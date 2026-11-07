import type { OfficeRoomDTO, OfficeSnapshot, EventEnvelope, Role, StationRole } from '@aik/contracts';

export type RunView = {
  runId: number;
  storyId: number;
  storyKey: string;
  storyTitle: string | null;
  role: Role;
  roomId: number;
  startedAt: number;
};

export type StoryRoleOutcome = {
  storyId: number;
  role: StationRole;
  state: 'completed' | 'error';
  at: number;
  reason?: string;
};

/** Per-check extras: duration (test board), recorded result line (whiteboard), mandatory flag (QA pass/fail). */
export type CheckDetail = { durationMs?: number | null; summary?: string; mandatory?: boolean };

/**
 * Backend semantics (verify/runner.ts): verification passes only when every mandatory check passed, so a
 * finished check fails it when its status is anything but 'passed' (failed, error, timed_out, skipped,
 * unsupported). A check of unknown mandatoriness counts as mandatory (secrets/vulnerabilities always are).
 */
export function isFailingCheck(status: string, detail?: CheckDetail): boolean {
  return status !== 'running' && status !== 'passed' && detail?.mandatory !== false;
}

export type QaRunView = {
  storyId: number;
  storyKey: string;
  roomId: number;
  verificationRunId: number;
  checks: Record<string, 'running' | string>;
  details?: Record<string, CheckDetail>;
  startedAt: number;
  finishedAt: number | null;
  passed: boolean | null;
  /** The story's previous verification failed and no newer one has passed yet (error persists). */
  previousFailed?: boolean;
};

export type ActivityView = {
  runId: number;
  kind: 'tool-start' | 'tool-end' | 'message' | 'subagent';
  name?: string;
  summary?: string;
  at: number;
};

/** What the view-model knows about a story (learned from events and snapshots). */
export type StoryInfo = { roomId: number; key: string; title: string | null; lastRole: StationRole | null };

export type OfficeState = {
  rooms: Map<number, OfficeRoomDTO>;
  roomByProjectKey: Map<string, number>;
  snapshot: Map<number, OfficeSnapshot['rooms'][number]>;
  runs: Map<number, RunView>;
  outcomes: StoryRoleOutcome[];
  qa: Map<number /*storyId*/, QaRunView>;
  lastActivity: Map<number /*runId*/, ActivityView>;
  testingStories: Map<number /*storyId*/, number /*roomId*/>;
  stories: Map<number /*storyId*/, StoryInfo>;
};

export function emptyOfficeState(): OfficeState {
  return {
    rooms: new Map(),
    roomByProjectKey: new Map(),
    snapshot: new Map(),
    runs: new Map(),
    outcomes: [],
    qa: new Map(),
    lastActivity: new Map(),
    testingStories: new Map(),
    stories: new Map(),
  };
}

export type OfficeInput =
  | { type: 'rooms'; rooms: OfficeRoomDTO[] }
  | { type: 'snapshot'; snapshot: OfficeSnapshot }
  | { type: 'event'; event: EventEnvelope };

/** Completed (green) and QA-passed lights stay on this long. */
export const COMPLETED_WINDOW_MS = 60_000;

export function mapRole(role: Role): StationRole | 'security' {
  return role === 'security' ? 'security' : role;
}
