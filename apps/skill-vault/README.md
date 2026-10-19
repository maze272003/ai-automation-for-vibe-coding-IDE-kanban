# @aik/skill-vault

Local, persistent **Coding Skill Vault**: discovers coding skills from SkillsMP, downloads
them from their linked GitHub repositories (commit-pinned), scans them statically for
malicious or suspicious content, indexes them in SQLite, and recommends/installs selected
skills for OpenCode and Claude Code — without loading every skill into agent context.

- Architecture: `docs/skill-vault/architecture.md`
- CLI reference: `docs/skill-vault/cli-reference.md`
- Security policy: `docs/skill-vault/security.md`
- Source interfaces (verified): `docs/skill-vault/source-discovery.md`
- Agent integration: `docs/skill-vault/agent-integration.md`
- Troubleshooting / limitations: `docs/skill-vault/troubleshooting.md`, `docs/skill-vault/limitations.md`

## Quick start (Windows PowerShell, from the repo root)

```powershell
npm ci                                   # installs workspace deps (better-sqlite3, zod — already pinned)
node apps/skill-vault/src/cli.ts init    # vault at %LOCALAPPDATA%\AiKanban\skill-vault
node apps/skill-vault/src/cli.ts discover --max-pages 5
node apps/skill-vault/src/cli.ts download --limit 60
node apps/skill-vault/src/cli.ts report
```

No paid API is used. Discovery goes through SkillsMP's documented MCP/REST interfaces;
content comes from GitHub codeload tarballs pinned via `git ls-remote`.

## Trust model in one line

Everything downloaded is untrusted: it lands in `skills/quarantined/`, is scanned statically
(never executed), and only an **explicit** `approve` moves it to `skills/approved/`.
