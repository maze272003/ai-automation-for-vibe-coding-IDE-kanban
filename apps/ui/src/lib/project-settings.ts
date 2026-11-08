import type { CheckConfig, DetectedCheck, ProjectSettings } from '@aik/contracts';

export type SettingsDraft = ProjectSettings;
export interface SettingsFieldMeta { path: string; label: string; enforced: boolean; note?: string }
const field = (path: string, label: string, enforced = true, note?: string): SettingsFieldMeta => ({
  path, label, enforced, ...(note ? { note } : !enforced ? { note: 'Not enforced yet.' } : {}),
});
export const SETTINGS_GROUPS: readonly { id: 'verification' | 'automation' | 'safety' | 'github'; title: string; fields: readonly SettingsFieldMeta[] }[] = [
  { id: 'verification', title: 'Verification', fields: [
    field('checks', 'Checks'), field('secretsOnlyVerification', 'Secrets-only verification'),
    field('cleanroomVerification', 'Cleanroom verification'), field('vulnerabilityScan.enabled', 'Vulnerability scan'),
    field('vulnerabilityScan.threshold', 'Severity threshold'), field('vulnerabilityScan.scannerPath', 'Scanner path'),
    field('vulnerabilityScan.scannerSha256', 'Scanner checksum', true, 'Set together with the scanner path.'),
  ] },
  { id: 'automation', title: 'Automation', fields: [field('autoAcceptPlans', 'Automatically accept plans'), field('maxAttempts', 'Maximum attempts')] },
  { id: 'safety', title: 'Safety', fields: [
    field('protectedPaths', 'Protected paths'), field('shellAllowlist', 'Shell allowlist', false, 'Not enforced yet — agents may run any command.'),
    field('allowPaid', 'Allow paid models', false), field('allowMayTrain', 'Allow training', false), field('webfetch', 'Web fetch', false),
    field('budgets.requestsPerRun', 'Requests per run', false), field('budgets.requestsPerStory', 'Requests per story', false),
    field('budgets.inputTokensPerStory', 'Input tokens per story', false), field('jobLimits.memoryMb', 'Memory (MB)', false),
    field('jobLimits.maxProcesses', 'Maximum processes', false),
  ] },
  { id: 'github', title: 'GitHub', fields: [field('publish', 'Publish'), field('remoteMerge', 'Remote merge'), field('requireRemoteChecks', 'Require remote checks'), field('mergeMethod', 'Merge method')] },
];

export function mergeDetectedChecks(current: CheckConfig[], detected: DetectedCheck[]): CheckConfig[] {
  const result = [...current];
  const keys = new Set(current.map((check) => check.key));
  for (const check of detected) {
    if (keys.has(check.key)) continue;
    keys.add(check.key);
    result.push({ key: check.key, command: check.command, mandatory: check.mandatory, timeoutSec: check.timeoutSec });
  }
  return result;
}

export function issuesByField(details: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!Array.isArray(details)) return result;
  for (const issue of details) {
    if (!issue || !Array.isArray(issue.path) || typeof issue.message !== 'string' ||
      !issue.path.every((part: unknown) => typeof part === 'string' || typeof part === 'number')) continue;
    const parts = issue.path[0] === 'settings' ? issue.path.slice(1) : issue.path;
    const key = parts.join('.');
    if (!Object.hasOwn(result, key)) Object.defineProperty(result, key, { value: issue.message, enumerable: true, configurable: true, writable: true });
  }
  return result;
}

export function buildPatch(draft: SettingsDraft): { settings: ProjectSettings } { return { settings: draft }; }
export function needsChecksBanner(settings: ProjectSettings): boolean { return settings.checks.length === 0 && !settings.secretsOnlyVerification; }
