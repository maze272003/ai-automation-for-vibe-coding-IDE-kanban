// apps/orchestrator/src/gateway/upstream.ts — pure URL and credential rewriting.
import type { AuthFlavour } from '@aik/providers';

export interface UpstreamTarget {
  baseUrl: string;
  auth: AuthFlavour;
  key: string | null;
}

export interface UpstreamCall {
  url: string;
  headers: Record<string, string>;
}

const AUTH_HEADERS = ['authorization', 'x-api-key', 'x-goog-api-key', 'api-key'];

/** The upstream URL is the provider's base URL plus the incoming path — the version prefix belongs to the base URL. */
export function buildUpstreamUrl(baseUrl: string, path: string, query: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  const qs = query ? `?${query}` : '';
  return `${base}${suffix}${qs}`;
}

export function stripAuthHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (AUTH_HEADERS.includes(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

/** The local gateway token, from whichever header the provider's AI SDK package uses. */
export function localToken(headers: Record<string, string>, query: string): string | null {
  const auth = headers.authorization;
  if (auth) return auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : auth;
  if (headers['x-api-key']) return headers['x-api-key'];
  if (headers['x-goog-api-key']) return headers['x-goog-api-key'];
  if (headers['api-key']) return headers['api-key'];
  const fromQuery = new URLSearchParams(query).get('key');
  return fromQuery ?? null;
}

export function buildUpstreamCall(
  target: UpstreamTarget,
  req: { path: string; query: string; headers: Record<string, string> },
): UpstreamCall {
  const headers = stripAuthHeaders(req.headers);
  const key = target.key;
  switch (target.auth) {
    case 'x-api-key':
      headers['x-api-key'] = key ?? '';
      break;
    case 'x-goog-api-key':
      headers['x-goog-api-key'] = key ?? '';
      break;
    case 'api-key':
      headers['api-key'] = key ?? '';
      break;
    case 'none':
      headers.authorization = 'Bearer local';
      break;
    default:
      headers.authorization = `Bearer ${key ?? ''}`;
      break;
  }
  return { url: buildUpstreamUrl(target.baseUrl, req.path, req.query), headers };
}
