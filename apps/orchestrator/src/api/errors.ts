// apps/orchestrator/src/api/errors.ts
import type { ApiError, ErrorCode, FailedGuard } from '@aik/contracts';
import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

export class ApiHttpError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details?: unknown;
  readonly failedGuards?: FailedGuard[];

  constructor(statusCode: number, code: ErrorCode, message: string, extra: { retryable?: boolean; details?: unknown; failedGuards?: FailedGuard[] } = {}) {
    super(message);
    this.name = 'ApiHttpError';
    this.statusCode = statusCode;
    this.code = code;
    this.retryable = extra.retryable ?? false;
    this.details = extra.details;
    this.failedGuards = extra.failedGuards;
  }
}

export function toEnvelope(err: unknown): { status: number; body: ApiError } {
  if (err instanceof ApiHttpError) {
    const error: ApiError['error'] = { code: err.code, message: err.message, retryable: err.retryable };
    if (err.details !== undefined) error.details = err.details;
    if (err.failedGuards !== undefined) error.failedGuards = err.failedGuards;
    return { status: err.statusCode, body: { error } };
  }
  if (err instanceof ZodError) {
    return { status: 400, body: { error: { code: 'VALIDATION_FAILED', message: 'Invalid request', retryable: false, details: err.issues } } };
  }
  const status = (err as { statusCode?: number }).statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return { status, body: { error: { code: 'VALIDATION_FAILED', message: (err as Error).message, retryable: false } } };
  }
  return { status: 500, body: { error: { code: 'INTERNAL', message: 'Internal error', retryable: true } } };
}

export function installErrorHandling(app: FastifyInstance, onInternal?: (err: unknown) => void): void {
  app.setErrorHandler((err, _req, reply) => {
    const { status, body } = toEnvelope(err);
    if (status >= 500) onInternal?.(err);
    void reply.status(status).send(body);
  });
  app.setNotFoundHandler((req, reply) => {
    void reply.status(404).send({ error: { code: 'NOT_FOUND', message: `No route ${req.method} ${req.url}`, retryable: false } });
  });
}
