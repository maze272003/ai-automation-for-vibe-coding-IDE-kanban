// apps/orchestrator/src/config.ts
import path from 'node:path';

export interface DataPaths {
  root: string;
  db: string;
  backups: string;
  logs: string;
  orchestratorLog: string;
  worktrees: string;
}

export function dataPaths(root: string): DataPaths {
  return {
    root,
    db: path.join(root, 'app.db'),
    backups: path.join(root, 'backups'),
    logs: path.join(root, 'logs'),
    orchestratorLog: path.join(root, 'logs', 'orchestrator.log'),
    worktrees: path.join(root, 'wt'),
  };
}
