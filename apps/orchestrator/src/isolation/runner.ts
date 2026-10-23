// apps/orchestrator/src/isolation/runner.ts

export interface ProcessResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
  timedOut?: boolean;
}

export interface IsolationOptions {
  worktreeDir: string;
  allowedPorts?: number[];
  env?: Record<string, string>;
  timeoutMs?: number;
  memMb?: number;
  maxProcs?: number;
}

export interface IsolationRunner {
  readonly kind: 'mxc' | 'job_object';
  run(command: string[], options: IsolationOptions): Promise<ProcessResult>;
  dispose?(): Promise<void>;
}
