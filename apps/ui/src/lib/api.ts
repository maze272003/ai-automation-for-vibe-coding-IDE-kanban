import type { ApiError, FailedGuard, HttpMethod } from '@aik/contracts';

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly failedGuards: FailedGuard[];

  constructor(status: number, body: unknown) {
    const err = (body as ApiError | null)?.error;
    super(err?.message ?? `Request failed with status ${status}`);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = err?.code ?? 'INTERNAL';
    this.failedGuards = err?.failedGuards ?? [];
  }

  /** Human-readable explanation, preferring the guard reasons. */
  get reason(): string {
    return this.failedGuards.length > 0 ? this.failedGuards.map((g) => g.reason).join('; ') : this.message;
  }
}

async function call<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
  const key = method === 'GET' ? undefined : crypto.randomUUID();
  const res = await window.api.request(method, path, body, key);
  if (res.status >= 400) throw new ApiRequestError(res.status, res.body);
  return res.body as T;
}

export const api = {
  get: <T>(path: string) => call<T>('GET', path),
  post: <T>(path: string, body: unknown) => call<T>('POST', path, body),
  patch: <T>(path: string, body: unknown) => call<T>('PATCH', path, body),
};
