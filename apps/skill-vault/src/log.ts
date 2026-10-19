// apps/skill-vault/src/log.ts — redacting JSONL logger. Secrets must never reach disk or stdout.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ensureDir } from './util.ts';

const SECRET_KEY_PATTERN = /(token|secret|password|passwd|authorization|api[-_]?key|cookie|credential|session)/i;
const SECRET_VALUE_PATTERN = /\b(sk_live_[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{16,}|eyJ[A-Za-z0-9._-]{20,})/g;

const redactText = (text: string): string => text.replace(SECRET_VALUE_PATTERN, '[redacted]');

/** Recursively redact values under secret-looking keys and scrub token-like strings. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limit]';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? '[redacted]' : redact(val, depth + 1);
    }
    return out;
  }
  return value;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export class Logger {
  private readonly stream: fsp.FileHandle | undefined;
  private readonly consoleOut: boolean;

  private constructor(stream: fsp.FileHandle | undefined, consoleOut: boolean) {
    this.stream = stream;
    this.consoleOut = consoleOut;
  }

  static async open(logsDir: string, consoleOut = true): Promise<Logger> {
    await ensureDir(logsDir);
    const stamp = new Date().toISOString().replaceAll(':', '-');
    const stream = await fsp.open(path.join(logsDir, `vault-${stamp}.jsonl`), 'a');
    return new Logger(stream, consoleOut);
  }

  static silent(): Logger {
    return new Logger(undefined, false);
  }

  async log(level: LogLevel, message: string, fields: Record<string, unknown> = {}): Promise<void> {
    const entry = redact({ ts: new Date().toISOString(), level, message, ...fields });
    const line = `${JSON.stringify(entry)}\n`;
    if (this.stream) await this.stream.write(line).catch(() => undefined);
    if (this.consoleOut) {
      const suffix = Object.keys(fields).length > 0 ? ` ${JSON.stringify(redact(fields))}` : '';
      const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
      sink(`[${level}] ${message}${suffix}`);
    }
  }

  readonly debug = (message: string, fields?: Record<string, unknown>) => this.log('debug', message, fields);
  readonly info = (message: string, fields?: Record<string, unknown>) => this.log('info', message, fields);
  readonly warn = (message: string, fields?: Record<string, unknown>) => this.log('warn', message, fields);
  readonly error = (message: string, fields?: Record<string, unknown>) => this.log('error', message, fields);

  async close(): Promise<void> {
    await this.stream?.close().catch(() => undefined);
  }
}
