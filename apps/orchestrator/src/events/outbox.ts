import type { EventEnvelope, EventTopic, Provenance } from '@aik/contracts';
import { outboxEvents, type AikDbOrTx } from '@aik/db';
import { asc, gt, sql } from 'drizzle-orm';

export interface OutboxInput {
  topic: EventTopic;
  storyId: number | null;
  provenance: Provenance;
  data: unknown;
}

export function appendOutbox(db: AikDbOrTx, input: OutboxInput, now: Date): number {
  const row = db
    .insert(outboxEvents)
    .values({ topic: input.topic, storyId: input.storyId, payload: { provenance: input.provenance, data: input.data }, createdAt: now })
    .returning({ seq: outboxEvents.seq })
    .get();
  return row.seq;
}

export function readOutboxAfter(db: AikDbOrTx, afterSeq: number, limit = 500): EventEnvelope[] {
  return db
    .select()
    .from(outboxEvents)
    .where(gt(outboxEvents.seq, afterSeq))
    .orderBy(asc(outboxEvents.seq))
    .limit(limit)
    .all()
    .map((r) => ({
      seq: r.seq,
      topic: r.topic as EventTopic,
      storyId: r.storyId,
      at: r.createdAt.getTime(),
      provenance: r.payload.provenance as Provenance,
      data: r.payload.data,
    }));
}

export function outboxBounds(db: AikDbOrTx): { min: number | null; max: number | null } {
  const row = db
    .select({ min: sql<number | null>`min(${outboxEvents.seq})`, max: sql<number | null>`max(${outboxEvents.seq})` })
    .from(outboxEvents)
    .get();
  return { min: row?.min ?? null, max: row?.max ?? null };
}
