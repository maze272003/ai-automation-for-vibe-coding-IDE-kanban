import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/logging/logger.ts';
import { RotatingFile } from '../src/logging/rotating-file.ts';
import { createRedactor } from '../src/secrets/redactor.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aikanban-test-log-'));

describe('RotatingFile', () => {
  it('rotates at maxBytes, keeps `keep` old files and applies the transform', () => {
    const file = path.join(tmp(), 'x.log');
    const f = new RotatingFile({ file, maxBytes: 100, keep: 2, transform: (s) => s.toUpperCase() });
    for (let i = 0; i < 10; i++) f.write(`line-${i}-${'x'.repeat(30)}\n`); // 38 bytes each
    f.close();
    expect(fs.existsSync(`${file}.1`)).toBe(true);
    expect(fs.existsSync(`${file}.2`)).toBe(true);
    expect(fs.existsSync(`${file}.3`)).toBe(false);
    const current = fs.readFileSync(file, 'utf8');
    expect(current).toContain('LINE-9');
    expect(current).not.toContain('line-9');
  });
});

describe('createLogger', () => {
  it('writes JSON lines with secrets redacted', () => {
    const file = path.join(tmp(), 'orchestrator.log');
    const redactor = createRedactor();
    redactor.addSecret('launch-token-0123456789');
    const { logger, close } = createLogger({ file, redactor });
    logger.info({ token: 'launch-token-0123456789', remote: 'https://u:p@example.com/x.git' }, 'hello');
    close();
    const entry = JSON.parse(fs.readFileSync(file, 'utf8').trim());
    expect(entry.msg).toBe('hello');
    expect(entry.token).toBe('[REDACTED:secret]');
    expect(entry.remote).toBe('https://[REDACTED]@example.com/x.git');
  });
});
