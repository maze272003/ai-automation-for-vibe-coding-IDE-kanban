// apps/orchestrator/test/office-routes.test.ts
import { OfficeSnapshot } from '@aik/contracts';
import { agentRuns, projects } from '@aik/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { buildTestApp } from './helpers/app.ts';
import { seedProject, seedStory } from './helpers/db.ts';
import { ProjectService } from '../src/projects/service.ts';
import { createTestDb } from './helpers/db.ts';
import { makeTempRepo } from './helpers/temp.ts';

const json = (r: { body: string }) => JSON.parse(r.body);

describe('/office routes', () => {
  it('creating a project creates its room; deleting archives it', async () => {
    const { inject } = await buildTestApp();
    const created = await inject('POST', '/projects', { name: 'Alpha', key: 'ALPHA', repoPath: makeTempRepo({ name: 'alpha' }) });
    let rooms = json(await inject('GET', '/office/rooms'));
    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({ projectKey: 'ALPHA', state: 'active', slot: { wing: 'N', index: 0, side: 'L' } });
    await inject('DELETE', `/projects/${json(created).id}`);
    expect(json(await inject('GET', '/office/rooms'))).toHaveLength(0);
    rooms = json(await inject('GET', '/office/rooms?include=archived'));
    expect(rooms[0]).toMatchObject({ state: 'archived', projectKey: 'ALPHA' });
  });

  it('PATCH validates customization', async () => {
    const { inject } = await buildTestApp();
    await inject('POST', '/projects', { name: 'Alpha', key: 'ALPHA', repoPath: makeTempRepo({ name: 'alpha2' }) });
    const [room] = json(await inject('GET', '/office/rooms'));
    const bad = await inject('PATCH', `/office/rooms/${room.id}`, { customization: { ...room.customization, accentColor: 'nope' } });
    expect(bad.statusCode).toBe(400);
    expect(json(bad).error.code).toBe('VALIDATION_FAILED');
    const good = await inject('PATCH', `/office/rooms/${room.id}`, { customization: { ...room.customization, signName: 'Hello' } });
    expect(good.statusCode).toBe(200);
    expect(json(good).customization.signName).toBe('Hello');
  });

  it('PATCH rejects a semantically invalid layout (role-less station) with 400', async () => {
    const { inject } = await buildTestApp();
    await inject('POST', '/projects', { name: 'Alpha', key: 'ALPHA', repoPath: makeTempRepo({ name: 'alpha-layout' }) });
    const [room] = json(await inject('GET', '/office/rooms'));
    const layout = [{ id: 's1', kind: 'station', area: 'dev', x: 2, z: 2, rotationY: 0 }];
    const bad = await inject('PATCH', `/office/rooms/${room.id}`, { customization: { ...room.customization, layout } });
    expect(bad.statusCode).toBe(400);
    expect(json(bad).error.code).toBe('VALIDATION_FAILED');
    expect(json(bad).error.message).toMatch(/station has no role/);
  });

  it('busy project delete (409) leaves the room active', async () => {
    const { inject, t } = await buildTestApp();
    const created = await inject('POST', '/projects', { name: 'Alpha', key: 'ALPHA', repoPath: makeTempRepo({ name: 'alpha3' }) });
    const id = json(created).id as number;
    const s = seedStory(t.db, id);
    t.db.insert(agentRuns).values({
      storyId: s.id, role: 'implementer', attempt: 1, promptVersion: 'v1', opencodeVersion: '0',
      idempotencyKey: 'k-office-busy', status: 'running', startedAt: new Date(1_700_000_000_000),
    }).run();
    expect((await inject('DELETE', `/projects/${id}`)).statusCode).toBe(409);
    expect(json(await inject('GET', '/office/rooms'))[0]).toMatchObject({ state: 'active', projectKey: 'ALPHA' });
  });

  it('DELETE of a non-archived room is rejected; unknown room is 404', async () => {
    const { inject } = await buildTestApp();
    await inject('POST', '/projects', { name: 'Alpha', key: 'ALPHA', repoPath: makeTempRepo({ name: 'alpha4' }) });
    const [room] = json(await inject('GET', '/office/rooms'));
    expect((await inject('DELETE', `/office/rooms/${room.id}`)).statusCode).toBe(409);
    expect((await inject('DELETE', '/office/rooms/9999')).statusCode).toBe(404);
  });

  it('POST /office/rooms/compact returns rooms', async () => {
    const { inject } = await buildTestApp();
    const res = await inject('POST', '/office/rooms/compact');
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(json(res))).toBe(true);
  });

  it('GET /office/snapshot returns a valid OfficeSnapshot', async () => {
    const { inject } = await buildTestApp();
    await inject('POST', '/projects', { name: 'Alpha', key: 'ALPHA', repoPath: makeTempRepo({ name: 'alpha5' }) });
    const res = await inject('GET', '/office/snapshot');
    expect(res.statusCode).toBe(200);
    const snap = OfficeSnapshot.parse(json(res));
    expect(snap.rooms).toHaveLength(1);
  });

  it('startup reconcile gives a pre-seeded project a room', async () => {
    const { inject } = await buildTestApp({ beforeStart: (db) => void seedProject(db, { key: 'PRE', name: 'Pre' }) });
    const rooms = json(await inject('GET', '/office/rooms'));
    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({ projectKey: 'PRE', state: 'active' });
  });

  it('room is archived only after the data purge succeeded', async () => {
    const t = createTestDb();
    const p = seedProject(t.db);
    let projectGoneAtHook: boolean | null = null;
    const rooms = { onProjectDeleted: () => { projectGoneAtHook = t.db.select().from(projects).where(eq(projects.id, p.id)).get() === undefined; } };
    const svc = new ProjectService({ db: t.db, rooms: rooms as never });
    await svc.delete(p.id);
    expect(projectGoneAtHook).toBe(true);
  });
});
