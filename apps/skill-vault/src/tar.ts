// apps/skill-vault/src/tar.ts — hardened, pure-JS tar.gz extractor.
//
// Security properties:
//   * Never executes anything; pure parsing of bytes.
//   * Rejects absolute paths, drive letters, backslashes, ".." traversal and NUL bytes in names.
//   * Rejects symlinks/hardlinks/devices/FIFOs (recorded, never materialized).
//   * Enforces per-file, per-archive and retained-bytes caps (zip-bomb / extraction-bomb guard).
//   * Only retains "interesting" text-like files; binaries are skipped and counted.
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

export type TarLimits = {
  maxFileBytes: number;
  maxArchiveBytes: number;
  maxFiles: number;
  maxRetainedBytes: number;
};

export type ExtractResult = {
  /** Retained files keyed by path relative to the archive's single top-level directory. */
  files: Map<string, Buffer>;
  rootPrefix: string;
  stats: {
    entries: number;
    retainedFiles: number;
    skippedSymlinks: number;
    skippedHardlinks: number;
    skippedSpecial: number;
    skippedBinary: number;
    skippedOversized: number;
  };
  warnings: string[];
};

export class UnsafeArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeArchiveError';
  }
}

const BLOCK = 512;

const STRING = (buf: Buffer, offset: number, length: number): string => {
  const end = buf.indexOf(0, offset);
  return buf.toString('utf8', offset, end === -1 || end > offset + length ? offset + length : end);
};

/** Parse a tar numeric field (octal ASCII, or GNU base-256 for large values). */
const tarNumber = (buf: Buffer, offset: number, length: number): number => {
  if (buf[offset] === 0x80) {
    // GNU base-256: only safe for values that fit in a JS number with the sizes we allow.
    let value = 0;
    for (let i = offset + 1; i < offset + length; i += 1) {
      if (value > Number.MAX_SAFE_INTEGER / 256) throw new UnsafeArchiveError('Archive declares an unsafe size');
      value = value * 256 + buf[i]!;
    }
    return value;
  }
  const text = STRING(buf, offset, length).trim().replace(/\0/g, '');
  if (text.length === 0) return 0;
  if (!/^[0-7]+$/.test(text)) throw new UnsafeArchiveError(`Invalid tar numeric field "${text}"`);
  return Number.parseInt(text, 8);
};

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico', '.tif', '.tiff', '.svgz',
  '.mp4', '.mov', '.avi', '.mkv', '.webm', '.mp3', '.wav', '.flac', '.ogg', '.m4a',
  '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.zst',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.a', '.class', '.jar', '.war', '.pyd', '.wasm',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.img', '.iso', '.dmg', '.msi', '.deb', '.rpm', '.AppImage', '.apk',
]);

const isBinaryPath = (relativePath: string): boolean => {
  const base = relativePath.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot === -1) return false;
  return BINARY_EXTENSIONS.has(base.slice(dot).toLowerCase());
};

export const validateEntryName = (rawName: string): string => {
  if (rawName.includes('\0')) throw new UnsafeArchiveError('Entry name contains a NUL byte');
  if (rawName.includes('\\')) throw new UnsafeArchiveError(`Entry name contains a backslash: ${rawName.slice(0, 80)}`);
  if (/^[a-zA-Z]:/.test(rawName)) throw new UnsafeArchiveError(`Entry name looks like a Windows drive path: ${rawName.slice(0, 80)}`);
  if (rawName.startsWith('/')) throw new UnsafeArchiveError(`Entry name is absolute: ${rawName.slice(0, 80)}`);
  const segments = rawName.split('/');
  if (segments.some((segment) => segment === '..')) throw new UnsafeArchiveError(`Entry name escapes the extraction root: ${rawName.slice(0, 80)}`);
  return rawName;
};

/** Extract a gzipped tar stream with strict safety checks. Throws UnsafeArchiveError on violations. */
export async function extractTarGz(input: Buffer, limits: TarLimits): Promise<ExtractResult> {
  if (input.length > limits.maxArchiveBytes) {
    throw new UnsafeArchiveError(`Archive exceeds max size (${input.length} > ${limits.maxArchiveBytes} bytes)`);
  }
  // Guard against gzip bombs before inflating: inflate incrementally and cap the result.
  const tarBuffer = await gunzipCapped(input, limits.maxRetainedBytes * 4 + 16 * 1024 * 1024);

  const files = new Map<string, Buffer>();
  const stats = {
    entries: 0,
    retainedFiles: 0,
    skippedSymlinks: 0,
    skippedHardlinks: 0,
    skippedSpecial: 0,
    skippedBinary: 0,
    skippedOversized: 0,
  };
  const warnings: string[] = [];
  let rootPrefix: string | undefined;
  let pendingLongName: string | undefined;
  let retainedBytes = 0;
  let offset = 0;

  while (offset + BLOCK <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break; // end-of-archive marker
    offset += BLOCK;
    const rawName = pendingLongName ?? validateEntryName(STRING(header, 0, 100));
    pendingLongName = undefined;
    const prefix = STRING(header, 345, 155);
    const fullName = prefix.length > 0 ? `${prefix}/${rawName}` : rawName;
    const size = tarNumber(header, 124, 12);
    const typeflag = String.fromCharCode(header[156] ?? 0x30);
    const magic = STRING(header, 257, 6);
    if (!magic.startsWith('ustar') && magic.replace(/\0/g, '').length > 0) {
      throw new UnsafeArchiveError('Not a tar archive (bad magic)');
    }
    stats.entries += 1;
    if (stats.entries > limits.maxFiles) throw new UnsafeArchiveError(`Archive exceeds max entry count (${limits.maxFiles})`);
    const dataEnd = offset + Math.ceil(size / BLOCK) * BLOCK;

    if (typeflag === 'L' || typeflag === 'K') {
      // GNU long name / long link name: data is the name for the next entry.
      pendingLongName = validateEntryName(tarBuffer.toString('utf8', offset, offset + size).replace(/\0+$/, ''));
      offset = dataEnd;
      continue;
    }
    if (typeflag === 'x' || typeflag === 'g') {
      // pax extended header: honor path/size overrides for the next entry when present.
      const paxText = tarBuffer.toString('utf8', offset, offset + size);
      const pathRecord = /(?:^|\n)\d+ path=([^\n]+)/.exec(paxText);
      if (pathRecord?.[1]) pendingLongName = validateEntryName(pathRecord[1].trim());
      offset = dataEnd;
      continue;
    }
    if (typeflag === '1') {
      stats.skippedHardlinks += 1;
      warnings.push(`hardlink skipped: ${fullName}`);
      offset = dataEnd;
      continue;
    }
    if (typeflag === '2') {
      stats.skippedSymlinks += 1;
      warnings.push(`symlink skipped: ${fullName}`);
      offset = dataEnd;
      continue;
    }
    if (typeflag === '3' || typeflag === '4' || typeflag === '6') {
      stats.skippedSpecial += 1;
      warnings.push(`special file skipped: ${fullName}`);
      offset = dataEnd;
      continue;
    }
    if (size > limits.maxFileBytes) {
      stats.skippedOversized += 1;
      warnings.push(`oversized file skipped (${size} bytes): ${fullName}`);
      offset = dataEnd;
      continue;
    }

    // Regular file ('0', NUL, or '7').
    const relFromRoot = fullName.replace(/^\.?\//, '');
    const firstSlash = relFromRoot.indexOf('/');
    const prefix0 = firstSlash === -1 ? relFromRoot : relFromRoot.slice(0, firstSlash);
    if (rootPrefix === undefined) {
      rootPrefix = prefix0;
    } else if (prefix0 !== rootPrefix && relFromRoot.length > 0) {
      warnings.push(`entry outside the archive root ignored: ${relFromRoot.slice(0, 80)}`);
      offset = dataEnd;
      continue;
    }
    const relative = relFromRoot.slice(rootPrefix.length).replace(/^\/+/, '');
    if (relative.length > 0 && typeflag !== '5') {
      if (isBinaryPath(relative)) {
        stats.skippedBinary += 1;
      } else {
        const data = tarBuffer.subarray(offset, offset + size);
        if (retainedBytes + size > limits.maxRetainedBytes) {
          throw new UnsafeArchiveError(`Retained extraction size exceeds cap (${limits.maxRetainedBytes} bytes)`);
        }
        files.set(relative, Buffer.from(data));
        retainedBytes += size;
        stats.retainedFiles += 1;
      }
    }
    offset = dataEnd;
  }

  return { files, rootPrefix: rootPrefix ?? '', stats, warnings };
}

/** Gunzip with a hard output cap so compressed bombs fail before exhausting memory. */
async function gunzipCapped(input: Buffer, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let seen = 0;
  const gunzip = createGunzip();
  const source = Readable.from(input);
  await pipeline(
    source,
    gunzip,
    async function collect(chunkSource: AsyncIterable<Buffer>) {
      for await (const chunk of chunkSource) {
        seen += chunk.length;
        if (seen > maxBytes) throw new UnsafeArchiveError(`Inflated archive exceeds cap (${maxBytes} bytes)`);
        chunks.push(Buffer.from(chunk));
      }
    },
  );
  return Buffer.concat(chunks);
}
