// apps/orchestrator/test/office-routes.test.ts
import { OfficeSnapshot } from '@aik/contracts';
import { agentRuns } from '@aik/db';
import { describe, expect, it } from 'vitest';
import { buildTestApp } from './helpers/app.ts';
import { seedStory } from './helpers/db.ts';
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
});
