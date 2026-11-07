import { z } from 'zod';
import { BLOCKED_REASON, ROLE, STORY_STATUS } from './enums.ts';

export const OFFICE_WINGS = ['N', 'E', 'S', 'W'] as const;
export type Wing = (typeof OFFICE_WINGS)[number];
export const OFFICE_SIDES = ['L', 'R'] as const;
export type Side = (typeof OFFICE_SIDES)[number];

export const RoomSlot = z.object({
  wing: z.enum(OFFICE_WINGS),
  index: z.number().int().min(0),
  side: z.enum(OFFICE_SIDES),
});
export type RoomSlot = z.infer<typeof RoomSlot>;

/** The n-th slot (0-based) in fill order: wings round-robin, left side before right, nearest first. */
export function slotAt(n: number): RoomSlot {
  return {
    wing: OFFICE_WINGS[n % 4]!,
    index: Math.floor(n / 8),
    side: n % 8 < 4 ? 'L' : 'R',
  };
}
export const slotKey = (s: RoomSlot): string => `${s.wing}:${s.index}:${s.side}`;

export const STATION_ROLES = ['planner', 'implementer', 'reviewer', 'pm', 'qa'] as const;
export type StationRole = (typeof STATION_ROLES)[number];

export const FURNITURE_KINDS = ['desk', 'chair', 'sofa', 'plant', 'huddle-table', 'whiteboard', 'bookshelf', 'lamp', 'rug'] as const;
export const SPECIAL_KINDS = ['station', 'reading-lounge', 'coffee-bar', 'huddle', 'test-board', 'audit-whiteboard', 'lab-couch'] as const;

export const FurnitureItem = z
  .object({
    id: z.string().min(1).max(40),
    kind: z.enum([...FURNITURE_KINDS, ...SPECIAL_KINDS]),
    area: z.enum(['dev', 'lab']),
    x: z.number(),
    z: z.number(),
    rotationY: z.number().int().multipleOf(15).min(0).max(345),
    role: z.enum(STATION_ROLES).optional(),
  })
  .strict();
export type FurnitureItem = z.infer<typeof FurnitureItem>;

export const ROOM_ICONS = ['rocket', 'code', 'database', 'globe', 'shield', 'chart', 'cube', 'bolt', 'leaf', 'star'] as const;
export const ACCENT_PALETTE = [
  '#f59e0b', '#60a5fa', '#a78bfa', '#22d3ee', '#4ade80', '#f472b6', '#fb923c', '#2dd4bf', '#facc15', '#c084fc',
] as const;
export function defaultAccent(projectKey: string): string {
  let sum = 0;
  for (let i = 0; i < projectKey.length; i++) sum += projectKey.charCodeAt(i);
  return ACCENT_PALETTE[sum % ACCENT_PALETTE.length]!;
}

const Hex = z.string().regex(/^#[0-9a-f]{6}$/i);

export const ScreenToggles = z.object({ kanban: z.boolean(), activity: z.boolean(), runs: z.boolean() }).strict();
export type ScreenToggles = z.infer<typeof ScreenToggles>;

export const RoomCustomization = z
  .object({
    signName: z.string().trim().min(1).max(60).nullable(),
    accentColor: Hex,
    icon: z.enum(ROOM_ICONS).nullable(),
    screens: ScreenToggles.nullable(),
    layout: z.array(FurnitureItem).max(200).nullable(),
  })
  .strict();
export type RoomCustomization = z.infer<typeof RoomCustomization>;

export const OfficeRoomDTO = z.object({
  id: z.number().int(),
  state: z.enum(['active', 'archived']),
  projectId: z.number().int().nullable(),
  projectKey: z.string(),
  projectName: z.string(),
  projectStatus: z.enum(['active', 'unavailable', 'archived']).nullable(),
  slot: RoomSlot.nullable(),
  customization: RoomCustomization,
  createdAt: z.number(),
  updatedAt: z.number(),
  archivedAt: z.number().nullable(),
});
export type OfficeRoomDTO = z.infer<typeof OfficeRoomDTO>;

export const PatchOfficeRoomRequest = z.object({ customization: RoomCustomization }).strict();
export type PatchOfficeRoomRequest = z.infer<typeof PatchOfficeRoomRequest>;

export const OfficeRoomSnapshot = z.object({
  roomId: z.number().int(),
  projectId: z.number().int().nullable(),
  board: z.record(z.enum(STORY_STATUS), z.number().int()),
  blocked: z.array(z.object({
    storyId: z.number().int(),
    storyKey: z.string(),
    title: z.string(),
    reason: z.enum(BLOCKED_REASON).nullable(),
  })),
  doneToday: z.number().int(),
  activeRuns: z.array(z.object({
    runId: z.number().int(),
    storyId: z.number().int(),
    storyKey: z.string(),
    storyTitle: z.string(),
    role: z.enum(ROLE),
    startedAt: z.number(),
  })),
  lastFinished: z.array(z.object({
    runId: z.number().int(),
    storyId: z.number().int(),
    storyKey: z.string(),
    role: z.enum(ROLE),
    status: z.enum(['succeeded', 'failed', 'interrupted']),
    endedAt: z.number(),
  })),
  verification: z.array(z.object({
    storyId: z.number().int(),
    storyKey: z.string(),
    verificationRunId: z.number().int(),
    status: z.enum(['running', 'passed', 'failed', 'error']),
    checks: z.array(z.object({
      checkKey: z.string(),
      status: z.string(),
      summary: z.string().max(200),
    })),
  })),
});
export type OfficeRoomSnapshot = z.infer<typeof OfficeRoomSnapshot>;

export const OfficeSnapshot = z.object({ generatedAt: z.number(), rooms: z.array(OfficeRoomSnapshot) });
export type OfficeSnapshot = z.infer<typeof OfficeSnapshot>;

export const OFFICE_QUALITY = ['low', 'medium', 'high'] as const;
export const AGENT_MOVEMENT = ['full', 'desk', 'off'] as const;
export const STATION_STATES = ['idle', 'planning', 'working', 'reviewing', 'testing', 'completed', 'error'] as const;

export const OfficePreferences = z
  .object({
    defaultView: z.enum(['overview', 'last-room', 'walk']),
    walkEnabled: z.boolean(),
    mouseSensitivity: z.number().min(0.2).max(3),
    walkSpeed: z.number().min(0.5).max(4),
    flySpeed: z.number().min(0.25).max(3),
    quality: z.enum(OFFICE_QUALITY),
    showArchived: z.boolean(),
    agentMovement: z.enum(AGENT_MOVEMENT),
    // Zod 4: z.record over an enum is exhaustive; partialRecord is the optional-keys form.
    statusColors: z.partialRecord(z.enum(STATION_STATES), Hex),
    screens: ScreenToggles,
    lastRoomId: z.number().int().nullable(),
  })
  .strict();
export type OfficePreferences = z.infer<typeof OfficePreferences>;

export const DEFAULT_OFFICE_PREFERENCES: OfficePreferences = {
  defaultView: 'overview',
  walkEnabled: true,
  mouseSensitivity: 1,
  walkSpeed: 1.4,
  flySpeed: 1,
  quality: 'medium',
  showArchived: false,
  agentMovement: 'full',
  statusColors: {},
  screens: { kanban: true, activity: true, runs: true },
  lastRoomId: null,
};

/** Tolerant parse: each field that fails validation falls back to its default; never throws. */
export function parseOfficePreferences(raw: unknown): OfficePreferences {
  const out: Record<string, unknown> = { ...DEFAULT_OFFICE_PREFERENCES };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ...DEFAULT_OFFICE_PREFERENCES };
  const input = raw as Record<string, unknown>;
  for (const [key, schema] of Object.entries(OfficePreferences.shape)) {
    if (!(key in input)) continue;
    const parsed = schema.safeParse(input[key]);
    if (parsed.success) out[key] = parsed.data;
  }
  return out as OfficePreferences;
}
