# AI Kanban (working name)

Local-first Windows desktop app: you write user stories on a Kanban board; AI agents plan, implement,
test, review and rework them; you approve plans and merges. DONE requires evidence.

- Design spec: `docs/superpowers/specs/2026-10-18-autonomous-ai-ide-design.md`
- Implementation plans: `docs/superpowers/plans/`

## Requirements
Windows 10 22H2+ / 11 · Node ≥ 24.17.0 · Git for Windows ≥ 2.38

## Commands
| Command | Purpose |
|---|---|
| `npm ci` | install exact dependencies |
| `npm run check:pins` | fail on non-exact dependency versions |
| `npm run lint` · `npm run typecheck` · `npm test` | static checks and unit/integration tests |
