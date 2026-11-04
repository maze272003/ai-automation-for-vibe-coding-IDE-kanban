import type { EventEnvelope } from '@aik/contracts';
import type { AikDb } from '@aik/db';
import { readOutboxAfter } from '../../src/events/outbox.ts';

export function readOutbox(db: AikDb): EventEnvelope[] {
  return readOutboxAfter(db, 0);
}
