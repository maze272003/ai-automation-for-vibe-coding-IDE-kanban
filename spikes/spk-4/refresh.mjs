// spikes/spk-4/refresh.mjs — THROWAWAY
import { clientId, form, loadTokens, saveTokens, mask } from './gh.mjs';
const old = loadTokens();
const r = await form('https://github.com/login/oauth/access_token', { client_id: clientId(), grant_type: 'refresh_token', refresh_token: old.refresh_token });
if (r.json.error) { console.log(`refresh failed: ${r.json.error} ${r.json.error_description ?? ''}`); process.exit(1); }
saveTokens({ ...r.json, obtained_at: Date.now() });
console.log(JSON.stringify({ refreshed: true, newAccess: mask(r.json.access_token), accessChanged: r.json.access_token !== old.access_token, refreshRotated: r.json.refresh_token !== old.refresh_token }));
