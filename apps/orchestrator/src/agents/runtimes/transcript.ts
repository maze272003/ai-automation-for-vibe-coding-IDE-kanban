// apps/orchestrator/src/agents/runtimes/transcript.ts — the app-owned redacted run log
// (spec §5.3, §6.2, task 6.1a-04). Every frame is redacted — recursive string leaves, plus whole
// values under credential keys — before it is serialized and counted against the size cap, so a
// secret is never written even when the frame that carried it ends up dropped by truncation. Room
// for the one fixed overflow diagnostic is reserved up front, so the file never passes the cap;
// after it, everything is dropped. Lines are always written whole; a write error never throws into
// the stdout handler. The log path is enforced to be <dataDir>/runs/<runId>/run.ndjson — never
// inside a worktree.
import fs from 'node:fs';
import path from 'node:path';

export interface RunLog {
  appendFrame(f: unknown): void;
  appendDiagnostic(text: string): void;
  close(): Promise<void>;
}

export interface RunLogOptions {
  /** Absolute log file path — `<dataDir>/runs/<runId>/run.ndjson` (see runLogPath); never inside a worktree. */
  path: string;
  redact: (text: string) => string;
  maxBytes?: number;
}

export const RUN_LOG_MAX_BYTES = 8 * 1024 * 1024;

/** Text of the one diagnostic written when the cap is hit; nothing is written after it. */
export const RUN_LOG_TRUNCATED_TEXT = 'run log size cap reached; remaining run output was dropped';

/** `type` of diagnostic envelope lines in a run log. */
export const RUN_LOG_DIAGNOSTIC_TYPE = 'aik_diagnostic';

export interface RunLogDiagnostic {
  type: typeof RUN_LOG_DIAGNOSTIC_TYPE;
  text: string;
}

// Alphanumeric, single character allowed (fresh databases have runs 1-9), no trailing dot, and no
// Windows device name (CON, PRN, AUX, NUL, COM1-9, LPT1-9) even with an extension — such ids
// would not map to a real file on Windows.
const RUN_ID_PATTERN = /^(?!(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$))[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9-])?$/i;

/** Run-log path convention (spec §5.3): `<dataDir>/runs/<runId>/run.ndjson`. */
export function runLogPath(dataDir: string, runId: string | number): string {
  const id = String(runId);
  if (!RUN_ID_PATTERN.test(id)) throw new Error(`unsafe run id for run log: ${id}`);
  return path.join(dataDir, 'runs', id, 'run.ndjson');
}

/** The "never inside a worktree" guarantee is enforced here, not left to caller convention. */
function assertRunLogPath(file: string): void {
  const parsed = path.parse(file);
  const runId = path.basename(parsed.dir);
  if (parsed.base !== 'run.ndjson' || path.basename(path.dirname(parsed.dir)) !== 'runs' || !RUN_ID_PATTERN.test(runId)) {
    throw new Error(`run log path must be <dataDir>/runs/<runId>/run.ndjson: ${file}`);
  }
}

/** Credential keys by suffix (spec §6.2): the credential token must sit at the start or after a
 *  `-`/`_` separator — covers Proxy-Authorization, OPENAI_API_KEY, client_secret, session_token and
 *  the camelCase forms (via `i` and the optional separators). The whole value is replaced, not pattern-matched. */
const CREDENTIAL_VALUE_KEY = /(?:^|[-_])(?:access_?token|refresh_?token|id_?token|(?:proxy-)?authorization|api[-_]?key|cookie|set-cookie|password|(?:client[-_]?)?secret|session[-_]?token)$/i;

function redactValue(key: string | undefined, value: unknown, redact: (text: string) => string): unknown {
  if (key !== undefined && CREDENTIAL_VALUE_KEY.test(key) && value !== null) return '[REDACTED]';
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(key, v, redact));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(k, v, redact);
    return out;
  }
  return value;
}

/** Safe round-trip before redaction: BigInt becomes a string, Buffer/typed arrays their toJSON shape,
 *  cyclic or non-serializable values null. Never throws and never leaves raw non-JSON bytes. */
function toJsonValue(value: unknown): unknown {
  const replacer = (_key: string, v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : v);
  try {
    return JSON.parse(JSON.stringify(value, replacer));
  } catch {
    return null;
  }
}

export function createRunLog(opts: RunLogOptions): RunLog {
  const maxBytes = opts.maxBytes ?? RUN_LOG_MAX_BYTES;
  assertRunLogPath(opts.path);
  fs.mkdirSync(path.dirname(opts.path), { recursive: true });
  const fd = fs.openSync(opts.path, 'a');
  let bytes: number;
  try {
    bytes = fs.fstatSync(fd).size;
  } catch (err) {
    fs.closeSync(fd);
    throw err;
  }
  let truncated = false;
  let closed = false;
  let closePromise: Promise<void> | undefined;

  const diagnosticLine = (text: string): string => JSON.stringify({ type: RUN_LOG_DIAGNOSTIC_TYPE, text });
  const diagnostic = `${diagnosticLine(RUN_LOG_TRUNCATED_TEXT)}\n`;
  const diagnosticBytes = Buffer.byteLength(diagnostic, 'utf8');

  // Writes the whole buffer and returns the bytes actually flushed; a short count or 0 on failure —
  // never a throw (a failure must not escape into the stdout handler, and a 0 return breaks the loop).
  const writeAll = (data: Buffer): number => {
    let offset = 0;
    while (offset < data.length) {
      let flushed: number;
      try {
        flushed = fs.writeSync(fd, data, offset, data.length - offset);
      } catch {
        return offset;
      }
      if (flushed <= 0) return offset;
      offset += flushed;
    }
    return offset;
  };

  const truncate = (partialLine: boolean): void => {
    truncated = true;
    const text = `${partialLine ? '\n' : ''}${diagnostic}`; // terminate a partly flushed line first
    const written = writeAll(Buffer.from(text, 'utf8'));
    if (written === Buffer.byteLength(text, 'utf8')) bytes += written;
  };

  const writeLine = (line: string): void => {
    if (truncated || closed) return;
    const size = Buffer.byteLength(line, 'utf8') + 1;
    // Room for the diagnostic is reserved, so the file never passes maxBytes.
    if (bytes + size + diagnosticBytes > maxBytes) {
      truncate(false);
      return;
    }
    const data = Buffer.from(`${line}\n`, 'utf8');
    const flushed = writeAll(data);
    if (flushed === data.length) bytes += size;
    else truncate(flushed > 0);
  };

  return {
    appendFrame(f) {
      const line = JSON.stringify(redactValue(undefined, toJsonValue(f), opts.redact));
      writeLine(line === undefined ? 'null' : line);
    },
    appendDiagnostic(text) {
      writeLine(diagnosticLine(opts.redact(text)));
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = new Promise<void>((resolve, reject) => {
        try {
          fs.closeSync(fd); // synchronous: close() resolves only after the handle is released (Windows EBUSY)
          resolve();
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      return closePromise;
    },
  };
}
