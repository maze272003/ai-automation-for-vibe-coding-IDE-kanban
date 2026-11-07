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

## Office

A native 3D office shows your agents at work. Each project gets its own suite with a QA lab,
and every planner/implementer/reviewer run appears as a pixel-art character walking to its
activity spot, with a bubble showing what it is doing. Use the overview, fly-to and walk modes
to look around; customize the suites and edit rooms and furniture with the room editor;
archive and restore rooms. Click a character to open that story's "Terminal Logs & Thoughts"
view. Preferences live under Settings → 3D office.

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
