import { z } from 'zod';
import { Sha } from './common.ts';
import { BLOCKED_REASON, COMPLEXITY, PLANNING_STATUS, PRIORITY, ROLE, STORY_STATUS } from './enums.ts';

export const AcceptanceCriterionDTO = z.object({ id: z.number().int(), ordinal: z.number().int(), text: z.string() });
export type AcceptanceCriterionDTO = z.infer<typeof AcceptanceCriterionDTO>;

export const StoryDTO = z.object({
  id: z.number().int(),
  key: z.string(),
  projectId: z.number().int(),
  title: z.string(),
  description: z.string(),
  priority: z.enum(PRIORITY),
  rank: z.number().int(),
  labels: z.array(z.string()),
  complexity: z.enum(COMPLEXITY).nullable(),
  revision: z.number().int(),
  status: z.enum(STORY_STATUS),
  statusVersion: z.number().int(),
  planningStatus: z.enum(PLANNING_STATUS),
  activePlanVersion: z.number().int().nullable(),
  hold: z.boolean(),
  blocked: z
    .object({ reason: z.enum(BLOCKED_REASON), from: z.enum(STORY_STATUS).nullable(), detail: z.string(), hint: z.string() })
    .nullable(),
  attempts: z.object({ used: z.number().int(), max: z.number().int() }),
  acceptanceCriteria: z.array(AcceptanceCriterionDTO),
  dependsOn: z.array(z.string()),
  branch: z.string().nullable(),
  candidateSha: z.string().nullable(),
  activeRun: z
    .object({
      id: z.number().int(),
      role: z.enum(ROLE),
      model: z.string(),
      startedAt: z.number(),
      opencodeSessionId: z.string().nullable().optional(),
    })
    .nullable(),
  lastRun: z
    .object({
      id: z.number().int(),
      role: z.enum(ROLE),
      status: z.string(),
      exitReason: z.string().nullable().optional(),
      model: z.string(),
      startedAt: z.number(),
      endedAt: z.number().nullable().optional(),
      opencodeSessionId: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  pullRequest: z.object({ number: z.number().int(), url: z.string(), state: z.string() }).nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type StoryDTO = z.infer<typeof StoryDTO>;

const Title = z.string().trim().min(1).max(200);
const Description = z.string().max(20_000);
const Criterion = z.string().trim().min(1).max(2000);
const Label = z.string().trim().min(1).max(40);
const StoryKeyRef = z.string().regex(/^[A-Z][A-Z0-9]{1,9}-\d+$/);

export const CreateStoryRequest = z
  .object({
    title: Title,
    description: Description.default(''),
    acceptanceCriteria: z.array(Criterion).max(50).default([]),
    priority: z.enum(PRIORITY).default('P2'),
    labels: z.array(Label).max(20).default([]),
    dependsOn: z.array(StoryKeyRef).max(50).default([]),
  })
  .strict();
export type CreateStoryRequest = z.infer<typeof CreateStoryRequest>;

export const PatchStoryRequest = z
  .object({
    expectedVersion: z.number().int().min(0),
    title: Title.optional(),
    description: Description.optional(),
    acceptanceCriteria: z.array(Criterion).max(50).optional(),
    priority: z.enum(PRIORITY).optional(),
    labels: z.array(Label).max(20).optional(),
    rank: z.number().int().optional(),
    dependsOn: z.array(StoryKeyRef).max(50).optional(),
  })
  .strict();
export type PatchStoryRequest = z.infer<typeof PatchStoryRequest>;

export const STORY_SORTS = ['rank', 'priority', 'updated', 'created'] as const;
export const StoryListQuery = z.object({
  status: z.string().max(400).optional(),
  label: z.string().max(40).optional(),
  q: z.string().max(200).optional(),
  sort: z.enum(STORY_SORTS).default('rank'),
});
export type StoryListQuery = z.infer<typeof StoryListQuery>;

export const HUMAN_EVENTS = [
  'approve_plan', 'reject_plan', 'answer_clarifications', 'request_changes', 'approve_publish', 'approve_merge',
  'override_remote_review', 'recover', 'cancel', 'hold', 'unhold', 'stop_run',
] as const;
export type HumanEvent = (typeof HUMAN_EVENTS)[number];

const PlanVersion = z.number().int().min(1);
export const TransitionRequest = z
  .discriminatedUnion('event', [
    z.object({ event: z.literal('approve_plan'), planVersion: PlanVersion }),
    z.object({ event: z.literal('reject_plan'), planVersion: PlanVersion, feedback: z.string().trim().min(1).max(5000) }),
    z.object({
      event: z.literal('answer_clarifications'),
      planVersion: PlanVersion,
      answers: z.array(z.object({ ordinal: z.number().int().min(1), answer: z.string().trim().min(1).max(5000) })).min(1),
    }),
    z.object({
      event: z.literal('request_changes'),
      sha: Sha,
      findings: z.array(z.object({ text: z.string().trim().min(1).max(5000), file: z.string().max(500).optional() })).min(1),
    }),
    z.object({ event: z.literal('approve_publish'), sha: Sha }),
    z.object({ event: z.literal('approve_merge'), sha: Sha, method: z.enum(['merge', 'squash']).optional() }),
    z.object({ event: z.literal('override_remote_review'), sha: Sha, note: z.string().trim().min(1).max(2000) }),
    z.object({ event: z.literal('recover'), target: z.enum(['READY', 'NEW', 'resume']), extraAttempts: z.number().int().min(0).max(5).optional() }),
    z.object({ event: z.literal('cancel') }),
    z.object({ event: z.literal('hold') }),
    z.object({ event: z.literal('unhold') }),
    z.object({ event: z.literal('stop_run') }),
  ])
  .and(z.object({ expectedVersion: z.number().int().min(0) }));
export type TransitionRequest = z.infer<typeof TransitionRequest>;

export const RevertMergeRequest = z.object({
  expectedVersion: z.number().int().min(0),
});
export type RevertMergeRequest = z.infer<typeof RevertMergeRequest>;
