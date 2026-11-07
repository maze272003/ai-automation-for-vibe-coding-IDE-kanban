// apps/orchestrator/src/agents/run-events.ts
// Emits the run.started/run.finished outbox topics (spec 2026-11-04 Pixel Agents office).
// The payload carries story/project context so consumers (the office bridge) need no extra joins.
import type { Role } from '@aik/contracts';
import { agentRuns, outboxEvents, projects, userStories, type AikDbOrTx } from '@aik/db';
import { and, eq, gt, sql } from 'drizzle-orm';
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

/** Emits run.started and returns the new outbox seq (callers bound the activity-cap count to it); null when the run is unknown. */
export function emitRunStarted(db: AikDbOrTx, now: Date, runId: number): number | null {
  const info = runEventInfo(db, runId);
  if (!info) return null;
  return appendOutbox(db, {
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

/** Max characters of a redacted activity summary. */
const SUMMARY_MAX = 120;

/** Applied after redaction, so a secret straddling the boundary is redacted whole before truncating. */
export function truncateSummary(text: string): string {
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX)}…` : text;
}

function persistedActivity(event: RunActivityEvent, redact: (text: string) => string): RunActivityEvent {
  const safe = (text: string) => truncateSummary(redact(text));
  switch (event.kind) {
    case 'tool-start':
    case 'tool-end':
      return { kind: event.kind, name: safe(event.name),
        ...(event.summary !== undefined ? { summary: safe(event.summary) } : {}) };
    case 'message':
      return { kind: event.kind, text: safe(event.text) };
    case 'subagent':
      return { kind: event.kind, phase: event.phase, id: safe(event.id), name: safe(event.name),
        ...(event.ok !== undefined ? { ok: event.ok } : {}) };
    case 'usage':
      return { kind: event.kind, inputTokens: event.inputTokens, cachedInputTokens: event.cachedInputTokens,
        outputTokens: event.outputTokens, costUsd: event.costUsd };
  }
}

/** One outbox row per activity batch: `{runId, role, storyKey, projectKey, events}`; summaries redacted, then truncated.
 * `afterSeq` (the run's run.started seq) bounds the cap count to the run's own rows via the outbox PK,
 * so SQLite range-scans only what was written since the run started instead of the whole 30-day outbox. */
export function appendRunActivity(
  db: AikDbOrTx,
  now: Date,
  runId: number,
  events: RunActivityEvent[],
  redact: (text: string) => string = (s) => s,
  rowCap: number = RUN_ACTIVITY_ROW_CAP,
  afterSeq?: number,
): number | null {
  if (events.length === 0) return null;
  const info = runEventInfo(db, runId);
  if (!info) return null;
  const count = db
    .select({ n: sql<number>`count(*)` })
    .from(outboxEvents)
    .where(and(
      eq(outboxEvents.topic, 'run.activity'),
      sql`json_extract(${outboxEvents.payload}, '$.data.runId') = ${runId}`,
      ...(afterSeq !== undefined ? [gt(outboxEvents.seq, afterSeq)] : []),
    ))
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
        events: events.map((event) => persistedActivity(event, redact)),
      },
    },
    now,
  );
}
