// packages/contracts/test/diagnostics.test.ts
import { describe, expect, it } from 'vitest';
import {
  DIAGNOSTICS_BACKUP_THROTTLE_MS,
  DIAGNOSTICS_ERROR_LIMIT,
  DIAGNOSTICS_LOG_TAIL,
  DIAGNOSTICS_MAX_BACKUPS,
  DIAGNOSTICS_RESTORE_NOTE,
  DiagnosticsErrorsQuery,
  DiagnosticsLogName,
  DiagnosticsLogParams,
  DiagnosticsLogQuery,
} from '../src/index.ts';

describe('diagnostics constants', () => {
  it('publishes the bounded defaults from the API contract', () => {
    expect(DIAGNOSTICS_LOG_TAIL).toEqual({ min: 4_096, max: 262_144, default: 65_536 });
    expect(DIAGNOSTICS_ERROR_LIMIT).toEqual({ min: 1, max: 200, default: 50 });
    expect(DIAGNOSTICS_MAX_BACKUPS).toBe(5);
    expect(DIAGNOSTICS_BACKUP_THROTTLE_MS).toBe(10_000);
    expect(typeof DIAGNOSTICS_RESTORE_NOTE).toBe('string');
    expect(DIAGNOSTICS_RESTORE_NOTE.length).toBeGreaterThan(0);
  });
});

describe('DiagnosticsLogName', () => {
  it.each([
    'orchestrator.log',
    'orchestrator.log.3',
    'orchestrator-stdio.log',
    'audit-purge.log',
  ])('accepts %s', (name) => {
    expect(DiagnosticsLogName.safeParse(name).success).toBe(true);
  });

  it.each([
    ['../x.log'],
    ['/abs.log'],
    ['a/b.log'],
    ['a\\b.log'],
    ['evil.log:stream'],
    ['.hidden.log'],
    ['app.db'],
    [''],
  ])('rejects %j', (name) => {
    expect(DiagnosticsLogName.safeParse(name).success).toBe(false);
  });

  it('enforces the 160-character cap on a valid-shaped name', () => {
    const atLimit = `${'a'.repeat(156)}.log`;
    const overLimit = `${'a'.repeat(157)}.log`;
    expect(atLimit).toHaveLength(160);
    expect(overLimit).toHaveLength(161);
    expect(DiagnosticsLogName.safeParse(atLimit).success).toBe(true);
    expect(DiagnosticsLogName.safeParse(overLimit).success).toBe(false);
  });
});

describe('DiagnosticsLogParams', () => {
  it('accepts a route param with a valid file name', () => {
    expect(DiagnosticsLogParams.safeParse({ file: 'orchestrator.log.3' }).success).toBe(true);
  });

  it('rejects missing or unsafe file names', () => {
    expect(DiagnosticsLogParams.safeParse({}).success).toBe(false);
    expect(DiagnosticsLogParams.safeParse({ file: '../x.log' }).success).toBe(false);
  });
});

describe('DiagnosticsLogQuery', () => {
  it('applies the default when tailBytes is absent', () => {
    expect(DiagnosticsLogQuery.parse({})).toEqual({ tailBytes: DIAGNOSTICS_LOG_TAIL.default });
  });

  it('coerces query-string values and accepts both bounds', () => {
    expect(DiagnosticsLogQuery.parse({ tailBytes: String(DIAGNOSTICS_LOG_TAIL.min) })).toEqual({
      tailBytes: DIAGNOSTICS_LOG_TAIL.min,
    });
    expect(DiagnosticsLogQuery.parse({ tailBytes: String(DIAGNOSTICS_LOG_TAIL.max) })).toEqual({
      tailBytes: DIAGNOSTICS_LOG_TAIL.max,
    });
  });

  it('rejects values one step outside the bounds and non-integers', () => {
    expect(DiagnosticsLogQuery.safeParse({ tailBytes: 0 }).success).toBe(false);
    expect(DiagnosticsLogQuery.safeParse({ tailBytes: DIAGNOSTICS_LOG_TAIL.max + 1 }).success).toBe(false);
    expect(DiagnosticsLogQuery.safeParse({ tailBytes: '4096.5' }).success).toBe(false);
  });

  it('rejects an empty value instead of defaulting', () => {
    // z.coerce.number() turns '' into 0, so an empty query parameter fails the
    // 4 KiB minimum. The UI must omit tailBytes rather than send ''.
    expect(DiagnosticsLogQuery.safeParse({ tailBytes: '' }).success).toBe(false);
  });
});

describe('DiagnosticsErrorsQuery', () => {
  it('applies the default when limit is absent', () => {
    expect(DiagnosticsErrorsQuery.parse({})).toEqual({ limit: DIAGNOSTICS_ERROR_LIMIT.default });
  });

  it('coerces query-string values and accepts both bounds', () => {
    expect(DiagnosticsErrorsQuery.parse({ limit: String(DIAGNOSTICS_ERROR_LIMIT.min) })).toEqual({
      limit: DIAGNOSTICS_ERROR_LIMIT.min,
    });
    expect(DiagnosticsErrorsQuery.parse({ limit: String(DIAGNOSTICS_ERROR_LIMIT.max) })).toEqual({
      limit: DIAGNOSTICS_ERROR_LIMIT.max,
    });
  });

  it('rejects values one step outside the bounds and non-integers', () => {
    expect(DiagnosticsErrorsQuery.safeParse({ limit: DIAGNOSTICS_ERROR_LIMIT.min - 1 }).success).toBe(false);
    expect(DiagnosticsErrorsQuery.safeParse({ limit: DIAGNOSTICS_ERROR_LIMIT.max + 1 }).success).toBe(false);
    expect(DiagnosticsErrorsQuery.safeParse({ limit: '10.5' }).success).toBe(false);
  });
});
