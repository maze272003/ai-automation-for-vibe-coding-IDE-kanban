// apps/orchestrator/src/secrets/scan.ts
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface SecretHit {
  /** Repository-relative file path, or `(diff)` for a staged diff. */
  file: string;
  pattern: string;
}

const PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/ },
  { name: 'openai-key', re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
];

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_HITS = 20;

/** Scans text and reports pattern names only; secret values never leave this function. */
export function scanText(text: string, file = '(text)'): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const { name, re } of PATTERNS) {
    if (re.test(text)) hits.push({ file, pattern: name });
    if (hits.length >= MAX_HITS) break;
  }
  return hits;
}

/** Scans the tracked files of a worktree (no paths outside it, no ignored build output). */
export function scanWorktree(cwd: string): SecretHit[] {
  const listed = execFileSync('git', ['ls-files', '-z'], { cwd, encoding: 'utf8' });
  const hits: SecretHit[] = [];
  for (const relative of listed.split('\0').filter(Boolean)) {
    if (hits.length >= MAX_HITS) break;
    const absolute = path.resolve(cwd, relative);
    if (!absolute.startsWith(path.resolve(cwd) + path.sep)) continue;
    try {
      const stat = fs.statSync(absolute);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
      const buffer = fs.readFileSync(absolute);
      if (buffer.includes(0)) continue; // binary
      hits.push(...scanText(buffer.toString('utf8'), relative));
    } catch {
      // unreadable file: skip
    }
  }
  return hits.slice(0, MAX_HITS);
}

/** Scans the staged diff before the orchestrator creates a candidate commit. */
export function scanStagedDiff(cwd: string): SecretHit[] {
  const diff = execFileSync('git', ['diff', '--cached', '--no-color'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return scanText(diff, '(staged diff)');
}

/** Fixed, redacted evidence string for a finding. */
export function describeHits(hits: SecretHit[]): string {
  return hits.map((h) => `${h.file}: potential secret (${h.pattern})`).join('; ');
}
