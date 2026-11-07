import { STATION_ROLES, type FurnitureItem, type OfficePreferences, type OfficeRoomDTO, type ROOM_ICONS, type ScreenToggles, type StationRole, type StoryStatus } from '@aik/contracts';
import { buildingLayout, type BuildingLayout, type SuiteLayout } from '../layout/building.ts';
import { defaultRoomLayout } from '../layout/room.ts';
import {
  activityScreen, kanbanScreen, pmScreen, runsScreen, signText, testBoardScreen,
  type ActivityScreenData, type KanbanScreenData, type PmScreenData, type RunsScreenData, type TestBoardData,
} from '../screens/data.ts';
import { STATE_COLOR } from '../screens/paint.ts';
import type { ActivityView, OfficeState, QaRunView } from '../state/model.ts';
import { pmView, roomAggregate, stationViews, type StationState } from '../state/selectors.ts';

/** Everything the scene draws for one suite; rebuilt from the view-model, compared by `dataSignature`. */
export type SuiteModel = {
  roomId: number;
  projectKey: string;
  suite: SuiteLayout;
  layout: FurnitureItem[];
  accent: string;
  icon: (typeof ROOM_ICONS)[number] | null;
  sign: string;
  /** Archived (shown only with prefs.showArchived) or project unavailable: drawn dimmed with a status sign. */
  dim: 'archived' | 'unavailable' | null;
  screens: ScreenToggles;
  /** Seat states per station, in seat order (ring colours; seat counts drive desks shown). */
  seats: Record<StationRole, StationState[]>;
  stationState: Record<StationRole, StationState>;
  aggregate: StationState;
  kanban: KanbanScreenData;
  activity: ActivityScreenData;
  runs: RunsScreenData;
  pm: PmScreenData;
  testBoard: TestBoardData;
};

export type SceneModel = { building: BuildingLayout; suites: SuiteModel[]; visibleSlots: Set<string> };

/** Station a story sits at -> the Kanban column its card belongs in. */
const ROLE_STATUS: Record<StationRole, StoryStatus | null> = {
  planner: 'READY', implementer: 'IN_PROGRESS', reviewer: 'READY_FOR_REVIEW', qa: 'TESTING', pm: null,
};

export function stateColor(state: StationState, overrides: OfficePreferences['statusColors']): string {
  return overrides[state] ?? STATE_COLOR[state];
}

function latestQa(s: OfficeState, roomId: number): QaRunView | null {
  let best: QaRunView | null = null;
  for (const q of s.qa.values()) if (q.roomId === roomId && (!best || q.startedAt > best.startedAt)) best = q;
  return best;
}

function roomActivity(s: OfficeState, roomId: number): Map<number, ActivityView> {
  const out = new Map<number, ActivityView>();
  for (const [runId, a] of s.lastActivity) if (s.runs.get(runId)?.roomId === roomId) out.set(runId, a);
  return out;
}

export function isRoomVisible(r: OfficeRoomDTO, prefs: Pick<OfficePreferences, 'showArchived'>): boolean {
  return r.slot !== null && (r.state === 'active' || prefs.showArchived);
}

function suiteModel(s: OfficeState, room: OfficeRoomDTO, suite: SuiteLayout, now: number, prefs: OfficePreferences): SuiteModel {
  const views = stationViews(s, room.id, now);
  const pm = pmView(s, room.id);
  const topCards = [
    ...pm.blocked.map((b) => ({ storyKey: b.storyKey, status: 'BLOCKED' as StoryStatus })),
    ...STATION_ROLES.flatMap((role) => {
      const status = ROLE_STATUS[role];
      return status ? views[role].stories.map((st) => ({ storyKey: st.storyKey, status })) : [];
    }),
  ];
  const seats = {} as Record<StationRole, StationState[]>;
  const stationState = {} as Record<StationRole, StationState>;
  for (const role of STATION_ROLES) {
    seats[role] = views[role].seats.map((x) => x.state);
    stationState[role] = views[role].state;
  }
  const c = room.customization;
  return {
    roomId: room.id,
    projectKey: room.projectKey,
    suite,
    layout: c.layout ?? defaultRoomLayout(),
    accent: c.accentColor,
    icon: c.icon,
    sign: signText(c, room.projectName),
    dim: room.state === 'archived' ? 'archived' : room.projectStatus === 'unavailable' ? 'unavailable' : null,
    screens: c.screens ?? prefs.screens,
    seats,
    stationState,
    aggregate: roomAggregate(s, room.id, now),
    kanban: kanbanScreen(pm.board, topCards),
    activity: activityScreen(roomActivity(s, room.id)),
    runs: runsScreen(views, s.snapshot.get(room.id)?.lastFinished ?? []),
    pm: pmScreen(pm),
    testBoard: testBoardScreen(latestQa(s, room.id)),
  };
}

/**
 * Scene model. The building layout includes every room that holds a slot (archived ones too) so hidden
 * rooms never shift hallway lengths; only visible rooms get a suite drawn.
 */
export function sceneModel(s: OfficeState, now: number, prefs: OfficePreferences): SceneModel {
  // One room per slot: if an archived room still names a slot an active room now holds, the active one wins.
  const bySlot = new Map<string, OfficeRoomDTO>();
  for (const r of [...s.rooms.values()].sort((a, b) => a.id - b.id)) {
    if (!r.slot) continue;
    const k = `${r.slot.wing}:${r.slot.index}:${r.slot.side}`;
    const prev = bySlot.get(k);
    if (!prev || (prev.state !== 'active' && r.state === 'active')) bySlot.set(k, r);
  }
  const rooms = [...bySlot.values()].sort((a, b) => a.id - b.id);
  const building = buildingLayout(rooms.map((r) => ({ roomId: r.id, slot: r.slot! })));
  const bySuite = new Map(building.suites.map((x) => [x.roomId, x]));
  const suites: SuiteModel[] = [];
  const visibleSlots = new Set<string>();
  for (const r of rooms) {
    if (!isRoomVisible(r, prefs)) continue;
    suites.push(suiteModel(s, r, bySuite.get(r.id)!, now, prefs));
    visibleSlots.add(`${r.slot!.wing}:${r.slot!.index}:${r.slot!.side}`);
  }
  return { building, suites, visibleSlots };
}
