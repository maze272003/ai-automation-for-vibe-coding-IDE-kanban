// apps/ui/test/plan-view.test.ts
import { describe, expect, it, vi } from 'vitest';
import type { PlanV1, StoryDTO } from '@aik/contracts';

const mocks = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('../src/lib/api.ts', () => ({ api: mocks }));

import { approvePlan } from '../src/lib/transitions.ts';
import { diffPlanLines, planBadge, planToLines } from '../src/lib/plan-view.ts';

const plan: PlanV1 = {
  schemaVersion: 1,
  summary: 'Add the approvals view backed by the existing plans table.',
  assumptions: ['The plans table already records who approved.'],
  clarificationQuestions: [],
  acceptanceCriteria: [
    { ref: 'AC-1', text: 'The approvals view lists every plan version', testable: true, verification: 'npm test approvals' },
  ],
  subtasks: [
    { id: '1', description: 'Render the approvals view', files: ['apps/ui/src/routes/approvals.tsx', 'apps/ui/test/approvals.test.ts'] },
  ],
  affectedFiles: [],
  requiredTests: [],
  migrations: { required: false, notes: '' },
  securitySensitive: [],
  dependencyChanges: [],
  conflictsWith: [],
  complexity: 'S',
  risks: ['Reviewers may approve a stale plan version.'],
};

describe('planToLines', () => {
  it('renders the exact review lines in order', () => {
    expect(planToLines(plan)).toEqual([
      'Summary: Add the approvals view backed by the existing plans table.',
      'Complexity: S',
      'Assumption: The plans table already records who approved.',
      'Risk: Reviewers may approve a stale plan version.',
      'AC AC-1: The approvals view lists every plan version — verify: npm test approvals',
      'Subtask 1: Render the approvals view',
      '  file: apps/ui/src/routes/approvals.tsx',
      '  file: apps/ui/test/approvals.test.ts',
    ]);
  });
});

describe('diffPlanLines', () => {
  it('marks a changed summary as one removed plus one added line, rest same', () => {
    const diff = diffPlanLines(plan, { ...plan, summary: 'Reuse the runs view with a plan filter.' });
    expect(diff).toEqual([
      { kind: 'removed', text: `Summary: ${plan.summary}` },
      { kind: 'added', text: 'Summary: Reuse the runs view with a plan filter.' },
      ...planToLines(plan).slice(1).map((text) => ({ kind: 'same', text })),
    ]);
  });

  it('reports identical plans as all same', () => {
    expect(diffPlanLines(plan, plan)).toEqual(planToLines(plan).map((text) => ({ kind: 'same', text })));
  });
});

describe('planBadge', () => {
  it('covers the four planning-attention cases', () => {
    expect(planBadge({ status: 'NEW', planningStatus: 'plan_proposed' })).toEqual({ label: 'Plan ready for approval', tone: 'info' });
    expect(planBadge({ status: 'NEW', planningStatus: 'needs_clarification' })).toEqual({ label: 'Needs your answers', tone: 'info' });
    expect(planBadge({ status: 'NEW', planningStatus: 'planning_failed' })).toEqual({ label: 'Planning failed — retrying', tone: 'warning' });
    expect(planBadge({ status: 'IN_PROGRESS', planningStatus: 'none' })).toBeNull();
  });
});

describe('approvePlan', () => {
  it('posts approve_plan with the active plan version', async () => {
    mocks.post.mockResolvedValue({});
    const story: StoryDTO = {
      id: 7,
      key: 'AIK-7',
      projectId: 1,
      title: 'Approve plans from the board',
      description: '',
      priority: 'P2',
      rank: 1,
      labels: [],
      complexity: null,
      revision: 0,
      status: 'NEW',
      statusVersion: 5,
      planningStatus: 'plan_proposed',
      activePlanVersion: 2,
      hold: false,
      costUsd: null,
      costComplete: true,
      blocked: null,
      attempts: { used: 0, max: 3 },
      acceptanceCriteria: [],
      dependsOn: [],
      branch: null,
      candidateSha: null,
      activeRun: null,
      lastRun: null,
      pullRequest: null,
      createdAt: 0,
      updatedAt: 0,
    };
    await expect(approvePlan(story)).resolves.toEqual({ ok: true });
    expect(mocks.post).toHaveBeenCalledWith('/stories/7/transitions', {
      event: 'approve_plan',
      planVersion: 2,
      expectedVersion: 5,
    });
  });
});
