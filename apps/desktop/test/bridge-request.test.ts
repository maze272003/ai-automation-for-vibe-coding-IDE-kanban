import { describe, expect, it } from 'vitest';
import { BridgeRequest, isRendererPathAllowed } from '../src/main/bridge-request.ts';

const request = (path: string) => ({ method: 'GET' as const, path });

describe('BridgeRequest', () => {
  it('accepts the characters URLSearchParams and encodeURIComponent leave unescaped', () => {
    for (const path of [
      '/projects/1/files/search?q=*.ts&caseSensitive=false&limit=500',
      "/projects/1/files/content?path=it's.ts",
      '/projects/1/files/content?path=hey!.ts',
      '/projects/1/files/content?path=src%2Fa%20b%23c%25.ts',
      '/projects/1/files/search?q=%C3%BC',
    ]) {
      expect(BridgeRequest.safeParse(request(path)).success, path).toBe(true);
    }
  });

  it('still rejects fragments, backslashes, controls and the events stream', () => {
    for (const path of ['/projects/1#frag', '/projects/1\\files', '/projects/1\nfiles', '/events']) {
      expect(BridgeRequest.safeParse(request(path)).success, path).toBe(false);
    }
  });

  it('allows a long encoded path but not an unbounded one', () => {
    expect(BridgeRequest.safeParse(request(`/projects/1/files/content?path=${'a'.repeat(8000)}`)).success).toBe(true);
    expect(BridgeRequest.safeParse(request(`/projects/1/files/content?path=${'a'.repeat(16_001)}`)).success).toBe(false);
  });
});

describe('isRendererPathAllowed', () => {
  it('accepts ordinary API paths including encoded query values', () => {
    for (const path of ['/projects', '/diagnostics/logs?tailBytes=65536', '/files?path=C%3A%5Crepo']) {
      expect(isRendererPathAllowed(path), path).toBe(true);
    }
  });

  it('denies the event stream and direct diagnostics export after normalisation', () => {
    for (const path of [
      '/events',
      '/x/../events',
      '/%65vents',
      '//events',
      '/events/',
      '/diagnostics/export',
      '/diagnostics/%65xport',
      '/EVENTS',
      '/a/..%2fevents',
    ]) {
      expect(isRendererPathAllowed(path), path).toBe(false);
    }
  });

  it('refuses malformed percent-encoding instead of guessing', () => {
    expect(isRendererPathAllowed('/projects/%ZZ')).toBe(false);
  });
});
