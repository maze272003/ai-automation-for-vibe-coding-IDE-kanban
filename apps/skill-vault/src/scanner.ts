// apps/skill-vault/src/scanner.ts — static security scanning of downloaded skill content.
//
// All downloaded content is untrusted. Scanning is purely static: files are read as text
// and pattern-matched. Nothing is ever executed, imported, or shell-evaluated. Findings
// carry human-readable explanations. A clean scan is "no known bad pattern matched" —
// never a guarantee of safety; approval is always an explicit human action.
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { VaultConfig } from './config.ts';
import { type SkillRow, type VaultDb } from './db.ts';
import type { Logger } from './log.ts';
import { skillDirFor, type VaultPaths } from './paths.ts';
import { moveDir, nowIso, writeFileAtomic } from './util.ts';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type RawFinding = {
  ruleId: string;
  severity: Severity;
  filePath: string;
  line: number | null;
  message: string;
};

export const SEVERITY_ORDER: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

const TEXT_EXTENSIONS = new Set([
  '', '.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.sh', '.bash', '.zsh', '.ps1', '.psm1',
  '.rb', '.go', '.rs', '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.pl', '.lua',
  '.sql', '.html', '.htm', '.css', '.scss', '.xml', '.svg', '.env', '.example', '.gitignore', '.editorconfig',
]);

const EXECUTABLE_EXTENSIONS = new Set([
  '.exe', '.dll', '.sys', '.msi', '.scr', '.vbs', '.vbe', '.jsbe', '.jse', '.wsf', '.wsh',
  '.bat', '.cmd', '.com', '.pif', '.cpl', '.ps1', '.psm1', '.psd1', '.jar', '.pyd', '.so',
  '.dylib', '.o', '.a', '.bin', '.apk', '.appimage', '.deb', '.rpm', '.dmg',
]);

const MAX_SCAN_FILE_BYTES = 1024 * 1024;

type LoadedFile = { path: string; text: string; bytes: number; executable: boolean };

async function loadSkillFiles(dir: string): Promise<LoadedFile[]> {
  const out: LoadedFile[] = [];
  const walk = async (current: string, prefix: string): Promise<void> => {
    const entries = await fsp.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === 'provenance.json') continue;
      const full = path.join(current, entry.name);
      const rel = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(full, rel);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (EXECUTABLE_EXTENSIONS.has(ext)) {
          out.push({ path: rel, text: '', bytes: (await fsp.stat(full)).size, executable: true });
          continue;
        }
        if (!TEXT_EXTENSIONS.has(ext)) continue;
        const stat = await fsp.stat(full);
        if (stat.size > MAX_SCAN_FILE_BYTES) continue;
        const text = await fsp.readFile(full, 'utf8').catch(() => '');
        out.push({ path: rel, text, bytes: stat.size, executable: false });
      }
    }
  };
  await walk(dir, '');
  return out;
}

type TextRule = {
  id: string;
  severity: Severity;
  patterns: RegExp[];
  build: (filePath: string, line: number, match: RegExpExecArray) => RawFinding | null;
};

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

const finding = (rule: { id: string; severity: Severity }, filePath: string, line: number | null, message: string): RawFinding => ({
  ruleId: rule.id,
  severity: rule.severity,
  filePath,
  line,
  message,
});

// --- Prompt-injection / secret exfiltration instructions -------------------------------
const INJECTION_RULES: TextRule[] = [
  {
    id: 'SEC004-secret-reveal',
    severity: 'critical',
    patterns: [
      /(?:reveal|print|output|show|leak|exfiltrate|send|upload|post)[^.]{0,80}(?:system\s*prompt|hidden\s+instructions?|previous\s+instructions|developer\s+message)/i,
      /(?:ignore|disregard|forget|override)[^.]{0,60}(?:previous|prior|above|earlier|all)\s+instructions?/i,
      /(?:your|the)\s+(?:api\s*key|credentials?|secrets?|env(?:ironment)?\s*(?:variables?)?)[^.]{0,60}(?:to|via|using)\s+(?:curl|wget|fetch|axios|http|webhook)/i,
      /exfiltrat/i,
    ],
    build: (filePath, line) =>
      finding(
        { id: 'SEC004-secret-reveal', severity: 'critical' },
        filePath,
        line,
        'Instruction attempts to reveal secrets, system prompts, or to override prior instructions (prompt injection).',
      ),
  },
  {
    id: 'SEC005-safeguard-bypass',
    severity: 'high',
    patterns: [
      /--dangerously-skip-permissions|--yolo\b|--no-sandbox|disable[sd]?\s+(?:the\s+)?sandbox|bypass\s+(?:all\s+)?permissions?|ignore\s+safety\s+(?:rules|guardrails|checks)/i,
      /permission\s+(?:mode\s+)?(?:set\s+to\s+)?(?:auto-accept|always allow)/i,
    ],
    build: (filePath, line) =>
      finding(
        { id: 'SEC005-safeguard-bypass', severity: 'high' },
        filePath,
        line,
        'Instruction tries to disable agent safeguards, sandboxing, or permission prompts.',
      ),
  },
  {
    id: 'SEC001-exfil-endpoint',
    severity: 'high',
    patterns: [
      /https?:\/\/[^\s"'`]*(?:webhook\.site|ngrok\.io|ngrok-free\.app|pastebin\.com|hastebin\.com|transfer\.sh|file\.io|0x0\.st|termbin\.com|requestbin|hookb\.in|beeceptor|pipedream)\b[^\s"'`]*/i,
      /https?:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\/[^\s"'`]+/i,
      /https?:\/\/hooks\.slack\.com\/services\/[^\s"'`]+/i,
    ],
    build: (filePath, line, match) =>
      finding(
        { id: 'SEC001-exfil-endpoint', severity: 'high' },
        filePath,
        line,
        `References a known exfiltration endpoint: ${match[0]!.slice(0, 120)}`,
      ),
  },
  {
    id: 'SEC002-pipe-to-shell',
    severity: 'critical',
    patterns: [
      /\b(?:curl|wget)[^|;\n`]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|python\d?|python3|perl|ruby)\b/i,
      /\|\s*(?:sh|bash)\s*<<|curl\s+[^|\n]*\|\s*iex\b/i,
      /\b(?:iwr|invoke-webrequest)[^|\n]*\|\s*iex\b/i,
      /powershell[^\n]*-enc(?:odedcommand)?\s+[A-Za-z0-9+/=]{16,}/i,
    ],
    build: (filePath, line, match) =>
      finding(
        { id: 'SEC002-pipe-to-shell', severity: 'critical' },
        filePath,
        line,
        `Downloads and executes remote code: ${match[0]!.slice(0, 120)}`,
      ),
  },
  {
    id: 'SEC003-destructive',
    severity: 'critical',
    patterns: [
      /\brm\s+-[rfRF]+\s+(?:-[rfRF]+\s+)*(?:\/(?:\s|$|\*)|\/(?:etc|usr|home|var|bin|lib)\b|~(?:\/|\s|$|\*))/,
      /\b(?:mkfs(?:\.\w+)?|fdisk|dd\s+if=\/dev\/zero)\b/i,
      /\bformat\s+[a-z]:\s*(?:\/q\s*)?(?:\/(?:y|x))?$/im,
      /remove-item\s+[^|\n]*-recurse[^|\n]*-force\s+[^|\n]*c:\\(?:windows|program files|users)\b/i,
      /\bdel\s+\/[fqs]+\s+[a-z]:\\/i,
      /:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/,
    ],
    build: (filePath, line, match) =>
      finding(
        { id: 'SEC003-destructive', severity: 'critical' },
        filePath,
        line,
        `Destructive system command: ${match[0]!.slice(0, 120)}`,
      ),
  },
  {
    id: 'SEC008-env-harvest',
    severity: 'high',
    patterns: [
      /\bprintenv\b[^|\n]*\|\s*(?:curl|wget|nc|ncat)\b/i,
      /\benv\b\s*\|\s*(?:curl|wget|nc|ncat|base64)\b/i,
      /get-childitem\s+env:[^|\n]*\|\s*(?:curl|invoke-(?:webrequest|restmethod))/i,
      /(?:cat|type)\s+~?\/?\.(?:aws\/credentials|ssh\/id_(?:rsa|ed25519)|netrc|gnupg|env)\b/i,
      /(?:cat|type|read)[^|\n]*\.env\b[^|\n]*\|\s*(?:curl|wget)\b/i,
    ],
    build: (filePath, line, match) =>
      finding(
        { id: 'SEC008-env-harvest', severity: 'high' },
        filePath,
        line,
        `Harvests environment variables or credential files: ${match[0]!.slice(0, 120)}`,
      ),
  },
  {
    id: 'SEC012-credential-paths',
    severity: 'high',
    patterns: [
      /\.(?:ssh\/id_rsa|ssh\/id_ed25519|aws\/credentials|kube\/config|netrc|gnupg\/)\b/i,
      /(?:read|send|upload|post)[^.\n]{0,50}\.env\b/i,
    ],
    build: (filePath, line, match) =>
      finding(
        { id: 'SEC012-credential-paths', severity: 'high' },
        filePath,
        line,
        `References private credential material: ${match[0]!.slice(0, 120)}`,
      ),
  },
  {
    id: 'SEC006-obfuscated-payload',
    severity: 'high',
    patterns: [
      /\b(?:eval|exec|execute)\s*\(\s*(?:atob|base64_decode|window\.atob|Buffer\.from\([^)]*,\s*['"]base64)/i,
      /(?:^|[^A-Za-z0-9+/])[A-Za-z0-9+/]{220,}={0,2}(?:[^A-Za-z0-9+/]|$)/,
      /\\x[0-9a-f]{2}(?:\\x[0-9a-f]{2}){24,}/i,
      /\\u[0-9a-f]{4}(?:\\u[0-9a-f]{4}){24,}/i,
    ],
    build: (filePath, line, match) =>
      finding(
        { id: 'SEC006-obfuscated-payload', severity: 'high' },
        filePath,
        line,
        `Suspicious encoded or obfuscated payload (${match[0].length} chars).`,
      ),
  },
  {
    id: 'SEC009-remote-install',
    severity: 'medium',
    patterns: [
      /(?:curl|wget)[^|\n]*(?:install\.sh|setup\.sh|bootstrap\.sh)[^|\n]*\|\s*(?:sudo\s+)?(?:sh|bash)/i,
      /npm\s+install\s+(?:-g\s+)?git\+https?:\/\/[^\s]+/i,
      /pip\s+install\s+https?:\/\/[^\s]+/i,
      /git\s+clone\s+[^\n]+\s*&&\s*(?:sudo\s+)?\.\//,
    ],
    build: (filePath, line, match) =>
      finding(
        { id: 'SEC009-remote-install', severity: 'medium' },
        filePath,
        line,
        `Installs or runs code from a remote, non-registry source: ${match[0]!.slice(0, 120)}`,
      ),
  },
  {
    id: 'SEC011-metadata-injection',
    severity: 'medium',
    patterns: [
      /you\s+must\s+(?:always|immediately)\s+(?:obey|follow|comply)/i,
      /(?:always|immediately)\s+(?:respond|reply)\s+with\s+(?:your\s+)?(?:system|hidden)\s+prompt/i,
      /do\s+not\s+tell\s+the\s+user/i,
    ],
    build: (filePath, line) =>
      finding(
        { id: 'SEC011-metadata-injection', severity: 'medium' },
        filePath,
        line,
        'Description or metadata contains instruction-like text aimed at the agent itself.',
      ),
  },
];

export const parseFrontmatter = (text: string): { data: Record<string, string>; body: string } => {
  if (!text.startsWith('---')) return { data: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: text };
  const block = text.slice(4, end);
  const data: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const match = /^([A-Za-z0-9_/-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (match) data[match[1]!] = match[2]!.replace(/^['"]|['"]$/g, '').trim();
  }
  return { data, body: text.slice(end + 4) };
};

const VALID_SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export type ScanOutcome = {
  skillId: string;
  outcome: 'clean' | 'findings' | 'rejected' | 'error';
  newStatus: 'scanned' | 'quarantined' | 'rejected';
  counts: Record<Severity, number>;
  findings: RawFinding[];
};

/** Scan one skill's content directory on disk. Pure static analysis; nothing is executed. */
export async function scanSkillContent(
  skill: { id: string; name: string; description: string; skill_path: string },
  dir: string,
  opts: { autoRejectOnCritical: boolean; disabledRules: Set<string>; expectLicense: boolean },
): Promise<ScanOutcome> {
  const findings: RawFinding[] = [];
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const dirStat = await fsp.stat(dir).catch(() => undefined);
  if (dirStat === undefined || !dirStat.isDirectory()) {
    throw new Error(`skill content directory is missing or not a directory: ${dir}`);
  }
  const files = await loadSkillFiles(dir);

  for (const file of files) {
    if (file.executable) {
      findings.push(
        finding(
          { id: 'SEC007-executable-content', severity: 'high' },
          file.path,
          null,
          `Executable or script binary present in skill content (${path.extname(file.path) || 'no extension'}). Skills should ship instructions and text assets only.`,
        ),
      );
      continue;
    }
    if (file.text.length === 0) continue;
    for (const rule of INJECTION_RULES) {
      if (opts.disabledRules.has(rule.id)) continue;
      for (const pattern of rule.patterns) {
        pattern.lastIndex = 0;
        let match = pattern.exec(file.text);
        while (match !== null) {
          const built = rule.build(file.path, lineOf(file.text, match.index), match);
          if (built !== null) findings.push(built);
          if (!pattern.global) break;
          pattern.lastIndex = match.index + match[0].length;
          match = pattern.exec(file.text);
        }
      }
    }
  }

  // Format checks on SKILL.md itself.
  const skillMd = files.find((file) => file.path.toLowerCase() === 'skill.md' || file.path.toLowerCase().endsWith('/skill.md'));
  if (skillMd === undefined) {
    findings.push(
      finding({ id: 'FMT001-missing-skill-md', severity: 'medium' }, '', null, 'No SKILL.md found in the skill directory.'),
    );
  } else {
    const { data } = parseFrontmatter(skillMd.text);
    if (data.name === undefined || data.description === undefined) {
      findings.push(
        finding(
          { id: 'FMT002-frontmatter', severity: 'medium' },
          skillMd.path,
          1,
          'SKILL.md frontmatter is missing required "name" and/or "description" fields (Agent Skills spec).',
        ),
      );
    } else {
      if (data.name.length > 64 || !VALID_SKILL_NAME.test(data.name)) {
        findings.push(
          finding(
            { id: 'FMT003-name-rules', severity: 'medium' },
            skillMd.path,
            1,
            `Skill name "${data.name}" violates the shared naming rule ^[a-z0-9]+(-[a-z0-9]+)*$ (max 64 chars).`,
          ),
        );
      }
      if (data.description.length > 1024) {
        findings.push(
          finding({ id: 'FMT004-description-length', severity: 'low' }, skillMd.path, 1, 'Description exceeds 1024 characters.'),
        );
      }
    }
    if (opts.expectLicense) {
      const hasLicenseFile = files.some((file) => /^licen[cs]e(\.|$)/i.test(file.path.split('/').pop() ?? ''));
      if (data.license === undefined && !hasLicenseFile) {
        findings.push(
          finding(
            { id: 'LIC001-missing-license',
              severity: 'info' },
            skillMd.path,
            1,
            'No license declared in frontmatter or LICENSE file; rights to reuse this skill are unclear.',
          ),
        );
      }
    }
  }

  for (const item of findings) counts[item.severity] += 1;
  let outcome: ScanOutcome['outcome'];
  let newStatus: ScanOutcome['newStatus'];
  if (counts.critical > 0 && opts.autoRejectOnCritical) {
    outcome = 'rejected';
    newStatus = 'rejected';
  } else if (counts.critical > 0 || counts.high > 0 || counts.medium > 0 || counts.low > 0) {
    outcome = 'findings';
    newStatus = 'quarantined';
  } else {
    outcome = 'clean';
    newStatus = 'scanned';
  }
  return { skillId: skill.id, outcome, newStatus, counts, findings };
}

export const skillContentDirFor = (paths: VaultPaths, row: SkillRow): string | undefined => {
  if (row.downloaded_at === null) return undefined;
  return skillDirFor(paths, row);
};

/** Scan every downloaded-but-unscanned (or forced) skill and persist findings + state transitions. */
export async function runScan(
  ctx: { db: VaultDb; config: VaultConfig; paths: VaultPaths; logger: Logger },
  opts: { skillIds?: string[]; rescan?: boolean } = {},
): Promise<{ scanned: number; rejected: number; quarantined: number; clean: number; errored: number }> {
  const { db, config, paths, logger } = ctx;
  const disabled = new Set(config.scan.disabledRules);
  const statuses = opts.rescan ? ['downloaded', 'quarantined', 'scanned', 'rejected'] : ['downloaded'];
  const placeholders = statuses.map(() => '?').join(',');
  let rows: SkillRow[];
  if (opts.skillIds !== undefined && opts.skillIds.length > 0) {
    rows = opts.skillIds
      .map((id) => getRow(db, id))
      .filter((row): row is SkillRow => row !== undefined && row.downloaded_at !== null);
  } else {
    rows = db.db
      .prepare(`SELECT * FROM skills WHERE status IN (${placeholders}) AND downloaded_at IS NOT NULL`)
      .all(...statuses) as SkillRow[];
  }

  const summary = { scanned: 0, rejected: 0, quarantined: 0, clean: 0, errored: 0 };
  for (const row of rows) {
    const dir = skillContentDirFor(paths, row);
    if (dir === undefined) {
      summary.errored += 1;
      continue;
    }
    const runId = Number(
      db.db
        .prepare('INSERT INTO scan_runs (skill_id, started_at, outcome) VALUES (?, ?, ?)')
        .run(row.id, nowIso(), 'running').lastInsertRowid,
    );
    try {
      const result = await scanSkillContent(
        row,
        dir,
        { autoRejectOnCritical: config.scan.autoRejectOnCritical, disabledRules: disabled, expectLicense: true },
      );
      const tx = () => {
        db.db.prepare('DELETE FROM findings WHERE skill_id = ?').run(row.id);
        const insert = db.db.prepare(
          'INSERT INTO findings (skill_id, rule_id, severity, file_path, line, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        );
        for (const item of result.findings) {
          insert.run(row.id, item.ruleId, item.severity, item.filePath, item.line, item.message, nowIso());
        }
        db.db
          .prepare(
            'UPDATE scan_runs SET finished_at = ?, outcome = ?, critical = ?, high = ?, medium = ?, low = ?, info = ? WHERE id = ?',
          )
          .run(nowIso(), result.outcome, result.counts.critical, result.counts.high, result.counts.medium, result.counts.low, result.counts.info, runId);
        db.db.prepare('UPDATE skills SET status = ? WHERE id = ?').run(result.newStatus, row.id);
      };
      db.transaction(tx);
      // Keep the on-disk home consistent with the status: auto-rejected content moves to
      // rejected/; anything still awaiting review or approval stays in quarantined/.
      if (result.newStatus === 'rejected' && row.status !== 'rejected') {
        const fromDir = skillDirFor(paths, row);
        const toDir = skillDirFor(paths, { ...row, status: 'rejected' });
        await moveDir(fromDir, toDir);
      } else if (result.newStatus !== 'rejected' && row.status === 'rejected') {
        const fromDir = skillDirFor(paths, row);
        const toDir = skillDirFor(paths, { ...row, status: result.newStatus });
        await moveDir(fromDir, toDir);
      }
      summary.scanned += 1;
      if (result.outcome === 'rejected') summary.rejected += 1;
      else if (result.newStatus === 'quarantined') summary.quarantined += 1;
      else summary.clean += 1;
      logger.info('scan finished', { skill: row.id, outcome: result.outcome, counts: result.counts });
    } catch (error) {
      db.db
        .prepare('UPDATE scan_runs SET finished_at = ?, outcome = ? WHERE id = ?')
        .run(nowIso(), `error: ${(error as Error).message.slice(0, 300)}`, runId);
      summary.errored += 1;
      logger.warn('scan failed', { skill: row.id, error: (error as Error).message });
    }
  }
  return summary;
}

const getRow = (db: VaultDb, id: string): SkillRow | undefined =>
  db.db.prepare('SELECT * FROM skills WHERE id = ? OR external_id = ?').get(id, id) as SkillRow | undefined;

/** Effective (non-dismissed) findings for a skill. */
export const effectiveFindings = (db: VaultDb, skillId: string): Array<RawFinding & { id: number }> =>
  (
    db.db
      .prepare(
        `SELECT f.id, f.rule_id AS ruleId, f.severity, f.file_path AS filePath, f.line, f.message
         FROM findings f LEFT JOIN finding_dismissals d ON d.finding_id = f.id
         WHERE f.skill_id = ? AND d.id IS NULL`,
      )
      .all(skillId) as Array<RawFinding & { id: number }>
  ).map((row) => ({ ...row, severity: row.severity as Severity }));

export const dismissFinding = (db: VaultDb, findingId: number, by: string, reason: string): boolean => {
  const info = db.db.prepare('SELECT skill_id FROM findings WHERE id = ?').get(findingId) as { skill_id: string } | undefined;
  if (info === undefined) return false;
  db.db
    .prepare('INSERT INTO finding_dismissals (finding_id, dismissed_by, reason, dismissed_at) VALUES (?, ?, ?, ?)')
    .run(findingId, by, reason, nowIso());
  return true;
};

/** Write the aggregate security report. */
export async function writeSecurityReport(db: VaultDb, paths: VaultPaths): Promise<string> {
  const byStatus = countByStatus(db);
  const bySeverity = (
    db.db
      .prepare(
        `SELECT f.severity, COUNT(*) AS n FROM findings f
         LEFT JOIN finding_dismissals d ON d.finding_id = f.id
         WHERE d.id IS NULL GROUP BY f.severity`,
      )
      .all() as Array<{ severity: string; n: number }>
  ).reduce<Record<string, number>>((acc, row) => ({ ...acc, [row.severity]: row.n }), {});
  const topRules = db.db
    .prepare(
      `SELECT rule_id AS ruleId, severity, COUNT(*) AS n FROM findings f
       LEFT JOIN finding_dismissals d ON d.finding_id = f.id
       WHERE d.id IS NULL GROUP BY rule_id ORDER BY n DESC LIMIT 20`,
    )
    .all();
  const report = {
    generated_at: nowIso(),
    policy: {
      autoRejectOnCritical: true,
      note: 'Automated static scanning only. A clean scan is not proof of safety; approval is always explicit and human.',
    },
    skillsByStatus: byStatus,
    findingsBySeverity: bySeverity,
    topRules,
  };
  const out = path.join(paths.reports, 'security-report.json');
  await writeFileAtomic(out, `${JSON.stringify(report, null, 2)}\n`);
  return out;
}

export const countByStatus = (db: VaultDb): Record<string, number> =>
  (
    db.db.prepare('SELECT status, COUNT(*) AS n FROM skills GROUP BY status').all() as Array<{ status: string; n: number }>
  ).reduce<Record<string, number>>((acc, row) => ({ ...acc, [row.status]: row.n }), {});
