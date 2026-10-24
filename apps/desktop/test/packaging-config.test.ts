// apps/desktop/test/packaging-config.test.ts
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { REQUIRED_FUSES } from '../scripts/apply-fuses.ts';

describe('REL-6 Packaging & Electron Fuses Configuration', () => {
  const pkgPath = path.resolve(import.meta.dirname, '../package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const build = pkg.build;

  test('defines valid electron-builder configuration for Windows NSIS', () => {
    expect(build).toBeDefined();
    expect(build.appId).toBe('com.aikanban.desktop');
    expect(build.productName).toBe('AI Kanban');
    expect(build.win).toBeDefined();
    expect(build.win.target).toBe('nsis');
  });

  test('enforces unprivileged per-user NSIS installation without elevation', () => {
    expect(build.nsis).toBeDefined();
    // perMachine: false ensures installer runs without UAC / admin prompts
    expect(build.nsis.perMachine).toBe(false);
    expect(build.nsis.oneClick).toBe(false);
    expect(build.nsis.allowToChangeInstallationDirectory).toBe(true);
  });

  test('preserves user application data on uninstall', () => {
    // Preserves database and project records in %LOCALAPPDATA%\AiKanban
    expect(build.nsis.deleteAppDataOnUninstall).toBe(false);
  });

  test('includes opencode runtime assets in packaged resources', () => {
    const extraResources = build.extraResources ?? [];
    const hasRuntime = extraResources.some(
      (r: { from?: string; to?: string }) => r.to === 'opencode-runtime' || r.from?.includes('opencode-runtime'),
    );
    expect(hasRuntime).toBe(true);
  });

  test('enforces hardened Electron fuses to prevent process takeover and code injection', () => {
    expect(REQUIRED_FUSES.runAsNode).toBe(false);
    expect(REQUIRED_FUSES.enableCookieEncryption).toBe(true);
    expect(REQUIRED_FUSES.enableNodeOptionsEnvironmentVariable).toBe(false);
    expect(REQUIRED_FUSES.enableNodeCliInspectArguments).toBe(false);
    expect(REQUIRED_FUSES.enableEmbeddedAsarIntegrityValidation).toBe(true);
    expect(REQUIRED_FUSES.onlyLoadAppFromAsar).toBe(true);
  });
});
