// apps/ui/test/files-api.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock('../src/lib/api.ts', () => ({ api: mocks }));

import { fileContent, fileTree, searchFiles, saveFile } from '../src/lib/files.ts';

beforeEach(() => {
  mocks.get.mockReset();
  mocks.put.mockReset();
  mocks.get.mockResolvedValue({});
  mocks.put.mockResolvedValue({});
});

describe('file API client', () => {
  it('encodes repo paths exactly once', async () => {
    await fileTree(7, 'src/a b#c%.ts');
    expect(mocks.get).toHaveBeenCalledWith('/projects/7/files/tree?path=src%2Fa%20b%23c%25.ts');
    await fileContent(7, 'src/a b#c%.ts');
    expect(mocks.get).toHaveBeenLastCalledWith('/projects/7/files/content?path=src%2Fa%20b%23c%25.ts');
  });

  it('serializes literal search queries, including glob characters', async () => {
    await searchFiles(7, '*.ts', false);
    expect(mocks.get).toHaveBeenCalledWith('/projects/7/files/search?q=*.ts&caseSensitive=false&limit=500');
    await searchFiles(7, 'Needle', true, 10);
    expect(mocks.get).toHaveBeenLastCalledWith('/projects/7/files/search?q=Needle&caseSensitive=true&limit=10');
  });

  it('PUTs a save request to the content endpoint', async () => {
    const body = { path: 'a.txt', content: 'x', expectedSha256: null };
    await saveFile(7, body);
    expect(mocks.put).toHaveBeenCalledWith('/projects/7/files/content', body);
  });
});
