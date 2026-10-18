// spikes/spk-4/merge-guard.mjs — THROWAWAY: PR from the pushed branch; stale sha → 409; current sha → merged.
import fs from 'node:fs';
import path from 'node:path';
import { api } from './gh.mjs';

const repo = process.env.AIK_SPIKE_REPO;
if (!repo?.endsWith('/aik-spike-scratch')) throw new Error('AIK_SPIKE_REPO must be <owner>/aik-spike-scratch');
const branch = fs.readFileSync(path.join(import.meta.dirname, 'last-branch.txt'), 'utf8').trim();
const pr = await api('POST', `/repos/${repo}/pulls`, { title: `spike ${branch}`, head: branch, base: 'main', body: 'SPK-4 scratch PR' });
if (pr.status !== 201) throw new Error(`PR create failed ${pr.status}: ${JSON.stringify(pr.json)}`);
const headSha = pr.json.head.sha;
const stale = '0'.repeat(40);
const r1 = await api('PUT', `/repos/${repo}/pulls/${pr.json.number}/merge`, { sha: stale, merge_method: 'merge' });
const r2 = await api('PUT', `/repos/${repo}/pulls/${pr.json.number}/merge`, { sha: headSha, merge_method: 'merge' });
console.log(JSON.stringify({ pr: pr.json.number, staleShaStatus: r1.status, staleMessage: r1.json?.message, currentShaStatus: r2.status, merged: r2.json?.merged, mergeCommitSha: r2.json?.sha }, null, 2));
