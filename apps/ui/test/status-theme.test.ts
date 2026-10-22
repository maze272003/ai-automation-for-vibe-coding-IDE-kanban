// apps/ui/test/status-theme.test.ts
import { BLOCKED_REASON, PRIORITY, STORY_STATUS } from '@aik/contracts';
import { describe, expect, it } from 'vitest';
import { BLOCKED_REASON_THEME, PRIORITY_THEME, STATUS_THEME } from '../src/lib/status-theme.ts';

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

describe('STATUS_THEME', () => {
  it('covers every story status exactly', () => {
    expect(Object.keys(STATUS_THEME).sort()).toEqual([...STORY_STATUS].sort());
  });

  it('gives every status a label, a dot, a rail and soft colours', () => {
    for (const status of STORY_STATUS) {
      const t = STATUS_THEME[status];
      expect(t.label.length, `${status} label`).toBeGreaterThan(0);
      expect(t.dot, `${status} dot`).toMatch(HEX);
      expect(t.rail, `${status} rail`).toContain('linear-gradient');
      expect(t.softBg, `${status} softBg`).toMatch(/^rgb\(/);
      expect(t.softFg, `${status} softFg`).toMatch(HEX);
      expect(t.glow, `${status} glow`).toMatch(/^rgb\(/);
    }
  });

  it('gives every status a distinct dot colour', () => {
    const dots = STORY_STATUS.map((s) => STATUS_THEME[s].dot);
    expect(new Set(dots).size).toBe(STORY_STATUS.length);
  });
});

describe('PRIORITY_THEME', () => {
  it('covers every priority exactly', () => {
    expect(Object.keys(PRIORITY_THEME).sort()).toEqual([...PRIORITY].sort());
  });

  it('gives every priority soft colours', () => {
    for (const p of PRIORITY) {
      expect(PRIORITY_THEME[p].label).toBe(p);
      expect(PRIORITY_THEME[p].softBg).toMatch(/^rgb\(/);
      expect(PRIORITY_THEME[p].softFg).toMatch(HEX);
    }
  });
});

describe('BLOCKED_REASON_THEME', () => {
  it('covers every blocked reason exactly', () => {
    expect(Object.keys(BLOCKED_REASON_THEME).sort()).toEqual([...BLOCKED_REASON].sort());
  });

  it('gives every blocked reason a label and soft colours', () => {
    for (const r of BLOCKED_REASON) {
      expect(BLOCKED_REASON_THEME[r].label.length, `${r} label`).toBeGreaterThan(0);
      expect(BLOCKED_REASON_THEME[r].softBg).toMatch(/^rgb\(/);
      expect(BLOCKED_REASON_THEME[r].softFg).toMatch(HEX);
    }
  });
});
