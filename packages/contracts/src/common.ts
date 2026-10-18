import { z } from 'zod';

export const Sha = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, 'expected a 40- or 64-hex lowercase commit SHA');

export const ERROR_CODES = [
  'VALIDATION_FAILED', 'UNAUTHORIZED', 'FORBIDDEN_ORIGIN', 'NOT_FOUND', 'VERSION_CONFLICT',
  'GUARD_FAILED', 'IDEMPOTENCY_MISMATCH', 'RATE_LIMITED', 'DEPENDENCY_UNAVAILABLE', 'INTERNAL',
] as const;
export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const FailedGuard = z.object({ guard: z.string(), reason: z.string() });
export type FailedGuard = z.infer<typeof FailedGuard>;

export const ApiError = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    retryable: z.boolean(),
    details: z.unknown().optional(),
    failedGuards: z.array(FailedGuard).optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

export const IdempotencyKey = z.uuid();
