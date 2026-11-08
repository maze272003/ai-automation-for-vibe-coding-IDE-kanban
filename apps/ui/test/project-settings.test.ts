import { afterEach, expect, it, vi } from 'vitest';
import { defaultProjectSettings } from '@aik/contracts';
import { api, ApiRequestError } from '../src/lib/api.ts';
import { SETTINGS_GROUPS, buildPatch, issuesByField, mergeDetectedChecks, needsChecksBanner } from '../src/lib/project-settings.ts';

afterEach(() => vi.unstubAllGlobals());
it('covers every settings leaf once and labels unenforced fields', () => {
  const paths = SETTINGS_GROUPS.flatMap((group) => group.fields.map((field) => field.path));
  const walk = (obj: object, prefix = ''): string[] => Object.entries(obj).flatMap(([key, value]) => {
    const name = prefix + key;
    return value && typeof value === 'object' && !Array.isArray(value) ? walk(value, `${name}.`) : [name];
  });
  expect(new Set(paths).size).toBe(paths.length);
  for (const path of walk(defaultProjectSettings())) expect(paths).toContain(path);
  for (const field of SETTINGS_GROUPS.flatMap((g) => g.fields)) if (!field.enforced) expect(field.note).toContain('Not enforced yet');
});
it('maps nested issues and preserves first message', () => {
  expect(issuesByField([{ path: ['settings', 'checks', 1, 'command'], message: 'Too small' }, { path: ['settings', 'checks', 1, 'command'], message: 'Second' }])).toEqual({ 'checks.1.command': 'Too small' });
  expect(issuesByField('x')).toEqual({});
  expect(issuesByField([null, {}, { path: [null], message: 'invalid' }])).toEqual({});
});
it('merges detected checks without replacing edits or retaining source', () => {
  const check = { key: 'test', command: 'custom', mandatory: true, timeoutSec: 60 };
  expect(mergeDetectedChecks([check], [{ ...check, command: 'detected', source: 'npm' }, { ...check, key: 'lint', source: 'npm' }])).toEqual([check, { ...check, key: 'lint' }]);
});
it('sends full settings and shows banner only without checks or acceptance', () => {
  const settings = defaultProjectSettings();
  expect(buildPatch(settings)).toEqual({ settings });
  expect(needsChecksBanner(settings)).toBe(true);
  expect(needsChecksBanner({ ...settings, secretsOnlyVerification: true })).toBe(false);
  expect(needsChecksBanner({ ...settings, checks: [{ key: 'test', command: 'test', mandatory: true, timeoutSec: 60 }] })).toBe(false);
});
it('preserves API validation details', async () => {
  vi.stubGlobal('window', { api: { request: vi.fn().mockResolvedValue({ status: 400, body: { error: { code: 'VALIDATION_FAILED', message: 'm', details: [1] } } }) } });
  await expect(api.get('/projects/1')).rejects.toMatchObject({ details: [1] });
  await expect(api.get('/projects/1')).rejects.toBeInstanceOf(ApiRequestError);
});
