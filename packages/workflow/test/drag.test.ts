import { describe, expect, it } from 'vitest';
import { dragVerdict, type DragStory } from '../src/index.ts';

const s = (o: Partial<DragStory>): DragStory => ({ status: 'NEW', blockedFrom: null, planningStatus: 'none', activePlanVersion: null, ...o });

describe('dragVerdict', () => {
  it('allows cancel from any non-terminal state', () => {
    expect(dragVerdict(s({ status: 'IN_PROGRESS' }), 'CANCELLED')).toEqual({ allowed: true, target: { to: 'CANCELLED', event: 'cancel' } });
  });
  it('refuses to drag into DONE with a clear reason', () => {
    expect(dragVerdict(s({}), 'DONE')).toEqual({ allowed: false, reason: 'Stories become DONE only after an approved, verified merge' });
  });
  it('NEW → READY only when a plan is proposed', () => {
    expect(dragVerdict(s({}), 'READY').allowed).toBe(false);
    expect(dragVerdict(s({ planningStatus: 'plan_proposed', activePlanVersion: 2 }), 'READY')).toEqual({ allowed: true, target: { to: 'READY', event: 'approve_plan' } });
  });
  it('BLOCKED recovers to READY, NEW or its resumable source', () => {
    const b = s({ status: 'BLOCKED', blockedFrom: 'TESTING' });
    expect(dragVerdict(b, 'TESTING')).toEqual({ allowed: true, target: { to: 'TESTING', event: 'recover', recoverTarget: 'resume' } });
    expect(dragVerdict(b, 'IN_PROGRESS')).toEqual({ allowed: false, reason: 'A blocked story can only be recovered to READY or NEW, or back to TESTING' });
  });
  it('system-only moves explain who moves them', () => {
    expect(dragVerdict(s({ status: 'READY' }), 'IN_PROGRESS')).toEqual({ allowed: false, reason: 'Only the orchestrator moves stories from READY to IN_PROGRESS' });
  });
  it('terminal stories never move', () => {
    expect(dragVerdict(s({ status: 'DONE' }), 'CANCELLED')).toEqual({ allowed: false, reason: 'DONE is final' });
  });
});
