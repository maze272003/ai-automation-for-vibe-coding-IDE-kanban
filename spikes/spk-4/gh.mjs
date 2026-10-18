// spikes/spk-4/gh.mjs — THROWAWAY helpers. Tokens live only in Windows Credential Manager (service AiKanbanSpike).
import { Entry } from '@napi-rs/keyring';

export const API_VERSION = '2026-03-10';
export const clientId = () => { const c = process.env.AIK_SPIKE_GH_CLIENT_ID; if (!c) throw new Error('set AIK_SPIKE_GH_CLIENT_ID'); return c; };
const entry = () => new Entry('AiKanbanSpike', 'github');
export const saveTokens = (t) => entry().setPassword(JSON.stringify(t));
export const loadTokens = () => { const s = entry().getPassword(); if (!s) throw new Error('no tokens stored; run device-flow.mjs'); return JSON.parse(s); };
export const deleteTokens = () => entry().deletePassword();
export const mask = (s) => (s ? `${s.slice(0, 4)}…(${s.length})` : String(s));

export async function form(url, params) {
  const res = await fetch(url, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  return { status: res.status, json: await res.json() };
}

export async function api(method, path, body) {
  const { access_token } = loadTokens();
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${access_token}`, 'x-github-api-version': API_VERSION, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, rate: { remaining: res.headers.get('x-ratelimit-remaining'), reset: res.headers.get('x-ratelimit-reset') } };
}
