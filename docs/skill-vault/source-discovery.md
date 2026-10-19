# SkillsMP Source Discovery — verified interfaces and limitations

Verified read-only on **2026-10-18** against the live site. SkillsMP is a **catalog**, not a
content host: its tools return metadata only. All skill content is fetched from the linked
public GitHub repositories using official interfaces.

## Verified public interfaces

| Interface | Endpoint | Limits (published) | Used by the vault |
|---|---|---|---|
| `robots.txt` | `https://skillsmp.com/robots.txt` | public pages allowed; `Crawl-delay: 1`; `/api/` disallowed for crawlers except `/api/llms.txt` | discovery stays on documented API/sitemap surfaces |
| `llms.txt` | `/api/llms.txt` | explicitly AI-agent-friendly; source of this table | interface verification |
| REST search | `GET /api/v1/skills/search?q=&category=&occupation=&language=&page=&limit=&sortBy=` | **anonymous 50/day, 10/min**; result window ≤ 1,000/query; follow `hasNext` | fallback transport |
| MCP server | `POST https://skillsmp.com/mcp` (Streamable HTTP) — `search_skills`, `get_skill`, `list_categories` | **no daily quota**; 30 tool-calls/60 s; 50 POST/10 s | primary transport |
| Sitemaps | `/sitemap.xml` → `skills-popular.xml`, `skills-discovered.xml`, … | public; crawl-delay 1 s | available for enumeration (not needed for current depth) |
| OpenAPI | `/openapi.json` (MIT) | — | schema verification |

Live observations (2026-10-18):

- `list_categories` returns `{domains:[{domain, categories:[{slug,name,count}]}]}` — **63 categories**.
- `search_skills` **requires `query` (minLength 1)**; supports `category`, `occupation`, `language`, `page` (≤50), `limit` (≤50), `sortBy` (`stars`/`recent`).
- The Streamable-HTTP revision requires an `MCP-Protocol-Version` header on requests **after** `initialize` (the client negotiates and sends it).
- One transient Cloudflare 403 challenge was observed during rapid MCP probing; the retry/backoff path recovered. Sustained crawling without politeness delays would be abusive — the vault enforces `minRequestIntervalMs` (default tuned to the MCP limits).

## How discovery works

1. `list_categories` (MCP) → classify coding-related categories with marker heuristics
   (`coding|software|develop|devops|program|engineer|data|ai|security|web|backend|frontend|testing|…`).
   22 of 63 categories qualified. Config `coding.categories` overrides the heuristic.
2. Per category, page through `search_skills` (query = the category label, sorted by stars,
   following `hasNext`), up to `--max-pages` per category (query-window cap: 1,000 results).
3. Rows are upserted by canonical SkillsMP id (`skillsmp:<external_id>`); the append-only
   `catalog/skills.jsonl` mirrors first-discovery events with timestamps and provenance.
4. Checkpoints (`catalog/sync-state.json`) record the last completed page per category and
   fully-enumerated categories; `discover` resumes from them by default.

## GitHub content interfaces

| Interface | Purpose | Quota impact |
|---|---|---|
| `git ls-remote --symref <repo> HEAD` | resolve default branch + **commit pin** | smart-HTTP; no REST quota |
| `https://codeload.github.com/{o}/{r}/tar.gz/{sha}` | pinned tarball download | not an API call |
| `api.github.com/repos/{o}/{r}` | license/metadata enrichment | 60/h anonymous; strictly budgeted (`githubApiBudgetPerRun`, default 20) and cached per run; optional |

## Known limitations

- **Counts are per-query-window, not global.** The API never exposes a full catalog count for
  a category beyond 1,000 results per query; the "3M+ skills" figure is the site's own
  marketing total across all categories. Our verified numbers are what the interfaces returned.
- REST anonymous access is 50 requests/day — the REST fallback is deliberately single-pass.
- `openclaw/openclaw` (392k★) exceeds the 100 MiB archive cap and is recorded as `failed`
  by design. Targeted per-file retrieval for such monorepos is a next step (see limitations.md).
- Stars/descriptions come from SkillsMP's index and can lag the upstream repositories.
