// apps/skill-vault/src/util.ts — small shared helpers (no external deps).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const sha256Hex = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

export const sha256File = async (filePath: string): Promise<string> => {
  const handle = await fsp.open(filePath, 'r');
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
};

/** Write a file atomically (tmp + rename) so readers never see partial content. */
export async function writeFileAtomic(filePath: string, data: string | Buffer): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, filePath);
}

/** Append one JSON line to an append-only JSONL file, creating parents. */
export async function appendJsonl(filePath: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.appendFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

/** Stream a JSONL file line by line without loading it into memory. */
export async function* readJsonl(filePath: string): AsyncGenerator<string> {
  const handle = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    let carry = '';
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      carry += buffer.toString('utf8', 0, bytesRead);
      const lines = carry.split('\n');
      carry = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length > 0) yield trimmed;
      }
    }
    if (carry.trim().length > 0) yield carry.trim();
  } finally {
    await handle.close();
  }
}

const csvCell = (value: unknown): string => {
  const text =
    value === null || value === undefined
      ? ''
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
};

/** Escape one CSV row (RFC 4180). */
export const csvRow = (cells: unknown[]): string => cells.map(csvCell).join(',');

/** Normalize a filesystem path fragment for use in ids and directory slugs. */
export const pathSlug = (p: string): string =>
  p
    .replaceAll('\\', '/')
    .split('/')
    .filter((part) => part.length > 0 && part !== '.' && part !== '..')
    .map((part) => part.replace(/[^a-zA-Z0-9._-]+/g, '-'))
    .join('__');

/** True when `child` is equal to or inside `parent` (both absolute). */
export const isInside = (parent: string, child: string): boolean => {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

export async function dirSizeBytes(dir: string): Promise<number> {
  let total = 0;
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSizeBytes(full);
    else if (entry.isFile()) total += (await fsp.stat(full)).size;
  }
  return total;
}

export async function removeDir(dir: string): Promise<void> {
  await fsp.rm(dir, { recursive: true, force: true });
}

export async function moveDir(from: string, to: string): Promise<void> {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.rename(from, to);
}

export const ensureDir = async (dir: string): Promise<string> => {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
};

export const fileExists = (filePath: string): Promise<boolean> =>
  fsp
    .stat(filePath)
    .then((s) => s.isFile())
    .catch(() => false);

export const readJsonIfExists = async <T>(filePath: string): Promise<T | undefined> => {
  if (!(await fileExists(filePath))) return undefined;
  return JSON.parse(await fsp.readFile(filePath, 'utf8')) as T;
};

export const nowIso = (): string => new Date().toISOString();

/** Recursive copy that preserves file modes (needed for skill installs). */
export async function copyDir(from: string, to: string): Promise<void> {
  await fsp.mkdir(to, { recursive: true });
  const entries = await fsp.readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) await copyDir(src, dest);
    else if (entry.isFile()) await fsp.copyFile(src, dest);
    // Symlinks are deliberately not followed or copied by the vault.
  }
}

export const fsSync = fs;
