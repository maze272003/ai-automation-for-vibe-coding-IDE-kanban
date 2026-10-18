// apps/orchestrator/src/api/security.ts
import { UI_ORIGIN } from '@aik/contracts';
import type { FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import { ApiHttpError } from './errors.ts';

/** Loopback-only, DNS-rebinding-safe bearer authentication (spec §17.1, plan deviation 1 for Origin). */
export function securityHook(opts: { token: string; getPort: () => number }) {
  const expected = Buffer.from(opts.token);
  return async (req: FastifyRequest): Promise<void> => {
    const port = opts.getPort();
    const host = (req.headers.host ?? '').toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      throw new ApiHttpError(403, 'FORBIDDEN_ORIGIN', 'Host not allowed');
    }
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== UI_ORIGIN) {
      throw new ApiHttpError(403, 'FORBIDDEN_ORIGIN', 'Origin not allowed');
    }
    const auth = req.headers.authorization ?? '';
    const presented = Buffer.from(auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '');
    if (presented.length !== expected.length || !crypto.timingSafeEqual(presented, expected)) {
      throw new ApiHttpError(401, 'UNAUTHORIZED', 'Missing or invalid token');
    }
  };
}
