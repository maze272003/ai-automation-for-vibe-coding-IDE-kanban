import { defaultAccent, slotAt, slotKey, type OfficeRoomDTO, type PatchOfficeRoomRequest, type RoomCustomization, type RoomSlot } from '@aik/contracts';
import { officeRooms, projects, type AikDb, type AikDbOrTx } from '@aik/db';
import { and, asc, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import { ApiHttpError } from '../api/errors.ts';
import type { EventBus } from '../events/bus.ts';
import { appendOutbox } from '../events/outbox.ts';
import { systemClock, type Clock } from '../time.ts';
import { normalizeRepoPath } from './normalize-path.ts';

type RoomRow = typeof officeRooms.$inferSelect;
interface ProjectInfo { id: number; key: string; name: string; repoPath: string }

const SLOT_SCAN_LIMIT = 100_000;
const wingOrder = { N: 0, E: 1, S: 2, W: 3 } as const;

/** Position of a slot in fill order (the inverse of slotAt); no slot sorts last. */
function fillRank(s: RoomSlot | null): number {
  return s ? s.index * 8 + (s.side === 'L' ? 0 : 4) + wingOrder[s.wing] : Number.MAX_SAFE_INTEGER;
}

function rowSlot(r: RoomRow): RoomSlot | null {
  return r.wing !== null && r.slotIndex !== null && r.side !== null ? { wing: r.wing, index: r.slotIndex, side: r.side } : null;
}

function toDto(r: RoomRow, p: typeof projects.$inferSelect | null): OfficeRoomDTO {
  return {
    id: r.id,
    state: r.state,
    projectId: r.projectId,
    projectKey: p?.key ?? r.projectKeySnapshot,
    projectName: p?.name ?? r.projectNameSnapshot,
    projectStatus: p?.status ?? null,
    slot: rowSlot(r),
    customization: r.customization,
    createdAt: r.createdAt.getTime(),
    updatedAt: r.updatedAt.getTime(),
    archivedAt: r.archivedAt ? r.archivedAt.getTime() : null,
  };
}

export class OfficeRoomService {
  private readonly db: AikDb;
  private readonly bus: EventBus;
  private readonly clock: Clock;

  constructor(deps: { db: AikDb; bus: EventBus; now?: Clock }) {
    this.db = deps.db;
    this.bus = deps.bus;
    this.clock = deps.now ?? systemClock;
  }

  onProjectCreated(project: ProjectInfo): OfficeRoomDTO {
    const id = this.write((tx, now) => {
      const roomId = this.upsertForProject(tx, project, now);
      return { result: roomId, changed: [roomId] };
    });
    return this.get(id);
  }

  onProjectDeleted(projectId: number): void {
    this.write((tx, now) => {
      const rows = tx.select().from(officeRooms).where(and(eq(officeRooms.projectId, projectId), eq(officeRooms.state, 'active'))).all();
      for (const r of rows) this.archive(tx, r.id, now);
      return { result: undefined, changed: rows.map((r) => r.id) };
    });
  }

  reconcile(): void {
    this.write((tx, now) => {
      const changed: number[] = [];
      const live = new Set(tx.select({ id: projects.id }).from(projects).all().map((p) => p.id));
      for (const r of tx.select().from(officeRooms).where(eq(officeRooms.state, 'active')).all()) {
        if (r.projectId === null || !live.has(r.projectId)) {
          this.archive(tx, r.id, now);
          changed.push(r.id);
        }
      }
      const covered = new Set(
        tx.select({ projectId: officeRooms.projectId }).from(officeRooms).where(and(eq(officeRooms.state, 'active'), isNotNull(officeRooms.projectId))).all().map((r) => r.projectId),
      );
      const candidates = tx.select().from(projects).where(ne(projects.status, 'archived')).orderBy(asc(projects.createdAt), asc(projects.id)).all();
      for (const p of candidates) {
        if (covered.has(p.id)) continue;
        changed.push(this.upsertForProject(tx, p, now));
      }
      return { result: undefined, changed };
    });
  }

  list(opts: { includeArchived: boolean }): OfficeRoomDTO[] {
    const rows = this.db
      .select({ room: officeRooms, project: projects })
      .from(officeRooms)
      .leftJoin(projects, eq(officeRooms.projectId, projects.id))
      .where(opts.includeArchived ? undefined : eq(officeRooms.state, 'active'))
      .all();
    return rows
      .map((r) => toDto(r.room, r.project))
      .sort((a, b) => fillRank(a.slot) - fillRank(b.slot) || a.id - b.id);
  }

  patch(id: number, req: PatchOfficeRoomRequest): OfficeRoomDTO {
    this.write((tx, now) => {
      this.require(tx, id);
      tx.update(officeRooms).set({ customization: req.customization, updatedAt: now }).where(eq(officeRooms.id, id)).run();
      return { result: undefined, changed: [id] };
    });
    return this.get(id);
  }

  compact(): OfficeRoomDTO[] {
    this.write((tx, now) => {
      const all = tx.select().from(officeRooms).all();
      const active = all.filter((r) => r.state === 'active').sort((a, b) => fillRank(rowSlot(a)) - fillRank(rowSlot(b)) || a.id - b.id);
      const changed = new Set<number>();
      // Free every slot first so re-slotting never trips the unique index mid-way.
      const slotted = all.filter((r) => r.wing !== null);
      for (const r of slotted) tx.update(officeRooms).set({ wing: null, slotIndex: null, side: null }).where(eq(officeRooms.id, r.id)).run();
      active.forEach((r, n) => {
        const s = slotAt(n);
        tx.update(officeRooms).set({ wing: s.wing, slotIndex: s.index, side: s.side }).where(eq(officeRooms.id, r.id)).run();
        if (r.wing !== s.wing || r.slotIndex !== s.index || r.side !== s.side) changed.add(r.id);
      });
      for (const r of slotted) if (r.state === 'archived') changed.add(r.id);
      if (changed.size > 0) tx.update(officeRooms).set({ updatedAt: now }).where(inArray(officeRooms.id, [...changed])).run();
      return { result: undefined, changed: [...changed] };
    });
    return this.list({ includeArchived: false });
  }

  deleteArchived(id: number): { ok: true } {
    this.write((tx) => {
      const row = this.require(tx, id);
      if (row.state !== 'archived') throw new ApiHttpError(409, 'VALIDATION_FAILED', 'Only archived rooms can be deleted');
      tx.delete(officeRooms).where(eq(officeRooms.id, id)).run();
      return { result: undefined, changed: [id] };
    });
    return { ok: true };
  }

  // ───────────── internals ─────────────

  /** One immediate transaction; appends a single outbox event inside it when rooms changed, notifies after commit. */
  private write<T>(fn: (tx: AikDbOrTx, now: Date) => { result: T; changed: number[] }): T {
    const now = new Date(this.clock());
    let seq: number | null = null;
    const result = this.db.transaction(
      (tx) => {
        const out = fn(tx, now);
        const roomIds = [...new Set(out.changed)];
        if (roomIds.length > 0) {
          seq = appendOutbox(tx, { topic: 'office.rooms_changed', storyId: null, provenance: 'system', data: { roomIds } }, now);
        }
        return out.result;
      },
      { behavior: 'immediate' },
    );
    if (seq !== null) this.bus.notify(seq);
    return result;
  }

  private require(tx: AikDbOrTx, id: number): RoomRow {
    const row = tx.select().from(officeRooms).where(eq(officeRooms.id, id)).get();
    if (!row) throw new ApiHttpError(404, 'NOT_FOUND', `Office room ${id} not found`);
    return row;
  }

  private get(id: number): OfficeRoomDTO {
    const r = this.db.select({ room: officeRooms, project: projects }).from(officeRooms).leftJoin(projects, eq(officeRooms.projectId, projects.id)).where(eq(officeRooms.id, id)).get();
    if (!r) throw new ApiHttpError(404, 'NOT_FOUND', `Office room ${id} not found`);
    return toDto(r.room, r.project);
  }

  private archive(tx: AikDbOrTx, id: number, now: Date): void {
    tx.update(officeRooms).set({ state: 'archived', projectId: null, archivedAt: now, updatedAt: now }).where(eq(officeRooms.id, id)).run();
  }

  private freeSlot(tx: AikDbOrTx): RoomSlot {
    const taken = new Set(tx.select().from(officeRooms).where(isNotNull(officeRooms.wing)).all().map((r) => slotKey(rowSlot(r)!)));
    for (let n = 0; n < SLOT_SCAN_LIMIT; n++) {
      const s = slotAt(n);
      if (!taken.has(slotKey(s))) return s;
    }
    throw new Error('No free office slot');
  }

  /** Restore the room for this repo (or create one), bind it to the project, return the room id. */
  private upsertForProject(tx: AikDbOrTx, project: ProjectInfo, now: Date): number {
    const norm = normalizeRepoPath(project.repoPath);
    const existing = tx.select().from(officeRooms).where(eq(officeRooms.repoPathNorm, norm)).get();
    if (!existing) {
      const slot = this.freeSlot(tx);
      const customization: RoomCustomization = { signName: null, accentColor: defaultAccent(project.key), icon: null, screens: null, layout: null };
      return tx
        .insert(officeRooms)
        .values({
          repoPathNorm: norm, projectId: project.id, projectKeySnapshot: project.key, projectNameSnapshot: project.name, state: 'active',
          wing: slot.wing, slotIndex: slot.index, side: slot.side, customization, createdAt: now, updatedAt: now, archivedAt: null,
        })
        .returning({ id: officeRooms.id })
        .get().id;
    }
    // The room's own slot is always free from its own point of view (unique index guarantees no other holder),
    // so an existing slot is kept as-is; only a slotless (compacted-away) room needs a new one.
    const slot = rowSlot(existing) ?? this.freeSlot(tx);
    // Detach any other room still bound to this project id (unique project_id index).
    tx.update(officeRooms).set({ projectId: null }).where(and(eq(officeRooms.projectId, project.id), ne(officeRooms.id, existing.id))).run();
    tx.update(officeRooms).set({
      projectId: project.id, projectKeySnapshot: project.key, projectNameSnapshot: project.name, state: 'active',
      wing: slot.wing, slotIndex: slot.index, side: slot.side, archivedAt: null, updatedAt: now,
    }).where(eq(officeRooms.id, existing.id)).run();
    return existing.id;
  }
}
