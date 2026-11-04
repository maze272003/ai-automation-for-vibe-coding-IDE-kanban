// apps/orchestrator/src/agents/run-events.ts
// Emits the run.started/run.finished outbox topics (spec 2026-11-04 Pixel Agents office).
// The payload carries story/project context so consumers (the office bridge) need no extra joins.
import type { Role } from '@aik/contracts';
import { agentRuns, outboxEvents, projects, userStories, type AikDbOrTx } from '@aik/db';
import { and, eq, sql } from 'drizzle-orm';
import { appendOutbox } from '../events/outbox.ts';
import type { RunActivityEvent } from './run-activity.ts';

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
