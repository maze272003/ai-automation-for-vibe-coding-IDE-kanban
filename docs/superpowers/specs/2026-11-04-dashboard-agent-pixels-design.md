# Dashboard Agent Pixels — Design

Date: 2026-11-04
Status: **superseded** by `2026-11-04-pixel-agents-office-design.md` — the user
pivoted to visualizing agents with Pixel Agents (pixel-agents-hq/pixel-agents)
instead of native dot indicators. Kept for history; not implemented.

## Problem

The dashboard lists every project, but gives no indication of agent activity. To see
whether an agent is working, the user must open each project's board, where the kanban
card already shows an animated teal "working" pixel per active run. With several
repositories being worked in parallel (up to `DEFAULT_MAX_CONCURRENT_LANES = 3`), there
is no at-a-glance cross-project view.

## Goal

One small animated pixel per currently active agent on each dashboard project card,
color-coded by role, with hover detail and click-to-board navigation.

## Non-goals (explicitly out of scope, future work)

- Emitting `run.started` / `run.finished` outbox events (declared in
  `packages/contracts/src/events.ts`, currently unimplemented). Polling is sufficient
  at the app's existing 2s cadence; events would only reduce perceived latency.
- Sidebar project-list pixels.
- Opening the terminal modal directly from the dashboard.
- New agent roles or changes to the agent run lifecycle.

## User experience

- Each dashboard project card shows one pixel per active agent in that project.
- Pixel colors by role: planner `#38bdf8` (sky), implementer `#2dd4bf` (teal — the
  same family as the board card's working strip), reviewer `#fbbf24` (amber).
- Pixel has the ping-halo animation used by the kanban card working strip.
- Hover (or keyboard focus) shows a one-line tooltip:
  `INV-4 · implementer · claude-sonnet · 3m 12s` (story key, role, model, elapsed).
- Click navigates to `/projects/$projectId` (the board), where the existing working
  strip and terminal viewer live. Deep-linking to the specific story is not attempted
  (the board already highlights active work).
- A project with no active agents renders no pixels — the card is unchanged from today.
- Data refreshes every 2 seconds while the dashboard is mounted.

## "Active" definition

A pixel is shown for a story when the board card would show its working strip, i.e.
exactly the derivation in `apps/ui/src/components/kanban/card.tsx`:

1. `user_stories.activeRunId` points at an `agent_runs` row with
   `status IN ('queued', 'running')`, **or**
2. `user_stories.planningStatus = 'planning'` with no active run row (planning job
   queued but the planner run has not started yet) → synthesized planner pixel.

Case 2 supplies: `role: 'planner'`, `model: 'OpenCode'`, `startedAt: story.updatedAt`,
`runId: null`. This keeps the dashboard and the board in agreement by construction.

## Architecture

### Contracts — `packages/contracts/src/projects.ts`

```ts
export const ActiveAgentRunDTO = z.object({
  runId: z.number().int().nullable(), // null in the planning-queued case
  storyId: z.number().int(),
  storyKey: z.string(),
  role: z.enum(ROLE), // planner | implementer | reviewer (packages/contracts/src/enums.ts)
  model: z.string(),
  startedAt: z.number(), // epoch ms
});
```

`ProjectDTO` gains `activeRuns: z.array(ActiveAgentRunDTO)` (required; the server
always fills it, empty array when idle). `GET /projects` and `GET /projects/:id`
both return it.

### Orchestrator — `apps/orchestrator/src/projects/active-runs.ts`

`activeRunsByProject(db: AikDb): Map<number, ActiveAgentRunDTO[]>`

One synchronous drizzle query (SQLite):

```
FROM user_stories
LEFT JOIN agent_runs      ON user_stories.active_run_id = agent_runs.id
LEFT JOIN model_profiles  ON agent_runs.model_profile_id = model_profiles.id
WHERE agent_runs.status IN ('queued','running')
   OR (user_stories.planning_status = 'planning' AND user_stories.active_run_id IS NULL)
```

Model falls back to `'OpenCode'` when the profile join misses (same fallback as
`apps/orchestrator/src/stories/dto.ts`). Results are grouped by
`user_stories.project_id`. `ProjectService.list()` and `get()` attach
`activeRuns: map.get(id) ?? []`. Archived projects are excluded by `list()` as today.

### UI

1. `apps/ui/src/lib/status-theme.ts` — add

   ```ts
   export interface RoleTheme { label: string; dot: string; glow: string; }
   export const ROLE_THEME: Record<Role, RoleTheme> = {
     planner:     { label: 'Planner',     dot: '#38bdf8', glow: 'rgb(56 189 248 / 0.55)' },
     implementer: { label: 'Implementer', dot: '#2dd4bf', glow: 'rgb(45 212 191 / 0.55)' },
     reviewer:    { label: 'Reviewer',    dot: '#fbbf24', glow: 'rgb(251 191 36 / 0.55)' },
   };
   export const ALL_ROLES: readonly Role[] = ROLE; // guard, mirrors ALL_STATUSES
   ```

2. New `apps/ui/src/components/dashboard/agent-pixels.tsx` —
   `AgentPixels({ projectId, runs })`. Renders `null` when `runs` is empty. Each pixel
   is a `<button>` (navigates with `useNavigate()`) sized `h-2 w-2 rounded-full`,
   colored `style={{ background: theme.dot }}`, wrapped in the existing one-line
   `Tooltip` (shows on hover **and** focus). Ping halo follows the kanban card pattern.
   Elapsed is derived from `startedAt` at render time (the 2s poll re-renders it).
   Accessibility: each button carries a full `aria-label`
   (e.g. `"implementer working on INV-4 with claude-sonnet — open board"`); the
   container is a `role="group"` labelled `"Active agents"` (only rendered when
   non-empty).
   Test ids: container `data-testid="project-agents-{KEY}"`,
   pixel `data-testid="agent-pixel-{KEY}-{runId|storyId}"`.

3. `apps/ui/src/routes/dashboard.tsx` —
   - `useEffect` adds a 2000 ms `setInterval` calling `load()` while mounted and
     `system.state === 'ready'` (mirrors the sidebar poll in `routes/root.tsx`).
   - `load()` keeps the previous `projects` on fetch failure instead of resetting to
     `[]`, so transient poll errors do not blank the grid or flicker pixels off. The
     initial load failure still leaves the empty state (starts `[]`).
   - Each card renders `<AgentPixels projectId={p.id} runs={p.activeRuns} />` in the
     badge row.

## Error handling and edge cases

- Story deleted mid-run → row disappears from the join → pixel disappears.
- Transient poll failure → last good payload retained.
- Clock skew → elapsed computed client-side from epoch-ms `startedAt`.
- `runId` null (planning queued) → test id falls back to story id.
- Multiple concurrent stories in one project → one pixel each, ordered by `startedAt`
  ascending (longest-running first).

## Testing

- **Orchestrator** — new `apps/orchestrator/test/projects-active-runs.test.ts` using
  `createTestDb`, `seedProject`, `seedStory` and the temp-dir helpers (never a real
  repository):
  1. running run → `activeRuns` lists role, model, storyKey, startedAt;
  2. succeeded/failed run → not listed;
  3. planning-queued story (no run row) → planner pixel with `runId: null`;
  4. active stories in two projects → each project only its own;
  5. archived project excluded from `list()`;
  6. model fallback to `'OpenCode'` when no model profile.
- **UI** — extend `apps/ui/test/status-theme.test.ts` with a `ROLE_THEME`
  completeness guard over `ALL_ROLES`.
- **e2e** — skipped: would require a live agent run. The behaviour is covered at the
  API/query level and the component is a thin pure render of that payload.

## Definition of done

- `npm run check:pins && npm run lint && npm run typecheck && npm test` pass.
- Dashboard cards show pixels only for active agents; board and dashboard agree.
- Pixels accessible via keyboard, labelled for screen readers.
- No secrets logged; no changes to run lifecycle or workflow state transitions.
