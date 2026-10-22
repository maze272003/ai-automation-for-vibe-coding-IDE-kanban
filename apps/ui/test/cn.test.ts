// apps/ui/test/cn.test.ts
import { describe, expect, it } from 'vitest';
import { cn } from '../src/lib/cn.ts';

describe('cn', () => {
  it('joins class names', () => {
    expect(cn('a', 'b')).toBe('a b');
  });

  it('drops falsy values', () => {
    expect(cn('a', false, undefined, null, '', 'b')).toBe('a b');
  });

  it('lets the later argument win a Tailwind conflict', () => {
    expect(cn('w-full', 'w-64')).toBe('w-64');
    expect(cn('p-2', 'p-4')).toBe('p-4');
  });

  it('keeps non-conflicting Tailwind utilities', () => {
    expect(cn('rounded-md border', 'bg-accent')).toBe('rounded-md border bg-accent');
  });

  it('accepts conditional objects and arrays', () => {
    expect(cn(['a', { b: true, c: false }])).toBe('a b');
  });
});
