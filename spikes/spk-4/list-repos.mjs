// spikes/spk-4/list-repos.mjs — THROWAWAY
import { api } from './gh.mjs';
const inst = await api('GET', '/user/installations');
const out = [];
for (const i of inst.json.installations ?? []) {
  const repos = await api('GET', `/user/installations/${i.id}/repositories?per_page=100`);
  for (const r of repos.json.repositories ?? []) out.push({ installation: i.id, full_name: r.full_name, private: r.private, default_branch: r.default_branch, permissions: r.permissions });
}
console.log(JSON.stringify({ installations: inst.status, repos: out, rate: inst.rate }, null, 2));
