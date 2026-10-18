import { APP_ID } from '@aik/contracts';
import path from 'node:path';

export function resolveDataDir(env: NodeJS.ProcessEnv, fallbackAppData: string): string {
  if (env.AIK_DATA_DIR) return path.resolve(env.AIK_DATA_DIR);
  return path.join(env.LOCALAPPDATA ?? fallbackAppData, APP_ID);
}

export interface DesktopPaths {
  dataDir: string;
  db: string;
  backups: string;
  logs: string;
  electronUserData: string;
}

export function desktopPaths(dataDir: string): DesktopPaths {
  return {
    dataDir,
    db: path.join(dataDir, 'app.db'),
    backups: path.join(dataDir, 'backups'),
    logs: path.join(dataDir, 'logs'),
    electronUserData: path.join(dataDir, 'electron'),
  };
}
