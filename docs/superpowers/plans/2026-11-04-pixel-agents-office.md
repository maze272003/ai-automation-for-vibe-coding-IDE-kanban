# Pixel Agents Office Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show every planner/implementer/reviewer run as an animated pixel-art character in an embedded, read-only Pixel Agents office view inside the desktop app.

**Architecture:** The orchestrator emits `run.started`/`run.finished` outbox events at the existing agent lifecycle points. A new `PixelAgentsBridge` service subscribes to the event bus and translates those into Pixel Agents' hook HTTP API (`POST /api/hooks/aik`). The desktop main process bundles the exact-pinned `pixel-agents` npm CLI as a runtime asset, spawns it privately (`--no-terminal`), and embeds its office web UI tokenless/read-only via a `WebContentsView` positioned over the renderer's `/office` route.

**Tech Stack:** Electron 44 (utilityProcess, WebContentsView), Fastify orchestrator, drizzle/SQLite outbox, Node global `fetch`/`WebSocket`, React 19 + TanStack Router, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-04-pixel-agents-office-design.md` (all "verified facts" below are backed by that spec's source-code citations).

## Global Constraints

- Dependencies use exact versions only (`npm install -E`); `npm run check:pins` enforces this — the runtime asset dir uses exact `"pixel-agents": "1.5.0"` = `PIXEL_AGENTS_PIN`.
- Before claiming done: `npm run check:pins`, then `npm run lint`, `npm run typecheck`, `npm run test` (run as separate commands — Windows PowerShell host).
- Tests must never touch a real repository or the real `%USERPROFILE%\.pixel-agents`; every test path comes from `fs.mkdtempSync(path.join(os.tmpdir(), ...))` or `apps/orchestrator/test/helpers/temp.ts`.
- Never log or persist secrets: the Pixel Agents bearer token is registered with the redactor, never appears in logs, persisted files, or the renderer. The office URL handed to the renderer/embedded view is tokenless.
- Story status changes only through `WorkflowService` — this plan never writes `user_stories.status`.
- Feature is off by default (`agentOffice: false`); no pixel-agents process spawns when off.
- Commits after every task. Shell is Windows PowerShell: never chain with `&&`.

## Execution notes (per-repo multi-agent mandate)

AGENTS.md asks for ≥20 parallel sub-agents when scope supports it. This plan's 13 tasks have hard sequential dependencies (Task 5 needs Task 1's events; Task 10 needs 7–9; Task 11 needs 10), so 20 agents would mostly idle or conflict. Largest useful parallelism: Tasks 2/3/4 in parallel (three disjoint agent files), and Tasks 8/9 in parallel after 7. Execute with subagent-driven-development, dispatching those batches together.

---

### Task 1: Run-event outbox helper

**Files:**
- Create: `apps/orchestrator/src/agents/run-events.ts`
- Test: `apps/orchestrator/test/run-events.test.ts`

**Interfaces:**
- Consumes: `appendOutbox(db, { topic, storyId, provenance, data }, now)` from `apps/orchestrator/src/events/outbox.ts`; `Role` from `@aik/contracts`.
- Produces (used by Tasks 2–4):
  - `runEventInfo(db: AikDbOrTx, runId: number): RunEventInfo | null` where `RunEventInfo = { runId: number; storyId: number; storyKey: string; projectKey: string; role: Role }`
  - `emitRunStarted(db: AikDbOrTx, now: Date, runId: number): void` — appends topic `'run.started'`, provenance `'system'`, data `{ runId, role, storyKey, projectKey }`
  - `emitRunFinished(db: AikDbOrTx, now: Date, runId: number, status: string, exitReason?: string | null): void` — appends topic `'run.finished'`, data `{ runId, role, storyKey, projectKey, status, exitReason? }` (omit `exitReason` when null/empty)

- [ ] **Step 1: Write the failing test**

```ts
// apps/orchestrator/test/run-events.test.ts
import { agentRuns } from '@aik/db';
import { describe, expect, test } from 'vitest';
import { emitRunFinished, emitRunStarted, runEventInfo } from '../src/agents/run-events.ts';
import { readOutbox } from './helpers/outbox.ts';
import { createTestDb, seedProject, seedStory } from './helpers/db.ts';

describe('run-events', () => {
  test('emits run.started and run.finished with story/project context', () => {
    const t = createTestDb();
    const project = seedProject(t.db, { key: 'INV' });
    const story = seedStory(t.db, project.id, { key: 'INV-4' });
    const run = t.db
      .insert(agentRuns)
      .values({
        storyId: story.id, role: 'implementer', attempt: 1, promptVersion: '1.0',
        opencodeVersion: '2.0.32', status: 'running', idempotencyKey: `test_${story.id}`,
        startedAt: new Date(1_000),
      })
      .returning()
      .get();

    expect(runEventInfo(t.db, run.id)).toEqual({
      runId: run.id, storyId: story.id, storyKey: 'INV-4', projectKey: 'INV', role: 'implementer',
    });

    const now = new Date(1_234);
    emitRunStarted(t.db, now, run.id);
    emitRunFinished(t.db, now, run.id, 'succeeded', null);

    const rows = readOutbox(t.db);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ topic: 'run.started', storyId: story.id, provenance: 'system' });
    expect(rows[0].data).toEqual({ runId: run.id, role: 'implementer', storyKey: 'INV-4', projectKey: 'INV' });
    expect(rows[1].topic).toBe('run.finished');
    expect(rows[1].data).toEqual({
      runId: run.id, role: 'implementer', storyKey: 'INV-4', projectKey: 'INV', status: 'succeeded',
    });
    t.close();
  });

  test('finished keeps a non-empty exitReason, drops empty ones; unknown run is a no-op', () => {
    const t = createTestDb();
    const project = seedProject(t.db);
    const story = seedStory(t.db, project.id);
    const run = t.db
      .insert(agentRuns)
      .values({
        storyId: story.id, role: 'planner', attempt: 1, promptVersion: '1.0',
        opencodeVersion: '2.0.32', status: 'failed', idempotencyKey: `test2_${story.id}`,
        startedAt: new Date(1_000), endedAt: new Date(2_000),
      })
      .returning()
      .get();

    emitRunFinished(t.db, new Date(2_000), run.id, 'failed', 'provider down');
    emitRunStarted(t.db, new Date(2_000), 999_999); // unknown run: silently ignored

    const rows = readOutbox(t.db);
    expect(rows).toHaveLength(1);
    expect(rows[0].data).toMatchObject({ status: 'failed', exitReason: 'provider down' });
    t.close();
  });
});
```

The test also needs a tiny outbox read helper — create it (it will be reused by Tasks 2–4):

```ts
// apps/orchestrator/test/helpers/outbox.ts
import type { EventEnvelope } from '@aik/contracts';
import type { AikDb } from '@aik/db';
import { readOutboxAfter } from '../../src/events/outbox.ts';

export function readOutbox(db: AikDb): EventEnvelope[] {
  return readOutboxAfter(db, 0);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @aik/orchestrator -- test/run-events.test.ts`
Expected: FAIL — `Cannot find module '../src/agents/run-events.ts'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/orchestrator/src/agents/run-events.ts
// Emits the run.started/run.finished outbox topics (spec 2026-11-04 Pixel Agents office).
// The payload carries story/project context so consumers (the office bridge) need no extra joins.
import type { Role } from '@aik/contracts';
import { agentRuns, projects, userStories, type AikDbOrTx } from '@aik/db';
import { eq } from 'drizzle-orm';
import { appendOutbox } from '../events/outbox.ts';

export interface RunEventInfo {
  runId: number;
  storyId: number;
  storyKey: string;
  projectKey: string;
  role: Role;
}

export function runEventInfo(db: AikDbOrTx, runId: number): RunEventInfo | null {
  const row = db
    .select({
      runId: agentRuns.id,
      role: agentRuns.role,
      storyId: userStories.id,
      storyKey: userStories.key,
      projectKey: projects.key,
    })
    .from(agentRuns)
    .innerJoin(userStories, eq(userStories.id, agentRuns.storyId))
    .innerJoin(projects, eq(projects.id, userStories.projectId))
    .where(eq(agentRuns.id, runId))
    .get();
  return row ? { runId: row.runId, storyId: row.storyId, storyKey: row.storyKey, projectKey: row.projectKey, role: row.role } : null;
}

export function emitRunStarted(db: AikDbOrTx, now: Date, runId: number): void {
  const info = runEventInfo(db, runId);
  if (!info) return;
  appendOutbox(db, {
    topic: 'run.started',
    storyId: info.storyId,
    provenance: 'system',
    data: { runId: info.runId, role: info.role, storyKey: info.storyKey, projectKey: info.projectKey },
  }, now);
}

export function emitRunFinished(db: AikDbOrTx, now: Date, runId: number, status: string, exitReason?: string | null): void {
  const info = runEventInfo(db, runId);
  if (!info) return;
  appendOutbox(db, {
    topic: 'run.finished',
    storyId: info.storyId,
    provenance: 'system',
    data: {
      runId: info.runId,
      role: info.role,
      storyKey: info.storyKey,
      projectKey: info.projectKey,
      status,
      ...(exitReason ? { exitReason } : {}),
    },
  }, now);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @aik/orchestrator -- test/run-events.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/src/agents/run-events.ts apps/orchestrator/test/run-events.test.ts apps/orchestrator/test/helpers/outbox.ts
git commit -m "feat(orchestrator): run.started/run.finished outbox emission helper"
```

---

### Task 2: Planner emits run events

**Files:**
- Modify: `apps/orchestrator/src/agents/planner.ts`
- Test: `apps/orchestrator/test/planner.test.ts` (append a test)

**Interfaces:**
- Consumes: `emitRunStarted`/`emitRunFinished` from Task 1.
- Produces: outbox rows (no new code interfaces).

- [ ] **Step 1: Write the failing test** — append inside `describe('PlannerAgent', ...)` in `apps/orchestrator/test/planner.test.ts` (reuse the file's existing `mockPlanText` helper and imports; add `emitRun`-row reads via `readOutbox`):

```ts
  test('emits run.started and run.finished outbox events', async () => {
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/office-proj' });
    const story = seedStory(dbHolder.db, project.id, { title: 'Office Plan', status: 'NEW' });

    const runOneShot = vi.fn().mockResolvedValue({ ok: true, text: mockPlanText([]) });
    const mockRuntime: OpenCodeRuntime = { runOneShot } as unknown as OpenCodeRuntime;
    const planner = new PlannerAgent({ db: dbHolder.db, workflow, bus, runtime: mockRuntime });

    const result = await planner.planStory({ storyId: story.id });
    expect(result.ok).toBe(true);

    const rows = readOutbox(dbHolder.db).filter((r) => r.topic.startsWith('run.'));
    expect(rows.map((r) => r.topic)).toEqual(['run.started', 'run.finished']);
    expect(rows[0].data).toMatchObject({ role: 'planner', storyKey: story.key });
    expect(rows[1].data).toMatchObject({ role: 'planner', status: 'succeeded' });
  });

  test('emits run.finished with status failed when planning fails', async () => {
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/office-proj-2' });
    const story = seedStory(dbHolder.db, project.id, { title: 'Office Fail', status: 'NEW' });

    const runOneShot = vi.fn().mockResolvedValue({ ok: false, error: 'model exploded' });
    const mockRuntime: OpenCodeRuntime = { runOneShot } as unknown as OpenCodeRuntime;
    const planner = new PlannerAgent({ db: dbHolder.db, workflow, bus, runtime: mockRuntime });

    await planner.planStory({ storyId: story.id });

    const rows = readOutbox(dbHolder.db).filter((r) => r.topic.startsWith('run.'));
    expect(rows.map((r) => r.topic)).toEqual(['run.started', 'run.finished']);
    expect(rows[1].data).toMatchObject({ status: 'failed', exitReason: 'model exploded' });
  });
```

Add the import at the top of the test file:

```ts
import { readOutbox } from './helpers/outbox.ts';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @aik/orchestrator -- test/planner.test.ts`
Expected: FAIL — the filtered `rows` arrays are empty (`expected [] to equal ['run.started', 'run.finished']`).

- [ ] **Step 3: Implement — four one-line edits in `apps/orchestrator/src/agents/planner.ts`**

Add the import with the other relative imports:

```ts
import { emitRunFinished, emitRunStarted } from './run-events.ts';
```

3a. Right after the `agentRuns` insert (after the `.returning().get();` that defines `run`, before the `user_stories` update around line 88):

```ts
    emitRunStarted(this.db, new Date(this.now()), run.id);
```

3b. In the `result.interrupted` branch, right after the `agentRuns` update (after `.run();` around line 221):

```ts
      emitRunFinished(this.db, new Date(this.now()), run.id, 'interrupted', 'Interrupted by a stop request');
```

3c. In the `!result.ok || !result.text` branch, right after the `agentRuns` update (around line 231):

```ts
      emitRunFinished(this.db, new Date(this.now()), run.id, 'failed', result.error ?? 'No response');
```

3d. In the success path, right after the `status: 'succeeded'` update (around line 278):

```ts
    emitRunFinished(this.db, new Date(this.now()), run.id, 'succeeded');
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @aik/orchestrator -- test/planner.test.ts`
Expected: PASS (existing tests + 2 new).

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/src/agents/planner.ts apps/orchestrator/test/planner.test.ts
git commit -m "feat(orchestrator): planner emits run lifecycle outbox events"
```

---

### Task 3: Implementer emits run events

**Files:**
- Modify: `apps/orchestrator/src/agents/implementer.ts`
- Test: `apps/orchestrator/test/implementer.test.ts` (append tests)

**Interfaces:**
- Consumes: `emitRunStarted`/`emitRunFinished` from Task 1.
- Produces: outbox rows (no new code interfaces).

- [ ] **Step 1: Write the failing test** — append to the implementer test suite. First read `apps/orchestrator/test/implementer.test.ts` to find its existing mock-runtime/worktree setup helpers and reuse them for seeding one success and one failed attempt. The assertions to add (adapting variable names to the file's existing helpers):

```ts
  test('emits run.started and run.finished outbox events', async () => {
    // …existing arrange for a successful implementStory call…
    await implementer.implementStory({ storyId: story.id });

    const rows = readOutbox(dbHolder.db).filter((r) => r.topic.startsWith('run.'));
    expect(rows.map((r) => r.topic)).toEqual(['run.started', 'run.finished']);
    expect(rows[0].data).toMatchObject({ role: 'implementer', storyKey: story.key });
    expect(rows[1].data).toMatchObject({ role: 'implementer', status: 'succeeded' });
  });

  test('emits run.finished failed when the model run fails', async () => {
    // …existing arrange with runOneShot resolving { ok: false, error: 'no changes' }…
    await implementer.implementStory({ storyId: story.id });

    const rows = readOutbox(dbHolder.db).filter((r) => r.topic.startsWith('run.'));
    expect(rows[1].data).toMatchObject({ role: 'implementer', status: 'failed' });
  });
```

with `import { readOutbox } from './helpers/outbox.ts';` added. If the existing suite constructs the agent via a helper function, call it twice with fresh stories (its seeding helpers already use temp dirs).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @aik/orchestrator -- test/implementer.test.ts`
Expected: FAIL — filtered rows empty.

- [ ] **Step 3: Implement — four edits in `apps/orchestrator/src/agents/implementer.ts`**

Import:

```ts
import { emitRunFinished, emitRunStarted } from './run-events.ts';
```

3a. After the `agentRuns` insert (after the `.returning().get();` defining `run`, ~line 113, before the `claim` transition):

```ts
    emitRunStarted(this.db, new Date(this.now()), run.id);
```

3b. In the `result.interrupted` branch after the update (~line 195):

```ts
      emitRunFinished(this.db, new Date(this.now()), run.id, 'interrupted', 'Interrupted by a stop request');
```

3c. In the success path after the `status: 'succeeded', resultSha: candidateSha` update (~line 231):

```ts
    emitRunFinished(this.db, new Date(this.now()), run.id, 'succeeded');
```

3d. Inside the private `failRun(runId: number, reason: string)` helper, after the update + before/after `this.bus.notify(1);` (~line 401) — this covers `failAttempt`, claim failure, and all direct callers:

```ts
    emitRunFinished(this.db, new Date(this.now()), runId, 'failed', reason);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @aik/orchestrator -- test/implementer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/src/agents/implementer.ts apps/orchestrator/test/implementer.test.ts
git commit -m "feat(orchestrator): implementer emits run lifecycle outbox events"
```

---

### Task 4: Reviewer emits run events

**Files:**
- Modify: `apps/orchestrator/src/agents/reviewer.ts`
- Test: `apps/orchestrator/test/reviewer.test.ts` (append tests)

**Interfaces:**
- Consumes: `emitRunStarted`/`emitRunFinished` from Task 1.
- Produces: outbox rows (no new code interfaces).

- [ ] **Step 1: Write the failing test** — append to the reviewer test suite, reusing its existing arrange helpers for a READY_FOR_REVIEW story with a candidate:

```ts
  test('emits run.started and run.finished outbox events per review attempt', async () => {
    // …existing arrange for one successful review…
    await reviewer.reviewStory({ storyId: story.id });

    const rows = readOutbox(dbHolder.db).filter((r) => r.topic.startsWith('run.'));
    expect(rows.map((r) => r.topic)).toEqual(['run.started', 'run.finished']);
    expect(rows[0].data).toMatchObject({ role: 'reviewer', storyKey: story.key });
    expect(rows[1].data).toMatchObject({ role: 'reviewer', status: 'succeeded' });
  });

  test('emits run.finished failed when the reviewer output is invalid', async () => {
    // …existing arrange where runOneShot resolves { ok: true, text: 'not json' } twice (both attempts fail)…
    await reviewer.reviewStory({ storyId: story.id });

    const rows = readOutbox(dbHolder.db).filter((r) => r.topic.startsWith('run.'));
    expect(rows.map((r) => r.topic)).toEqual(['run.started', 'run.finished', 'run.started', 'run.finished']);
    expect(rows[1].data).toMatchObject({ status: 'failed' });
    expect(rows[3].data).toMatchObject({ status: 'failed' });
  });
```

with `import { readOutbox } from './helpers/outbox.ts';` added.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @aik/orchestrator -- test/reviewer.test.ts`
Expected: FAIL — filtered rows empty.

- [ ] **Step 3: Implement — four edits in `apps/orchestrator/src/agents/reviewer.ts`**

Import:

```ts
import { emitRunFinished, emitRunStarted } from './run-events.ts';
```

3a. After the per-attempt `agentRuns` insert (after `.returning().get();` ~line 210, before `this.setActiveRun(story.id, run.id);`):

```ts
      emitRunStarted(this.db, new Date(this.now()), run.id);
```

3b. In the `result.interrupted` branch after the update (~line 284):

```ts
          emitRunFinished(this.db, new Date(this.now()), run.id, 'interrupted', 'Interrupted by a stop request');
```

3c. Inside the `finishReview` transaction, right after the `tx.update(agentRuns).set({ status: 'succeeded', … })` inside the `this.db.transaction((tx) => { … })` callback (~line 425) — pass `tx` so the event commits atomically with the status:

```ts
      emitRunFinished(tx, new Date(this.now()), runId, 'succeeded');
```

3d. Inside the private `failRun(runId: number, reason: string)` helper (~line 530), same as implementer:

```ts
    emitRunFinished(this.db, new Date(this.now()), runId, 'failed', reason);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @aik/orchestrator -- test/reviewer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/src/agents/reviewer.ts apps/orchestrator/test/reviewer.test.ts
git commit -m "feat(orchestrator): reviewer emits run lifecycle outbox events"
```

---

### Task 5: PixelAgentsBridge (translate → POST → pixel-agents)

**Files:**
- Create: `apps/orchestrator/src/office/bridge.ts`
- Test: `apps/orchestrator/test/office-bridge.test.ts`

**Interfaces:**
- Consumes: `EventBus.subscribe(fn: (seq: number) => void): () => void`; `readOutboxAfter(db, afterSeq, limit?)`; `outboxBounds(db)`; `OfficeConfig`/`OfficeBounds` (defined in this task in contracts — see step 3a).
- Produces:
  - `hookEventsForRunStarted(data: unknown): HookEvent[]` / `hookEventsForRunFinished(data: unknown): HookEvent[]` (pure, exported)
  - `class PixelAgentsBridge { start(): void; stop(): void; poll(): Promise<void> }` with deps `PixelAgentsBridgeDeps`

- [ ] **Step 1: Write the failing test**

```ts
// apps/orchestrator/test/office-bridge.test.ts
import { appendOutbox } from '../src/events/outbox.ts';
import { EventBus } from '../src/events/bus.ts';
import {
  hookEventsForRunFinished,
  hookEventsForRunStarted,
  PixelAgentsBridge,
  type HookEvent,
} from '../src/office/bridge.ts';
import { createTestDb, seedProject, seedStory } from './helpers/db.ts';
import { outboxBounds } from '../src/events/outbox.ts';

const RUN_STARTED = { runId: 7, role: 'implementer', storyKey: 'INV-4', projectKey: 'INV' };
const RUN_FINISHED = { ...RUN_STARTED, status: 'succeeded' };

/** Records POSTs; can be scripted to fail N times with a 500 before succeeding. */
function makeFetch(script: Array<{ status: number } | { error: string }>) {
  const posts: Array<{ url: string; auth?: string; body: HookEvent }> = [];
  const healthCalls: string[] = [];
  let call = 0;
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const u = url.toString();
    if (u.endsWith('/api/health')) {
      healthCalls.push(u);
      const step = script[call];
      call += 1;
      if (step && 'error' in step) throw new Error(step.error);
      return new Response('ok', { status: step?.status ?? 200 });
    }
    posts.push({ url: u, auth: (init?.headers as Record<string, string>)?.authorization, body: JSON.parse(String(init?.body)) as HookEvent });
    const step = script[call];
    call += 1;
    if (step && 'error' in step) throw new Error(step.error);
    return new Response('ok', { status: step?.status ?? 200 });
  }) as unknown as typeof fetch;
  return { impl, posts, healthCalls };
}

/** Minimal WebSocket double: auto-opens on the next tick, records sent frames. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
    setTimeout(() => this.onopen?.(), 0);
  }
  send(frame: string): void {
    this.sent.push(frame);
  }
  close(): void {}
}

function makeBridge(overrides: Partial<ConstructorParameters<typeof PixelAgentsBridge>[0]> = {}) {
  const t = createTestDb();
  const bus = new EventBus();
  const warns: Array<Record<string, unknown> | string> = [];
  const bridge = new PixelAgentsBridge({
    db: t.db,
    bus,
    logger: {
      info: () => undefined,
      warn: (obj, msg) => warns.push({ ...obj, msg }),
    },
    redact: (text) => text.replaceAll('sekret-token', '[REDACTED:secret]'),
    office: { url: 'http://127.0.0.1:45999', token: 'sekret-token' },
    healthIntervalMs: 60_000,
    retryDelaysMs: [0, 0],
    ...overrides,
  });
  return { t, bus, warns, bridge };
}

describe('hook event translation (pure)', () => {
  test('started spawns a character: SessionStart(cwd label) + confirming PreToolUse', () => {
    expect(hookEventsForRunStarted(RUN_STARTED)).toEqual([
      { session_id: 'aik-run-7', hook_event_name: 'SessionStart', source: 'startup', cwd: 'AIK/INV/INV-4 implementer' },
      { session_id: 'aik-run-7', hook_event_name: 'PreToolUse', tool_name: 'aik-implementer', tool_input: { story: 'INV-4' } },
    ]);
  });

  test('finished despawns: PostToolUse + Stop + SessionEnd', () => {
    expect(hookEventsForRunFinished(RUN_FINISHED)).toEqual([
      { session_id: 'aik-run-7', hook_event_name: 'PostToolUse', tool_name: 'aik-implementer', tool_input: { story: 'INV-4' } },
      { session_id: 'aik-run-7', hook_event_name: 'Stop' },
      { session_id: 'aik-run-7', hook_event_name: 'SessionEnd', reason: 'exit' },
    ]);
  });

  test('garbage payloads translate to nothing', () => {
    expect(hookEventsForRunStarted(null)).toEqual([]);
    expect(hookEventsForRunStarted({ runId: 'x' })).toEqual([]);
    expect(hookEventsForRunFinished('nope')).toEqual([]);
  });
});

describe('PixelAgentsBridge', () => {
  test('healthy path: pushes watchAllSessions once, posts events with Bearer auth', async () => {
    const t = createTestDb();
    const bus = new EventBus();
    FakeWebSocket.instances = [];
    const { impl, posts, healthCalls } = makeFetch([]);
    const bridge = new PixelAgentsBridge({
      db: t.db, bus, logger: { info: () => undefined, warn: () => undefined }, redact: (s) => s,
      office: { url: 'http://127.0.0.1:45999', token: 'sekret-token' },
      fetchImpl: impl, webSocketImpl: FakeWebSocket as unknown as new (url: string) => WebSocket,
      healthIntervalMs: 60_000, retryDelaysMs: [0, 0],
    });
    bridge.start();
    await bridge.poll(); // immediate health + settings push + drain

    expect(healthCalls[0]).toBe('http://127.0.0.1:45999/api/health');
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]?.url).toBe('ws://127.0.0.1:45999/ws?token=sekret-token');
    expect(FakeWebSocket.instances[0]?.sent).toContain('{"type":"webviewReady"}');
    expect(FakeWebSocket.instances[0]?.sent).toContain('{"type":"setWatchAllSessions","enabled":true}');

    appendOutbox(t.db, { topic: 'run.started', storyId: 1, provenance: 'system', data: RUN_STARTED }, new Date());
    bus.notify(1);
    await new Promise((r) => setTimeout(r, 0));

    expect(posts.map((p) => p.url)).toEqual(['http://127.0.0.1:45999/api/hooks/aik', 'http://127.0.0.1:45999/api/hooks/aik']);
    expect(posts[0]?.auth).toBe('Bearer sekret-token');
    expect(posts[0]?.body.hook_event_name).toBe('SessionStart');
    expect(posts[1]?.body.hook_event_name).toBe('PreToolUse');
    bridge.stop();
    t.close();
  });

  test('unhealthy path: queues, then flushes in order once health recovers', async () => {
    const t = createTestDb();
    const bus = new EventBus();
    FakeWebSocket.instances = [];
    const posts: string[] = [];
    let down = true;
    const impl = (async (url: string | URL, init?: RequestInit) => {
      const u = url.toString();
      if (u.endsWith('/api/health')) {
        if (down) throw new Error('down');
        return new Response('ok', { status: 200 });
      }
      if (down) throw new Error('down');
      posts.push((JSON.parse(String(init?.body)) as HookEvent).hook_event_name);
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;
    const bridge = new PixelAgentsBridge({
      db: t.db, bus, logger: { info: () => undefined, warn: () => undefined }, redact: (s) => s,
      office: { url: 'http://127.0.0.1:45999', token: 'sekret-token' },
      fetchImpl: impl, webSocketImpl: FakeWebSocket as unknown as new (url: string) => WebSocket,
      healthIntervalMs: 60_000, retryDelaysMs: [0, 0],
    });
    bridge.start();
    await bridge.poll(); // health fails → not healthy

    appendOutbox(t.db, { topic: 'run.started', storyId: 1, provenance: 'system', data: RUN_STARTED }, new Date());
    appendOutbox(t.db, { topic: 'run.finished', storyId: 1, provenance: 'system', data: RUN_FINISHED }, new Date());
    bus.notify(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(posts).toEqual([]); // queued, not posted

    down = false;
    await bridge.poll(); // health recovers → flush the queue in FIFO order
    expect(posts).toEqual(['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd']);
    bridge.stop();
    t.close();
  });

  test('queue is bounded and drops oldest', async () => {
    const { t, bridge } = makeBridge({ queueCap: 2 });
    expect((bridge as unknown as { queue: unknown[] }).queue).toHaveLength(0);
    bridge.start();
    const health = makeFetch([{ error: 'down' }, { error: 'down' }]);
    const b2 = new PixelAgentsBridge({
      db: t.db, bus: new EventBus(), logger: { info: () => undefined, warn: () => undefined }, redact: (s) => s,
      office: { url: 'http://127.0.0.1:45999', token: 'sekret-token' },
      fetchImpl: health.impl, healthIntervalMs: 60_000, queueCap: 2, retryDelaysMs: [0, 0],
    });
    b2.start();
    await b2.poll(); // unhealthy
    const internals = b2 as unknown as { enqueue: (e: HookEvent) => void; queue: HookEvent[] };
    for (const name of ['a', 'b', 'c', 'd']) internals.enqueue({ session_id: name, hook_event_name: 'Stop' });
    expect(internals.queue.map((e) => e.session_id)).toEqual(['c', 'd']);
    bridge.stop();
    b2.stop();
    t.close();
  });

  test('retries a 500 twice then succeeds; a 4xx is dropped without retry', async () => {
    const { impl, posts } = makeFetch([{ status: 500 }, { status: 500 }]);
    const t = createTestDb();
    const bridge = new PixelAgentsBridge({
      db: t.db, bus: new EventBus(), logger: { info: () => undefined, warn: () => undefined }, redact: (s) => s,
      office: { url: 'http://127.0.0.1:45999', token: 'sekret-token' },
      fetchImpl: impl, healthIntervalMs: 60_000, retryDelaysMs: [0, 0],
    });
    const post = (bridge as unknown as { post: (e: HookEvent) => Promise<void> }).post.bind(bridge);
    await post({ session_id: 's1', hook_event_name: 'Stop' }); // 500, 500, then 200
    expect(posts).toHaveLength(3);
    const drop = makeFetch([{ status: 400 }]);
    const b2 = new PixelAgentsBridge({
      db: t.db, bus: new EventBus(), logger: { info: () => undefined, warn: () => undefined }, redact: (s) => s,
      office: { url: 'http://127.0.0.1:45999', token: 'sekret-token' },
      fetchImpl: drop.impl, healthIntervalMs: 60_000, retryDelaysMs: [0, 0],
    });
    await (b2 as unknown as { post: (e: HookEvent) => Promise<void> }).post({ session_id: 's2', hook_event_name: 'Stop' });
    expect(drop.posts).toHaveLength(1); // no retry on 4xx
    bridge.stop();
    b2.stop();
    t.close();
  });

  test('token is redacted in warn logs', async () => {
    const { t, bridge, warns } = makeBridge();
    const { impl } = makeFetch([{ error: 'conn refused sekret-token' }, { error: 'conn refused sekret-token' }, { error: 'conn refused sekret-token' }]);
    const b2 = new PixelAgentsBridge({
      db: t.db, bus: new EventBus(),
      logger: { info: () => undefined, warn: (obj, msg) => warns.push({ ...obj, msg }) },
      redact: (text) => text.replaceAll('sekret-token', '[REDACTED:secret]'),
      office: { url: 'http://127.0.0.1:45999', token: 'sekret-token' },
      fetchImpl: impl, healthIntervalMs: 60_000, retryDelaysMs: [0, 0],
    });
    await (b2 as unknown as { post: (e: HookEvent) => Promise<void> }).post({ session_id: 's', hook_event_name: 'Stop' });
    const flat = JSON.stringify(warns);
    expect(flat).not.toContain('sekret-token');
    expect(flat).toContain('[REDACTED:secret]');
    bridge.stop();
    b2.stop();
    t.close();
  });

  test('cursor starts at outbox max: a restarted bridge never replays old runs', async () => {
    const { t, bridge } = makeBridge();
    appendOutbox(t.db, { topic: 'run.started', storyId: 1, provenance: 'system', data: RUN_STARTED }, new Date());
    const before = outboxBounds(t.db).max;
    const { impl, posts } = makeFetch([]);
    const b2 = new PixelAgentsBridge({
      db: t.db, bus: new EventBus(), logger: { info: () => undefined, warn: () => undefined }, redact: (s) => s,
      office: { url: 'http://127.0.0.1:45999', token: 'sekret-token' },
      fetchImpl: impl, healthIntervalMs: 60_000, retryDelaysMs: [0, 0],
    });
    b2.start();
    await b2.poll();
    expect(posts.filter((p) => p.url.includes('/api/hooks/'))).toHaveLength(0); // old row skipped
    expect(before).toBeGreaterThan(0);
    bridge.stop();
    b2.stop();
    t.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @aik/orchestrator -- test/office-bridge.test.ts`
Expected: FAIL — `Cannot find module '../src/office/bridge.ts'` (and contracts missing `OfficeConfig`).

- [ ] **Step 3: Write the implementation**

3a. Contracts first — create `packages/contracts/src/pixel-agents.ts`:

```ts
// packages/contracts/src/pixel-agents.ts — the bundled Pixel Agents office runtime (spec 2026-11-04).
/** Exact version of the `pixel-agents` npm package the app bundles as a runtime asset. */
export const PIXEL_AGENTS_PIN = '1.5.0';

/** How to reach a running Pixel Agents office server. `token` is a secret: redact, never log. */
export interface OfficeConfig {
  url: string;
  token: string;
}

/** Pixel-coordinate rectangle of the office viewport inside the window (CSS px == DIP at zoom 1). */
export interface OfficeBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
```

and add to `packages/contracts/src/index.ts` (keep alphabetical order, between `opencode` and `projects`):

```ts
export * from './pixel-agents.ts';
```

3b. The bridge — create `apps/orchestrator/src/office/bridge.ts`:

```ts
// apps/orchestrator/src/office/bridge.ts — forwards run lifecycle events to a Pixel Agents
// office server (spec 2026-11-04). Pixel Agents exposes a provider-agnostic hook ingest
// (POST /api/hooks/:id, Bearer auth, Claude-shaped payloads); hooks-only sessions appear
// as characters only when their "Watch All Sessions" setting is on, so the bridge pushes
// that setting once over its WebSocket after the first successful health check.
import type { OfficeConfig } from '@aik/contracts';
import type { AikDb } from '@aik/db';
import type { EventBus } from '../events/bus.ts';
import { outboxBounds, readOutboxAfter } from '../events/outbox.ts';

export interface HookEvent {
  session_id: string;
  hook_event_name: string;
  [key: string]: unknown;
}

interface BridgeLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface PixelAgentsBridgeDeps {
  db: AikDb;
  bus: EventBus;
  logger: BridgeLogger;
  redact: (text: string) => string;
  office: OfficeConfig;
  fetchImpl?: typeof fetch;
  webSocketImpl?: new (url: string) => WebSocket;
  healthIntervalMs?: number;
  retryDelaysMs?: readonly number[];
  queueCap?: number;
  requestTimeoutMs?: number;
}

interface RunEventData {
  runId: number;
  role: string;
  storyKey: string;
  projectKey: string;
  status?: string;
  exitReason?: string;
}

function toRunEventData(data: unknown): RunEventData | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.runId !== 'number' || typeof d.role !== 'string' || typeof d.storyKey !== 'string' || typeof d.projectKey !== 'string') {
    return null;
  }
  return {
    runId: d.runId,
    role: d.role,
    storyKey: d.storyKey,
    projectKey: d.projectKey,
    status: typeof d.status === 'string' ? d.status : undefined,
    exitReason: typeof d.exitReason === 'string' ? d.exitReason : undefined,
  };
}

const sessionIdOf = (runId: number): string => `aik-run-${runId}`;

/** Character spawn: SessionStart stages the session, PreToolUse confirms + shows the busy bubble. */
export function hookEventsForRunStarted(data: unknown): HookEvent[] {
  const d = toRunEventData(data);
  if (!d) return [];
  return [
    {
      session_id: sessionIdOf(d.runId),
      hook_event_name: 'SessionStart',
      source: 'startup',
      // The display label is basename(cwd); the path never needs to exist (hooks-only agent).
      cwd: `AIK/${d.projectKey}/${d.storyKey} ${d.role}`,
    },
    { session_id: sessionIdOf(d.runId), hook_event_name: 'PreToolUse', tool_name: `aik-${d.role}`, tool_input: { story: d.storyKey } },
  ];
}

/** Character despawn: clear the tool bubble, flash Done, remove the character. */
export function hookEventsForRunFinished(data: unknown): HookEvent[] {
  const d = toRunEventData(data);
  if (!d) return [];
  return [
    { session_id: sessionIdOf(d.runId), hook_event_name: 'PostToolUse', tool_name: `aik-${d.role}`, tool_input: { story: d.storyKey } },
    { session_id: sessionIdOf(d.runId), hook_event_name: 'Stop' },
    { session_id: sessionIdOf(d.runId), hook_event_name: 'SessionEnd', reason: 'exit' },
  ];
}

export class PixelAgentsBridge {
  private readonly db: AikDb;
  private readonly bus: EventBus;
  private readonly logger: BridgeLogger;
  private readonly redact: (text: string) => string;
  private readonly office: OfficeConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly webSocketImpl: new (url: string) => WebSocket;
  private readonly healthIntervalMs: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly queueCap: number;
  private readonly requestTimeoutMs: number;

  private cursor = 0;
  private healthy = false;
  private settingsPushed = false;
  private draining = false;
  private queue: HookEvent[] = [];
  private unsubscribe: (() => void) | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: PixelAgentsBridgeDeps) {
    this.db = deps.db;
    this.bus = deps.bus;
    this.logger = deps.logger;
    this.redact = deps.redact;
    this.office = deps.office;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.webSocketImpl = deps.webSocketImpl ?? WebSocket;
    this.healthIntervalMs = deps.healthIntervalMs ?? 5_000;
    this.retryDelaysMs = deps.retryDelaysMs ?? [500, 1500];
    this.queueCap = deps.queueCap ?? 100;
    this.requestTimeoutMs = deps.requestTimeoutMs ?? 5_000;
  }

  start(): void {
    // A restarted orchestrator never replays old runs (spec: characters appear on next event).
    this.cursor = outboxBounds(this.db).max ?? 0;
    this.unsubscribe = this.bus.subscribe(() => void this.drain());
    this.healthTimer = setInterval(() => void this.poll(), this.healthIntervalMs);
    void this.poll();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
  }

  /** One health check + settings push + drain cycle. Also driven by the interval. */
  async poll(): Promise<void> {
    await this.checkHealth();
    await this.drain();
  }

  private async checkHealth(): Promise<void> {
    try {
      const res = await this.fetchImpl(`${this.office.url}/api/health`, { signal: AbortSignal.timeout(2_000) });
      if (!res.ok) throw new Error(`health ${res.status}`);
      this.healthy = true;
      // The settings push is best-effort: a failure must not block flushing queued events —
      // it just means characters are not adopted until a later poll succeeds.
      if (!this.settingsPushed) {
        try {
          await this.pushWatchAllSessions();
        } catch (err) {
          this.logger.warn({ err: this.redact(err instanceof Error ? err.message : String(err)) }, 'pixel-agents settings push failed; will retry');
        }
      }
      await this.flush();
    } catch (err) {
      this.healthy = false;
      this.logger.warn({ err: this.redact(err instanceof Error ? err.message : String(err)) }, 'pixel-agents office unreachable; events are queued');
    }
  }

  /** Hooks-only sessions are dropped unless Watch All Sessions is on (verified in their source). */
  private async pushWatchAllSessions(): Promise<void> {
    const wsUrl = `${this.office.url.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(this.office.token)}`;
    const ws = new this.webSocketImpl(wsUrl);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ws open timeout')), 3_000);
        ws.onopen = () => {
          clearTimeout(timer);
          resolve();
        };
        ws.onerror = () => {
          clearTimeout(timer);
          reject(new Error('ws error'));
        };
      });
      ws.send('{"type":"webviewReady"}');
      ws.send('{"type":"setWatchAllSessions","enabled":true}');
      this.settingsPushed = true;
    } finally {
      ws.close();
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (const env of readOutboxAfter(this.db, this.cursor)) {
        this.cursor = env.seq;
        if (env.topic === 'run.started' || env.topic === 'run.finished') {
          const events = env.topic === 'run.started' ? hookEventsForRunStarted(env.data) : hookEventsForRunFinished(env.data);
          for (const event of events) await this.deliver(event);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async deliver(event: HookEvent): Promise<void> {
    if (!this.healthy) {
      this.enqueue(event);
      return;
    }
    try {
      await this.post(event);
    } catch {
      this.healthy = false;
      this.enqueue(event);
    }
  }

  enqueue(event: HookEvent): void {
    this.queue.push(event);
    while (this.queue.length > this.queueCap) {
      const dropped = this.queue.shift();
      this.logger.warn({ session: dropped?.session_id }, 'office queue full; dropped oldest event');
    }
  }

  private async flush(): Promise<void> {
    while (this.healthy && this.queue.length > 0) {
      const event = this.queue[0];
      try {
        await this.post(event);
        this.queue.shift();
      } catch {
        this.healthy = false;
        break;
      }
    }
  }

  /** POST one hook event; transport errors and 5xx are retried, 4xx is a permanent drop. */
  async post(event: HookEvent): Promise<void> {
    const url = `${this.office.url}/api/hooks/aik`;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const res = await this.fetchImpl(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${this.office.token}`, 'content-type': 'application/json' },
          body: JSON.stringify(event),
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
        if (res.status >= 500) throw new Error(`hook post ${res.status}`);
        if (!res.ok) {
          // 4xx: our payload is wrong — retrying cannot help; drop with a redacted warn.
          this.logger.warn({ status: res.status, session: event.session_id }, 'pixel-agents rejected a hook event');
          return;
        }
        return;
      } catch (err) {
        if (attempt >= this.retryDelaysMs.length) {
          throw err instanceof Error ? err : new Error(String(err));
        }
        await new Promise((r) => setTimeout(r, this.retryDelaysMs[attempt] ?? 0));
      }
    }
  }
}
```

Type note: the global `WebSocket` type in Node's lib may not match the constructor injection — if `typecheck` complains, type `webSocketImpl` as `new (url: string) => { send(data: string): void; close(): void; onopen: (() => void) | null; onerror: (() => void) | null }` and use that structural interface instead of `WebSocket`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @aik/orchestrator -- test/office-bridge.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/pixel-agents.ts packages/contracts/src/index.ts apps/orchestrator/src/office/bridge.ts apps/orchestrator/test/office-bridge.test.ts
git commit -m "feat(orchestrator): pixel agents bridge translates run events to hook posts"
```

---

### Task 6: Wire the bridge into the orchestrator

**Files:**
- Modify: `apps/orchestrator/src/app.ts`

**Interfaces:**
- Consumes: `PixelAgentsBridge` + `OfficeConfig` from Task 5.
- Produces: `OrchestratorOptions.agentOffice?: OfficeConfig`. The desktop→orchestrator init message type is `{ type: 'init' } & OrchestratorOptions` (`apps/orchestrator/src/main.ts:6`), so the new field flows automatically once the desktop sends it (Task 10).

- [ ] **Step 1: Add the option** — in `app.ts`, extend `OrchestratorOptions` after `gatewayToken`:

```ts
  /**
   * Pixel Agents office server (spec 2026-11-04). Presence constructs the run→hook-event
   * bridge; absence means the feature is off and no office wiring exists at all.
   */
  agentOffice?: OfficeConfig;
```

with the import at the top:

```ts
import { PixelAgentsBridge } from './office/bridge.ts';
```

(`OfficeConfig` is already re-exported by `@aik/contracts`, which `app.ts` imports types from via other modules — add `type OfficeConfig` to an existing `@aik/contracts` import or a new one.)

- [ ] **Step 2: Register the token with the redactor** — in `startOrchestrator`, right after the `gatewayToken` secret registration (after line 87):

```ts
  // The office token is a bearer capability for the local Pixel Agents server: register it so
  // no log line or persisted error can leak it (spec 2026-11-04 security review).
  if (opts.agentOffice) redactor.addSecret(opts.agentOffice.token);
```

- [ ] **Step 3: Construct + start the bridge** — after the `skills`/agent construction block (~line 226, after `const reviewer = …`):

```ts
  // Pixel Agents office bridge (spec 2026-11-04): only exists when the desktop passed the
  // office server config — feature off means no subscriber, no sockets, no processes.
  const officeBridge = opts.agentOffice
    ? new PixelAgentsBridge({ db, bus, logger, redact: redactor.redact, office: opts.agentOffice })
    : null;
  officeBridge?.start();
```

- [ ] **Step 4: Stop it on close** — in the returned `close` closure, add as the first stop (before `runner.stop()`):

```ts
      officeBridge?.stop();
```

- [ ] **Step 5: Verify nothing regressed**

Run: `npm test -w @aik/orchestrator`
Expected: PASS (full orchestrator suite — the bridge is absent in every existing test because no `agentOffice` option is passed).

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/orchestrator/src/app.ts
git commit -m "feat(orchestrator): construct pixel agents bridge when agentOffice config is passed"
```

---

### Task 7: Bundle the pixel-agents runtime asset

**Files:**
- Create: `apps/desktop/assets/pixel-agents-runtime/package.json`
- Create: `apps/desktop/assets/pixel-agents-runtime/package-lock.json` (generated)
- Modify: `apps/desktop/scripts/build.mjs` (one copy line)
- Modify: `apps/desktop/package.json` (`build.extraResources`)
- Test: `apps/desktop/test/pixel-agents-packaging.test.ts`

**Interfaces:**
- Consumes: `PIXEL_AGENTS_PIN` from `packages/contracts/src/pixel-agents.ts` (Task 5).
- Produces: an installable runtime dir `<dataDir>/runtime/pixel-agents` (consumed by Task 8's `officeCliPath`); assets land at `dist/pixel-agents-runtime` (dev) and `resources/pixel-agents-runtime` (packaged).

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/test/pixel-agents-packaging.test.ts
import { PIXEL_AGENTS_PIN } from '@aik/contracts';
import fs from 'node:fs';
import { describe, expect, test } from 'vitest';

const desktopPkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  build: { extraResources: Array<{ from: string; to: string }> };
};
const assetPkg = JSON.parse(
  fs.readFileSync(new URL('../assets/pixel-agents-runtime/package.json', import.meta.url), 'utf8'),
) as { dependencies: Record<string, string> };

describe('pixel-agents runtime packaging', () => {
  test('ships the runtime as extraResources next to opencode-runtime', () => {
    const entry = desktopPkg.build.extraResources.find((e) => e.to === 'pixel-agents-runtime');
    expect(entry).toEqual({ from: 'assets/pixel-agents-runtime', to: 'pixel-agents-runtime', filter: ['**/*'] });
  });

  test('pins the exact pixel-agents version mirrored in contracts', () => {
    expect(assetPkg.dependencies['pixel-agents']).toBe(PIXEL_AGENTS_PIN);
    expect(PIXEL_AGENTS_PIN).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('has a lockfile so npm ci works offline-reproducibly', () => {
    expect(fs.existsSync(new URL('../assets/pixel-agents-runtime/package-lock.json', import.meta.url))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @aik/desktop -- test/pixel-agents-packaging.test.ts`
Expected: FAIL — asset package.json missing.

- [ ] **Step 3: Create the asset + wire packaging**

`apps/desktop/assets/pixel-agents-runtime/package.json`:

```json
{
  "name": "aik-pixel-agents-runtime",
  "private": true,
  "dependencies": {
    "pixel-agents": "1.5.0"
  }
}
```

Generate the lockfile (one-time, network):

```bash
cd apps/desktop/assets/pixel-agents-runtime
npm install --package-lock-only --ignore-scripts
cd ../../../../..
```

`apps/desktop/scripts/build.mjs` — after the opencode-runtime copy (line 28):

```js
fs.cpSync(path.join(root, 'apps/desktop/assets/pixel-agents-runtime'), path.join(out, 'pixel-agents-runtime'), { recursive: true });
```

`apps/desktop/package.json` — add to `build.extraResources` after the opencode-runtime entry:

```json
      {
        "from": "assets/pixel-agents-runtime",
        "to": "pixel-agents-runtime",
        "filter": ["**/*"]
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @aik/desktop -- test/pixel-agents-packaging.test.ts`
Expected: PASS (3 tests). Also run `npm run check:pins` — Expected: PASS (asset pin is exact).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/assets/pixel-agents-runtime apps/desktop/scripts/build.mjs apps/desktop/package.json apps/desktop/test/pixel-agents-packaging.test.ts
git commit -m "build(desktop): bundle pinned pixel-agents runtime asset"
```

---

### Task 8: Office server manager (install, spawn, discover, stop)

**Files:**
- Create: `apps/desktop/src/main/office-server.ts`
- Create: `apps/desktop/test/fixtures/fake-pixel-agents.cjs`
- Test: `apps/desktop/test/office-server.test.ts`

**Interfaces:**
- Consumes: `PIXEL_AGENTS_PIN` (Task 5/7).
- Produces (used by Task 10):
  - `officeInstallDir(dataDir: string): string`
  - `officeCliPath(dataDir: string): string`
  - `officeInstalled(dataDir: string): boolean`
  - `installPixelAgents(dataDir: string, assetsDir: string): { ok: true; version: string } | { ok: false; error: string }`
  - `startOfficeServer(opts: { dataDir: string; assetsDir: string; registryDir?: string; command?: string; node?: string; spawnTimeoutMs?: number }): Promise<OfficeServerInfo | null>` where `OfficeServerInfo = { port: number; url: string; token: string; pid: number | undefined }`
  - `stopOfficeServer(): void`

- [ ] **Step 1: Create the fake CLI fixture** (test double for the real `dist/cli.js`):

```js
// apps/desktop/test/fixtures/fake-pixel-agents.cjs
// Minimal stand-in for the pixel-agents CLI: serves /api/health on an ephemeral port and
// writes the registry entry pixel-agents would write, honouring AIK_OFFICE_REGISTRY_DIR.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const dir = process.env.AIK_OFFICE_REGISTRY_DIR;
if (!dir) process.exit(2);

const server = http.createServer((req, res) => {
  if (req.url === '/api/health') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', pid: process.pid }));
    return;
  }
  res.statusCode = 404;
  res.end('not found');
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  const entry = {
    port,
    pid: process.pid,
    token: 'test-office-token-1234567890',
    startedAt: Date.now(),
    servesSpa: true,
    protocol: 1,
  };
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${process.pid}-${port}.json`);
  fs.writeFileSync(file, JSON.stringify(entry, null, 2));
});
```

- [ ] **Step 2: Write the failing test**

```ts
// apps/desktop/test/office-server.test.ts
import { PIXEL_AGENTS_PIN } from '@aik/contracts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import {
  officeCliPath,
  officeInstalled,
  startOfficeServer,
  stopOfficeServer,
} from '../src/main/office-server.ts';

const temps: string[] = [];
const tempDir = (label: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aik-office-${label}-`));
  temps.push(dir);
  return dir;
};
afterAll(() => {
  stopOfficeServer();
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

const fixture = new URL('./fixtures/fake-pixel-agents.cjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

describe('office-server', () => {
  test('paths derive from the data dir and report install state', () => {
    const dataDir = tempDir('paths');
    expect(officeCliPath(dataDir)).toBe(
      path.join(dataDir, 'runtime', 'pixel-agents', 'node_modules', 'pixel-agents', 'dist', 'cli.js'),
    );
    expect(officeInstalled(dataDir)).toBe(false);
  });

  test('spawns the CLI, discovers port+token from the registry, verifies health', async () => {
    const registryDir = tempDir('registry');
    const info = await startOfficeServer({
      dataDir: tempDir('spawn'),
      assetsDir: tempDir('assets'),
      registryDir,
      command: fixture,
      node: process.execPath,
      spawnTimeoutMs: 10_000,
    });
    expect(info).not.toBeNull();
    expect(info!.port).toBeGreaterThan(0);
    expect(info!.url).toBe(`http://127.0.0.1:${info!.port}`);
    expect(info!.token).toBe('test-office-token-1234567890');

    const health = await fetch(`${info!.url}/api/health`);
    expect(health.ok).toBe(true);

    stopOfficeServer();
    await new Promise((r) => setTimeout(r, 200));
  }, 20_000);

  test('resolves null when the CLI never writes a registry entry', async () => {
    const never = path.join(tempDir('never'), 'no-such-cli.cjs');
    const info = await startOfficeServer({
      dataDir: tempDir('spawn2'),
      assetsDir: tempDir('assets2'),
      registryDir: tempDir('registry2'),
      command: never,
      node: process.execPath,
      spawnTimeoutMs: 500,
    });
    expect(info).toBeNull();
  }, 10_000);

  test('the pin stays exact (guards accidental range bumps)', () => {
    expect(PIXEL_AGENTS_PIN).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -w @aik/desktop -- test/office-server.test.ts`
Expected: FAIL — `Cannot find module '../src/main/office-server.ts'`.

- [ ] **Step 4: Write the implementation**

```ts
// apps/desktop/src/main/office-server.ts — the bundled Pixel Agents office server
// (spec 2026-11-04). Spawned privately with --no-terminal (a distinct access profile, so a
// user's own running instance is never silently reused). The registry entry the server writes
// (~/.pixel-agents/servers/<pid>-<port>.json, mode 0600) is the only trusted source of
// {port, token}; stdout is discarded because it prints the token.
import { PIXEL_AGENTS_PIN } from '@aik/contracts';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface OfficeServerInfo {
  port: number;
  url: string;
  token: string;
  pid: number | undefined;
}

export interface OfficeSpawnOptions {
  dataDir: string;
  assetsDir: string;
  /** Test seam: where registry entries are read from (default ~/.pixel-agents/servers). */
  registryDir?: string;
  /** Test seam: CLI to spawn (default: the runtime install's dist/cli.js). */
  command?: string;
  /** Test seam: node binary (default process.execPath). */
  node?: string;
  spawnTimeoutMs?: number;
}

export function officeInstallDir(dataDir: string): string {
  return path.join(dataDir, 'runtime', 'pixel-agents');
}

export function officeCliPath(dataDir: string): string {
  return path.join(officeInstallDir(dataDir), 'node_modules', 'pixel-agents', 'dist', 'cli.js');
}

export function officeInstalled(dataDir: string): boolean {
  return fs.existsSync(officeCliPath(dataDir));
}

/** Installs/repairs the pinned runtime: npm ci inside the data dir (never the repo). */
export function installPixelAgents(dataDir: string, assetsDir: string): { ok: true; version: string } | { ok: false; error: string } {
  try {
    const installDir = officeInstallDir(dataDir);
    fs.mkdirSync(installDir, { recursive: true });
    for (const file of ['package.json', 'package-lock.json']) {
      fs.copyFileSync(path.join(assetsDir, file), path.join(installDir, file));
    }
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    execFileSync(npm, ['ci', '--no-fund', '--no-audit', '--ignore-scripts'], {
      cwd: installDir,
      stdio: 'ignore',
      shell: process.platform === 'win32',
    });
    const version = (
      JSON.parse(fs.readFileSync(path.join(installDir, 'node_modules', 'pixel-agents', 'package.json'), 'utf8')) as { version: string }
    ).version;
    if (version !== PIXEL_AGENTS_PIN) return { ok: false, error: `pixel-agents ${version} installed but ${PIXEL_AGENTS_PIN} pinned` };
    return { ok: true, version };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

interface RegistryEntry {
  port: number;
  pid: number;
  token: string;
}

function readRegistryEntry(registryDir: string, pid: number): RegistryEntry | null {
  let files: string[] = [];
  try {
    files = fs.readdirSync(registryDir).filter((f) => f.endsWith('.json'));
  } catch {
    return null;
  }
  for (const file of files) {
    if (!file.startsWith(`${pid}-`)) continue;
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(registryDir, file), 'utf8')) as Partial<RegistryEntry>;
      if (typeof entry.port === 'number' && typeof entry.pid === 'number' && typeof entry.token === 'string') {
        return { port: entry.port, pid: entry.pid, token: entry.token };
      }
    } catch {
      // unparsable entry — keep scanning
    }
  }
  return null;
}

let current: { proc: ChildProcess; info: OfficeServerInfo } | null = null;
let starting: Promise<OfficeServerInfo | null> | null = null;

export function startOfficeServer(opts: OfficeSpawnOptions): Promise<OfficeServerInfo | null> {
  if (current && current.proc.exitCode === null) return Promise.resolve(current.info);
  starting ??= launch(opts).then((launched) => {
    current = launched;
    starting = null;
    return launched?.info ?? null;
  });
  return starting;
}

async function launch(opts: OfficeSpawnOptions): Promise<{ proc: ChildProcess; info: OfficeServerInfo } | null> {
  const registryDir = opts.registryDir ?? path.join(os.homedir(), '.pixel-agents', 'servers');
  const command = opts.command ?? officeCliPath(opts.dataDir);
  const proc = spawn(opts.node ?? process.execPath, [command, '--host', '127.0.0.1', '--no-terminal'], {
    stdio: 'ignore', // stdout prints the bearer token — never capture it
    env: { ...process.env, ...(opts.registryDir ? { AIK_OFFICE_REGISTRY_DIR: opts.registryDir } : {}) },
  });
  const timeoutMs = opts.spawnTimeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) return null;
    const entry = proc.pid ? readRegistryEntry(registryDir, proc.pid) : null;
    if (entry) {
      const url = `http://127.0.0.1:${entry.port}`;
      // Health-verify before declaring ready (their registry write precedes HTTP readiness).
      for (let i = 0; i < 40; i += 1) {
        try {
          const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(500) });
          if (res.ok) {
            return { proc, info: { port: entry.port, url, token: entry.token, pid: proc.pid } };
          }
        } catch {
          // not up yet
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      return null;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  proc.kill();
  return null;
}

export function stopOfficeServer(): void {
  if (current) {
    current.proc.kill();
    current = null;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -w @aik/desktop -- test/office-server.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/office-server.ts apps/desktop/test/fixtures/fake-pixel-agents.cjs apps/desktop/test/office-server.test.ts
git commit -m "feat(desktop): office server manager spawns and discovers pixel-agents"
```

---

### Task 9: AppSettings.agentOffice + settings IPC

**Files:**
- Modify: `packages/contracts/src/bridge.ts` (`AppSettings`)
- Modify: `apps/desktop/src/main/opencode-server.ts` (settings read/write)
- Modify: `apps/desktop/src/main/bridge.ts` (settings IPC handler + change hook)
- Test: `apps/desktop/test/office-settings.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `AppSettings = { opencodeMode: OpencodeMode; agentOffice: boolean }`; `RegisterBridgeDeps.onSettingsChanged?: (next: AppSettings) => void` (consumed by Task 10).

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/test/office-settings.test.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { readAppSettings, writeAppSettings } from '../src/main/opencode-server.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aik-office-settings-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('app settings: agent office', () => {
  test('defaults to off and survives unknown fields gracefully', () => {
    expect(readAppSettings(dir)).toEqual({ opencodeMode: 'managed', agentOffice: false });
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ opencodeMode: 'personal' }));
    expect(readAppSettings(dir)).toEqual({ opencodeMode: 'personal', agentOffice: false });
  });

  test('round-trips agentOffice=true without losing opencodeMode', () => {
    writeAppSettings(dir, { opencodeMode: 'managed', agentOffice: true });
    expect(readAppSettings(dir)).toEqual({ opencodeMode: 'managed', agentOffice: true });
    writeAppSettings(dir, { opencodeMode: 'personal', agentOffice: false });
    expect(readAppSettings(dir)).toEqual({ opencodeMode: 'personal', agentOffice: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @aik/desktop -- test/office-settings.test.ts`
Expected: FAIL — `agentOffice` missing from returned objects.

- [ ] **Step 3: Implement**

`packages/contracts/src/bridge.ts` — extend `AppSettings`:

```ts
export interface AppSettings {
  opencodeMode: OpencodeMode;
  /** Show running agents as pixel-art characters in the embedded Pixel Agents office (spec 2026-11-04). Off by default. */
  agentOffice: boolean;
}
```

`apps/desktop/src/main/opencode-server.ts` — update the settings block:

```ts
const DEFAULT_SETTINGS: AppSettings = { opencodeMode: 'managed', agentOffice: false };

export function readAppSettings(dataDir: string): AppSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')) as Partial<AppSettings>;
    return { opencodeMode: raw.opencodeMode === 'personal' ? 'personal' : 'managed', agentOffice: raw.agentOffice === true };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function writeAppSettings(dataDir: string, settings: AppSettings): AppSettings {
  const next: AppSettings = { opencodeMode: settings.opencodeMode === 'personal' ? 'personal' : 'managed', agentOffice: settings.agentOffice === true };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(next, null, 2));
  return next;
}
```

`apps/desktop/src/main/bridge.ts` — the settings-set handler keeps a field when the caller omits it and fires the change hook (add `onSettingsChanged` to the deps interface alongside the existing fields):

```ts
  ipcMain.handle('aik:app-settings-set', (event, raw: unknown) => {
    assertTrusted(event, deps);
    const previous = readAppSettings(deps.paths.dataDir);
    const parsed = z
      .object({ opencodeMode: z.enum(['managed', 'personal']), agentOffice: z.boolean().optional() })
      .parse(raw);
    const next = writeAppSettings(deps.paths.dataDir, {
      opencodeMode: parsed.opencodeMode,
      agentOffice: parsed.agentOffice ?? previous.agentOffice,
    });
    stopOpencodeServer(); // the next call starts a server in the new mode
    if (previous.agentOffice !== next.agentOffice) deps.onSettingsChanged?.(next);
    return next;
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @aik/desktop -- test/office-settings.test.ts`
Expected: PASS. Then `npm test -w @aik/desktop` — Expected: PASS (existing settings consumers still compile: they only read `opencodeMode`).

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/bridge.ts apps/desktop/src/main/opencode-server.ts apps/desktop/src/main/bridge.ts apps/desktop/test/office-settings.test.ts
git commit -m "feat(desktop): agentOffice app setting with change hook"
```

---

### Task 10: Office context, embedded view, IPC and main wiring

**Files:**
- Create: `apps/desktop/src/main/office-context.ts`
- Create: `apps/desktop/src/main/office-view.ts`
- Modify: `apps/desktop/src/main/index.ts` (startup, init message, quit, toggle)
- Modify: `apps/desktop/src/preload/index.ts` + `packages/contracts/src/bridge.ts` (`office` API namespace)
- Test: `apps/desktop/test/office-view.test.ts`

**Interfaces:**
- Consumes: `startOfficeServer`/`stopOfficeServer`/`officeInstalled`/`installPixelAgents` (Task 8); `AppSettings.onSettingsChanged` hook (Task 9); `OfficeConfig`/`OfficeBounds` (Task 5).
- Produces:
  - `setOfficeContext(next: OfficeConfig | null): void` / `getOfficeContext(): OfficeConfig | null`
  - `parseOfficeBounds(raw: unknown): OfficeBounds | null`
  - `class OfficeViewManager { show(): void; hide(): void; setBounds(b: OfficeBounds): void; destroy(): void }`
  - `registerOfficeIpc(deps: { manager: OfficeViewManager; isTrustedSender: (url: string) => boolean }): void`
  - Renderer API: `window.api.office.setVisible(visible: boolean): void; window.api.office.setBounds(bounds: OfficeBounds): void` over IPC channels `aik:office-visible` / `aik:office-bounds`

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/test/office-view.test.ts
import { clearOfficeContextForTests, getOfficeContext, parseOfficeBounds, setOfficeContext } from '../src/main/office-context.ts';

describe('office context + bounds parsing', () => {
  test('context round-trips and clears', () => {
    setOfficeContext({ url: 'http://127.0.0.1:45999', token: 'tok' });
    expect(getOfficeContext()).toEqual({ url: 'http://127.0.0.1:45999', token: 'tok' });
    clearOfficeContextForTests();
    expect(getOfficeContext()).toBeNull();
  });

  test('parseOfficeBounds accepts finite non-negative numbers only', () => {
    expect(parseOfficeBounds({ x: 10.4, y: 20.6, width: 800.5, height: 600.5 })).toEqual({ x: 10, y: 21, width: 801, height: 601 });
    expect(parseOfficeBounds({ x: -5, y: 0, width: 100, height: 100 })).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    expect(parseOfficeBounds({ x: 'a', y: 0, width: 100, height: 100 })).toBeNull();
    expect(parseOfficeBounds(null)).toBeNull();
    expect(parseOfficeBounds({ x: 1, y: 2, width: 0, height: 0 })).toEqual({ x: 1, y: 2, width: 0, height: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @aik/desktop -- test/office-view.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

`apps/desktop/src/main/office-context.ts`:

```ts
// apps/desktop/src/main/office-context.ts — main-process memory holder for the running office
// server, mirroring gateway-context.ts. The supervisor's initMessage closure reads it at spawn
// time, so a restart after a settings toggle picks the new state up automatically.
import type { OfficeConfig } from '@aik/contracts';

let context: OfficeConfig | null = null;

export function setOfficeContext(next: OfficeConfig | null): void {
  context = next;
}

export function getOfficeContext(): OfficeConfig | null {
  return context;
}

/** Rounds/clamps a renderer-reported rect; null when the payload is not a usable rect. */
export function parseOfficeBounds(raw: unknown): import('@aik/contracts').OfficeBounds | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const parts = [r.x, r.y, r.width, r.height];
  if (!parts.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  const round = (n: number) => Math.max(0, Math.round(n));
  return { x: round(parts[0] as number), y: round(parts[1] as number), width: round(parts[2] as number), height: round(parts[3] as number) };
}

export function clearOfficeContextForTests(): void {
  context = null;
}
```

`apps/desktop/src/main/office-view.ts`:

```ts
// apps/desktop/src/main/office-view.ts — embeds the office web UI tokenless (read-only,
// enforced server-side by pixel-agents) in a WebContentsView layered over the renderer's
// /office route. An <iframe> is not viable in production: app:// is a secure scheme and an
// http subframe would be blocked as mixed content (spec 2026-11-04).
import type { OfficeBounds } from '@aik/contracts';
import { ipcMain, WebContentsView } from 'electron';
import type { BrowserWindow } from 'electron';
import { getOfficeContext, parseOfficeBounds } from './office-context.ts';

export class OfficeViewManager {
  private view: WebContentsView | null = null;
  private visible = false;
  private bounds: OfficeBounds | null = null;

  constructor(private readonly win: BrowserWindow) {}

  private ensureView(): WebContentsView | null {
    const office = getOfficeContext();
    if (!office || this.win.isDestroyed()) return null;
    if (!this.view) {
      this.view = new WebContentsView({ webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
      const origin = `${office.url}/`;
      this.view.webContents.on('will-navigate', (event, url) => {
        if (!url.startsWith(origin)) event.preventDefault();
      });
      this.win.addChildView(this.view);
      void this.view.webContents.loadURL(origin);
    }
    return this.view;
  }

  show(): void {
    this.visible = true;
    const view = this.ensureView();
    if (view && this.bounds && this.bounds.width > 0 && this.bounds.height > 0) view.setBounds(this.bounds);
  }

  hide(): void {
    this.visible = false;
    this.view?.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  }

  setBounds(bounds: OfficeBounds): void {
    this.bounds = bounds;
    if (this.visible && this.view && bounds.width > 0 && bounds.height > 0) this.view.setBounds(bounds);
  }

  destroy(): void {
    if (!this.view) return;
    if (!this.win.isDestroyed()) this.win.removeChildView(this.view);
    this.view.webContents.close();
    this.view = null;
  }
}

export function registerOfficeIpc(deps: { manager: OfficeViewManager; isTrustedSender: (url: string) => boolean }): void {
  ipcMain.on('aik:office-visible', (event, visible: unknown) => {
    if (!deps.isTrustedSender(event.senderFrame?.url ?? '')) return;
    if (visible === true) deps.manager.show();
    else deps.manager.hide();
  });
  ipcMain.on('aik:office-bounds', (event, raw: unknown) => {
    if (!deps.isTrustedSender(event.senderFrame?.url ?? '')) return;
    const bounds = parseOfficeBounds(raw);
    if (bounds) deps.manager.setBounds(bounds);
  });
}
```

`packages/contracts/src/bridge.ts` — extend `AikWindowApi` (after `openTerminalCli`):

```ts
  office: {
    /** Tell main whether the office view should be visible (office route active + feature on). */
    setVisible(visible: boolean): void;
    /** Report the office container's viewport bounds (CSS px == DIP at zoom 1) so main can position the embedded view. */
    setBounds(bounds: OfficeBounds): void;
  };
```

with `import type { OfficeBounds } from './pixel-agents.ts';` at the top of `bridge.ts`.

`apps/desktop/src/preload/index.ts` — add to the `api` object (after `openTerminalCli`):

```ts
  office: {
    setVisible: (visible) => ipcRenderer.send('aik:office-visible', visible),
    setBounds: (bounds) => ipcRenderer.send('aik:office-bounds', bounds),
  },
```

`apps/desktop/src/main/index.ts` — wire it all (imports first):

```ts
import { installPixelAgents, officeInstalled, startOfficeServer, stopOfficeServer } from './office-server.ts';
import { getOfficeContext, setOfficeContext } from './office-context.ts';
import { OfficeViewManager, registerOfficeIpc } from './office-view.ts';
```

In `main()`, make the init message office-aware (after the `gatewayToken` line in `initMessage`):

```ts
      ...(getOfficeContext() ? { agentOffice: getOfficeContext() } : {}),
```

Replace the `whenReady` body — office boot happens before `supervisor.start()` so the first init message already carries it; the settings toggle starts/stops and restarts the orchestrator:

```ts
  void app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    registerAppProtocol(path.join(__dirname, 'ui'));

    // Pixel Agents office (spec 2026-11-04): boot before the supervisor so the init message
    // carries the config; failures degrade to feature-off (no office, no bridge).
    if (readAppSettings(paths.dataDir).agentOffice) {
      if (!officeInstalled(paths.dataDir)) {
        const installed = installPixelAgents(paths.dataDir, path.join(__dirname, 'pixel-agents-runtime'));
        if (!installed.ok) console.error(`agent office install failed: ${installed.error}`);
      }
      if (officeInstalled(paths.dataDir)) {
        const info = await startOfficeServer({ dataDir: paths.dataDir, assetsDir: path.join(__dirname, 'pixel-agents-runtime') });
        if (info) setOfficeContext({ url: info.url, token: info.token });
      }
    }

    registerBridge({
      supervisor,
      token,
      paths,
      opencodeAssetsDir: path.join(__dirname, 'opencode-runtime'),
      isTrustedSender: (url) => url.startsWith('app://ui/') || (devUrl !== null && url.startsWith(devUrl)),
      onSettingsChanged: async (next) => {
        if (next.agentOffice) {
          if (!officeInstalled(paths.dataDir)) installPixelAgents(paths.dataDir, path.join(__dirname, 'pixel-agents-runtime'));
          const info = officeInstalled(paths.dataDir)
            ? await startOfficeServer({ dataDir: paths.dataDir, assetsDir: path.join(__dirname, 'pixel-agents-runtime') })
            : null;
          if (info) setOfficeContext({ url: info.url, token: info.token });
        } else {
          stopOfficeServer();
          setOfficeContext(null);
        }
        // initMessage is a closure: the restarted orchestrator gets the new office state.
        supervisor.restart();
      },
    });
    supervisor.start();
    forwarder.start();
    win = createMainWindow({ preload: path.join(__dirname, 'preload.cjs'), url: devUrl ?? 'app://ui/index.html' });
    win.on('closed', () => {
      win = null;
    });
    const officeManager = new OfficeViewManager(win);
    registerOfficeIpc({
      manager: officeManager,
      isTrustedSender: (url) => url.startsWith('app://ui/') || (devUrl !== null && url.startsWith(devUrl)),
    });
    win.on('closed', () => officeManager.destroy());
    if (isE2E) (globalThis as Record<string, unknown>).__aik = { supervisor, dataDir: paths.dataDir, token };
  });
```

And in `before-quit`, add `stopOfficeServer();` next to `stopOpencodeServer();`.

If `registerBridge`'s deps type doesn't accept `onSettingsChanged`, add the optional field `onSettingsChanged?: (next: AppSettings) => void;` to its deps interface in `apps/desktop/src/main/bridge.ts` (Task 9 already added the call site).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @aik/desktop -- test/office-view.test.ts`
Expected: PASS. Then `npm test -w @aik/desktop` and `npm run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/office-context.ts apps/desktop/src/main/office-view.ts apps/desktop/src/main/index.ts apps/desktop/src/main/bridge.ts apps/desktop/src/preload/index.ts packages/contracts/src/bridge.ts apps/desktop/test/office-view.test.ts
git commit -m "feat(desktop): embed pixel agents office via WebContentsView with trusted IPC"
```

---

### Task 11: Office route, sidebar link, bounds reporting

**Files:**
- Create: `apps/ui/src/lib/office.ts`
- Create: `apps/ui/src/routes/office.tsx`
- Modify: `apps/ui/src/router.tsx`, `apps/ui/src/components/shell/sidebar.tsx`
- Test: `apps/ui/test/office.test.ts`

**Interfaces:**
- Consumes: `window.api.office.setVisible/setBounds` (Task 10), `window.api.getAppSettings` (existing).
- Produces: `/office` route (`OfficePage`), `isOfficeEnabled(settings: AppSettings | null): boolean`, `toOfficeBounds(rect: { x: number; y: number; width: number; height: number }): OfficeBounds`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/ui/test/office.test.ts
import { isOfficeEnabled, toOfficeBounds } from '../src/lib/office.ts';

describe('office lib', () => {
  test('enabled only when the setting is explicitly true', () => {
    expect(isOfficeEnabled({ opencodeMode: 'managed', agentOffice: true })).toBe(true);
    expect(isOfficeEnabled({ opencodeMode: 'managed', agentOffice: false })).toBe(false);
    expect(isOfficeEnabled(null)).toBe(false);
  });

  test('bounds are rounded, never negative', () => {
    expect(toOfficeBounds({ x: 10.4, y: 20.6, width: 800.5, height: 600.2 })).toEqual({ x: 10, y: 21, width: 801, height: 600 });
    expect(toOfficeBounds({ x: -3, y: 0, width: 12.5, height: 0 })).toEqual({ x: 0, y: 0, width: 13, height: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @aik/ui -- test/office.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

`apps/ui/src/lib/office.ts`:

```ts
// apps/ui/src/lib/office.ts — pure helpers for the embedded Pixel Agents office view.
import type { AppSettings, OfficeBounds } from '@aik/contracts';

export function isOfficeEnabled(settings: AppSettings | null): boolean {
  return settings?.agentOffice === true;
}

export function toOfficeBounds(rect: { x: number; y: number; width: number; height: number }): OfficeBounds {
  const round = (n: number) => Math.max(0, Math.round(n));
  return { x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height) };
}
```

`apps/ui/src/routes/office.tsx`:

```tsx
import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import type { AppSettings } from '@aik/contracts';
import { TopBar } from '../components/shell/top-bar.tsx';
import { isOfficeEnabled, toOfficeBounds } from '../lib/office.ts';

/**
 * The office itself renders in a main-process WebContentsView layered over this container
 * (an iframe would be mixed content under app://). This page owns: the feature off state,
 * the loading state, and reporting the container's bounds so main can position the view.
 */
export function OfficePage() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void window.api.getAppSettings().then(setSettings, () => setSettings(null));
  }, []);

  const enabled = isOfficeEnabled(settings);

  useEffect(() => {
    if (!enabled) return;
    const report = () => {
      const el = ref.current;
      if (el) window.api.office.setBounds(toOfficeBounds(el.getBoundingClientRect()));
    };
    report();
    window.api.office.setVisible(true);
    const onResize = () => report();
    window.addEventListener('resize', onResize);
    const el = ref.current;
    const observer = el ? new ResizeObserver(report) : null;
    if (el && observer) observer.observe(el);
    return () => {
      window.removeEventListener('resize', onResize);
      observer?.disconnect();
      window.api.office.setVisible(false);
    };
  }, [enabled]);

  return (
    <div className="flex h-full flex-col">
      <TopBar title="Agent office" subtitle="Every running agent as a pixel-art character" />
      <div className="min-h-0 flex-1 p-4">
        {settings === null ? (
          <p data-testid="office-loading" className="text-sm text-muted">Loading…</p>
        ) : enabled ? (
          <div
            data-testid="office-viewport"
            ref={ref}
            aria-label="Agent office viewport (rendered natively by the app)"
            className="h-full w-full rounded-panel border border-glass-border bg-surface-2"
          />
        ) : (
          <p data-testid="office-disabled" className="rounded-panel border border-dashed border-glass-border bg-glass/40 p-6 text-sm text-muted">
            The agent office is turned off. Enable it in{' '}
            <Link to="/settings" className="font-semibold text-foreground underline">
              Settings
            </Link>
            .
          </p>
        )}
      </div>
    </div>
  );
}
```

`apps/ui/src/router.tsx` — add the import and route:

```ts
import { OfficePage } from './routes/office.tsx';
```

```ts
const officeRoute = createRoute({ getParentRoute: () => rootRoute, path: '/office', component: OfficePage });
```

and include `officeRoute` in `routeTree: rootRoute.addChildren([dashboardRoute, boardRoute, codeRoute, gitRoute, usageRoute, settingsRoute, officeRoute])`.

`apps/ui/src/components/shell/sidebar.tsx` — add between Usage and Settings in the `<nav>`:

```tsx
        <Link to="/office" className={navItem}>
          Office
        </Link>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @aik/ui -- test/office.test.ts`
Expected: PASS. Then `npm test -w @aik/ui` and `npm run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/lib/office.ts apps/ui/src/routes/office.tsx apps/ui/src/router.tsx apps/ui/src/components/shell/sidebar.tsx apps/ui/test/office.test.ts
git commit -m "feat(ui): office route with bounds reporting and off-state"
```

---

### Task 12: Settings card for the agent office

**Files:**
- Modify: `apps/ui/src/routes/settings.tsx`

**Interfaces:**
- Consumes: `AppSettings.agentOffice` (Task 9), `window.api.setAppSettings`.
- Produces: none (UI glue; the toggling side effects run in main via Task 10's `onSettingsChanged`).

Note: the UI suite has no DOM rendering setup (pure-function tests only), so this task is verified by typecheck + lint + the existing suites + the Task 13 e2e-ready manual check; the checkbox is a real `<input type="checkbox">` so Playwright `check()` works if a spec is added later.

- [ ] **Step 1: Implement** — in `settings.tsx`:

Add state + loading (extend the existing effect):

```tsx
  const [office, setOffice] = useState(false);
```

```tsx
    void window.api.getAppSettings().then((s) => {
      setMode(s.opencodeMode);
      setOffice(s.agentOffice);
    }, () => undefined);
```

Update `changeMode` to preserve the office flag, and add the office toggle handler:

```tsx
  /** The managed/personal decision is shared by the model picker and the Providers card. */
  const changeMode = async (next: OpencodeMode) => {
    if (next === mode) return;
    setMode(next);
    const saved = await window.api.setAppSettings({ opencodeMode: next, agentOffice: office });
    setMode(saved.opencodeMode);
    setOffice(saved.agentOffice);
  };

  /** Toggling starts/stops the bundled office server and restarts the orchestrator (main side). */
  const changeOffice = async (next: boolean) => {
    if (next === office) return;
    setOffice(next);
    const saved = await window.api.setAppSettings({ opencodeMode: mode, agentOffice: next });
    setMode(saved.opencodeMode);
    setOffice(saved.agentOffice);
  };
```

Insert a card after the `settings-runtime` card (before `settings-about`):

```tsx
          <Card data-testid="settings-office" className="p-4">
            <h2 className="text-sm font-semibold text-foreground">Agent office</h2>
            <p className="mt-1 text-xs text-muted">
              Show every running agent as a pixel-art character in an office view. Bundled Pixel
              Agents (MIT) runs locally on 127.0.0.1 and is embedded read-only. Enabling it also
              turns on Pixel Agents' global "Watch all sessions" setting so this app's agents
              appear; the orchestrator restarts once to activate it.
            </p>
            <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                data-testid="office-toggle"
                checked={office}
                onChange={(e) => void changeOffice(e.target.checked)}
                className="h-3.5 w-3.5 shrink-0 appearance-none rounded-[4px] border border-border-strong bg-surface-2 checked:border-accent checked:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              />
              Show agents in the office view
            </label>
          </Card>
```

- [ ] **Step 2: Verify compile + suites**

Run: `npm run typecheck`
Expected: no errors.

Run: `npm test -w @aik/ui`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/ui/src/routes/settings.tsx
git commit -m "feat(ui): agent office settings card"
```

---

### Task 13: Docs + full verification gate

**Files:**
- Modify: `README.md`

**Interfaces:** none.

- [ ] **Step 1: Document the feature** — add a section to `README.md` after "## Skill Vault":

```markdown
## Agent office

Optional (Settings → Agent office, off by default): every planner/implementer/reviewer run
appears as an animated pixel-art character in an embedded office view powered by the bundled
[Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents) runtime (exact-pinned, MIT).
The office server runs locally on 127.0.0.1 with terminals disabled and is embedded read-only;
its loopback bearer token stays in the app's processes (redacted from all logs). Enabling the
feature also turns on Pixel Agents' global "Watch all sessions" setting (required for external
agents to appear). Design: `docs/superpowers/specs/2026-11-04-pixel-agents-office-design.md`.
```

- [ ] **Step 2: Run the full gate (separate commands — PowerShell)**

```bash
npm run check:pins
npm run lint
npm run typecheck
npm test
```

Expected: all four PASS. If any fails, fix before proceeding (the fix belongs in the task that owns the file).

- [ ] **Step 3: Manual smoke check (developer machine, recorded in the PR description)**

1. `npm run build` then `npm start`.
2. Settings → Agent office → tick the checkbox (first enable installs the runtime; the orchestrator restarts).
3. Sidebar → Office: the office renders (empty).
4. Start a story run (e.g. plan a story on any project): a character labelled `STORY-KEY planner` appears and despawns when the run ends.
5. Untick the checkbox: the office server stops (`~/.pixel-agents/servers/` entry gone) and the Office page shows the off state.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: agent office (pixel agents) feature"
```

---

## Self-review notes

- Spec coverage: verified-facts §ingest → Task 5; adoption setting → Task 5 (`pushWatchAllSessions`); lifecycle events → Tasks 1–4; bridge config/init message → Tasks 6/10; bundling/spawn/registry → Tasks 7–8; settings toggle + restart → Tasks 9–10; read-only embed → Task 10; UI route/sidebar/settings → Tasks 11–12; security (token redaction, tokenless embed, trusted IPC) → Tasks 5/6/10; docs → Task 13. Phase-2 items (tool-level fidelity) are spec non-goals.
- Known verification gaps (declared, not hidden): the office content itself has no e2e (needs the real bundled server — spec records this); Task 12 is UI glue verified by typecheck/lint/suites + Task 13 manual smoke.
- Type consistency: `OfficeConfig`/`OfficeBounds`/`PIXEL_AGENTS_PIN` live in `packages/contracts/src/pixel-agents.ts` and are imported by orchestrator (Task 6) and desktop (Tasks 8, 10); `emitRunStarted/emitRunFinished` signatures identical across Tasks 2–4; `startOfficeServer(opts)`/`stopOfficeServer()` identical across Tasks 8 and 10.
