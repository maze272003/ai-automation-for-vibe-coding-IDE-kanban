import { protocol } from 'electron';
import fs from 'node:fs';
import { CSP, contentTypeFor, resolveUiFile } from './ui-path.ts';

export const APP_SCHEME = { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } };

export function registerAppProtocol(uiRoot: string): void {
  protocol.handle('app', async (request) => {
    const file = resolveUiFile(uiRoot, request.url);
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response('Not found', { status: 404 });
    return new Response(await fs.promises.readFile(file), {
      headers: { 'content-type': contentTypeFor(file), 'content-security-policy': CSP, 'x-content-type-options': 'nosniff' },
    });
  });
}
