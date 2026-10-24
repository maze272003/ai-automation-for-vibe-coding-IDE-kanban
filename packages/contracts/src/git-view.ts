// packages/contracts/src/git-view.ts
import { z } from 'zod';

/** One path from `git status --porcelain`: x = index state, y = worktree state (single chars). */
export const GitFileDTO = z.object({
  path: z.string().min(1).max(2000),
  x: z.string().length(1),
  y: z.string().length(1),
});
export type GitFileDTO = z.infer<typeof GitFileDTO>;

export const GitStatusDTO = z.object({
  projectId: z.number().int(),
  branch: z.string().nullable(),
  upstream: z.string().nullable(),
  ahead: z.number().int().nullable(),
  behind: z.number().int().nullable(),
  staged: z.array(GitFileDTO),
  changes: z.array(GitFileDTO),
  /** merge/rebase markers: git mutations pause unless 'none'. */
  mergeState: z.enum(['none', 'merge', 'rebase']),
  agentBusy: z.boolean(),
  headSha: z.string().nullable(),
});
export type GitStatusDTO = z.infer<typeof GitStatusDTO>;

export const CommitDTO = z.object({
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  short: z.string().min(1).max(12),
  author: z.string().max(200),
  dateIso: z.string(),
  subject: z.string().max(400),
  parents: z.array(z.string()),
});
export type CommitDTO = z.infer<typeof CommitDTO>;

export const CommitLogDTO = z.object({ projectId: z.number().int(), commits: z.array(CommitDTO) });
export type CommitLogDTO = z.infer<typeof CommitLogDTO>;

export const CommitFileDTO = z.object({ path: z.string().min(1).max(2000), change: z.enum(['A', 'M', 'D', 'R', 'T', 'C']) });
export type CommitFileDTO = z.infer<typeof CommitFileDTO>;

export const CommitFilesDTO = z.object({ projectId: z.number().int(), sha: CommitDTO.shape.sha, files: z.array(CommitFileDTO) });
export type CommitFilesDTO = z.infer<typeof CommitFilesDTO>;

export const BranchListDTO = z.object({ projectId: z.number().int(), current: z.string().nullable(), local: z.array(z.string()), remote: z.array(z.string()) });
export type BranchListDTO = z.infer<typeof BranchListDTO>;

const PathList = z.array(z.string().min(1).max(2000)).min(1).max(500);

export const GitStageRequest = z.union([
  z.strictObject({ paths: PathList }),
  z.strictObject({ all: z.literal(true) }),
]);
export type GitStageRequest = z.infer<typeof GitStageRequest>;

/** `paths` commits those files directly (stage-then-commit); otherwise commits what is staged. */
export const GitCommitRequest = z.object({ message: z.string().trim().min(1).max(4000), paths: PathList.optional() }).strict();
export type GitCommitRequest = z.infer<typeof GitCommitRequest>;

export const GitDiscardRequest = z.object({ paths: PathList }).strict();
export type GitDiscardRequest = z.infer<typeof GitDiscardRequest>;

export const GitBranchCheckoutRequest = z.object({ name: z.string().min(1).max(200) }).strict();
export type GitBranchCheckoutRequest = z.infer<typeof GitBranchCheckoutRequest>;

export const GitBranchCreateRequest = z.object({
  name: z.string().min(1).max(200),
  // A leading dash would make git parse the start point as an option, so reject it at the route
  // (400 VALIDATION_FAILED) instead of letting a malformed `git switch -c name -evil` run.
  from: z.string().max(200).refine((s) => !s.startsWith('-'), 'Start point must not begin with a dash').optional(),
}).strict();
export type GitBranchCreateRequest = z.infer<typeof GitBranchCreateRequest>;
