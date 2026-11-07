// Imports a raw agent CLI capture as a recorded fixture and appends a manifest entry.
// Usage: node --experimental-strip-types scripts/import-agent-fixture.ts <raw.jsonl> <destDir> <cli> <cliVersion>
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createRedactor } from '../apps/orchestrator/src/secrets/redactor.ts';

const manifestPath = resolve(
  dirname(process.argv[1] ?? process.cwd()),
  '../apps/orchestrator/test/fixtures/agent-cli/manifest.json',
);

const HOME = '<HOME>';
const homeRaw = 'C:\\Users\\USER';
const homeFwd = 'C:/Users/USER';
const homeJsonEscaped = 'C:\\\\Users\\\\USER';
const emailRe = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const orgIdRe = /("(?:org_?id|org_u?uid|organization_?id)"\s*:\s*")[^"]*(")/gi;

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const [rawPath, destDir, cli, cliVersion] = process.argv.slice(2);
if (rawPath === undefined || destDir === undefined || cli === undefined || cliVersion === undefined) {
  fail('usage: node --experimental-strip-types scripts/import-agent-fixture.ts <raw.jsonl> <destDir> <cli> <cliVersion>');
}
if (cli !== 'claude' && cli !== 'codex') {
  fail(`cli must be "claude" or "codex" (got "${cli}")`);
}

const raw = readFileSync(rawPath);
let text: string;
if (raw[0] === 0xff && raw[1] === 0xfe) {
  text = raw.subarray(2).toString('utf16le');
} else {
  text = raw.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
}

const redactor = createRedactor();
const frames = text
  .split(/\r?\n/)
  .filter((line) => line.length > 0)
  .map((line) => {
    let out = redactor.redact(line);
    out = out.replaceAll(homeJsonEscaped, HOME).replaceAll(homeFwd, HOME).replaceAll(homeRaw, HOME);
    out = out.replace(emailRe, '[email]');
    out = out.replace(orgIdRe, '$1<ORG-ID>$2');
    return out;
  });

const scenario = basename(rawPath).replace(/\.[^.]+$/, '');
const destPath = join(destDir, `${scenario}.jsonl`);
mkdirSync(dirname(destPath), { recursive: true });
writeFileSync(destPath, frames.length > 0 ? `${frames.join('\n')}\n` : '', 'utf8');

let manifest: Record<string, unknown> = {};
if (existsSync(manifestPath)) {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
}
manifest[`${cli}-${cliVersion}/${scenario}`] = {
  file: `${scenario}.jsonl`,
  cli,
  cliVersion,
  provenance: 'recorded',
  sha256: 'PENDING-CHECKRUNNER',
  capturedAt: statSync(rawPath).mtime.toISOString(),
};
mkdirSync(dirname(manifestPath), { recursive: true });
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(`[import-agent-fixture] ${cli}-${cliVersion}/${scenario} -> ${destPath} (sha256 PENDING-CHECKRUNNER)`);
