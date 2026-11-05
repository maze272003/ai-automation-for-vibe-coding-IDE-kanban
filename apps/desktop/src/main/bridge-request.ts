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

/** Cut a URL at its query or fragment delimiter. */
function withoutQueryOrHash(value: string): string {
  const cut = value.search(/[?#]/);
  return cut === -1 ? value : value.slice(0, cut);
}

/**
 * Decode percent-encoding at most twice (the bridge path itself must stay encoded for the
 * fetch); `null` means the path could not be normalised and is refused fail-closed.
 */
function decodePath(value: string): string | null {
  let current = value;
  let decoded = false;
  for (let round = 0; round < 2; round += 1) {
    if (!/%[0-9a-f]{2}/i.test(current)) {
      return !decoded && current.includes('%') ? null : current;
    }
    try {
      current = decodeURIComponent(current);
    } catch {
      return null;
    }
    decoded = true;
  }
  return current;
}

/**
 * Main-only capabilities are unreachable from the renderer bridge. Decide on the
 * normalised path so encoded/dot-segment/duplicate-slash variants cannot bypass the
 * `/events` stream denial or the direct `/diagnostics/export` archive fetch (K-10).
 */
export function isRendererPathAllowed(raw: string): boolean {
  if (raw === '') return false;

  const decoded = decodePath(withoutQueryOrHash(raw));
  if (decoded === null) return false;

  // Decoding can reveal a query/hash delimiter or Windows separators; normalise those
  // too before resolving POSIX dot segments.
  const pathPart = withoutQueryOrHash(decoded).replace(/\\/g, '/');
  const segments: string[] = [];
  for (const segment of pathPart.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  const normalized = `/${segments.join('/')}`.toLowerCase();

  if (normalized === '/events' || normalized.startsWith('/events/')) return false;
  if (normalized === '/diagnostics/export' || normalized.startsWith('/diagnostics/export/')) return false;
  return true;
}
