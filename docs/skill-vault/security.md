# Skill Vault Security Policy

## Trust model

```
SkillsMP catalog      → metadata only, treated as untrusted text (prompt-injection checked)
GitHub repositories   → untrusted content: never executed, never imported, never shell-run
Vault content dirs    → untrusted at rest; immutable; scanned statically
Approved skills       → still untrusted code-shaped text; approval = human review recorded
```

Nothing downloaded is ever *executed* to determine safety. The tar extractor is a pure parser;
the scanner reads bytes and matches patterns. Integration copies files only.

## Pipeline states

`discovered → downloaded → quarantined → scanned → approved | rejected`, plus `duplicate`
(provenance kept, points at the canonical copy), `skipped` (policy: expanded into child skills
or repo already vaulted), `failed` (recorded with reason).

| Transition | Who |
|---|---|
| discovered → downloaded | engine, after hardened extraction + hash manifest |
| downloaded → scanned / quarantined / rejected | scanner (static) |
| quarantined → approved **or** rejected | **explicit human CLI action only** (audited in `approvals`) |
| any → duplicate | content-hash reconciliation |

**A failed or incomplete scan never results in approval.** A clean scan is *not* proof of
safety — it means no known-bad pattern matched. Every report repeats this.

## Scanner rules (static, local)

| Rule | Severity | Detects |
|---|---|---|
| SEC002 pipe-to-shell | critical | `curl … \| sh`, `iwr … \| iex`, `powershell -enc …` |
| SEC003 destructive | critical | `rm -rf /`, `mkfs`, `dd if=/dev/zero`, `format c:`, `Remove-Item -Force C:\Windows`, fork bomb |
| SEC004 secret-reveal | critical | "reveal your system prompt", "ignore previous instructions", exfiltrate instructions |
| SEC001 exfil-endpoint | high | webhook.site / ngrok / pastebin / discord webhooks / hooks.slack / file.io / 0x0.st … |
| SEC005 safeguard-bypass | high | `--dangerously-skip-permissions`, `--yolo`, disable sandbox, bypass permissions |
| SEC006 obfuscated-payload | high | long base64/hex blobs, `eval(atob(…))`, `exec(base64.b64decode` |
| SEC007 executable-content | high | .exe/.dll/.bat/.ps1/.jar… shipped inside a skill |
| SEC008 env-harvest | high | `printenv \| curl`, `cat ~/.ssh/id_rsa`, `.env` upload |
| SEC012 credential-paths | high | references to `.ssh/`, `.aws/credentials`, kube configs |
| SEC009 remote-install | medium | install scripts from non-registry URLs, `git clone … && ./run.sh` |
| SEC011 metadata-injection | medium | instruction-like text aimed at the agent in metadata |
| FMT001–FMT004 | medium/low | missing SKILL.md, missing frontmatter, name/description rule violations |
| LIC001 missing-license | info | no license in frontmatter or LICENSE file |

Severity handling: **critical ⇒ auto-rejected** (configurable, reversible via `approve --force`
with audit); high/medium ⇒ stays quarantined for manual review; info-only ⇒ `scanned`.
False positives are dismissible with an audit trail (`dismiss-finding --finding N --reason …`).

## Hardened extraction (`tar.ts`)

- Rejects absolute paths, drive letters, backslashes, `..` segments, NUL bytes.
- Symlinks/hardlinks/devices/FIFOs are **skipped and counted**, never materialized.
- Per-file, per-archive, entry-count and retained-bytes caps (zip/gzip bomb guards — the
  inflation cap trips before memory is exhausted).
- Binaries are skipped; only text-like files are retained for scanning/indexing.

## Agent-instruction safeguards

- Skill content is **never** treated as higher-priority than system instructions, repository
  rules (AGENTS.md/CLAUDE.md) or the user. Search/recommend output repeats this.
- `apply` plans never embed shell commands from skills; skills are referenced by path to be
  read on demand.
- Approving a skill requires either a clean scan or explicit dismissal/`--force` for every
  undismissed critical/high finding.

## What is intentionally NOT claimed

- No guarantee that an approved skill is safe.
- No dynamic analysis (sandbox execution) — static checks only.
- No OCR/deep parsing of unusual file formats; binary formats are skipped, not inspected.
