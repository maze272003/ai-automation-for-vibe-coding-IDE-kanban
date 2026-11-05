// apps/desktop/src/main/diagnostics-export.ts — electron-free orchestration of the
// redacted diagnostics archive export (Phase 5.4 spec K-10). The main process owns
// the fetch, the native Save dialog and the file write; this module only sequences
// injected dependencies so it can be unit-tested with temp files.
import type { DiagnosticsExportResult } from '@aik/contracts';

export interface ExportDiagnosticsDeps {
  fetchArchive: () => Promise<unknown>;
  choosePath: (defaultName: string) => Promise<string | null>;
  writeFile: (file: string, data: string) => Promise<void>;
  now?: () => Date;
}

/** `aik-diagnostics-<ISO>.json`, with `:`/`.` replaced so the name is portable. */
function defaultFileName(now: Date): string {
  return `aik-diagnostics-${now.toISOString().replace(/[:.]/g, '-')}.json`;
}

export async function exportDiagnostics(deps: ExportDiagnosticsDeps): Promise<DiagnosticsExportResult> {
  let archive: unknown;
  try {
    archive = await deps.fetchArchive();
  } catch {
    // Fixed reason: never surface the underlying error text (it can contain internals).
    return { ok: false, reason: 'orchestrator unavailable' };
  }
  if (typeof archive !== 'object' || archive === null || Array.isArray(archive)) {
    return { ok: false, reason: 'export failed' };
  }

  let data: string;
  try {
    data = JSON.stringify(archive, null, 2);
  } catch {
    return { ok: false, reason: 'export failed' };
  }

  let file: string | null;
  try {
    file = await deps.choosePath(defaultFileName((deps.now ?? (() => new Date()))()));
  } catch {
    return { ok: false, reason: 'export failed' };
  }
  if (file === null) return { ok: false, reason: 'cancelled' };

  try {
    await deps.writeFile(file, data);
  } catch {
    return { ok: false, reason: 'write failed' };
  }
  return { ok: true, path: file };
}
