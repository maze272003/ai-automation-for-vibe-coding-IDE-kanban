# Troubleshooting

All commands accept `--root <dir>` and honor `SKILL_VAULT_ROOT`. Logs (redacted JSONL) live in
`<root>/logs/`. Set `SKILL_VAULT_DEBUG=1` for stack traces.

| Symptom | Cause | Recovery |
|---|---|---|
| `MCP unavailable … falling back to REST (anonymous 50/day quota)` | MCP endpoint rejected the request (header/version mismatch or a transient Cloudflare challenge) | just run `discover` again — the client now negotiates `MCP-Protocol-Version`; REST fallback burns quota, so prefer repeated MCP attempts |
| `RATE_LIMITED` / `DAILY_QUOTA_EXCEEDED` notes during REST discovery | anonymous REST quota (50/day) | wait for the 00:00 UTC reset, or use MCP transport: `discover --transport mcp` |
| `query is too short` errors from `search_skills` | the server requires a non-empty keyword | the vault now uses the category label as the query; for custom runs pass `--categories` with real slugs |
| `Response … exceeded size cap of … bytes` (e.g. openclaw/openclaw) | repository tarball exceeds `download.maxArchiveBytes` (100 MiB) | intentional guard. Raise the cap knowingly in `vault.config.json`, or wait for targeted per-file retrieval (see limitations) |
| Skill stuck in `failed` with `repository contains no SKILL.md` | the linked repo has no Agent-Skills content | nothing to fetch; the row keeps provenance. Retry later with `download --resume` |
| `disk guard triggered` | free space below `download.minFreeDiskBytes` at the vault root | free space or lower the threshold deliberately |
| Exit code 1 after `download` with failures listed | some repos failed (all recorded in `download_attempts`) | `download --resume` retries `failed` rows; inspect with `explain --skill ID` |
| Approve refuses: "N undismissed critical/high finding(s)" | approval is blocked while findings stand | `dismiss-finding --finding N --reason …` after review, or `approve --force` (audited) |
| `verify` reports mismatches | stored content changed on disk | re-download the skill or restore from `backup`; content is meant to be immutable |
| `integrate` skips a skill: "target already exists and is not managed by this vault" | a user skill with the same name exists | never overwritten. Rename one side, or uninstall the user skill manually |
| `opencode NOT detected on PATH` but it is installed | installed as a `.ps1`/`.cmd` shim the detector could not launch | the detector now falls back to shell resolution; otherwise verify `opencode --version` in the same shell |
| Corrupt/locked SQLite after a crash | WAL files left behind | `restore --dir <backup> --confirm` from `backups/`, or delete `<root>/indexes` and re-sync |
| Re-discovery finds nothing new | all pages in scope are checkpointed as finished | `discover --no-resume` re-enumerates from page 1, or raise `--max-pages` |

## Safe recovery patterns

```powershell
node apps/skill-vault/src/cli.ts backup                       # before risky operations
node apps/skill-vault/src/cli.ts verify                       # integrity of content vs manifest
node apps/skill-vault/src/cli.ts restore --dir <root>\backups\<stamp> --confirm
node apps/skill-vault/src/cli.ts download --resume            # continue a partial run
```
