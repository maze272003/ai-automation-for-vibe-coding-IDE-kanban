import { slotAt, slotKey, type RoomSlot } from '@aik/contracts';
import { projects } from '@aik/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../src/events/bus.ts';
import { normalizeRepoPath } from '../src/office/normalize-path.ts';
import { OfficeRoomService } from '../src/office/room-service.ts';
import { purgeProjectData } from '../src/projects/purge-repo.ts';
import { createTestDb, seedProject } from './helpers/db.ts';
import { readOutbox } from './helpers/outbox.ts';

const mk = (n: number) => ({ id: n, key: `K${n}A`, name: `Proj ${n}`, repoPath: `C:/repos/room${n}` });
const sk = (s: RoomSlot | null) => (s ? slotKey(s) : null);

describe('normalizeRepoPath', () => {
  it('folds Windows casing and separators', () => {
    expect(normalizeRepoPath('C:\\Repos\\Alpha\\', 'win32')).toBe(normalizeRepoPath('c:/repos/alpha', 'win32'));
    expect(normalizeRepoPath('/home/x/Alpha', 'linux')).toBe('/home/x/Alpha');
  });
});

describe('OfficeRoomService', () => {
  let t: ReturnType<typeof createTestDb>;
  let svc: OfficeRoomService;
  beforeEach(() => {
    t = createTestDb();
    svc = new OfficeRoomService({ db: t.db, bus: new EventBus() });
  });

  it('first projects fill slots N0L, E0L, S0L', () => {
    const slots = [1, 2, 3].map((n) => sk(svc.onProjectCreated(mk(n)).slot));
    expect(slots).toEqual(['N:0:L', 'E:0:L', 'S:0:L']);
  });

  it('delete archives the room and keeps customization and slot', () => {
    const r = svc.onProjectCreated(mk(1));
    svc.patch(r.id, { customization: { ...r.customization, signName: 'Alpha HQ' } });
    svc.onProjectDeleted(1);
    const [a] = svc.list({ includeArchived: true });
    expect(a).toMatchObject({ state: 'archived', projectId: null, slot: r.slot, customization: { signName: 'Alpha HQ' } });
    expect(a!.archivedAt).not.toBeNull();
    expect(svc.list({ includeArchived: false })).toEqual([]);
  });

  it('re-import of the same repo restores the same room', () => {
    const r = svc.onProjectCreated({ ...mk(1), repoPath: 'C:\\Repos\\Alpha' });
    svc.onProjectDeleted(1);
    const again = process.platform === 'win32' ? 'c:/repos/alpha/' : 'C:\\Repos\\Alpha';
    const back = svc.onProjectCreated({ ...mk(1), id: 99, repoPath: again });
    expect(back.id).toBe(r.id);
    expect(back.state).toBe('active');
    expect(back.projectId).toBe(99);
    expect(back.archivedAt).toBeNull();
  });

  it('restored room takes next free slot when its old slot was taken', () => {
    const a = svc.onProjectCreated(mk(1));
    svc.onProjectDeleted(1);
    svc.compact();
    const b = svc.onProjectCreated(mk(2));
    expect(sk(b.slot)).toBe('N:0:L');
    const back = svc.onProjectCreated({ ...mk(1), id: 50 });
    expect(back.id).toBe(a.id);
    expect(sk(back.slot)).toBe('E:0:L');
  });

  it('new project never moves existing rooms', () => {
    for (let n = 1; n <= 5; n++) svc.onProjectCreated(mk(n));
    const before = svc.list({ includeArchived: true }).map((r) => [r.id, sk(r.slot)]);
    svc.onProjectCreated(mk(6));
    const after = svc.list({ includeArchived: true }).map((r) => [r.id, sk(r.slot)]);
    expect(after.slice(0, 5)).toEqual(before);
    expect(after).toHaveLength(6);
  });

  it('compact closes gaps and frees archived slots', () => {
    for (let n = 1; n <= 4; n++) svc.onProjectCreated(mk(n));
    svc.onProjectDeleted(2);
    const res = svc.compact();
    expect(res.filter((r) => r.state === 'active').map((r) => sk(r.slot))).toEqual([0, 1, 2].map((n) => slotKey(slotAt(n))));
    expect(svc.list({ includeArchived: true }).find((r) => r.state === 'archived')!.slot).toBeNull();
  });

  it('reconcile creates rooms for pre-existing projects and archives orphans', () => {
    const p1 = seedProject(t.db, { repoPath: 'C:/repos/rc1' });
    const p2 = seedProject(t.db, { repoPath: 'C:/repos/rc2' });
    svc.reconcile();
    const rooms = svc.list({ includeArchived: false });
    expect(rooms.map((r) => r.projectId)).toEqual([p1.id, p2.id]);
    purgeProjectData(t.db, p2.id);
    svc.reconcile();
    const all = svc.list({ includeArchived: true });
    expect(all.find((r) => r.id === rooms[1]!.id)).toMatchObject({ state: 'archived', projectId: null });
    expect(all.find((r) => r.id === rooms[0]!.id)!.state).toBe('active');
  });

  it('reconcile emits nothing when nothing changed', () => {
    seedProject(t.db);
    svc.reconcile();
    const n = readOutbox(t.db).length;
    svc.reconcile();
    expect(readOutbox(t.db)).toHaveLength(n);
  });

  it('list joins current project name, key and status', () => {
    const p = seedProject(t.db);
    svc.onProjectCreated({ id: p.id, key: p.key, name: p.name, repoPath: p.repoPath });
    t.db.update(projects).set({ name: 'Renamed', status: 'unavailable' }).where(eq(projects.id, p.id)).run();
    expect(svc.list({ includeArchived: false })[0]).toMatchObject({ projectName: 'Renamed', projectStatus: 'unavailable' });
  });

  it('patch 404s on a missing room', () => {
    const r = svc.onProjectCreated(mk(1));
    expect(() => svc.patch(9999, { customization: r.customization })).toThrow(/not found/i);
  });

  it('deleteArchived refuses active rooms and deletes archived ones', () => {
    const active = svc.onProjectCreated(mk(1));
    expect(() => svc.deleteArchived(active.id)).toThrow(/Only archived rooms/);
    svc.onProjectDeleted(1);
    expect(svc.deleteArchived(active.id)).toEqual({ ok: true });
    expect(svc.list({ includeArchived: true })).toEqual([]);
  });

  it('every mutation emits office.rooms_changed', () => {
    svc.onProjectCreated(mk(1));
    expect(readOutbox(t.db).filter((e) => e.topic === 'office.rooms_changed').at(-1)?.data).toEqual({ roomIds: [expect.any(Number)] });
    const before = readOutbox(t.db).length;
    svc.onProjectDeleted(1);
    svc.compact();
    expect(readOutbox(t.db).length).toBe(before + 2);
  });
});
