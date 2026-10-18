import { describe, expect, it } from 'vitest';
import { isAllowedExternal } from '../src/main/links.ts';

describe('isAllowedExternal', () => {
  it.each([
    ['https://github.com/o/r', true],
    ['https://docs.github.com/en', true],
    ['http://github.com/o/r', false],
    ['https://github.com.evil.example/x', false],
    ['https://user:pass@github.com/', false],
    ['javascript:alert(1)', false],
    ['file:///C:/Windows', false],
    ['not a url', false],
  ])('%s → %s', (url, expected) => {
    expect(isAllowedExternal(url)).toBe(expected);
  });
});
