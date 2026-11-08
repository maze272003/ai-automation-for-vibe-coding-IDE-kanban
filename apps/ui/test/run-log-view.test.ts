import { describe, expect, it } from 'vitest';
import { formatCheckExit, runLogEmptyState } from '../src/lib/run-log-view.ts';

describe('run log empty states', () => {
  it.each([
    [false, false, 'No agent has run yet', 'Logs appear here once an agent starts working on this story.'],
    [false, true, 'Starting an agent…', 'Waiting for the first message.'],
    [true, true, 'Agent session started', 'Analyzing repository and preparing reasoning thoughts...'],
    [true, false, 'Agent session ended', 'No message logs recorded.'],
  ] as const)('describes hasRun=%s running=%s', (hasRun, isRunning, title, detail) => {
    expect(runLogEmptyState({ hasRun, isRunning })).toEqual({ title, detail });
  });
  it('distinguishes absent exit codes from success and failure', () => {
    expect(formatCheckExit(null)).toBe('(no exit code)');
    expect(formatCheckExit(0)).toBe('(exit 0)');
    expect(formatCheckExit(1)).toBe('(exit 1)');
  });
});
