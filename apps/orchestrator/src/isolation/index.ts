// apps/orchestrator/src/isolation/index.ts
import { JobObjectIsolationRunner } from './job-object.js';
import type { IsolationRunner } from './runner.js';

export * from './runner.js';
export * from './job-object.js';

let defaultRunner: IsolationRunner | null = null;

export function getIsolationRunner(): IsolationRunner {
  defaultRunner ??= new JobObjectIsolationRunner();
  return defaultRunner;
}
