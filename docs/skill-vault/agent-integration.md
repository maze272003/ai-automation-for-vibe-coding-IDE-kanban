# Agent Integration — OpenCode and Claude Code

Both agents follow the [Agent Skills](https://agentskills.io) open standard: one directory per
skill containing a `SKILL.md` with YAML frontmatter. The vault installs into each agent's
**documented** skills directory and never edits agent config files.

## Verified formats (2026-10-18)

| | OpenCode (v2.x) | Claude Code |
|---|---|---|
| Project skills | `.opencode/skills/<name>/SKILL.md` | `.claude/skills/<name>/SKILL.md` |
| Global skills | `~/.config/opencode/skills/<name>/SKILL.md` | `~/.claude/skills/<name>/SKILL.md` |
| Also reads | `.claude/skills/`, `.agents/skills/` (compat) | enterprise/plugin/additional dirs |
| Frontmatter | `name`†, `description`†, `license`, `compatibility`, `metadata` (+ `metadata["opencode/slash"]`, `metadata["opencode/autoinvoke"]`) | spec fields + Claude extensions (`allowed-tools`, `disable-model-invocation`, `context: fork`, …) |
| Name rules | `^[a-z0-9]+(-[a-z0-9]+)*$`, 1–64 chars, matches dir; description ≤ 1024 | same core rules |
| Docs | https://opencode.ai/docs/skills/ | https://code.claude.com/docs/en/skills |

† required by OpenCode.

## Commands

```powershell
# Detect agents (version-aware; reports NOT-detected instead of failing)
node apps/skill-vault/src/cli.ts integrate opencode --dry-run --project .
node apps/skill-vault/src/cli.ts integrate claude-code --dry-run --project .

# Install approved-only (default). --include-scanned also installs scanned-clean skills.
node apps/skill-vault/src/cli.ts integrate opencode --project C:\path\to\repo
node apps/skill-vault/src/cli.ts integrate claude-code --scope global
node apps/skill-vault/src/cli.ts integration-status
node apps/skill-vault/src/cli.ts uninstall --skill gh:owner/repo/path --agent opencode
```

## Safety properties

- **Approved-only by default**; `--include-scanned` is explicit.
- Conflict detection: an existing `<name>` directory **not** managed by the vault is never
  overwritten (reported as skipped). Vault-managed directories carry a `skill-vault.json`
  marker with the source skill id and content hash.
- Uninstall removes **only** directories whose marker matches the skill id; neighboring
  user skills are untouched.
- Per-agent validation produces a compatibility report (missing frontmatter, name-rule
  violations, fields the other agent ignores).
- Discoverability is verified at file level (SKILL.md present at the documented path with a
  valid name); the report includes the agent's own docs link.

## Verified in this environment (2026-10-18)

- OpenCode **2.0.29** detected on PATH; 6 approved skills installed to a scratch project's
  `.opencode/skills/` and `.claude/skills/`, markers written, uninstall tested.
- Claude Code is not installed on this machine; installs proceed to the documented layout
  and are reported as unverified-by-runtime.
