# AI Kanban (working name)

Local-first Windows desktop app: you write user stories on a Kanban board; AI agents plan, implement,
test, review and rework them; you approve plans and merges. DONE requires evidence.

- Design spec: `docs/superpowers/specs/2026-10-18-autonomous-ai-ide-design.md`
- Implementation plans: `docs/superpowers/plans/`

## Skill Vault

`apps/skill-vault` — a local Coding Skill Vault: discovers coding skills from SkillsMP,
downloads + security-scans them from their GitHub sources, and installs approved skills for
OpenCode/Claude Code. Docs: `docs/skill-vault/` · CLI: `node apps/skill-vault/src/cli.ts help`.
Vault data lives in `%LOCALAPPDATA%\AiKanban\skill-vault` (never in git).

## Agent office

Optional (Settings → Agent office, off by default): every planner/implementer/reviewer run
appears as an animated pixel-art character in an embedded office view powered by the bundled
[Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents) runtime (exact-pinned, MIT).
The office server runs locally on 127.0.0.1 with terminals disabled and is embedded read-only;
its loopback bearer token stays in the app's processes (redacted from all logs). Enabling the
feature also turns on Pixel Agents' global "Watch all sessions" setting (required for external
agents to appear). Design: `docs/superpowers/specs/2026-11-04-pixel-agents-office-design.md`.

- Click a character to open that story's "Terminal Logs & Thoughts" view (live reasoning,
  tool calls and output); while a run is in flight the character's bubble shows the agent's
  real activity (`Reading foo.ts`, `Running: npm test`, `Using Thinking`).

## Requirements
Windows 10 22H2+ / 11 · Node ≥ 24.17.0 · Git for Windows ≥ 2.38

## Commands
| Command | Purpose |
|---|---|
| `npm ci` | install exact dependencies |
| `npm run check:pins` | fail on non-exact dependency versions |
| `npm run lint` · `npm run typecheck` · `npm test` | static checks and unit/integration tests |
| `npm run build` | build the renderer and bundle the Electron shell into `apps/desktop/dist` |
| `npm start` | run the built app (data in `%LOCALAPPDATA%\AiKanban`; override with `AIK_DATA_DIR`) |
| `npm run dev` | Vite dev server + Electron (renderer hot reload) |
| `npm run e2e` | Playwright Electron end-to-end tests (run `npm run build` first) |

## Project lifecycle

- **Add project** — dashboard → pick an existing git repository; AI Kanban adopts the checkout
  (branch, origin, history) and never modifies it outside approved runs.
- **Git tab** — per project: stage/unstage/commit/discard, push/pull (`--ff-only`), branch
  dropdown with create-new, and history. Mutations pause while an agent run or merge is active.
- **Code tab** — lazy-loaded Monaco editor, one-directory-at-a-time file explorer, and literal
  search across the checkout. `Ctrl/Cmd+S` saves with optimistic concurrency (a file changed on
  disk raises a conflict); binary and >2 MiB files are read-only. Saves pause while an agent run
  is active, symlinks and `.git` are never followed, and search skips build/vendor directories.
- **Delete project** — dashboard card `⋯` → two-step confirm. Detaches the project and cleans
  app-owned worktrees (`%LOCALAPPDATA%\AiKanban\wt`); your folder on disk and `.git` are never touched.
