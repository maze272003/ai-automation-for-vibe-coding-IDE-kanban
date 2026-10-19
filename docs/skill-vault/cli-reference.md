# Skill Vault CLI Reference

Entry point (from the repo root, no build step needed — Node ≥ 24.17 runs the TypeScript directly):

```powershell
node apps/skill-vault/src/cli.ts <command> [options]
# or, after `npm install`, via the workspace bin:
npx skill-vault <command>
```

Global: `--root <dir>` (default `%LOCALAPPDATA%\AiKanban\skill-vault`, or `SKILL_VAULT_ROOT`).

## Commands

| Command | Purpose |
|---|---|
| `init` | create vault layout + default config |
| `discover [--categories a,b] [--max-pages N] [--max-items N] [--transport mcp\|rest] [--no-resume]` | discover SkillsMP coding catalog (MCP preferred; checkpointed & incremental) |
| `catalog [--category X] [--status a,b] [--format table\|jsonl] [--limit N]` | list catalog rows |
| `download [--limit N] [--concurrency N] [--dry-run] [--no-resume] [--skill ID ...] [--all-accessible]` | download + scan; default target = coding catalog entries pending |
| `sync` | discover (resume) + incremental download + scan |
| `scan [--skill ID ...] [--rescan]` | (re)scan downloaded content |
| `approve --skill ID [--note T] [--force]` | **explicit** approval (moves content to `approved/`) |
| `reject --skill ID [--note T]` | explicit rejection (moves content to `rejected/`) |
| `dismiss-finding --finding N --reason T` | mark a finding a false positive (audited) |
| `search QUERY [--status a,b] [--category X] [--min-stars N] [--updated-within-days N] [--limit N]` | ranked local search (default scope: scanned+approved) |
| `recommend --repo PATH [--task TEXT] [--limit N]` | codebase-aware minimal skill set with explanations |
| `explain --skill ID` / `inspect --skill ID` | provenance, findings, attempts, hashes |
| `integrate opencode\|claude-code [--dry-run] [--approved-only\|--include-scanned] [--scope project\|global] [--project PATH] [--skills ID ...]` | install approved skills for an agent |
| `integration-status` | list vault-managed installations |
| `uninstall --skill ID [--agent opencode\|claude-code]` | remove only vault-managed files |
| `apply --repo PATH --task TEXT` | write a task plan with the selected minimal skill set |
| `verify` | recompute all content hashes vs the manifest |
| `report [--json]` / `status` | vault status summary |
| `export --format csv\|jsonl --out FILE` | export the catalog |
| `backup` / `restore --dir PATH [--confirm]` | backup (SQLite snapshot + catalog) / restore |
| `help` | usage |

Exit codes: `0` ok · `1` error · `2` usage error. Set `SKILL_VAULT_DEBUG=1` for stack traces.

## Examples

```powershell
# Full first run
node apps/skill-vault/src/cli.ts init
node apps/skill-vault/src/cli.ts discover --max-pages 5
node apps/skill-vault/src/cli.ts download --limit 60
node apps/skill-vault/src/cli.ts report

# Incremental follow-up
node apps/skill-vault/src/cli.ts sync

# Search + recommendations for the repo you are working on
node apps/skill-vault/src/cli.ts search "react performance optimization"
node apps/skill-vault/src/cli.ts recommend --repo . --task "harden Fastify API routes with zod"
node apps/skill-vault/src/cli.ts apply --repo . --task "harden Fastify API routes with zod"

# Approve a reviewed skill and install it for OpenCode (project scope)
node apps/skill-vault/src/cli.ts approve --skill gh:mattpocock/skills/skills/engineering/tdd
node apps/skill-vault/src/cli.ts integrate opencode --project .
node apps/skill-vault/src/cli.ts integration-status
node apps/skill-vault/src/cli.ts uninstall --skill gh:mattpocock/skills/skills/engineering/tdd
```

## Configuration (`config/vault.config.json`, validated with Zod)

| Section | Key defaults |
|---|---|
| `download` | concurrency 4 · maxRetries 4 · minRequestIntervalMs 250 (2100 tuned live for MCP) · requestTimeoutMs 30 s · maxArchiveBytes 100 MiB · maxFileBytes 10 MiB · maxFilesPerSkill 500 · maxBytesPerSkill 25 MiB · minFreeDiskBytes 2 GiB · githubApiBudgetPerRun 20 |
| `scan` | autoRejectOnCritical true · disabledRules [] |
| `coding` | categories [] (auto-classify) |
| `search` | defaultStatuses [scanned, approved] |
