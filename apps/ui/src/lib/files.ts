// apps/ui/src/lib/files.ts
import type {
  FileContentDTO,
  FileSearchDTO,
  FileTreeDTO,
  FileWriteDTO,
  FileWriteRequest,
} from '@aik/contracts';
import { MAX_SEARCH_RESULTS } from '@aik/contracts';
import { api } from './api.ts';

export function fileTree(projectId: number, path = ''): Promise<FileTreeDTO> {
  return api.get<FileTreeDTO>(`/projects/${projectId}/files/tree?path=${encodeURIComponent(path)}`);
}

export function fileContent(projectId: number, path: string): Promise<FileContentDTO> {
  return api.get<FileContentDTO>(`/projects/${projectId}/files/content?path=${encodeURIComponent(path)}`);
}

export function searchFiles(
  projectId: number,
  query: string,
  caseSensitive: boolean,
  limit = MAX_SEARCH_RESULTS,
): Promise<FileSearchDTO> {
  const params = new URLSearchParams({
    q: query,
    caseSensitive: String(caseSensitive),
    limit: String(limit),
  });
  return api.get<FileSearchDTO>(`/projects/${projectId}/files/search?${params.toString()}`);
}

export function saveFile(projectId: number, body: FileWriteRequest): Promise<FileWriteDTO> {
  return api.put<FileWriteDTO>(`/projects/${projectId}/files/content`, body);
}

/** Repo paths are always `/`-separated in DTOs; accept pasted Windows separators too. */
export function normalizeRepoPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

export function parentPath(value: string): string {
  const normalized = normalizeRepoPath(value);
  const index = normalized.lastIndexOf('/');
  return index < 0 ? '' : normalized.slice(0, index);
}

export function baseName(value: string): string {
  const normalized = normalizeRepoPath(value);
  const index = normalized.lastIndexOf('/');
  return index < 0 ? normalized : normalized.slice(index + 1);
}

export function joinRepoPath(dir: string, name: string): string {
  const left = normalizeRepoPath(dir);
  const right = normalizeRepoPath(name);
  if (left === '') return right;
  if (right === '') return left;
  return `${left}/${right}`;
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  cs: 'csharp',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ps1: 'powershell',
  bat: 'bat',
  cmd: 'bat',
  yml: 'yaml',
  yaml: 'yaml',
  xml: 'xml',
  sql: 'sql',
  toml: 'ini',
  ini: 'ini',
  php: 'php',
  rb: 'ruby',
  swift: 'swift',
  dockerfile: 'dockerfile',
  txt: 'plaintext',
  log: 'plaintext',
  env: 'plaintext',
};

export function fileExtension(value: string): string {
  const name = baseName(value).toLowerCase();
  if (name === 'dockerfile') return 'dockerfile';
  const index = name.lastIndexOf('.');
  return index <= 0 ? '' : name.slice(index + 1);
}

/** Maps a repository path to a Monaco language id; unknown files stay plain text. */
export function languageForPath(value: string): string {
  return LANGUAGE_BY_EXTENSION[fileExtension(value)] ?? 'plaintext';
}

/** Collapses whitespace for a one-line result row and clips long lines. */
export function searchPreview(value: string, max = 160): string {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** `path:line:column`, the shape used by search result labels. */
export function formatMatchLocation(path: string, line: number, column: number): string {
  return `${path}:${line}:${column}`;
}
