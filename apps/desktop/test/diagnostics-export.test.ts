import { mkdtemp, readFile, rm, writeFile as fsWriteFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportDiagnostics } from '../src/main/diagnostics-export.ts';

const createdDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'aik-diagnostics-export-'));
  createdDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const fixedNow = () => new Date('2026-11-05T12:34:56.789Z');
const archive = { version: '1.2.3', diagnostics: { platform: 'win32', logs: [{ name: 'orchestrator.log' }] } };

describe('exportDiagnostics', () => {
  it('saves the archive as pretty-printed JSON at the chosen path', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'aik-diagnostics.json');
    let suggested = '';
    const writeFile = vi.fn(async (target: string, data: string) => {
      await fsWriteFile(target, data, 'utf8');
    });

    const result = await exportDiagnostics({
      fetchArchive: async () => archive,
      choosePath: async (defaultName) => {
        suggested = defaultName;
        return file;
      },
      writeFile,
      now: fixedNow,
    });

    expect(result).toEqual({ ok: true, path: file });
    expect(suggested).toBe('aik-diagnostics-2026-11-05T12-34-56-789Z.json');
    expect(writeFile).toHaveBeenCalledOnce();
    const content = await readFile(file, 'utf8');
    expect(content).toBe(JSON.stringify(archive, null, 2));
    expect(content).toContain('\n  "version": "1.2.3"');
    expect(JSON.parse(content)).toEqual(archive);
  });

  it('suggests a portable timestamped filename', async () => {
    const names: string[] = [];
    const result = await exportDiagnostics({
      fetchArchive: async () => archive,
      choosePath: async (defaultName) => {
        names.push(defaultName);
        return null;
      },
      writeFile: async () => undefined,
      now: () => new Date('2026-01-02T03:04:05.006Z'),
    });

    expect(result).toEqual({ ok: false, reason: 'cancelled' });
    expect(names).toEqual(['aik-diagnostics-2026-01-02T03-04-05-006Z.json']);
    expect(names[0]!.slice(0, -'.json'.length)).not.toMatch(/[:.]/);
  });

  it('reports cancellation without writing a file', async () => {
    const writeFile = vi.fn(async () => undefined);
    const result = await exportDiagnostics({
      fetchArchive: async () => archive,
      choosePath: async () => null,
      writeFile,
    });

    expect(result).toEqual({ ok: false, reason: 'cancelled' });
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('maps a fetch failure to a fixed reason without opening the dialog', async () => {
    const choosePath = vi.fn(async () => 'never-used.json');
    const result = await exportDiagnostics({
      fetchArchive: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:1234 secret-token');
      },
      choosePath,
      writeFile: async () => undefined,
    });

    expect(result).toEqual({ ok: false, reason: 'orchestrator unavailable' });
    expect(choosePath).not.toHaveBeenCalled();
  });

  it('rejects an undefined or non-object archive before asking for a path', async () => {
    for (const value of [undefined, null, 'archive', 42, ['not-an-archive']]) {
      const choosePath = vi.fn(async () => 'never-used.json');
      const result = await exportDiagnostics({
        fetchArchive: async () => value,
        choosePath,
        writeFile: async () => undefined,
      });

      expect(result, String(value)).toEqual({ ok: false, reason: 'export failed' });
      expect(choosePath).not.toHaveBeenCalled();
    }
  });

  it('maps a write failure to a fixed reason', async () => {
    const result = await exportDiagnostics({
      fetchArchive: async () => archive,
      choosePath: async () => path.join(tmpdir(), 'aik-diagnostics-export-unwritable.json'),
      writeFile: async () => {
        throw new Error('EACCES: permission denied');
      },
    });

    expect(result).toEqual({ ok: false, reason: 'write failed' });
  });
});
