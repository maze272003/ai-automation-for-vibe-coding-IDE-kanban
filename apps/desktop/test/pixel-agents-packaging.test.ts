// apps/desktop/test/pixel-agents-packaging.test.ts
import { PIXEL_AGENTS_PIN } from '@aik/contracts';
import fs from 'node:fs';
import { describe, expect, test } from 'vitest';

const desktopPkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  build: { extraResources: Array<{ from: string; to: string }> };
};
const assetPkg = JSON.parse(
  fs.readFileSync(new URL('../assets/pixel-agents-runtime/package.json', import.meta.url), 'utf8'),
) as { dependencies: Record<string, string> };

describe('pixel-agents runtime packaging', () => {
  test('ships the runtime as extraResources next to opencode-runtime', () => {
    const entry = desktopPkg.build.extraResources.find((e) => e.to === 'pixel-agents-runtime');
    expect(entry).toEqual({ from: 'assets/pixel-agents-runtime', to: 'pixel-agents-runtime', filter: ['**/*'] });
  });

  test('pins the exact pixel-agents version mirrored in contracts', () => {
    expect(assetPkg.dependencies['pixel-agents']).toBe(PIXEL_AGENTS_PIN);
    expect(PIXEL_AGENTS_PIN).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('has a lockfile so npm ci works offline-reproducibly', () => {
    expect(fs.existsSync(new URL('../assets/pixel-agents-runtime/package-lock.json', import.meta.url))).toBe(true);
  });

  test('the office view runs the click-observer preload and only trusts its own webContents', () => {
    const view = fs.readFileSync(new URL('../src/main/office-view.ts', import.meta.url), 'utf8');
    const build = fs.readFileSync(new URL('../scripts/build.mjs', import.meta.url), 'utf8');
    const preload = fs.readFileSync(new URL('../src/main/office-preload.ts', import.meta.url), 'utf8');
    // The view attaches the preload and gates click IPC on the exact webContents id…
    expect(view).toContain('office-preload.cjs');
    expect(view).toContain('acceptAgentClick');
    // …the build ships it next to preload.cjs…
    expect(build).toContain('office-preload.ts');
    // …and the preload only observes WebSocket frames and sends one string channel.
    expect(preload).toContain('aik:office-agent-click');
    expect(preload).toContain('focusAgent');
  });
});
