// apps/skill-vault/test/tar.test.ts — hardened extraction: paths, symlinks, limits, bombs.
import { expect, describe, it } from 'vitest';
import { extractTarGz, validateEntryName, UnsafeArchiveError, type TarLimits } from '../src/tar.ts';
import { buildTar, gzip } from './helpers/fixtures.ts';

const limits: TarLimits = {
  maxFileBytes: 1024 * 1024,
  maxArchiveBytes: 8 * 1024 * 1024,
  maxFiles: 100,
  maxRetainedBytes: 2 * 1024 * 1024,
};

describe('tar extraction safety', () => {
  it('extracts a normal archive under its root prefix', async () => {
    const tar = gzip(
      buildTar([
        { name: 'repo-abc/' , type: 'dir' },
        { name: 'repo-abc/SKILL.md', data: Buffer.from('---\nname: x\n---\nhi') },
        { name: 'repo-abc/skills/nested/SKILL.md', data: Buffer.from('nested') },
        { name: 'repo-abc/logo.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      ]),
    );
    const result = await extractTarGz(tar, limits);
    expect(result.rootPrefix).toBe('repo-abc');
    expect(result.files.get('SKILL.md')?.toString()).toContain('name: x');
    expect(result.files.has('skills/nested/SKILL.md')).toBe(true);
    expect(result.files.has('logo.png')).toBe(false); // binary skipped
    expect(result.stats.skippedBinary).toBe(1);
  });

  it('rejects path traversal entries', () => {
    expect(() => validateEntryName('../evil')).toThrow(UnsafeArchiveError);
    expect(() => validateEntryName('safe/../../evil')).toThrow(UnsafeArchiveError);
    expect(() => validateEntryName('/absolute')).toThrow(UnsafeArchiveError);
    expect(() => validateEntryName('C:\\Windows\\evil')).toThrow(UnsafeArchiveError);
    expect(() => validateEntryName('back\\slash')).toThrow(UnsafeArchiveError);
    expect(validateEntryName('normal/file.md')).toBe('normal/file.md');
  });

  it('rejects traversal in archive data, never materializing files', async () => {
    const tar = gzip(buildTar([{ name: '../../evil.md', data: Buffer.from('x') }]));
    await expect(extractTarGz(tar, limits)).rejects.toThrow(UnsafeArchiveError);
  });

  it('skips symlinks and hardlinks instead of creating them', async () => {
    const tar = gzip(
      buildTar([
        { name: 'r/', type: 'dir' },
        { name: 'r/SKILL.md', data: Buffer.from('ok') },
        { name: 'r/link', type: 'symlink', linkname: '/etc/passwd' },
        { name: 'r/hard', type: 'hardlink', linkname: 'r/SKILL.md' },
      ]),
    );
    const result = await extractTarGz(tar, limits);
    expect(result.stats.skippedSymlinks).toBe(1);
    expect(result.stats.skippedHardlinks).toBe(1);
    expect(result.files.has('link')).toBe(false);
    expect(result.files.has('hard')).toBe(false);
    expect(result.warnings.some((w: string) => w.includes('symlink'))).toBe(true);
  });

  it('enforces entry-count and retained-size caps', async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ name: `r/f${i}.md`, data: Buffer.from('x'.repeat(100)) }));
    await expect(extractTarGz(gzip(buildTar(many)), limits)).rejects.toThrow(/max entry count/);

    const big = [{ name: 'r/big.md', data: Buffer.from('x'.repeat(1024 * 1024)) }, { name: 'r/big2.md', data: Buffer.from('x'.repeat(1024 * 1024)) }, { name: 'r/big3.md', data: Buffer.from('x'.repeat(100)) }];
    await expect(extractTarGz(gzip(buildTar(big)), limits)).rejects.toThrow(/Retained extraction size/);
  });

  it('defeats gzip bombs via the inflation cap', async () => {
    const bomb = gzip(Buffer.alloc(64 * 1024 * 1024, 0x41)); // 64 MiB of 'A' in a few KiB
    await expect(extractTarGz(bomb, { ...limits, maxArchiveBytes: 1024 * 1024 * 1024 })).rejects.toThrow(UnsafeArchiveError);
  });

  it('honors GNU long names and pax path overrides', async () => {
    const longName = `r/${'a'.repeat(150)}/SKILL.md`;
    const tar = gzip(
      buildTar([
        { name: longName, data: Buffer.from('deep') },
      ]),
    );
    const result = await extractTarGz(tar, limits);
    expect([...result.files.keys()].some((name) => name.endsWith('/SKILL.md'))).toBe(true);
  });
});
