import { z } from 'zod';

export const CheckConfig = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
  command: z.string().min(1).max(500),
  mandatory: z.boolean(),
  timeoutSec: z.number().int().min(1).max(7200).default(900),
});
export type CheckConfig = z.infer<typeof CheckConfig>;

export const ProjectSettings = z.object({
  checks: z.array(CheckConfig).default([]),
  shellAllowlist: z.array(z.string().min(1).max(200)).default([]),
  protectedPaths: z
    .array(z.string().min(1).max(200))
    .default(['.github/workflows/**', '.opencode/**', 'opencode.json*', '.husky/**', '.gitmodules', '.gitattributes']),
  publish: z.boolean().default(false),
  remoteMerge: z.boolean().default(false),
  requireRemoteChecks: z.boolean().default(true),
  autoAcceptPlans: z.boolean().default(false),
  maxAttempts: z.number().int().min(1).max(10).default(3),
  allowPaid: z.boolean().default(false),
  allowMayTrain: z.boolean().default(false),
  webfetch: z.boolean().default(false),
  mergeMethod: z.enum(['merge', 'squash']).default('merge'),
  // Zod 4: `.prefault({})` runs the default through the schema so nested defaults apply.
  budgets: z
    .object({
      requestsPerRun: z.number().int().min(1).default(300),
      requestsPerStory: z.number().int().min(1).default(1000),
      inputTokensPerStory: z.number().int().min(1).default(3_000_000),
    })
    .prefault({}),
  jobLimits: z
    .object({
      memoryMb: z.number().int().min(256).default(4096),
      maxProcesses: z.number().int().min(4).default(64),
    })
    .prefault({}),
});
export type ProjectSettings = z.infer<typeof ProjectSettings>;
export const defaultProjectSettings = (): ProjectSettings => ProjectSettings.parse({});

export const ProjectKey = z
  .string()
  .regex(/^[A-Z][A-Z0-9]{1,9}$/, 'Project key: 2–10 uppercase letters/digits, starting with a letter');

export const ProjectDTO = z.object({
  id: z.number().int(),
  key: z.string(),
  name: z.string(),
  repoPath: z.string(),
  baseBranch: z.string(),
  remoteUrl: z.string().nullable(),
  status: z.enum(['active', 'unavailable', 'archived']),
  settings: ProjectSettings,
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ProjectDTO = z.infer<typeof ProjectDTO>;

export const CreateProjectRequest = z
  .object({
    name: z.string().trim().min(1).max(100),
    key: ProjectKey,
    repoPath: z.string().min(1).max(1000),
    baseBranch: z.string().min(1).max(200).optional(),
  })
  .strict();
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;

/** `settings` replaces the stored settings wholesale (send the full object). */
export const PatchProjectRequest = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    baseBranch: z.string().min(1).max(200).optional(),
    settings: ProjectSettings.optional(),
  })
  .strict();
export type PatchProjectRequest = z.infer<typeof PatchProjectRequest>;
