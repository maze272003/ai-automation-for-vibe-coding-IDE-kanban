# 3D Agent Office — Design

Date: 2026-11-08
Status: approved (user, 2026-11-08) · plan: `docs/superpowers/plans/2026-11-08-3d-office.md` (awaiting plan review)
Supersedes (on completion): `2026-11-04-pixel-agents-office-design.md`, `2026-11-04-office-agent-activity-design.md` (the embedded Pixel Agents office)

## 1. Intent

The current Office page embeds the third-party Pixel Agents app (v1.5.0) in a
main-process `WebContentsView`. Its single small pixel map is owned by that app,
so it cannot be reshaped and has no notion of projects. The user wants a
spacious, professional 3D headquarters inside the desktop app where
**one imported project = one dedicated office room**, the building grows as
projects are added, and each room shows that project's AI team at work.

The office is a *view* over existing state. It reads projects, stories and agent
runs; it never changes workflow state. Every existing integration (project
import, Kanban, agent assignment, status sync, workflows) keeps working
unchanged.

## 2. Goals

- G1. Native 3D office rendered in the desktop app's renderer (`apps/ui`), no external server.
- G2. Hub-and-wings headquarters (user choice): central lobby hub with reception,
  AI Ops monitoring center, lounge and meeting rooms; four wing hallways radiate
  from the hub, lined on both sides with equally sized project suites
  (development room + connected QA lab, §6.4a).
- G3. Exactly one room per project; rooms are generated, placed and connected to a
  hallway automatically; supports ≥ 20 rooms initially with no hard upper limit.
- G4. Room interior in "pipeline row" layout (user choice): stations left → right
  Planner → Developers → Reviewer → QA → PM, matching Kanban column order.
- G5. Live agent activity: each station shows idle / planning / working /
  reviewing / testing / completed / error.
- G6. Navigation: building overview (default) with click-to-fly into a room;
  optional first-person walk mode; room list + search quick-jump.
- G7. Everything the user sees is customizable (user requirement): navigation
  preferences, room identity, displayed screens, graphics quality, and a room
  editor for furniture placement.
- G8. Rooms are archived, not destroyed, when their project goes away, and come
  back intact when the project returns.

## 3. Non-goals

- Web/browser build. Desktop app only (user requirement).
- Changing story status, assigning agents or launching runs from inside the 3D
  scene. Clicks only *navigate* to existing screens.
- A real Project Manager agent. The PM station is a progress display (§6.4).
- Multi-user / shared offices, avatars of humans, chat.
- Photo-real rendering or realistic textures (user chose voxel props + pixel agents).

## 4. Anti-goals (failure even if it "works")

- Merely enlarging the existing pixel map or stretching a grid of boxes.
- Cramped rooms, narrow hallways, furniture clutter, decorative noise.
- More than one project sharing a room; any room unreachable from a hallway; overlapping rooms.
- Deleting a project's room customizations when the project is removed.
- The office freezing or heating the laptop when left open (the user's machine is an
  i5-10310U with Intel UHD integrated graphics only).
- Any regression in project import, board, agent runs, or status sync.

## 5. Constraints

- Repo rules (`AGENTS.md`): exact dependency pins (`npm install -E`, `npm run check:pins`);
  required checks `npm run check:pins && npm run lint && npm run typecheck && npm test`;
  tests never touch a real repository (use `apps/orchestrator/test/helpers/temp.ts`);
  story status changes only via `WorkflowService` (the office never changes status);
  never log or persist secrets; never import `spikes/`.
- Stack (existing): Electron shell, Vite 8 + React 19.3 renderer (`apps/ui`), TanStack
  Router, Node 24 orchestrator (Fastify, Drizzle + better-sqlite3, SSE `/events`),
  shared Zod contracts in `packages/contracts`, schema + migrations in `packages/db`.
- Hardware: Intel UHD iGPU. Must stay smooth at "Medium" quality on this machine.
- Renderer runs under the `app://` scheme with a CSP; everything bundled locally, no CDN, no remote assets.

## 6. Design

### 6.1 Rendering stack *(my call)*

- `three` + `@react-three/fiber` (React 19–compatible major). Camera controls
  come from three's own `three/examples/jsm` addons (MapControls,
  PointerLockControls); sign/screen text is drawn into `CanvasTexture`s with a
  pixel font, so `@react-three/drei` is not needed (fewer dependencies, no
  worker/WASM CSP surprises). Exact versions pinned in the plan.
- Lives in `apps/ui` as a new feature folder `apps/ui/src/office3d/`:
  - `layout/` — **pure, framework-free TypeScript**: building and room layout
    generation (fully unit-testable, no three.js import).
  - `scene/` — React Three Fiber components (building shell, hallways, rooms,
    furniture, screens, stations, signage, lighting).
  - `state/` — office view-model derived from API data + SSE events.
  - `editor/` — room editor UI and logic.
- Lazy-loaded route chunk so the 3D code costs nothing until the Office page opens.
- **Visual style (user decisions, confirmed on mockups)** — a "pixel world in a
  modern building":
  - *Building shell*: modern architecture — smooth floors with subtle tile grid,
    walls, large windows, glass partitions and glass fronts (transparent
    material, no real refraction), hallway, signage. Baked-feel ambient light +
    one directional "sun" light through windows; soft contact shadows only on High.
  - *Props / furniture*: **voxel style** ("3D pixels") — every desk, chair,
    monitor, keyboard, couch, coffee bar, mug, plant, lamp, whiteboard and test
    board is built from cubes on a 0.25 m grid, with flat per-face shading and
    faint voxel seams. This supersedes the original request's "realistic
    materials and textures"; the user chose the voxel look over modern props.
  - *Screens*: all screens (monitors, Kanban wall, code activity, runs, QA test
    board, PM progress) show pixel-font, pixel-bar content.
  - *Agents*: pixel-art sprites (§6.5a).
- Voxel props are defined in code as small voxel models (arrays of coloured
  cells), converted at load time into one merged mesh per model type with hidden
  faces culled (greedy meshing), then instanced per placement — no external model
  files, no licensing questions *(my call)*.

### 6.2 Building layout (hub and wings)

Coordinate unit = 1 m. All values are defaults *(my call)*; constants live in one
`layout/dimensions.ts`.

- **Hub** (centre, ~36 × 36 m): reception desk + lobby seating at the entrance
  side, AI Ops monitoring center (wall of screens), lounge, two meeting rooms.
  Four exits, one per wing: North, East, South, West.
- **Wing hallway**: 5 m wide, lined on both sides by project suites. Each suite
  occupies a fixed **slot** of 22 m (along hallway) × 12 m (depth), interior height
  3.5 m: the **development room** (14 m) and, next to it, the connected **QA lab**
  (8 m), separated by a glass partition with an internal door (§6.4a). Both open
  onto the hallway through glass front walls; the development room carries the
  main entrance sign, the lab a smaller "QA Lab" sign.
- **Slot addressing**: `(wing ∈ N|E|S|W, index ≥ 0, side ∈ L|R)`. Slot index 0 is
  closest to the hub. A wing with `k` slot pairs has hallway length `k × 22 m`.
- **Fill order**: new rooms fill wings round-robin, nearest free slot first
  (N0L, E0L, S0L, W0L, N0R, E0R, …, N1L, …), so the building grows evenly
  outward. 20 projects = 3 slot pairs per wing (~66 m wings). Wings simply lengthen
  past that; there is no maximum.
- **Stability rule**: a room's slot is assigned once and persisted. Adding
  projects never moves existing rooms. Archiving frees nothing visually until the
  user runs **"Compact layout"** (explicit action in office settings), which
  reassigns slots to close gaps. This is the "automatic layout recalculation":
  the layout function recomputes geometry from slot assignments on every change,
  and compaction is available, but rooms never jump unasked.
- **Invariants** (enforced in pure code + unit tests): no two rooms share a slot;
  every room's door touches a hallway; every hallway connects to the hub;
  room footprints never intersect each other, the hub, or hallways.
- Building exterior: floor slab, outer walls with large window bands, ceiling
  hidden in overview (cut-away), visible in walk mode.

### 6.3 Room lifecycle and persistence

New table `office_rooms` (migration in `packages/db`), deliberately **not**
foreign-keyed to `projects` so it survives project deletion:

| column | notes |
|---|---|
| `id` | integer PK — the stable **room identifier** |
| `repo_path_norm` | normalized repo path (lower-cased on Windows, forward slashes, no trailing slash); unique — identity used to re-attach a room to a re-imported project |
| `project_id` | nullable; current project, `NULL` when archived by deletion |
| `project_key_snapshot`, `project_name_snapshot` | last known key/name, for archived display |
| `state` | `active` \| `archived` |
| `wing`, `slot_index`, `side` | slot assignment; nullable when archived after compaction |
| `customization` | JSON (Zod-validated `RoomCustomization`, §6.7) |
| `created_at`, `updated_at`, `archived_at` | |

Lifecycle (implemented in a new orchestrator `OfficeRoomService`, called from
`ProjectService`; office code never writes to `projects`):

1. **Project created/imported** (`POST /projects`, GitHub clone/link paths that create
   projects): look up room by `repo_path_norm`. Found → restore it (state `active`,
   `project_id` set, keep its slot if still free, otherwise next free slot; keep
   customization). Not found → create room, assign next free slot, default
   customization derived from the project (name, deterministic accent colour from key).
2. **Project deleted** (`DELETE /projects/:id`, existing hard purge): before the purge,
   mark the room `archived`, null `project_id`, snapshot key/name. Customization kept.
3. **Project status `archived`** (existing enum value; no UI sets it today): room
   shown as archived. **Status `unavailable`** (repo missing on disk): room stays
   in place, rendered dimmed with an "Unavailable" sign.
4. **Project restored** = re-imported with the same repository → step 1 re-attaches
   the room. Office settings also list archived rooms with "Delete permanently".
5. Startup reconcile: any active project without a room gets one (covers projects
   imported before this feature); any room whose `project_id` no longer exists is archived.

Room creation/archival emits a new outbox topic `office.rooms_changed` so open
office views refresh without polling.

API (orchestrator, follows existing `mutation()` idempotency pattern):
- `GET /office/rooms?include=archived` → rooms + slot + customization.
- `PATCH /office/rooms/:id` → customization only (Zod `RoomCustomization`).
- `POST /office/rooms/compact` → reassign slots, returns new assignments.
- `DELETE /office/rooms/:id` → only allowed for archived rooms.
- `GET /office/snapshot` → one call that returns, per active room, the station
  state (§6.5) and board column counts, so first paint needs a single request.

### 6.4 Project room interior (pipeline row)

Default interior for the 14 × 12 m development room, back wall opposite the glass
front (the QA lab is described in §6.4a):

- **Back wall screens**: Kanban board (live column counts + top cards per column),
  code activity (recent tool/file activity from `run.activity`), tasks/runs (active
  and last few runs with status). Screens are rendered as textures from a small
  2D canvas, re-drawn only when their data changes.
- **Stations, left → right**: Planner · Developers · Reviewer · PM, then the glass
  door into the QA lab at the right-hand end (QA moved into its own lab at the
  user's request). Each station
  = desk, chair, monitor(s), role label, status light (floor ring + desk lamp in the
  status colour) and a simple stylised agent figure when a run is active.
- **Developer zone scales** *(my call)*: the developer station is a fixed
  **reserved zone** (2 desks wide × 4 deep = up to 8 desks). Desks shown =
  max(2, active implementer runs), filling the zone; beyond 8 concurrent runs the
  zone keeps 8 desks and the last one shows a "+N" badge. The zone's footprint
  never changes, so it never collides with user furniture (§6.7).
- **Other stations** add a second seat when two runs of that role are active and
  show a "+N" badge beyond that; their footprint is likewise fixed.
- **Security role** (exists in `ROLE`): appears as a second desk in the Reviewer
  station only while a security run is active *(my call)*.
- **PM station** *(my call)*: no PM agent exists; the PM desk displays project
  progress — stories per Kanban column, count of BLOCKED stories with reason,
  stories DONE today. Its light: error if any BLOCKED, working if any active run,
  else idle.
- **Activity spots** (user requirement, §6.5a): a **reading lounge** (sofa, 3 seats,
  side table) in the front-left corner, a **coffee bar** (counter + coffee machine,
  3 standing places) in the front-right corner, and the existing huddle table
  beside it. Plants only as accents; nothing else by default (avoid clutter).
- **Entrance sign**: `<Project name> Development Office` (e.g. "Alpha Development
  Office"), in the room's accent colour, plus the project key.
- **Identity**: accent colour on sign, floor inlay, chair fabric; optional icon on
  sign and back wall.

### 6.4a QA lab (connected room)

User requirement: QA works in its own room, connected to the project's
development room but separate from the developers, where the user can watch
QA testing.

- 8 × 12 m, adjoining the development room's right-hand wall; glass partition with
  an internal door between them, plus its own glass front to the hallway with a
  "QA Lab" sign in the project's accent colour.
- **Test board**: a large wall-mounted touchscreen on the lab's back wall showing
  the checks for the project's stories in TESTING — each check with running /
  passed / failed state, story key, and duration.
- **Audit whiteboard**: on the side wall, listing the problems QA found — for each
  failing story, the failed check name and a short reason (from the check's
  recorded result, redacted and truncated). An entry is wiped off when that
  story's checks pass or the story leaves TESTING/REWORK.
- **Couch** (2 seats) for reading and thinking, a QA desk with monitor, one plant.
- QA status light sits above the internal door so it is visible from the
  development room and the hallway.

**QA character behaviour** (extends §6.5a):

| QA is… | Goes to | Animation | Bubble |
|---|---|---|---|
| running tests / checks | test board | touches the screen | "Testing: `<check>`" |
| reading or thinking | lab couch | reads / sits thinking | "Reading `<file>`" / "Thinking…" |
| hit a failure | audit whiteboard | writes on the board; a new entry appears | "Writing up: `<check>` failed" (stays ≥ 5 s) |
| all checks passed | test board, then leaves through the internal door | thumbs-up | "All checks passed ✓" |

**Data on `main`** (no QA agent yet, §6.5): the QA figure represents the automated
verification and is labelled "QA · automated checks". It appears when a
verification run starts for a story in the project and leaves when it ends.
Per-check state comes from `verification_checks` (check key, status). To make it
live, the plan makes the verifier (`apps/orchestrator/src/verify/runner.ts`) emit
the already-declared `check.started` / `check.finished` outbox topics with
`{ storyId, verificationRunId, checkKey }` (+ `status` on finished): check rows
are only written once a check completes, so `check.started` is emitted just
before each check is executed and `check.finished` right after its row is
inserted. Reading/thinking only happen once a real QA agent exists (Phase 6), whose
`run.activity` events then drive the couch/coffee behaviours like any agent; a
failed check or a QA finding sends it to the whiteboard.

### 6.5 Agent status mapping

Derived in the renderer view-model from `agent_runs` (via snapshot) and SSE
`run.started` / `run.activity` / `run.finished`, `story.transitioned`:

| Condition | Station state | Colour (default) |
|---|---|---|
| no active run for the role | idle | slate |
| planner run active | planning | blue |
| implementer run active | working | amber |
| reviewer / security run active | reviewing | violet |
| qa run active, or story in `TESTING` (see data sources below) | testing | cyan |
| run finished succeeded (shown 60 s, then idle) | completed | green |
| run finished failed / interrupted, or story BLOCKED with that role's run last | error | red (persists until next run of that role or story leaves BLOCKED) |

**Data sources on `main` (user decision: build on `main`, not after Phase 6)**:
- Planner, implementer **and reviewer** already emit `run.started` /
  `run.finished` / `run.activity` (verified in code at plan time; an earlier
  draft wrongly said the reviewer did not). No agent change is needed. The
  verifier's `check.*` events (§6.4a) are the only change to orchestrator
  behaviour, and they only add outbox events.
- **QA station** has no QA agent on `main`: it shows *testing* while any story in
  the project is in status `TESTING` (from `story.transitioned`) or a verification
  run is active (`check.*`, §6.4a), and uses the story's latest
  `verification_runs` row for completed (passed) / error (failed).
  When Phase 6 adds real `qa` agent runs, a `qa` run takes precedence over the
  verification-derived state for that story.
- **Security desk** appears only when a `security` agent run exists — none on
  `main` today; it works without further change once Phase 6 lands.
- `check.started` / `check.finished` are declared but not emitted on `main`
  today; §6.4a adds their emission.

**Several stories at once** *(my call)*: a project may run several stories in
parallel (`maxConcurrentLanes`). State is tracked **per (story, role)**, then
aggregated per station:
- Each active run gets its own seat/figure, coloured by its own state.
- The station light shows the most urgent state across its stories, in order
  error > active state > completed > idle. Error is per story: it clears when that
  story's role runs again or the story leaves BLOCKED. A story that stays BLOCKED
  keeps the light red — that is the honest state; the PM desk lists it.
- Clicking a station with exactly one relevant story navigates directly; with
  several, a small popover lists them (story key, title, state) and each entry
  navigates to its terminal.

Colours come from the existing theme tokens where possible and are user-overridable (§6.7).
Lost/late events self-heal: the view-model re-fetches `/office/snapshot` on
`system.resync` and every 60 s while the page is visible.

### 6.5a Agent characters, movement and speech bubbles

The user wants to *see what each agent is doing* by where it goes in the room,
with a pop-up saying what it is doing: reading → goes to the couch and shows
"Reading"; coding → goes to its desk and shows "Coding"; thinking → goes for a
coffee.

**Appearance** (user decision, style C): **pixel-art characters** standing in the
3D office as camera-facing sprites ("standees"), drawn with nearest-neighbour
filtering so pixels stay crisp. Shirt in the role colour (Planner blue,
Developer amber, Reviewer violet, QA cyan, PM green); developer sprites get a
per-seat variation (hair/skin palette swap, chosen deterministically from the run
id) so several developers are distinguishable. Sprite-sheet frame animations:
idle, walk (4 directions), sit-type, sit-read, stand-sip-coffee, touch-board,
write-on-whiteboard, thumbs-up. Speech bubbles use a pixel font and pixel frame.
Sprite sheets are original art made for this app (no copied assets), defined in
code as pixel grids and painted into an in-memory canvas texture at load (no
image files, CSP-safe); a sprite sheet is small, so this is light on the iGPU.

**One figure per active run.** It enters through the room door when the run
starts and leaves through it when the run finishes (with a brief "Done ✓" or
"Failed ✗" bubble first). Between runs, a role's desk is empty (idle).

**Activity → place → bubble** (from `run.activity` tool-start/tool-end, message and
subagent events, which already exist for planner and implementer and will exist
for reviewer, §6.5):

| Agent activity (event) | Goes to | Animation | Bubble |
|---|---|---|---|
| read / grep / glob / list / search / web fetch tools | reading lounge (sofa) | reads | "Reading `<file>`" |
| edit / write / patch tools | own desk | types | "Coding `<file>`" |
| bash / shell tool | own desk | types | "Running `<command>`" (or "Testing" when the command is the project's configured test command) |
| reasoning ("Thinking" activity), or no event for > 8 s while the run is active | coffee bar | sips coffee | "Thinking…" |
| message text (writing its answer) | own desk | types | "Writing" |
| subagent start | huddle table | gestures | "Delegating to `<name>`" |
| any other tool | own desk | types | "Using `<tool>`" |
| QA (any activity) | QA lab — see §6.4a | | |

- Bubble text uses the activity `summary`, which the orchestrator already
  redacts and truncates; the renderer additionally shortens to ~40 chars. Bubbles
  float above the figure, always face the camera, and are readable in overview
  zoom (shown on hover/selected room in overview to avoid clutter).
- **No jitter** *(my call)*: agents call tools many times per second, so a figure
  only changes place after the new activity has lasted ≥ 3 s and it has stayed
  ≥ 4 s at its current place; the bubble text updates immediately even when the
  figure stays put.
- **Walking**: speed ~1.4 m/s along a per-room waypoint graph (door, each desk
  seat, sofa seats, coffee places, huddle seats, connected through the central
  walkway) generated by the pure layout code from the room's furniture layout
  (so it follows the room editor's arrangement). No physics; figures may pass
  through each other.
- **Full spots**: if all sofa seats or coffee places are taken, the agent does that
  activity at its own desk (bubble still says "Reading"/"Thinking").
- **Editor**: the reading lounge, coffee bar and huddle table are special items
  (movable, not deletable) like stations; the waypoint graph is rebuilt on save.
- **Preference**: "Agent movement" setting — full (walk to spots, default) | desk
  only (stay seated, bubbles only) | off (no figures, desk lights only), also
  forced to "desk only" on Low quality.

### 6.6 Navigation and interaction

- **Overview (default)**: orbit/map camera above the building, ceilings cut away,
  room labels always readable, each room tinted by its aggregate state (any error >
  any active > idle). Mouse drag pan, wheel zoom, right-drag rotate.
- **Fly-to**: click a room (or pick it from the quick-jump list) → camera animates
  (~0.8 s, eased) to a fixed vantage inside that room; Esc/Back returns to overview.
- **Walk mode** (opt-in, toggle key default `V`, configurable): first-person,
  WASD + mouse look with pointer lock, simple collision against walls (2D grid of
  wall segments from the layout — no physics engine). Esc exits to overview.
- **Quick-jump**: side panel with searchable room list (name, key, status dot,
  active agent count), archived rooms in a collapsed section. Keyboard: `/` focuses search.
- **Clicks** (navigation only, reuse existing routes):
  - station with an active run → `/projects/$projectId?terminal=<storyId>` (same
    target as today's office click);
  - Kanban screen → `/projects/$projectId` (board);
  - PM desk → board (the board has no status filter today; a BLOCKED filter is
    out of scope — plan-time adjustment).
- **Accessibility**: the 3D canvas is decorative; the quick-jump panel is a real
  list with text status for every room and station, so all information and all
  navigation targets are reachable without the canvas (and in E2E tests).
- Global shortcuts: integrate with existing `apps/ui/src/lib/shortcuts.ts`
  registry so office keys appear in the shortcuts dialog and don't collide.

### 6.7 Customization

Two levels, both validated by Zod schemas in `packages/contracts`:

**Office preferences** (global; stored in `AppSettings` like the current
`agentOffice` flag, extended with an `office3d` object):
- default view on open: overview | last room | walk;
- walk mode enabled; mouse sensitivity; walk speed; camera fly speed. Office keys
  (`V` walk, `/` search, `Esc` back) are registered in the shortcuts registry and
  shown in the shortcuts dialog, but are **not rebindable in v1** — the registry
  has no rebinding support (plan-time adjustment);
- graphics quality: Low | Medium (default) | High (§9);
- show archived rooms in building (default off);
- status colour overrides per state;
- which wall screens rooms show by default (Kanban, code activity, tasks/runs).

**Room customization** (per room, `office_rooms.customization`):
- sign name override (default `<name> Development Office`), accent colour, icon
  (from a small bundled icon set added for this feature — the app currently uses
  only inline SVGs), screen toggles
  overriding the global default;
- **furniture layout**: list of `{ id, kind, x, z, rotationY }` items in room-local
  coordinates. `kind` ∈ a fixed catalogue (desk, chair, monitor-desk, sofa, plant,
  huddle-table, whiteboard, bookshelf, lamp, rug). Role stations are special items
  `{ kind: "station", role }` with a fixed footprint (the developer zone is the
  largest, §6.4) that can be moved but not deleted (they carry the status
  display); extra seats grow only inside that footprint. `null` layout = use the
  generated default.

**Room editor** (opened from a room via "Edit room"):
- top-down camera of that room only; drag to move, `R`/handle to rotate 90° (15° with
  modifier), Delete to remove, catalogue palette to add;
- snap to 0.25 m grid; items cannot overlap each other, walls, the door swing
  area, or the 1 m walkway from door to back wall (validated in pure code; invalid
  drops snap back);
- Save / Cancel / Reset to default; saving PATCHes the room customization.
- The QA lab is editable the same way; its test board, audit whiteboard and couch
  are special items (movable, not deletable).
- Hub (lobby/ops/lounge) is not editable in v1 *(my call)*.

### 6.8 Replacing Pixel Agents

- The `/office` route renders the new 3D office directly in the renderer (no
  `WebContentsView`, no external server). Sidebar entry stays "Office".
- The new office does not depend on the `agentOffice` toggle; it is always available.
- Final step of the work (after the 3D office is complete and verified): remove the
  Pixel Agents integration — `office-server.ts`, `office-view.ts`,
  `office-click-frames.ts`, `office-context.ts`, the orchestrator
  `office/bridge.ts` + its wiring in `app.ts`, the bundled
  `assets/pixel-agents-runtime`, `packages/contracts/src/pixel-agents.ts`,
  related IPC/preload entries, settings card, and their tests. The orchestrator
  `run.started`/`run.finished`/`run.activity` outbox events stay (the new office uses them).
  `agentOffice` is dropped from `AppSettings` with a tolerant settings reader so
  old settings files still load.

## 7. Data flow

```
orchestrator (DB: projects, user_stories, agent_runs, office_rooms)
   │  GET /office/snapshot, GET /office/rooms        SSE /events (run.*, story.*, office.rooms_changed, system.resync)
   ▼                                                     ▼
renderer office3d/state  ── view-model (rooms, slots, station states, screen data)
   │                         ▲
   ▼                         │ PATCH /office/rooms/:id (customization only)
layout/ (pure) → geometry ──► scene/ (R3F)  ──► clicks → TanStack Router navigate
```

## 8. Testing

- `layout/` pure unit tests (Vitest, `apps/ui/test`): slot fill order; 0, 1, 4, 20,
  57 rooms → no overlap, every door on a hallway, every hallway connected to hub;
  stability (adding rooms never moves existing ones); compaction closes gaps;
  developer column sizing 0–12 runs; editor collision rules; waypoint graph
  connectivity for default and edited rooms.
- Behaviour tests (pure): activity-event sequences → (place, bubble) per figure,
  including the 3 s / 4 s anti-jitter rule, idle → coffee after 8 s, full-spot
  fallback to desk, enter/leave on run start/finish; QA: check running → test
  board, check failed → whiteboard entry + figure at whiteboard, all passed →
  leaves; whiteboard entry cleared when the story passes.
- Orchestrator: verifier emits
  `check.started`/`check.finished` with redacted payloads (temp repos only).
- View-model tests: event sequences → station states (including completed timeout,
  error persistence, resync).
- Orchestrator tests (temp DB/temp paths only): room created on project create,
  re-attached on re-import of same repo (path normalization incl. Windows casing),
  archived (not deleted) on project delete, startup reconcile, compaction,
  customization validation, archived-only delete, `office.rooms_changed` emitted.
- Renderer: the repo has no component-test setup (Vitest runs in `node`), so all
  renderer logic lives in pure modules with unit tests and the R3F layer stays
  thin; E2E checks that the quick-jump list renders every room and station
  status as text.
- E2E (existing desktop E2E harness): open Office → room list shows imported
  projects → selecting one navigates; Settings quality toggle persists.
- Existing project/board/workflow tests must stay green. Required repo checks before
  claiming done.

## 9. Performance budget *(my call)*

- Target ≥ 45 fps at Medium on Intel UHD 620-class GPU at 1080p with 20 rooms; ≥ 30 fps with 40.
- Render-on-demand (`frameloop="demand"`): frames are drawn only on camera
  movement, animation, or data change — idle office ≈ 0 % GPU.
- Instanced meshes for repeated furniture; merged static geometry per room; shared materials.
- Rooms outside the camera frustum or > N m away in walk mode skip screen texture
  updates; screens update at most 1×/s.
- Quality levels: **Low** — no shadows, no glass transparency (tinted opaque),
  pixel ratio 1, simplified furniture; **Medium** — glass, no real-time shadows,
  baked ambient occlusion look; **High** — contact shadows, MSAA, device pixel ratio.
- Page hidden / route inactive → render loop stops entirely.

## 10. Decided by the user

- Build our own 3D office; desktop app only; replaces the Pixel Agents embed.
- Hub-and-wings building (option C).
- Pipeline-row room interior (option A) as the default room layout.
- Navigation: overview + click-to-fly, optional walk mode, quick-jump list.
- Everything customizable, including a room editor for furniture.
- One project = one room; archive on removal, restore on return; supports 20+ rooms.
- Agents are pixel-art characters (style C) inside the 3D office.
- Props/furniture are voxel style (option B); building shell stays modern glass
  architecture; screens show pixel content (mockup: `suite-detailed-v2`).
- Agents move to a place that shows their activity, with a speech bubble:
  reading → couch "Reading", coding → desk "Coding", thinking → coffee.
- QA has its own connected QA lab, separate from the developers: testing → touches
  the test board; reading/thinking → lab couch; failure found → writes the problem
  on the audit whiteboard.
- Build on `main` now, not after the Phase 6 agent team merges; QA desk derives from
  testing status/verification runs until a real QA agent exists.

## 11. Left to the builder

- Exact library versions (pinned), file-level structure inside `office3d/`.
- Procedural furniture geometry details, materials and lighting tuning within the
  §6.1 style and §9 budget.
- Screen texture visual design (consistent with the app's existing theme tokens, light/dark).
- Phasing of the plan (suggested: layout core → persistence/API → scene shell →
  room interior + live status → navigation → customization/editor → Pixel Agents removal).
