import { z } from 'zod';

export const EVENT_TOPICS = [
  'story.transitioned', 'story.updated', 'run.started', 'run.output', 'run.finished', 'check.started', 'check.finished',
  'review.completed', 'pr.updated', 'provider.quota', 'github.connection', 'system.health', 'system.resync',
] as const;
export type EventTopic = (typeof EVENT_TOPICS)[number];

export const PROVENANCE = [
  'agent_reported', 'command_completed', 'check_verified', 'review_decision', 'human_approval', 'completion', 'system',
] as const;
export type Provenance = (typeof PROVENANCE)[number];

export const EventEnvelope = z.object({
  seq: z.number().int(),
  topic: z.enum(EVENT_TOPICS),
  storyId: z.number().int().nullable(),
  at: z.number(),
  provenance: z.enum(PROVENANCE),
  data: z.unknown(),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;
