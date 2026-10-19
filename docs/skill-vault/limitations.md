# Limitations

## Source-side

- **No complete catalog count exists.** SkillsMP advertises "3M+ skills" but no interface
  returns a per-category total beyond the 1,000-result query window. Verified counts are what
  the documented interfaces actually returned at discovery time (see source-discovery.md).
- Anonymous REST is capped at 50 requests/day; MCP has no daily cap but 30 calls/min.
- `openclaw/openclaw` (392k★, ~10 catalog entries in the top results) exceeds the 100 MiB
  archive cap → recorded `failed`. **Next step:** targeted per-file retrieval
  (`raw.githubusercontent.com/<owner>/<repo>/<sha>/<path>/SKILL.md`) for entries whose
  catalog URL encodes the repo path, avoiding whole-repo tarballs for monorepos.
- SkillsMP metadata (stars, descriptions) can lag upstream GitHub.
- The SkillsMP catalog is GitHub-centric; non-GitHub sources in the catalog are recorded but
  not downloadable by the current engine.

## Engine

- Multi-skill repos are expanded on first download; later catalog entries for the same repo
  at the same commit are linked (`skipped`, "already vaulted") rather than re-fetched.
- Duplicate detection is byte-exact on SKILL.md content; near-duplicates (edited forks,
  translations) are not merged, though search collapses same-name results.
- Retained-file filtering skips binaries; a skill whose value is a binary asset will have
  that asset omitted from the vault copy (recorded as skipped-binary in extraction stats).
- The GitHub REST enrichment (license via API) is budgeted per run; without it, license
  detection falls back to parsing the LICENSE file in the tarball.

## Security

- Static scanning only — no dynamic/sandboxed execution analysis. A clean scan is not proof
  of safety; approval is always an explicit human action.
- Rules are pattern-based and will have false positives (dismissable with audit) and,
  theoretically, false negatives (novel obfuscations).

## Search / recommendation

- Keyword + metadata ranking (FTS5 when available, LIKE otherwise). Optional local semantic
  search is deliberately **not implemented** — no free local embedding runtime is guaranteed
  on this machine, and the prompt forbids requiring a paid embedding API. The ranking hook
  (`search.ts`) is where a local model could be added later.
- Recommendations are heuristic: stack detection from manifests + file extensions; task
  terms are matched against names/descriptions. They err toward small skill sets.

## Integrations

- OpenCode and Claude Code formats are handled per their documented layouts; other agents
  (Copilot, Codex, Cursor…) are not integrated yet. OpenCode also reads `.claude/skills/`,
  but the vault keeps per-agent directories explicit.
- Discoverability is verified at file level; we do not launch the agent to confirm runtime
  listing (too heavy/network-bound for CI).

## Scale

- Designed for hundreds of thousands of rows (streamed JSONL, SQL indexes, bounded batches),
  but live-verified at ~6.5k catalog rows / ~1.1k downloaded skills so far.
