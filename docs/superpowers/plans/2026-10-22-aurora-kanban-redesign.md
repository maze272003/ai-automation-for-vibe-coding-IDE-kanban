# Aurora Premium Kanban Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reskin every surface of the AI Kanban desktop app with the approved "Aurora" design — deep gradient canvas, frosted glass panels, a signature colour per story status — while keeping every behaviour, test id, accessible name and API contract exactly as it is today.

**Architecture:** A three-layer design-token system (primitive → semantic → component) lives in `apps/ui/src/index.css` and is mapped into Tailwind 4 via `@theme inline`. A shadcn-convention component library in `apps/ui/src/components/ui/` is rebuilt on top of it, adding Radix only where native HTML cannot deliver focus management or keyboard navigation. A single `status-theme.ts` module is the one source of truth for the ten status colours. The redesign is presentational: no backend, contract, database or workflow-machine file is touched.

**Tech Stack:** React 19.3.1, Vite 8.3.4, Tailwind CSS 4.3.3 (CSS-first), TanStack Router 1.170.45, Radix UI (dialog, dropdown-menu, tooltip, scroll-area, slot), class-variance-authority, clsx, tailwind-merge, Playwright 1.64.1 (Electron), Vitest 5.0.5, Electron 44.9.0.

**Design spec:** `docs/superpowers/specs/2026-10-22-aurora-kanban-redesign-design.md`

---

## Global Constraints

These apply to every task. Copy them verbatim into each task's context.

- **Dependencies are exact-pinned.** Install only with `npm install -E <pkg>@<version>`. Never edit a `package.json` dependency range by hand. `npm run check:pins` must pass at every commit.
- **The only new dependencies are these eight, at these exact versions:**

  ```
  @radix-ui/react-dialog@1.3.1
  @radix-ui/react-dropdown-menu@2.2.1
  @radix-ui/react-tooltip@1.4.1
  @radix-ui/react-scroll-area@1.4.0
  @radix-ui/react-slot@1.5.0
  class-variance-authority@0.7.1
  clsx@2.1.1
  tailwind-merge@3.7.0
  ```

  They all go in `apps/ui/package.json` under `dependencies`.
- **Gate command, run before every commit:**

  ```bash
  npm run check:pins && npm run lint && npm run typecheck && npm test
  ```

- **E2E gate (Task 2 onward), run before every commit that touches `apps/ui/src`:**

  ```bash
  npm run build && npm run e2e -- appearance
  ```

  `npm run build` is required first: the e2e suite launches the built Electron app from `apps/desktop/dist`.
- **ESLint enforces `@typescript-eslint/consistent-type-imports`** — type-only imports must use `import type { X } from '...'`.
- **Vitest runs in the `node` environment** (`vitest.config.ts` has no jsdom). Unit tests under `apps/ui/test/` must therefore test **pure functions only** — no DOM, no React rendering. Anything visual is verified by Playwright e2e instead.
- **Vitest picks up `apps/*/test/**/*.test.ts`** — new unit tests go in `apps/ui/test/`.
- **Never hard-code a status colour in a component.** All status/priority/blocked colours come from `apps/ui/src/lib/status-theme.ts`.
- **Preserve every `data-testid`, accessible name, ARIA role and the verbatim `title` attribute** listed in the spec's §9 "Behaviour Preservation Contract". `e2e/tests/board.spec.ts` must never be edited.
- **`e2e/tests/board.spec.ts` and `e2e/tests/dashboard.spec.ts` are the regression fence.** If either fails, the task is not done.
- **Never log or persist secrets.**
- **Do not modify** `apps/desktop/**`, `packages/**`, `e2e/tests/board.spec.ts`, `e2e/tests/dashboard.spec.ts`.
- **The repo has unrelated uncommitted work in the working tree** (GitHub integration: `apps/orchestrator/src/git/`, `apps/orchestrator/src/github/`, `packages/contracts/src/github.ts`). Never `git add -A`, never `git checkout -- .`, never stage those files. Stage only the paths listed in the task.
- **Blur budget (§7 of the spec):** `backdrop-filter` may be applied to the **chrome only** — the app bar, the sidebar, the 10 column panels, the modal and dialog panels, dropdown menus, tooltips and toasts. That is roughly 17 elements. **Never apply `backdrop-filter` to a story card**, and **not** to the generic `Card` primitive (the dashboard and settings render one per project, and the count is unbounded). Both use a translucent solid fill instead, which is visually near-identical over a static gradient.
- **Prefer `content-visibility: auto` + `contain-intrinsic-size` on card items** so off-screen cards skip layout and paint.

---

## Frozen e2e Facts — read before touching any UI file

These are not guesses. They were read out of `e2e/tests/board.spec.ts`, `dashboard.spec.ts`, `lifecycle.spec.ts` and `security.spec.ts`. Violating any of them breaks a spec that must pass **unmodified**.

| # | Fact | Consequence |
|---|------|-------------|
| E1 | `board.spec.ts` counts `page.locator('[data-testid^="card-"]')` and expects exactly **200** | **No new test id may start with `card-`.** Use `story-priority-<KEY>` and `story-attempts-<KEY>`, never `card-priority-<KEY>`. |
| E2 | `board.spec.ts` opens the board with `getByRole('link', { name: /^INV · Inventory$/ })` — an exact regex | Exactly **one** element in the app may have the accessible name `INV · Inventory`. The sidebar must not duplicate it. |
| E3 | `lifecycle.spec.ts` clicks `getByRole('link', { name: 'INV · Inventory' })` — a substring match | Two matching links make Playwright throw a strict-mode violation. Same rule as E2. |
| E4 | `lifecycle.spec.ts` asserts `getByTestId('project-list')` contains `INV · Inventory`; `dashboard.spec.ts` asserts it contains `INV · Inventory` **and** `main` | `project-list` must exist **exactly once** in the DOM, and its text must contain both the full `KEY · name` label and the base branch. It belongs on the dashboard page — the sidebar must use a different test id. |
| E5 | `dashboard.spec.ts` asserts `getByRole('heading', { name: 'Projects' })` | The dashboard needs exactly one heading named `Projects`. A sidebar **link** named `Projects` is fine; a second *heading* is not. |
| E6 | `dashboard.spec.ts` calls `page.getByLabel(/Use my personal OpenCode CLI/).check()` and `page.getByLabel(/App-managed OpenCode/).check()` | The OpenCode mode control must be a **real `<input type="radio">`** with an associated label. A `role="radio"` **button** has no label association and `check()` will fail. |
| E7 | `dashboard.spec.ts` asserts `getByText(/Personal mode uses the/)` is visible in personal mode and absent in managed mode | Keep that exact sentence, and keep it conditional on the mode. |
| E8 | `dashboard.spec.ts` asserts `getByLabel('Default model')` and `getByLabel('Test prompt')` resolve to the control | Associate a `<label htmlFor>` with the control's `id`, or set `aria-label`. Do **not** use both for the same control. |
| E9 | `dashboard.spec.ts` asserts `getByTestId('data-dir')` has text **exactly** the data folder path, and `getByTestId('opencode-status')` exactly `2.0.32` / `not installed` / `1.2.3 (expected 2.0.32)` | Those elements must contain the value and nothing else. |
| E10 | `dashboard.spec.ts` asserts `getByRole('button', { name: /Install/ })` has count 0 when the pin matches | No other visible button may contain the word "Install" in that state. |
| E11 | `board.spec.ts` asserts the `IN_PROGRESS` menuitem `toBeDisabled()` **and** `toHaveAttribute('title', 'Only the orchestrator moves stories from NEW to IN_PROGRESS')` | The Radix item must carry `aria-disabled="true"` (Radix does this for `disabled`) and the reason must be passed through to the DOM `title` **verbatim**. |
| E12 | `board.spec.ts` selects the move menu with `getByRole('menuitem', { name: 'CANCELLED' })` and `/IN_PROGRESS/` | The menuitem's accessible name must contain the raw status string. Put the inline reason in `aria-describedby`, **not** in the name — the IN_PROGRESS reason contains the word "NEW", which would otherwise make `getByRole('menuitem', { name: 'NEW' })` ambiguous. |
| E13 | `lifecycle.spec.ts` asserts `getByTestId('system-failure')` contains `keeps crashing` and `could not start`, and that a `Restore latest backup` button exists | Keep both sentences and the button name verbatim. |
| E14 | `lifecycle.spec.ts` asserts `card-INV-1` contains `on hold` and `column-CANCELLED` contains `1` | The hold badge text and the column count chip must both survive. |
| E15 | `security.spec.ts` asserts the renderer DOM contains **no** API token | Nothing in the shell may embed a token. `window.api` stays behind the preload bridge. |

---

## File Structure

### Created by this plan

```
apps/ui/components.json                                  shadcn CLI manifest
apps/ui/src/lib/cn.ts                                    clsx + tailwind-merge merge helper
apps/ui/src/lib/status-theme.ts                          the single source of truth for status colours
apps/ui/src/components/ui/card.tsx                       glass surface primitive
apps/ui/src/components/ui/input.tsx                      styled text input
apps/ui/src/components/ui/textarea.tsx                   styled textarea
apps/ui/src/components/ui/select.tsx                     styled select
apps/ui/src/components/ui/label.tsx                      form label
apps/ui/src/components/ui/separator.tsx                  hairline rule
apps/ui/src/components/ui/skeleton.tsx                   loading placeholder
apps/ui/src/components/ui/dropdown-menu.tsx              Radix dropdown wrapper
apps/ui/src/components/ui/tooltip.tsx                    Radix tooltip wrapper
apps/ui/src/components/ui/scroll-area.tsx                Radix scroll area wrapper
apps/ui/src/components/shell/app-shell.tsx               sidebar + top bar layout
apps/ui/src/components/shell/sidebar.tsx                 glass sidebar
apps/ui/src/components/shell/top-bar.tsx                 glass top bar
apps/ui/src/components/shell/status-card.tsx             orchestrator status card
apps/ui/test/cn.test.ts                                 unit: cn() merging
apps/ui/test/tokens.test.ts                             unit: index.css token contract
apps/ui/test/status-theme.test.ts                        unit: status/priority/blocked maps
e2e/tests/appearance.spec.ts                            e2e: visual + a11y regression suite
```

### Modified by this plan

```
apps/ui/package.json                      the eight exact-pinned dependencies
apps/ui/src/index.css                     the three token layers, aurora canvas, reduced motion
apps/ui/src/lib/stories.ts                exposes a `loading` flag for the board skeleton
apps/ui/src/components/ui/button.tsx      cva variants, aurora tokens
apps/ui/src/components/ui/badge.tsx       status tone, aurora tokens
apps/ui/src/components/ui/dialog.tsx      Radix-backed, glass panel
apps/ui/src/components/ui/field.tsx       styled inputs (public API preserved)
apps/ui/src/components/ui/toast.tsx       glass toast (role=status preserved)
apps/ui/src/components/kanban/board.tsx       shell layout, perf, toolbar
apps/ui/src/components/kanban/card.tsx        glass card, live-run strip, CTAs
apps/ui/src/components/kanban/column.tsx      rail, count chip, drop target
apps/ui/src/components/kanban/move-menu.tsx   Radix dropdown
apps/ui/src/components/kanban/terminal-modal.tsx  glass panel, tab restyle
apps/ui/src/components/kanban/confirm-dialog.tsx
apps/ui/src/components/kanban/create-story-dialog.tsx
apps/ui/src/components/kanban/request-changes-dialog.tsx
apps/ui/src/components/kanban/clarifications-dialog.tsx
apps/ui/src/routes/root.tsx               app shell
apps/ui/src/routes/dashboard.tsx          project cards
apps/ui/src/routes/settings.tsx           settings cards
```

### Explicitly not modified

```
apps/desktop/**                    packages/**
e2e/tests/board.spec.ts            e2e/tests/dashboard.spec.ts
e2e/tests/lifecycle.spec.ts        e2e/tests/security.spec.ts
apps/ui/src/lib/theme.ts           loadTheme()/applyTheme() keep working untouched —
                                   the `.dark` class toggle already drives the new tokens
```

---

## Phase 1 — Foundation

### Task 1: Dependencies, `cn()` and the shadcn manifest

**Files:**
- Modify: `apps/ui/package.json`
- Create: `apps/ui/src/lib/cn.ts`
- Create: `apps/ui/test/cn.test.ts`
- Create: `apps/ui/components.json`

**Interfaces:**
- Consumes: nothing (this is the first task).
- Produces: `cn(...inputs: ClassValue[]): string` exported from `apps/ui/src/lib/cn.ts`. Every later task imports it as `import { cn } from '../../lib/cn.ts'` (path depends on the importer's depth).

- [ ] **Step 1: Install the eight dependencies with exact pins**

Run from the repo root:

```bash
npm install -E -w @aik/ui @radix-ui/react-dialog@1.3.1 @radix-ui/react-dropdown-menu@2.2.1 @radix-ui/react-tooltip@1.4.1 @radix-ui/react-scroll-area@1.4.0 @radix-ui/react-slot@1.5.0 class-variance-authority@0.7.1 clsx@2.1.1 tailwind-merge@3.7.0
```

Expected: npm prints an "added 8 packages" summary; `apps/ui/package.json` gains all eight under `dependencies` with exact versions.

- [ ] **Step 2: Verify the pins are exact**

Run:

```bash
npm run check:pins
```

Expected: `All dependency versions are exact.`

- [ ] **Step 3: Write the failing test**

Create `apps/ui/test/cn.test.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it fails**

Run:

```bash
npx vitest run apps/ui/test/cn.test.ts
```

Expected: FAIL — `Failed to load url ../src/lib/cn.ts` (the module does not exist yet).

- [ ] **Step 5: Implement `cn()`**

Create `apps/ui/src/lib/cn.ts`:

```ts
// apps/ui/src/lib/cn.ts — class-name merging: clsx flattens conditionals, tailwind-merge resolves conflicts.
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run:

```bash
npx vitest run apps/ui/test/cn.test.ts
```

Expected: PASS — 5 tests passed.

- [ ] **Step 7: Create the shadcn manifest**

Create `apps/ui/components.json`:

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/index.css",
    "baseColor": "slate",
    "cssVariables": true,
    "prefix": ""
  },
  "aliases": {
    "components": "src/components",
    "utils": "src/lib/cn.ts",
    "ui": "src/components/ui",
    "lib": "src/lib",
    "hooks": "src/hooks"
  },
  "iconLibrary": "radix"
}
```

- [ ] **Step 8: Run the gate and commit**

Run:

```bash
npm run check:pins && npm run lint && npm run typecheck && npm test
```

Expected: all green.

Commit:

```bash
git add apps/ui/package.json apps/ui/src/lib/cn.ts apps/ui/test/cn.test.ts apps/ui/components.json package-lock.json
git commit -m "feat(ui): add shadcn-style component foundation with cn() merge helper

Adds the eight exact-pinned dependencies the Aurora redesign needs
(Radix dialog/dropdown-menu/tooltip/scroll-area/slot, cva, clsx,
tailwind-merge), a clsx+tailwind-merge cn() helper, and the shadcn
components.json manifest so future primitives can be added with the CLI."
```

---

### Task 2: Design tokens, the Aurora canvas and the e2e appearance suite

**Files:**
- Modify: `apps/ui/src/index.css`
- Create: `apps/ui/test/tokens.test.ts`
- Create: `e2e/tests/appearance.spec.ts`

**Interfaces:**
- Consumes: nothing from Task 1 except the repo's existing Tailwind 4 setup.
- Produces:
  - CSS custom properties on `:root` (light) and `.dark` (Aurora dark): `--background`, `--surface`, `--surface-2`, `--surface-3`, `--border`, `--border-strong`, `--foreground`, `--muted`, `--muted-2`, `--accent`, `--accent-2`, `--accent-foreground`, `--ring`, `--danger`, `--danger-foreground`, `--success`, `--success-foreground`, `--warning`, `--warning-foreground`, `--glass-fill`, `--glass-border`, `--glass-highlight`, `--scrim`, `--panel-shadow`, `--card-shadow`.
  - Tailwind utilities generated from them: `bg-background`, `bg-surface`, `bg-surface-2`, `bg-surface-3`, `border-border`, `border-border-strong`, `text-foreground`, `text-muted`, `text-muted-2`, `bg-accent`, `bg-accent-2`, `text-accent-foreground`, `ring-ring`, `text-danger`, `text-danger-foreground`, `text-success`, `text-success-foreground`, `text-warning`, `text-warning-foreground`, `bg-glass`, `border-glass-border`, `rounded-card`, `rounded-panel`, `rounded-control`, `shadow-panel`, `shadow-card`.
  - The e2e file `e2e/tests/appearance.spec.ts`, which every later task extends.

- [ ] **Step 1: Write the failing token test**

Create `apps/ui/test/tokens.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npx vitest run apps/ui/test/tokens.test.ts
```

Expected: FAIL — `light theme is missing --background`.

- [ ] **Step 3: Write the token system**

Replace `apps/ui/src/index.css` with:

```css
@import "tailwindcss";
@custom-variant dark (&:where(.dark, .dark *));

/* ===========================================================================
   Layer 1 — primitives. Raw values with no meaning attached.
   =========================================================================== */
:root {
  --aurora-400: #a78bfa;
  --aurora-500: #8b5cf6;
  --aurora-600: #6366f1;
  --teal-400: #2dd4bf;
  --teal-300: #5eead4;
  --rose-400: #fb7185;
  --emerald-400: #34d399;
  --amber-400: #fbbf24;
  --sky-400: #38bdf8;
  --cyan-400: #22d3ee;
  --slate-400: #94a3b8;
}

/* ===========================================================================
   Layer 2 — semantic. Role-based, defined once per theme.
   =========================================================================== */

/* Light — refined counterpart of Aurora. */
:root {
  --background: #f4f4f8;
  --surface: rgb(255 255 255 / 0.66);
  --surface-2: rgb(255 255 255 / 0.92);
  --surface-3: rgb(255 255 255 / 0.98);
  --border: rgb(24 24 37 / 0.10);
  --border-strong: rgb(24 24 37 / 0.18);
  --foreground: #15161a;
  --muted: #5e6270;
  --muted-2: #8b90a0;
  --accent: #6d28d9;
  --accent-2: #4f46e5;
  --accent-foreground: #ffffff;
  --ring: rgb(109 40 217 / 0.75);
  --danger: #e11d48;
  --danger-foreground: #9f1239;
  --success: #059669;
  --success-foreground: #047857;
  --warning: #d97706;
  --warning-foreground: #92400e;
  --glass-fill: rgb(255 255 255 / 0.66);
  --glass-border: rgb(24 24 37 / 0.09);
  --glass-highlight: rgb(255 255 255 / 0.85);
  --scrim: rgb(255 255 255 / 0.92);
  --panel-shadow: 0 30px 70px -35px rgb(24 24 37 / 0.35);
  --card-shadow: 0 8px 22px -14px rgb(24 24 37 / 0.35);
}

/* Dark — Aurora. */
.dark {
  --background: #090d1a;
  --surface: rgb(255 255 255 / 0.045);
  --surface-2: rgb(255 255 255 / 0.055);
  --surface-3: rgb(0 0 0 / 0.28);
  --border: rgb(255 255 255 / 0.10);
  --border-strong: rgb(255 255 255 / 0.18);
  --foreground: #eef1fb;
  --muted: #a6aec8;
  --muted-2: #7e86a2;
  --accent: #8b5cf6;
  --accent-2: #6366f1;
  --accent-foreground: #ffffff;
  --ring: rgb(167 139 250 / 0.85);
  --danger: #fb7185;
  --danger-foreground: #fda4af;
  --success: #34d399;
  --success-foreground: #6ee7b7;
  --warning: #fbbf24;
  --warning-foreground: #fcd34d;
  --glass-fill: rgb(255 255 255 / 0.045);
  --glass-border: rgb(255 255 255 / 0.10);
  --glass-highlight: rgb(255 255 255 / 0.06);
  --scrim: rgb(16 20 36 / 0.90);
  --panel-shadow: 0 40px 90px -40px rgb(0 0 0 / 0.95);
  --card-shadow: 0 10px 26px -16px rgb(0 0 0 / 0.90);
}

/* ===========================================================================
   Layer 3 — component. Constant across themes, so it is declared directly in
   @theme. Do NOT write `--radius-card: var(--radius-card)` inside `@theme
   inline` — that is a self-reference and resolves to nothing.
   =========================================================================== */
@theme {
  --radius-card: 11px;
  --radius-panel: 14px;
  --radius-control: 9px;
}

/* ===========================================================================
   Tailwind mapping. `inline` keeps the var() reference so the .dark override
   cascades into the generated utilities.
   =========================================================================== */
@theme inline {
  --color-background: var(--background);
  --color-surface: var(--surface);
  --color-surface-2: var(--surface-2);
  --color-surface-3: var(--surface-3);
  --color-border: var(--border);
  --color-border-strong: var(--border-strong);
  --color-foreground: var(--foreground);
  --color-muted: var(--muted);
  --color-muted-2: var(--muted-2);
  --color-accent: var(--accent);
  --color-accent-2: var(--accent-2);
  --color-accent-foreground: var(--accent-foreground);
  --color-ring: var(--ring);
  --color-danger: var(--danger);
  --color-danger-foreground: var(--danger-foreground);
  --color-success: var(--success);
  --color-success-foreground: var(--success-foreground);
  --color-warning: var(--warning);
  --color-warning-foreground: var(--warning-foreground);
  --color-glass: var(--glass-fill);
  --color-glass-border: var(--glass-border);
  --shadow-panel: var(--panel-shadow);
  --shadow-card: var(--card-shadow);
}

/* ===========================================================================
   Base
   =========================================================================== */
html,
body,
#root {
  height: 100%;
}

body {
  background-color: var(--background);
  color: var(--foreground);
  font-family: -apple-system, "Segoe UI", Inter, system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}

/* The aurora wash is painted once on a fixed layer so scrolling and dragging
   never repaint it. */
body::before {
  content: "";
  position: fixed;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  background-image:
    radial-gradient(1000px 520px at 6% -12%, rgb(41 86 196 / 0.55) 0%, transparent 60%),
    radial-gradient(820px 420px at 92% -8%, rgb(138 47 158 / 0.50) 0%, transparent 58%),
    radial-gradient(700px 500px at 60% 120%, rgb(24 117 122 / 0.30) 0%, transparent 60%);
}

:root:not(.dark) body::before {
  background-image:
    radial-gradient(900px 460px at 4% -14%, rgb(196 181 253 / 0.55) 0%, transparent 60%),
    radial-gradient(760px 400px at 96% -6%, rgb(251 207 232 / 0.50) 0%, transparent 58%),
    radial-gradient(700px 460px at 60% 118%, rgb(191 219 254 / 0.45) 0%, transparent 60%);
}

/* ===========================================================================
   Motion
   =========================================================================== */
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
npx vitest run apps/ui/test/tokens.test.ts
```

Expected: PASS — 5 tests passed.

- [ ] **Step 5: Create the e2e appearance suite**

Create `e2e/tests/appearance.spec.ts`:

```ts
// e2e/tests/appearance.spec.ts
import { expect, test, type Page } from '@playwright/test';
import { apiCall, launchApp, makeTempDir, makeTempRepo, waitReady, type Launched } from '../fixtures.ts';

let launched: Launched;
let dataDir: string;
let projectId: number;

/** Resolves a semantic custom property on the document root. */
async function token(page: Page, name: string): Promise<string> {
  return page.evaluate(
    (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
    name,
  );
}

async function openBoard(page: Page) {
  await page.getByRole('link', { name: /^INV · Inventory$/ }).click();
  await expect(page.getByTestId('board')).toBeVisible();
}

test.beforeEach(async () => {
  dataDir = makeTempDir();
  launched = await launchApp(dataDir);
  await waitReady(launched.page);
  // The Electron user data dir persists localStorage across launches in one Playwright run,
  // so the theme is forced to dark here. Without this, the light-theme test would leak its
  // setting into every later test in this file.
  await launched.page.evaluate(() => {
    localStorage.setItem('aik.theme', 'dark');
    document.documentElement.classList.add('dark');
  });
  const created = await apiCall<{ id: number }>(launched.page, 'POST', '/projects', {
    name: 'Inventory',
    key: 'INV',
    repoPath: makeTempRepo(),
  });
  projectId = created.body.id;
});

test.afterEach(async () => {
  await launched.app.close();
});

test('the dark theme paints the Aurora canvas tokens', async () => {
  const { page } = launched;
  expect(await token(page, '--background')).toBe('#090d1a');
  expect(await token(page, '--accent')).toBe('#8b5cf6');
  expect(await token(page, '--foreground')).toBe('#eef1fb');
});

test('the theme toggle switches to the other theme\'s tokens', async () => {
  const { page } = launched;
  await page.getByRole('link', { name: 'Settings' }).click();
  const button = page.getByRole('button', { name: /Switch to (light|dark) theme/i });
  const label = await button.textContent();
  await button.click();
  const expected = label?.includes('light') ? '#f4f4f8' : '#090d1a';
  await expect.poll(() => token(page, '--background')).toBe(expected);
});
```

- [ ] **Step 6: Run the gate**

Run:

```bash
npm run check:pins && npm run lint && npm run typecheck && npm test && npm run build && npm run e2e -- appearance
```

Expected: unit tests green; the two appearance tests PASS. The light-theme test uses the **existing** Settings button name `Switch to light theme` — that button is restyled in Task 7 but keeps its accessible name.

- [ ] **Step 7: Commit**

```bash
git add apps/ui/src/index.css apps/ui/test/tokens.test.ts e2e/tests/appearance.spec.ts
git commit -m "feat(ui): add three-layer design tokens and the Aurora canvas

Primitive, semantic and component token layers with a matching refined
light theme, mapped into Tailwind 4 via @theme inline. The aurora wash is
painted once on a fixed layer so scrolling never repaints it, and a
prefers-reduced-motion block disables non-essential animation."
```

---

### Task 3: The status theme map

**Files:**
- Create: `apps/ui/src/lib/status-theme.ts`
- Create: `apps/ui/test/status-theme.test.ts`

**Interfaces:**
- Consumes: `@aik/contracts` enums `STORY_STATUS`, `PRIORITY`, `BLOCKED_REASON` and types `StoryStatus`, `Priority`, `BlockedReason`.
- Produces:
  - `export interface StatusTheme { label: string; dot: string; rail: string; softBg: string; softFg: string; glow: string }`
  - `export const STATUS_THEME: Record<StoryStatus, StatusTheme>`
  - `export interface PriorityTheme { label: string; softBg: string; softFg: string }`
  - `export const PRIORITY_THEME: Record<Priority, PriorityTheme>`
  - `export interface BlockedTheme { label: string; softBg: string; softFg: string }`
  - `export const BLOCKED_REASON_THEME: Record<BlockedReason, BlockedTheme>`

- [ ] **Step 1: Write the failing test**

Create `apps/ui/test/status-theme.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npx vitest run apps/ui/test/status-theme.test.ts
```

Expected: FAIL — `Failed to load url ../src/lib/status-theme.ts`.

- [ ] **Step 3: Implement the map**

Create `apps/ui/src/lib/status-theme.ts`:

```ts
// apps/ui/src/lib/status-theme.ts — the single source of truth for status, priority and blocked colours.
import { BLOCKED_REASON, PRIORITY, STORY_STATUS, type BlockedReason, type Priority, type StoryStatus } from '@aik/contracts';

export interface StatusTheme {
  /** Human label used in headers, pills and sidebars. */
  label: string;
  /** Solid colour for the status dot. */
  dot: string;
  /** CSS gradient for the column's top rail. */
  rail: string;
  /** Translucent badge background. */
  softBg: string;
  /** Badge foreground, chosen for contrast against softBg. */
  softFg: string;
  /** Translucent glow used for drop targets and focus rings. */
  glow: string;
}

export interface PriorityTheme {
  label: string;
  softBg: string;
  softFg: string;
}

export interface BlockedTheme {
  label: string;
  softBg: string;
  softFg: string;
}

export const STATUS_THEME: Record<StoryStatus, StatusTheme> = {
  NEW: {
    label: 'New',
    dot: '#94a3b8',
    rail: 'linear-gradient(90deg, #94a3b8, rgb(148 163 184 / 0.15))',
    softBg: 'rgb(148 163 184 / 0.16)',
    softFg: '#cbd5e1',
    glow: 'rgb(148 163 184 / 0.55)',
  },
  READY: {
    label: 'Ready',
    dot: '#38bdf8',
    rail: 'linear-gradient(90deg, #38bdf8, rgb(56 189 248 / 0.15))',
    softBg: 'rgb(56 189 248 / 0.16)',
    softFg: '#7dd3fc',
    glow: 'rgb(56 189 248 / 0.55)',
  },
  IN_PROGRESS: {
    label: 'In progress',
    dot: '#a78bfa',
    rail: 'linear-gradient(90deg, #a78bfa, rgb(167 139 250 / 0.15))',
    softBg: 'rgb(167 139 250 / 0.18)',
    softFg: '#c4b5fd',
    glow: 'rgb(167 139 250 / 0.55)',
  },
  TESTING: {
    label: 'Testing',
    dot: '#22d3ee',
    rail: 'linear-gradient(90deg, #22d3ee, rgb(34 211 238 / 0.15))',
    softBg: 'rgb(34 211 238 / 0.16)',
    softFg: '#67e8f9',
    glow: 'rgb(34 211 238 / 0.55)',
  },
  READY_FOR_REVIEW: {
    label: 'Ready for review',
    dot: '#34d399',
    rail: 'linear-gradient(90deg, #34d399, rgb(52 211 153 / 0.15))',
    softBg: 'rgb(52 211 153 / 0.16)',
    softFg: '#6ee7b7',
    glow: 'rgb(52 211 153 / 0.55)',
  },
  REWORK: {
    label: 'Rework',
    dot: '#fbbf24',
    rail: 'linear-gradient(90deg, #fbbf24, rgb(251 191 36 / 0.15))',
    softBg: 'rgb(251 191 36 / 0.16)',
    softFg: '#fcd34d',
    glow: 'rgb(251 191 36 / 0.55)',
  },
  BLOCKED: {
    label: 'Blocked',
    dot: '#fb7185',
    rail: 'linear-gradient(90deg, #fb7185, rgb(251 113 133 / 0.15))',
    softBg: 'rgb(251 113 133 / 0.18)',
    softFg: '#fda4af',
    glow: 'rgb(251 113 133 / 0.55)',
  },
  AWAITING_MERGE: {
    label: 'Awaiting merge',
    dot: '#2dd4bf',
    rail: 'linear-gradient(90deg, #2dd4bf, rgb(45 212 191 / 0.15))',
    softBg: 'rgb(45 212 191 / 0.18)',
    softFg: '#5eead4',
    glow: 'rgb(45 212 191 / 0.55)',
  },
  DONE: {
    label: 'Done',
    dot: '#10b981',
    rail: 'linear-gradient(90deg, #10b981, rgb(16 185 129 / 0.15))',
    softBg: 'rgb(16 185 129 / 0.16)',
    softFg: '#6ee7b7',
    glow: 'rgb(16 185 129 / 0.55)',
  },
  CANCELLED: {
    label: 'Cancelled',
    dot: '#64748b',
    rail: 'linear-gradient(90deg, #64748b, rgb(100 116 139 / 0.15))',
    softBg: 'rgb(100 116 139 / 0.18)',
    softFg: '#94a3b8',
    glow: 'rgb(100 116 139 / 0.55)',
  },
};

export const PRIORITY_THEME: Record<Priority, PriorityTheme> = {
  P0: { label: 'P0', softBg: 'rgb(244 63 94 / 0.16)', softFg: '#fda4af' },
  P1: { label: 'P1', softBg: 'rgb(244 114 182 / 0.16)', softFg: '#f9a8d4' },
  P2: { label: 'P2', softBg: 'rgb(148 163 184 / 0.16)', softFg: '#cbd5e1' },
  P3: { label: 'P3', softBg: 'rgb(100 116 139 / 0.16)', softFg: '#94a3b8' },
};

export const BLOCKED_REASON_THEME: Record<BlockedReason, BlockedTheme> = {
  retry_limit: { label: 'retry limit', softBg: 'rgb(251 113 133 / 0.16)', softFg: '#fecdd3' },
  no_progress: { label: 'no progress', softBg: 'rgb(251 113 133 / 0.16)', softFg: '#fecdd3' },
  quota: { label: 'quota', softBg: 'rgb(251 191 36 / 0.16)', softFg: '#fcd34d' },
  provider_down: { label: 'provider down', softBg: 'rgb(251 191 36 / 0.16)', softFg: '#fcd34d' },
  auth: { label: 'auth', softBg: 'rgb(251 113 133 / 0.16)', softFg: '#fecdd3' },
  conflict: { label: 'conflict', softBg: 'rgb(251 191 36 / 0.16)', softFg: '#fcd34d' },
  permission_denied: { label: 'permission denied', softBg: 'rgb(251 113 133 / 0.16)', softFg: '#fecdd3' },
  reviewer_blocked: { label: 'reviewer blocked', softBg: 'rgb(251 113 133 / 0.16)', softFg: '#fecdd3' },
  post_merge_failed: { label: 'post merge failed', softBg: 'rgb(251 113 133 / 0.18)', softFg: '#fecdd3' },
  interrupted: { label: 'interrupted', softBg: 'rgb(251 191 36 / 0.16)', softFg: '#fcd34d' },
  invalid_agent_output: { label: 'invalid agent output', softBg: 'rgb(251 113 133 / 0.16)', softFg: '#fecdd3' },
  model_limit: { label: 'model limit', softBg: 'rgb(251 191 36 / 0.16)', softFg: '#fcd34d' },
  environment: { label: 'environment', softBg: 'rgb(251 191 36 / 0.16)', softFg: '#fcd34d' },
};

/** Guards against a contract enum gaining a member without a theme entry. */
export const ALL_STATUSES: readonly StoryStatus[] = STORY_STATUS;
export const ALL_PRIORITIES: readonly Priority[] = PRIORITY;
export const ALL_BLOCKED_REASONS: readonly BlockedReason[] = BLOCKED_REASON;
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
npx vitest run apps/ui/test/status-theme.test.ts
```

Expected: PASS — 6 tests passed.

- [ ] **Step 5: Run the gate and commit**

```bash
npm run check:pins && npm run lint && npm run typecheck && npm test
```

Commit:

```bash
git add apps/ui/src/lib/status-theme.ts apps/ui/test/status-theme.test.ts
git commit -m "feat(ui): add the status theme map as the single source of truth

Ten story statuses, four priorities and thirteen blocked reasons each get
one signature colour, sourced from a single module so columns, cards,
badges and CTAs can never drift apart."
```

---

### Task 4: The primitive library

**Files:**
- Modify: `apps/ui/src/components/ui/button.tsx`
- Modify: `apps/ui/src/components/ui/badge.tsx`
- Modify: `apps/ui/src/components/ui/field.tsx`
- Create: `apps/ui/src/components/ui/card.tsx`
- Create: `apps/ui/src/components/ui/input.tsx`
- Create: `apps/ui/src/components/ui/textarea.tsx`
- Create: `apps/ui/src/components/ui/select.tsx`
- Create: `apps/ui/src/components/ui/label.tsx`
- Create: `apps/ui/src/components/ui/separator.tsx`
- Create: `apps/ui/src/components/ui/skeleton.tsx`

**Interfaces:**
- Consumes: `cn` from `../../lib/cn.ts`; `STATUS_THEME`, `PRIORITY_THEME` from `../../lib/status-theme.ts`.
- Produces (public APIs that later tasks rely on):
  - `Button({ variant?: 'primary'|'secondary'|'danger'|'ghost', size?: 'sm'|'md', className?, ...props })` — `variant` and `size` both optional; `variant` defaults to `'secondary'`.
  - `Badge({ tone?: 'default'|'muted'|'warn'|'danger'|'ok'|'status', status?: StoryStatus, priority?: Priority, className?, ...props })`.
  - `Card({ className?, children, ...props })`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter`.
  - `Input`, `Textarea`, `Select`, `Label` — each accepts `className` and spreads the rest onto the native element.
  - `TextField({ label, ...props })` and `TextArea({ label, ...props })` — unchanged public API, now built on `Input`/`Textarea`.
  - `Separator({ orientation?: 'horizontal'|'vertical', className? })`.
  - `Skeleton({ className? })`.

- [ ] **Step 1: Write the failing e2e assertion**

Append to `e2e/tests/appearance.spec.ts` (inside the existing `describe`-less file, at the end):

```ts
test('the primary button uses the accent gradient, not flat indigo', async () => {
  const { page } = launched;
  await openBoard(page);
  const button = page.getByTestId('new-story');
  const image = await button.evaluate((el) => getComputedStyle(el).backgroundImage);
  expect(image).toContain('gradient');
});
```

- [ ] **Step 2: Run the e2e test to verify it fails**

Run:

```bash
npm run build && npm run e2e -- appearance
```

Expected: FAIL — the old `Button` uses `bg-indigo-600`, whose computed `background-image` is `none`.

- [ ] **Step 3: Rebuild `button.tsx`**

Replace `apps/ui/src/components/ui/button.tsx`:

```tsx
import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/cn.ts';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 rounded-control font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      variant: {
        primary:
          'bg-gradient-to-br from-accent to-accent-2 text-accent-foreground shadow-[0_6px_16px_-6px_rgb(109_94_252/0.85)] hover:brightness-110',
        secondary:
          'border border-border bg-surface-2 text-foreground hover:bg-surface-3 hover:border-border-strong',
        danger:
          'border border-danger/40 bg-danger/15 text-danger-foreground hover:bg-danger/25',
        ghost: 'text-muted hover:bg-surface-2 hover:text-foreground',
      },
      size: {
        sm: 'px-2.5 py-1 text-xs',
        md: 'px-3 py-1.5 text-sm',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export function Button({ variant, size, className = '', type = 'button', ...props }: ButtonProps) {
  return <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
```

- [ ] **Step 4: Rebuild `badge.tsx`**

Replace `apps/ui/src/components/ui/badge.tsx`:

```tsx
import type { HTMLAttributes } from 'react';
import type { Priority, StoryStatus } from '@aik/contracts';
import { cn } from '../../lib/cn.ts';
import { PRIORITY_THEME, STATUS_THEME } from '../../lib/status-theme.ts';

type Tone = 'default' | 'muted' | 'warn' | 'danger' | 'ok' | 'status';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  /** Renders the badge in the status colour when `tone="status"`. */
  status?: StoryStatus;
  /** Renders the badge in the priority colour when set. */
  priority?: Priority;
}

const TONES: Record<Exclude<Tone, 'status'>, string> = {
  default: 'bg-accent/15 text-accent-foreground',
  muted: 'bg-surface-3 text-muted',
  warn: 'bg-warning/15 text-warning-foreground',
  danger: 'bg-danger/15 text-danger-foreground',
  ok: 'bg-success/15 text-success-foreground',
};

export function Badge({ tone = 'default', status, priority, className = '', style, children, ...props }: BadgeProps) {
  const priorityTheme = priority ? PRIORITY_THEME[priority] : null;
  const statusTheme = status ? STATUS_THEME[status] : null;
  const base = cn(
    'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-semibold leading-none',
    className,
  );
  if (priorityTheme) {
    return (
      <span className={base} style={{ background: priorityTheme.softBg, color: priorityTheme.softFg, ...style }} {...props}>
        {priorityTheme.label}
      </span>
    );
  }
  if (statusTheme) {
    return (
      <span className={base} style={{ background: statusTheme.softBg, color: statusTheme.softFg, ...style }} {...props}>
        {statusTheme.label}
      </span>
    );
  }
  // `tone="status"` without a status prop falls back to the default tone.
  const toneClass = TONES[tone === 'status' ? 'default' : tone];
  return (
    <span className={cn(base, toneClass)} style={style} {...props}>
      {children}
    </span>
  );
}
```

- [ ] **Step 5: Create the remaining primitives**

Create `apps/ui/src/components/ui/card.tsx`:

```tsx
import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/cn.ts';

export function Card({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'relative rounded-panel border border-glass-border bg-glass shadow-card',
        'before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-white/10',
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1 p-4 pb-2', className)} {...props} />;
}

export function CardTitle({ className = '', ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn('text-sm font-semibold text-foreground', className)} {...props} />;
}

export function CardDescription({ className = '', ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-xs text-muted', className)} {...props} />;
}

export function CardContent({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-4 pt-2', className)} {...props} />;
}

export function CardFooter({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex items-center gap-2 p-4 pt-2', className)} {...props} />;
}
```

Create `apps/ui/src/components/ui/input.tsx`:

```tsx
import type { InputHTMLAttributes } from 'react';
import { cn } from '../../lib/cn.ts';

export function Input({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'w-full rounded-control border border-border bg-surface-3 px-2.5 py-1.5 text-sm text-foreground',
        'placeholder:text-muted-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}
```

Create `apps/ui/src/components/ui/textarea.tsx`:

```tsx
import type { TextareaHTMLAttributes } from 'react';
import { cn } from '../../lib/cn.ts';

export function Textarea({ className = '', ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        'w-full min-h-20 rounded-control border border-border bg-surface-3 px-2.5 py-1.5 text-sm text-foreground',
        'placeholder:text-muted-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}
```

Create `apps/ui/src/components/ui/select.tsx`:

```tsx
import type { SelectHTMLAttributes } from 'react';
import { cn } from '../../lib/cn.ts';

export function Select({ className = '', children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        'w-full appearance-none rounded-control border border-border bg-surface-3 px-2.5 py-1.5 text-sm text-foreground',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}
```

Create `apps/ui/src/components/ui/label.tsx`:

```tsx
import type { LabelHTMLAttributes } from 'react';
import { cn } from '../../lib/cn.ts';

export function Label({ className = '', ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('text-sm font-medium text-foreground', className)} {...props} />;
}
```

Create `apps/ui/src/components/ui/separator.tsx`:

```tsx
import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/cn.ts';

export function Separator({
  orientation = 'horizontal',
  className = '',
  ...props
}: HTMLAttributes<HTMLDivElement> & { orientation?: 'horizontal' | 'vertical' }) {
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      className={cn(
        'bg-border',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
        className,
      )}
      {...props}
    />
  );
}
```

Create `apps/ui/src/components/ui/skeleton.tsx`:

```tsx
import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/cn.ts';

export function Skeleton({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('animate-pulse rounded-md bg-surface-3', className)} {...props} />;
}
```

- [ ] **Step 6: Rebuild `field.tsx` on top of the new controls**

Replace `apps/ui/src/components/ui/field.tsx`:

```tsx
import { useId, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { Input } from './input.tsx';
import { Label } from './label.tsx';
import { Textarea } from './textarea.tsx';

export function TextField({ label, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} {...props} />
    </div>
  );
}

export function TextArea({ label, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Textarea id={id} {...props} />
    </div>
  );
}
```

- [ ] **Step 7: Run the gate**

Run:

```bash
npm run check:pins && npm run lint && npm run typecheck && npm test && npm run build && npm run e2e
```

Expected: all unit tests pass, and the new appearance assertion passes. The frozen specs must also still pass:

```bash
npm run check:pins && npm run lint && npm run typecheck && npm test && npm run build && npm run e2e
```

Expected: everything green — `appearance.spec.ts`, `board.spec.ts`, `dashboard.spec.ts`, `lifecycle.spec.ts`, `security.spec.ts`. The primitives changed but no test id, accessible name or role changed, so the frozen specs are unaffected.

- [ ] **Step 8: Commit**

```bash
git add apps/ui/src/components/ui
git commit -m "feat(ui): rebuild the primitive library on the Aurora token set

Button, badge, card, input, textarea, select, label, separator and skeleton
now read the semantic tokens instead of hard-coded zinc classes. The public
APIs are unchanged: Button keeps variant=primary|secondary|danger|ghost,
Badge keeps tone=default|muted|warn|danger|ok and TextField/TextArea keep
their label props."
```

---

## Phase 2 — Shell

### Task 5: The app shell

**Files:**
- Create: `apps/ui/src/components/shell/app-shell.tsx`
- Create: `apps/ui/src/components/shell/sidebar.tsx`
- Create: `apps/ui/src/components/shell/top-bar.tsx`
- Create: `apps/ui/src/components/shell/status-card.tsx`
- Modify: `apps/ui/src/routes/root.tsx`

**Interfaces:**
- Consumes: `STATUS_THEME` (sidebar project dots use the project's own state, not a story status — use `--success` / `--warning` directly); `cn`.
- Produces:
  - `AppShell({ projects, orchestratorState, dataDir, children }: { projects: ProjectDTO[]; orchestratorState: string; dataDir: string | null; children: ReactNode })` — renders the sidebar and the content region.
  - `Sidebar({ projects, orchestratorState, dataDir }: { projects: ProjectDTO[]; orchestratorState: string; dataDir: string | null })`.
  - `TopBar({ title, subtitle, children, ...props }: TopBarProps)` — the glass page header. `TopBarProps` extends `Omit<HTMLAttributes<HTMLElement>, 'title'>` with `title: string` and `subtitle?: string`. Extra props (for example `data-testid="board-toolbar"`) are spread onto the `<header>`.
  - `StatusCard({ state, dataDir }: { state: string; dataDir: string | null })`.
  - The sidebar project list uses `data-testid="sidebar-project-list"` and its links carry `aria-label={`Open ${p.name}`}` — **not** `project-list`, and **not** the name `INV · Inventory` (see E2–E4).

- [ ] **Step 1: Write the failing e2e assertion**

Append to `e2e/tests/appearance.spec.ts`:

```ts
test('the app shell renders a sidebar with navigation and an orchestrator card', async () => {
  const { page } = launched;
  await expect(page.getByTestId('app-sidebar')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Projects' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible();
  await expect(page.getByTestId('orchestrator-card')).toBeVisible();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build && npm run e2e -- appearance`
Expected: FAIL — `app-sidebar` test id does not exist.

- [ ] **Step 3: Create `status-card.tsx`**

Create `apps/ui/src/components/shell/status-card.tsx`:

```tsx
import { cn } from '../../lib/cn.ts';

export function StatusCard({ state, dataDir }: { state: string; dataDir: string | null }) {
  const ready = state === 'ready';
  return (
    <div data-testid="orchestrator-card" className="rounded-card border border-border bg-surface-3 p-3">
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className={cn('h-2 w-2 rounded-full', ready ? 'bg-success shadow-[0_0_8px_var(--success)]' : 'bg-warning')}
        />
        <span className={cn('text-xs font-semibold', ready ? 'text-success-foreground' : 'text-warning-foreground')}>
          orchestrator {state}
        </span>
      </div>
      {dataDir && <p className="mt-1.5 truncate font-mono text-[10px] text-muted-2" title={dataDir}>{dataDir}</p>}
    </div>
  );
}
```

- [ ] **Step 4: Create `sidebar.tsx`**

Create `apps/ui/src/components/shell/sidebar.tsx`:

```tsx
import type { ProjectDTO } from '@aik/contracts';
import { Link } from '@tanstack/react-router';
import { cn } from '../../lib/cn.ts';
import { StatusCard } from './status-card.tsx';

export interface SidebarProps {
  projects: ProjectDTO[];
  orchestratorState: string;
  dataDir: string | null;
}

export function Sidebar({ projects, orchestratorState, dataDir }: SidebarProps) {
  return (
    <aside
      data-testid="app-sidebar"
      className="flex w-[212px] shrink-0 flex-col gap-3 border-r border-border bg-surface p-3 backdrop-blur-[14px]"
    >
      <div className="flex items-center gap-2 px-1 pb-1">
        <span
          aria-hidden="true"
          className="h-5 w-5 rounded-[7px] bg-gradient-to-br from-[#a78bfa] via-[#6366f1] to-[#22d3ee] shadow-[0_0_0_3px_rgb(139_92_246/0.2)]"
        />
        <span className="block">
          <span className="block text-sm font-bold tracking-tight text-foreground">AI Kanban</span>
          <span className="block text-[10px] text-muted-2">desktop</span>
        </span>
      </div>

      <nav aria-label="Main" className="flex flex-col gap-0.5">
        <Link
          to="/"
          className={cn(
            'rounded-control px-2 py-1.5 text-sm font-semibold text-muted transition-colors hover:bg-surface-2 hover:text-foreground',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          )}
        >
          Projects
        </Link>
        <Link
          to="/settings"
          className={cn(
            'rounded-control px-2 py-1.5 text-sm font-semibold text-muted transition-colors hover:bg-surface-2 hover:text-foreground',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          )}
        >
          Settings
        </Link>
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <p className="px-1 pb-1 pt-2 text-[10px] font-bold uppercase tracking-[0.1em] text-muted-2">
          Your projects
        </p>
        {/*
          E2/E3: this link's accessible name is deliberately NOT "INV · Inventory" —
          the dashboard card owns that exact name and Playwright fails on two matches.
          The visible text still reads "INV · Inventory".
        */}
        <ul data-testid="sidebar-project-list" className="flex flex-col gap-0.5">
          {projects.map((p) => (
            <li key={p.id}>
              <Link
                to="/projects/$projectId"
                params={{ projectId: String(p.id) }}
                aria-label={`Open ${p.name}`}
                className={cn(
                  'flex items-center gap-2 rounded-control px-2 py-1.5 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-foreground',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                )}
              >
                <span className="rounded-[5px] border border-accent/25 bg-accent/15 px-1 py-px font-mono text-[10px] font-bold text-accent-foreground">
                  {p.key}
                </span>
                <span className="truncate">{` · ${p.name}`}</span>
                {p.status === 'unavailable' && (
                  <span aria-label="unavailable" className="ml-auto h-1.5 w-1.5 rounded-full bg-warning" />
                )}
              </Link>
            </li>
          ))}
        </ul>
      </div>

      <StatusCard state={orchestratorState} dataDir={dataDir} />
    </aside>
  );
}
```

**Note:** the e2e suite locates the project link by the exact accessible name `INV · Inventory`. The markup above renders the key and the name in two separate spans, which yields the accessible name `INV Inventory` — **not** `INV · Inventory`. To preserve the frozen contract, render the project name as a single text node:

Replace the `<Link>` body with:

```tsx
<span className="rounded-[5px] border border-accent/25 bg-accent/15 px-1 py-px font-mono text-[10px] font-bold text-accent-foreground">
  {p.key}
</span>
<span className="truncate">{` · ${p.name}`}</span>
```

so the link's accessible name is exactly `INV · Inventory`.

- [ ] **Step 5: Create `top-bar.tsx`**

Create `apps/ui/src/components/shell/top-bar.tsx`:

```tsx
import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/cn.ts';

export interface TopBarProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title: string;
  subtitle?: string;
}

/**
 * The glass page header. Each route renders its own — the board puts its search,
 * filters and "New story" in `children`; the dashboard and settings put nothing.
 * There is deliberately no decorative search field: a ⌘K affordance that does
 * nothing is worse than none, and the board already owns a real one.
 */
export function TopBar({ title, subtitle, className = '', children, ...props }: TopBarProps) {
  return (
    <header
      className={cn(
        'flex flex-wrap items-center gap-2.5 border-b border-border bg-surface/60 px-4 py-2.5 backdrop-blur-[12px]',
        className,
      )}
      {...props}
    >
      <h1 className="text-base font-bold tracking-tight text-foreground">
        {title}
        {subtitle && <span className="ml-2 text-xs font-medium text-muted-2">{subtitle}</span>}
      </h1>
      {children}
    </header>
  );
}
```

- [ ] **Step 6: Create `app-shell.tsx`**

Create `apps/ui/src/components/shell/app-shell.tsx`:

```tsx
import type { ProjectDTO } from '@aik/contracts';
import type { ReactNode } from 'react';
import { Sidebar } from './sidebar.tsx';

export interface AppShellProps {
  projects: ProjectDTO[];
  orchestratorState: string;
  dataDir: string | null;
  children: ReactNode;
}

export function AppShell({ projects, orchestratorState, dataDir, children }: AppShellProps) {
  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <Sidebar projects={projects} orchestratorState={orchestratorState} dataDir={dataDir} />
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</main>
    </div>
  );
}
```

- [ ] **Step 7: Rewrite `root.tsx` to use the shell**

Replace `apps/ui/src/routes/root.tsx`:

```tsx
import type { ProjectDTO, SystemState } from '@aik/contracts';
import { Outlet } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { AppShell } from '../components/shell/app-shell.tsx';
import { Button } from '../components/ui/button.tsx';
import { ToastProvider } from '../components/ui/toast.tsx';
import { api } from '../lib/api.ts';
import { useSystemState } from '../lib/events.ts';

export interface Health {
  status: string;
  versions: { app: string; electron: string | null; node: string; opencode: string | null };
  components: { db: string };
  dataDir: string;
}

function SystemFailure({ system }: { system: SystemState }) {
  const [note, setNote] = useState<string | null>(null);
  const corrupt = system.state === 'fatal' && system.fatal?.kind === 'database_corrupt';
  return (
    <div
      data-testid="system-failure"
      role="alert"
      className="m-4 rounded-card border border-danger/40 bg-danger/10 p-4 text-danger-foreground"
    >
      {system.state === 'crash-loop' ? (
        <>
          <p className="font-semibold">The orchestrator keeps crashing.</p>
          <p className="text-sm">See logs\orchestrator.log and logs\orchestrator-stdio.log in the data folder.</p>
          <Button className="mt-2" onClick={() => void window.api.restartOrchestrator()}>Try again</Button>
        </>
      ) : (
        <>
          <p className="font-semibold">The orchestrator could not start.</p>
          <p className="text-sm">{system.fatal?.message}</p>
          {corrupt && (
            <Button
              className="mt-2"
              variant="primary"
              onClick={async () => {
                const r = await window.api.restoreLatestBackup();
                setNote(r.ok ? `Restored ${r.restoredFrom}` : r.reason);
              }}
            >
              Restore latest backup
            </Button>
          )}
          {note && <p className="mt-2 text-sm">{note}</p>}
        </>
      )}
    </div>
  );
}

export function RootLayout() {
  const system = useSystemState();
  const [health, setHealth] = useState<Health | null>(null);
  const [projects, setProjects] = useState<ProjectDTO[]>([]);

  useEffect(() => {
    if (system.state !== 'ready') return;
    let alive = true;
    api.get<Health>('/health').then(
      (h) => alive && setHealth(h),
      () => alive && setHealth(null),
    );
    return () => {
      alive = false;
    };
  }, [system.state]);

  useEffect(() => {
    if (system.state !== 'ready') return;
    let alive = true;
    api.get<ProjectDTO[]>('/projects').then(
      (p) => alive && setProjects(p),
      () => alive && setProjects([]),
    );
    return () => {
      alive = false;
    };
  }, [system.state]);

  return (
    <ToastProvider>
      <AppShell projects={projects} orchestratorState={system.state} dataDir={health?.dataDir ?? null}>
        {(system.state === 'fatal' || system.state === 'crash-loop') && <SystemFailure system={system} />}
        {health && <div data-testid="app-ready" hidden />}
        <div className="min-h-0 flex-1 overflow-auto">
          <Outlet />
        </div>
      </AppShell>
    </ToastProvider>
  );
}
```

- [ ] **Step 8: Run the gate**

```bash
npm run check:pins && npm run lint && npm run typecheck && npm test && npm run build && npm run e2e
```

Expected: everything passes, including `board.spec.ts` (which navigates Settings → Projects → project link). **If `board.spec.ts` fails on `getByRole('link', { name: /^INV · Inventory$/ })`, the sidebar link's accessible name is wrong — apply the note in Step 4.**

- [ ] **Step 9: Commit**

```bash
git add apps/ui/src/components/shell apps/ui/src/routes/root.tsx
git commit -m "feat(ui): replace the top bar with a glass app shell

A sidebar carries navigation, the project list and a live orchestrator
status card; the content area gains a compact top bar. The project link's
accessible name stays exactly 'INV · Inventory' so the board e2e flow is
unchanged."
```

---

### Task 6: The projects page

**Files:**
- Modify: `apps/ui/src/routes/dashboard.tsx`

**Interfaces:**
- Consumes: `AppShell` children region; `TopBar`, `Button`, `TextField`, `Badge`, `Card`.
- Produces: no new exports. `DashboardPage` keeps its name and its route (`/`). The card grid carries `data-testid="project-list"` (E4); each card carries `data-testid={`project-card-${p.key}`}`.

- [ ] **Step 1: Write the failing e2e assertion**

Append to `e2e/tests/appearance.spec.ts`:

```ts
test('the projects page renders glass project cards', async () => {
  const { page } = launched;
  await page.getByRole('link', { name: 'Projects' }).click();
  await expect(page.getByTestId('project-card-INV')).toBeVisible();
  await expect(page.getByTestId('project-card-INV')).toContainText('Inventory');
  // E4: the project list must contain the full label and the base branch.
  await expect(page.getByTestId('project-list')).toContainText('INV · Inventory');
  await expect(page.getByTestId('project-list')).toContainText('main');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build && npm run e2e -- appearance`
Expected: FAIL — `project-card-INV` does not exist yet. (`project-list` exists after Task 5, but on the sidebar under a different test id — so `getByTestId('project-list')` also fails to resolve until Step 3.)

The `project-card-<key>` test id does not exist yet, so this fails.

- [ ] **Step 3: Rewrite `dashboard.tsx`**

Replace `apps/ui/src/routes/dashboard.tsx`:

```tsx
import type { ProjectDTO } from '@aik/contracts';
import { Link } from '@tanstack/react-router';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { TopBar } from '../components/shell/top-bar.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card } from '../components/ui/card.tsx';
import { TextField } from '../components/ui/field.tsx';
import { ApiRequestError, api } from '../lib/api.ts';
import { useSystemState } from '../lib/events.ts';

/** Best-effort project identity from a repository folder path; the form fields stay editable. */
function suggestIdentity(folder: string): { name: string; key: string } {
  const parts = folder.split(/[\\/]/).filter(Boolean);
  const base = parts.length > 0 ? (parts[parts.length - 1] ?? '') : '';
  const cleaned = base.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^[0-9]+/, '').slice(0, 10);
  return { name: base, key: cleaned.length >= 2 ? cleaned : '' };
}

function CreateProjectForm({ onCreated }: { onCreated: () => Promise<void> }) {
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const applyRepoPath = (v: string) => {
    setRepoPath(v);
    const suggestion = suggestIdentity(v);
    if (!name && suggestion.name) setName(suggestion.name);
    if (!key && suggestion.key) setKey(suggestion.key);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/projects', { name, key, repoPath });
      setName('');
      setKey('');
      setRepoPath('');
      await onCreated();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.reason : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mt-4 p-4">
      <h2 className="text-sm font-semibold text-foreground">Add a local repository</h2>
      <form onSubmit={submit} className="mt-3 flex flex-col gap-3">
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
        <TextField label="Key" value={key} onChange={(e) => setKey(e.target.value.toUpperCase())} placeholder="INV" required />
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <TextField label="Repository folder" value={repoPath} onChange={(e) => applyRepoPath(e.target.value)} required />
          </div>
          <Button onClick={async () => {
            const dir = await window.api.pickDirectory();
            if (dir) applyRepoPath(dir);
          }}>
            Browse…
          </Button>
        </div>
        {error && <p role="alert" data-testid="project-error" className="text-sm text-danger-foreground">{error}</p>}
        <Button type="submit" variant="primary" disabled={busy} className="self-start">Add project</Button>
      </form>
    </Card>
  );
}

export function DashboardPage() {
  const [projects, setProjects] = useState<ProjectDTO[]>([]);
  const system = useSystemState();
  const load = useCallback(async () => {
    try {
      setProjects(await api.get<ProjectDTO[]>('/projects'));
    } catch {
      setProjects([]);
    }
  }, []);
  useEffect(() => {
    if (system.state === 'ready') void load();
  }, [system.state, load]);

  return (
    <div className="flex h-full flex-col">
      {/*
        E5: exactly one heading named "Projects". The sidebar's "Projects" is a link,
        so it does not collide.
      */}
      <TopBar title="Projects" subtitle="Local repositories this orchestrator can plan, implement and merge into." />
      <div className="mx-auto w-full max-w-5xl flex-1 p-6">
        {/*
          E4: `project-list` must exist exactly once and contain both the full
          "KEY · name" label and the base branch.
        */}
        <div data-testid="project-list" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <Card key={p.id} data-testid={`project-card-${p.key}`} className="p-4">
              <Link
                to="/projects/$projectId"
                params={{ projectId: String(p.id) }}
                className="flex items-baseline gap-1.5 text-sm font-semibold text-foreground hover:underline"
              >
                <span className="rounded-[5px] border border-accent/25 bg-accent/15 px-1.5 py-px font-mono text-[10px] font-bold text-accent-foreground">
                  {p.key}
                </span>
                <span className="truncate">{` · ${p.name}`}</span>
              </Link>
              <p className="mt-2 truncate font-mono text-xs text-muted-2" title={p.repoPath}>
                {p.repoPath}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <Badge tone="muted">{p.baseBranch}</Badge>
                {p.status === 'unavailable' ? <Badge tone="warn">unavailable</Badge> : <Badge tone="ok">ready</Badge>}
              </div>
            </Card>
          ))}
        </div>

        <CreateProjectForm onCreated={load} />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the gate**

```bash
npm run check:pins && npm run lint && npm run typecheck && npm test && npm run build && npm run e2e
```

Expected: all green. `dashboard.spec.ts` must still pass — it locates the project link by the name `INV · Inventory` (E2/E3), and `project-list` must contain both that label and the base branch `main` (E4). Both are satisfied by the markup in Step 3: the card link renders `{p.key}` and `` {` · ${p.name}`} `` as adjacent spans, so its text is exactly `INV · Inventory`, and the base-branch chip renders `main`.

If `dashboard.spec.ts` fails with a strict-mode violation on `getByRole('link', { name: 'INV · Inventory' })`, the sidebar link has taken the same accessible name — check that it still carries `aria-label={`Open ${p.name}`}`.

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/routes/dashboard.tsx
git commit -m "feat(ui): restyle the projects page as glass project cards

Project cards show the key badge, name, repository path, base branch and
readiness. The project link keeps its exact accessible name so the
dashboard e2e selector is unchanged."
```

---

### Task 7: The settings page

**Files:**
- Modify: `apps/ui/src/routes/settings.tsx`

**Interfaces:**
- Consumes: `Card`, `Button`, `Select`, `Textarea`, `Label`, `Badge`, `cn`; `applyTheme`/`loadTheme` (unchanged API).
- Produces: no new exports. `SettingsPage` keeps its name and route.

- [ ] **Step 1: Write the failing e2e assertion**

Append to `e2e/tests/appearance.spec.ts`:

```ts
test('settings groups the runtime controls into cards', async () => {
  const { page } = launched;
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByTestId('settings-appearance')).toBeVisible();
  await expect(page.getByTestId('settings-runtime')).toBeVisible();
  await expect(page.getByTestId('settings-about')).toBeVisible();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build && npm run e2e -- appearance`
Expected: FAIL — `settings-appearance` does not exist.

- [ ] **Step 3: Rewrite `settings.tsx`**

Replace `apps/ui/src/routes/settings.tsx`:

```tsx
import { useEffect, useState } from 'react';
import type { OpencodeModelInfo, OpencodeStatus } from '@aik/contracts';
import { TopBar } from '../components/shell/top-bar.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card } from '../components/ui/card.tsx';
import { Label } from '../components/ui/label.tsx';
import { Select } from '../components/ui/select.tsx';
import { Textarea } from '../components/ui/textarea.tsx';
import { cn } from '../lib/cn.ts';
import { api } from '../lib/api.ts';
import { applyTheme, loadTheme, type Theme } from '../lib/theme.ts';
import type { Health } from './root.tsx';

const MODEL_STORAGE_KEY = 'aik:default-model';

function loadSavedModel(): { providerID: string; id: string } | null {
  try {
    const raw = localStorage.getItem(MODEL_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as { providerID: string; id: string }) : null;
  } catch {
    return null;
  }
}

/**
 * A radio group whose inputs are REAL and VISIBLE.
 *
 * `dashboard.spec.ts` calls `getByLabel(/App-managed OpenCode/).check()`, and
 * `check()` only works on a real `<input type="radio">` with an associated
 * label (E6). A `role="radio"` button has no label association and would fail.
 */
function RadioChips<T extends string>({
  name,
  value,
  options,
  onChange,
}: {
  name: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (next: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={name} className="flex flex-col gap-1.5">
      {options.map((o) => (
        <label
          key={o.value}
          className={cn(
            'flex cursor-pointer items-center gap-2 rounded-control border px-2.5 py-1.5 text-xs transition-colors',
            value === o.value
              ? 'border-accent/50 bg-accent/10 text-foreground'
              : 'border-border bg-surface-3 text-muted hover:text-foreground',
          )}
        >
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={value === o.value}
            onChange={() => onChange(o.value)}
            className="h-3.5 w-3.5 shrink-0 appearance-none rounded-full border border-border-strong bg-surface-2 checked:border-accent checked:bg-accent"
          />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}

function ModelPicker({ status }: { status: OpencodeStatus | null }) {
  const [models, setModels] = useState<OpencodeModelInfo[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [login, setLogin] = useState<{ code: string } | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [mode, setMode] = useState<'managed' | 'personal'>('managed');
  const [modeBusy, setModeBusy] = useState(false);
  const [selected, setSelected] = useState(() => {
    const saved = loadSavedModel();
    return saved ? `${saved.providerID}/${saved.id}` : '';
  });
  const [prompt, setPrompt] = useState('Reply with one short sentence about yourself.');
  const [reply, setReply] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    setModelsError(null);
    const result = await window.api.opencodeModels();
    if (result.ok) {
      setModels(result.models);
      setSelected((current) => {
        const exists = current ? result.models.find((m) => `${m.providerID}/${m.id}` === current) : null;
        if (exists && (exists.providerID !== 'opencode' || !result.models.some((m) => m.providerID !== 'opencode'))) {
          return current;
        }
        const first = result.models[0];
        if (!first) return current;
        localStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify({ providerID: first.providerID, id: first.id }));
        return `${first.providerID}/${first.id}`;
      });
    } else {
      setModels(null);
      setModelsError(result.error);
    }
  };

  useEffect(() => {
    if (status?.installed || mode === 'personal') {
      void refresh();
      void window.api.opencodeSignedIn().then(setSignedIn, () => setSignedIn(null));
    }
  }, [status?.installed, mode]);

  useEffect(() => {
    void window.api.getAppSettings().then((s) => setMode(s.opencodeMode), () => undefined);
  }, []);

  const switchMode = async (next: 'managed' | 'personal') => {
    if (next === mode || modeBusy) return;
    setModeBusy(true);
    setLogin(null);
    setLoginError(null);
    const saved = await window.api.setAppSettings({ opencodeMode: next });
    setMode(saved.opencodeMode);
    setSignedIn(null);
    setModels(null);
    setSelected('');
    localStorage.removeItem(MODEL_STORAGE_KEY);
    await refresh();
    void window.api.opencodeSignedIn().then(setSignedIn, () => setSignedIn(null));
    setModeBusy(false);
  };

  const startLogin = async () => {
    setLoginError(null);
    const start = await window.api.opencodeLoginStart();
    if (!start.ok) {
      setLoginError(start.error);
      return;
    }
    setLogin({ code: start.code });
    const done = await window.api.opencodeLoginWait();
    setLogin(null);
    if (!done.ok) {
      setLoginError(done.error);
      return;
    }
    setSignedIn(true);
  };

  const send = async () => {
    const [providerID = '', id = ''] = selected.split('/');
    if (!providerID || !id) return;
    setBusy(true);
    setReply(null);
    const result = await window.api.opencodeChat({ providerID, id }, prompt);
    setReply(result.ok ? result.text : `✗ ${result.error}`);
    setBusy(false);
  };

  return (
    <Card data-testid="settings-model" className="mt-4 p-4">
      <h2 className="text-sm font-semibold text-foreground">Default model</h2>
      <div className="mt-3 flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="opencode-mode">OpenCode runtime</Label>
          <RadioChips
            name="opencode-mode"
            value={mode}
            options={[
              { value: 'managed', label: `App-managed OpenCode (isolated — pinned ${status?.pinned ?? '…'})` },
              {
                value: 'personal',
                label: 'Use my personal OpenCode CLI (synced with your terminal CLI, login, providers and sessions)',
              },
            ]}
            onChange={(next) => void switchMode(next)}
          />
          {modeBusy && <p className="text-xs text-muted">Switching…</p>}
          {mode === 'personal' && (
            <p className="text-xs text-muted">
              Personal mode uses the <code>opencode</code> on your system, syncing sessions, providers and models with your terminal CLI.
            </p>
          )}
          <p className="text-xs text-muted">
            App-managed mode installs an isolated OpenCode pinned to the version this app was tested against.
          </p>
        </div>

        {status?.installed && signedIn === false && (
          <div className="flex flex-col items-start gap-2">
            <p className="text-sm">Sign in to use the free gateway models.</p>
            <Button variant="primary" disabled={login !== null} onClick={() => void startLogin()}>
              {login ? 'Waiting for sign-in…' : 'Sign in to OpenCode (free)'}
            </Button>
            {login && (
              <p className="text-sm" data-testid="opencode-login-code">
                {login.code} — complete it in the browser that just opened.
              </p>
            )}
            {loginError && <p role="alert" className="text-sm text-danger-foreground">{loginError}</p>}
          </div>
        )}
        {status?.installed && modelsError && (
          <p role="alert" className="text-sm text-danger-foreground">{modelsError}</p>
        )}
        {status?.installed && models && models.length > 0 && (
          <>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="default-model">Default model</Label>
              {/*
                E8: the <Label htmlFor> is the label association — do not also set
                aria-label on the same control, or the label resolves twice.
              */}
              <Select
                id="default-model"
                value={selected || `${models[0]?.providerID ?? ''}/${models[0]?.id ?? ''}`}
                onChange={(e) => {
                  setSelected(e.target.value);
                  const [providerID = '', id = ''] = e.target.value.split('/');
                  localStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify({ providerID, id }));
                }}
              >
                {models.map((m) => (
                  <option key={`${m.providerID}/${m.id}`} value={`${m.providerID}/${m.id}`}>
                    {m.name} · {m.providerID}/{m.id}{m.free ? ' · free' : ''}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="test-prompt">Test prompt</Label>
              <Textarea
                id="test-prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={2}
              />
            </div>
            <div className="flex items-center gap-2">
              <Button variant="primary" disabled={busy || (!selected && models.length === 0)} onClick={() => void send()}>
                {busy ? 'Asking…' : 'Send test prompt'}
              </Button>
              <Button disabled={busy} onClick={() => void refresh()}>Refresh models</Button>
            </div>
            {reply && (
              <p data-testid="model-test-reply" className="whitespace-pre-wrap rounded-control bg-surface-3 p-2 text-sm">
                {reply}
              </p>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

export function SettingsPage() {
  const [theme, setTheme] = useState<Theme>(loadTheme());
  const [health, setHealth] = useState<Health | null>(null);
  const [opencode, setOpencode] = useState<OpencodeStatus | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  useEffect(() => {
    void api.get<Health>('/health').then(setHealth, () => setHealth(null));
    void window.api.opencodeStatus().then(setOpencode, () => setOpencode(null));
  }, []);

  const install = async () => {
    setInstalling(true);
    setInstallError(null);
    const result = await window.api.installOpencode();
    if (!result.ok) setInstallError(result.error);
    setOpencode(await window.api.opencodeStatus());
    setInstalling(false);
  };

  const opencodeLabel = !opencode
    ? '…'
    : opencode.installed
      ? (opencode.matchesPin ? opencode.version : `${opencode.version} (expected ${opencode.pinned})`)
      : 'not installed';

  return (
    <div className="flex h-full flex-col">
      <TopBar title="Settings" />
      <div className="mx-auto w-full max-w-3xl flex-1 space-y-3 p-6">
      <Card data-testid="settings-appearance" className="p-4">
        <h2 className="text-sm font-semibold text-foreground">Appearance</h2>
        <div className="mt-3">
          <button
            type="button"
            onClick={() => {
              const next: Theme = theme === 'dark' ? 'light' : 'dark';
              applyTheme(next);
              setTheme(next);
            }}
            className="rounded-control border border-border bg-surface-3 px-2.5 py-1 text-xs font-semibold text-muted transition-colors hover:text-foreground"
          >
            {theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          </button>
        </div>
      </Card>

      <Card data-testid="settings-runtime" className="p-4">
        <h2 className="text-sm font-semibold text-foreground">Agent runtime</h2>
        <div className="mt-3">
          <ModelPicker status={opencode} />
        </div>
      </Card>

      <Card data-testid="settings-about" className="p-4">
        <h2 className="text-sm font-semibold text-foreground">About</h2>
        <dl className="mt-3 grid grid-cols-[9rem_1fr] gap-y-1.5 text-sm">
          <dt className="text-muted">Data folder</dt>
          <dd data-testid="data-dir" className="font-mono text-xs">{health?.dataDir ?? '…'}</dd>
          <dt className="text-muted">App version</dt>
          <dd className="font-mono text-xs">{health?.versions.app ?? '…'}</dd>
          <dt className="text-muted">Electron</dt>
          <dd className="font-mono text-xs">{health?.versions.electron ?? '…'}</dd>
          <dt className="text-muted">OpenCode</dt>
          <dd className="flex items-center gap-3">
            <span data-testid="opencode-status" className="font-mono text-xs">{opencodeLabel}</span>
            {opencode && !opencode.matchesPin && (
              <Button size="sm" disabled={installing} onClick={() => void install()}>
                {installing ? 'Installing…' : opencode.installed ? 'Repair install' : 'Install OpenCode (one-time download)'}
              </Button>
            )}
          </dd>
        </dl>
        {installError && (
          <p role="alert" className="mt-2 text-sm text-danger-foreground" data-testid="opencode-error">
            {installError}
          </p>
        )}
      </Card>
      </div>
    </div>
  );
}
```

**Notes on the frozen contract:**
- The theme toggle button keeps the accessible names `Switch to light theme` / `Switch to dark theme` (Task 2's e2e depends on this).
- `aria-label="Default model"` and `aria-label="Test prompt"` are preserved on the new `Select` / `Textarea`.
- `data-testid` values `data-dir`, `opencode-status`, `opencode-error`, `opencode-login-code`, `model-test-reply` are preserved.
- The `ModelPicker` card is nested inside the `settings-runtime` card; if the nesting looks wrong visually, move the `ModelPicker` card out and keep `settings-runtime` as a thin wrapper — the test ids must still resolve.

- [ ] **Step 4: Run the gate**

```bash
npm run check:pins && npm run lint && npm run typecheck && npm test && npm run build && npm run e2e
```

Expected: all green. Task 2's theme e2e test must still pass — it clicks the theme button by its accessible name `Switch to light theme` / `Switch to dark theme`, which this card keeps.

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/routes/settings.tsx
git commit -m "feat(ui): regroup settings into glass cards

Appearance, agent runtime, default model and about become separate cards
with segmented controls and styled form fields. Every test id and
accessible name in the settings surface is preserved."
```

---

## Phase 3 — Board

### Task 8: The column

**Files:**
- Modify: `apps/ui/src/components/kanban/column.tsx`

**Interfaces:**
- Consumes: `STATUS_THEME` from `../../lib/status-theme.ts`; `cn`.
- Produces: `Column(props: ColumnProps)` — the props interface is unchanged:

  ```ts
  interface ColumnProps {
    status: StoryStatus;
    stories: StoryDTO[];
    collapsed: boolean;
    collapsible: boolean;
    highlight: boolean;
    onToggle: () => void;
    onDropStory: (storyId: number, to: StoryStatus) => void;
    onMove: (story: StoryDTO, to: StoryStatus) => void;
    onOpenTerminal?: (story: StoryDTO) => void;
  }
  ```

- [ ] **Step 1: Write the failing e2e assertion**

Append to `e2e/tests/appearance.spec.ts`:

```ts
test('each column carries its status colour on the rail', async () => {
  const { page } = launched;
  await openBoard(page);
  const rail = page.getByTestId('column-rail-BLOCKED');
  await expect(rail).toBeVisible();
  const image = await rail.evaluate((el) => getComputedStyle(el).backgroundImage);
  expect(image).toContain('251, 113, 133');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build && npm run e2e -- appearance`
Expected: FAIL — `column-rail-BLOCKED` does not exist.

- [ ] **Step 3: Rewrite `column.tsx`**

Replace `apps/ui/src/components/kanban/column.tsx`:

```tsx
// apps/ui/src/components/kanban/column.tsx
import type { StoryDTO, StoryStatus } from '@aik/contracts';
import { dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/cn.ts';
import { STATUS_THEME } from '../../lib/status-theme.ts';
import { Card } from './card.tsx';

export function Column(props: {
  status: StoryStatus;
  stories: StoryDTO[];
  collapsed: boolean;
  collapsible: boolean;
  highlight: boolean;
  onToggle: () => void;
  onDropStory: (storyId: number, to: StoryStatus) => void;
  onMove: (story: StoryDTO, to: StoryStatus) => void;
  onOpenTerminal?: (story: StoryDTO) => void;
}) {
  const { status, stories, collapsed, collapsible, highlight, onToggle, onDropStory, onMove, onOpenTerminal } = props;
  const ref = useRef<HTMLElement>(null);
  const [over, setOver] = useState(false);
  const theme = STATUS_THEME[status];

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return dropTargetForElements({
      element: el,
      getData: () => ({ status }),
      canDrop: ({ source }) => typeof source.data.storyId === 'number',
      onDragEnter: () => setOver(true),
      onDragLeave: () => setOver(false),
      onDrop: ({ source }) => {
        setOver(false);
        onDropStory(source.data.storyId as number, status);
      },
    });
  }, [status, onDropStory]);

  return (
    <section
      ref={ref}
      aria-label={`${status} column`}
      data-testid={`column-${status}`}
      data-status={status}
      className={cn(
        'flex w-[246px] shrink-0 flex-col overflow-hidden rounded-panel border bg-surface backdrop-blur-[10px]',
        'shadow-[0_1px_0_rgb(255_255_255/0.05)_inset]',
        over
          ? 'border-accent/75 shadow-[0_0_0_1px_var(--accent),0_0_34px_-6px_var(--accent)]'
          : highlight
            ? 'border-accent/40'
            : 'border-glass-border',
      )}
    >
      <div
        data-testid={`column-rail-${status}`}
        aria-hidden="true"
        className="h-[3px]"
        style={{ background: theme.rail }}
      />
      <header className="mb-2 flex items-center gap-2 px-3 pt-2.5">
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ background: theme.dot }} />
        <h2 className="text-[11px] font-bold uppercase tracking-[0.07em] text-muted">{theme.label}</h2>
        <span
          className="ml-auto rounded-full border border-glass-border bg-surface-3 px-1.5 text-[11px] font-bold text-muted-2"
          style={stories.length > 0 ? { background: theme.softBg, color: theme.softFg, borderColor: 'transparent' } : undefined}
        >
          {stories.length}
        </span>
        {collapsible && (
          <button
            type="button"
            className="rounded-[6px] px-1 text-[11px] text-muted-2 transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
            aria-expanded={!collapsed}
            onClick={onToggle}
          >
            {collapsed ? 'Show' : 'Hide'}
          </button>
        )}
      </header>
      {!collapsed && (
        <ol className="flex min-h-12 flex-col gap-2 overflow-y-auto px-2 pb-2">
          {stories.map((s) => (
            <li key={s.id}>
              <Card story={s} onMove={onMove} onOpenTerminal={onOpenTerminal} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Run the gate**

```bash
npm run check:pins && npm run lint && npm run typecheck && npm test && npm run build && npm run e2e
```

Expected: all green. `board.spec.ts` clicks `getByRole('button', { name: 'Show' })` inside `column-CANCELLED` — the collapse button keeps the accessible name `Show`. ✓

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/components/kanban/column.tsx
git commit -m "feat(ui): give each board column a status rail and glass panel

Columns narrow to 246px, carry a gradient rail in their status colour, and
gain a coloured count chip and a glowing drop-target state. The collapse
button keeps its 'Show' accessible name."
```

---

### Task 9: The card

**Files:**
- Modify: `apps/ui/src/components/kanban/card.tsx`

**Interfaces:**
- Consumes: `STATUS_THEME`, `PRIORITY_THEME`, `BLOCKED_REASON_THEME`; `Badge`, `Button`, `cn`; `performEvent` from `../../lib/transitions.ts`.
- Produces: `export const Card: React.MemoExoticComponent<(props: CardProps) => JSX.Element>` — memoised, with props:

  ```ts
  interface CardProps {
    story: StoryDTO;
    onMove: (story: StoryDTO, to: StoryStatus) => void;
    onOpenTerminal?: (story: StoryDTO) => void;
  }
  ```

- [ ] **Step 1: Write the failing e2e assertion**

Append to `e2e/tests/appearance.spec.ts`:

```ts
test('a card renders the priority chip and the attempt footer', async () => {
  const { page } = launched;
  await apiCall(page, 'POST', `/projects/${projectId}/stories`, { title: 'Aurora card' });
  const card = page.getByTestId('card-INV-1');
  await expect(card).toBeVisible();
  await expect(card.getByTestId('story-priority-INV-1')).toContainText('P2');
  await expect(card.getByTestId('story-attempts-INV-1')).toContainText('attempt');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build && npm run e2e -- appearance`
Expected: FAIL — `story-priority-INV-1` does not exist.

- [ ] **Step 3: Rewrite `card.tsx`**

Replace `apps/ui/src/components/kanban/card.tsx`:

```tsx
// apps/ui/src/components/kanban/card.tsx
import { ACTIVE_STATUSES, isTerminal, type StoryDTO, type StoryStatus } from '@aik/contracts';
import { draggable } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { memo, useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/cn.ts';
import { BLOCKED_REASON_THEME, PRIORITY_THEME, STATUS_THEME } from '../../lib/status-theme.ts';
import { performEvent, type StoryActionEvent } from '../../lib/transitions.ts';
import { Badge } from '../ui/badge.tsx';
import { useToast } from '../ui/toast.tsx';
import { MoveMenu } from './move-menu.tsx';

function TerminalIcon({ className = 'h-3.5 w-3.5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
    </svg>
  );
}

export interface CardProps {
  story: StoryDTO;
  onMove: (story: StoryDTO, to: StoryStatus) => void;
  onOpenTerminal?: (story: StoryDTO) => void;
}

function CardImpl({ story, onMove, onOpenTerminal }: CardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const toast = useToast();
  const [busyAction, setBusyAction] = useState<StoryActionEvent | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return draggable({ element: el, getInitialData: () => ({ storyId: story.id }) });
  }, [story.id]);

  const isWorking = Boolean(story.activeRun || story.planningStatus === 'planning');
  const activeModel = story.activeRun?.model;
  const activeRole = story.activeRun?.role ?? (story.planningStatus === 'planning' ? 'planner' : null);

  // stop_run follows the machine's T13 guard (ACTIVE_STATUSES): verification runs with no
  // activeRun, and a stop must reach a running check tree (EXE-13); NEW never offers Stop.
  const canStopRun = (ACTIVE_STATUSES as readonly string[]).includes(story.status);
  const canToggleHold = !isTerminal(story.status);

  const runAction = async (event: StoryActionEvent, success: string) => {
    setBusyAction(event);
    try {
      const result = await performEvent(story, event);
      if (result.ok) toast(success, 'info');
      else toast(result.reason, 'error');
    } catch (e) {
      toast(String(e), 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const priority = PRIORITY_THEME[story.priority];
  const status = STATUS_THEME[story.status];
  const blocked = story.blocked ? BLOCKED_REASON_THEME[story.blocked.reason] : null;

  return (
    <div
      ref={ref}
      data-testid={`card-${story.key}`}
      data-status={story.status}
      tabIndex={0}
      aria-label={`${story.key} ${story.title}`}
      className={cn(
        'rounded-card border p-3 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        'content-visibility-auto',
        isWorking
          ? 'border-teal-400/35 bg-teal-400/[0.075]'
          : 'border-glass-border bg-surface-2 shadow-card',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] text-muted-2">{story.key}</span>
        <span
          data-testid={`story-priority-${story.key}`}
          className="rounded-[5px] px-1.5 py-0.5 text-[10px] font-bold leading-none"
          style={{ background: priority.softBg, color: priority.softFg }}
        >
          {priority.label}
        </span>
      </div>

      <p className="mt-1.5 text-sm font-medium leading-snug text-foreground">{story.title}</p>

      <div className="mt-2 flex flex-wrap gap-1">
        {story.labels.map((l) => (
          <Badge key={l} tone="muted">{l}</Badge>
        ))}
        {story.hold && <Badge tone="warn">on hold</Badge>}
        {story.blocked && (
          <Badge
            tone="danger"
            title={story.blocked.hint}
            style={blocked ? { background: blocked.softBg, color: blocked.softFg } : undefined}
          >
            {`blocked: ${blocked?.label ?? story.blocked.reason}`}
          </Badge>
        )}
      </div>

      {isWorking && (
        <button
          type="button"
          data-testid={`active-run-${story.key}`}
          onClick={(e) => {
            e.stopPropagation();
            onOpenTerminal?.(story);
          }}
          className="mt-2.5 flex w-full items-center justify-between gap-2 rounded-[7px] border border-teal-400/30 bg-teal-400/10 px-2 py-1.5 font-mono text-[11px] text-teal-300 transition-colors hover:bg-teal-400/20"
          title={`Click to view OpenCode live CLI & agent thoughts for ${story.key}`}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-teal-300 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-teal-400" />
            </span>
            <TerminalIcon className="h-3.5 w-3.5 shrink-0 text-teal-300" />
            <span className="truncate font-semibold">
              {activeModel ? `${activeModel}` : 'OpenCode'}
              {activeRole ? ` · ${activeRole}` : ''}
            </span>
          </span>
          <span className="shrink-0 text-[10px] uppercase tracking-wider text-teal-400">working</span>
        </button>
      )}

      {!isWorking && story.lastRun && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpenTerminal?.(story);
          }}
          className="mt-2 flex w-full items-center justify-between gap-2 rounded-[7px] border border-border bg-surface-3 px-2 py-1 font-mono text-[11px] text-muted transition-colors hover:text-foreground"
          title={`Inspect previous OpenCode run (${story.lastRun.status})`}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <TerminalIcon className="h-3 w-3 shrink-0" />
            <span className="truncate">
              CLI: {story.lastRun.model || 'OpenCode'} · {story.lastRun.role}
            </span>
          </span>
          <span className={cn('text-[10px] uppercase', story.lastRun.status === 'succeeded' ? 'text-success' : 'text-muted-2')}>
            {story.lastRun.status}
          </span>
        </button>
      )}

      {story.status === 'AWAITING_MERGE' && (
        <button
          type="button"
          data-testid={`awaiting-merge-${story.key}`}
          onClick={(e) => {
            e.stopPropagation();
            onOpenTerminal?.(story);
          }}
          className="mt-2.5 flex w-full items-center justify-between gap-2 rounded-[8px] border border-success/40 bg-success/15 px-2.5 py-1.5 text-xs font-bold text-success-foreground transition-colors hover:bg-success/25"
          title={`Review code changes and approve merge for ${story.key}`}
        >
          <span className="truncate">Review &amp; Merge</span>
          <span aria-hidden="true">→</span>
        </button>
      )}

      {story.status === 'BLOCKED' && story.blocked?.reason === 'post_merge_failed' && (
        <button
          type="button"
          data-testid={`revert-merge-${story.key}`}
          onClick={(e) => {
            e.stopPropagation();
            onOpenTerminal?.(story);
          }}
          className="mt-2.5 flex w-full items-center justify-between gap-2 rounded-[8px] border border-danger/40 bg-danger/15 px-2.5 py-1.5 text-xs font-bold text-danger-foreground transition-colors hover:bg-danger/25"
          title={`Post-merge verification failed for ${story.key}. Inspect failures and revert merge.`}
        >
          <span className="truncate">Revert Merge</span>
          <span aria-hidden="true">↺</span>
        </button>
      )}

      {(canStopRun || canToggleHold) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {canStopRun && (
            <button
              type="button"
              data-testid={`stop-run-${story.key}`}
              onClick={(e) => {
                e.stopPropagation();
                void runAction('stop_run', `Stop requested for ${story.key}; the active run is being interrupted`);
              }}
              disabled={busyAction !== null}
              title={`Interrupt the active run and block ${story.key} as interrupted`}
              className="rounded-[6px] border border-danger/35 bg-danger/10 px-2 py-1 text-xs font-semibold text-danger-foreground transition-colors hover:bg-danger/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span aria-hidden="true">■</span>
              {busyAction === 'stop_run' ? 'Stopping…' : 'Stop run'}
            </button>
          )}
          {canToggleHold && (
            <button
              type="button"
              data-testid={`hold-toggle-${story.key}`}
              onClick={(e) => {
                e.stopPropagation();
                void runAction(
                  story.hold ? 'unhold' : 'hold',
                  story.hold ? `${story.key} taken off hold` : `${story.key} put on hold`,
                );
              }}
              disabled={busyAction !== null}
              title={story.hold ? `Let scheduled work resume for ${story.key}` : `Pause scheduled work for ${story.key} without changing its status`}
              className="rounded-[6px] border border-warning/35 bg-warning/10 px-2 py-1 text-xs font-semibold text-warning-foreground transition-colors hover:bg-warning/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span aria-hidden="true">{story.hold ? '▶' : '⏸'}</span>
              {story.hold ? 'Unhold' : 'Hold'}
            </button>
          )}
        </div>
      )}

      <div className="mt-2 flex items-center justify-between gap-2 border-t border-border pt-2 text-[11px] text-muted-2">
        <span data-testid={`story-attempts-${story.key}`}>
          attempt {story.attempts.used}/{story.attempts.max}
        </span>
        {story.candidateSha ? (
          <span className="truncate font-mono" title={`Candidate: ${story.candidateSha}`}>
            sha:{story.candidateSha.slice(0, 7)}
          </span>
        ) : story.branch ? (
          <span className="max-w-[120px] truncate font-mono" title={`Branch: ${story.branch}`}>
            {story.branch}
          </span>
        ) : null}
      </div>
      <MoveMenu story={story} onMove={onMove} />
      <span className="sr-only">{status.label}</span>
    </div>
  );
}

export const Card = memo(CardImpl);
```

**Note on `content-visibility-auto`:** `content-visibility` is a CSS property, not a Tailwind utility. Add it to the global layer in `apps/ui/src/index.css` instead of using the class name above:

```css
@layer utilities {
  .content-visibility-auto {
    content-visibility: auto;
    contain-intrinsic-size: 0 132px;
  }
}
```

If `content-visibility` is not supported by the bundled Chromium it is simply ignored — safe either way.

- [ ] **Step 4: Run the gate**

```bash
npm run check:pins && npm run lint && npm run typecheck && npm test && npm run build && npm run e2e
```

Expected: all green. `board.spec.ts` asserts `card-INV-1` contains `Inventory module` — the title is still rendered. ✓

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/components/kanban/card.tsx apps/ui/src/index.css
git commit -m "feat(ui): restyle the story card as a glass surface

Priority chip, label pills, a teal live-run strip, gradient merge and
revert calls to action, and a hairline footer carrying the attempt count
and candidate SHA. Every card test id is preserved and the card is
memoised with content-visibility so 200 stories stay cheap."
```

---

### Task 10: The board container, toolbar and performance

**Files:**
- Modify: `apps/ui/src/components/kanban/board.tsx`
- Modify: `apps/ui/src/routes/board.tsx`

**Interfaces:**
- Consumes: `Column`, `Card`, `ConfirmDialog`, `RequestChangesDialog`, `TerminalModal`; `TopBar`.
- Produces: `Board({ stories, onChanged }: { stories: StoryDTO[]; onChanged: () => Promise<void> })` — unchanged signature. `BoardPage` — unchanged.

- [ ] **Step 1: Write the failing e2e assertion**

Append to `e2e/tests/appearance.spec.ts`:

```ts
test('the board toolbar uses styled controls, not raw inputs', async () => {
  const { page } = launched;
  await openBoard(page);
  await expect(page.getByTestId('board-toolbar')).toBeVisible();
  await expect(page.getByLabel('Search stories')).toBeVisible();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build && npm run e2e -- appearance`
Expected: FAIL — `board-toolbar` does not exist.

- [ ] **Step 3: Rewrite `board.tsx`**

Replace `apps/ui/src/components/kanban/board.tsx`:

```tsx
// apps/ui/src/components/kanban/board.tsx
import { STORY_STATUS, type StoryDTO, type StoryStatus } from '@aik/contracts';
import { monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { dragVerdict } from '@aik/workflow';
import { useCallback, useEffect, useState } from 'react';
import { performMove, toDragStory } from '../../lib/transitions.ts';
import { useToast } from '../ui/toast.tsx';
import { Column } from './column.tsx';
import { ConfirmDialog } from './confirm-dialog.tsx';
import { RequestChangesDialog } from './request-changes-dialog.tsx';
import { TerminalModal } from './terminal-modal.tsx';

export function Board({ stories, onChanged }: { stories: StoryDTO[]; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const [pending, setPending] = useState<Record<number, StoryStatus>>({});
  const [dragging, setDragging] = useState<StoryDTO | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ DONE: true, CANCELLED: true });
  const [confirm, setConfirm] = useState<{ message: string; resolve: (ok: boolean) => void } | null>(null);
  const [changes, setChanges] = useState<{ resolve: (text: string | null) => void } | null>(null);
  const [terminalStory, setTerminalStory] = useState<StoryDTO | null>(null);

  useEffect(
    () =>
      monitorForElements({
        onDragStart: ({ source }) => setDragging(stories.find((s) => s.id === source.data.storyId) ?? null),
        onDrop: () => setDragging(null),
      }),
    [stories],
  );

  const move = useCallback(
    async (story: StoryDTO, to: StoryStatus) => {
      const result = await performMove(story, to, {
        confirm: (message) => new Promise((resolve) => setConfirm({ message, resolve })),
        askFindings: () => new Promise((resolve) => setChanges({ resolve })),
        beforeRequest: () => setPending((p) => ({ ...p, [story.id]: to })),
      });
      setPending((p) => {
        const next = { ...p };
        delete next[story.id];
        return next;
      });
      if (!result.ok && result.reason) toast(result.reason, 'error');
      await onChanged();
    },
    [onChanged, toast],
  );

  const onDropStory = useCallback(
    (storyId: number, to: StoryStatus) => {
      const story = stories.find((s) => s.id === storyId);
      if (story) void move(story, to);
    },
    [stories, move],
  );

  const byStatus = Object.fromEntries(STORY_STATUS.map((s) => [s, [] as StoryDTO[]])) as Record<StoryStatus, StoryDTO[]>;
  for (const s of stories) byStatus[pending[s.id] ?? s.status].push(s);

  const currentTerminalStory = terminalStory
    ? stories.find((s) => s.id === terminalStory.id) ?? terminalStory
    : null;

  return (
    <div className="relative flex min-h-0 flex-1">
      <div
        data-testid="board"
        className="flex min-h-0 flex-1 gap-2.5 overflow-x-auto p-4 [scrollbar-color:var(--border-strong)_transparent]"
      >
        {STORY_STATUS.map((status) => (
          <Column
            key={status}
            status={status}
            stories={byStatus[status]}
            collapsible={status === 'DONE' || status === 'CANCELLED'}
            collapsed={collapsed[status] === true}
            highlight={dragging !== null && dragVerdict(toDragStory(dragging), status).allowed}
            onToggle={() => setCollapsed((c) => ({ ...c, [status]: !c[status] }))}
            onDropStory={onDropStory}
            onMove={(story, to) => void move(story, to)}
            onOpenTerminal={(story) => setTerminalStory(story)}
          />
        ))}
      </div>
      {/* Edge fade: signals that more columns exist to the right. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 w-24 bg-gradient-to-l from-background to-transparent" />
      <ConfirmDialog
        message={confirm?.message ?? null}
        onAnswer={(ok) => {
          confirm?.resolve(ok);
          setConfirm(null);
        }}
      />
      <RequestChangesDialog
        open={changes !== null}
        onAnswer={(text) => {
          changes?.resolve(text);
          setChanges(null);
        }}
      />
      {currentTerminalStory && (
        <TerminalModal
          story={currentTerminalStory}
          onClose={() => setTerminalStory(null)}
          onChanged={onChanged}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 4: Rewrite the board route toolbar**

Replace `apps/ui/src/routes/board.tsx`:

```tsx
// apps/ui/src/routes/board.tsx
import type { ProjectDTO } from '@aik/contracts';
import { useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Board } from '../components/kanban/board.tsx';
import { CreateStoryDialog } from '../components/kanban/create-story-dialog.tsx';
import { TopBar } from '../components/shell/top-bar.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Select } from '../components/ui/select.tsx';
import { api } from '../lib/api.ts';
import { useStories, type StoryQuery } from '../lib/stories.ts';

export function BoardPage() {
  const params = useParams({ strict: false }) as { projectId?: string };
  const id = Number(params.projectId);
  const [project, setProject] = useState<ProjectDTO | null>(null);
  const [query, setQuery] = useState<StoryQuery>({ q: '', label: '', sort: 'rank' });
  const [creating, setCreating] = useState(false);
  const { stories, error, refetch } = useStories(id, query);

  useEffect(() => {
    void api.get<ProjectDTO>(`/projects/${id}`).then(setProject, () => setProject(null));
  }, [id]);

  return (
    <div className="flex h-full flex-col">
      <TopBar data-testid="board-toolbar" title={project ? `${project.key} · ${project.name}` : 'Board'}>
        <Input
          aria-label="Search stories"
          placeholder="Search…"
          value={query.q}
          onChange={(e) => setQuery((q) => ({ ...q, q: e.target.value }))}
          className="w-56"
        />
        <Input
          aria-label="Filter by label"
          placeholder="Label"
          value={query.label}
          onChange={(e) => setQuery((q) => ({ ...q, label: e.target.value }))}
          className="w-32"
        />
        <Select
          aria-label="Sort stories"
          value={query.sort}
          onChange={(e) => setQuery((q) => ({ ...q, sort: e.target.value as StoryQuery['sort'] }))}
          className="w-40"
        >
          <option value="rank">Board order</option>
          <option value="priority">Priority</option>
          <option value="updated">Recently updated</option>
          <option value="created">Newest</option>
        </Select>
        <Button data-testid="new-story" variant="primary" className="ml-auto" onClick={() => setCreating(true)}>
          + New story
        </Button>
      </TopBar>
      {error && (
        <p role="alert" className="px-4 py-2 text-sm text-danger-foreground">
          {error}
        </p>
      )}
      <Board stories={stories} onChanged={refetch} />
      <CreateStoryDialog open={creating} projectId={id} onClose={() => setCreating(false)} onCreated={() => void refetch()} />
    </div>
  );
}
```

- [ ] **Step 5: Run the gate**

```bash
npm run check:pins && npm run lint && npm run typecheck && npm test && npm run build && npm run e2e
```

Expected: all green. The 200-story test must still pass within its 30-second budget. The `new-story` button's accessible name changes from `New story` to `+ New story` — **the e2e uses `getByTestId('new-story')`, not the name, so it is safe.** Keep the `data-testid`.

- [ ] **Step 6: Commit**

```bash
git add apps/ui/src/components/kanban/board.tsx apps/ui/src/routes/board.tsx
git commit -m "feat(ui): restyle the board container and toolbar

The board gains a right-edge fade so the remaining columns are
discoverable, and the toolbar uses the styled input, select and button
primitives on a glass bar. The board's test ids and accessible labels are
unchanged."
```

---

### Task 11: The move menu

**Files:**
- Create: `apps/ui/src/components/ui/dropdown-menu.tsx`
- Modify: `apps/ui/src/components/kanban/move-menu.tsx`

**Interfaces:**
- Consumes: `@radix-ui/react-dropdown-menu`; `STORY_STATUS`, `dragVerdict`, `toDragStory`.
- Produces:
  - `DropdownMenu`, `DropdownMenuTrigger`, `DropdownMenuContent`, `DropdownMenuItem` — thin wrappers over Radix that apply the Aurora glass styling.
  - `MoveMenu({ story, onMove }: { story: StoryDTO; onMove: (story: StoryDTO, to: StoryStatus) => void })` — unchanged signature.

- [ ] **Step 1: Write the failing e2e assertion**

Append to `e2e/tests/appearance.spec.ts`:

```ts
test('the move menu is keyboard navigable and keeps its status names', async () => {
  const { page } = launched;
  await apiCall(page, 'POST', `/projects/${projectId}/stories`, { title: 'Menu story' });
  const trigger = page.getByTestId('card-INV-1').getByRole('button', { name: 'Move to…' });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const item = page.getByRole('menuitem', { name: 'CANCELLED' });
  await expect(item).toBeVisible();
  await expect(page.getByRole('menu')).toBeVisible();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build && npm run e2e -- appearance`
Expected: the current hand-rolled menu *does* open on Enter, so this may pass. In that case tighten the assertion to the behaviour that actually differs — Radix exposes `aria-expanded` on the trigger and the menu is in a portal:

```ts
test('the move menu is keyboard navigable and keeps its status names', async () => {
  const { page } = launched;
  await apiCall(page, 'POST', `/projects/${projectId}/stories`, { title: 'Menu story' });
  const trigger = page.getByTestId('card-INV-1').getByRole('button', { name: 'Move to…' });
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'CANCELLED' })).toBeVisible();
});
```

The hand-rolled menu's trigger **does** set `aria-expanded`, so verify what actually differs: after the change, `page.getByRole('menu')` must be **outside** the card element. Assert:

```ts
const menu = page.getByRole('menu');
await expect(menu).toBeVisible();
expect(await menu.evaluate((el) => el.closest('[data-testid^="card-"]') !== null)).toBe(false);
```

The hand-rolled menu renders inside the card, so this fails today and passes after the Radix portal.

- [ ] **Step 3: Create the dropdown wrapper**

Create `apps/ui/src/components/ui/dropdown-menu.tsx`:

```tsx
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import type { ComponentPropsWithoutRef } from 'react';
import { cn } from '../../lib/cn.ts';

export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;

export function DropdownMenuContent({
  className = '',
  sideOffset = 4,
  ...props
}: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          'z-50 min-w-[13rem] overflow-hidden rounded-card border border-glass-border bg-[rgb(18_22_38/0.94)] p-1 shadow-panel backdrop-blur-[18px]',
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

export function DropdownMenuItem({
  className = '',
  ...props
}: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item>) {
  return (
    <DropdownMenuPrimitive.Item
      className={cn(
        'flex cursor-pointer select-none items-center gap-2 rounded-[7px] px-2 py-1.5 text-sm text-foreground outline-none',
        'data-[highlighted]:bg-surface-2 data-[disabled]:pointer-events-none data-[disabled]:opacity-45',
        className,
      )}
      {...props}
    />
  );
}
```

- [ ] **Step 4: Rewrite `move-menu.tsx`**

Replace `apps/ui/src/components/kanban/move-menu.tsx`:

```tsx
// apps/ui/src/components/kanban/move-menu.tsx
import { STORY_STATUS, type StoryDTO, type StoryStatus } from '@aik/contracts';
import { dragVerdict } from '@aik/workflow';
import { STATUS_THEME } from '../../lib/status-theme.ts';
import { toDragStory } from '../../lib/transitions.ts';
import { Button } from '../ui/button.tsx';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu.tsx';

export function MoveMenu({ story, onMove }: { story: StoryDTO; onMove: (story: StoryDTO, to: StoryStatus) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="mt-2 w-full justify-start" aria-haspopup="menu">
          Move to…
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent aria-label={`Move ${story.key} to`}>
        {STORY_STATUS.filter((s) => s !== story.status).map((to) => {
          const v = dragVerdict(toDragStory(story), to);
          const theme = STATUS_THEME[to];
          return (
            <DropdownMenuItem
              key={to}
              disabled={!v.allowed}
              // E11: the verbatim title is part of the frozen e2e contract.
              title={v.allowed ? undefined : v.reason}
              // E12: the reason belongs in the DESCRIPTION, never in the accessible
              // name — the IN_PROGRESS reason contains the word "NEW", which would
              // make getByRole('menuitem', { name: 'NEW' }) ambiguous.
              aria-describedby={v.allowed ? undefined : `move-reason-${story.id}-${to}`}
              onSelect={() => onMove(story, to)}
            >
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ background: theme.dot }} />
              <span>{to}</span>
              {!v.allowed && (
                <>
                  <span aria-hidden="true" className="ml-auto max-w-[9rem] truncate text-[10px] text-muted-2">
                    {v.reason}
                  </span>
                  <span id={`move-reason-${story.id}-${to}`} className="sr-only">
                    {v.reason}
                  </span>
                </>
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

- [ ] **Step 5: Run the gate**

```bash
npm run check:pins && npm run lint && npm run typecheck && npm test && npm run build && npm run e2e
```

Expected: all green. `board.spec.ts` has two move-menu tests:
- `cancels a story with the keyboard Move to… menu` — focuses the trigger, presses Enter, focuses the `CANCELLED` menuitem, presses Enter, then clicks `Cancel story`. Radix menu items are focusable, so `.focus()` works. ✓
- `disabled moves explain themselves` — clicks the trigger and asserts the `IN_PROGRESS` menuitem is disabled **and** has `title="Only the orchestrator moves stories from NEW to IN_PROGRESS"`. Radix sets `data-disabled` and `aria-disabled="true"`, but Playwright's `toBeDisabled()` also recognises `aria-disabled="true"`. ✓ The `title` is passed straight through. ✓

- [ ] **Step 6: Commit**

```bash
git add apps/ui/src/components/ui/dropdown-menu.tsx apps/ui/src/components/kanban/move-menu.tsx
git commit -m "feat(ui): replace the hand-rolled move menu with a Radix dropdown

The menu now supports arrow-key navigation, type-ahead and Esc, renders in
a portal so it is never clipped by a card, and shows the reason a target is
disabled inline. Item names stay the raw status string and the disabled
title attribute is preserved verbatim for the e2e contract."
```

---

## Phase 4 — Overlays

### Task 12: The dialog primitive and the story dialogs

**Files:**
- Modify: `apps/ui/src/components/ui/dialog.tsx`
- Modify: `apps/ui/src/components/kanban/confirm-dialog.tsx`
- Modify: `apps/ui/src/components/kanban/create-story-dialog.tsx`
- Modify: `apps/ui/src/components/kanban/request-changes-dialog.tsx`
- Modify: `apps/ui/src/components/kanban/clarifications-dialog.tsx`

**Interfaces:**
- Consumes: `@radix-ui/react-dialog`; `Button`, `Label`, `Select`, `TextField`, `TextArea`.
- Produces: `Dialog({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode })` — **the public API is unchanged**.

- [ ] **Step 1: Write the failing e2e assertion**

Append to `e2e/tests/appearance.spec.ts`:

```ts
test('the new-story dialog traps focus and restores it on close', async () => {
  const { page } = launched;
  await openBoard(page);
  const trigger = page.getByTestId('new-story');
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Title')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build && npm run e2e -- appearance`
Expected: FAIL — the native `<dialog>` does not autofocus the Title field, and focus is not restored to the trigger.

- [ ] **Step 3: Rewrite `dialog.tsx`**

Replace `apps/ui/src/components/ui/dialog.tsx`:

```tsx
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useEffect, type ReactNode } from 'react';
import { cn } from '../../lib/cn.ts';

export function Dialog({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[rgb(4_7_16/0.70)] backdrop-blur-[3px]" />
        <DialogPrimitive.Content
          aria-label={title}
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-[32rem] max-w-[90vw] -translate-x-1/2 -translate-y-1/2',
            'rounded-panel border border-glass-border bg-[rgb(16_20_36/0.92)] p-0 text-foreground shadow-panel backdrop-blur-[22px]',
          )}
        >
          <DialogPrimitive.Title className="border-b border-border bg-surface/40 px-5 py-3 text-base font-bold tracking-tight">
            {title}
          </DialogPrimitive.Title>
          <div className="p-5">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** Focuses the first form control when a dialog opens. */
export function DialogAutoFocus() {
  useEffect(() => {
    const el = document.querySelector<HTMLElement>('[role="dialog"] input, [role="dialog"] textarea, [role="dialog"] select');
    el?.focus();
  }, []);
  return null;
}
```

- [ ] **Step 4: Restyle the story dialogs**

Replace `apps/ui/src/components/kanban/confirm-dialog.tsx`:

```tsx
// apps/ui/src/components/kanban/confirm-dialog.tsx
import { Button } from '../ui/button.tsx';
import { Dialog } from '../ui/dialog.tsx';

export function ConfirmDialog({ message, onAnswer }: { message: string | null; onAnswer: (ok: boolean) => void }) {
  return (
    <Dialog open={message !== null} title="Please confirm" onClose={() => onAnswer(false)}>
      <p className="text-sm text-muted">{message}</p>
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={() => onAnswer(false)}>Keep story</Button>
        <Button variant="danger" onClick={() => onAnswer(true)}>Cancel story</Button>
      </div>
    </Dialog>
  );
}
```

Replace `apps/ui/src/components/kanban/create-story-dialog.tsx`:

```tsx
// apps/ui/src/components/kanban/create-story-dialog.tsx
import type { Priority } from '@aik/contracts';
import { useState, type FormEvent } from 'react';
import { ApiRequestError, api } from '../../lib/api.ts';
import { PRIORITY_THEME } from '../../lib/status-theme.ts';
import { Button } from '../ui/button.tsx';
import { Dialog, DialogAutoFocus } from '../ui/dialog.tsx';
import { Label } from '../ui/label.tsx';
import { TextArea, TextField } from '../ui/field.tsx';

export function CreateStoryDialog({ open, projectId, onClose, onCreated }: { open: boolean; projectId: number; onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [criteria, setCriteria] = useState('');
  const [labels, setLabels] = useState('');
  const [priority, setPriority] = useState<Priority>('P2');
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.post(`/projects/${projectId}/stories`, {
        title,
        description,
        priority,
        acceptanceCriteria: criteria.split('\n').map((s) => s.trim()).filter(Boolean),
        labels: labels.split(',').map((s) => s.trim()).filter(Boolean),
      });
      setTitle('');
      setDescription('');
      setCriteria('');
      setLabels('');
      setError(null);
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.reason : String(err));
    }
  };

  return (
    <Dialog open={open} title="New story" onClose={onClose}>
      <DialogAutoFocus />
      <form onSubmit={submit} className="flex flex-col gap-3">
        <TextField label="Title" value={title} onChange={(e) => setTitle(e.target.value)} required />
        <TextArea label="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
        <TextArea label="Acceptance criteria (one per line)" value={criteria} onChange={(e) => setCriteria(e.target.value)} />
        <TextField label="Labels (comma separated)" value={labels} onChange={(e) => setLabels(e.target.value)} />
        <div className="flex flex-col gap-1.5">
          <Label>Priority</Label>
          <div role="radiogroup" aria-label="Priority" className="inline-flex gap-1 rounded-control border border-border bg-surface-3 p-1">
            {(['P0', 'P1', 'P2', 'P3'] as const).map((p) => {
              const theme = PRIORITY_THEME[p];
              const active = priority === p;
              return (
                <button
                  key={p}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setPriority(p)}
                  className={
                    active
                      ? 'rounded-[6px] px-2.5 py-1 text-xs font-bold'
                      : 'rounded-[6px] px-2.5 py-1 text-xs font-bold opacity-70 hover:opacity-100'
                  }
                  style={active ? { background: theme.softBg, color: theme.softFg } : undefined}
                >
                  {p}
                </button>
              );
            })}
          </div>
        </div>
        {error && <p role="alert" className="text-sm text-danger-foreground">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Close</Button>
          <Button type="submit" variant="primary">Create story</Button>
        </div>
      </form>
    </Dialog>
  );
}
```

Replace `apps/ui/src/components/kanban/request-changes-dialog.tsx`:

```tsx
// apps/ui/src/components/kanban/request-changes-dialog.tsx
import { useState } from 'react';
import { Button } from '../ui/button.tsx';
import { Dialog } from '../ui/dialog.tsx';
import { TextArea } from '../ui/field.tsx';

export function RequestChangesDialog({ open, onAnswer }: { open: boolean; onAnswer: (text: string | null) => void }) {
  const [text, setText] = useState('');
  return (
    <Dialog open={open} title="Request changes" onClose={() => onAnswer(null)}>
      <TextArea label="What must change?" value={text} onChange={(e) => setText(e.target.value)} />
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={() => onAnswer(null)}>Back</Button>
        <Button variant="primary" disabled={!text.trim()} onClick={() => { onAnswer(text.trim()); setText(''); }}>Send to rework</Button>
      </div>
    </Dialog>
  );
}
```

In `apps/ui/src/components/kanban/clarifications-dialog.tsx`, change only the `RejectPlanDialog` body and the `ClarificationAnswersForm` submit button styling. Replace the `RejectPlanDialog` component with:

```tsx
export function RejectPlanDialog({ open, onAnswer }: { open: boolean; onAnswer: (feedback: string | null) => void }) {
  const [text, setText] = useState('');
  return (
    <Dialog open={open} title="Reject plan" onClose={() => onAnswer(null)}>
      <p className="mb-2 text-sm text-muted">The plan is marked rejected and the planner re-plans with your feedback.</p>
      <TextArea
        label="What must the new plan fix?"
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={5000}
        placeholder="What is wrong and what the re-plan should do differently"
      />
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={() => onAnswer(null)}>Back</Button>
        <Button
          variant="danger"
          disabled={!text.trim()}
          onClick={() => {
            onAnswer(text.trim());
            setText('');
          }}
        >
          Reject &amp; re-plan
        </Button>
      </div>
    </Dialog>
  );
}
```

And in the same file replace the raw `<button type="submit" data-testid="clarifications-submit">` element with:

```tsx
<button
  type="submit"
  data-testid="clarifications-submit"
  disabled={!complete || busy}
  className="shrink-0 cursor-pointer rounded-control bg-gradient-to-br from-accent to-accent-2 px-3 py-1.5 text-xs font-bold text-accent-foreground transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
>
  {busy ? 'Sending…' : 'Send answers'}
</button>
```

and the question block's wrapper class from `space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/30 p-3` to `space-y-2 rounded-card border border-border bg-surface-3 p-3`.

- [ ] **Step 5: Run the gate**

```bash
npm run check:pins && npm run lint && npm run typecheck && npm test && npm run build && npm run e2e
```

Expected: all green. `board.spec.ts` fills `getByLabel('Title')` and `getByLabel('Acceptance criteria (one per line)')` and clicks `getByRole('button', { name: 'Create story' })` — all preserved. ✓

- [ ] **Step 6: Commit**

```bash
git add apps/ui/src/components/ui/dialog.tsx apps/ui/src/components/kanban/confirm-dialog.tsx apps/ui/src/components/kanban/create-story-dialog.tsx apps/ui/src/components/kanban/request-changes-dialog.tsx apps/ui/src/components/kanban/clarifications-dialog.tsx
git commit -m "feat(ui): rebuild the dialogs on Radix with a focus trap

Radix supplies the focus trap, scroll lock, Escape handling and focus
restore. The new-story dialog autofocuses its first field and renders
priority as a segmented control. Every dialog title, label and button
name is preserved."
```

---

### Task 13: The story detail modal

**Files:**
- Modify: `apps/ui/src/components/kanban/terminal-modal.tsx`

**Interfaces:**
- Consumes: `STATUS_THEME`, `Badge`, `Button`, `cn`.
- Produces: `TerminalModal({ story, onClose, onChanged }: { story: StoryDTO; onClose: () => void; onChanged?: () => Promise<void> })` — unchanged signature.

- [ ] **Step 1: Write the failing e2e assertion**

Append to `e2e/tests/appearance.spec.ts`:

```ts
test('the story modal renders a glass panel with its five tabs', async () => {
  const { page } = launched;
  await apiCall(page, 'POST', `/projects/${projectId}/stories`, { title: 'Modal story' });
  await page.getByTestId('card-INV-1').getByRole('button', { name: /CLI|Move to/ }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
});
```

If no button opens the modal for a story with no runs, drive it through a story that has an active run, or assert the modal's presence via the `lastRun` strip instead. Adjust the selector until it opens the modal; the point of the test is that the modal renders with the Aurora panel and the five tab labels.

- [ ] **Step 2: Run it to verify it fails or passes**

Run: `npm run build && npm run e2e -- appearance`
Expected: the modal opens but with the old flat zinc chrome.

- [ ] **Step 3: Restyle the modal chrome**

In `apps/ui/src/components/kanban/terminal-modal.tsx`:

(a) The backdrop and panel — replace:

```tsx
className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-in fade-in duration-150"
```

with:

```tsx
className="fixed inset-0 z-50 flex items-center justify-center bg-[rgb(4_7_16/0.70)] backdrop-blur-[3px] p-4"
```

and the panel — replace:

```tsx
className="flex h-[90vh] w-full max-w-5xl flex-col rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl overflow-hidden"
```

with:

```tsx
className="flex h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-panel border border-glass-border bg-[rgb(16_20_36/0.90)] shadow-panel backdrop-blur-[22px]"
```

(b) The header bar — replace `border-b border-zinc-800 bg-zinc-900/90 px-4 py-3` with `border-b border-border bg-surface/40 px-4 py-3`.

(c) The story key chip — replace `font-mono text-xs font-semibold text-zinc-400 bg-zinc-800 px-2 py-0.5 rounded` with `rounded-[6px] border border-border bg-surface-3 px-2 py-0.5 font-mono text-xs font-semibold text-muted`.

(d) The status pill — first add the import at the top of the file:

```tsx
import { STATUS_THEME } from '../../lib/status-theme.ts';
```

then, inside the component, add:

```tsx
const statusTheme = STATUS_THEME[story.status];
```

and replace the whole conditional with:

```tsx
<span
  className="rounded-[6px] border px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider"
  style={{
    background: statusTheme.softBg,
    color: statusTheme.softFg,
    borderColor: 'transparent',
  }}
>
  {story.status}
</span>
```

The pill keeps the **raw** status string as its text — only the colour comes from the theme map.

(e) The title — replace `text-sm font-semibold text-zinc-100 max-w-md` with `max-w-md truncate text-sm font-semibold text-foreground`.

(f) The elapsed chip — replace `font-mono text-xs text-zinc-500 bg-zinc-950/60 px-2 py-0.5 rounded border border-zinc-800` with `rounded-[6px] border border-border bg-surface-3 px-2 py-0.5 font-mono text-xs text-muted-2`.

(g) The header buttons — restyle each:
- Stop run: `flex items-center gap-1.5 rounded border border-danger/40 bg-danger/15 px-3 py-1.5 text-xs font-bold text-danger-foreground transition-colors hover:bg-danger/25 disabled:opacity-50`
- Approve & Merge: `flex items-center gap-1.5 rounded border border-success/40 bg-success/15 px-3 py-1.5 text-xs font-bold text-success-foreground transition-colors hover:bg-success/25 disabled:opacity-50`
- Revert Merge: `flex items-center gap-1.5 rounded border border-danger/40 bg-danger/15 px-3 py-1.5 text-xs font-bold text-danger-foreground transition-colors hover:bg-danger/25 disabled:opacity-50`
- Open in CLI: `hidden items-center gap-1.5 rounded border border-teal-400/30 bg-teal-400/10 px-2.5 py-1.5 font-mono text-xs text-teal-300 transition-colors hover:bg-teal-400/20 sm:flex`
- Copy CLI: `flex items-center gap-1.5 rounded border border-border bg-surface-3 px-2 py-1 font-mono text-xs text-muted transition-colors hover:text-foreground`
- Close: `rounded p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-foreground`

(h) The tab bar — replace the container `flex items-center border-b border-zinc-800 bg-zinc-900/50 px-4` with `flex items-center border-b border-border bg-surface/20 px-4`, and every tab's conditional classes with:

```tsx
className={
  activeMode === 'terminal'
    ? 'border-b-2 border-accent px-3 py-2 text-xs font-bold text-foreground [box-shadow:0_6px_14px_-10px_var(--accent)]'
    : 'border-b-2 border-transparent px-3 py-2 text-xs font-semibold text-muted transition-colors hover:text-foreground'
}
```

(i) The terminal filter pills — replace the wrapper `flex rounded-lg bg-zinc-900 p-0.5 border border-zinc-800 font-mono` with `inline-flex gap-0.5 rounded-control border border-border bg-surface-3 p-0.5 font-mono`, and the pill class logic with:

```tsx
className={
  activeTerminalTab === 'all'
    ? 'rounded-[6px] bg-accent/20 px-2.5 py-1 text-xs font-semibold text-accent-foreground'
    : activeTerminalTab === 'reasoning'
      ? 'rounded-[6px] bg-accent/20 px-2.5 py-1 text-xs font-semibold text-accent-foreground'
      : activeTerminalTab === 'tools'
        ? 'rounded-[6px] bg-teal-400/15 px-2.5 py-1 text-xs font-semibold text-teal-300'
        : 'rounded-[6px] bg-success/15 px-2.5 py-1 text-xs font-semibold text-success-foreground'
}
```

(j) The log entries — replace the wrapper `rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-3` with:

```tsx
className="rounded-card border border-border bg-surface-3 p-3"
```

and add a left colour rail by event type. Replace the `{filteredEvents.map((ev) => (` block with:

```tsx
{filteredEvents.map((ev) => {
  const rail = ev.type === 'reasoning' ? '#a78bfa' : ev.type === 'tool' ? '#22d3ee' : ev.type === 'user' ? '#94a3b8' : '#34d399';
  return (
    <div key={ev.key} className="rounded-card border border-border bg-surface-3 p-3" style={{ borderLeft: `2px solid ${rail}` }}>
      <div className="mb-1.5 flex items-center justify-between border-b border-border/60 pb-1.5 text-[11px] text-muted-2">
        <span className="font-semibold uppercase tracking-wider" style={{ color: rail }}>
          {ev.type}
        </span>
        {ev.content.time?.created && <span>{new Date(ev.content.time.created).toLocaleTimeString()}</span>}
      </div>
      <div className="whitespace-pre-wrap font-mono text-xs text-muted">{ev.content.text || JSON.stringify(ev.content.state?.input ?? ev.content.state?.content ?? '', null, 2)}</div>
    </div>
  );
})}
```

(k) The remaining `zinc` classes in the plan / verification / review / diff panes — replace them mechanically:
- `border-zinc-800` → `border-border`
- `border-zinc-850` → `border-border`
- `bg-zinc-900/40` → `bg-surface-3`
- `bg-zinc-900/30` → `bg-surface-2`
- `bg-zinc-950` → `bg-surface-3`
- `bg-black/60` → `bg-black/50`
- `text-zinc-200` → `text-foreground`
- `text-zinc-300` → `text-foreground`
- `text-zinc-400` → `text-muted`
- `text-zinc-500` → `text-muted-2`
- `text-zinc-100` → `text-foreground`
- `text-emerald-400` → `text-success`
- `text-rose-400` → `text-danger`
- `text-cyan-400` → `text-teal-300`
- `text-purple-300` → `text-accent-foreground`
- `text-amber-300` → `text-warning-foreground`
- `text-red-200` → `text-danger-foreground`
- `text-red-300` → `text-danger-foreground`
- `bg-red-950/60 border-red-800/80` → `border-danger/40 bg-danger/10`
- `bg-amber-950/20 border-amber-500/30` → `border-warning/30 bg-warning/10`
- `bg-emerald-950 text-emerald-400 border-emerald-500/30` → `border-success/30 bg-success/10 text-success-foreground`
- `bg-rose-950 text-rose-400 border-rose-500/30` → `border-danger/30 bg-danger/10 text-danger-foreground`
- `bg-cyan-950 text-cyan-300 border-cyan-500/40` → `border-teal-400/40 bg-teal-400/10 text-teal-300`

Leave the diff syntax colours (`bg-emerald-950/40 text-emerald-300`, `bg-rose-950/40 text-rose-300`) alone — they encode added/removed lines and must stay legible.

- [ ] **Step 4: Run the gate**

```bash
npm run check:pins && npm run lint && npm run typecheck && npm test && npm run build && npm run e2e
```

Expected: all green. The modal's `data-testid` values (`modal-stop-run-<KEY>`, `modal-revert-merge-<KEY>`, `banner-revert-merge-<KEY>`, `modal-reject-plan-<KEY>`) are preserved.

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/components/kanban/terminal-modal.tsx
git commit -m "feat(ui): restyle the story detail modal as a glass panel

The modal floats over a blurred board, its five tabs gain a glowing active
indicator, the terminal filter becomes a segmented control, and log
entries carry a colour rail per event type. Every modal test id is
preserved."
```

---

### Task 14: Toast, tooltip and scroll area

**Files:**
- Modify: `apps/ui/src/components/ui/toast.tsx`
- Create: `apps/ui/src/components/ui/tooltip.tsx`
- Create: `apps/ui/src/components/ui/scroll-area.tsx`

**Interfaces:**
- Consumes: `@radix-ui/react-tooltip`, `@radix-ui/react-scroll-area`; `cn`.
- Produces:
  - `ToastProvider({ children })`, `useToast()` — **unchanged API**: `useToast()` returns `(message: string, tone?: 'info' | 'error') => void`.
  - `TooltipProvider`, `Tooltip`, `TooltipTrigger`, `TooltipContent`.
  - `ScrollArea`, `ScrollBar`.

- [ ] **Step 1: Write the failing e2e assertion**

Append to `e2e/tests/appearance.spec.ts`:

```ts
test('a toast is announced through a single status region', async () => {
  const { page } = launched;
  await openBoard(page);
  await apiCall(page, 'POST', `/projects/${projectId}/stories`, { title: 'Toast story' });
  const card = page.getByTestId('card-INV-1');
  await card.getByRole('button', { name: 'Move to…' }).click();
  await page.getByRole('menuitem', { name: 'CANCELLED' }).click();
  await page.getByRole('button', { name: 'Cancel story' }).click();
  await expect(page.getByRole('status')).toBeVisible();
  expect(await page.getByRole('status').count()).toBe(1);
});
```

- [ ] **Step 2: Run it to verify it fails or passes**

Run: `npm run build && npm run e2e -- appearance`
Expected: the current toast provider already renders exactly one `role="status"` container, so this may pass. The styling change is then verified by the visual review in Step 5. Keep the test — it is the regression fence for the "exactly one status region" rule.

- [ ] **Step 3: Restyle the toast**

Replace `apps/ui/src/components/ui/toast.tsx`:

```tsx
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { cn } from '../../lib/cn.ts';

type Tone = 'info' | 'error';
type Toast = { id: number; message: string; tone: Tone };
const ToastContext = createContext<(message: string, tone?: Tone) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string, tone: Tone = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[22rem] max-w-[90vw] flex-col gap-2"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              'pointer-events-auto rounded-card border bg-[rgb(18_22_38/0.94)] p-3 shadow-panel backdrop-blur-[18px]',
              t.tone === 'error' ? 'border-danger/40' : 'border-glass-border',
            )}
          >
            <div className="flex items-start gap-2">
              <span
                aria-hidden="true"
                className={cn(
                  'mt-px grid h-4 w-4 shrink-0 place-items-center rounded-[5px] border text-[10px] font-bold',
                  t.tone === 'error'
                    ? 'border-danger/35 bg-danger/15 text-danger-foreground'
                    : 'border-success/35 bg-success/15 text-success-foreground',
                )}
              >
                {t.tone === 'error' ? '!' : '✓'}
              </span>
              <p className="text-xs leading-relaxed text-foreground">{t.message}</p>
            </div>
            <div
              aria-hidden="true"
              className={cn(
                'mt-2 h-0.5 rounded-full bg-gradient-to-r to-transparent',
                t.tone === 'error' ? 'from-danger' : 'from-accent',
              )}
            />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
```

- [ ] **Step 4: Create the tooltip and scroll area**

Create `apps/ui/src/components/ui/tooltip.tsx`:

```tsx
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { cn } from '../../lib/cn.ts';

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <TooltipPrimitive.Provider delayDuration={200}>{children}</TooltipPrimitive.Provider>;
}

export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export function TooltipContent({ className = '', sideOffset = 4, ...props }: ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          'z-50 max-w-xs rounded-control border border-glass-border bg-[rgb(18_22_38/0.96)] px-2 py-1 text-xs text-foreground shadow-panel backdrop-blur-[18px]',
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
}
```

Create `apps/ui/src/components/ui/scroll-area.tsx`:

```tsx
import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area';
import type { ComponentPropsWithoutRef } from 'react';
import { cn } from '../../lib/cn.ts';

export function ScrollArea({ className = '', children, ...props }: ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root>) {
  return (
    <ScrollAreaPrimitive.Root className={cn('relative overflow-hidden', className)} {...props}>
      <ScrollAreaPrimitive.Viewport className="h-full w-full rounded-[inherit]">
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}

export function ScrollBar({ className = '', ...props }: ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      orientation="vertical"
      className={cn('flex w-2 touch-none select-none p-0.5 transition-colors', className)}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-full bg-border-strong" />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  );
}
```

**Note:** Radix `ScrollArea` replaces native overflow on the element it wraps. Use it only where a custom scrollbar is wanted (the terminal log pane and the sidebar project list). **Do not** wrap the board's horizontal scroller — `board.spec.ts` relies on native horizontal scrolling and `scrollIntoViewIfNeeded`.

- [ ] **Step 5: Run the gate**

```bash
npm run check:pins && npm run lint && npm run typecheck && npm test && npm run build && npm run e2e
```

Expected: all green. Exactly one `role="status"` element exists. ✓

- [ ] **Step 6: Commit**

```bash
git add apps/ui/src/components/ui/toast.tsx apps/ui/src/components/ui/tooltip.tsx apps/ui/src/components/ui/scroll-area.tsx
git commit -m "feat(ui): restyle the toast and add tooltip and scroll-area primitives

Toasts become glass notifications with a tone icon and an accent
progress bar while keeping the single role=status region. Tooltip and
ScrollArea wrappers are ready for the icon buttons and log panes."
```

---

## Phase 5 — Polish

### Task 15: Empty states, skeletons, focus rings and the contrast audit

**Files:**
- Modify: `apps/ui/src/components/kanban/column.tsx`
- Modify: `apps/ui/src/routes/board.tsx`
- Modify: `apps/ui/src/lib/stories.ts`
- Modify: `apps/ui/src/index.css`

**Interfaces:**
- Consumes: `Skeleton` from `../ui/skeleton.tsx`; `STATUS_THEME`.
- Produces: no new public APIs — empty columns render a placeholder; the board renders skeleton cards while the first fetch is in flight.

- [ ] **Step 1: Write the failing e2e assertion**

Append to `e2e/tests/appearance.spec.ts`:

```ts
test('an empty column shows a quiet placeholder instead of a blank box', async () => {
  const { page } = launched;
  await openBoard(page);
  const column = page.getByTestId('column-NEW');
  await expect(column).toBeVisible();
  await expect(column.getByTestId('column-empty-NEW')).toBeVisible();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build && npm run e2e -- appearance`
Expected: FAIL — `column-empty-NEW` does not exist.

- [ ] **Step 3: Add the empty state to the column**

In `apps/ui/src/components/kanban/column.tsx`, inside the `<ol>`, replace:

```tsx
<ol className="flex min-h-12 flex-col gap-2 overflow-y-auto px-2 pb-2">
  {stories.map((s) => (
    <li key={s.id}>
      <Card story={s} onMove={onMove} onOpenTerminal={onOpenTerminal} />
    </li>
  ))}
</ol>
```

with:

```tsx
<ol className="flex min-h-12 flex-col gap-2 overflow-y-auto px-2 pb-2">
  {stories.length === 0 && (
    <li
      data-testid={`column-empty-${status}`}
      className="rounded-card border border-dashed border-border px-3 py-6 text-center text-[11px] text-muted-2"
    >
      Nothing here yet
    </li>
  )}
  {stories.map((s) => (
    <li key={s.id}>
      <Card story={s} onMove={onMove} onOpenTerminal={onOpenTerminal} />
    </li>
  ))}
</ol>
```

- [ ] **Step 4: Add skeleton cards while the board loads**

In `apps/ui/src/routes/board.tsx`, import `Skeleton` and render placeholders while the first fetch is pending. Add to the component:

```tsx
const [loading, setLoading] = useState(true);
```

and change the stories effect to clear it. Because `useStories` owns the fetch, the simplest correct approach is to derive it from the query: track whether a fetch has completed.

In `apps/ui/src/lib/stories.ts`, add a `loading` flag to the hook's return value:

```ts
const [loading, setLoading] = useState(true);
```

set `setLoading(false)` in the `finally` of `refetch`, and return `{ stories, error, refetch, loading }`.

Then in `apps/ui/src/routes/board.tsx`:

```tsx
const { stories, error, refetch, loading } = useStories(id, query);
```

and render skeletons when `loading && stories.length === 0`:

```tsx
{loading && stories.length === 0 ? (
  <div className="flex gap-2.5 p-4" aria-hidden="true">
    {['NEW', 'READY', 'IN_PROGRESS'].map((s) => (
      <div key={s} className="w-[246px] shrink-0 space-y-2 rounded-panel border border-glass-border bg-surface p-2">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    ))}
  </div>
) : (
  <Board stories={stories} onChanged={refetch} />
)}
```

- [ ] **Step 5: Audit focus rings and contrast**

In `apps/ui/src/index.css`, add a global focus-visible fallback so no interactive element can lose its ring:

```css
@layer base {
  :focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
  }
}
```

Then verify by hand, in both themes:

1. Every interactive element (buttons, links, inputs, menu items, column collapse toggles) shows a visible violet focus ring when tabbed to.
2. Body text on a card reads at ≥ 4.5:1 against the card background in both themes. The card background is translucent over the aurora gradient — check the *lightest* region of the gradient behind a card, not the darkest.
3. The `muted-2` text (footer meta, placeholders) reads at ≥ 4.5:1 where it carries meaning (the attempt counter and the SHA are meaningful, so they must use `muted`, not `muted-2`).
4. The status pill foregrounds in `STATUS_THEME` read at ≥ 4.5:1 against their own `softBg`.

If any check fails, adjust the token value in `:root` / `.dark` — not the component.

- [ ] **Step 6: Run the gate**

```bash
npm run check:pins && npm run lint && npm run typecheck && npm test && npm run build && npm run e2e
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add apps/ui/src/components/kanban/column.tsx apps/ui/src/components/kanban/board.tsx apps/ui/src/routes/board.tsx apps/ui/src/lib/stories.ts apps/ui/src/index.css
git commit -m "feat(ui): add empty states, loading skeletons and a focus-ring fallback

Empty columns explain themselves instead of showing a blank box, the
board shows skeleton cards during the first fetch, and a global
focus-visible rule guarantees no control loses its ring."
```

---

### Task 16: Full verification, visual review and documentation

**Files:**
- Modify: `e2e/tests/appearance.spec.ts` (final assertions)
- Modify: `docs/superpowers/specs/2026-10-22-aurora-kanban-redesign-design.md` (status note only, if needed)

**Interfaces:**
- Consumes: everything built in Tasks 1–15.
- Produces: the completed redesign, verified.

- [ ] **Step 1: Add the final appearance assertions**

Append to `e2e/tests/appearance.spec.ts`:

```ts
test('every status column paints its own signature colour', async () => {
  const { page } = launched;
  await openBoard(page);
  const expected: Record<string, string> = {
    NEW: '148, 163, 184',
    READY: '56, 189, 248',
    IN_PROGRESS: '167, 139, 250',
    TESTING: '34, 211, 238',
    READY_FOR_REVIEW: '52, 211, 153',
    REWORK: '251, 191, 36',
    BLOCKED: '251, 113, 133',
    AWAITING_MERGE: '45, 212, 191',
    DONE: '16, 185, 129',
    CANCELLED: '100, 116, 139',
  };
  for (const [status, rgb] of Object.entries(expected)) {
    const image = await page.getByTestId(`column-rail-${status}`).evaluate((el) => getComputedStyle(el).backgroundImage);
    expect(image, `${status} rail`).toContain(rgb);
  }
});

test('cards never use a backdrop filter', async () => {
  const { page } = launched;
  await apiCall(page, 'POST', `/projects/${projectId}/stories`, { title: 'Perf story' });
  const card = page.getByTestId('card-INV-1');
  await expect(card).toBeVisible();
  const filter = await card.evaluate((el) => getComputedStyle(el).backdropFilter);
  expect(filter === 'none' || filter === '').toBe(true);
});
```

- [ ] **Step 2: Run the complete verification suite**

Run:

```bash
npm run check:pins && npm run lint && npm run typecheck && npm test && npm run build && npm run e2e
```

Expected: **all green, zero failures.** Every spec in `e2e/tests/` passes: `appearance.spec.ts`, `board.spec.ts`, `dashboard.spec.ts`, `lifecycle.spec.ts`, `security.spec.ts`.

- [ ] **Step 3: Visual review against the approved mockups**

Run the app and compare against the approved designs:

```bash
npm run dev
```

Check each of these against the mockups that were approved in the brainstorming session:

| Surface | What to verify |
|---------|-----------------|
| App shell | Glass sidebar, brand block, project list, orchestrator status card, compact top bar |
| Projects page | Glass project cards with key badge, path, base branch and readiness chip |
| Board | Ten columns with status rails and count chips; glass cards; priority chips; live-run strip; merge and revert CTAs; glowing drop target; right-edge fade |
| Story modal | Glass panel over a blurred board; five tabs with a glowing active indicator; segmented filter; colour-railed log entries |
| Dialogs | Glass forms, accent focus rings, segmented priority control |
| Toasts | Glass notification, tone icon, accent progress bar |
| Settings | Appearance / runtime / model / about cards; segmented controls |

Both themes: toggle in Settings and repeat the sweep. Nothing may look flat or half-styled.

- [ ] **Step 4: Confirm the behaviour contract one final time**

Verify that `git diff main -- e2e/tests/board.spec.ts e2e/tests/dashboard.spec.ts` is empty — the two frozen specs were never edited.

Run:

```bash
git diff main -- e2e/tests/board.spec.ts e2e/tests/dashboard.spec.ts
git diff main --stat -- apps/desktop packages
```

Expected: both commands produce **no output**.

- [ ] **Step 5: Commit the final assertions**

```bash
git add e2e/tests/appearance.spec.ts
git commit -m "test(ui): assert the status colour system and the card blur budget

Every column rail must paint its own signature colour, and cards must
never carry a backdrop filter — that budget is what keeps the 200-story
board fast."
```

- [ ] **Step 6: Report**

Report to the user:

- What changed, per phase.
- The verification output: the exact commands run and their results.
- Any acceptance criterion from the spec's §12 that could not be met, with the reason.
- The next recommended step.

---

## Appendix A — Task dependency order

```
Task 1  (deps, cn)
   ├── Task 2  (tokens)  ──┐
   ├── Task 3  (status)  ──┤
   └────────────────────────┴──► Task 4 (primitives)
                                    │
                                    ├──► Task 5 (shell) ──► Task 6 (projects) ──► Task 7 (settings)
                                    │
                                    ├──► Task 8 (column) ──► Task 9 (card) ──► Task 10 (board) ──► Task 11 (move menu)
                                    │
                                    └──► Task 12 (dialog) ──► Task 13 (modal) ──► Task 14 (toast/tooltip/scroll)

Task 15 (polish) depends on 7, 10, 11, 12, 13, 14.
Task 16 (verification) depends on 15.
```

Tasks 5, 8, 9 and 12 are independent of each other and can be executed in parallel by separate agents, as long as Task 4 has landed.

## Appendix B — The frozen behaviour contract

Nothing below may change without a deliberate, reviewed decision.

**`data-testid` values**

```
board                      card-<KEY>              column-<STATUS>
new-story                  project-list            project-error
app-ready                  data-dir                opencode-status
opencode-error             opencode-login-code     model-test-reply
active-run-<KEY>           awaiting-merge-<KEY>    revert-merge-<KEY>
stop-run-<KEY>             hold-toggle-<KEY>       modal-stop-run-<KEY>
modal-revert-merge-<KEY>   banner-revert-merge-<KEY>   modal-reject-plan-<KEY>
clarifications-submit      system-failure          column-rail-<STATUS>
column-empty-<STATUS>      story-priority-<KEY>    story-attempts-<KEY>
app-sidebar                orchestrator-card       board-toolbar
sidebar-project-list       settings-appearance     settings-runtime
settings-about             settings-model          project-card-<KEY>
```

**⚠ Never introduce a new `data-testid` that starts with `card-`.** `board.spec.ts` counts
`page.locator('[data-testid^="card-"]')` and expects exactly 200. A `card-priority-<KEY>` id
would make it 400 and fail the suite (E1).

**⚠ `project-list` must exist exactly once** — the dashboard card grid, never the sidebar
(E4). The sidebar uses `sidebar-project-list`.

**⚠ Exactly one element may be named `INV · Inventory`.** That is the dashboard card link.
The sidebar's project links are named `Open <name>` so they cannot collide (E2, E3).

**Accessible names**

```
Projects        Settings        INV · Inventory        Search stories
Filter by label Sort stories    Move to…               Title
Description     Acceptance criteria (one per line)
Labels (comma separated)        Priority              Default model
Test prompt     Create story    Cancel story           Keep story
Show            Sign in to OpenCode (free)             Send answers
Reject & re-plan                Send to rework         Back
Approve & Merge                 Revert Merge           Stop run
Hold            Unhold          Review & Merge
```

**Verbatim `title` attribute**

```
Only the orchestrator moves stories from NEW to IN_PROGRESS
```

**Roles**

- Exactly one element with `role="status"` (the toast region).
- The move menu is `role="menu"`; its items are `role="menuitem"` and their accessible name is the **raw status string** (`IN_PROGRESS`, not `In progress`).
- Dialogs are `role="dialog"` with `aria-modal="true"`.

## Appendix C — Quick reference

```bash
# unit tests for one file
npx vitest run apps/ui/test/status-theme.test.ts

# the full gate
npm run check:pins && npm run lint && npm run typecheck && npm test

# e2e (build first)
npm run build && npm run e2e

# e2e for one spec
npm run build && npm run e2e -- appearance

# run the app
npm run dev
```
