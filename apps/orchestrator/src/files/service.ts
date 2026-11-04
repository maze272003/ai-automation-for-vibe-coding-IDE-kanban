// apps/orchestrator/src/files/service.ts
import {
  type FileContentDTO,
  type FileSearchDTO,
  type FileSearchMatchDTO,
  type FileTreeDTO,
  type FileTreeEntryDTO,
  type FileWriteDTO,
  type FileWriteRequest,
  isRepoRelPath,
  MAX_FILE_BYTES,
  MAX_SEARCH_BYTES,
  MAX_SEARCH_ENTRIES,
  MAX_SEARCH_FILES,
  MAX_SEARCH_FILE_BYTES,
  MAX_SEARCH_RESULTS,
  MAX_TREE_ENTRIES,
  RepoRelPath,
} from '@aik/contracts';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ApiHttpError } from '../api/errors.ts';
import type { ProjectService } from '../projects/service.ts';

type Project = ReturnType<ProjectService['get']>;

const INVALID = (message: string) => new ApiHttpError(400, 'VALIDATION_FAILED', message);
const NOT_FOUND = (message: string) => new ApiHttpError(404, 'NOT_FOUND', message);

/**
 * Directories that are never worth searching and often dominate a checkout. The tree still
 * shows them so the user can browse `dist` or `node_modules` explicitly.
 */
const SEARCH_IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  'target',
  'out',
  '__pycache__',
  '.venv',
  'venv',
  '.cache',
  'vendor',
  '.pnpm',
  '.yarn',
  'Pods',
  '.svelte-kit',
  'obj',
]);

const sha256 = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');

async function sha256File(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(file);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** UTF-16/32 BOMs are readable by other tools but our UTF-8 editor must not rewrite them. */
function hasUnsupportedBom(buffer: Buffer): boolean {
  if (buffer.length >= 4) {
    if (buffer[0] === 0xff && buffer[1] === 0xfe && buffer[2] === 0x00 && buffer[3] === 0x00) return true;
    if (buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0xfe && buffer[3] === 0xff) return true;
  }
  return buffer.length >= 2 && ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff));
}

/** Truncating at a byte cap can split a multi-byte sequence; drop at most three trailing bytes. */
function trimIncompleteUtf8(buffer: Buffer): Buffer {
  let end = buffer.length;
  for (let i = 0; i < 4 && end > 0; i += 1) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, end));
      return buffer.subarray(0, end);
    } catch {
      end -= 1;
    }
  }
  return buffer.subarray(0, Math.max(0, end));
}

/** Returns decoded text, or null when the bytes are not editable UTF-8. */
function decodeText(buffer: Buffer, opts: { allowPartial?: boolean } = {}): string | null {
  if (hasUnsupportedBom(buffer)) return null;
  if (buffer.subarray(0, 8192).includes(0)) return null;
  const candidate = opts.allowPartial ? trimIncompleteUtf8(buffer) : buffer;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(candidate);
  } catch {
    return null;
  }
  // Buffer#toString preserves a UTF-8 BOM, matching what the editor round-trips.
  return candidate.toString('utf8');
}

/** Folds case while retaining a map back to the original UTF-16 offsets. */
function foldCase(value: string): { folded: string; origin: number[] } {
  let folded = '';
  const origin: number[] = [];
  for (let i = 0; i < value.length; ) {
    const codePoint = value.codePointAt(i)!;
    const character = String.fromCodePoint(codePoint);
    const lower = character.toLowerCase();
    folded += lower;
    for (let k = 0; k < lower.length; k += 1) origin.push(i);
    i += character.length;
  }
  return { folded, origin };
}

function previewOf(line: string): string {
  return line.replace(/\s+/g, ' ').trim().slice(0, 300);
}

function compareEntries(a: FileTreeEntryDTO, b: FileTreeEntryDTO): number {
  const rank = (e: FileTreeEntryDTO) => (e.type === 'dir' ? 0 : e.type === 'file' ? 1 : 2);
  const byType = rank(a) - rank(b);
  if (byType !== 0) return byType;
  const byName = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  return byName !== 0 ? byName : a.name.localeCompare(b.name);
}

export interface WorkspaceFileServiceDeps {
  projects: ProjectService;
  busy?: (projectId: number) => string | null;
}

export class WorkspaceFileService {
  private readonly deps: WorkspaceFileServiceDeps;
  private readonly writeLocks = new Map<string, Promise<unknown>>();

  constructor(deps: WorkspaceFileServiceDeps) {
    this.deps = deps;
  }

  /**
   * Serialize writes to one project/path. The optimistic hash check and the rename must be one
   * critical section, otherwise two saves based on the same hash both succeed and one is lost.
   */
  private async serialized<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.writeLocks.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(run);
    this.writeLocks.set(key, current);
    try {
      return await current;
    } finally {
      if (this.writeLocks.get(key) === current) this.writeLocks.delete(key);
    }
  }

  private async open(projectId: number): Promise<{ project: Project; root: string }> {
    const project = this.deps.projects.get(projectId); // 404s when unknown
    let root: string;
    try {
      root = await fs.promises.realpath(project.repoPath);
    } catch {
      throw new ApiHttpError(409, 'NOT_IN_WORKING_TREE', 'Project folder is missing on disk');
    }
    const stat = await fs.promises.stat(root).catch(() => null);
    if (!stat?.isDirectory()) {
      throw new ApiHttpError(409, 'NOT_IN_WORKING_TREE', 'Project folder is not a readable directory');
    }
    return { project, root };
  }

  private normalize(rel: string): string {
    const normalized = rel.replace(/\\/g, '/');
    if (!RepoRelPath.safeParse(normalized).success) throw INVALID(`Unsafe repository path: ${rel}`);
    return normalized;
  }

  /** True when `abs` is the root itself or a descendant (after both are real paths). */
  private contained(root: string, abs: string): boolean {
    const rel = path.relative(root, abs);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
  }

  private samePath(a: string, b: string): boolean {
    return process.platform === 'win32' || process.platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b;
  }

  /**
   * Validate the *resolved* path as well as the request string. This catches Windows 8.3 aliases
   * such as `GIT~1` that expand to `.git` only after `realpath`.
   */
  private checkResolved(root: string, real: string, requested: string): void {
    if (!this.contained(root, real)) throw INVALID(`Path escapes the repository: ${requested}`);
    const rel = path.relative(root, real);
    if (rel !== '' && !isRepoRelPath(rel.split(path.sep).join('/'))) {
      throw INVALID(`Resolved path is not accessible: ${requested}`);
    }
  }

  /**
   * Resolve an existing path while refusing any symlink component. `lstat` on the final
   * component catches the obvious case; comparing realpath with the expected path catches a
   * symlinked parent directory too.
   */
  private async resolveExisting(root: string, rel: string): Promise<{ abs: string; rel: string }> {
    const normalized = this.normalize(rel);
    const abs = path.resolve(root, normalized);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(abs);
    } catch {
      throw NOT_FOUND(`Path not found in repository: ${normalized}`);
    }
    if (stat.isSymbolicLink()) throw INVALID(`Symlinks are not opened: ${normalized}`);
    let real: string;
    try {
      real = await fs.promises.realpath(abs);
    } catch {
      throw NOT_FOUND(`Path not found in repository: ${normalized}`);
    }
    this.checkResolved(root, real, normalized);
    if (!this.samePath(real, abs)) throw INVALID(`Symlinked paths are not opened: ${normalized}`);
    return { abs: real, rel: normalized };
  }

  /** Resolve the parent of a (possibly new) file, refusing symlink components. */
  private async resolveParent(root: string, rel: string): Promise<{ parent: string; base: string; rel: string }> {
    const normalized = this.normalize(rel);
    const parts = normalized.split('/');
    const base = parts.pop()!;
    const parentRel = parts.join('/');
    const expected = path.resolve(root, parentRel);
    let real: string;
    try {
      real = await fs.promises.realpath(expected);
    } catch {
      throw INVALID(`Parent directory does not exist: ${parentRel || '.'}`);
    }
    this.checkResolved(root, real, normalized);
    if (!this.samePath(real, expected)) throw INVALID(`Symlinked paths are not writable: ${normalized}`);
    const stat = await fs.promises.stat(real).catch(() => null);
    if (!stat?.isDirectory()) throw INVALID(`Parent is not a directory: ${parentRel || '.'}`);
    return { parent: real, base, rel: normalized };
  }

  async tree(projectId: number, rel = ''): Promise<FileTreeDTO> {
    const { root } = await this.open(projectId);
    let target = root;
    let dirRel = '';
    if (rel !== '') {
      const resolved = await this.resolveExisting(root, rel);
      const stat = await fs.promises.stat(resolved.abs);
      if (!stat.isDirectory()) throw INVALID(`Not a directory: ${resolved.rel}`);
      target = resolved.abs;
      dirRel = resolved.rel;
    }
    let dirents: fs.Dirent[];
    try {
      dirents = await fs.promises.readdir(target, { withFileTypes: true });
    } catch {
      throw INVALID(`Could not read directory: ${dirRel || '.'}`);
    }
    const candidates: FileTreeEntryDTO[] = [];
    for (const dirent of dirents) {
      if (dirent.name.toLowerCase() === '.git') continue;
      if (dirent.name.startsWith('.aik-') && dirent.name.endsWith('.tmp')) continue;
      const entryRel = dirRel === '' ? dirent.name : `${dirRel}/${dirent.name}`;
      // A name that cannot be represented as a safe repo-relative path is not addressable by
      // the API, so hide it rather than returning a DTO that violates its own contract.
      if (!isRepoRelPath(entryRel)) continue;
      const type = dirent.isSymbolicLink() ? 'symlink' : dirent.isDirectory() ? 'dir' : dirent.isFile() ? 'file' : null;
      if (type === null) continue;
      candidates.push({ name: dirent.name, path: entryRel, type, size: null });
    }
    candidates.sort(compareEntries);
    const entries = candidates.slice(0, MAX_TREE_ENTRIES);
    // Stat only the rows that will actually be returned; a huge directory must not cost one
    // syscall per entry just to report truncation.
    for (const entry of entries) {
      if (entry.type !== 'file') continue;
      const stat = await fs.promises.lstat(path.join(target, entry.name)).catch(() => null);
      if (stat?.isFile()) entry.size = stat.size;
    }
    return {
      projectId,
      path: dirRel,
      entries,
      truncated: candidates.length > MAX_TREE_ENTRIES,
    };
  }

  async read(projectId: number, rel: string): Promise<FileContentDTO> {
    const { root } = await this.open(projectId);
    const resolved = await this.resolveExisting(root, rel);
    const handle = await fs.promises.open(resolved.abs, 'r').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') throw NOT_FOUND(`Path not found in repository: ${resolved.rel}`);
      throw INVALID(`Could not open file: ${resolved.rel}`);
    });
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw INVALID(`Not a file: ${resolved.rel}`);
      const size = stat.size;
      const truncated = size > MAX_FILE_BYTES;
      const length = Math.min(size, MAX_FILE_BYTES);
      const buffer = Buffer.allocUnsafe(length);
      let offset = 0;
      // Read through the validated handle, and never beyond the cap even if the file grows.
      while (offset < length) {
        const { bytesRead } = await handle.read(buffer, offset, length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const bytes = buffer.subarray(0, offset);
      const content = decodeText(bytes, { allowPartial: truncated });
      const binary = content === null;
      return {
        projectId,
        path: resolved.rel,
        content,
        sha256: binary || truncated ? null : sha256(bytes),
        size: truncated ? size : offset,
        binary,
        truncated,
        editable: !binary && !truncated,
      };
    } finally {
      await handle.close();
    }
  }

  async search(
    projectId: number,
    query: string,
    opts: { caseSensitive?: boolean; limit?: number } = {},
  ): Promise<FileSearchDTO> {
    const { root } = await this.open(projectId);
    const q = query.trim();
    if (q === '') throw INVALID('Search query must not be empty');
    if (q.length > 200) throw INVALID('Search query is too long');
    const caseSensitive = opts.caseSensitive ?? false;
    const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? MAX_SEARCH_RESULTS)), MAX_SEARCH_RESULTS);
    const needle = caseSensitive ? q : foldCase(q).folded;
    const matches: FileSearchMatchDTO[] = [];
    let filesScanned = 0;
    let entriesSeen = 0;
    let bytesRead = 0;
    let truncated = false;

    const walk = async (dirRel: string): Promise<void> => {
      if (truncated) return;
      const dir = dirRel === '' ? root : path.join(root, dirRel);
      // Resolve each directory before descending: a checkout can swap it for a junction while
      // the walk is running, and previews must never come from outside the repository.
      const realDir = await fs.promises.realpath(dir).catch(() => null);
      if (!realDir || !this.contained(root, realDir) || !this.samePath(realDir, path.resolve(dir))) return;
      const dirents = await fs.promises.readdir(realDir, { withFileTypes: true }).catch(() => null);
      if (!dirents) return;
      const ordered = [...dirents].sort((a, b) => {
        const ad = a.isDirectory() ? 0 : 1;
        const bd = b.isDirectory() ? 0 : 1;
        if (ad !== bd) return ad - bd;
        const byName = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        return byName !== 0 ? byName : a.name.localeCompare(b.name);
      });
      for (const dirent of ordered) {
        if (truncated) return;
        entriesSeen += 1;
        if (entriesSeen > MAX_SEARCH_ENTRIES) {
          truncated = true;
          return;
        }
        const rel = dirRel === '' ? dirent.name : `${dirRel}/${dirent.name}`;
        if (!isRepoRelPath(rel)) continue;
        if (dirent.isSymbolicLink()) continue;
        if (dirent.isDirectory()) {
          if (SEARCH_IGNORED_DIRS.has(dirent.name.toLowerCase())) continue;
          await walk(rel);
          continue;
        }
        if (!dirent.isFile()) continue;
        if (filesScanned >= MAX_SEARCH_FILES) {
          truncated = true;
          return;
        }
        filesScanned += 1;
        const abs = path.join(realDir, dirent.name);
        const real = await fs.promises.realpath(abs).catch(() => null);
        if (!real || !this.contained(root, real) || !this.samePath(real, abs)) continue;
        const handle = await fs.promises
          .open(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
          .catch(() => null);
        if (!handle) continue;
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > MAX_SEARCH_FILE_BYTES) continue;
          if (bytesRead + stat.size > MAX_SEARCH_BYTES) {
            truncated = true;
            return;
          }
          const buffer = Buffer.allocUnsafe(stat.size);
          let offset = 0;
          while (offset < buffer.length) {
            const { bytesRead: read } = await handle.read(buffer, offset, buffer.length - offset, offset);
            if (read === 0) break;
            offset += read;
          }
          bytesRead += offset;
          const text = decodeText(buffer.subarray(0, offset));
          if (text === null) continue;
          let line = 1;
          let lineStart = 0;
          for (let i = 0; i <= text.length; i += 1) {
            if (i < text.length && text.charCodeAt(i) !== 10) continue;
            let lineEnd = i;
            if (lineEnd > lineStart && text.charCodeAt(lineEnd - 1) === 13) lineEnd -= 1;
            const rawLine = text.slice(lineStart, lineEnd);
            let column = -1;
            if (caseSensitive) {
              column = rawLine.indexOf(q);
            } else {
              const folded = foldCase(rawLine);
              const index = folded.folded.indexOf(needle);
              if (index >= 0) column = folded.origin[index] ?? index;
            }
            if (column >= 0) {
              matches.push({ path: rel, line, column: column + 1, preview: previewOf(rawLine) });
              if (matches.length >= limit) {
                truncated = true;
                return;
              }
            }
            line += 1;
            lineStart = i + 1;
          }
        } finally {
          await handle.close();
        }
      }
    };

    await walk('');
    return { projectId, query: q, caseSensitive, matches, truncated, filesScanned };
  }

  async write(projectId: number, body: FileWriteRequest): Promise<FileWriteDTO> {
    const key = `${projectId}\u0000${body.path.replace(/\\/g, '/')}`;
    return this.serialized(key, () => this.writeLocked(projectId, body));
  }

  private async writeLocked(projectId: number, body: FileWriteRequest): Promise<FileWriteDTO> {
    const { root } = await this.open(projectId);
    const reason = this.deps.busy?.(projectId);
    if (reason) throw new ApiHttpError(409, 'PROJECT_BUSY', reason);
    if (body.content.includes('\u0000')) throw INVALID('Binary content is not editable.');
    const bytes = Buffer.from(body.content, 'utf8');
    if (bytes.byteLength > MAX_FILE_BYTES) {
      throw INVALID(`File is larger than ${MAX_FILE_BYTES} bytes; this editor only saves smaller text files.`);
    }
    const { parent, base, rel } = await this.resolveParent(root, body.path);
    const target = path.join(parent, base);
    if (!this.contained(root, target)) throw INVALID(`Path escapes the repository: ${rel}`);
    let existing: fs.Stats | null = null;
    try {
      existing = await fs.promises.lstat(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw INVALID(`Could not inspect file: ${rel}`);
    }
    if (existing?.isSymbolicLink()) throw INVALID(`Symlinks are not writable: ${rel}`);
    if (existing?.isDirectory()) throw INVALID(`Not a file: ${rel}`);
    if (existing && !existing.isFile()) throw INVALID(`Not a regular file: ${rel}`);
    if (existing) {
      if (body.expectedSha256 === null) {
        throw new ApiHttpError(409, 'FILE_CHANGED', 'The file already exists — reload before saving.');
      }
      const current = await sha256File(target).catch(() => null);
      if (current === null || current !== body.expectedSha256) {
        throw new ApiHttpError(409, 'FILE_CHANGED', 'The file changed on disk — reload before saving.');
      }
    } else if (body.expectedSha256 !== null) {
      throw new ApiHttpError(409, 'FILE_CHANGED', 'The file was deleted on disk — reload before saving.');
    }

    const tmp = path.join(parent, `.aik-${crypto.randomUUID()}.tmp`);
    try {
      const handle = await fs.promises.open(tmp, 'wx', 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (existing && process.platform !== 'win32') {
        await fs.promises.chmod(tmp, existing.mode & 0o777).catch(() => undefined);
      }
      if (existing) {
        // Shrink the window between the hash check and the atomic replace as far as possible.
        const current = await sha256File(target).catch(() => null);
        if (current === null || current !== body.expectedSha256) {
          throw new ApiHttpError(409, 'FILE_CHANGED', 'The file changed on disk — reload before saving.');
        }
        await fs.promises.rename(tmp, target);
      } else {
        try {
          // Hard-link is an atomic create: it fails if another writer created the target meanwhile.
          await fs.promises.link(tmp, target);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new ApiHttpError(409, 'FILE_CHANGED', 'The file was created on disk — reload before saving.');
          }
          await fs.promises.copyFile(tmp, target, fs.constants.COPYFILE_EXCL).catch((copyErr: NodeJS.ErrnoException) => {
            if (copyErr.code === 'EEXIST') {
              throw new ApiHttpError(409, 'FILE_CHANGED', 'The file was created on disk — reload before saving.');
            }
            throw copyErr;
          });
        }
      }
    } catch (err) {
      await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
      if (err instanceof ApiHttpError) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') {
        throw new ApiHttpError(500, 'INTERNAL', `Could not write ${rel}: the file is locked by another process.`, { retryable: true });
      }
      throw INVALID(`Could not write file: ${rel}`);
    }
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
    return { projectId, path: rel, sha256: sha256(bytes), size: bytes.byteLength };
  }
}
