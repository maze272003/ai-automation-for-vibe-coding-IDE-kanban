# Aurora — Premium Kanban Redesign (`UI-REDESIGN`)

## 1. Overview & Context

### 1.1 Problem

The AI Kanban desktop app is functionally complete but visually plain. Every surface is built
from flat `zinc` utility classes: `border-zinc-200 bg-white`, `rounded-md`, `shadow-sm`. The board
reads as a wireframe rather than a product, and the parts of the app that carry the most weight —
the story detail modal with its five tabs of agent reasoning, tool calls and diffs — are the
plainest surfaces in the codebase.

The user request: *"redesign of the kanban boards — premium design using shadcn components or
Radix, professional like other premium kanban aesthetics, not a plain design."*

### 1.2 Goals

| # | Goal | Success signal |
|---|------|----------------|
| G1 | Every surface (shell, dashboard, board, overlays, settings) reads as one designed product | No screen mixes old flat styling with new glass styling |
| G2 | A professional "premium kanban" aesthetic, not a restyled wireframe | Aurora direction approved against rendered mockups (§2.2) |
| G3 | Accessible interaction primitives instead of hand-rolled ARIA | Dialog traps and restores focus; move menu is keyboard-navigable |
| G4 | One consistent colour language for the ten story statuses | Every status has one signature colour, sourced from a single map |
| G5 | Zero regression in behaviour | Existing e2e suite passes unmodified |
| G6 | The redesign stays fast with 200 stories on screen | 200-card board renders within the existing e2e budget |

### 1.3 Non-goals

- **No backend, DTO, database or workflow-machine changes.** `dragVerdict`, `performMove`,
  `performEvent` and every API route stay exactly as they are.
- **No change to the story lifecycle or the meaning of any status.** The ten columns remain
  ten columns in the same order.
- **No new feature work.** No swimlanes, no swimlane filters, no command palette, no board
  preferences persistence. The board layout is unchanged; only its craft changes.
- **No new UI framework beyond what is listed in §5.2.** The dependency footprint is a fixed,
  reviewed set — not "whatever the shadcn CLI pulls in".

### 1.4 Scope

In scope — every surface in `apps/ui/src`:

```
routes/root.tsx      app shell: sidebar, top bar, orchestrator status card
routes/dashboard.tsx projects page: project cards, add-repository panel
routes/settings.tsx  settings page: appearance, agent runtime, default model, about
components/kanban/*  board, column, card, move menu, dialogs, terminal modal
components/ui/*      the primitive library (rebuilt)
lib/theme.ts         unchanged API, new token wiring
lib/status-theme.ts  NEW — the single source of truth for status/priority colour
```

Out of scope: `apps/desktop` (Electron shell), `apps/orchestrator`, `packages/*`.

---

## 2. Design Direction

### 2.1 Chosen direction: **Aurora**

Deep indigo-violet gradient canvas, translucent frosted panels, luminous accents.

| Layer | Treatment |
|-------|-----------|
| Canvas | Fixed radial-gradient wash: indigo `#1b2a5e` top-left, violet `#7a2c8c` top-right, teal `#18757a` low-centre, base `#090d1a` |
| Panels | `rgb(255 255 255 / 0.045)` fill, `rgb(255 255 255 / 0.09)` border, `blur(10px)`, 1px inset top highlight |
| Cards | `rgb(255 255 255 / 0.055)` fill (no blur — see §7), `rgb(255 255 255 / 0.10)` border, deep soft shadow |
| Accent | `#8b5cf6` → `#6366f1` gradient for primary actions, violet glow ring |
| Type | System UI stack, tight tracking on headings, monospace for keys / SHAs / elapsed timers |

### 2.2 Alternatives considered and rejected

| Alternative | Why rejected |
|-------------|--------------|
| **Graphite** (near-black, Linear-style, single accent) | Renders beautifully but reads as another developer tool; the user asked for "premium" in the showcase sense |
| **Studio** (layered light, white cards on soft shadows) | Professional but generic — closest to what a well-made SaaS already does, so it adds the least identity |
| **Full shadcn/ui CLI install** | Pulls 30+ Radix packages into an exact-pinned lockfile and fights Tailwind 4's CSS-first setup. Superseded by §5.2 |
| **Zero new dependencies** | Requires hand-implementing focus trap and roving-tabindex. Real accessibility risk |
| **Grouping 10 columns into 5 phase lanes** | Changes the board's mental model and the drop semantics. Not a styling decision — out of scope |
| **Dark-only, drop the light theme** | Removes a feature that exists today. Both themes are kept (§3.3) |

### 2.3 The light theme

Aurora is the **dark** theme. The light theme is a *refined counterpart*, not the old zinc theme:
soft lavender-grey gradient canvas, white glass panels at low alpha, the same accent system and
the same status colours with adjusted (darker) foregrounds for contrast. The Settings theme
toggle switches between them; both are first-class.

---

## 3. Design Token Architecture

### 3.1 Three layers

```
┌─────────────────────────────────────────────────────────────┐
│ PRIMITIVE          raw values, no meaning                   │
│   --aurora-500, --status-emerald-500, --glass-08            │
├─────────────────────────────────────────────────────────────┤
│ SEMANTIC           role-based, defined per theme            │
│   --surface-app --surface-panel --surface-card              │
│   --surface-raised --border-subtle --border-strong          │
│   --text-primary --text-secondary --text-tertiary           │
│   --accent --accent-contrast --ring --shadow-panel          │
├─────────────────────────────────────────────────────────────┤
│ COMPONENT          only where a component diverges         │
│   --card-radius --column-blur --ctl-height --card-accent    │
└─────────────────────────────────────────────────────────────┘
```

Semantic tokens are mapped into Tailwind 4 via `@theme`, so they are usable as utilities
(`bg-surface-panel`, `text-secondary`, `border-subtle`) rather than as raw `var()` calls in JSX.

### 3.2 Implementation

`apps/ui/src/index.css` owns all of it:

```css
@import "tailwindcss";
@custom-variant dark (&:where(.dark, .dark *));

:root {            /* refined light theme */
  --surface-app: ...; --surface-panel: ...; --accent: ...;
}
.dark {           /* Aurora dark theme */
  --surface-app: ...; --surface-panel: ...; --accent: ...;
}

@theme inline {
  --color-surface-app: var(--surface-app);
  --color-surface-panel: var(--surface-panel);
  ...
}
```

### 3.3 Theme switching

`lib/theme.ts` is **unchanged in API** — `loadTheme()` and `applyTheme()` keep working, and the
`.dark` class still toggles on `<html>`. Only the token blocks behind it change. The Settings
toggle is restyled as a segmented control but calls the same two functions.

### 3.4 Status colour language

Ten statuses, ten signature colours, used consistently on the column rail, count chip, status
pill, badge, sidebar dot and merge CTA.

| Status | Colour | Rail | Foreground |
|--------|--------|------|------------|
| `NEW` | slate | `#94a3b8` | `#cbd5e1` |
| `READY` | sky | `#38bdf8` | `#7dd3fc` |
| `IN_PROGRESS` | violet | `#a78bfa` | `#c4b5fd` |
| `TESTING` | cyan | `#22d3ee` | `#67e8f9` |
| `READY_FOR_REVIEW` | emerald | `#34d399` | `#6ee7b7` |
| `REWORK` | amber | `#fbbf24` | `#fcd34d` |
| `BLOCKED` | rose | `#fb7185` | `#fda4af` |
| `AWAITING_MERGE` | teal | `#2dd4bf` | `#5eead4` |
| `DONE` | deep emerald | `#10b981` | `#6ee7b7` |
| `CANCELLED` | deep slate | `#64748b` | `#94a3b8` |

Priority colours: `P0` rose `#fb7185`, `P1` pink `#f472b6`, `P2` slate `#94a3b8`, `P3` dim
slate `#64748b`. Blocked reasons reuse the rose family.

---

## 4. Status Theme Map — the single source of truth

`apps/ui/src/lib/status-theme.ts`:

```ts
export interface StatusTheme {
  label: string;          // human label, e.g. "Ready for review"
  dot: string;            // solid dot colour
  rail: string;           // column rail gradient
  softBg: string;         // badge background
  softFg: string;         // badge foreground
  glow: string;           // drop-target / focus glow
}

export const STATUS_THEME: Record<StoryStatus, StatusTheme>;
export const PRIORITY_THEME: Record<Priority, { label: string; softBg: string; softFg: string }>;
export const BLOCKED_REASON_THEME: Record<BlockedReason, { label: string; softBg: string; softFg: string }>;
```

Every consumer imports from here. No component hard-codes a status colour. This is what makes the
result read as a designed system rather than hand-painted surfaces.

---

## 5. Component Layer

### 5.1 Inventory

`apps/ui/src/components/ui/` — shadcn conventions (`cva` variants, `cn()` merging, `components.json`
present so `npx shadcn add` works for future primitives):

| Component | Base | Notes |
|-----------|------|-------|
| `button.tsx` | — | **Public API unchanged**: `variant="primary\|secondary\|danger\|ghost"`, `className`, `...props` |
| `badge.tsx` | — | **Public API unchanged**: `tone="default\|muted\|warn\|danger\|ok"`, plus new `tone="status"` driven by `STATUS_THEME` |
| `card.tsx` | — | New: glass surface primitive |
| `dialog.tsx` | Radix Dialog | **Public API unchanged**: `open`, `title`, `onClose`, `children` |
| `dropdown-menu.tsx` | Radix DropdownMenu | New: replaces the hand-rolled move menu |
| `tooltip.tsx` | Radix Tooltip | New: for icon buttons and truncated text |
| `scroll-area.tsx` | Radix ScrollArea | New: styled scrollbars for board and log panes |
| `input.tsx` / `textarea.tsx` / `select.tsx` / `label.tsx` | — | New: styled form controls (`field.tsx` keeps `TextField`/`TextArea` exports) |
| `separator.tsx`, `skeleton.tsx` | — | New: separators, loading placeholders |
| `toast.tsx` | — | **Behaviour unchanged**: exactly one `role="status"` container, `useToast()` API preserved |

### 5.2 New dependencies (exact pins, the only ones)

```
@radix-ui/react-dialog        @radix-ui/react-dropdown-menu
@radix-ui/react-tooltip       @radix-ui/react-scroll-area
@radix-ui/react-slot          class-variance-authority
clsx                          tailwind-merge
```

All installed with `npm install -E` (exact). `npm run check:pins` must pass.

### 5.3 Why these and not more

Radix is used only where native HTML cannot deliver the behaviour:

- `Dialog` — focus trap, scroll lock, Esc, focus restore (the native `<dialog>` gives a trap but
  not a consistent focus-restore or a styled entrance animation).
- `DropdownMenu` — roving tabindex, type-ahead, item roles, Esc/arrow handling. The current move
  menu is a hand-rolled `<ul role="menu">` with no keyboard navigation.
- `Tooltip` — hover/focus descriptions for icon buttons.
- `ScrollArea` — styled, consistent scrollbars.
- `Slot` — `asChild` composition for `Button` and `Badge`.

Everything else (badges, cards, inputs, tokens) is plain HTML plus Tailwind. No other package is
introduced.

### 5.4 `cn()`

`apps/ui/src/lib/cn.ts` — `clsx` + `tailwind-merge`, so a caller's `className` always beats a
component's default (e.g. `className="w-64"` overriding `w-full`).

---

## 6. Surface Designs

### 6.1 App shell

```
┌──────────────┬──────────────────────────────────────────────────────┐
│              │  Top bar: breadcrumb · ⌘K search · theme · help    │
│  Sidebar     ├──────────────────────────────────────────────────────┤
│  (glass)     │                                                      │
│              │  Content (route)                                    │
│  brand       │                                                      │
│  nav         │                                                      │
│  projects    │                                                      │
│  status card │                                                      │
└──────────────┴──────────────────────────────────────────────────────┘
```

- **Sidebar** (212px, glass, `border-right`): brand block with gradient mark + version; nav
  (Projects, Settings); a "Your projects" list with monospace key badges and a state dot; an
  **orchestrator status card** pinned to the bottom showing live state and the data folder.
- **Top bar**: breadcrumb + subtitle, command-palette search field (decorative affordance — no
  palette is implemented in this project), theme toggle, help button.
- The current top bar (`AI Kanban` + links + `orchestrator: ready`) is replaced by this shell.

**Accessibility contract**: the nav links keep the exact accessible names `Projects` and
`Settings`. Project rows keep the exact label `INV · Inventory`. The e2e flow
(Settings → Projects → project) keeps working.

### 6.2 Projects page (dashboard)

- Page header: title + one-line explanation.
- Grid of glass **project cards**: key badge, name, repository path (monospace, truncated),
  base-branch chip, readiness chip (`ready` / `unavailable` in the warning tone).
- **Add a local repository** panel: dashed glass border, explanation, primary button. The
  existing `Browse…` directory picker and the full create form are preserved — the form fields
  (Name, Key, Repository folder) keep their labels and the `project-error` test id.

### 6.3 Board

```
┌ Top bar ─────────────────────────────────────────────────────────────┐
│ INV · Inventory   ⌕ search   Filter  Sort   + New story   ● ready   │
├──────────────────────────────────────────────────────────────────────┤
│ ┌─ NEW ──┐ ┌─ READY ─┐ ┌─ IN PROGRESS ─┐ ┌─ TESTING ─┐ ┌─ REVIEW ─┐  │
│ │ rail   │ │ rail    │ │ rail          │ │ rail      │ │ rail     │  │
│ │ ● 2  ⌄ │ │ ● 1  ⌄ │ │ ● 2  ⌄        │ │ ● 1  ⌄   │ │ ● 1  ⌄  │  │
│ │ card   │ │ card   │ │ card (live)   │ │ card     │ │ card     │  │
│ │ card   │ │ card   │ │ card          │ │          │ │          │  │
│ └────────┘ └────────┘ └───────────────┘ └──────────┘ └──────────┘  │
│                        ← horizontal scroll, right edge fade →       │
└──────────────────────────────────────────────────────────────────────┘
```

- **Column**: 246px wide (was 288px), glass panel, 3px **accent rail** across the top in the
  status colour, header row with dot + uppercase tracked name + count chip + collapse chevron.
  The collapsed DONE/CANCELLED behaviour is preserved exactly (the `Show` button must keep that
  accessible name).
- **Drop target**: the column under the dragged card gets the violet glow border + outer bloom.
  The dragged card renders as a dashed ghost.
- **Card**: key (monospace) + priority chip; title; label pills; optional **live-run strip**
  (teal glass, pulsing dot, `opencode · implementer`, uppercase `working`); optional
  **merge CTA** (`Review & Merge →` emerald glass / `Revert Merge ↺` rose glass); footer
  separated by a hairline carrying `attempt n/max` and the candidate SHA; `Move to…` trigger.
- **Scroll affordance**: a right-edge fade plus a visible scrollbar make the remaining columns
  discoverable. Columns are still `shrink-0` and the board still scrolls horizontally.

### 6.4 Overlays

- **Story detail modal** — one glass panel on a blurred, aurora-tinted board. Header row: key
  chip, status pill, title, elapsed timer, then actions (Stop run / Open in CLI / Copy CLI /
  Approve & Merge / Revert Merge / close). The five tabs (Terminal Logs & Thoughts, Architecture
  Plan, Verification Checks, Code Review, Git Changes) are preserved as tabs with a glowing
  active indicator. The terminal filter pills (All / Thoughts / Tools / Output) become a
  segmented control whose active pill takes the colour of the category it filters. Log entries
  get a left colour rail by type: violet = reasoning, cyan = tool, emerald = output,
  slate = user.
- **New story dialog** — glass form; Title, Description, Acceptance criteria, Labels keep their
  labels verbatim; Priority becomes a segmented control; the submit button keeps the accessible
  name `Create story`.
- **Move to… menu** — a Radix dropdown menu. Item names remain the **raw status string**
  (`IN_PROGRESS`, not "In progress") because the e2e selects on that. Disabled items keep their
  `title` attribute **verbatim** and additionally show the reason inline.
- **Confirm / Request changes / Clarifications / Reject plan dialogs** — same glass treatment,
  same button names (`Cancel story`, `Keep story`, …).
- **Toast** — glass notification with a tone-coloured icon and an accent progress bar. Exactly
  one `role="status"` container in the DOM.

### 6.5 Settings

Regrouped into glass cards:

- **Appearance** — theme as a segmented control (`Light` / `Aurora`), calling the existing
  `applyTheme`.
- **Agent runtime** — OpenCode mode as a segmented control (`App-managed` / `My personal CLI`)
  instead of stacked radio inputs. The `opencode-status` and `opencode-error` test ids, the
  `opencode-login-code` test id and the `Sign in to OpenCode (free)` button name are preserved.
- **Default model** — a styled select instead of a native one; `aria-label="Default model"` is
  preserved. The `model-test-reply` test id is preserved.
- **About** — a definition grid (data folder, app version, Electron, OpenCode) with the
  `data-dir` test id preserved.

---

## 7. Performance Strategy

The 200-story render is an existing e2e assertion, and glass effects are expensive. The strategy
is to put blur where it is visible and nowhere else.

| Rule | Detail |
|------|--------|
| Blur budget | `backdrop-filter` on **~15 elements only**: app bar, sidebar, column panels, modal/dialog panels, dropdowns, toasts |
| No blur on cards | Cards use translucent **solid** fills (`rgb(255 255 255 / 0.055)`) with a border and inset highlight — visually near-identical over a static gradient, but free at 200 instances |
| Painted-once canvas | The aurora gradient lives on a `position: fixed` background layer, so scrolling and dragging never repaint it |
| No per-card animations | The live-run pulse is the only animation, and only on cards that are actually running |
| Memoisation | `Card` is wrapped in `React.memo`; `Board` callbacks are stable (`useCallback`) |
| Containment | `content-visibility: auto` + `contain-intrinsic-size` on card items so off-screen cards skip layout and paint |

**Acceptance**: the existing `renders 200 stories` e2e (30s timeout) passes, and the board feels
no slower than today.

---

## 8. Accessibility

- **Dialog** — Radix supplies the focus trap, scroll lock, Esc handling and focus restore.
- **Dropdown menu** — roving tabindex, arrow-key navigation, type-ahead, item roles.
- **Contrast** — every glass panel sits on an opaque scrim (`rgb(16 20 36 / 0.90)` dark /
  `rgb(255 255 255 / 0.92)` light) so text contrast is ≥ 4.5:1 regardless of the gradient behind
  it. The blur is decoration, never the carrier of legibility. Status foreground colours are
  chosen against their soft backgrounds, not against the canvas.
- **Focus** — a visible focus ring in the accent colour on every interactive element, including
  inside the board, dialogs and menus.
- **Reduced motion** — `prefers-reduced-motion: reduce` disables the live-run pulse, the toast
  progress animation and all transitions.
- **Roles preserved** — `role="status"` (one), `role="menu"` / `role="menuitem"`, `aria-modal`,
  `aria-expanded`, `aria-haspopup`, `aria-label` on every column and card.

---

## 9. Behaviour Preservation Contract

The redesign is presentational. The following are **frozen** and verified by the existing e2e
suite, which must pass **unmodified**:

| Kind | Values |
|------|--------|
| `data-testid` | `board`, `card-<KEY>`, `column-<STATUS>`, `new-story`, `active-run-<KEY>`, `awaiting-merge-<KEY>`, `revert-merge-<KEY>`, `stop-run-<KEY>`, `hold-toggle-<KEY>`, `project-list`, `project-error`, `app-ready`, `data-dir`, `opencode-status`, `opencode-error`, `opencode-login-code`, `model-test-reply` |
| `aria-label` / label text | `Search stories`, `Filter by label`, `Sort stories`, `Move to…`, `Title`, `Description`, `Acceptance criteria (one per line)`, `Labels (comma separated)`, `Priority`, `Default model`, `Test prompt`, `Create story`, `Cancel story`, `Keep story`, `Show`, `Projects`, `Settings` |
| Roles | exactly one `role="status"`; `role="menu"` on the move menu; `role="menuitem"` whose accessible name is the **raw status string** |
| Verbatim attribute | the disabled-move `title` string (`Only the orchestrator moves stories from NEW to IN_PROGRESS`) — the inline reason is additive only |
| Behaviour | drag/drop rules, `dragVerdict` gating, confirm dialogs, merge/revert flows, toast messages, the 2s polling in the terminal modal |

---

## 10. Testing Strategy

| Level | Test | Covers |
|-------|------|--------|
| Unit (vitest, node env) | `apps/ui/test/status-theme.test.ts` | `STATUS_THEME` covers all ten statuses; `PRIORITY_THEME` covers P0–P3; `BLOCKED_REASON_THEME` covers every `BlockedReason`; no missing entries |
| Unit (vitest, node env) | `apps/ui/test/cn.test.ts` | `cn()` merges classes and lets the caller's `className` win |
| E2E (playwright) | `e2e/tests/board.spec.ts` (existing, **unmodified**) | The behaviour fence — must pass untouched |
| E2E (playwright) | `e2e/tests/appearance.spec.ts` (new) | Theme toggle flips the applied tokens; dialog traps and restores focus; move menu is keyboard-navigable and its items are `menuitem`s with raw status names; the disabled item keeps its `title`; the board renders 200 cards within budget; reduced-motion disables the pulse |
| E2E (playwright) | `e2e/tests/dashboard.spec.ts` (existing) | Project list still renders; `project-error` path intact |

**Gates** (per `AGENTS.md`):

```
npm run check:pins && npm run lint && npm run typecheck && npm test && npm run e2e
```

---

## 11. Rollout Plan

Five independently shippable phases. Each leaves the app working and verifiable.

| Phase | Content | Exit check |
|-------|---------|------------|
| **1 — Foundation** | Token layers in `index.css`; `cn()`; `components.json`; rebuild `button`, `badge`, `card`, `input`, `textarea`, `select`, `label`, `separator`, `skeleton`; add the exact-pinned deps | `check:pins`, lint, typecheck, unit tests pass; the primitives pick up the Aurora look in this phase and every later phase consumes tokens only |
| **2 — Shell** | Sidebar, top bar, orchestrator status card, projects page, settings page | Existing e2e passes; new appearance e2e passes for theme toggle |
| **3 — Board** | Columns (rail, chip, collapse), cards, status theme map, live-run strip, merge/revert CTAs, drag/drop states, board toolbar | Existing `board.spec.ts` passes unmodified; 200-card budget holds |
| **4 — Overlays** | Radix `Dialog` + `DropdownMenu` + `Tooltip` + `ScrollArea`; terminal modal restyle; toast restyle | Focus-trap and keyboard-nav e2e pass; all dialog button names preserved |
| **5 — Polish** | Motion and reduced-motion, empty states, skeletons, focus states, final contrast audit | Full gate suite green; manual review against the approved mockups |

---

## 12. Acceptance Criteria

1. Every surface listed in §1.4 uses the Aurora token set; no surface retains flat `zinc` chrome.
2. All ten statuses render with their §3.4 colour, sourced from `STATUS_THEME` — no hard-coded
   status colour anywhere in `apps/ui/src`.
3. Light and dark themes both exist and are switchable from Settings via the unchanged
   `applyTheme` / `loadTheme` API.
4. Dialogs trap focus and restore it on close; the move menu is fully keyboard-operable.
5. `npm run check:pins && npm run lint && npm run typecheck && npm test && npm run e2e` all pass,
   with `e2e/tests/board.spec.ts` unmodified.
6. The 200-story board renders inside the existing 30-second budget.
7. Text contrast ≥ 4.5:1 on every surface, in both themes.
8. `prefers-reduced-motion` disables all non-essential animation.
9. No backend, contract, database or workflow-machine file is modified.

---

## 13. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Glass effects make 200-card rendering slow | Medium | High | Blur budget of ~15 elements (§7); no blur on cards; `content-visibility`; `React.memo`; existing 200-card e2e as the gate |
| New Radix dependencies conflict with the exact-pin rule | Medium | Medium | `npm install -E` only; `check:pins` runs in the gate; the dependency list is frozen at §5.2 |
| Restyling breaks the e2e contract | Medium | High | §9 freezes every test id, label, role and the one verbatim `title`; `board.spec.ts` stays unmodified as the fence |
| The redesign becomes inconsistent as surfaces are reworked phase by phase | Medium | Medium | The token layers are Phase 1, and every later phase consumes only tokens — no surface may hard-code a colour |
| Hand-rolled move menu semantics regress | Low | High | Replaced by Radix in Phase 4 with a dedicated keyboard-navigation e2e |
| Contrast fails over the gradient | Medium | Medium | Panels sit on an opaque scrim; §12.7 requires a contrast audit in both themes |
| Light theme drifts from the Aurora identity | Medium | Low | Light theme is defined in the same token file with the same semantic names; both are reviewed against §2.3 |

---

## 14. File Inventory

### New files

```
apps/ui/src/lib/cn.ts
apps/ui/src/lib/status-theme.ts
apps/ui/src/components/ui/card.tsx
apps/ui/src/components/ui/dropdown-menu.tsx
apps/ui/src/components/ui/tooltip.tsx
apps/ui/src/components/ui/scroll-area.tsx
apps/ui/src/components/ui/input.tsx
apps/ui/src/components/ui/textarea.tsx
apps/ui/src/components/ui/select.tsx
apps/ui/src/components/ui/label.tsx
apps/ui/src/components/ui/separator.tsx
apps/ui/src/components/ui/skeleton.tsx
apps/ui/src/components/shell/app-shell.tsx
apps/ui/src/components/shell/sidebar.tsx
apps/ui/src/components/shell/top-bar.tsx
apps/ui/src/components/shell/status-card.tsx
apps/ui/test/status-theme.test.ts
apps/ui/test/cn.test.ts
e2e/tests/appearance.spec.ts
apps/ui/components.json
```

### Modified files

```
apps/ui/src/index.css                          tokens, aurora canvas, @theme mapping
apps/ui/package.json                           the eight exact-pinned dependencies
apps/ui/src/lib/stories.ts                     exposes a `loading` flag for the board skeleton
apps/ui/src/components/ui/button.tsx           cva variants, aurora tokens
apps/ui/src/components/ui/badge.tsx            status tone, aurora tokens
apps/ui/src/components/ui/dialog.tsx           Radix-backed, glass panel
apps/ui/src/components/ui/field.tsx            styled inputs (API preserved)
apps/ui/src/components/ui/toast.tsx            glass toast (role=status preserved)
apps/ui/src/components/kanban/*.tsx            restyled to tokens; test ids preserved
apps/ui/src/routes/root.tsx                    app shell
apps/ui/src/routes/dashboard.tsx               project cards
apps/ui/src/routes/settings.tsx                settings cards
```

### Explicitly not modified

```
apps/desktop/**   packages/**   e2e/tests/board.spec.ts   e2e/tests/dashboard.spec.ts
apps/ui/src/lib/theme.ts    loadTheme()/applyTheme() keep working untouched — the
                            existing `.dark` class toggle already drives the new tokens
```
