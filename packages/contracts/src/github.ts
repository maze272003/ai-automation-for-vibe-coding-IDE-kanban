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
