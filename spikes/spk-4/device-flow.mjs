// spikes/spk-4/device-flow.mjs — THROWAWAY
import { execFile } from 'node:child_process';
import { clientId, form, saveTokens, mask } from './gh.mjs';

const start = await form('https://github.com/login/device/code', { client_id: clientId() });
if (start.status !== 200) throw new Error(`device code request failed: ${JSON.stringify(start.json)}`);
const { device_code, user_code, verification_uri, interval, expires_in } = start.json;
console.log(`Enter code ${user_code} at ${verification_uri} (expires in ${expires_in}s)`);
execFile('cmd.exe', ['/c', 'start', '', verification_uri]);
let wait = interval;
const deadline = Date.now() + expires_in * 1000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, wait * 1000));
  const r = await form('https://github.com/login/oauth/access_token', { client_id: clientId(), device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
  const e = r.json.error;
  if (e === 'authorization_pending') continue;
  if (e === 'slow_down') { wait += 5; console.log(`slow_down → interval ${wait}s`); continue; }
  if (e) { console.log(`terminal error: ${e}`); process.exit(1); }
  saveTokens({ ...r.json, obtained_at: Date.now() });
  console.log(JSON.stringify({ token_type: r.json.token_type, expires_in: r.json.expires_in, refresh_token_expires_in: r.json.refresh_token_expires_in, access: mask(r.json.access_token), refresh: mask(r.json.refresh_token) }));
  process.exit(0);
}
console.log('expired_token (deadline passed)');
process.exit(1);
