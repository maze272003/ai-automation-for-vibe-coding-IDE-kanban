// apps/desktop/test/office-settings.test.ts — Task 9: the agentOffice app setting.
// Defaults off, survives unknown fields, round-trips without losing opencodeMode.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { readAppSettings, writeAppSettings } from '../src/main/opencode-server.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aik-office-settings-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('app settings: agent office', () => {
  test('defaults to off and survives unknown fields gracefully', () => {
    expect(readAppSettings(dir)).toEqual({ opencodeMode: 'managed', agentOffice: false });
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ opencodeMode: 'personal' }));
    expect(readAppSettings(dir)).toEqual({ opencodeMode: 'personal', agentOffice: false });
  });

  test('round-trips agentOffice=true without losing opencodeMode', () => {
    writeAppSettings(dir, { opencodeMode: 'managed', agentOffice: true });
    expect(readAppSettings(dir)).toEqual({ opencodeMode: 'managed', agentOffice: true });
    writeAppSettings(dir, { opencodeMode: 'personal', agentOffice: false });
    expect(readAppSettings(dir)).toEqual({ opencodeMode: 'personal', agentOffice: false });
  });
});
