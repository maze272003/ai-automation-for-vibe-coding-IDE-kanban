// apps/ui/test/tokens.test.ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const cssPath = path.resolve(import.meta.dirname, '..', 'src', 'index.css');
const css = readFileSync(cssPath, 'utf8');

/**
 * Concatenates the bodies of every `selector { ... }` block. There is more than
 * one `:root` block (primitives, then the light theme), so taking only the first
 * would miss every semantic token.
 */
function blocks(selector: string): string {
  const bodies: string[] = [];
  let from = 0;
  for (;;) {
    const at = css.indexOf(`${selector} {`, from);
    if (at < 0) break;
    const open = css.indexOf('{', at);
    const close = css.indexOf('}', open);
    if (open < 0 || close < 0) break;
    bodies.push(css.slice(open + 1, close));
    from = close + 1;
  }
  return bodies.join('\n');
}

const SEMANTIC_TOKENS = [
  '--background', '--surface', '--surface-2', '--surface-3',
  '--border', '--border-strong',
  '--foreground', '--muted', '--muted-2',
  '--accent', '--accent-2', '--accent-foreground', '--ring',
  '--danger', '--danger-foreground',
  '--success', '--success-foreground',
  '--warning', '--warning-foreground',
  '--glass-fill', '--glass-border', '--glass-highlight', '--scrim',
  '--panel-shadow', '--card-shadow',
] as const;

describe('design tokens', () => {
  it('defines every semantic token in the light theme', () => {
    const light = blocks(':root');
    expect(light).not.toBe('');
    for (const token of SEMANTIC_TOKENS) {
      expect(light, `light theme is missing ${token}`).toContain(`${token}:`);
    }
  });

  it('defines every semantic token in the Aurora dark theme', () => {
    const dark = blocks('.dark');
    expect(dark).not.toBe('');
    for (const token of SEMANTIC_TOKENS) {
      expect(dark, `dark theme is missing ${token}`).toContain(`${token}:`);
    }
  });

  it('maps every semantic token into the Tailwind theme', () => {
    const theme = blocks('@theme inline');
    expect(theme).not.toBe('');
    for (const token of SEMANTIC_TOKENS) {
      expect(theme, `@theme inline is missing ${token}`).toContain(`var(${token})`);
    }
  });

  it('paints the aurora canvas on a fixed layer', () => {
    expect(css).toContain('body::before');
    expect(css).toContain('position: fixed');
  });

  it('honours prefers-reduced-motion', () => {
    expect(css).toContain('prefers-reduced-motion: reduce');
  });
});
