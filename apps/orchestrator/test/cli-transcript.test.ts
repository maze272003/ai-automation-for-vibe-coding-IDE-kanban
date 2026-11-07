// apps/orchestrator/test/cli-transcript.test.ts — RED tests for the redacted run-log writer
// (task 6.1a-04, spec §5.3, §6.2). All files live under OS temp via makeTempDir.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { createJsonlDecoder } from '../src/agents/runtimes/jsonl.ts';
import {
  createRunLog,
  RUN_LOG_DIAGNOSTIC_TYPE,
  RUN_LOG_MAX_BYTES,
  RUN_LOG_TRUNCATED_TEXT,
  runLogPath,
} from '../src/agents/runtimes/transcript.ts';
import { createRedactor } from '../src/secrets/redactor.ts';
import { makeTempDir } from './helpers/temp.ts';

function makeLog(dir: string, runId: string | number, maxBytes?: number) {
  const redactor = createRedactor();
  const file = runLogPath(dir, runId);
  const log = createRunLog({ path: file, redact: redactor.redact, ...(maxBytes !== undefined ? { maxBytes } : {}) });
  return { redactor, file, log };
}

function readLogLines(file: string): string[] {
  const content = fs.readFileSync(file, 'utf8');
  expect(content === '' || content.endsWith('\n')).toBe(true); // lines are always newline-terminated, never half-written
  return content.split('\n').slice(0, -1);
}

describe('runLogPath', () => {
  test('builds <dataDir>/runs/<runId>/run.ndjson and refuses unsafe run ids', () => {
    const dir = makeTempDir('aik-runlog-');
    expect(runLogPath(dir, 42)).toBe(path.join(dir, 'runs', '42', 'run.ndjson'));
    expect(runLogPath(dir, 'probe-2b3c4d')).toBe(path.join(dir, 'runs', 'probe-2b3c4d', 'run.ndjson'));
    expect(() => runLogPath(dir, '../escape')).toThrow(/run id/);
    expect(() => runLogPath(dir, 'a/b')).toThrow(/run id/);
    expect(() => runLogPath(dir, 'a.')).toThrow(/run id/);
    expect(() => runLogPath(dir, 'a..')).toThrow(/run id/);
    expect(() => runLogPath(dir, 'CON')).toThrow(/run id/);
    expect(() => runLogPath(dir, 'com1')).toThrow(/run id/);
    expect(() => runLogPath(dir, 'NUL.backup')).toThrow(/run id/);
  });
});

describe('createRunLog', () => {
  test('accepts only the <dataDir>/runs/<runId>/run.ndjson shape, never a worktree path', () => {
    const dir = makeTempDir('aik-runlog-');
    const redact = createRedactor().redact;
    expect(() => createRunLog({ path: path.join(dir, 'logs', 'run.ndjson'), redact })).toThrow(/runs/);
    expect(() => createRunLog({ path: path.join(dir, 'wt', 'story-1', 'run.ndjson'), redact })).toThrow(/runs/);
    expect(() => createRunLog({ path: runLogPath(dir, 'run-x').replace(/run\.ndjson$/, 'other.ndjson'), redact })).toThrow(/run\.ndjson/);
  });

  test('single-character run ids are valid (a fresh database has runs 1-9)', async () => {
    const dir = makeTempDir('aik-runlog-');
    expect(runLogPath(dir, 1)).toBe(path.join(dir, 'runs', '1', 'run.ndjson'));
    const { file, log } = makeLog(dir, '7');
    log.appendFrame({ ok: true });
    await log.close();
    expect(readLogLines(file)).toEqual(['{"ok":true}']);
  });
  test('creates the parent directory recursively and writes frames as NDJSON', async () => {
    const dir = makeTempDir('aik-runlog-');
    const { file, log } = makeLog(dir, 'run-1');
    log.appendFrame({ type: 'assistant', text: 'hello' });
    await log.close();
    expect(fs.existsSync(file)).toBe(true);
    expect(readLogLines(file)).toEqual([JSON.stringify({ type: 'assistant', text: 'hello' })]);
  });

  test('redaction reaches every string leaf, in nested objects and arrays', async () => {
    const dir = makeTempDir('aik-runlog-');
    const { redactor, file, log } = makeLog(dir, 'run-2');
    redactor.addSecret('sk-test-SECRET');
    log.appendFrame({ deep: { list: ['sk-test-SECRET', { inner: 'x sk-test-SECRET y' }], n: 5, ok: null } });
    await log.close();
    const lines = readLogLines(file);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({ deep: { list: ['[REDACTED:secret]', { inner: 'x [REDACTED:secret] y' }], n: 5, ok: null } });
  });

  test('a registered secret split across two stdout chunks never appears in the written log file', async () => {
    const dir = makeTempDir('aik-runlog-');
    const { redactor, file, log } = makeLog(dir, 'run-3');
    redactor.addSecret('sk-test-SECRET');
    const decoder = createJsonlDecoder(
      (frame) => log.appendFrame(frame),
      (line) => log.appendDiagnostic(`malformed line: ${line}`),
    );
    const line = `${JSON.stringify({ type: 'tool', output: 'value="sk-test-SECRET" end' })}\n`;
    const bytes = Buffer.from(line, 'utf8');
    // ASCII-only prefix, so the character offset is also the byte offset; cut inside the secret.
    const cut = line.indexOf('sk-test-SEC') + 'sk-te'.length;
    decoder.push(bytes.subarray(0, cut));
    decoder.push(bytes.subarray(cut));
    decoder.end();
    await log.close();
    const content = fs.readFileSync(file, 'utf8');
    expect(content).not.toContain('sk-test-SECRET');
    expect(content).not.toContain('sk-test-SEC');
    const lines = readLogLines(file);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({ type: 'tool', output: 'value="[REDACTED:secret]" end' });
  });

  test('appendDiagnostic writes one redacted, parseable diagnostic line', async () => {
    const dir = makeTempDir('aik-runlog-');
    const { redactor, file, log } = makeLog(dir, 'run-4');
    redactor.addSecret('sk-test-SECRET');
    log.appendDiagnostic('stderr tail: sk-test-SECRET leaked');
    await log.close();
    const lines = readLogLines(file);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({ type: RUN_LOG_DIAGNOSTIC_TYPE, text: 'stderr tail: [REDACTED:secret] leaked' });
    expect(fs.readFileSync(file, 'utf8')).not.toContain('sk-test-SECRET');
  });

  test('malformed decoder lines routed into the log are redacted too', async () => {
    const dir = makeTempDir('aik-runlog-');
    const { redactor, file, log } = makeLog(dir, 'run-5');
    redactor.addSecret('sk-test-SECRET');
    const decoder = createJsonlDecoder((frame) => log.appendFrame(frame), (line) => log.appendDiagnostic(`unparsed: ${line}`));
    decoder.push(Buffer.from('garbage sk-test-SECRET here\n{"ok":1}\n', 'utf8'));
    decoder.end();
    await log.close();
    const content = fs.readFileSync(file, 'utf8');
    expect(content).not.toContain('sk-test-SECRET');
    const lines = readLogLines(file);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ type: RUN_LOG_DIAGNOSTIC_TYPE, text: 'unparsed: garbage [REDACTED:secret] here' });
    expect(JSON.parse(lines[1]!)).toEqual({ ok: 1 });
  });

  test('credential token values are redacted raw and JSON-escaped, and every line still parses', async () => {
    const dir = makeTempDir('aik-runlog-');
    const { file, log } = makeLog(dir, 'run-6');
    const tokens = '{"tokens":{"access_token":"eyJhbGciOiJIUzI1NiJ9.payload.sig","refresh_token":"rt-refreshtoken-1","id_token":"x"}}';
    log.appendFrame({ type: 'tool_result', output: tokens });
    log.appendFrame({ type: 'tool_result', output: `read ${tokens} done` });
    log.appendFrame({ type: 'tool_result', output: 'captured {\\"tokens\\":{\\"access_token\\":\\"eyJaa\\",\\"refresh_token\\":\\"rt-bb\\",\\"id_token\\":\\"x\\"}} end' });
    await log.close();
    const lines = readLogLines(file);
    expect(lines).toHaveLength(3);
    const frames = lines.map((l) => JSON.parse(l) as { output: string });
    expect(frames[0]!.output).toBe('{"tokens":{"access_token":"[REDACTED]","refresh_token":"[REDACTED]","id_token":"[REDACTED]"}}');
    expect(frames[1]!.output).toBe('read {"tokens":{"access_token":"[REDACTED]","refresh_token":"[REDACTED]","id_token":"[REDACTED]"}} done');
    expect(frames[2]!.output).toBe('captured {\\"tokens\\":{\\"access_token\\":\\"[REDACTED]\\",\\"refresh_token\\":\\"[REDACTED]\\",\\"id_token\\":\\"[REDACTED]\\"}} end');
    const content = fs.readFileSync(file, 'utf8');
    expect(content).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(content).not.toContain('rt-refreshtoken-1');
    expect(content).toContain('read {\\"tokens\\":{\\"access_token\\":\\"[REDACTED]\\"'); // escaped quotes kept in the raw bytes
  });

  test('credential-bearing object fields are redacted whole by key, not just as text', async () => {
    const dir = makeTempDir('aik-runlog-');
    const { file, log } = makeLog(dir, 'run-10');
    log.appendFrame({ result: { structured_content: { tokens: { access_token: 'opaque-access-1', refresh_token: 'opaque-refresh-1', id_token: 'opaque-id-1' } } } });
    log.appendFrame({ input: { headers: { Authorization: 'Bearer abc.def.ghi' } } });
    await log.close();
    const lines = readLogLines(file);
    expect(lines).toHaveLength(2);
    const parsed = lines.map((l) => JSON.parse(l) as { result?: unknown; input?: unknown });
    expect(parsed[0]!).toEqual({ result: { structured_content: { tokens: { access_token: '[REDACTED]', refresh_token: '[REDACTED]', id_token: '[REDACTED]' } } } });
    expect(parsed[1]!).toEqual({ input: { headers: { Authorization: '[REDACTED]' } } });
    const content = fs.readFileSync(file, 'utf8');
    expect(content).not.toContain('opaque-access-1');
    expect(content).not.toContain('Bearer abc.def.ghi');
  });

  test('credential keys with prefixes (Proxy-Authorization, client_secret) redact whole values', async () => {
    const dir = makeTempDir('aik-runlog-');
    const { file, log } = makeLog(dir, 'run-12');
    log.appendFrame({ headers: { 'Proxy-Authorization': 'Bearer proxy-secret-1', client_secret: 'shh-client-secret-1' } });
    await log.close();
    const lines = readLogLines(file);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({ headers: { 'Proxy-Authorization': '[REDACTED]', client_secret: '[REDACTED]' } });
    const content = fs.readFileSync(file, 'utf8');
    expect(content).not.toContain('proxy-secret-1');
    expect(content).not.toContain('shh-client-secret-1');
  });

  test('non-string values under credential keys are replaced whole', async () => {
    const dir = makeTempDir('aik-runlog-');
    const { file, log } = makeLog(dir, 'run-13');
    log.appendFrame({ authorization: { token: 'abc' }, password: 123456 });
    await log.close();
    const lines = readLogLines(file);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({ authorization: '[REDACTED]', password: '[REDACTED]' });
  });

  test('non-JSON frame values (BigInt, Buffer) never throw and leave no unredacted string bytes', async () => {
    const dir = makeTempDir('aik-runlog-');
    const { redactor, file, log } = makeLog(dir, 'run-11');
    redactor.addSecret('sk-test-SECRET');
    log.appendFrame({ big: 9007199254740993n, buf: Buffer.from('plain-bytes', 'utf8'), text: 'x sk-test-SECRET y' });
    await log.close();
    const lines = readLogLines(file);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as { big: string; buf: { type: string; data: number[] }; text: string };
    expect(parsed.big).toBe('9007199254740993'); // exact BigInt digits, not a Number-rounded value
    expect(parsed.buf.type).toBe('Buffer');
    expect(parsed.buf.data).toEqual(Array.from(Buffer.from('plain-bytes', 'utf8')));
    expect(parsed.text).toBe('x [REDACTED:secret] y');
    expect(fs.readFileSync(file, 'utf8')).not.toContain('sk-test-SECRET');
  });

  test('a small custom cap writes exactly one overflow diagnostic and drops the rest', async () => {
    const dir = makeTempDir('aik-runlog-');
    const { file, log } = makeLog(dir, 'run-7', 200); // frame (69) + reserved diagnostic (94) fit; a second frame does not
    const frameA = `{"n":"${'a'.repeat(60)}"}`; // 68 bytes + newline = 69
    const frameB = `{"n":"${'b'.repeat(60)}"}`;
    log.appendFrame(JSON.parse(frameA));
    log.appendFrame(JSON.parse(frameB));
    log.appendDiagnostic('dropped-after-overflow');
    await log.close();
    const lines = readLogLines(file);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(frameA);
    expect(JSON.parse(lines[1]!)).toEqual({ type: RUN_LOG_DIAGNOSTIC_TYPE, text: RUN_LOG_TRUNCATED_TEXT });
    expect(Buffer.byteLength(fs.readFileSync(file, 'utf8'), 'utf8')).toBeLessThanOrEqual(200);
  });

  test('the default cap stops the log at 8 MiB with exactly one overflow diagnostic', async () => {
    const dir = makeTempDir('aik-runlog-');
    const { file, log } = makeLog(dir, 'run-8');
    expect(RUN_LOG_MAX_BYTES).toBe(8 * 1024 * 1024);
    const payload = 'z'.repeat(256 * 1024);
    const total = 48; // 48 × ~256 KiB ≈ 12 MiB appended, well past the 8 MiB cap
    for (let seq = 0; seq < total; seq += 1) log.appendFrame({ seq, data: payload });
    log.appendDiagnostic('after-overflow');
    await log.close();
    const content = fs.readFileSync(file, 'utf8');
    const size = Buffer.byteLength(content, 'utf8');
    expect(size).toBeGreaterThan(7 * 1024 * 1024);
    expect(size).toBeLessThanOrEqual(RUN_LOG_MAX_BYTES); // the reserved diagnostic keeps the file inside the cap exactly
    const lines = readLogLines(file);
    const parsed = lines.map((l) => JSON.parse(l) as { type?: string; seq?: number; text?: string });
    const diagnostics = parsed.filter((p) => p.type === RUN_LOG_DIAGNOSTIC_TYPE);
    expect(diagnostics).toEqual([{ type: RUN_LOG_DIAGNOSTIC_TYPE, text: RUN_LOG_TRUNCATED_TEXT }]);
    expect(parsed[parsed.length - 1]).toEqual(diagnostics[0]!); // the diagnostic is the last line
    expect(parsed[parsed.length - 2]!.seq).toBeLessThan(total - 1); // later frames were dropped whole
    expect(content).not.toContain('after-overflow');
    expect(content).not.toContain(`"seq":${total - 1}`);
  });

  test('close() releases the file handle and appends after close do nothing', async () => {
    const dir = makeTempDir('aik-runlog-');
    const { file, log } = makeLog(dir, 'run-9');
    log.appendFrame({ a: 1 });
    await log.close();
    log.appendFrame({ b: 2 });
    log.appendDiagnostic('dropped');
    await log.close();
    expect(readLogLines(file)).toEqual(['{"a":1}']);
    fs.rmSync(dir, { recursive: true, force: true }); // throws EBUSY on Windows if the handle were still open
    expect(fs.existsSync(dir)).toBe(false);
  });

  test('a short write is completed on the next call and the line stays whole', async () => {
    const dir = makeTempDir('aik-runlog-');
    const { file, log } = makeLog(dir, 'run-14', 1000);
    const frame = `{"n":"${'x'.repeat(40)}"}`; // 48 bytes + newline
    const originalWriteSync = fs.writeSync;
    const spy = vi.spyOn(fs, 'writeSync');
    let calls = 0;
    // The spy target is overloaded; the run log always calls the Buffer form (fd, buffer, offset, length).
    spy.mockImplementation(((fd: number, data: Buffer, offset: number, length: number): number => {
      calls += 1;
      const written = calls === 1 ? 10 : length; // first call flushes only 10 bytes
      return originalWriteSync(fd, data, offset, written, null);
    }) as unknown as typeof fs.writeSync);
    try {
      log.appendFrame(JSON.parse(frame));
      await log.close();
    } finally {
      spy.mockRestore();
    }
    expect(calls).toBe(2);
    expect(readLogLines(file)).toEqual([frame]);
    expect(JSON.parse(readLogLines(file)[0]!)).toEqual({ n: 'x'.repeat(40) });
  });

  test('a failing write truncates with one diagnostic, never throws, and every line parses', async () => {
    const dir = makeTempDir('aik-runlog-');
    const { file, log } = makeLog(dir, 'run-15', 1000); // cap high enough that frameB reaches the write itself
    const frameA = `{"n":"${'a'.repeat(60)}"}`; // 68 bytes + newline = 69
    const frameB = `{"n":"${'b'.repeat(60)}"}`;
    const originalWriteSync = fs.writeSync;
    const spy = vi.spyOn(fs, 'writeSync');
    let calls = 0;
    spy.mockImplementation(((fd: number, data: Buffer, offset: number, length: number): number => {
      calls += 1;
      if (calls === 2) throw new Error('EIO: simulated write failure');
      return originalWriteSync(fd, data, offset, length, null);
    }) as unknown as typeof fs.writeSync);
    try {
      log.appendFrame(JSON.parse(frameA));
      expect(() => log.appendFrame(JSON.parse(frameB))).not.toThrow();
      log.appendDiagnostic('dropped'); // already truncated, dropped
      await log.close();
    } finally {
      spy.mockRestore();
    }
    const content = fs.readFileSync(file, 'utf8');
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(1000);
    const lines = readLogLines(file);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(frameA);
    expect(JSON.parse(lines[0]!)).toEqual({ n: 'a'.repeat(60) });
    expect(JSON.parse(lines[1]!)).toEqual({ type: RUN_LOG_DIAGNOSTIC_TYPE, text: RUN_LOG_TRUNCATED_TEXT });
  });

  test('a partly flushed failing line is newline-terminated before the diagnostic', async () => {
    const dir = makeTempDir('aik-runlog-');
    const { file, log } = makeLog(dir, 'run-16', 1000);
    const frameA = `{"n":"${'a'.repeat(40)}"}`; // 48 bytes + newline
    const frameB = `{"n":"${'b'.repeat(40)}"}`;
    const originalWriteSync = fs.writeSync;
    const spy = vi.spyOn(fs, 'writeSync');
    let calls = 0;
    spy.mockImplementation(((fd: number, data: Buffer, offset: number, length: number): number => {
      calls += 1;
      if (calls === 2) return originalWriteSync(fd, data, 0, 10, null); // flush only the first 10 bytes
      if (calls === 3) throw new Error('EIO: simulated write failure');
      return originalWriteSync(fd, data, offset, length, null);
    }) as unknown as typeof fs.writeSync);
    try {
      log.appendFrame(JSON.parse(frameA));
      expect(() => log.appendFrame(JSON.parse(frameB))).not.toThrow();
      await log.close();
    } finally {
      spy.mockRestore();
    }
    const lines = readLogLines(file);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(frameA);
    expect(lines[1]).toBe(frameB.slice(0, 10)); // the partial fragment got its own line
    expect(JSON.parse(lines[2]!)).toEqual({ type: RUN_LOG_DIAGNOSTIC_TYPE, text: RUN_LOG_TRUNCATED_TEXT });
  });
});
