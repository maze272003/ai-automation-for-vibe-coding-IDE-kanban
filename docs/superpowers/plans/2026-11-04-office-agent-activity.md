# Office Agent Activity (Click-to-Watch + Live Tool Bubbles) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking a pixel-office character opens the existing "Terminal Logs & Thoughts" modal for that story, and characters show live real tool/thinking activity while runs are in flight.

**Architecture:** Three wires: (1) the runtime's 400 ms poll loop diffs OpenCode session messages into `onActivity` events that agents append as `run.activity` outbox rows; (2) the PixelAgentsBridge translates those rows into `PreToolUse`/`PostToolUse` hook posts so pixel-agents renders real bubbles; (3) a sandboxed preload inside the embedded office view observes the page's `focusAgent` WebSocket frame (character click) and forwards the character label, which the office route resolves to a story and opens the existing Terminal modal via a `?terminal=` board search param.

**Tech Stack:** TypeScript, Electron (utilityProcess, WebContentsView, sandboxed preloads), Fastify, better-sqlite3 + Drizzle, TanStack Router, Vitest. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-11-04-office-agent-activity-design.md`

## Global Constraints

- Dependencies use exact versions only (`npm install -E`); `npm run check:pins` enforces this. No new dependencies in this plan.
- Before claiming any task done, run: `npm run check:pins && npm run lint && npm run typecheck && npm test`.
- Tests never touch a real repository or real `%USERPROFILE%\.pixel-agents`; temp paths come from `apps/orchestrator/test/helpers/temp.ts` (or `fs.mkdtempSync(path.join(os.tmpdir(), ...))`).
- Story status changes only through `WorkflowService`.
- Never log or persist secrets; summaries pass through the orchestrator redactor before persisting.
- pixel-agents stays pinned at `PIXEL_AGENTS_PIN = '1.5.0'` (spawn-only; no upstream code changes).
- All test commands run from the repo root. Windows (PowerShell) environment.

---

### Task 1: Runtime activity diffing (`onActivity`)

**Files:**
- Create: `apps/orchestrator/src/agents/run-activity.ts`
- Modify: `apps/orchestrator/src/agents/runtime.ts` (RunOneShotInput + the 400 ms loop, lines 63-72 and 254-296)
- Test: `apps/orchestrator/test/run-activity.test.ts` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `interface RunActivityEvent { kind: 'tool-start' | 'tool-end'; name: string; summary?: string }`
  - `interface ActivityDiffState { seen: Set<string>; thinking: boolean }`
  - `createActivityDiffState(): ActivityDiffState`
  - `diffActivity(state: ActivityDiffState, messages: unknown[]): RunActivityEvent[]`
  - `RunOneShotInput.onActivity?: (events: RunActivityEvent[]) => void` (fired at most once per 400 ms tick, only when provided; never throws)

- [ ] **Step 1: Write the failing tests**

Create `apps/orchestrator/test/run-activity.test.ts`:

```ts
// apps/orchestrator/test/run-activity.test.ts
import { describe, expect, test } from 'vitest';
import { createActivityDiffState, diffActivity } from '../src/agents/run-activity.ts';

/** Part shapes follow spikes/spk-1/out/probe-A-messages.json (tool state.input.path, bash command). */
const tool = (id: string, name: string, status: string, input: Record<string, unknown> = {}) => ({
  type: 'tool', id, name, state: { status, input },
});

describe('diffActivity', () => {
  test('a new completed tool emits start then end with a file summary', () => {
    const state = createActivityDiffState();
    const messages = [{ role: 'assistant', content: [tool('p1', 'edit', 'completed', { path: 'C:/x/src/foo.ts' })] }];
    expect(diffActivity(state, messages)).toEqual([
      { kind: 'tool-start', name: 'edit', summary: 'foo.ts' },
      { kind: 'tool-end', name: 'edit' },
    ]);
    // Second diff of the same messages: nothing new.
    expect(diffActivity(state, messages)).toEqual([]);
  });

  test('running tool starts now, ends on a later tick', () => {
    const state = createActivityDiffState();
    const first = [{ role: 'assistant', content: [tool('p1', 'bash', 'running', { command: 'npm test' })] }];
    expect(diffActivity(state, first)).toEqual([{ kind: 'tool-start', name: 'bash', summary: 'npm test' }]);
    const later = [{ role: 'assistant', content: [tool('p1', 'bash', 'completed', { command: 'npm test' })] }];
    expect(diffActivity(state, later)).toEqual([{ kind: 'tool-end', name: 'bash' }]);
  });

  test('bash commands are truncated to 120 chars; long paths use the basename', () => {
    const state = createActivityDiffState();
    const long = 'x'.repeat(200);
    const messages = [
      { role: 'assistant', content: [tool('p1', 'bash', 'running', { command: long })] },
    ];
    expect(diffActivity(state, messages)).toEqual([
      { kind: 'tool-start', name: 'bash', summary: `${'x'.repeat(120)}…` },
    ]);
  });

  test('reasoning starts Thinking; a following text part ends it before other events', () => {
    const state = createActivityDiffState();
    const tick1 = [{ role: 'assistant', content: [{ type: 'reasoning', text: 'hmm' }] }];
    expect(diffActivity(state, tick1)).toEqual([{ kind: 'tool-start', name: 'Thinking' }]);
    const tick2 = [
      {
        role: 'assistant',
        content: [{ type: 'reasoning', text: 'hmm' }, tool('p1', 'read', 'running', { path: 'a/b.ts' })],
      },
    ];
    expect(diffActivity(state, tick2)).toEqual([
      { kind: 'tool-end', name: 'Thinking' },
      { kind: 'tool-start', name: 'read', summary: 'b.ts' },
    ]);
  });

  test('unknown shapes are ignored without throwing', () => {
    const state = createActivityDiffState();
    expect(diffActivity(state, [{ type: 'idle', outcome: 'succeeded' }, null, { content: 'nope' }, { content: [{}] }])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/orchestrator/test/run-activity.test.ts`
Expected: FAIL — `Cannot find module '../src/agents/run-activity.ts'`.

- [ ] **Step 3: Implement `run-activity.ts`**

Create `apps/orchestrator/src/agents/run-activity.ts`:

```ts
// apps/orchestrator/src/agents/run-activity.ts — pure message→activity diffing for the
// office bubbles (spec 2026-11-04-office-agent-activity). Part shapes follow
// spikes/spk-1/out/probe-A-messages.json: tool parts are
// {type:'tool', id, name, state:{status, input}}; reasoning parts {type:'reasoning'}.
export interface RunActivityEvent {
  kind: 'tool-start' | 'tool-end';
  name: string;
  summary?: string;
}

export interface ActivityDiffState {
  /** Composite keys of parts already reported: `t:<id>` (started) and `e:<id>` (ended). */
  seen: Set<string>;
  thinking: boolean;
}

const SUMMARY_MAX = 120;

export function createActivityDiffState(): ActivityDiffState {
  return { seen: new Set(), thinking: false };
}

const basenameOf = (p: unknown): string | undefined =>
  typeof p === 'string' && p !== '' ? p.split(/[\\/]/).pop() : undefined;

function summaryFor(name: string, input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const inp = input as Record<string, unknown>;
  if (name === 'bash' && typeof inp.command === 'string' && inp.command !== '') {
    const cmd = inp.command;
    return cmd.length > SUMMARY_MAX ? `${cmd.slice(0, SUMMARY_MAX)}…` : cmd;
  }
  return basenameOf(inp.path) ?? basenameOf(inp.file_path);
}

/**
 * Diff one message fetch against `state` (mutated). Event order within a tick:
 * Thinking-end first (a tool/text part followed the reasoning), then new tool starts,
 * then tool ends, then a Thinking-start if new reasoning appeared. Never throws.
 */
export function diffActivity(state: ActivityDiffState, messages: unknown[]): RunActivityEvent[] {
  const starts: RunActivityEvent[] = [];
  const ends: RunActivityEvent[] = [];
  let sawReasoning = false;
  let sawText = false;
  try {
    for (const message of messages) {
      if (typeof message !== 'object' || message === null) continue;
      const content = (message as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (typeof part !== 'object' || part === null) continue;
        const p = part as { type?: unknown; id?: unknown; name?: unknown; state?: unknown };
        if (p.type === 'reasoning') sawReasoning = true;
        if (p.type === 'text') sawText = true;
        if (p.type !== 'tool' || typeof p.id !== 'string' || typeof p.name !== 'string') continue;
        const raw = typeof p.state === 'object' && p.state !== null ? p.state : {};
        const st = raw as { status?: unknown; input?: unknown };
        const status = typeof st.status === 'string' ? st.status : 'running';
        const terminal = status === 'completed' || status === 'failed';
        if (!state.seen.has(`t:${p.id}`)) {
          state.seen.add(`t:${p.id}`);
          const summary = summaryFor(p.name, st.input);
          starts.push({ kind: 'tool-start', name: p.name, ...(summary !== undefined ? { summary } : {}) });
          if (terminal) {
            state.seen.add(`e:${p.id}`);
            ends.push({ kind: 'tool-end', name: p.name });
          }
        } else if (terminal && !state.seen.has(`e:${p.id}`)) {
          state.seen.add(`e:${p.id}`);
          ends.push({ kind: 'tool-end', name: p.name });
        }
      }
    }
  } catch {
    return []; // activity reporting must never break a run
  }
  const events: RunActivityEvent[] = [];
  if (state.thinking && (sawText || starts.length > 0)) {
    events.push({ kind: 'tool-end', name: 'Thinking' });
    state.thinking = false;
  }
  events.push(...starts, ...ends);
  if (sawReasoning && !state.thinking) {
    events.push({ kind: 'tool-start', name: 'Thinking' });
    state.thinking = true;
  }
  return events;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/orchestrator/test/run-activity.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Wire `onActivity` into the runtime (with a failing test first)**

Add to `apps/orchestrator/test/agent-runtime.test.ts` (inside the existing `describe('OpenCodeRuntime')`; reuse the existing fake-server harness variables `sessionStartDelayPolls`, `sessionActivePolls`, `mockMessages`):

```ts
  test('runOneShot reports activity diffs while the session runs', async () => {
    const runtime = new OpenCodeRuntime();
    // The fake server harness: active for 3 polls, messages contain one completed tool.
    sessionStartDelayPolls = 0;
    sessionActivePolls = 3;
    mockMessages = [
      { type: 'assistant', finish: 'stop', content: [{ type: 'text', text: 'done' }], time: { created: 2 } },
    ] as typeof mockMessages;
    const ticks: unknown[][] = [];
    const result = await runtime.runOneShot({
      title: 'activity',
      directory: process.cwd(),
      prompt: 'go',
      onActivity: (events) => ticks.push(events),
      onSessionCreated: () => {
        // Swap in tool parts mid-run so the next 400 ms tick sees them.
        mockMessages = [
          {
            type: 'assistant',
            finish: 'stop',
            content: [
              { type: 'tool', id: 'tp1', name: 'read', state: { status: 'completed', input: { path: 'src/foo.ts' } } },
              { type: 'text', text: 'done' },
            ],
            time: { created: 2 },
          },
        ] as typeof mockMessages;
      },
    } as never);
    expect(result.ok).toBe(true);
    const flat = ticks.flat() as { kind: string; name: string; summary?: string }[];
    expect(flat).toContainEqual({ kind: 'tool-start', name: 'read', summary: 'foo.ts' });
    expect(flat).toContainEqual({ kind: 'tool-end', name: 'read' });
  });
```

Note: the mock message type in that file is `{ type: string; content?: { type: string; text: string }[] }` — extend it to `content?: Record<string, unknown>[]` so tool parts type-check (adjust only that local type alias).

- [ ] **Step 6: Run the runtime test to verify it fails**

Run: `npx vitest run apps/orchestrator/test/agent-runtime.test.ts`
Expected: FAIL — `ticks` is empty (`onActivity` never called; `flat` does not contain the tool events).

- [ ] **Step 7: Implement the runtime wiring**

In `apps/orchestrator/src/agents/runtime.ts`:

1. Add to imports at the top: `import { createActivityDiffState, diffActivity } from './run-activity.ts';` and extend the existing `RunOneShotInput` interface (after `onSessionCreated`) with:

```ts
  /** Fired at most once per 400 ms tick with the run's new activity (office bubbles, spec 2026-11-04-office-agent-activity). Never throws. */
  onActivity?: (events: import('./run-activity.ts').RunActivityEvent[]) => void;
```

(Use a direct import of the type at the top instead of the inline `import()` if the lint rules prefer it.)

2. In `runOneShot`, before the `for (;;)` poll loop (after `let sawActive = false;`), add:

```ts
      // Office bubble feed (spec 2026-11-04-office-agent-activity): when a consumer wants
      // activity, fetch the messages each tick and diff them. Cost: one extra loopback GET
      // per 400 ms — the same message endpoint the run's final extraction already uses.
      const activity = input.onActivity ? createActivityDiffState() : null;
```

3. Inside the loop, after the active/pending branch (the `else` block ending at `if (sessionHasCompleted(...)) || Date.now() > startGraceDeadline) break;`) and before the `if (interruptSent) {` check, add:

```ts
        if (activity && input.onActivity) {
          const res = await this.api('GET', `/api/session/${id}/message`, input.directory).catch(() => ({ status: 0, body: null }));
          const msgs = (res.body as { data?: unknown[] } | null)?.data ?? [];
          const events = diffActivity(activity, msgs);
          if (events.length > 0) {
            try {
              input.onActivity(events);
            } catch {
              // activity reporting must never fail a run
            }
          }
        }
```

- [ ] **Step 8: Run the runtime tests to verify they pass**

Run: `npx vitest run apps/orchestrator/test/agent-runtime.test.ts apps/orchestrator/test/run-activity.test.ts`
Expected: PASS (all).

- [ ] **Step 9: Commit**

```bash
git add apps/orchestrator/src/agents/run-activity.ts apps/orchestrator/src/agents/runtime.ts apps/orchestrator/test/run-activity.test.ts apps/orchestrator/test/agent-runtime.test.ts
git commit -m "feat(orchestrator): runtime diffs session messages into onActivity events"
```

---

### Task 2: `run.activity` outbox emission

**Files:**
- Modify: `packages/contracts/src/events.ts:3-6` (EVENT_TOPICS)
- Modify: `apps/orchestrator/src/agents/run-events.ts` (appendRunActivity)
- Modify: `apps/orchestrator/src/agents/planner.ts` (deps + onActivity), `apps/orchestrator/src/agents/implementer.ts`, `apps/orchestrator/src/agents/reviewer.ts` (same wiring at their runOneShot call sites)
- Modify: `apps/orchestrator/src/app.ts` (pass `redact` to the three agents, lines ~234-236)
- Test: `apps/orchestrator/test/run-events.test.ts`, `apps/orchestrator/test/planner.test.ts`

**Interfaces:**
- Consumes: `RunActivityEvent` from Task 1; existing `runEventInfo`, `appendOutbox`.
- Produces:
  - Outbox topic `'run.activity'` on `EVENT_TOPICS`.
  - `appendRunActivity(db: AikDbOrTx, now: Date, runId: number, events: RunActivityEvent[], redact?: (text: string) => string, rowCap?: number): number | null` — appends one row `{ runId, role, storyKey, projectKey, events }` (each event's `summary` redacted); returns the outbox seq, or `null` (no-op) when the run is unknown, events empty, or the run already has `rowCap` activity rows (default 300).
  - `PlannerAgent`/`ImplementerAgent`/`ReviewerAgent` deps gain optional `redact?: (text: string) => string` (default identity).

- [ ] **Step 1: Write the failing tests**

Add to `apps/orchestrator/test/run-events.test.ts` (inside `describe('run-events')`; reuses the file's existing helpers/imports; add `appendRunActivity` to the import from `'../src/agents/run-events.ts'`):

```ts
  test('appendRunActivity batches one row per call, redacts summaries, enforces the cap', () => {
    const t = createTestDb();
    const project = seedProject(t.db, { key: 'INV' });
    const story = seedStory(t.db, project.id, { key: 'INV-7' });
    const run = t.db
      .insert(agentRuns)
      .values({
        storyId: story.id, role: 'implementer', attempt: 1, promptVersion: '1.0',
        opencodeVersion: '2.0.32', status: 'running', idempotencyKey: `act_${story.id}`,
        startedAt: new Date(1_000),
      })
      .returning()
      .get();

    const redact = (s: string) => s.replace(/hunter2/g, '[red]');
    const seq = appendRunActivity(
      t.db, new Date(2_000), run.id,
      [
        { kind: 'tool-start', name: 'bash', summary: 'echo hunter2' },
        { kind: 'tool-start', name: 'Thinking' },
      ],
      redact,
    );
    expect(typeof seq).toBe('number');

    const rows = readOutbox(t.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ topic: 'run.activity', storyId: story.id, provenance: 'system' });
    expect(rows[0]?.data).toEqual({
      runId: run.id, role: 'implementer', storyKey: 'INV-7', projectKey: 'INV',
      events: [{ kind: 'tool-start', name: 'bash', summary: 'echo [red]' }, { kind: 'tool-start', name: 'Thinking' }],
    });

    // Cap: with rowCap=1 the second call is a no-op.
    expect(appendRunActivity(t.db, new Date(3_000), run.id, [{ kind: 'tool-end', name: 'bash' }], redact, 1)).toBeNull();
    expect(readOutbox(t.db)).toHaveLength(1);

    // Unknown run / empty events: no-ops.
    expect(appendRunActivity(t.db, new Date(4_000), 999_999, [{ kind: 'tool-end', name: 'x' }])).toBeNull();
    expect(appendRunActivity(t.db, new Date(5_000), run.id, [])).toBeNull();
    t.close();
  });
```

Add to `apps/orchestrator/test/planner.test.ts` (new test; add imports: `EventBus` from `'../src/events/bus.ts'`, `WorkflowService` from `'../src/workflow/service.ts'`, `OpenCodeRuntime` type from `'../src/agents/runtime.ts'`, `PlannerAgent` from `'../src/agents/planner.ts'`, `readOutbox` from `'./helpers/outbox.ts'` — follow the file's existing import style):

```ts
  test('planner forwards onActivity to the run.activity outbox with redaction', async () => {
    const t = createTestDb();
    const project = seedProject(t.db, { key: 'INV' });
    const story = seedStory(t.db, project.id, { key: 'INV-9' });
    const runtime = {
      runOneShot: async (input: { onActivity?: (e: { kind: string; name: string; summary?: string }[]) => void }) => {
        input.onActivity?.([{ kind: 'tool-start', name: 'read', summary: 'file-with-hunter2' }]);
        return { ok: false, error: 'boom' };
      },
      interrupt: async () => true,
    } as unknown as OpenCodeRuntime;
    const planner = new PlannerAgent({
      db: t.db,
      workflow: new WorkflowService({ db: t.db, bus: new EventBus() }),
      bus: new EventBus(),
      runtime,
      redact: (s) => s.replace(/hunter2/g, '[red]'),
    });
    const res = await planner.planStory({ storyId: story.id });
    expect(res.ok).toBe(false);
    const row = readOutbox(t.db).find((r) => r.topic === 'run.activity');
    expect(row?.data).toMatchObject({ role: 'planner', storyKey: 'INV-9', projectKey: 'INV' });
    expect(JSON.stringify(row?.data)).toContain('file-with-[red]');
    t.close();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/orchestrator/test/run-events.test.ts apps/orchestrator/test/planner.test.ts`
Expected: FAIL — `appendRunActivity` is not exported; the planner test finds no `run.activity` row.

- [ ] **Step 3: Implement**

1. `packages/contracts/src/events.ts` — add the topic to `EVENT_TOPICS`:

```ts
export const EVENT_TOPICS = [
  'story.transitioned', 'story.updated', 'run.started', 'run.output', 'run.finished', 'run.activity', 'check.started', 'check.finished',
  'review.completed', 'pr.updated', 'provider.quota', 'github.connection', 'system.health', 'system.resync',
] as const;
```

2. `apps/orchestrator/src/agents/run-events.ts` — add imports (`outboxEvents` from `'@aik/db'`, `and, eq, sql` from `'drizzle-orm'`, `type RunActivityEvent` from `'./run-activity.ts'`) and:

```ts
/** Max `run.activity` rows per run (spec 2026-11-04-office-agent-activity); drops silently after. */
export const RUN_ACTIVITY_ROW_CAP = 300;

/** One outbox row per activity batch: `{runId, role, storyKey, projectKey, events}`; summaries redacted. Null = no-op. */
export function appendRunActivity(
  db: AikDbOrTx,
  now: Date,
  runId: number,
  events: RunActivityEvent[],
  redact: (text: string) => string = (s) => s,
  rowCap: number = RUN_ACTIVITY_ROW_CAP,
): number | null {
  if (events.length === 0) return null;
  const info = runEventInfo(db, runId);
  if (!info) return null;
  const count = db
    .select({ n: sql<number>`count(*)` })
    .from(outboxEvents)
    .where(and(eq(outboxEvents.topic, 'run.activity'), sql`json_extract(${outboxEvents.payload}, '$.data.runId') = ${runId}`))
    .get();
  if ((count?.n ?? 0) >= rowCap) return null;
  return appendOutbox(
    db,
    {
      topic: 'run.activity',
      storyId: info.storyId,
      provenance: 'system',
      data: {
        runId: info.runId,
        role: info.role,
        storyKey: info.storyKey,
        projectKey: info.projectKey,
        events: events.map((e) => ({ kind: e.kind, name: e.name, ...(e.summary !== undefined ? { summary: redact(e.summary) } : {}) })),
      },
    },
    now,
  );
}
```

3. `apps/orchestrator/src/agents/planner.ts` — add `redact?: (text: string) => string;` to `PlannerAgentDeps`, store `private readonly redact: (text: string) => string;` initialized `deps.redact ?? ((s) => s)`. Add `appendRunActivity` to the existing `run-events.ts` import. In the `runOneShot` call input (after `onSessionCreated`), add:

```ts
        onActivity: (events) => {
          const seq = appendRunActivity(this.db, new Date(this.now()), run.id, events, this.redact);
          if (seq !== null) this.bus.notify(seq);
        },
```

4. Repeat step 3 verbatim in `apps/orchestrator/src/agents/implementer.ts` and `apps/orchestrator/src/agents/reviewer.ts` (each already has `run.id` in scope at its `runOneShot` call — implementer.ts ~line 115ff, reviewer.ts ~line 213ff; deps type + private field + import + `onActivity`).

5. `apps/orchestrator/src/app.ts` — add `redact: redactor.redact` to the three agent constructions (lines ~234-236):

```ts
  const planner = new PlannerAgent({ db, workflow, bus, runtime, interrupts, skills, redact: redactor.redact });
  const implementer = new ImplementerAgent({ db, workflow, bus, runtime, worktreeManager, interrupts, skills, redact: redactor.redact });
  const reviewer = new ReviewerAgent({ db, workflow, bus, runtime, worktreeManager, interrupts, skills, redact: redactor.redact });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/orchestrator/test/run-events.test.ts apps/orchestrator/test/planner.test.ts apps/orchestrator/test/implementer.test.ts apps/orchestrator/test/reviewer.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/events.ts apps/orchestrator/src/agents/run-events.ts apps/orchestrator/src/agents/planner.ts apps/orchestrator/src/agents/implementer.ts apps/orchestrator/src/agents/reviewer.ts apps/orchestrator/src/app.ts apps/orchestrator/test/run-events.test.ts apps/orchestrator/test/planner.test.ts
git commit -m "feat(orchestrator): agents emit redacted run.activity outbox rows"
```

---

### Task 3: Bridge translation (`run.activity` → hook posts)

**Files:**
- Modify: `apps/orchestrator/src/office/bridge.ts` (new `hookEventsForRunActivity` + `drain()` filter, lines ~204-218)
- Test: `apps/orchestrator/test/office-bridge.test.ts`

**Interfaces:**
- Consumes: `run.activity` outbox rows from Task 2; existing `HookEvent`, `toRunEventData`, `sessionIdOf`, queue/post machinery.
- Produces: `export function hookEventsForRunActivity(data: unknown): HookEvent[]` — tool-start → `PreToolUse` with mapped Claude-style `tool_name` and `tool_input` (`{file_path: summary}` for file tools, `{command: summary}` for bash, `{}` otherwise); tool-end → `PostToolUse`; unknown shapes skipped.

- [ ] **Step 1: Write the failing tests**

Add to `apps/orchestrator/test/office-bridge.test.ts` (follow the file's existing import of pure helpers — it imports `hookEventsForRunStarted`/`hookEventsForRunFinished` from `'../src/office/bridge.ts'`):

```ts
describe('hookEventsForRunActivity', () => {
  const base = { runId: 7, role: 'implementer', storyKey: 'INV-7', projectKey: 'INV' };

  test('maps tool events to Claude-shaped PreToolUse/PostToolUse', () => {
    const events = hookEventsForRunActivity({
      ...base,
      events: [
        { kind: 'tool-start', name: 'read', summary: 'foo.ts' },
        { kind: 'tool-start', name: 'bash', summary: 'npm test' },
        { kind: 'tool-start', name: 'Thinking' },
        { kind: 'tool-end', name: 'bash' },
      ],
    });
    expect(events).toEqual([
      { session_id: 'aik-run-7', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'foo.ts' } },
      { session_id: 'aik-run-7', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } },
      { session_id: 'aik-run-7', hook_event_name: 'PreToolUse', tool_name: 'Thinking', tool_input: {} },
      { session_id: 'aik-run-7', hook_event_name: 'PostToolUse' },
    ]);
  });

  test('unknown tools capitalize; garbage is skipped; bad base data yields nothing', () => {
    expect(hookEventsForRunActivity({ ...base, events: [{ kind: 'tool-start', name: 'webfetch' }] })).toEqual([
      { session_id: 'aik-run-7', hook_event_name: 'PreToolUse', tool_name: 'Webfetch', tool_input: {} },
    ]);
    expect(hookEventsForRunActivity({ ...base, events: [{ kind: 'tool-start' }, 'junk', { kind: 'wat', name: 'x' }] })).toEqual([]);
    expect(hookEventsForRunActivity({ events: 'nope' })).toEqual([]);
    expect(hookEventsForRunActivity({ runId: 'x' })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/orchestrator/test/office-bridge.test.ts`
Expected: FAIL — `hookEventsForRunActivity` is not exported.

- [ ] **Step 3: Implement**

In `apps/orchestrator/src/office/bridge.ts`, after `hookEventsForRunFinished`:

```ts
/** pixel-agents' formatToolStatus renders Read/Edit/Write/Bash/Grep/Glob specially; map ours. */
const TOOL_NAME_MAP: Record<string, string> = { read: 'Read', edit: 'Edit', write: 'Write', bash: 'Bash', grep: 'Grep', glob: 'Glob' };

/** Live bubbles (spec 2026-11-04-office-agent-activity): tool-start → PreToolUse, tool-end → PostToolUse. */
export function hookEventsForRunActivity(data: unknown): HookEvent[] {
  const d = toRunEventData(data);
  if (!d || typeof data !== 'object' || data === null) return [];
  const rawEvents = (data as { events?: unknown }).events;
  if (!Array.isArray(rawEvents)) return [];
  const out: HookEvent[] = [];
  for (const raw of rawEvents) {
    if (typeof raw !== 'object' || raw === null) continue;
    const ev = raw as { kind?: unknown; name?: unknown; summary?: unknown };
    if (typeof ev.name !== 'string' || ev.name === '') continue;
    if (ev.kind === 'tool-start') {
      const mapped = TOOL_NAME_MAP[ev.name] ?? ev.name.charAt(0).toUpperCase() + ev.name.slice(1);
      const summary = typeof ev.summary === 'string' && ev.summary !== '' ? ev.summary : undefined;
      const toolInput = summary === undefined ? {} : ev.name === 'bash' ? { command: summary } : { file_path: summary };
      out.push({ session_id: sessionIdOf(d.runId), hook_event_name: 'PreToolUse', tool_name: mapped, tool_input: toolInput });
    } else if (ev.kind === 'tool-end') {
      out.push({ session_id: sessionIdOf(d.runId), hook_event_name: 'PostToolUse' });
    }
  }
  return out;
}
```

In `drain()`, replace the topic dispatch (lines ~210-213) with:

```ts
        if (env.topic === 'run.started' || env.topic === 'run.finished' || env.topic === 'run.activity') {
          const events =
            env.topic === 'run.started'
              ? hookEventsForRunStarted(env.data)
              : env.topic === 'run.finished'
                ? hookEventsForRunFinished(env.data)
                : hookEventsForRunActivity(env.data);
          for (const event of events) await this.deliver(event);
        }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/orchestrator/test/office-bridge.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/src/office/bridge.ts apps/orchestrator/test/office-bridge.test.ts
git commit -m "feat(orchestrator): pixel agents bridge translates run.activity to tool hooks"
```

---

### Task 4: Story-by-key API

**Files:**
- Modify: `apps/orchestrator/src/stories/service.ts` (add `getByKey` next to `get`, line ~101)
- Modify: `apps/orchestrator/src/api/routes/stories.ts` (new route after `/stories/:id`, line ~12)
- Test: `apps/orchestrator/test/stories.test.ts`

**Interfaces:**
- Consumes: existing `getStoryRow`, `toStoryDTO`, `ApiHttpError`.
- Produces: `StoryService.getByKey(key: string): StoryDTO` (404 `ApiHttpError` when unknown); HTTP `GET /stories/key/:key` → `StoryDTO`.

- [ ] **Step 1: Write the failing test**

Add to `apps/orchestrator/test/stories.test.ts` (reuse the file's existing project/story seeding helpers; follow its import of the service):

```ts
  test('getByKey resolves a story across projects and 404s unknown keys', () => {
    const t = createTestDb();
    const project = seedProject(t.db, { key: 'INV' });
    const story = seedStory(t.db, project.id, { key: 'INV-4' });
    const stories = new StoryService({ db: t.db, workflow: new WorkflowService({ db: t.db, bus: new EventBus() }), bus: new EventBus() });
    expect(stories.getByKey('INV-4').id).toBe(story.id);
    expect(() => stories.getByKey('NOPE-1')).toThrow(/not found/i);
    t.close();
  });
```

(Adjust to the file's actual helper names/imports if they differ — the file already tests `get`/`list` with the same setup.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/orchestrator/test/stories.test.ts`
Expected: FAIL — `stories.getByKey is not a function`.

- [ ] **Step 3: Implement**

In `apps/orchestrator/src/stories/service.ts`, after the `get(id)` method:

```ts
  /** Global key lookup (office click-through, spec 2026-11-04-office-agent-activity). Keys embed the project key, so they are unique across projects. */
  getByKey(key: string): StoryDTO {
    const row = this.db.select().from(userStories).where(eq(userStories.key, key)).get();
    if (!row) throw new ApiHttpError(404, 'NOT_FOUND', `Story ${key} not found`);
    return toStoryDTO(this.db, row);
  }
```

In `apps/orchestrator/src/api/routes/stories.ts`, add after the `app.get('/stories/:id', ...)` line (and `z` to the existing contracts import if missing):

```ts
  const KeyParams = z.object({ key: z.string().min(1).max(100) });
  app.get('/stories/key/:key', async (req) => deps.stories.getByKey(parse(KeyParams, req.params).key));
```

(`parse` is already imported from `'../idempotency.ts'`; `z` comes from `zod` — check the file's existing imports and add `import { z } from 'zod';` if absent.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/orchestrator/test/stories.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/src/stories/service.ts apps/orchestrator/src/api/routes/stories.ts apps/orchestrator/test/stories.test.ts
git commit -m "feat(orchestrator): GET /stories/key/:key resolves a story by its global key"
```

---

### Task 5: UI click plumbing (label → modal)

**Files:**
- Modify: `packages/contracts/src/bridge.ts` (`office` gains `onAgentClick`, line ~71-76)
- Modify: `apps/desktop/src/preload/index.ts` (implement `onAgentClick`)
- Modify: `apps/ui/src/lib/office.ts` (add `parseOfficeLabel`)
- Modify: `apps/ui/src/router.tsx` (boardRoute `validateSearch`)
- Modify: `apps/ui/src/routes/board.tsx` (read `terminal` search, pass to Board)
- Modify: `apps/ui/src/components/kanban/board.tsx` (`focusStoryId` prop opens the modal)
- Modify: `apps/ui/src/routes/office.tsx` (subscribe + navigate)
- Test: `apps/ui/test/office.test.ts`

**Interfaces:**
- Consumes: `GET /stories/key/:key` (Task 4); existing `TerminalModal`, `window.api.request`.
- Produces:
  - `AikWindowApi.office.onAgentClick(listener: (label: string) => void): () => void` (main sends `aik:office-agent-click`; wired in Task 6 — until then the listener simply never fires, which is safe).
  - `parseOfficeLabel(label: string): { storyKey: string; role: string } | null`.
  - Board URL contract: `#/projects/<id>?terminal=<storyId>` opens the Terminal modal.

- [ ] **Step 1: Write the failing test**

Add to `apps/ui/test/office.test.ts` (add `parseOfficeLabel` to the existing import from `'../src/lib/office.ts'`):

```ts
describe('parseOfficeLabel', () => {
  test('splits the office character label into storyKey + role', () => {
    expect(parseOfficeLabel('INV-7 planner')).toEqual({ storyKey: 'INV-7', role: 'planner' });
    expect(parseOfficeLabel('WT-12 implementer')).toEqual({ storyKey: 'WT-12', role: 'implementer' });
  });

  test('rejects labels without a space or with an empty part', () => {
    expect(parseOfficeLabel('INV-7')).toBeNull();
    expect(parseOfficeLabel('planner ')).toBeNull();
    expect(parseOfficeLabel('')).toBeNull();
    expect(parseOfficeLabel('INV-7 ')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/ui/test/office.test.ts`
Expected: FAIL — `parseOfficeLabel` is not exported.

- [ ] **Step 3: Implement the label parser**

Append to `apps/ui/src/lib/office.ts`:

```ts
/** Office character labels are exactly `${storyKey} ${role}` (we generate the cwd); the last space separates them. */
export function parseOfficeLabel(label: string): { storyKey: string; role: string } | null {
  const trimmed = label.trim();
  const idx = trimmed.lastIndexOf(' ');
  if (idx <= 0 || idx === trimmed.length - 1) return null;
  return { storyKey: trimmed.slice(0, idx), role: trimmed.slice(idx + 1) };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/ui/test/office.test.ts`
Expected: PASS.

- [ ] **Step 5: Contracts + app preload**

In `packages/contracts/src/bridge.ts`, extend the `office` block of `AikWindowApi`:

```ts
  office: {
    /** Tell main whether the office view should be visible (office route active + feature on). */
    setVisible(visible: boolean): void;
    /** Report the office container's viewport bounds (CSS px == DIP at zoom 1) so main can position the embedded view. */
    setBounds(bounds: OfficeBounds): void;
    /** Fired when the user clicks a character in the embedded office (label = `${storyKey} ${role}`). */
    onAgentClick(listener: (label: string) => void): () => void;
  };
```

In `apps/desktop/src/preload/index.ts`, extend the `office` object:

```ts
  office: {
    setVisible: (visible) => ipcRenderer.send('aik:office-visible', visible),
    setBounds: (bounds) => ipcRenderer.send('aik:office-bounds', bounds),
    onAgentClick: (listener) => {
      const handler = (_e: IpcRendererEvent, label: string) => listener(label);
      ipcRenderer.on('aik:office-agent-click', handler);
      return () => {
        ipcRenderer.removeListener('aik:office-agent-click', handler);
      };
    },
  },
```

- [ ] **Step 6: Board opens the modal from `?terminal=`**

1. `apps/ui/src/router.tsx` — the board route gains search validation:

```tsx
const boardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$projectId',
  component: BoardPage,
  validateSearch: (search: Record<string, unknown>): { terminal?: string } =>
    typeof search.terminal === 'string' && search.terminal !== '' ? { terminal: search.terminal } : {},
});
```

2. `apps/ui/src/routes/board.tsx` — add `useSearch` to the router import and pass the param down (replace the `<Board ...>` render line):

```tsx
import { Link, useParams, useSearch } from '@tanstack/react-router';
// inside BoardPage:
  const search = useSearch({ from: '/projects/$projectId' });
  const focusStoryId = search.terminal ? Number(search.terminal) : undefined;
// render:
        <Board stories={stories} onChanged={refetch} focusStoryId={focusStoryId} />
```

3. `apps/ui/src/components/kanban/board.tsx` — accept and consume the prop:

```tsx
export function Board({
  stories,
  onChanged,
  focusStoryId,
}: {
  stories: StoryDTO[];
  onChanged: () => Promise<void>;
  /** Story to open the Terminal modal for (office click-through navigates with ?terminal=). */
  focusStoryId?: number;
}) {
```

and inside, after the existing `const [terminalStory, setTerminalStory] = ...` state:

```tsx
  useEffect(() => {
    if (focusStoryId === undefined) return;
    const story = stories.find((s) => s.id === focusStoryId);
    if (story) setTerminalStory(story);
  }, [focusStoryId, stories]);
```

- [ ] **Step 7: The office route subscribes and navigates**

In `apps/ui/src/routes/office.tsx` — add `useNavigate` to the router import, `parseOfficeLabel` to the office-lib import, and a new effect after the existing visibility effect:

```tsx
  const navigate = useNavigate();
  useEffect(() => {
    if (!enabled) return;
    return window.api.office.onAgentClick((label) => {
      const parsed = parseOfficeLabel(label);
      if (!parsed) return;
      void window.api.request('GET', `/stories/key/${encodeURIComponent(parsed.storyKey)}`).then((res) => {
        if (res.status !== 200) return;
        const story = res.body as { id: number; projectId: number } | null;
        if (!story || typeof story.id !== 'number' || typeof story.projectId !== 'number') return;
        void navigate({
          to: '/projects/$projectId',
          params: { projectId: String(story.projectId) },
          search: { terminal: String(story.id) },
        });
      });
    });
  }, [enabled, navigate]);
```

- [ ] **Step 8: Typecheck + tests**

Run: `npm run typecheck && npx vitest run apps/ui/test/office.test.ts`
Expected: both PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/contracts/src/bridge.ts apps/desktop/src/preload/index.ts apps/ui/src/lib/office.ts apps/ui/src/router.tsx apps/ui/src/routes/board.tsx apps/ui/src/components/kanban/board.tsx apps/ui/src/routes/office.tsx apps/ui/test/office.test.ts
git commit -m "feat(ui): office character click opens the story terminal modal"
```

---

### Task 6: Office click preload + IPC + build + docs

> **Post-review amendment (CDP):** the mechanism specified below — an isolated-world
> preload patching `window.WebSocket` — was found **functionally inert in review**:
> under contextIsolation the preload cannot see the page's WebSocket constructor, so
> no frame was ever observed. Task 6 was reworked (see
> `.superpowers/sdd/task-6-report.md`): `office-preload.ts` is deleted and nothing is
> injected into the pixel-agents page. Instead the main process attaches the office
> view's `webContents.debugger`, enables `Network`, and passively observes
> `Network.webSocketFrameSent`/`FrameReceived`; frames are parsed by the pure,
> unit-tested `apps/desktop/src/main/office-click-frames.ts` (label map from
> agentCreated/existingAgents/agentClosed; focusAgent resolves the clicked label);
> parsed clicks route in-process through `OfficeViewManager`'s `clickHandler`, and
> `acceptAgentClick` stays only as a harmless, still-guarded IPC entry point. The
> build line for `office-preload.cjs` and the packaging guard were updated
> accordingly. The steps below are the original (rejected) preload variant, kept for
> history — do not re-implement them.

**Files:**
- Create: `apps/desktop/src/main/office-preload.ts`
- Modify: `apps/desktop/src/main/office-view.ts` (preload attach + `acceptAgentClick` + `onClick`)
- Modify: `apps/desktop/src/main/index.ts` (forward clicks to the window, line ~150)
- Modify: `apps/desktop/scripts/build.mjs` (bundle office-preload, after line 15)
- Test: `apps/desktop/test/pixel-agents-packaging.test.ts` (extend)
- Modify: `README.md` (office section)

**Interfaces:**
- Consumes: `AikWindowApi.office.onAgentClick` channel `aik:office-agent-click` (Task 5).
- Produces: the click observation wire (preload → `OfficeViewManager.acceptAgentClick(senderId, label)` → registered handler → `win.webContents.send('aik:office-agent-click', label)`); `dist/office-preload.cjs` in every build.

- [ ] **Step 1: Write the failing packaging/build guard test**

Add to `apps/desktop/test/pixel-agents-packaging.test.ts` (it already reads files with `new URL(...)`):

```ts
  test('the office view runs the click-observer preload and only trusts its own webContents', () => {
    const view = fs.readFileSync(new URL('../src/main/office-view.ts', import.meta.url), 'utf8');
    const build = fs.readFileSync(new URL('../scripts/build.mjs', import.meta.url), 'utf8');
    const preload = fs.readFileSync(new URL('../src/main/office-preload.ts', import.meta.url), 'utf8');
    // The view attaches the preload and gates click IPC on the exact webContents id…
    expect(view).toContain('office-preload.cjs');
    expect(view).toContain('acceptAgentClick');
    // …the build ships it next to preload.cjs…
    expect(build).toContain('office-preload.ts');
    // …and the preload only observes WebSocket frames and sends one string channel.
    expect(preload).toContain('aik:office-agent-click');
    expect(preload).toContain('focusAgent');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/desktop/test/pixel-agents-packaging.test.ts`
Expected: FAIL — `office-preload.ts` does not exist (`ENOENT`).

- [ ] **Step 3: Implement the office preload**

Create `apps/desktop/src/main/office-preload.ts`:

```ts
// apps/desktop/src/main/office-preload.ts — click observer for the embedded pixel-agents
// office (spec 2026-11-04-office-agent-activity, security amendment). Their SPA sends
// {type:'focusAgent', id} over its WebSocket when a character is clicked and learns
// id→directoryName from agentCreated/existingAgents broadcasts. This preload only
// OBSERVES those frames (pass-through) and sends one string — the character label —
// on one IPC channel. Sandbox + contextIsolation stay on; no other page API is touched.
import { ipcRenderer } from 'electron';

const labels = new Map<number, string>();

const note = (id: unknown, name: unknown): void => {
  if (typeof id === 'number' && typeof name === 'string' && name !== '') labels.set(id, name);
};

const onFrame = (raw: unknown): void => {
  try {
    const msg = JSON.parse(typeof raw === 'string' ? raw : String(raw)) as Record<string, unknown>;
    if (msg.type === 'agentCreated') {
      note(msg.id, msg.directoryName);
    } else if (msg.type === 'agentClosed' && typeof msg.id === 'number') {
      labels.delete(msg.id);
    } else if (msg.type === 'existingAgents' && typeof msg.directoryNames === 'object' && msg.directoryNames !== null) {
      for (const [id, name] of Object.entries(msg.directoryNames as Record<string, string>)) note(Number(id), name);
    } else if (msg.type === 'focusAgent' && typeof msg.id === 'number') {
      const label = labels.get(msg.id);
      if (label !== undefined) ipcRenderer.send('aik:office-agent-click', label);
    }
  } catch {
    // never break the page on a non-JSON frame
  }
};

const OriginalWebSocket = window.WebSocket;
class ObservedWebSocket extends OriginalWebSocket {
  constructor(url: URL | string, protocols?: string | string[]) {
    super(url, protocols);
    this.addEventListener('message', (event: MessageEvent) => onFrame((event as MessageEvent).data));
  }
  send(data: string): void {
    onFrame(data);
    super.send(data);
  }
}
window.WebSocket = ObservedWebSocket as unknown as typeof WebSocket;
```

- [ ] **Step 4: Attach it and gate the click IPC**

In `apps/desktop/src/main/office-view.ts`:

1. Add `path` to the node imports (`import path from 'node:path';`).
2. In `ensureView()`'s view construction, add the preload:

```ts
      this.view = new WebContentsView({
        webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'office-preload.cjs') },
      });
```

3. Add to `OfficeViewManager` (fields + methods):

```ts
  private clickHandler: ((label: string) => void) | null = null;

  /** The window forwards office click IPC here; only the office view's own webContents may use it. */
  acceptAgentClick(senderWebContentsId: number, label: unknown): void {
    if (!this.view || this.view.webContents.isDestroyed()) return;
    if (senderWebContentsId !== this.view.webContents.id) return; // exact match, no URL heuristics
    if (typeof label !== 'string' || label === '' || label.length > 200) return;
    this.clickHandler?.(label);
  }

  /** Register the UI-side click consumer (label = `${storyKey} ${role}`). */
  onClick(handler: (label: string) => void): void {
    this.clickHandler = handler;
  }
```

4. In `registerOfficeIpc`, add the guarded listener:

```ts
  ipcMain.on('aik:office-agent-click', (event, label: unknown) => {
    deps.manager.acceptAgentClick(event.sender.id, label);
  });
```

- [ ] **Step 5: Wire the window forward + build entry**

In `apps/desktop/src/main/index.ts`, after `registerOfficeIpc({ ... })` (line ~151-154), add:

```ts
    officeManager.onClick((label) => sendToWindow('aik:office-agent-click', label));
```

In `apps/desktop/scripts/build.mjs`, after the existing preload build line (line 15), add:

```js
await build({ ...common, entryPoints: [path.join(root, 'apps/desktop/src/main/office-preload.ts')], outfile: path.join(out, 'office-preload.cjs'), external: ['electron'], sourcemap: false });
```

- [ ] **Step 6: Run the packaging test**

Run: `npx vitest run apps/desktop/test/pixel-agents-packaging.test.ts`
Expected: PASS (all, including the new guard).

- [ ] **Step 7: README**

In `README.md`, extend the office bullet (the section mentioning "animated pixel-art character") with:

```markdown
- Click a character to open that story's "Terminal Logs & Thoughts" view (live reasoning,
  tool calls and output); while a run is in flight the character's bubble shows the agent's
  real activity (`Reading foo.ts`, `Running: npm test`, `Using Thinking`).
```

- [ ] **Step 8: Full gate**

Run: `npm run check:pins && npm run lint && npm run typecheck && npm test`
Expected: all green.

- [ ] **Step 9: Manual live verification (recorded gap)**

Rebuild the desktop app, enable the office, run a story, and confirm: (a) the character's bubble cycles through real tool statuses; (b) clicking the character opens the Terminal modal for that story. Optionally extend the temp-dir proof script (`%TEMP%\opencode\office-e2e-proof.cjs`) to POST a `run.activity`-shaped `PreToolUse` and watch the bubble change. Record results in the task notes — this is the spec's declared verification gap for the click path.

- [ ] **Step 10: Commit**

```bash
git add apps/desktop/src/main/office-preload.ts apps/desktop/src/main/office-view.ts apps/desktop/src/main/index.ts apps/desktop/scripts/build.mjs apps/desktop/test/pixel-agents-packaging.test.ts README.md
git commit -m "feat(desktop): observe office character clicks via sandboxed preload and forward to UI"
```
