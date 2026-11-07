// apps/orchestrator/test/cli-jsonl.test.ts — RED tests for the CLI stdout JSONL decoder (task 6.1a-04, spec §5.3).
import { spawn } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import { createJsonlDecoder, JSONL_OVERSIZE_MARKER, type JsonlDecoder } from '../src/agents/runtimes/jsonl.ts';
import { makeTempDir } from './helpers/temp.ts';

function makeDecoder(): { decoder: JsonlDecoder; frames: unknown[]; malformed: string[] } {
  const frames: unknown[] = [];
  const malformed: string[] = [];
  const decoder = createJsonlDecoder(
    (frame) => frames.push(frame),
    (line) => malformed.push(line),
  );
  return { decoder, frames, malformed };
}

describe('createJsonlDecoder', () => {
  test('decodes frames from chunks split at arbitrary ASCII boundaries', () => {
    const { decoder, frames, malformed } = makeDecoder();
    decoder.push(Buffer.from('{"a":1}\n{"b', 'utf8'));
    decoder.push(Buffer.from('":2}\n', 'utf8'));
    decoder.end();
    expect(frames).toEqual([{ a: 1 }, { b: 2 }]);
    expect(malformed).toEqual([]);
  });

  test('a frame split inside a multi-byte character decodes once and correctly', () => {
    const { decoder, frames, malformed } = makeDecoder();
    const line = `${JSON.stringify({ text: 'héllo 🚀' })}\n`;
    const bytes = Buffer.from(line, 'utf8');
    // Cut between the two bytes of 'é' (U+00E9, UTF-8 0xC3 0xA9).
    const cut = Buffer.byteLength('{"text":"h', 'utf8') + 1;
    expect(bytes.subarray(cut - 1, cut).toString('utf8')).toBe('\uFFFD'); // proves the cut is mid-character
    expect(bytes.subarray(cut - 1, cut + 1).toString('utf8')).toBe('é');
    decoder.push(bytes.subarray(0, cut));
    decoder.push(bytes.subarray(cut));
    decoder.end();
    expect(frames).toEqual([{ text: 'héllo 🚀' }]);
    expect(malformed).toEqual([]);
  });

  test('end() flushes the decoder remainder and a final line without a newline', () => {
    const { decoder, frames, malformed } = makeDecoder();
    const bytes = Buffer.from('{"t":"é"}', 'utf8');
    const cut = Buffer.byteLength('{"t":"', 'utf8') + 1; // between the two bytes of 'é'
    decoder.push(bytes.subarray(0, cut));
    decoder.push(bytes.subarray(cut)); // completes 'é'; the frame has no trailing newline
    decoder.end();
    expect(frames).toEqual([{ t: 'é' }]);
    expect(malformed).toEqual([]);
  });

  test('a frame truncated at end() is reported malformed, never framed', () => {
    const { decoder, frames, malformed } = makeDecoder();
    const bytes = Buffer.from('{"t":"é"}', 'utf8');
    decoder.push(bytes.subarray(0, bytes.length - 2)); // the closing '"}' never arrives
    decoder.end();
    expect(frames).toEqual([]);
    expect(malformed).toEqual(['{"t":"é']);
  });

  test('a dangling multi-byte byte at end() decodes as U+FFFD and the line is malformed', () => {
    const { decoder, frames, malformed } = makeDecoder();
    const bytes = Buffer.from('{"t":"é"}', 'utf8');
    decoder.push(bytes.subarray(0, Buffer.byteLength('{"t":"', 'utf8') + 1)); // first byte of 'é' only
    decoder.end();
    expect(frames).toEqual([]);
    expect(malformed).toEqual(['{"t":"\uFFFD']);
  });

  test('a final line without a newline is flushed on end()', () => {
    const { decoder, frames, malformed } = makeDecoder();
    decoder.push(Buffer.from('{"a":1}\n{"b":"tail"}', 'utf8'));
    decoder.end();
    expect(frames).toEqual([{ a: 1 }, { b: 'tail' }]);
    expect(malformed).toEqual([]);
  });

  test('end() with nothing pending emits nothing; push and end after end() are no-ops', () => {
    const { decoder, frames, malformed } = makeDecoder();
    decoder.push(Buffer.from('{"a":1}\n', 'utf8'));
    decoder.end();
    decoder.push(Buffer.from('{"b":2}\n', 'utf8'));
    decoder.end();
    expect(frames).toEqual([{ a: 1 }]);
    expect(malformed).toEqual([]);
  });

  test('CRLF line endings are tolerated and a trailing \\r is stripped', () => {
    const { decoder, frames, malformed } = makeDecoder();
    decoder.push(Buffer.from('{"a":1}\r\n{"b":2}\r', 'utf8'));
    decoder.end();
    expect(frames).toEqual([{ a: 1 }, { b: 2 }]);
    expect(malformed).toEqual([]);
  });

  test('empty lines are skipped, not reported malformed', () => {
    const { decoder, frames, malformed } = makeDecoder();
    decoder.push(Buffer.from('\n\n{"a":1}\n\r\n\n', 'utf8'));
    decoder.end();
    expect(frames).toEqual([{ a: 1 }]);
    expect(malformed).toEqual([]);
  });

  test('a non-JSON line within the cap is reported with its text and decoding continues', () => {
    const { decoder, frames, malformed } = makeDecoder();
    decoder.push(Buffer.from('not-json\n{"a":1}\n', 'utf8'));
    decoder.end();
    expect(malformed).toEqual(['not-json']);
    expect(frames).toEqual([{ a: 1 }]);
  });

  test('a 2 MiB line yields exactly one fixed malformed marker and the decoder continues', () => {
    const { decoder, frames, malformed } = makeDecoder();
    decoder.push(Buffer.from(`${'x'.repeat(2 * 1024 * 1024)}\n{"ok":true}\n`, 'utf8'));
    decoder.end();
    expect(JSONL_OVERSIZE_MARKER).toBe('[aik:jsonl-line-over-1mib]');
    expect(malformed).toEqual([JSONL_OVERSIZE_MARKER]);
    expect(frames).toEqual([{ ok: true }]);
  });

  test('a line crossing the cap in small chunks yields one marker, then decoding continues after its newline', () => {
    const { decoder, frames, malformed } = makeDecoder();
    const chunk = 'y'.repeat(64 * 1024);
    for (let i = 0; i < 20; i += 1) decoder.push(Buffer.from(chunk, 'utf8'));
    expect(malformed).toEqual([JSONL_OVERSIZE_MARKER]);
    decoder.push(Buffer.from('\n{"after":1}\n', 'utf8'));
    decoder.end();
    expect(frames).toEqual([{ after: 1 }]);
    expect(malformed).toEqual([JSONL_OVERSIZE_MARKER]);
  });

  test('a line over the cap that never ends is reported once and discarded by end()', () => {
    const { decoder, frames, malformed } = makeDecoder();
    decoder.push(Buffer.from('z'.repeat(2 * 1024 * 1024), 'utf8'));
    decoder.end();
    expect(malformed).toEqual([JSONL_OVERSIZE_MARKER]);
    expect(frames).toEqual([]);
  });

  test('the per-line cap counts bytes, not characters', () => {
    const { decoder, frames, malformed } = makeDecoder();
    // 600k 'é' characters are 600k characters but 1.2 MB of UTF-8.
    decoder.push(Buffer.from('é'.repeat(600_000), 'utf8'));
    decoder.push(Buffer.from('\n{"ok":1}\n', 'utf8'));
    decoder.end();
    expect(malformed).toEqual([JSONL_OVERSIZE_MARKER]);
    expect(frames).toEqual([{ ok: 1 }]);
  });
});

describe('createJsonlDecoder against a real process', () => {
  test('stderr bytes are never parsed as frames', async () => {
    const script = [
      'process.stdout.write(\'{"out":1}\\n\');',
      'process.stderr.write(\'{"err":"looks-like-a-frame"}\\n\');',
      'process.stdout.write(\'{"out":2}\\n\');',
    ].join(' ');
    const child = spawn(process.execPath, ['-e', script], { cwd: makeTempDir('aik-jsonl-') });
    const { decoder, frames, malformed } = makeDecoder();
    child.stdout.on('data', (chunk: Buffer) => decoder.push(chunk));
    const stderr: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    const exitCode = await new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
    decoder.end();
    expect(exitCode).toBe(0);
    expect(frames).toEqual([{ out: 1 }, { out: 2 }]);
    expect(malformed).toEqual([]);
    const stderrText = Buffer.concat(stderr).toString('utf8');
    expect(stderrText).toContain('looks-like-a-frame');
    expect(stderrText.includes('"out"')).toBe(false);
  });
});
