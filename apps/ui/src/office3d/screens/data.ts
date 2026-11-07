import { STATION_ROLES, type OfficeSnapshot, type RoomCustomization, type StationRole, type StoryStatus } from '@aik/contracts';
import type { ActivityView, QaRunView } from '../state/model.ts';
import type { StationState, StationView } from '../state/selectors.ts';

export const KANBAN_COLUMNS = ['NEW', 'READY', 'IN_PROGRESS', 'TESTING', 'READY_FOR_REVIEW', 'DONE'] as const;
export type KanbanColumnId = (typeof KANBAN_COLUMNS)[number];
const FOLD: Partial<Record<StoryStatus, KanbanColumnId>> = { REWORK: 'IN_PROGRESS', AWAITING_MERGE: 'READY_FOR_REVIEW' };
export const COLUMN_LABEL: Record<KanbanColumnId, string> = {
  NEW: 'NEW', READY: 'READY', IN_PROGRESS: 'DOING', TESTING: 'TEST', READY_FOR_REVIEW: 'REVIEW', DONE: 'DONE',
};

export type KanbanScreenData = {
  columns: Array<{ id: KanbanColumnId; count: number; cards: string[] }>;
  blocked: number;
};
export const MAX_CARDS_PER_COLUMN = 3;

/** `topCards`: a few story keys with their status, already ordered by importance. */
export function kanbanScreen(
  board: Record<StoryStatus, number>,
  topCards: Array<{ storyKey: string; status: StoryStatus }>,
): KanbanScreenData {
  const columns = KANBAN_COLUMNS.map((id) => ({ id, count: 0, cards: [] as string[] }));
  const byId = new Map(columns.map((c) => [c.id, c]));
  for (const [status, n] of Object.entries(board) as Array<[StoryStatus, number]>) {
    const col = byId.get((FOLD[status] ?? status) as KanbanColumnId);
    if (col) col.count += n;
  }
  for (const c of topCards) {
    const col = byId.get((FOLD[c.status] ?? c.status) as KanbanColumnId);
    if (col && col.cards.length < MAX_CARDS_PER_COLUMN) col.cards.push(c.storyKey);
  }
  return { columns, blocked: board.BLOCKED ?? 0 };
}

export type RunsRow = { storyKey: string; role: StationRole; state: StationState };
export type RunsScreenData = { rows: RunsRow[] };
export const MAX_RUN_ROWS = 6;

/** Active/colored station stories first (station order), then recently finished runs (newest first). */
export function runsScreen(
  views: Record<StationRole, StationView>,
  lastFinished: OfficeSnapshot['rooms'][number]['lastFinished'],
): RunsScreenData {
  const rows: RunsRow[] = [];
  for (const role of STATION_ROLES) {
    for (const s of views[role]?.stories ?? []) rows.push({ storyKey: s.storyKey, role, state: s.state });
  }
  const finished = [...lastFinished].sort((a, b) => b.endedAt - a.endedAt || b.runId - a.runId);
  for (const f of finished) {
    const role: StationRole = f.role === 'security' ? 'reviewer' : f.role;
    rows.push({ storyKey: f.storyKey, role, state: f.status === 'succeeded' ? 'completed' : 'error' });
  }
  return { rows: rows.slice(0, MAX_RUN_ROWS) };
}

export type ActivityScreenData = { bars: Array<{ kind: ActivityView['kind']; height: number; at: number }> };
export const ACTIVITY_BUCKETS = 9;
const KIND_HEIGHT: Record<ActivityView['kind'], number> = { 'tool-start': 5, 'tool-end': 3, message: 2, subagent: 7 };

/** Last 9 activity buckets in time order; bar height encodes the kind of activity. */
export function activityScreen(lastActivity: Map<number, ActivityView>): ActivityScreenData {
  const items = [...lastActivity.values()].sort((a, b) => a.at - b.at || a.runId - b.runId).slice(-ACTIVITY_BUCKETS);
  return { bars: items.map((a) => ({ kind: a.kind, height: KIND_HEIGHT[a.kind], at: a.at })) };
}

export type TestRow = { checkKey: string; status: 'running' | 'failed' | 'passed' | 'other'; duration: string | null };
export type TestBoardData = { storyKey: string | null; rows: TestRow[]; passed: boolean | null };
export const MAX_TEST_ROWS = 8;

/** Compact check duration for the test board: "<1s", "12s", "2m5s", "1m"; null when unknown. */
export function formatCheckDuration(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return '<1s';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const r = sec % 60;
  return r === 0 ? `${m}m` : `${m}m${r}s`;
}

export function testBoardScreen(qa: QaRunView | null): TestBoardData {
  if (!qa) return { storyKey: null, rows: [], passed: null };
  const rows = Object.entries(qa.checks)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, MAX_TEST_ROWS)
    .map(([checkKey, v]): TestRow => ({
      checkKey,
      status: v === 'running' ? 'running' : v === 'failed' ? 'failed' : v === 'passed' ? 'passed' : 'other',
      duration: v === 'running' ? null : formatCheckDuration(qa.details?.[checkKey]?.durationMs),
    }));
  return { storyKey: qa.storyKey, rows, passed: qa.passed };
}

export type PmScreenData = { done: number; total: number; progressText: string; blocked: number; doneToday: number; state: StationState };

/** Total excludes CANCELLED stories. */
export function pmScreen(v: {
  board: Record<StoryStatus, number>;
  blocked: unknown[];
  doneToday: number;
  state: StationState;
}): PmScreenData {
  let total = 0;
  for (const [k, n] of Object.entries(v.board) as Array<[StoryStatus, number]>) if (k !== 'CANCELLED') total += n;
  const done = v.board.DONE ?? 0;
  return { done, total, progressText: `${done}/${total} ✓`, blocked: v.blocked.length, doneToday: v.doneToday, state: v.state };
}

export const SIGN_MAX = 40;

export function signText(c: Pick<RoomCustomization, 'signName'>, projectName: string): string {
  return (c.signName ?? `${projectName} Development Office`).toUpperCase().slice(0, SIGN_MAX);
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  }
  return v;
}

/** Stable JSON key (independent of object key order) so a texture is re-painted only when its data changed. */
export function dataSignature(data: unknown): string {
  return JSON.stringify(canonical(data)) ?? 'undefined';
}
