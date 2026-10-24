// apps/orchestrator/src/maintenance/diagnostics.ts
import { projects, providers, type AikDb } from '@aik/db';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createRedactor, type Redactor } from '../secrets/redactor.ts';
import { describeHits, scanText } from '../secrets/scan.ts';

export interface DiagnosticsDeps {
  db: AikDb;
  logsDir?: string;
  version?: string;
  redactor?: Redactor;
}

export interface DiagnosticsArchive {
  version: string;
  timestamp: string;
  diagnostics: {
    platform: {
      os: string;
      arch: string;
      nodeVersion: string;
      uptimeSeconds: number;
    };
    projects: Array<{
      id: number;
      name: string;
      repoPath: string;
      settings: unknown;
    }>;
    providers: Array<{
      id: number;
      name: string;
      kind: string;
      baseUrl: string;
      hasApiKey: boolean;
    }>;
    logs: Array<{
      file: string;
      content: string;
    }>;
  };
}

const MAX_LOG_BYTES = 256 * 1024; // 256 KB per log file tail

export class DiagnosticsService {
  private readonly db: AikDb;
  private readonly logsDir?: string;
  private readonly version: string;
  private readonly redactor: Redactor;

  constructor(deps: DiagnosticsDeps) {
    this.db = deps.db;
    this.logsDir = deps.logsDir;
    this.version = deps.version ?? '0.0.0';
    this.redactor = deps.redactor ?? createRedactor();
  }

  async exportArchive(): Promise<DiagnosticsArchive> {
    // 1. Gather system info
    const platform = {
      os: `${os.type()} ${os.release()} (${os.platform()})`,
      arch: os.arch(),
      nodeVersion: process.version,
      uptimeSeconds: Math.floor(process.uptime()),
    };

    // 2. Fetch projects
    const rawProjects = this.db
      .select({
        id: projects.id,
        name: projects.name,
        repoPath: projects.repoPath,
        settings: projects.settings,
      })
      .from(projects)
      .all();

    // 3. Fetch providers (exclude secrets)
    const rawProviders = this.db
      .select({
        id: providers.id,
        name: providers.name,
        kind: providers.kind,
        baseUrl: providers.baseUrl,
        keyRef: providers.keyRef,
      })
      .from(providers)
      .all();

    const sanitizedProviders = rawProviders.map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      baseUrl: p.baseUrl,
      hasApiKey: Boolean(p.keyRef),
    }));

    // 4. Collect logs with redaction
    const collectedLogs: Array<{ file: string; content: string }> = [];
    if (this.logsDir && fs.existsSync(this.logsDir)) {
      try {
        const entries = fs.readdirSync(this.logsDir);
        for (const entry of entries) {
          if (!entry.endsWith('.log')) continue;
          const fullPath = path.join(this.logsDir, entry);
          try {
            const stat = fs.statSync(fullPath);
            if (!stat.isFile()) continue;
            let logContent = fs.readFileSync(fullPath, 'utf8');
            if (logContent.length > MAX_LOG_BYTES) {
              logContent = logContent.slice(-MAX_LOG_BYTES);
            }
            const redactedContent = this.redactor.redact(logContent);
            collectedLogs.push({
              file: entry,
              content: redactedContent,
            });
          } catch {
            // ignore unreadable log file
          }
        }
      } catch {
        // ignore unreadable logs directory
      }
    }

    const archive: DiagnosticsArchive = {
      version: this.version,
      timestamp: new Date().toISOString(),
      diagnostics: {
        platform,
        projects: rawProjects,
        providers: sanitizedProviders,
        logs: collectedLogs,
      },
    };

    // 5. Serialize, redact entire archive, and scan for any remaining secrets
    const serialized = JSON.stringify(archive);
    const fullyRedacted = this.redactor.redact(serialized);
    const hits = scanText(fullyRedacted, 'diagnostics.json');

    if (hits.length > 0) {
      throw new Error(`Diagnostics export failed secret scanning: ${describeHits(hits)}`);
    }

    return JSON.parse(fullyRedacted) as DiagnosticsArchive;
  }
}
