import { describe, expect, test } from 'vitest';
import { STORY_STATUS, type RoomCustomization, type StoryStatus } from '@aik/contracts';
import { PIXEL_FONT, measurePixelText, paintPixelText, type Ctx2D } from '../../src/office3d/screens/pixel-font.ts';
import {
  activityScreen, dataSignature, formatCheckDuration, kanbanScreen, pmScreen, runsScreen, signText, testBoardScreen,
} from '../../src/office3d/screens/data.ts';
import { paintActivity, paintBubble, paintKanban, paintPm, paintRuns, paintSign, paintTestBoard, paintWhiteboard } from '../../src/office3d/screens/paint.ts';
import type { StationView } from '../../src/office3d/state/selectors.ts';
import type { ActivityView, QaRunView } from '../../src/office3d/state/model.ts';

type Rec = Ctx2D & { ops: string[] };
function fakeCtx(): Rec {
  const ops: string[] = [];
  const c: Rec = {
    fillStyle: '#000000',
    ops,
    fillRect(x: number, y: number, w: number, h: number) { ops.push(`F ${c.fillStyle} ${x},${y},${w},${h}`); },
    clearRect(x: number, y: number, w: number, h: number) { ops.push(`C ${x},${y},${w},${h}`); },
  };
  return c;
}

const board = Object.fromEntries(STORY_STATUS.map((k) => [k, 0])) as Record<StoryStatus, number>;
const cust = { signName: null, accentColor: '#22d3ee', icon: null } as unknown as RoomCustomization;
const emptyView = (): StationView => ({ state: 'idle', seats: [], overflow: 0, stories: [] });
const noViews = () => ({ pm: emptyView(), planner: emptyView(), implementer: emptyView(), reviewer: emptyView(), qa: emptyView() });

describe('pixel font', () => {
  test('measure and unknown glyphs', () => {
    expect(measurePixelText('AB', 1)).toBe(11);
    expect(measurePixelText('AB', 2)).toBe(22);
    expect(measurePixelText('', 1)).toBe(0);
  });
  test('every glyph is 7 rows of 5 columns', () => {
    for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.:-_/✓✗…()#%+ ?') {
      const g = PIXEL_FONT[ch];
      expect(g, ch).toBeDefined();
      expect(g!.length, ch).toBe(7);
      for (const r of g!) expect(r.length, ch).toBe(5);
    }
  });
  test('unknown glyph renders as ?', () => {
    const a = fakeCtx(); const b = fakeCtx();
    paintPixelText(a, '☃', 0, 0, 1, '#fff');
    paintPixelText(b, '?', 0, 0, 1, '#fff');
    expect(a.ops).toEqual(b.ops);
    expect(a.ops.length).toBeGreaterThan(0);
  });
  test('paints deterministically with scale', () => {
    const a = fakeCtx(); const b = fakeCtx();
    paintPixelText(a, 'Hi', 3, 4, 2, '#abcdef');
    paintPixelText(b, 'Hi', 3, 4, 2, '#abcdef');
    expect(a.ops).toEqual(b.ops);
    expect(a.ops.every((o) => o.startsWith('F #abcdef'))).toBe(true);
  });
});

describe('screen data', () => {
  test('kanban folds statuses into 6 columns and counts blocked', () => {
    expect(kanbanScreen(board, []).columns.map((c) => c.id)).toEqual(['NEW', 'READY', 'IN_PROGRESS', 'TESTING', 'READY_FOR_REVIEW', 'DONE']);
    expect(kanbanScreen({ ...board, BLOCKED: 2 }, []).blocked).toBe(2);
    const k = kanbanScreen({ ...board, IN_PROGRESS: 1, REWORK: 2, READY_FOR_REVIEW: 1, AWAITING_MERGE: 3, CANCELLED: 9 }, [
      { storyKey: 'S-1', status: 'REWORK' }, { storyKey: 'S-2', status: 'BLOCKED' },
    ]);
    const by = Object.fromEntries(k.columns.map((c) => [c.id, c]));
    expect(by.IN_PROGRESS!.count).toBe(3);
    expect(by.READY_FOR_REVIEW!.count).toBe(4);
    expect(by.IN_PROGRESS!.cards).toEqual(['S-1']);
  });
  test('signText default and override', () => {
    expect(signText({ ...cust, signName: null }, 'Alpha')).toBe('ALPHA DEVELOPMENT OFFICE');
    expect(signText({ ...cust, signName: 'Alpha HQ' }, 'Alpha')).toBe('ALPHA HQ');
    expect(signText({ ...cust, signName: 'x'.repeat(60) }, 'A').length).toBe(40);
  });
  test('runsScreen caps at 6 rows, active first', () => {
    const v = { ...noViews(), implementer: { ...emptyView(), stories: [1, 2, 3, 4].map((i) => ({ storyId: i, storyKey: `S-${i}`, title: null, state: 'working' as const })) } };
    const fin = [1, 2, 3, 4].map((i) => ({ runId: i, storyId: i, storyKey: `F-${i}`, role: 'qa' as const, status: 'failed' as const, endedAt: i }));
    const r = runsScreen(v, fin);
    expect(r.rows.length).toBe(6);
    expect(r.rows[0]!.storyKey).toBe('S-1');
    expect(r.rows[4]!.state).toBe('error');
  });
  test('activityScreen keeps last 9 buckets in time order', () => {
    const m = new Map<number, ActivityView>();
    for (let i = 0; i < 12; i++) m.set(i, { runId: i, kind: 'tool-start', at: i });
    const a = activityScreen(m);
    expect(a.bars.length).toBe(9);
    expect(a.bars[0]!.at).toBe(3);
  });
  test('testBoardScreen max 8 checks', () => {
    const checks: QaRunView['checks'] = {};
    for (let i = 0; i < 10; i++) checks[`c${i}`] = i % 2 ? 'failed' : 'running';
    const t = testBoardScreen({ storyId: 1, storyKey: 'S-1', roomId: 1, verificationRunId: 1, checks, startedAt: 0, finishedAt: null, passed: null });
    expect(t.rows.length).toBe(8);
    expect(testBoardScreen(null).rows).toEqual([]);
  });
  test('testBoardScreen shows each check duration ("12s"), blank while unknown', () => {
    const t = testBoardScreen({
      storyId: 1, storyKey: 'S-1', roomId: 1, verificationRunId: 1, startedAt: 0, finishedAt: null, passed: null,
      checks: { lint: 'passed', unit: 'running', e2e: 'failed', slow: 'passed' },
      details: { lint: { durationMs: 12_400 }, e2e: { durationMs: 300 }, slow: { durationMs: 125_000 } },
    });
    expect(t.rows.map((r) => [r.checkKey, r.duration])).toEqual([['e2e', '<1s'], ['lint', '12s'], ['slow', '2m5s'], ['unit', null]]);
  });
  test('formatCheckDuration', () => {
    expect(formatCheckDuration(null)).toBeNull();
    expect(formatCheckDuration(undefined)).toBeNull();
    expect(formatCheckDuration(999)).toBe('<1s');
    expect(formatCheckDuration(59_900)).toBe('59s');
    expect(formatCheckDuration(60_000)).toBe('1m');
    expect(formatCheckDuration(3_725_000)).toBe('62m5s');
  });
  test('pmScreen text', () => {
    const p = pmScreen({ board: { ...board, DONE: 12, NEW: 8 }, blocked: [], doneToday: 3, state: 'working' });
    expect(p.progressText).toBe('12/20 ✓');
    expect(p.total).toBe(20);
  });
  test('dataSignature is stable across key order', () => {
    expect(dataSignature({ a: 1, b: 2 })).toBe(dataSignature({ b: 2, a: 1 }));
    expect(dataSignature({ a: { x: 1, y: 2 } })).toBe(dataSignature({ a: { y: 2, x: 1 } }));
    expect(dataSignature({ a: 1 })).not.toBe(dataSignature({ a: 2 }));
  });
});

describe('painters', () => {
  test('paintBubble returns size proportional to text', () => {
    expect(paintBubble(fakeCtx(), 'Thinking…').w).toBeGreaterThan(paintBubble(fakeCtx(), 'Hi').w);
  });
  test('painters are deterministic and draw', () => {
    const k = kanbanScreen({ ...board, NEW: 2, BLOCKED: 1 }, [{ storyKey: 'S-1', status: 'NEW' }]);
    const cases: Array<(c: Ctx2D) => void> = [
      (c) => paintKanban(c, k, 128, 64),
      (c) => paintRuns(c, runsScreen(noViews(), []), 128, 64),
      (c) => paintActivity(c, activityScreen(new Map([[1, { runId: 1, kind: 'message', at: 1 }]])), 128, 64),
      (c) => paintTestBoard(c, testBoardScreen(null), 128, 64),
      (c) => paintPm(c, pmScreen({ board, blocked: [], doneToday: 0, state: 'idle' }), 128, 64),
      (c) => paintWhiteboard(c, [{ storyKey: 'S-1', checkKey: 'lint', summary: 'lint failed' }]),
      (c) => paintSign(c, 'ALPHA', '#22d3ee', 'rocket'),
    ];
    for (const f of cases) {
      const a = fakeCtx(); const b = fakeCtx();
      f(a); f(b);
      expect(a.ops.length).toBeGreaterThan(0);
      expect(a.ops).toEqual(b.ops);
    }
  });
  test('sign icon placeholder only when icon set', () => {
    const a = fakeCtx(); const b = fakeCtx();
    paintSign(a, 'X', '#22d3ee', null); paintSign(b, 'X', '#22d3ee', 'star');
    expect(b.ops.length).toBeGreaterThan(a.ops.length);
  });
});
