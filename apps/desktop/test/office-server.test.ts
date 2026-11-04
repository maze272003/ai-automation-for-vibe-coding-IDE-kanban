// apps/desktop/test/office-server.test.ts
import { PIXEL_AGENTS_PIN } from '@aik/contracts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import {
  officeCliPath,
  officeInstalled,
  officeSpawnEnv,
  resolveNodeBinary,
  startOfficeServer,
  stopOfficeServer,
} from '../src/main/office-server.ts';

const temps: string[] = [];
const tempDir = (label: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aik-office-${label}-`));
  temps.push(dir);
  return dir;
};
afterAll(() => {
  stopOfficeServer();
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

const fixture = new URL('./fixtures/fake-pixel-agents.cjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

describe('office-server', () => {
  test('paths derive from the data dir and report install state', () => {
    const dataDir = tempDir('paths');
    expect(officeCliPath(dataDir)).toBe(
      path.join(dataDir, 'runtime', 'pixel-agents', 'node_modules', 'pixel-agents', 'dist', 'cli.js'),
    );
    expect(officeInstalled(dataDir)).toBe(false);
  });

  test('spawns the CLI, discovers port+token from the registry, verifies health', async () => {
    const registryDir = tempDir('registry');
    const info = await startOfficeServer({
      dataDir: tempDir('spawn'),
      assetsDir: tempDir('assets'),
      registryDir,
      command: fixture,
      node: process.execPath,
      spawnTimeoutMs: 10_000,
    });
    expect(info).not.toBeNull();
    expect(info!.port).toBeGreaterThan(0);
    expect(info!.url).toBe(`http://127.0.0.1:${info!.port}`);
    expect(info!.token).toBe('test-office-token-1234567890');

    const health = await fetch(`${info!.url}/api/health`);
    expect(health.ok).toBe(true);

    stopOfficeServer();
    await new Promise((r) => setTimeout(r, 200));
  }, 20_000);

  test('resolves null when the CLI never writes a registry entry', async () => {
    const never = path.join(tempDir('never'), 'no-such-cli.cjs');
    const info = await startOfficeServer({
      dataDir: tempDir('spawn2'),
      assetsDir: tempDir('assets2'),
      registryDir: tempDir('registry2'),
      command: never,
      node: process.execPath,
      spawnTimeoutMs: 500,
    });
    expect(info).toBeNull();
  }, 10_000);

  test('the pin stays exact (guards accidental range bumps)', () => {
    expect(PIXEL_AGENTS_PIN).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('the CLI child env forces Node mode for the Electron binary', () => {
    // In the Electron main process process.execPath is the Electron binary; without
    // ELECTRON_RUN_AS_NODE the spawn is a second Electron app, not the CLI (no
    // server, no registry entry, no pixel characters ever spawn).
    const env = officeSpawnEnv();
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(officeSpawnEnv(path.join(tempDir('reg'))).AIK_OFFICE_REGISTRY_DIR).toBeDefined();
    expect(officeSpawnEnv().AIK_OFFICE_REGISTRY_DIR).toBeUndefined();
  });

  test('a stop during an in-flight start never adopts the late server', async () => {
    const registryDir = tempDir('race');
    const slowFixture = new URL('./fixtures/slow-pixel-agents.cjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    const pending = startOfficeServer({
      dataDir: tempDir('race-data'),
      assetsDir: tempDir('race-assets'),
      registryDir,
      command: slowFixture,
      node: process.execPath,
      spawnTimeoutMs: 5_000,
    });
    stopOfficeServer(); // toggled off while the CLI is still starting
    const info = await pending;
    expect(info).toBeNull();
  }, 15_000);

  test('node resolution prefers a real system node and never returns a missing file', () => {
    // The install step itself needs system npm (hence node), so preferring PATH node
    // keeps the office working even under a packaged exe fused with runAsNode:false.
    const node = resolveNodeBinary();
    expect(fs.existsSync(node)).toBe(true);
    expect(path.basename(node).toLowerCase()).toMatch(/^node(\.exe)?$/);
  });
});
