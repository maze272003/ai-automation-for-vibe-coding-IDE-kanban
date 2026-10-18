import { pino, type Logger } from 'pino';
import type { Redactor } from '../secrets/redactor.ts';
import { RotatingFile } from './rotating-file.ts';

export function createLogger(opts: { file: string; redactor: Redactor; level?: string; maxBytes?: number; keep?: number }): {
  logger: Logger;
  close(): void;
} {
  const destination = new RotatingFile({
    file: opts.file,
    maxBytes: opts.maxBytes ?? 10 * 1024 * 1024,
    keep: opts.keep ?? 5,
    transform: (line) => opts.redactor.redact(line),
  });
  const logger = pino({ level: opts.level ?? 'info', base: undefined, timestamp: pino.stdTimeFunctions.isoTime }, destination);
  return { logger, close: () => destination.close() };
}
