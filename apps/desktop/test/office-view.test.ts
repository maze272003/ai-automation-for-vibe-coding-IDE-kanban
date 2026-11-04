// apps/desktop/test/office-view.test.ts — Task 10: office context round-trip + bounds parsing.
// office-view.ts itself is not imported here: it pulls in `electron`, which only exists in
// the packaged main process — its logic is exercised by the e2e/manual verification instead.
import { describe, expect, test } from 'vitest';
import { clearOfficeContextForTests, getOfficeContext, parseOfficeBounds, setOfficeContext } from '../src/main/office-context.ts';

describe('office context + bounds parsing', () => {
  test('context round-trips and clears', () => {
    setOfficeContext({ url: 'http://127.0.0.1:45999', token: 'tok' });
    expect(getOfficeContext()).toEqual({ url: 'http://127.0.0.1:45999', token: 'tok' });
    clearOfficeContextForTests();
    expect(getOfficeContext()).toBeNull();
  });

  test('parseOfficeBounds accepts finite non-negative numbers only', () => {
    expect(parseOfficeBounds({ x: 10.4, y: 20.6, width: 800.5, height: 600.5 })).toEqual({ x: 10, y: 21, width: 801, height: 601 });
    expect(parseOfficeBounds({ x: -5, y: 0, width: 100, height: 100 })).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    expect(parseOfficeBounds({ x: 'a', y: 0, width: 100, height: 100 })).toBeNull();
    expect(parseOfficeBounds(null)).toBeNull();
    expect(parseOfficeBounds({ x: 1, y: 2, width: 0, height: 0 })).toEqual({ x: 1, y: 2, width: 0, height: 0 });
  });
});
