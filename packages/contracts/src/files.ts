// packages/contracts/src/files.ts
import { z } from 'zod';

/** Maximum size of a single file the API will return or accept, in bytes. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Maximum rows in one directory listing. */
export const MAX_TREE_ENTRIES = 1000;
/** Maximum matches returned by one search. */
export const MAX_SEARCH_RESULTS = 500;
/** Maximum files examined by one search. */
export const MAX_SEARCH_FILES = 20_000;
/** Maximum file size examined by search, in bytes. */
export const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
/** Maximum bytes read across one search, bounding slow repositories. */
export const MAX_SEARCH_BYTES = 256 * 1024 * 1024;
/** Maximum directory entries (files and directories) visited by one search. */
export const MAX_SEARCH_ENTRIES = 50_000;

const WINDOWS_RESERVED =
  /^(con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
const WINDOWS_INVALID = /[<>:"|?*]/;
// C0/C1 controls plus bidi overrides, which can spoof how a path renders in the explorer.
function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
    if ((code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) return true;
  }
  return false;
}

/** True when `value` contains a UTF-16 surrogate that is not part of a pair. */
function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Structural validation for a repository-relative path. This intentionally rejects the
 * Windows aliases that could dodge the service's containment checks; the service still
 * performs realpath containment because validation alone can never prove where a path lands.
 */
export function isRepoRelPath(value: string): boolean {
  if (value.length === 0 || value.length > 2000) return false;
  if (hasControlChars(value)) return false;
  const normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('/') || normalized.startsWith('//')) return false;
  if (/^[a-zA-Z]:/.test(normalized)) return false;
  for (const part of normalized.split('/')) {
    if (part === '' || part === '.' || part === '..') return false;
    if (part.toLowerCase() === '.git') return false;
    if (WINDOWS_INVALID.test(part)) return false;
    // Windows strips trailing dots/spaces, so `secret.` can alias `secret`.
    if (/[. ]$/.test(part)) return false;
    if (WINDOWS_RESERVED.test(part)) return false;
  }
  return true;
}

export const RepoRelPath = z.string().max(2000).refine(isRepoRelPath, 'expected a safe repository-relative path');
export type RepoRelPath = z.infer<typeof RepoRelPath>;

export const FileTreeEntryDTO = z.object({
  name: z
    .string()
    .min(1)
    .max(500)
    .refine((value) => !/[/\\]/.test(value) && !hasControlChars(value), 'expected a single path segment'),
  path: RepoRelPath,
  type: z.enum(['file', 'dir', 'symlink']),
  size: z.number().int().nonnegative().nullable(),
});
export type FileTreeEntryDTO = z.infer<typeof FileTreeEntryDTO>;

const TreePath = z.union([z.literal(''), RepoRelPath]);

export const FileTreeDTO = z.object({
  projectId: z.number().int(),
  /** '' for the repository root. */
  path: TreePath,
  entries: z.array(FileTreeEntryDTO).max(MAX_TREE_ENTRIES),
  truncated: z.boolean(),
});
export type FileTreeDTO = z.infer<typeof FileTreeDTO>;

export const FileContentDTO = z.object({
  projectId: z.number().int(),
  path: RepoRelPath,
  /**
   * null for binary reads. Truncated text reads carry a read-only prefix so the editor can
   * show context; `editable` is false and `sha256` is null for those.
   */
  content: z.string().max(MAX_FILE_BYTES).nullable(),
  /** null when no editable buffer hash exists (binary/truncated). */
  sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  size: z.number().int().nonnegative(),
  binary: z.boolean(),
  truncated: z.boolean(),
  editable: z.boolean(),
});
export type FileContentDTO = z.infer<typeof FileContentDTO>;

export const FileWriteRequest = z
  .object({
    path: RepoRelPath,
    content: z
      .string()
      .max(MAX_FILE_BYTES)
      .refine((value) => !value.includes('\u0000'), 'binary content is not editable')
      .refine((value) => !hasLoneSurrogate(value), 'content contains an invalid UTF-16 surrogate')
      .refine((value) => utf8ByteLength(value) <= MAX_FILE_BYTES, `content exceeds ${MAX_FILE_BYTES} UTF-8 bytes`),
    /** null means "create only"; an existing file requires its current hash. */
    expectedSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  })
  .strict();
export type FileWriteRequest = z.infer<typeof FileWriteRequest>;

export const FileWriteDTO = z.object({
  projectId: z.number().int(),
  path: RepoRelPath,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().nonnegative(),
});
export type FileWriteDTO = z.infer<typeof FileWriteDTO>;

export const FileSearchMatchDTO = z.object({
  path: RepoRelPath,
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  preview: z.string().max(400),
});
export type FileSearchMatchDTO = z.infer<typeof FileSearchMatchDTO>;

export const FileSearchDTO = z.object({
  projectId: z.number().int(),
  query: z.string().min(1).max(200),
  caseSensitive: z.boolean(),
  matches: z.array(FileSearchMatchDTO).max(MAX_SEARCH_RESULTS),
  truncated: z.boolean(),
  filesScanned: z.number().int().nonnegative(),
});
export type FileSearchDTO = z.infer<typeof FileSearchDTO>;
