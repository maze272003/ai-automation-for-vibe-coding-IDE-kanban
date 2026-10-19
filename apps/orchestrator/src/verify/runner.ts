// apps/orchestrator/src/verify/runner.ts
import { ProjectSettings, type BlockedReason, type CheckConfig } from '@aik/contracts';
import { projects, userStories, verificationChecks, verificationRuns, type AikDb } from '@aik/db';
import { and, eq, inArray } from 'drizzle-orm';
import os from 'node:os';
import path from 'node:path';
import type { EventBus } from '../events/bus.ts';
import { git } from '../git/git.ts';
import type { WorktreeManager } from '../git/worktree.ts';
import { runCheckCommand, type CommandStatus, type SpawnedCheckProcess } from '../checks/run.ts';
import { describeHits, scanWorktree } from '../secrets/scan.ts';
import { systemClock, type Clock } from '../time.ts';
import type { RunInterruptRegistry } from '../agents/interrupts.ts';
import type { WorkflowService } from '../workflow/service.ts';

export interface VerifyStoryInput {
  storyId: number;
}

export interface VerifyStoryResult {
  ok: boolean;
  status: 'passed' | 'failed' | 'error';
  passed?: boolean;
  error?: string;
  blockedReason?: BlockedReason;
  verificationRunId?: number;
}

export interface VerificationRunnerDeps {
  db: AikDb;
  workflow: WorkflowService;
  bus: EventBus;
  worktreeManager: WorktreeManager;
  logsDir?: string;
  now?: Clock;
  redact?: (text: string) => string;
  /** When provided, checks running for a story are registered as interruptible work (EXE-13). */
  interrupts?: RunInterruptRegistry;
}

function checkStatus(result: CommandStatus): 'passed' | 'failed' | 'error' | 'timed_out' | 'unsupported' {
  switch (result) {
    case 'passed':
      return 'passed';
    case 'failed':
      return 'failed';
    case 'timed_out':
      return 'timed_out';
    case 'unsupported':
      return 'unsupported';
    default:
      return 'error';
  }
}

/** Runs mandatory checks against the exact candidate (EXE-10). Evidence is written before any transition. */
export class VerificationRunner {
  private readonly db: AikDb;
  private readonly workflow: WorkflowService;
  private readonly bus: EventBus;
  private readonly worktreeManager: WorktreeManager;
  private readonly logsDir: string;
  private readonly now: Clock;
  private readonly redact: (text: string) => string;
  private readonly interrupts?: RunInterruptRegistry;

  constructor(deps: VerificationRunnerDeps) {
    this.db = deps.db;
    this.workflow = deps.workflow;
    this.bus = deps.bus;
    this.worktreeManager = deps.worktreeManager;
    this.logsDir = deps.logsDir ?? path.join(os.tmpdir(), 'aikanban-verify-logs');
    this.now = deps.now ?? systemClock;
    this.redact = deps.redact ?? ((s) => s);
    this.interrupts = deps.interrupts;
  }

  async verifyStory(input: VerifyStoryInput | number): Promise<VerifyStoryResult> {
    const storyId = typeof input === 'number' ? input : input.storyId;
    const story = this.db.select().from(userStories).where(eq(userStories.id, storyId)).get();
    if (!story) return { ok: false, status: 'error', error: `Story ${storyId} not found` };
    if (story.status !== 'TESTING') return { ok: false, status: 'error', error: `Story ${story.key} is ${story.status}, not TESTING` };
    if (!story.candidateSha) return { ok: false, status: 'error', error: `Story ${story.key} has no candidate commit` };

    const project = this.db.select().from(projects).where(eq(projects.id, story.projectId)).get();
    if (!project) return { ok: false, status: 'error', error: `Project for story ${story.key} not found` };
    const settings = ProjectSettings.parse(project.settings);
    if (settings.checks.length === 0 && !settings.secretsOnlyVerification) {
      return {
        ok: false,
        status: 'error',
        blockedReason: 'environment',
        error: 'No checks are configured. Add checks or explicitly accept secrets-only verification in the project settings.',
      };
    }

    const { worktreePath } = await this.worktreeManager.ensureStoryWorktree({
      repoPath: project.repoPath,
      storyKey: story.key,
      baseBranch: project.baseBranch,
      storyId: story.id,
    });

    const head = await git(['rev-parse', 'HEAD'], { cwd: worktreePath });
    if (head !== story.candidateSha) {
      return { ok: false, status: 'error', error: `Worktree HEAD ${head} does not match candidate ${story.candidateSha}; no evidence was recorded` };
    }
    const dirty = await git(['status', '--porcelain'], { cwd: worktreePath });
    if (dirty) {
      return { ok: false, status: 'error', error: 'The story worktree has uncommitted changes; verification refuses to run' };
    }

    const startedAt = new Date(this.now());
    const run = this.db
      .insert(verificationRuns)
      .values({
        storyId: story.id,
        commitSha: story.candidateSha,
        trigger: 'candidate',
        status: 'running',
        startedAt,
      })
      .returning()
      .get();

    let allMandatoryPassed: boolean;
    try {
      allMandatoryPassed = await this.runChecks(story.id, run.id, settings, worktreePath);
    } catch (err) {
      this.markRunError(run.id);
      return { ok: false, status: 'error', verificationRunId: run.id, error: err instanceof Error ? err.message : String(err) };
    }

    // Evidence is only trustworthy when it was produced at the recorded SHA: a check that moved
    // HEAD invalidates the whole run (spec §13.5 step 4, merge-integrity acceptance 7).
    const headAfterChecks = await this.headOrNull(worktreePath);
    if (headAfterChecks !== story.candidateSha) {
      this.markRunError(run.id);
      return {
        ok: false,
        status: 'error',
        verificationRunId: run.id,
        error: 'HEAD changed while checks were running; evidence was discarded',
      };
    }

    const infrastructure = this.db
      .select({ key: verificationChecks.checkKey, status: verificationChecks.status })
      .from(verificationChecks)
      .where(
        and(
          eq(verificationChecks.verificationRunId, run.id),
          eq(verificationChecks.mandatory, true),
          inArray(verificationChecks.status, ['error', 'unsupported']),
        ),
      )
      .all();
    if (infrastructure.length > 0) {
      this.db
        .update(verificationRuns)
        .set({ status: 'error', endedAt: new Date(this.now()) })
        .where(eq(verificationRuns.id, run.id))
        .run();
      this.bus.notify(1);
      return {
        ok: false,
        status: 'error',
        blockedReason: 'environment',
        verificationRunId: run.id,
        error: `Mandatory checks cannot run: ${infrastructure.map((c) => `${c.key} (${c.status})`).join(', ')}`,
      };
    }

    const status = allMandatoryPassed ? 'passed' : 'failed';
    this.db
      .update(verificationRuns)
      .set({ status, endedAt: new Date(this.now()) })
      .where(eq(verificationRuns.id, run.id))
      .run();
    this.bus.notify(1);

    if (!allMandatoryPassed) return { ok: false, status: 'failed', passed: false, verificationRunId: run.id };

    const transition = this.workflow.transition({
      storyId: story.id,
      event: { type: 'verification_passed', sha: story.candidateSha },
      actor: 'system',
    });
    if (!transition.ok) {
      return {
        ok: false,
        status: 'error',
        verificationRunId: run.id,
        error: transition.failedGuards?.map((g) => g.reason).join('; ') ?? transition.code,
      };
    }
    return { ok: true, status: 'passed', passed: true, verificationRunId: run.id };
  }

  /**
   * Runs the same mandatory evidence set against `merged_sha` in a fresh detached worktree (spec
   * §13.5 step 4). It never transitions the story: the merge pipeline owns T10.
   */
  async verifyPostMerge(input: { storyId: number; mergedSha: string }): Promise<VerifyStoryResult> {
    const story = this.db.select().from(userStories).where(eq(userStories.id, input.storyId)).get();
    if (!story) return { ok: false, status: 'error', error: `Story ${input.storyId} not found` };
    const project = this.db.select().from(projects).where(eq(projects.id, story.projectId)).get();
    if (!project) return { ok: false, status: 'error', error: `Project for story ${story.key} not found` };
    const settings = ProjectSettings.parse(project.settings);
    if (settings.checks.length === 0 && !settings.secretsOnlyVerification) {
      return {
        ok: false,
        status: 'error',
        blockedReason: 'environment',
        error: 'No checks are configured. Add checks or explicitly accept secrets-only verification in the project settings.',
      };
    }

    let worktreePath: string;
    try {
      worktreePath = await this.worktreeManager.ensurePostMergeWorktree({
        repoPath: project.repoPath,
        storyKey: story.key,
        sha: input.mergedSha,
        storyId: story.id,
      });
    } catch (err) {
      return { ok: false, status: 'error', error: err instanceof Error ? err.message : String(err) };
    }

    try {
      const head = await git(['rev-parse', 'HEAD'], { cwd: worktreePath });
      if (head !== input.mergedSha) {
        return { ok: false, status: 'error', error: `Post-merge worktree HEAD ${head} does not match ${input.mergedSha}` };
      }
      const dirty = await git(['status', '--porcelain'], { cwd: worktreePath });
      if (dirty) return { ok: false, status: 'error', error: 'The post-merge worktree is not clean; post-merge checks refuse to run' };

      const run = this.db
        .insert(verificationRuns)
        .values({
          storyId: story.id,
          commitSha: input.mergedSha,
          trigger: 'postmerge',
          status: 'running',
          startedAt: new Date(this.now()),
        })
        .returning()
        .get();

      let passed = false;
      try {
        passed = await this.runChecks(input.storyId, run.id, settings, worktreePath);
      } catch (err) {
        this.db
          .update(verificationRuns)
          .set({ status: 'error', endedAt: new Date(this.now()) })
          .where(eq(verificationRuns.id, run.id))
          .run();
        this.bus.notify(1);
        return { ok: false, status: 'error', verificationRunId: run.id, error: err instanceof Error ? err.message : String(err) };
      }

      // A post-merge check that moved HEAD means the evidence is not about `merged_sha`; discard it.
      const headAfterChecks = await this.headOrNull(worktreePath);
      if (headAfterChecks !== input.mergedSha) {
        this.markRunError(run.id);
        return {
          ok: false,
          status: 'error',
          verificationRunId: run.id,
          error: 'HEAD changed while checks were running; evidence was discarded',
        };
      }

      this.db
        .update(verificationRuns)
        .set({ status: passed ? 'passed' : 'failed', endedAt: new Date(this.now()) })
        .where(eq(verificationRuns.id, run.id))
        .run();
      this.bus.notify(1);
      return passed
        ? { ok: true, status: 'passed', passed: true, verificationRunId: run.id }
        : { ok: false, status: 'failed', passed: false, verificationRunId: run.id };
    } finally {
      await this.worktreeManager
        .removePostMergeWorktree({ repoPath: project.repoPath, storyKey: story.key })
        .catch(() => undefined);
    }
  }

  /** Marks a verification run `error` with an end timestamp and notifies listeners. */
  private markRunError(verificationRunId: number): void {
    this.db
      .update(verificationRuns)
      .set({ status: 'error', endedAt: new Date(this.now()) })
      .where(eq(verificationRuns.id, verificationRunId))
      .run();
    this.bus.notify(1);
  }

  /** HEAD of a worktree, or null when it cannot be read — unreadable evidence is untrustworthy. */
  private async headOrNull(worktreePath: string): Promise<string | null> {
    try {
      return await git(['rev-parse', 'HEAD'], { cwd: worktreePath });
    } catch {
      return null;
    }
  }

  /**
   * Executes the internal secrets scan and every configured check; returns whether all mandatory
   * ones passed. While checks run, the story's active work is registered as interruptible so a
   * registry stop kills the running check's process tree; a killed or stopped check can never
   * yield a pass (EXE-13, plan AC 5).
   */
  private async runChecks(
    storyId: number,
    verificationRunId: number,
    settings: ProjectSettings,
    worktreePath: string,
  ): Promise<boolean> {
    let allMandatoryPassed = true;

    // Verification has no agent run id; the registry slot exists only to make checks stoppable.
    let activeKillTree: SpawnedCheckProcess['killTree'] | null = null;
    if (this.interrupts) {
      this.interrupts.register(storyId, {
        stop: async () => {
          if (activeKillTree) await activeKillTree();
        },
      });
    }
    const onSpawned = (info: SpawnedCheckProcess) => {
      activeKillTree = info.killTree;
    };

    try {
      // Secrets scanning is always mandatory (EXE-9) and runs before any project check.
      const secretStarted = new Date(this.now());
      let secretHits: ReturnType<typeof scanWorktree> = [];
      let secretError: string | null = null;
      try {
        secretHits = scanWorktree(worktreePath);
      } catch (err) {
        secretError = err instanceof Error ? err.message : String(err);
      }
      const secretStatus = secretError ? 'error' : secretHits.length > 0 ? 'failed' : 'passed';
      if (secretStatus !== 'passed') allMandatoryPassed = false;
      this.db
        .insert(verificationChecks)
        .values({
          verificationRunId,
          checkKey: 'secrets',
          mandatory: true,
          command: 'internal:secrets',
          cwd: worktreePath,
          status: secretStatus,
          exitCode: null,
          outputTail: this.redact(secretError ?? describeHits(secretHits)),
          logPath: null,
          startedAt: secretStarted,
          endedAt: new Date(this.now()),
        })
        .run();

      for (const check of settings.checks) {
        if (this.interrupts?.isStopRequested(storyId)) {
          // A stop was requested (between checks, or after a kill): no further checks run and
          // the run cannot be recorded as passed.
          allMandatoryPassed = false;
          break;
        }
        const row = await this.runOneCheck(verificationRunId, check, worktreePath, onSpawned);
        if (check.mandatory && row !== 'passed') allMandatoryPassed = false;
      }
      return allMandatoryPassed;
    } finally {
      this.interrupts?.unregister(storyId);
    }
  }

  private async runOneCheck(
    verificationRunId: number,
    check: CheckConfig,
    worktreePath: string,
    onSpawned?: (info: SpawnedCheckProcess) => void,
  ): Promise<'passed' | 'failed' | 'error' | 'timed_out' | 'unsupported'> {
    const startedAt = new Date(this.now());
    const logPath = path.join(this.logsDir, `verify-${verificationRunId}-${check.key}.log`);
    const result = await runCheckCommand({
      command: check.command,
      cwd: worktreePath,
      timeoutMs: check.timeoutSec * 1000,
      logFile: logPath,
      redact: this.redact,
      onSpawned,
    });
    const status = checkStatus(result.status);
    this.db
      .insert(verificationChecks)
      .values({
        verificationRunId,
        checkKey: check.key,
        mandatory: check.mandatory,
        command: check.command,
        cwd: worktreePath,
        status,
        exitCode: result.exitCode,
        outputTail: this.redact(result.error ? `${result.error}\n${result.output}` : result.output),
        logPath,
        startedAt,
        endedAt: new Date(this.now()),
      })
      .run();
    return status;
  }
}
