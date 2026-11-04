# Pixel Agents Office Integration — Design

Date: 2026-11-04
Status: approved (user) · pending implementation
Supersedes: `2026-11-04-dashboard-agent-pixels-design.md` (native dashboard dots)

## Problem

The app gives no at-a-glance, living view of agent activity across projects. The
user wants to see all agents working on the different projects, and chose to
reuse [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents) (MIT,
v1.5.0) — which renders running agents as animated pixel-art characters in a
virtual office — rather than building a custom indicator.

## Goal

Every planner / implementer / reviewer run appears as an animated character in
an embedded, read-only Pixel Agents office view inside the desktop app. The
character spawns when the run starts and despawns when it ends.

## Non-goals (phase 2+, explicitly out of scope now)

- Tool-level animation fidelity (typing when editing, reading when searching).
  Requires subscribing to OpenCode session SSE events; v1 shows a generic
  "Using aik-\<role\>" bubble.
- First-class upstream provider (an in-tree `HookProvider` PR to pixel-agents).
- Launching agents from the office, terminal attach, layout editing from our
  app (their UI handles layout; our embed is read-only).
- Native dashboard dots (superseded).

## Verified integration facts (pixel-agents@1.5.0)

All verified in their source (clone at `%LOCALAPPDATA%\Temp\opencode\pixel-agents`),
not just the README:

- Event ingest: `POST /api/hooks/:providerId` (any id matching `^[a-z0-9-]+$`;
  the id is ignored at normalization — Claude shapes are assumed). Bearer
  token auth; body must contain `session_id` + `hook_event_name`; 64 KB cap.
  `server/src/httpServer.ts`.
- Lifecycle protocol: `SessionStart{cwd}` stages a pending session; a follow-up
  `PreToolUse`/`PostToolUse`/`Stop`/`Notification`/`PermissionRequest` confirms
  it and creates the character; `SessionEnd{reason:"exit"}` despawns.
  `server/src/hookEventHandler.ts`, examples in `server/manual-hook-events.http`.
- Hooks-only agents (no `transcript_path`) are adopted **only** when the
  Watch All Sessions setting is on; directory registration does not register
  tracked project dirs in standalone. `server/src/agentRuntime.ts:156-216`.
- Watch All Sessions: `pixel-agents.watchAllSessions`, persisted globally in
  `~/.pixel-agents/config.json` under the `standalone` namespace; mutable only
  via a privileged WebSocket client message `{"type":"setWatchAllSessions",
  "enabled":true}` (no HTTP route). `server/src/clientMessageHandler.ts`,
  `server/src/configPersistence.ts`.
- Character display name = `basename(cwd)` for hooks-only agents; the cwd need
  not exist on disk. `server/src/fileWatcher.ts:1069-1094`.
- Spawn: `node dist/cli.js` (npm package `pixel-agents`; `core/` types are not
  published — spawn only, no library import). Omit `--port` for an OS-assigned
  ephemeral port; registry entry `~/.pixel-agents/servers/<pid>-<port>.json`
  (mode 0600, written before the stdout URL) carries `{port, pid, token}`.
  `GET /api/health` is unauthenticated. `server/src/server.ts`, `server/src/cli.ts`.
- Reuse: a spawn joins an already-running standalone server with identical
  access profile (`servesSpa` + `standalone{terminal,host,allowedHosts}`); the
  `--port` flag is not compared. `--no-terminal` differs from the default
  profile and therefore yields a private instance. `server/src/server.ts:112-122`.
- Read-only view: a webview without `?token=` receives the full agent list and
  live updates; every mutating client message is refused server-side.
  `server/src/clientMessageHandler.ts:128-134`.
- No CSP / X-Frame-Options headers on their server; no telemetry; all URLs
  loopback. Windows: spawn `node dist/cli.js` directly (avoid `.cmd` shims);
  `~` resolves to `%USERPROFILE%`; use forward slashes in `cwd` payloads.
- Hooks-only characters do not survive an office-server restart (their design);
  they reappear when the next event arrives.

## Architecture

```
┌─ desktop main ────────────────────────────────────────────────┐
│ settings.json: agentOffice=true/off                            │
│ office-server.ts: spawn pixel-agents CLI (--no-terminal),     │
│   read registry {port,token}, health-poll, kill on stop       │
│ office-view.ts: WebContentsView over the renderer container   │
│ init message ──▶ orchestrator: agentOffice:{url,token}        │
└───────────────────────────────────────────────────────────────┘
┌─ orchestrator ────────────────────────────────────────────────┐
│ planner/implementer/reviewer: appendOutbox(run.started/       │
│   run.finished) at existing lifecycle points                  │
│ office/bridge.ts: bus.subscribe → readOutboxAfter → translate │
│   → POST /api/hooks/aik (Bearer), retry 3x(500/1500ms),      │
│   bounded offline queue, redacts token                       │
└───────────────────────────────────────────────────────────────┘
┌─ renderer ────────────────────────────────────────────────────┐
│ /office route + sidebar item; reports container bounds via    │
│ aik:office-bounds; Settings card toggles the feature          │
└───────────────────────────────────────────────────────────────┘
```

## Component design

### 1. Bundling + spawn — `apps/desktop`

Follows the `opencode-runtime` pattern (`apps/desktop/src/main/opencode.ts`,
`assets/opencode-runtime/`):

- `apps/desktop/assets/pixel-agents-runtime/package.json`:
  `"dependencies": { "pixel-agents": "1.5.0" }` (exact). Shipped via
  electron-builder `extraResources`; installed on demand (`npm ci
  --no-fund --no-audit`) into `<dataDir>\runtime\pixel-agents`.
- `PIXEL_AGENTS_PIN = '1.5.0'` exported from a new
  `packages/contracts/src/pixel-agents.ts`, verified at install like
  `OPENCODE_PIN`. The asset dir is not scanned by `npm run check:pins`; the
  runtime gate enforces the pin.
- New `apps/desktop/src/main/office-server.ts` (modeled on
  `opencode-server.ts`): spawn `node <runtime>/node_modules/pixel-agents/dist/cli.js
  --host 127.0.0.1 --no-terminal`; discover `{port, token}` by polling
  `~/.pixel-agents/servers/` for an entry whose pid matches the child;
  readiness via `GET /api/health`; lazy singleton; stop = kill child (registry
  self-cleans via pid-liveness); best-effort, never blocks app startup.

### 2. Adoption setup

The **bridge** (after its first successful health check) connects one
WebSocket client to `ws://127.0.0.1:<port>/ws?token=<token>` using Node's
global `WebSocket` (no new dependency; no Origin header → allowed) and sends
`{"type":"setWatchAllSessions","enabled":true}`; disconnect. Purpose:
hooks-only sessions are otherwise silently dropped. The setting persists
globally in the user's `~/.pixel-agents/config.json` — this is disclosed in
the Settings card copy. We never set it back to false.

### 3. Run lifecycle events — `apps/orchestrator/src/agents/*`

Emit the (already-declared, never-emitted) outbox topics at the existing
lifecycle points, following house style (`appendOutbox` inside the write +
`bus.notify(seq)` after):

- After the `agent_runs` insert in `planner.ts` (~L82), `implementer.ts`
  (~L110), `reviewer.ts` (~L205): `run.started` with
  `data = { runId, role, storyKey, projectKey }`, `provenance: 'system'`.
- At every terminal `update(agentRuns).set({ status: … })` in the three
  agents (interrupted / failed / succeeded paths): `run.finished` with
  `data = { runId, role, storyKey, projectKey, status, exitReason? }`.

`EventEnvelope.storyId` is set where known. `cwd` is not stored per run today;
the bridge does not need the real cwd (see §4).

### 4. Bridge — `apps/orchestrator/src/office/bridge.ts`

`new PixelAgentsBridge({ db, bus, logger, redact, office })` constructed in
`app.ts` next to the agents **only when** the init message carries
`agentOffice: { url, token }` (the `gatewayToken` presence-switches-a-stack
convention). The token is registered with the redactor immediately.

- Subscribe to the bus; on notify, `readOutboxAfter(cursor)`, filter
  `run.started` / `run.finished`. Cursor initializes to the current outbox
  max — a restarted orchestrator never replays old runs.
- Translate (HTTP per house convention: global `fetch`,
  `AbortSignal.timeout(…)`, retry 3× with 500/1500 ms backoff on transport
  error / 5xx only):

| Our event | POST sequence to `/api/hooks/aik` | Character effect |
|---|---|---|
| `run.started` | `{session_id:"aik-run-<runId>", hook_event_name:"SessionStart", source:"startup", cwd:"AIK/<projectKey>/<storyKey> <role>"}` then `{…, hook_event_name:"PreToolUse", tool_name:"aik-<role>", tool_input:{story:"<storyKey>"}}` | Character spawns, labeled `basename(cwd)` → **"INV-4 implementer"**, busy bubble "Using aik-implement" |
| `run.finished` (any status) | `PostToolUse` → `Stop` → `{…, hook_event_name:"SessionEnd", reason:"exit"}` | Bubble clears, "Done" flash, character despawns |

- `session_id` is `aik-run-<runId>` (stable, unique per run; the OpenCode
  session id is not yet known at insert time). The synthetic `cwd` uses
  forward slashes and never needs to exist — hooks-only agents use it only
  for the display label.
- Offline resilience: while health checks fail, events queue in memory
  (bounded, FIFO, cap 100; oldest dropped with a redacted warn log); on
  recovery the queue flushes in order. Lost events degrade gracefully (a
  character may linger or never appear; the next run self-heals).
- Errors are logged through `logger` with `redact()` applied; the token never
  appears in logs (redactor secret + no token in URLs that get logged).

### 5. Office view — renderer + desktop main

- **Embedding choice**: an `<iframe>` is not viable in production — the
  packaged UI loads from the `app://` secure scheme and an `http://127.0.0.1`
  subframe would be blocked as mixed content (CSP aside). Dev mode
  (`http://localhost:5173`) would work but prod would silently break.
  Instead the desktop main owns a **`WebContentsView`** (Electron 44) that
  loads `http://127.0.0.1:<port>/` **without** `?token=` → read-only office.
- New trusted IPC `aik:office-bounds` (renderer → main): the `/office` route
  reports its container `getBoundingClientRect` (and on window resize /
  ResizeObserver) — main shows/hides/positions the WebContentsView over that
  rect (DIP coordinates; `win.getContentBounds()` math). When the route is
  inactive the view is hidden.
- No preload is injected into their page; `will-navigate` on that webContents
  is pinned to the office origin (`http://127.0.0.1:<port>/`), everything
  else denied.
- `apps/ui/src/routes/office.tsx` + route + sidebar link "Office". When the
  feature is off: empty state "Enable in Settings". When on but server
  starting: skeleton. The page also renders an accessible text status line
  (the canvas itself is decorative).
- Settings (`aik:app-settings` pattern): `AppSettings` gains
  `agentOffice: boolean` (default `false`); Settings page gains an "Agent
  office" card with a real `<input type="checkbox">` (E2E-checkable, like the
  settings radios). Toggling calls for an **orchestrator restart** via the
  existing supervisor so the new init message (with/without `agentOffice`)
  takes effect immediately — the supervisor already owns restart machinery and
  in-process restart takes ~a second. Toggling on also starts the office
  server; toggling off stops it and hides the view. Card copy discloses:
  bundled Pixel Agents (MIT), runs locally on 127.0.0.1, read-only embed, and
  that the global Pixel Agents "Watch All Sessions" setting is enabled.

### 6. Init message contract

`OrchestratorOptions` gains optional `agentOffice?: { url: string; token:
string }` (desktop → orchestrator init message, same channel as `token` /
`gatewayToken`). Absent ⇒ bridge never constructed (feature off). The
desktop only includes it when settings have the office enabled **and** the
office server reached readiness.

## Security review

- The pixel-agents token is a bearer capability. It lives in: their 0600
  registry file (their design), our main process memory, and the
  utility-process init message (in-process IPC, loopback machine only). It is
  registered with the redactor; never logged, never persisted by us, never
  sent to the renderer. The office URL handed to the WebContentsView is
  tokenless.
- The embed is read-only by their server's enforcement (verified), not by
  our UI alone.
- `--no-terminal` disables their PTY surface entirely for our instance.
- All traffic is loopback. Their hook endpoint has permissive CORS
  (`origin: true`) — irrelevant to us; it is still token-gated.
- No new outbound network access, no telemetry added (verified: none in
  pixel-agents server/webview).
- `assertTrusted` applies to the new IPC channel; office webContents gets no
  node access, no preload.

## Error handling & edge cases

- Office server crash: bridge queue absorbs events; view shows reconnect
  state; characters rebuild on the next run events (hooks-only agents do not
  survive their restart — their design).
- Orchestrator restart mid-run: cursor starts at outbox max; in-flight runs
  produce no character until their `run.finished` (which SessionEnds an
  unknown session → dropped harmlessly); the next run self-heals.
- User runs their own pixel-agents standalone: our `--no-terminal` access
  profile prevents instance reuse (verified comparison semantics).
- Concurrent runs (≤ 3 lanes): one character each (`aik-run-<runId>` unique).
- Feature toggled off mid-run: server killed; queued events discarded;
  no orphan processes (pid-liveness prunes registry).

## Testing

- **Orchestrator — outbox emission**: extend `planner/implementer/reviewer`
  tests: run.started appended with `{runId, role, storyKey, projectKey}` on
  insert; run.finished appended with status/exitReason on every terminal
  path (succeeded / failed / interrupted; reviewer retry loop per attempt).
- **Orchestrator — bridge unit tests** (mocked fetch, temp-dir DB via
  helpers): correct POST sequences for started/finished; Bearer header;
  `setWatchAllSessions` push on first health; retry on 5xx then success;
  queue-and-flush while unhealthy; queue cap; token redacted in captured log
  output; cursor init at outbox max (no replay).
- **Desktop — office-server lifecycle**: fake CLI child (test script that
  writes a registry file + serves /api/health) — spawn, discover, ready,
  stop; settings toggle round-trip starts/stops; packaging test extended for
  the new `extraResources` asset; `aik:office-bounds` trust + hide/show.
- **UI**: route renders empty state when off; settings checkbox flips
  `agentOffice`; sidebar link present.
- **e2e**: office content itself is not e2e-tested (requires the real
  bundled server) — recorded as a verification gap; the toggle and route
  empty state can be covered by the existing Playwright suite.

## Definition of done

- `npm run check:pins && npm run lint && npm run typecheck && npm test` pass.
- With the toggle on: starting a story run spawns a labeled character in the
  embedded office; finishing despawns it; multiple projects produce
  concurrent characters.
- Feature off by default; no pixel-agents process spawns when off.
- Token never appears in any log, persisted file, or the renderer.
- Spec + README updated (Settings → Agent office section).

## Implementation phases (for the plan)

1. `run.started` / `run.finished` outbox emission (independently testable).
2. Bridge service + `agentOffice` init option (unit-tested against mocks).
3. Desktop: runtime asset bundling, install gate, office-server manager,
   settings toggle, init passing.
4. Renderer: WebContentsView bounds plumbing, `/office` route, sidebar,
   Settings card, docs.
