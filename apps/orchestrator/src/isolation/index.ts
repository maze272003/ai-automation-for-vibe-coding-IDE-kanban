// apps/orchestrator/src/isolation/index.ts
import { JobObjectIsolationRunner } from './job-object.ts';
import type { IsolationRunner } from './runner.ts';

export * from './runner.ts';
export * from './job-object.ts';

let defaultRunner: IsolationRunner | null = null;

export function getIsolationRunner(): IsolationRunner {
  defaultRunner ??= new JobObjectIsolationRunner();
  return defaultRunner;
}
