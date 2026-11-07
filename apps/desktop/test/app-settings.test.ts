// apps/desktop/test/app-settings.test.ts — Task 7: office3d preferences in app settings.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_OFFICE_PREFERENCES } from '@aik/contracts';
import { afterAll, describe, expect, test } from 'vitest';
import { needsOpencodeRestart, readAppSettings, writeAppSettings } from '../src/main/opencode-server.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aik-app-settings-'));
const file = path.join(dir, 'settings.json');
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('app settings: office3d', () => {
  test('old settings file without office3d gets defaults and keeps opencodeMode', () => {
    fs.writeFileSync(file, JSON.stringify({ opencodeMode: 'personal', agentOffice: true }));
    expect(readAppSettings(dir)).toMatchObject({ opencodeMode: 'personal', office3d: DEFAULT_OFFICE_PREFERENCES });
  });
  test('legacy agentOffice field is ignored and dropped on write', () => {
    fs.writeFileSync(file, JSON.stringify({ opencodeMode: 'personal', agentOffice: true }));
    const s = readAppSettings(dir);
    expect(s).toEqual({ opencodeMode: 'personal', office3d: DEFAULT_OFFICE_PREFERENCES });
    writeAppSettings(dir, s);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).not.toHaveProperty('agentOffice');
  });
  test('missing settings file yields defaults', () => {
    expect(readAppSettings(path.join(dir, 'nope'))).toEqual({ opencodeMode: 'managed', office3d: DEFAULT_OFFICE_PREFERENCES });
  });
  test('office3d round-trips and invalid fields fall back', () => {
    writeAppSettings(dir, { ...readAppSettings(dir), office3d: { ...DEFAULT_OFFICE_PREFERENCES, quality: 'low' } });
    expect(readAppSettings(dir).office3d.quality).toBe('low');
    fs.writeFileSync(file, JSON.stringify({ opencodeMode: 'managed', office3d: { quality: 'ultra' } }));
    expect(readAppSettings(dir).office3d.quality).toBe('medium');
  });
});

describe('needsOpencodeRestart', () => {
  const base = { opencodeMode: 'managed' as const, office3d: DEFAULT_OFFICE_PREFERENCES };
  test('office3d changes never restart OpenCode; a mode change does', () => {
    expect(needsOpencodeRestart(base, { ...base, office3d: { ...DEFAULT_OFFICE_PREFERENCES, quality: 'low' } })).toBe(false);
    expect(needsOpencodeRestart(base, { ...base, opencodeMode: 'personal' })).toBe(true);
  });
});
