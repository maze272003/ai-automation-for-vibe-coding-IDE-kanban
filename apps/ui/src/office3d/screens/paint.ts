import { ROOM_ICON_GRIDS, type RoomIcon } from '../ui/icons.ts';
import type { StationState } from '../state/selectors.ts';
import {
  COLUMN_LABEL, type ActivityScreenData, type KanbanScreenData, type PmScreenData, type RunsScreenData, type TestBoardData,
} from './data.ts';
import { GLYPH_H, measurePixelText, paintPixelText, type Ctx2D } from './pixel-font.ts';

export const STATE_COLOR: Record<StationState, string> = {
  idle: '#94a3b8', planning: '#60a5fa', working: '#f59e0b', reviewing: '#a78bfa', testing: '#22d3ee', completed: '#4ade80', error: '#f87171',
};
const BG = '#0f172a';
const PANEL = '#1e293b';
const TEXT = '#e2e8f0';
const DIM = '#64748b';
const RED = '#f87171';
const GREEN = '#4ade80';
const AMBER = '#f59e0b';

const rect = (ctx: Ctx2D, color: string, x: number, y: number, w: number, h: number) => {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
};
const clear = (ctx: Ctx2D, w: number, h: number) => {
  ctx.clearRect(0, 0, w, h);
  rect(ctx, BG, 0, 0, w, h);
};
const fit = (text: string, maxChars: number) => (text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 1))}…` : text);

export function paintKanban(ctx: Ctx2D, data: KanbanScreenData, w: number, h: number): void {
  clear(ctx, w, h);
  const n = data.columns.length;
  const colW = Math.floor(w / n);
  const maxChars = Math.max(1, Math.floor((colW - 2 + 1) / 6));
  data.columns.forEach((c, i) => {
    const x = i * colW;
    rect(ctx, PANEL, x + 1, 1, colW - 2, h - 2);
    paintPixelText(ctx, fit(COLUMN_LABEL[c.id], maxChars), x + 2, 3, 1, TEXT);
    paintPixelText(ctx, String(c.count), x + 2, 3 + GLYPH_H + 2, 1, c.id === 'DONE' ? GREEN : AMBER);
    c.cards.forEach((card, j) => {
      const y = 3 + (GLYPH_H + 2) * 2 + j * (GLYPH_H + 3);
      rect(ctx, '#334155', x + 2, y - 1, colW - 4, GLYPH_H + 2);
      paintPixelText(ctx, fit(card, maxChars), x + 3, y, 1, TEXT);
    });
  });
  if (data.blocked > 0) {
    const label = `${data.blocked}`;
    const bw = measurePixelText(label, 1) + 4;
    rect(ctx, RED, w - bw - 1, h - GLYPH_H - 4, bw, GLYPH_H + 2);
    paintPixelText(ctx, label, w - bw + 1, h - GLYPH_H - 3, 1, BG);
  }
}

export function paintRuns(ctx: Ctx2D, data: RunsScreenData, w: number, h: number): void {
  clear(ctx, w, h);
  const rowH = GLYPH_H + 3;
  data.rows.forEach((r, i) => {
    const y = 2 + i * rowH;
    if (y + GLYPH_H > h) return;
    rect(ctx, STATE_COLOR[r.state], 2, y, 3, GLYPH_H);
    paintPixelText(ctx, fit(r.storyKey, Math.max(1, Math.floor((w - 40) / 6))), 8, y, 1, TEXT);
    paintPixelText(ctx, r.role.slice(0, 3).toUpperCase(), w - measurePixelText('ABC', 1) - 2, y, 1, DIM);
  });
}

const KIND_COLOR: Record<string, string> = { 'tool-start': AMBER, 'tool-end': '#22d3ee', message: '#a78bfa', subagent: GREEN };

export function paintActivity(ctx: Ctx2D, data: ActivityScreenData, w: number, h: number): void {
  clear(ctx, w, h);
  const slot = Math.floor(w / 9);
  const unit = Math.max(1, Math.floor((h - 4) / 7));
  data.bars.forEach((b, i) => {
    const bh = b.height * unit;
    rect(ctx, KIND_COLOR[b.kind] ?? TEXT, i * slot + 2, h - 2 - bh, Math.max(1, slot - 3), bh);
  });
}

const CHECK_COLOR: Record<string, string> = { running: AMBER, failed: RED, passed: GREEN, other: DIM };
const CHECK_MARK: Record<string, string> = { running: '…', failed: '✗', passed: '✓', other: '?' };

export function paintTestBoard(ctx: Ctx2D, data: TestBoardData, w: number, h: number): void {
  clear(ctx, w, h);
  const rowH = GLYPH_H + 3;
  data.rows.forEach((r, i) => {
    const y = 2 + i * rowH;
    if (y + GLYPH_H > h) return;
    paintPixelText(ctx, CHECK_MARK[r.status]!, 3, y, 1, CHECK_COLOR[r.status]!);
    const durW = r.duration ? measurePixelText(r.duration, 1) + 6 : 0;
    paintPixelText(ctx, fit(r.checkKey, Math.max(1, Math.floor((w - 14 - durW) / 6))), 12, y, 1, TEXT);
    if (r.duration) paintPixelText(ctx, r.duration, w - measurePixelText(r.duration, 1) - 3, y, 1, DIM);
  });
  if (data.passed !== null) rect(ctx, data.passed ? GREEN : RED, 0, h - 2, w, 2);
}

export function paintPm(ctx: Ctx2D, data: PmScreenData, w: number, h: number): void {
  clear(ctx, w, h);
  paintPixelText(ctx, data.progressText, 3, 3, 2, TEXT);
  const barY = 3 + GLYPH_H * 2 + 4;
  rect(ctx, PANEL, 3, barY, w - 6, 6);
  if (data.total > 0) rect(ctx, GREEN, 3, barY, Math.floor(((w - 6) * data.done) / data.total), 6);
  paintPixelText(ctx, `+${data.doneToday}`, 3, barY + 10, 1, GREEN);
  if (data.blocked > 0) paintPixelText(ctx, `${data.blocked}`, w - measurePixelText(`${data.blocked}`, 1) - 3, barY + 10, 1, RED);
  rect(ctx, STATE_COLOR[data.state], w - 5, 1, 4, 4);
  void h;
}

/** Audit whiteboard: per failed check, "<story> <check>" in red, then its short reason indented in slate. */
export function paintWhiteboard(ctx: Ctx2D, entries: Array<{ storyKey: string; checkKey: string; summary: string }>, w = 256, h = 128): void {
  ctx.clearRect(0, 0, w, h);
  rect(ctx, '#f8fafc', 0, 0, w, h);
  const rowH = GLYPH_H + 3;
  entries.forEach((e, i) => {
    const y = 2 + i * 2 * rowH;
    if (y + rowH + GLYPH_H > h) return;
    paintPixelText(ctx, fit(`${e.storyKey} ${e.checkKey}`, Math.max(1, Math.floor((w - 4) / 6))), 3, y, 1, '#dc2626');
    paintPixelText(ctx, fit(e.summary, Math.max(1, Math.floor((w - 10) / 6))), 9, y + rowH, 1, '#334155');
  });
}

/**
 * Entrance sign: optional 8x8 pixel icon, then the text, both in the accent colour; an optional tag (the
 * project key, spec §6.4) is drawn right-aligned in an accent box. Without a tag the text stays white
 * (QA LAB / ARCHIVED / RECEPTION signs).
 */
export function paintSign(ctx: Ctx2D, text: string, accent: string, icon: RoomIcon | null, w = 256, h = 32, tag: string | null = null): void {
  ctx.clearRect(0, 0, w, h);
  rect(ctx, '#111827', 0, 0, w, h);
  rect(ctx, accent, 0, 0, w, 2);
  rect(ctx, accent, 0, h - 2, w, 2);
  let tx = 4;
  if (icon !== null) {
    const iy = Math.floor((h - 8) / 2);
    ROOM_ICON_GRIDS[icon].forEach((row, y) => {
      for (let x = 0; x < 8; x++) if (row[x] === '#') rect(ctx, accent, 4 + x, iy + y, 1, 1);
    });
    tx = 16;
  }
  const scale = 2;
  let right = w - 4;
  if (tag) {
    const tw = measurePixelText(tag, scale) + 8;
    const bx = w - 4 - tw;
    rect(ctx, accent, bx, 4, tw, h - 8);
    paintPixelText(ctx, tag, bx + 4, Math.floor((h - GLYPH_H * scale) / 2), scale, '#111827');
    right = bx - 6;
  }
  const maxChars = Math.max(1, Math.floor((right - tx) / (6 * scale)));
  paintPixelText(ctx, fit(text, maxChars), tx, Math.floor((h - GLYPH_H * scale) / 2), scale, tag ? accent : '#f8fafc');
}

/** Small "+N" overflow badge (spec §6.4): white pixel text on a red pill with a dark outline. */
export function paintBadge(ctx: Ctx2D, text: string, w = 32, h = 16): void {
  ctx.clearRect(0, 0, w, h);
  rect(ctx, '#111827', 0, 0, w, h);
  rect(ctx, '#dc2626', 1, 1, w - 2, h - 2);
  const tw = measurePixelText(text, 1);
  paintPixelText(ctx, text, Math.max(1, Math.floor((w - tw) / 2)), Math.floor((h - GLYPH_H) / 2), 1, '#f8fafc');
}

/** Speech bubble in the top-left of the canvas; returns its pixel size so the sprite can be scaled to fit. */
export function paintBubble(ctx: Ctx2D, text: string): { w: number; h: number } {
  const pad = 3;
  const tw = measurePixelText(text, 1);
  const w = tw + pad * 2;
  const h = GLYPH_H + pad * 2 + 3;
  rect(ctx, '#0f172a', 0, 0, w, h - 3);
  rect(ctx, '#f8fafc', 1, 1, w - 2, h - 5);
  rect(ctx, '#f8fafc', 3, h - 4, 3, 2);
  rect(ctx, '#f8fafc', 4, h - 2, 1, 1);
  paintPixelText(ctx, text, pad, pad, 1, '#0f172a');
  return { w, h };
}
