import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { probeScanner } from '../src/security/vulnerability.ts';
import { makeTempDir, makeTempRepo } from './helpers/temp.ts';
import { buildTestApp } from './helpers/app.ts';

it('reports a missing executable', async () => {
  const scannerPath = path.join(makeTempDir(), 'missing.exe');
  expect(await probeScanner({ scannerPath })).toEqual({ found: false, path: scannerPath, version: null, error: 'not found' });
});
it('reports a script version including paths containing spaces', async () => {
  const scannerPath = path.join(makeTempDir(), process.platform === 'win32' ? 'test scanner.cmd' : 'test scanner');
  fs.writeFileSync(scannerPath, process.platform === 'win32' ? '@echo off\r\necho osv-scanner version: 1.9.0\r\n' : '#!/bin/sh\necho "osv-scanner version: 1.9.0"\n', { mode: 0o755 });
  expect(await probeScanner({ scannerPath })).toMatchObject({ found: true, version: expect.stringContaining('1.9.0'), error: null });
});
it('probes the configured scanner for a project', async () => {
  const ctx = await buildTestApp();
  try {
    const project = await ctx.services.projects.create({ key: 'SCAN', name: 'Scanner', repoPath: makeTempRepo() });
    const scannerPath = path.join(makeTempDir(), 'missing.exe');
    ctx.services.projects.patch(project.id, { settings: { ...project.settings, vulnerabilityScan: { enabled: true, threshold: 'high', scannerPath } } });
    const response = await ctx.inject('GET', `/projects/${project.id}/vulnerability-scanner`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ found: false, path: scannerPath, version: null, error: 'not found' });
    expect((await ctx.inject('GET', '/projects/999999/vulnerability-scanner')).statusCode).toBe(404);
  } finally { await ctx.app.close(); ctx.t.close(); }
});
