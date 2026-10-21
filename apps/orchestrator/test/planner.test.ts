import { acceptanceCriteria, agentRuns, clarifications, plans, userStories } from '@aik/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { PlannerAgent } from '../src/agents/planner.ts';
import { RunInterruptRegistry } from '../src/agents/interrupts.ts';
import { ROLE_TIMEOUTS, type OpenCodeRuntime, type RunOneShotInput } from '../src/agents/runtime.ts';
import { EventBus } from '../src/events/bus.ts';
import { WorkflowService } from '../src/workflow/service.ts';
import { createTestDb, forceStory, seedAcceptanceCriterion, seedPlan, seedProject, seedStory } from './helpers/db.ts';

/** A valid PlanV1 JSON code block with configurable clarification questions. */
function mockPlanText(clarificationQuestions: string[] = []): string {
  const plan = {
    schemaVersion: 1,
    summary: 'Mock plan summary',
    assumptions: [],
    clarificationQuestions,
    acceptanceCriteria: [{ ref: 'AC-1', text: 'It works', testable: true, verification: 'Unit test' }],
    subtasks: [{ id: '1', description: 'Do the work', files: ['src/feature.ts'] }],
    affectedFiles: ['src/feature.ts'],
    requiredTests: ['test/feature.test.ts'],
    migrations: { required: false, notes: '' },
    securitySensitive: [],
    dependencyChanges: [],
    conflictsWith: [],
    complexity: 'S',
    risks: [],
  };
  return `\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``;
}

describe('PlannerAgent', () => {
  let dbHolder: ReturnType<typeof createTestDb>;
  let bus: EventBus;
  let workflow: WorkflowService;

  beforeAll(() => {
    dbHolder = createTestDb();
    bus = new EventBus();
    workflow = new WorkflowService({ db: dbHolder.db, bus });
  });

  afterAll(() => {
    dbHolder.close();
  });

  test('runs the model with the planner wall-clock budget from the spec', async () => {
    // A flat 10-minute budget cut real planning runs short: observed planner runs needed
    // 11–12 minutes and were killed, which threw away the finished plan.
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/test-proj-timeout' });
    const story = seedStory(dbHolder.db, project.id, { title: 'Budgeted Plan', status: 'NEW' });

    const runOneShot = vi.fn().mockResolvedValue({ ok: true, text: mockPlanText([]) });
    const mockRuntime: OpenCodeRuntime = { runOneShot } as unknown as OpenCodeRuntime;

    const planner = new PlannerAgent({ db: dbHolder.db, workflow, bus, runtime: mockRuntime });
    const result = await planner.planStory({ storyId: story.id });

    expect(result.ok).toBe(true);
    expect(runOneShot).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: ROLE_TIMEOUTS.planner }));
    expect(ROLE_TIMEOUTS.planner).toBe(20 * 60_000);
  });

  test('generates plan, saves to plans table, and transitions story to READY on auto-accept', async () => {
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/test-proj' });
    const story = seedStory(dbHolder.db, project.id, {
      title: 'Add User Logout Button',
      description: 'Add a logout button in the header.',
      status: 'NEW',
    });

    dbHolder.db.insert(acceptanceCriteria).values({
      storyId: story.id,
      storyRevision: 1,
      ordinal: 1,
      text: 'Clicking logout clears session and redirects to /login',
      source: 'human',
      createdAt: new Date(),
    }).run();

    const mockResponseJson = JSON.stringify({
      schemaVersion: 1,
      summary: 'Add logout button and session clearing logic',
      assumptions: ['Auth token is stored in localStorage'],
      clarificationQuestions: [],
      acceptanceCriteria: [
        { ref: 'AC-1', text: 'Clicking logout clears session', testable: true, verification: 'Unit test' },
      ],
      subtasks: [
        { id: '1', description: 'Create LogoutButton component', files: ['apps/ui/src/components/LogoutButton.tsx'] },
        { id: '2', description: 'Add onClick handler calling logout API', files: ['apps/ui/src/lib/auth.ts'] },
      ],
      affectedFiles: ['apps/ui/src/components/LogoutButton.tsx', 'apps/ui/src/lib/auth.ts'],
      requiredTests: ['apps/ui/test/logout.test.ts'],
      migrations: { required: false, notes: '' },
      securitySensitive: [],
      dependencyChanges: [],
      conflictsWith: [],
      complexity: 'S',
      risks: [],
    });

    const mockRuntime: OpenCodeRuntime = {
      runOneShot: vi.fn().mockResolvedValue({
        ok: true,
        text: `Here is the plan:\n\`\`\`json\n${mockResponseJson}\n\`\`\``,
      }),
    } as unknown as OpenCodeRuntime;

    const planner = new PlannerAgent({
      db: dbHolder.db,
      workflow,
      bus,
      runtime: mockRuntime,
    });

    const result = await planner.planStory({
      storyId: story.id,
      autoAccept: true,
    });

    expect(result.ok).toBe(true);
    expect(result.planId).toBeDefined();

    // Verify database row
    const savedPlan = dbHolder.db.select().from(plans).where(eq(plans.storyId, story.id)).get();
    expect(savedPlan).toBeDefined();
    expect(savedPlan?.status).toBe('approved');
    expect(savedPlan?.content.summary).toContain('Add logout button');

    // Verify story transitioned to READY
    const updatedStory = dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get();
    expect(updatedStory?.status).toBe('READY');
    expect(updatedStory?.planningStatus).toBe('plan_approved');
  });

  test('registers the session with the interrupt registry and unregisters after a successful plan', async () => {
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/test-proj-registry' });
    const story = seedStory(dbHolder.db, project.id, { title: 'Interruptible Plan', status: 'NEW' });
    const registry = new RunInterruptRegistry();
    const interrupt = vi.fn().mockResolvedValue(true);

    let runIdDuringSession: number | undefined;
    let shouldStopDuringSession: boolean | undefined;
    const mockRuntime: OpenCodeRuntime = {
      runOneShot: vi.fn().mockImplementation(async (opts: RunOneShotInput) => {
        shouldStopDuringSession = opts.shouldStop?.();
        await opts.onSessionCreated?.('ses_plan_registry');
        runIdDuringSession = registry.active(story.id)?.runId;
        return { ok: true, text: 'Simple approach: add the feature with tests.' };
      }),
      interrupt,
    } as unknown as OpenCodeRuntime;

    const planner = new PlannerAgent({ db: dbHolder.db, workflow, bus, runtime: mockRuntime, interrupts: registry });
    const result = await planner.planStory({ storyId: story.id });

    expect(result.ok).toBe(true);
    const run = dbHolder.db.select().from(agentRuns).where(eq(agentRuns.storyId, story.id)).get();
    expect(run?.status).toBe('succeeded');
    expect(runIdDuringSession).toBe(run?.id);
    expect(shouldStopDuringSession).toBe(false);
    expect(registry.active(story.id)).toBeUndefined();
    expect(registry.isStopRequested(story.id)).toBe(false);
    expect(interrupt).not.toHaveBeenCalled();
  });

  test('records an interrupted run without transitioning the story or consuming an attempt', async () => {
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/test-proj-stopped' });
    const story = seedStory(dbHolder.db, project.id, { title: 'Stopped Plan', status: 'NEW', attemptCount: 2 });
    const registry = new RunInterruptRegistry();
    const interrupt = vi.fn().mockResolvedValue(true);
    const transitionSpy = vi.spyOn(workflow, 'transition');

    let shouldStopBefore: boolean | undefined;
    let shouldStopAfter: boolean | undefined;
    let runIdDuringSession: number | undefined;
    const mockRuntime: OpenCodeRuntime = {
      runOneShot: vi.fn().mockImplementation(async (opts: RunOneShotInput) => {
        shouldStopBefore = opts.shouldStop?.();
        await opts.onSessionCreated?.('ses_plan_stopped');
        runIdDuringSession = registry.active(story.id)?.runId;
        await registry.requestStop(story.id);
        shouldStopAfter = opts.shouldStop?.();
        // Production ordering (EXE-13): the stop request transitions the story before the interrupt lands.
        forceStory(dbHolder.db, story.id, { status: 'BLOCKED', blockedReason: 'interrupted', activeRunId: null });
        return { ok: false, interrupted: true, error: 'Aborted' };
      }),
      interrupt,
    } as unknown as OpenCodeRuntime;

    const planner = new PlannerAgent({ db: dbHolder.db, workflow, bus, runtime: mockRuntime, interrupts: registry });
    const result = await planner.planStory({ storyId: story.id });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('interrupted');
    expect(shouldStopBefore).toBe(false);
    expect(shouldStopAfter).toBe(true);
    expect(runIdDuringSession).toBeDefined();

    const run = dbHolder.db.select().from(agentRuns).where(eq(agentRuns.storyId, story.id)).get();
    expect(run?.status).toBe('interrupted');
    expect(run?.exitReason).toContain('stop request');

    const updated = dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get();
    expect(updated?.status).toBe('BLOCKED');
    expect(updated?.blockedReason).toBe('interrupted');
    expect(updated?.attemptCount).toBe(2);

    expect(transitionSpy).not.toHaveBeenCalled();
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(interrupt).toHaveBeenCalledWith('ses_plan_stopped', 'C:/repos/test-proj-stopped');
    expect(registry.active(story.id)).toBeUndefined();
    expect(registry.isStopRequested(story.id)).toBe(false);
    transitionSpy.mockRestore();
  });

  test('behaves identically without the interrupts dependency', async () => {
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/test-proj-nodep' });
    const story = seedStory(dbHolder.db, project.id, { title: 'No Registry Plan', status: 'NEW' });

    let shouldStopResult: boolean | undefined;
    const mockRuntime: OpenCodeRuntime = {
      runOneShot: vi.fn().mockImplementation(async (opts: RunOneShotInput) => {
        shouldStopResult = opts.shouldStop?.();
        await opts.onSessionCreated?.('ses_plan_nodep');
        return { ok: true, text: 'Plan without a registry.' };
      }),
      interrupt: vi.fn().mockResolvedValue(true),
    } as unknown as OpenCodeRuntime;

    const planner = new PlannerAgent({ db: dbHolder.db, workflow, bus, runtime: mockRuntime });
    const result = await planner.planStory({ storyId: story.id });

    expect(result.ok).toBe(true);
    expect(shouldStopResult).toBe(false);
    expect(mockRuntime.interrupt).not.toHaveBeenCalled();
    expect(dbHolder.db.select().from(plans).where(eq(plans.storyId, story.id)).get()?.status).toBe('proposed');
  });

  test('plan with clarification questions → needs_clarification, rows persisted, no auto-accept', async () => {
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/test-proj-questions' });
    const story = seedStory(dbHolder.db, project.id, { title: 'Needs Clarification', status: 'NEW' });
    const transitionSpy = vi.spyOn(workflow, 'transition');

    const questions = ['Which identity provider backs login?', 'Should sessions expire after inactivity?'];
    let capturedPrompt = '';
    const mockRuntime: OpenCodeRuntime = {
      runOneShot: vi.fn().mockImplementation(async (opts: RunOneShotInput) => {
        capturedPrompt = opts.prompt;
        return { ok: true, text: mockPlanText(questions) };
      }),
    } as unknown as OpenCodeRuntime;

    const planner = new PlannerAgent({ db: dbHolder.db, workflow, bus, runtime: mockRuntime });
    const result = await planner.planStory({ storyId: story.id, autoAccept: true });

    expect(result.ok).toBe(true);

    // The prompt no longer forces an empty list and tells the model when questions are allowed.
    expect(capturedPrompt).not.toContain('"clarificationQuestions": []');
    expect(capturedPrompt).toContain('genuinely block');

    // Story parks in needs_clarification (stays NEW); no auto-accept even though it was requested.
    const updated = dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get();
    expect(updated?.status).toBe('NEW');
    expect(updated?.planningStatus).toBe('needs_clarification');
    expect(transitionSpy).not.toHaveBeenCalled();

    // The plan itself is saved as proposed, with its questions intact.
    const savedPlan = dbHolder.db.select().from(plans).where(eq(plans.storyId, story.id)).get();
    expect(savedPlan?.status).toBe('proposed');
    expect(savedPlan?.content.clarificationQuestions).toEqual(questions);

    // One clarifications row per question, ordinals 1..n, unanswered.
    const rows = dbHolder.db
      .select()
      .from(clarifications)
      .where(eq(clarifications.planId, savedPlan!.id))
      .all()
      .sort((a, b) => a.ordinal - b.ordinal);
    expect(rows.map((r) => r.ordinal)).toEqual([1, 2]);
    expect(rows.map((r) => r.question)).toEqual(questions);
    expect(rows.every((r) => r.answer === null && r.answeredAt === null)).toBe(true);
    transitionSpy.mockRestore();
  });

  test('zero questions with autoAccept → plan_proposed then auto-accept transition', async () => {
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/test-proj-zeroq' });
    const story = seedStory(dbHolder.db, project.id, { title: 'Zero Questions', description: 'Add the feature.', status: 'NEW' });
    seedAcceptanceCriterion(dbHolder.db, story.id);
    const transitionSpy = vi.spyOn(workflow, 'transition');

    const mockRuntime: OpenCodeRuntime = {
      runOneShot: vi.fn().mockResolvedValue({ ok: true, text: mockPlanText([]) }),
    } as unknown as OpenCodeRuntime;

    const planner = new PlannerAgent({ db: dbHolder.db, workflow, bus, runtime: mockRuntime });
    const result = await planner.planStory({ storyId: story.id, autoAccept: true });

    expect(result.ok).toBe(true);
    expect(transitionSpy).toHaveBeenCalledTimes(1);
    expect(transitionSpy).toHaveBeenCalledWith(
      expect.objectContaining({ storyId: story.id, event: { type: 'auto_accept_plan', planVersion: 1 }, actor: 'system' }),
    );

    const updated = dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get();
    expect(updated?.status).toBe('READY');
    expect(updated?.planningStatus).toBe('plan_approved');
    transitionSpy.mockRestore();
  });

  test('re-plan prompt includes previous rejection feedback and answered clarifications', async () => {
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/test-proj-replan' });
    const story = seedStory(dbHolder.db, project.id, { title: 'Replan Me', status: 'NEW' });

    const rejected = seedPlan(dbHolder.db, story.id, {
      version: 1,
      status: 'rejected',
      rejectionFeedback: 'Use feature flags instead of environment variables.',
    });
    dbHolder.db
      .insert(clarifications)
      .values([
        {
          planId: rejected.id,
          ordinal: 1,
          question: 'Which feature-flag provider do you use?',
          answer: 'LaunchDarkly',
          answeredAt: new Date(),
        },
        { planId: rejected.id, ordinal: 2, question: 'Unanswered question that must not reach the prompt?', answer: null },
      ])
      .run();

    let capturedPrompt = '';
    const mockRuntime: OpenCodeRuntime = {
      runOneShot: vi.fn().mockImplementation(async (opts: RunOneShotInput) => {
        capturedPrompt = opts.prompt;
        return { ok: true, text: mockPlanText([]) };
      }),
    } as unknown as OpenCodeRuntime;

    const planner = new PlannerAgent({ db: dbHolder.db, workflow, bus, runtime: mockRuntime });
    const result = await planner.planStory({ storyId: story.id });

    expect(result.ok).toBe(true);
    expect(capturedPrompt).toContain('PREVIOUS PLAN FEEDBACK');
    expect(capturedPrompt).toContain('Use feature flags instead of environment variables.');
    expect(capturedPrompt).toContain('CLARIFICATION ANSWERS');
    expect(capturedPrompt).toContain('Q: Which feature-flag provider do you use?');
    expect(capturedPrompt).toContain('A: LaunchDarkly');
    expect(capturedPrompt).toContain('Incorporate the previous plan feedback');
    // Unanswered rows are not rendered into the re-plan prompt.
    expect(capturedPrompt).not.toContain('Unanswered question');

    // The re-plan is the next version; the rejected v1 row is untouched.
    const allPlans = dbHolder.db.select().from(plans).where(eq(plans.storyId, story.id)).all();
    expect(allPlans.map((p) => p.version).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(allPlans.find((p) => p.version === 1)?.status).toBe('rejected');
    expect(allPlans.find((p) => p.version === 2)?.status).toBe('proposed');
  });

  test('injects skills for planner role and cleans them up after plan run', async () => {
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/test-proj-skills' });
    const story = seedStory(dbHolder.db, project.id, { title: 'Skill Injected Story', status: 'NEW' });

    let capturedPrompt = '';
    const mockRuntime: OpenCodeRuntime = {
      runOneShot: vi.fn().mockImplementation(async (opts: RunOneShotInput) => {
        capturedPrompt = opts.prompt;
        return { ok: true, text: mockPlanText([]) };
      }),
    } as unknown as OpenCodeRuntime;

    const mockSkills = {
      injectSkills: vi.fn().mockResolvedValue({
        injected: [{ id: 'writing-plans', name: 'writing-plans', installName: 'writing-plans' }],
        promptHint: 'AVAILABLE SKILLS:\n- writing-plans',
      }),
      cleanupSkills: vi.fn().mockResolvedValue(undefined),
    };

    const planner = new PlannerAgent({
      db: dbHolder.db,
      workflow,
      bus,
      runtime: mockRuntime,
      skills: mockSkills as never,
    });

    const result = await planner.planStory({ storyId: story.id });
    expect(result.ok).toBe(true);
    expect(mockSkills.injectSkills).toHaveBeenCalledWith(
      expect.objectContaining({
        targetDirectory: project.repoPath,
        role: 'planner',
        storyTitle: story.title,
      }),
    );
    expect(capturedPrompt).toContain('AVAILABLE SKILLS:\n- writing-plans');
    expect(mockSkills.cleanupSkills).toHaveBeenCalledWith(project.repoPath);
  });
});

