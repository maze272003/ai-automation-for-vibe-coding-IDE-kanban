/**
 * Registry of interruptible in-flight work per story.
 *
 * Spec §16.3 T13/T17 side effects: "Active run interrupted and process tree killed; lease
 * released". The workflow service records the `interrupt_active_run` effect in the audit
 * trail and, after commit, asks this registry to stop the story's active work (EXE-13).
 *
 * One interruptible run per story at a time (invariant I10: at most one implement run is
 * active per story, and the runner executes one heavy job at a time).
 */
export interface InterruptibleRun {
  /** The agent run id when one exists; verification jobs may omit it. */
  runId?: number;
  /**
   * Best-effort stop: interrupt the OpenCode session (§18.5) or kill a check process tree.
   * Errors are swallowed by `requestStop`; the stop flag alone must abort the local poll loop.
   */
  stop: () => Promise<void> | void;
}

export class RunInterruptRegistry {
  private readonly runs = new Map<number, InterruptibleRun>();
  private readonly stopRequested = new Set<number>();

  /**
   * Registers (or replaces) the story's active interruptible run. A fresh run never
   * inherits a stale stop flag (QA defect B): the boot sweep's `fail(interrupted)` can set
   * the flag while no run is registered, and a run started after `recover` must proceed.
   */
  register(storyId: number, run: InterruptibleRun): void {
    this.runs.set(storyId, run);
    this.stopRequested.delete(storyId);
  }

  /** Clears the story's handle and stop flag. Call when the run finishes, whatever the outcome. */
  unregister(storyId: number): void {
    this.runs.delete(storyId);
    this.stopRequested.delete(storyId);
  }

  /** Polled by in-flight work (e.g. `runOneShot`) so a stop request aborts the local loop. */
  isStopRequested(storyId: number): boolean {
    return this.stopRequested.has(storyId);
  }

  active(storyId: number): InterruptibleRun | undefined {
    return this.runs.get(storyId);
  }

  activeStoryIds(): number[] {
    return [...this.runs.keys()];
  }

  /**
   * Sets the stop flag and invokes the registered handle's `stop()`. Both are best-effort:
   * if `stop()` throws (e.g. the OpenCode server is unreachable), the flag still makes the
   * local poll loop abort, and the story has already transitioned (fail-safe ordering).
   */
  async requestStop(storyId: number): Promise<void> {
    this.stopRequested.add(storyId);
    const run = this.runs.get(storyId);
    if (run) {
      try {
        await run.stop();
      } catch {
        // Best-effort by design; see docblock.
      }
    }
  }
}
