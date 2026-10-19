#!/usr/bin/env node
// apps/skill-vault/src/cli.ts — the skill-vault command line interface.
import process from 'node:process';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { loadConfig, saveConfig, type VaultConfig } from './config.ts';
import { VaultDb, type SkillRow } from './db.ts';
import { PoliteHttpClient } from './http.ts';
import { GithubResolver } from './github.ts';
import { Logger } from './log.ts';
import { ensureVaultLayout, resolveVaultRoot, skillDirFor, vaultPaths, type VaultPaths } from './paths.ts';
import { SkillsmpClient } from './skillsmp.ts';
import { exportCatalogCsv, getSkill, runDiscovery } from './catalog.ts';
import { runDownload, type DownloadTargets } from './download.ts';
import { dismissFinding, effectiveFindings, runScan, scanSkillContent, skillContentDirFor, writeSecurityReport } from './scanner.ts';
import { searchSkills, type SearchFilters } from './search.ts';
import { recommendForRepo } from './recommend.ts';
import { buildApplyPlan } from './apply.ts';
import {
  AGENT_SPECS,
  detectAgent,
  installSkills,
  integrationStatus,
  resolveTargetRoot,
  uninstallSkill,
  type AgentId,
} from './integrations.ts';
import { collectStatus, formatBytes, writeDownloadReport, writeIntegrationReport } from './report.ts';
import { verifyVault } from './verify.ts';
import { backupVault, restoreVault } from './backup.ts';
import { moveDir, nowIso } from './util.ts';

const USAGE = `skill-vault — local coding skill vault (discover · download · scan · search · integrate)

Usage: skill-vault [--root <dir>] <command> [options]

Vault data lives in %LOCALAPPDATA%\\AiKanban\\skill-vault by default (SKILL_VAULT_ROOT overrides).

Commands:
  init                                        create the vault layout and default config
  discover [--categories a,b] [--max-pages N] [--max-items N] [--transport mcp|rest]
                                              discover the SkillsMP coding catalog (incremental, checkpointed)
  catalog [--category X] [--status X] [--format table|jsonl] [--limit N]
                                              list the discovered catalog
  download [--limit N] [--concurrency N] [--dry-run] [--no-resume]
          [--skill ID ...] | [--all-accessible]
                                              download skills (default target: coding catalog), scan after
  sync                                        discover + incremental download + scan
  scan [--skill ID ...] [--rescan]            (re)scan downloaded content
  approve --skill ID [--note TEXT]            explicitly approve a scanned skill (human action)
  reject  --skill ID [--note TEXT]            explicitly reject a skill
  dismiss-finding --finding N --reason TEXT   mark a finding as a false positive (audited)
  search QUERY [--status a,b] [--category X] [--min-stars N] [--limit N]
                                              keyword search with ranking
  recommend --repo PATH [--task TEXT]         codebase-aware minimal skill set
  explain --skill ID                          explain a skill's provenance and findings
  inspect --skill ID                          full skill detail
  integrate opencode|claude-code [--dry-run] [--approved-only|--include-scanned]
          [--scope project|global] [--project PATH] [--skills ID ...]
                                              install approved skills for an agent
  integration-status                          list vault-managed installations
  uninstall --skill ID [--agent NAME]         remove only vault-managed files
  apply --repo PATH --task TEXT               produce a task plan with selected skills
  verify                                      re-verify content hashes vs the manifest
  report [--json]                             vault status summary
  export --format csv|jsonl --out FILE        export the catalog
  backup | restore --dir PATH [--confirm]     backup / restore the vault
  status                                      short status line
  help                                        this help
`;

type ParsedArgs = {
  root?: string;
  command: string;
  flags: Map<string, string | boolean | string[]>;
  positional: string[];
};

const MULTI_FLAGS = new Set(['--skill', '--categories', '--status', '--agent']);
const BOOL_FLAGS = new Set([
  '--dry-run', '--no-resume', '--rescan', '--force', '--json', '--confirm',
  '--all-accessible', '--approved-only', '--include-scanned', '--help', '-h',
]);

const parseArgs = (argv: string[]): ParsedArgs => {
  const flags = new Map<string, string | boolean | string[]>();
  const positional: string[] = [];
  let command = '';
  let root: string | undefined;
  let index = 0;
  const pushFlag = (name: string, value: string | boolean | string[]): void => {
    if (MULTI_FLAGS.has(name)) {
      const existing = flags.get(name);
      const list = Array.isArray(existing) ? existing : existing !== undefined && existing !== true ? [String(existing)] : [];
      if (typeof value === 'string') list.push(value);
      flags.set(name, list);
    } else {
      flags.set(name, value);
    }
  };
  while (index < argv.length) {
    const arg = argv[index]!;
    if (arg === '--root' || arg === '-r') {
      index += 1;
      root = argv[index];
    } else if (arg === '--help' || arg === '-h') {
      command = command || 'help';
    } else if (arg.startsWith('--')) {
      const [name, inlineValue] = arg.split('=', 2);
      if (inlineValue !== undefined) {
        pushFlag(name!, inlineValue);
      } else if (!BOOL_FLAGS.has(name!) && index + 1 < argv.length && !argv[index + 1]!.startsWith('--')) {
        // Value flag: consume the next argument.
        pushFlag(name!, argv[index + 1]!);
        index += 1;
      } else {
        pushFlag(name!, true);
      }
    } else if (command === '') {
      command = arg;
    } else {
      positional.push(arg);
    }
    index += 1;
  }
  return { root, command: command || 'help', flags, positional };
};

const flag = (args: ParsedArgs, name: string, fallback?: string): string | undefined => {
  const value = args.flags.get(name);
  if (value === undefined || value === true) return fallback;
  if (value === false) return undefined;
  return String(value);
};
const flagList = (args: ParsedArgs, name: string): string[] => {
  const value = args.flags.get(name);
  if (value === undefined || value === true) return [];
  return Array.isArray(value) ? value : String(value).split(',');
};
const flagBool = (args: ParsedArgs, name: string): boolean => args.flags.get(name) === true;
const flagNumber = (args: ParsedArgs, name: string, fallback: number): number => {
  const value = flag(args, name);
  const parsed = value === undefined ? NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

type Ctx = {
  paths: VaultPaths;
  config: VaultConfig;
  db: VaultDb;
  logger: Logger;
  http: PoliteHttpClient;
  client: SkillsmpClient;
  github: GithubResolver;
};

const makeContext = async (rootOverride: string | undefined, quiet = false): Promise<Ctx> => {
  const root = resolveVaultRoot(rootOverride);
  const paths = vaultPaths(root);
  await ensureVaultLayout(paths);
  const config = await loadConfig(paths.config);
  const db = VaultDb.open(paths.sqlite);
  const logger = quiet ? Logger.silent() : await Logger.open(paths.logs);
  const http = new PoliteHttpClient({
    userAgent: config.userAgent,
    minIntervalMs: config.download.minRequestIntervalMs,
    maxRetries: config.download.maxRetries,
    timeoutMs: config.download.requestTimeoutMs,
    onRetry: (notice) => {
      void logger.debug('http retry', { url: notice.url, attempt: notice.attempt, delayMs: notice.delayMs, reason: notice.reason });
    },
  });
  const skillsmp = new SkillsmpClient('https://skillsmp.com', http, logger);
  const github = new GithubResolver(http, logger, config.download.githubApiBudgetPerRun);
  return { paths, config, db, logger, http, client: skillsmp, github };
};

const findSkill = (db: VaultDb, idOrExternal: string): SkillRow | undefined =>
  getSkill(db, idOrExternal) ??
  (db.db.prepare('SELECT * FROM skills WHERE id = ?').get(`skillsmp:${idOrExternal}`) as SkillRow | undefined) ??
  (db.db.prepare('SELECT * FROM skills WHERE external_id = ?').get(idOrExternal) as SkillRow | undefined) ??
  (db.db.prepare('SELECT * FROM skills WHERE name = ? COLLATE NOCASE ORDER BY stars DESC').get(idOrExternal) as SkillRow | undefined);

const rowLine = (row: SkillRow): string =>
  `${row.status.padEnd(11)} ${String(row.stars).padStart(6)}★ ${row.name.slice(0, 48).padEnd(48)} ${row.repo_owner}/${row.repo_name}${
    row.license ? ` [${row.license}]` : ''
  }`;

const printDiscoveryResult = (result: Awaited<ReturnType<typeof runDiscovery>>): void => {
  console.log(`Discovery via ${result.transport}: ${result.pagesFetched} pages, ${result.upserts} rows upserted (${result.newSkills} new).`);
  console.log(`Catalog now holds ${result.totalCatalogRows} rows. Categories: ${result.categoriesQueried.join(', ')}`);
  if (result.incomplete) console.log('NOTE: discovery stopped early (page cap, item cap, or source error) — run again to continue.');
  for (const note of result.notes) console.log(`note: ${note}`);
};

const printDownloadResult = (result: Awaited<ReturnType<typeof runDownload>>): void => {
  console.log(
    `Download: ${result.reposConsidered} catalog entries considered, ${result.reposProcessed} repos fetched, ${result.skillsDownloaded} skills stored, ${result.duplicates} duplicates, ${result.skippedUnchanged} unchanged (skipped), ${result.failed} failed.`,
  );
  if (result.bytesFetched > 0) console.log(`Fetched ${formatBytes(result.bytesFetched)} of archives.`);
  if (result.diskGuardTriggered) console.log('WARNING: disk-space guard stopped the run early.');
  for (const failure of result.failures.slice(0, 20)) console.log(`  fail: ${failure.repo}: ${failure.error}`);
  if (result.failures.length > 20) console.log(`  … and ${result.failures.length - 20} more failures`);
  for (const note of result.notes.slice(0, 20)) console.log(`  ${note}`);
};

async function approveReject(ctx: Ctx, args: ParsedArgs, action: 'approve' | 'reject'): Promise<number> {
  const ids = flagList(args, '--skill');
  if (ids.length === 0) {
    console.error(`--skill is required (one or multiple). See: skill-vault ${action} --skill <id>`);
    return 2;
  }
  const note = flag(args, '--note');
  for (const id of ids) {
    const row = findSkill(ctx.db, id);
    if (row === undefined) {
      console.error(`Skill not found: ${id}`);
      return 1;
    }
    if (row.downloaded_at === null) {
      console.error(`Skill ${row.id} has no downloaded content to ${action}.`);
      return 1;
    }
    const findings = effectiveFindings(ctx.db, row.id);
    if (action === 'approve' && row.status !== 'scanned' && row.status !== 'quarantined') {
      console.error(`Skill ${row.id} is "${row.status}" — only scanned or quarantined skills can be approved.`);
      return 1;
    }
    if (action === 'approve') {
      const blocking = findings.filter((f) => f.severity === 'critical' || f.severity === 'high');
      if (blocking.length > 0 && flagBool(args, '--force') !== true) {
        console.error(
          `Skill ${row.id} has ${blocking.length} undismissed critical/high finding(s). Dismiss them as false positives (--dismiss-finding) or pass --force to approve anyway.`,
        );
        return 1;
      }
    }
    const fromDir = skillDirFor(ctx.paths, row);
    ctx.db.db
      .prepare('INSERT INTO approvals (skill_id, action, actor, note, at) VALUES (?, ?, ?, ?, ?)')
      .run(row.id, action, process.env.USERNAME ?? 'user', note ?? null, nowIso());
    ctx.db.db.prepare('UPDATE skills SET status = ? WHERE id = ?').run(action === 'approve' ? 'approved' : 'rejected', row.id);
    const toDir = skillDirFor(ctx.paths, { ...row, status: action === 'approve' ? 'approved' : 'rejected' });
    await moveDir(fromDir, toDir);
    console.log(`${action === 'approve' ? 'Approved' : 'Rejected'} ${row.id} (${row.name}); content moved to ${path.relative(ctx.paths.root, toDir)}`);
  }
  await writeSecurityReport(ctx.db, ctx.paths);
  return 0;
}

async function runCli(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.command === 'help') {
    console.log(USAGE);
    return 0;
  }

  const ctx = await makeContext(args.root);
  try {
    switch (args.command) {
      case 'init': {
        await saveConfig(ctx.paths.config, ctx.config);
        await fsp.writeFile(
          path.join(ctx.paths.root, 'README.md'),
          `# Skill Vault\n\nLocal coding skill vault managed by @aik/skill-vault.\nRoot: ${ctx.paths.root}\n\nSee docs/skill-vault/ in the ai-kanban-automation repository for documentation.\n`,
        );
        console.log(`Vault initialized at ${ctx.paths.root}`);
        return 0;
      }
      case 'discover': {
        const result = await runDiscovery(ctx, {
          categories: flagList(args, '--categories'),
          maxPagesPerCategory: flagNumber(args, '--max-pages', 20),
          maxItems: flagNumber(args, '--max-items', 10_000),
          transport: flag(args, '--transport') === 'rest' ? 'rest' : 'mcp',
          resume: !flagBool(args, '--no-resume'),
        });
        printDiscoveryResult(result);
        return 0;
      }
      case 'catalog': {
        const status = flagList(args, '--status');
        const category = flag(args, '--category');
        const format = flag(args, '--format', 'table');
        const limit = flagNumber(args, '--limit', 50);
        const conditions: string[] = [];
        const params: unknown[] = [];
        if (status.length > 0) {
          conditions.push(`status IN (${status.map(() => '?').join(',')})`);
          params.push(...status);
        }
        if (category !== undefined) {
          conditions.push('category = ?');
          params.push(category);
        }
        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const rows = ctx.db.db
          .prepare(`SELECT * FROM skills ${where} ORDER BY stars DESC LIMIT ?`)
          .all(...params, limit) as SkillRow[];
        if (format === 'jsonl') {
          for (const row of rows) console.log(JSON.stringify(row));
        } else {
          for (const row of rows) console.log(rowLine(row));
          console.log(`${rows.length} rows (use --limit to see more)`);
        }
        return 0;
      }
      case 'download': {
        let targets: DownloadTargets = { kind: 'coding' };
        const skillIds = flagList(args, '--skill');
        if (skillIds.length > 0) targets = { kind: 'skills', ids: skillIds };
        else if (flagBool(args, '--all-accessible')) targets = { kind: 'all-accessible' };
        const result = await runDownload(ctx, targets, {
          limit: flagNumber(args, '--limit', 500),
          concurrency: flagNumber(args, '--concurrency', ctx.config.download.concurrency),
          dryRun: flagBool(args, '--dry-run'),
          resume: !flagBool(args, '--no-resume'),
        });
        printDownloadResult(result);
        if (!result.dryRun) {
          const scan = await runScan(ctx, {});
          console.log(`Scan: ${scan.scanned} scanned → ${scan.clean} clean, ${scan.quarantined} kept for review, ${scan.rejected} auto-rejected, ${scan.errored} errors.`);
        }
        await writeDownloadReport(ctx.db, ctx.paths, result);
        await writeSecurityReport(ctx.db, ctx.paths);
        return result.failures.length > 0 && result.skillsDownloaded === 0 && result.duplicates === 0 ? 1 : 0;
      }
      case 'sync': {
        const discovery = await runDiscovery(ctx, { resume: true });
        printDiscoveryResult(discovery);
        const result = await runDownload(ctx, { kind: 'coding' }, { resume: true });
        printDownloadResult(result);
        const scan = await runScan(ctx, {});
        console.log(`Scan: ${scan.scanned} scanned → ${scan.clean} clean, ${scan.quarantined} for review, ${scan.rejected} auto-rejected.`);
        await writeDownloadReport(ctx.db, ctx.paths, result);
        await writeSecurityReport(ctx.db, ctx.paths);
        return 0;
      }
      case 'scan': {
        const skillIds = flagList(args, '--skill');
        const summary = await runScan(ctx, { skillIds: skillIds.length > 0 ? skillIds : undefined, rescan: flagBool(args, '--rescan') });
        console.log(
          `Scan: ${summary.scanned} scanned → ${summary.clean} clean, ${summary.quarantined} kept for review, ${summary.rejected} auto-rejected, ${summary.errored} errors.`,
        );
        await writeSecurityReport(ctx.db, ctx.paths);
        return 0;
      }
      case 'approve':
        return await approveReject(ctx, args, 'approve');
      case 'reject':
        return await approveReject(ctx, args, 'reject');
      case 'dismiss-finding': {
        const findingId = Number(flag(args, '--finding'));
        const reason = flag(args, '--reason');
        if (!Number.isFinite(findingId) || reason === undefined) {
          console.error('Usage: skill-vault dismiss-finding --finding <id> --reason <text>');
          return 2;
        }
        const ok = dismissFinding(ctx.db, findingId, process.env.USERNAME ?? 'user', reason);
        console.log(ok ? 'Finding dismissed (audited).' : 'Finding not found.');
        return ok ? 0 : 1;
      }
      case 'search': {
        const query = args.positional.join(' ');
        if (query.trim().length === 0) {
          console.error('Usage: skill-vault search "query"');
          return 2;
        }
        const statuses = flagList(args, '--status');
        const filters: SearchFilters = {
          statuses: statuses.length > 0 ? statuses : undefined,
          categories: flagList(args, '--category').length > 0 ? flagList(args, '--category') : undefined,
          minStars: flag(args, '--min-stars') !== undefined ? flagNumber(args, '--min-stars', 0) : undefined,
          updatedWithinDays: flag(args, '--updated-within-days') !== undefined ? flagNumber(args, '--updated-within-days', 365) : undefined,
        };
        const hits = searchSkills(ctx.db, { query, filters, limit: flagNumber(args, '--limit', 20) });
        for (const hit of hits) {
          console.log(`${String(hit.score).padStart(8)} ${rowLine(hit.row)}`);
          console.log(`          why: ${hit.why.join(', ')}`);
        }
        if (hits.length === 0) console.log('No matching skills (default scope: scanned+approved).');
        return 0;
      }
      case 'recommend': {
        const repo = flag(args, '--repo');
        if (repo === undefined) {
          console.error('--repo is required');
          return 2;
        }
        const result = await recommendForRepo(ctx.db, {
          repoRoot: repo,
          task: flag(args, '--task'),
          limit: flagNumber(args, '--limit', 6),
        });
        console.log(`Repo: ${result.inspection.root}`);
        console.log(`Languages: ${result.inspection.languages.slice(0, 6).join(', ') || 'none detected'}`);
        console.log(`Frameworks: ${result.inspection.frameworks.join(', ') || 'none detected'}`);
        console.log(`Agents configured: ${result.inspection.agents.join(', ') || 'none detected'}`);
        console.log(`Terms: ${result.terms.join(', ')}`);
        console.log(`\nRecommended minimal skill set:`);
        for (const rec of result.recommendations) {
          console.log(`- ${rec.skill.name} (${rec.score}) [${rec.skill.status}] ${rec.skill.repo_owner}/${rec.skill.repo_name}`);
          console.log(`  why: ${rec.why.join(', ')} · terms: ${rec.terms.join(', ')}`);
        }
        for (const overlap of result.overlaps) console.log(`overlap: ${overlap}`);
        for (const warning of result.warnings) console.log(`warning: ${warning}`);
        console.log(`\nPolicy: ${result.policy}`);
        return 0;
      }
      case 'explain':
      case 'inspect': {
        const id = flag(args, '--skill');
        if (id === undefined) {
          console.error('--skill is required');
          return 2;
        }
        const row = findSkill(ctx.db, id);
        if (row === undefined) {
          console.error(`Skill not found: ${id}`);
          return 1;
        }
        const findings = effectiveFindings(ctx.db, row.id);
        const attempts = ctx.db.db
          .prepare('SELECT outcome, error, started_at AS startedAt, bytes FROM download_attempts WHERE skill_id = ? ORDER BY id DESC LIMIT 5')
          .all(row.id);
        const dir = skillContentDirFor(ctx.paths, row);
        const provenance = dir ? await fsp.readFile(path.join(dir, 'provenance.json'), 'utf8').catch(() => null) : null;
        console.log(JSON.stringify({ row, findings, attempts, contentDir: dir, provenance: provenance ? JSON.parse(provenance) : null }, null, 2));
        return 0;
      }
      case 'integrate': {
        const agentName = args.positional[0] as AgentId | undefined;
        if (agentName === undefined || !(agentName in AGENT_SPECS)) {
          console.error('Usage: skill-vault integrate opencode|claude-code [--dry-run] [--approved-only] ...');
          return 2;
        }
        const detection = await detectAgent(agentName);
        console.log(`Agent: ${agentName} ${detection.installed ? `installed (${detection.version ?? 'version unknown'})` : 'NOT detected on PATH (installing files anyway)'}`);
        const scope = (flag(args, '--scope', 'project') as 'project' | 'global');
        const targetRoot = resolveTargetRoot(agentName, scope, flag(args, '--project') ?? flag(args, '--repo'));
        const includeScanned = flagBool(args, '--include-scanned');
        const requested = flagList(args, '--skill');
        const statuses = includeScanned ? ['approved', 'scanned'] : ['approved'];
        const skills = (
          requested.length > 0
            ? requested.map((id) => findSkill(ctx.db, id)).filter((row): row is SkillRow => row !== undefined)
            : (ctx.db.db
                .prepare(`SELECT * FROM skills WHERE status IN (${statuses.map(() => '?').join(',')}) AND downloaded_at IS NOT NULL ORDER BY stars DESC`)
                .all(...statuses) as SkillRow[])
        ).filter((row) => statuses.includes(row.status));
        const skippedForStatus = requested.length > 0 && skills.length < requested.length;
        const report = await installSkills(ctx, {
          agent: agentName,
          scope,
          targetRoot,
          skills,
          dryRun: flagBool(args, '--dry-run'),
        });
        for (const outcome of report.outcomes) {
          const name = outcome.skillId;
          if (outcome.outcome === 'installed') {
            console.log(`${report.dryRun ? '[dry-run] ' : ''}installed ${name} → ${outcome.target}${outcome.updated ? ' (updated)' : ''}`);
          } else {
            console.log(`skipped ${name}: ${outcome.reason}`);
          }
        }
        for (const compat of report.compatibility) {
          for (const note of compat.notes) console.log(`compat[${compat.skillId}]: ${note}`);
        }
        for (const line of report.discoverability) console.log(line);
        if (skippedForStatus) console.log('note: some requested skills were skipped — only approved (or scanned with --include-scanned) skills install.');
        await writeIntegrationReport(ctx.paths, [report]);
        return 0;
      }
      case 'integration-status': {
        const rows = integrationStatus(ctx.db);
        if (rows.length === 0) {
          console.log('No vault-managed installations.');
          return 0;
        }
        for (const row of rows) {
          console.log(`${row.agent.padEnd(12)} ${row.scope.padEnd(8)} ${row.skillId} → ${row.targetPath} (${row.installedAt})`);
        }
        return 0;
      }
      case 'uninstall': {
        const id = flag(args, '--skill');
        if (id === undefined) {
          console.error('--skill is required');
          return 2;
        }
        const row = findSkill(ctx.db, id);
        if (row === undefined) {
          console.error(`Skill not found: ${id}`);
          return 1;
        }
        const agents = flagList(args, '--agent') as AgentId[];
        const results = await uninstallSkill({ db: ctx.db, logger: ctx.logger }, { skillId: row.id, agents: agents.length > 0 ? agents : undefined });
        for (const item of results) {
          console.log(item.removed ? `removed ${item.target}` : `not removed: ${item.target || '-'} ${item.reason ?? ''}`);
        }
        return results.every((item) => item.removed) ? 0 : 1;
      }
      case 'apply': {
        const repo = flag(args, '--repo');
        const task = flag(args, '--task');
        if (repo === undefined || task === undefined) {
          console.error('Usage: skill-vault apply --repo <path> --task "description"');
          return 2;
        }
        const { plan, planPath } = await buildApplyPlan(ctx.db, ctx.paths, { repoRoot: repo, task });
        console.log(`Apply plan written to ${planPath}`);
        console.log(`Task: ${plan.task}`);
        console.log(`Selected skills: ${plan.skillInstructions.map((item) => item.name).join(', ') || '(none — use repo instructions)'}`);
        console.log(`Suggested files: ${plan.suggestedFiles.slice(0, 10).join(', ')}`);
        for (const step of plan.workflow) console.log(`  step: ${step}`);
        return 0;
      }
      case 'verify': {
        const result = await verifyVault(ctx.db, ctx.paths);
        console.log(
          `Verify: ${result.checked} files checked, ${result.ok} intact, ${result.mismatched.length} hash mismatches, ${result.missing.length} missing, ${result.provenanceIssues.length} provenance issues.`,
        );
        for (const item of result.mismatched.slice(0, 10)) console.log(`  mismatch: ${item.skillId} ${item.path}`);
        for (const item of result.missing.slice(0, 10)) console.log(`  missing: ${item.skillId} ${item.dir}`);
        for (const item of result.provenanceIssues.slice(0, 10)) console.log(`  provenance: ${item.skillId}: ${item.issue}`);
        return result.mismatched.length + result.missing.length + result.provenanceIssues.length === 0 ? 0 : 1;
      }
      case 'report':
      case 'status': {
        const status = await collectStatus(ctx.db, ctx.paths);
        if (flagBool(args, '--json') || args.command === 'status') {
          console.log(JSON.stringify(status, null, 2));
        } else {
          console.log(JSON.stringify(status, null, 2));
        }
        return 0;
      }
      case 'export': {
        const format = flag(args, '--format', 'csv');
        const out = flag(args, '--out');
        if (out === undefined) {
          console.error('--out is required');
          return 2;
        }
        if (format === 'csv') {
          const bytes = await exportCatalogCsv(ctx.db, out);
          console.log(`CSV written to ${out} (${formatBytes(bytes)})`);
        } else {
          const source = ctx.paths.skillsJsonl;
          await fsp.copyFile(source, out);
          console.log(`JSONL copied to ${out}`);
        }
        return 0;
      }
      case 'backup': {
        const result = await backupVault(ctx.db, ctx.paths);
        console.log(`Backup written to ${path.dirname(result.sqlite)} (${result.files.join(', ')})`);
        return 0;
      }
      case 'restore': {
        const dir = flag(args, '--dir');
        if (dir === undefined) {
          console.error('--dir is required');
          return 2;
        }
        const result = await restoreVault(ctx.paths, path.resolve(dir), flagBool(args, '--confirm'));
        console.log(result.message);
        return result.restored ? 0 : 1;
      }
      default:
        console.error(`Unknown command: ${args.command}\n`);
        console.log(USAGE);
        return 2;
    }
  } finally {
    await ctx.logger.close();
    ctx.db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}` || process.argv[1]?.endsWith('cli.ts')) {
  runCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`error: ${(error as Error).message}`);
      if (process.env.SKILL_VAULT_DEBUG === '1') console.error((error as Error).stack);
      process.exit(1);
    },
  );
}

export { runCli, makeContext, scanSkillContent };
