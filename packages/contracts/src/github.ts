import { z } from 'zod';

export const GITHUB_CONNECTION_STATUS = ['connected', 'expired', 'revoked', 'disconnected', 'error'] as const;
export type GitHubConnectionStatus = (typeof GITHUB_CONNECTION_STATUS)[number];

export const GitHubClientIdSchema = z
  .string()
  .trim()
  .min(6, 'Client ID must be at least 6 characters')
  .max(100, 'Client ID must not exceed 100 characters')
  .regex(/^[a-zA-Z0-9_.-]+$/, 'Client ID must contain only alphanumeric characters, dots, underscores, or dashes');

export const GitHubSettingsDTOSchema = z.object({
  clientId: z.string().nullable(),
});
export type GitHubSettingsDTO = z.infer<typeof GitHubSettingsDTOSchema>;

export const PatchGitHubSettingsSchema = z.object({
  clientId: GitHubClientIdSchema,
});
export type PatchGitHubSettingsRequest = z.infer<typeof PatchGitHubSettingsSchema>;

export const GitHubConnectionDTOSchema = z.object({
  id: z.number().int().positive(),
  githubUserId: z.number().int().positive(),
  login: z.string().min(1),
  appClientId: z.string().min(1),
  status: z.enum(GITHUB_CONNECTION_STATUS),
  accessExpiresAt: z.string().datetime().nullable(),
  refreshExpiresAt: z.string().datetime().nullable(),
  grantedPermissions: z.record(z.string(), z.string()).nullable(),
  lastValidatedAt: z.string().datetime().nullable(),
});
export type GitHubConnectionDTO = z.infer<typeof GitHubConnectionDTOSchema>;

export const DeviceCodeStartDTOSchema = z.object({
  userCode: z.string().min(1),
  verificationUri: z.string().url(),
  expiresIn: z.number().int().positive(),
  interval: z.number().int().positive(),
  sessionToken: z.string().min(1),
});
export type DeviceCodeStartDTO = z.infer<typeof DeviceCodeStartDTOSchema>;

export const DeviceFlowPollDTOSchema = z.object({
  status: z.enum(['pending', 'slow_down', 'complete', 'expired', 'access_denied', 'error']),
  connection: GitHubConnectionDTOSchema.optional(),
  interval: z.number().int().positive().optional(),
  error: z.string().optional(),
});
export type DeviceFlowPollDTO = z.infer<typeof DeviceFlowPollDTOSchema>;

export const GitHubRepositoryDTOSchema = z.object({
  id: z.number().int().positive(),
  githubRepoId: z.number().int().positive(),
  owner: z.string().min(1),
  name: z.string().min(1),
  fullName: z.string().min(1),
  description: z.string().nullable(),
  defaultBranch: z.string().min(1),
  visibility: z.enum(['public', 'private', 'internal']),
  permissions: z.object({
    admin: z.boolean(),
    push: z.boolean(),
    pull: z.boolean(),
  }),
  installationId: z.number().int().positive().nullable(),
  localPath: z.string().nullable(),
  linkedProjectId: z.number().int().positive().nullable(),
  lastSyncedAt: z.number().nullable(),
});
export type GitHubRepositoryDTO = z.infer<typeof GitHubRepositoryDTOSchema>;

export const GitHubInstallationDTOSchema = z.object({
  id: z.number().int().positive(),
  account: z.object({
    login: z.string().min(1),
    type: z.enum(['User', 'Organization']),
    avatarUrl: z.string().optional(),
  }),
  htmlUrl: z.string().url(),
});
export type GitHubInstallationDTO = z.infer<typeof GitHubInstallationDTOSchema>;

export const GitHubOrgNoticeDTOSchema = z.object({
  org: z.string().min(1),
  type: z.enum(['install_needed', 'sso_needed']),
  url: z.string().url(),
});
export type GitHubOrgNoticeDTO = z.infer<typeof GitHubOrgNoticeDTOSchema>;

export const ListRepositoriesResponseSchema = z.object({
  repositories: z.array(GitHubRepositoryDTOSchema),
  installations: z.array(GitHubInstallationDTOSchema),
  notices: z.array(GitHubOrgNoticeDTOSchema),
  rateLimit: z
    .object({
      remaining: z.number().int().nonnegative(),
      reset: z.number().int().nonnegative(),
    })
    .optional(),
});
export type ListRepositoriesResponse = z.infer<typeof ListRepositoriesResponseSchema>;

export const CloneRepositoryRequestSchema = z.object({
  parentDirectory: z.string().trim().min(1, 'parentDirectory is required'),
  projectKey: z.string().trim().regex(/^[A-Z0-9]{2,10}$/, 'projectKey must be 2-10 uppercase alphanumeric characters').optional(),
  projectName: z.string().trim().min(1).optional(),
});
export type CloneRepositoryRequest = z.infer<typeof CloneRepositoryRequestSchema>;

export const LinkRepositoryRequestSchema = z.object({
  localPath: z.string().trim().min(1, 'localPath is required'),
  projectKey: z.string().trim().regex(/^[A-Z0-9]{2,10}$/, 'projectKey must be 2-10 uppercase alphanumeric characters').optional(),
  projectName: z.string().trim().min(1).optional(),
});
export type LinkRepositoryRequest = z.infer<typeof LinkRepositoryRequestSchema>;

export function normalizeGitHubRemoteUrl(rawUrl: string): string | null {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  const githubRegex = /^(?:(?:https?|git|ssh):\/\/(?:[^/@\s]+@)?github\.com(?::\d+)?\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i;
  const match = trimmed.match(githubRegex);
  if (!match || !match[1] || !match[2]) return null;
  return `${match[1].toLowerCase()}/${match[2].toLowerCase()}`;
}

