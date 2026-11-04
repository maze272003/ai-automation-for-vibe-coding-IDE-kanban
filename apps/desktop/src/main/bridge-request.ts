import { z } from 'zod';

/**
 * The renderer's request shape. The URL cap applies to the encoded URL, so it must leave room
 * for percent-encoding a 2000-character repo path (up to six bytes per non-ASCII code point).
 */
export const BridgeRequest = z.object({
  method: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']),
  path: z.string().max(16_000).regex(/^\/(?!events\b)[A-Za-z0-9/_\-.~%?=&,+:@()*'!]*$/),
  body: z.unknown().optional(),
  idempotencyKey: z.uuid().optional(),
});
export type BridgeRequest = z.infer<typeof BridgeRequest>;
