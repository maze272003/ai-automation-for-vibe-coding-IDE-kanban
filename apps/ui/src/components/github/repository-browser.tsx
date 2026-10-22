import type {
  GitHubOrgNoticeDTO,
  GitHubRepositoryDTO,
  ListRepositoriesResponse,
  ProjectDTO,
} from '@aik/contracts';
import { Link, useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiRequestError } from '../../lib/api.ts';
import { Badge } from '../ui/badge.tsx';
import { Button } from '../ui/button.tsx';
import { CloneModal } from './clone-modal.tsx';
import { LinkModal } from './link-modal.tsx';

interface RepositoryBrowserProps {
  onProjectCreated?: (project: ProjectDTO) => void;
}

export function RepositoryBrowser({ onProjectCreated }: RepositoryBrowserProps) {
  const navigate = useNavigate();
  const [repos, setRepos] = useState<GitHubRepositoryDTO[]>([]);
  const [notices, setNotices] = useState<GitHubOrgNoticeDTO[]>([]);
  const [rateLimit, setRateLimit] = useState<{ remaining: number; reset: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [search, setSearch] = useState('');
  const [visibilityFilter, setVisibilityFilter] = useState<'all' | 'public' | 'private'>('all');
  const [onlyPush, setOnlyPush] = useState(false);

  // Modals
  const [cloningRepo, setCloningRepo] = useState<GitHubRepositoryDTO | null>(null);
  const [linkingRepo, setLinkingRepo] = useState<GitHubRepositoryDTO | null>(null);

  const fetchRepositories = useCallback(async (force = false) => {
    setError(null);
    if (force) setRefreshing(true);
    else setLoading(true);

    try {
      const endpoint = force ? '/github/repositories/refresh' : '/github/repositories';
      const res = force
        ? await api.post<ListRepositoriesResponse>(endpoint, {})
        : await api.get<ListRepositoriesResponse>(endpoint);

      setRepos(res.repositories);
      setNotices(res.notices ?? []);
      if (res.rateLimit) setRateLimit(res.rateLimit);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.reason : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void fetchRepositories(false);
  }, [fetchRepositories]);

  const filteredRepos = useMemo(() => {
    return repos.filter((r) => {
      if (visibilityFilter !== 'all' && r.visibility !== visibilityFilter) {
        return false;
      }
      if (onlyPush && !r.permissions.push) {
        return false;
      }
      if (search.trim()) {
        const query = search.trim().toLowerCase();
        const matchesName = r.fullName.toLowerCase().includes(query);
        const matchesDesc = r.description ? r.description.toLowerCase().includes(query) : false;
        if (!matchesName && !matchesDesc) return false;
      }
      return true;
    });
  }, [repos, visibilityFilter, onlyPush, search]);

  const handleProjectLinked = (project: ProjectDTO) => {
    onProjectCreated?.(project);
    void fetchRepositories(false);
    void navigate({ to: '/projects/$projectId', params: { projectId: String(project.id) } });
  };

  return (
    <div className="flex flex-col gap-5">
      {/* Notices */}
      {notices.map((n, i) => (
        <div
          key={i}
          className="flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 p-3.5 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200"
        >
          <div>
            <span className="font-semibold">{n.org}: </span>
            {n.type === 'install_needed'
              ? 'GitHub App is not yet installed on this organization.'
              : 'Single Sign-On (SSO) authorization is required.'}
          </div>
          <a
            href={n.url}
            target="_blank"
            rel="noreferrer"
            className="rounded bg-amber-200 px-3 py-1 font-medium text-amber-900 hover:bg-amber-300 dark:bg-amber-800 dark:text-amber-100"
          >
            {n.type === 'install_needed' ? 'Install App' : 'Authorize SSO'} ↗
          </a>
        </div>
      ))}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-1 items-center gap-2 min-w-[280px]">
          <input
            type="search"
            aria-label="Search repositories"
            placeholder="Search repositories…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
          />
        </div>

        <div className="flex items-center gap-2">
          {/* Visibility filter */}
          <div className="flex rounded-md border border-zinc-200 p-0.5 text-xs dark:border-zinc-800">
            {(['all', 'public', 'private'] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setVisibilityFilter(v)}
                className={`rounded px-2.5 py-1 capitalize transition-colors ${
                  visibilityFilter === v
                    ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 font-medium'
                    : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200'
                }`}
              >
                {v}
              </button>
            ))}
          </div>

          {/* Has push access */}
          <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
            <input
              type="checkbox"
              checked={onlyPush}
              onChange={(e) => setOnlyPush(e.target.checked)}
              className="rounded border-zinc-300 text-indigo-600 focus:ring-indigo-500"
            />
            Can push
          </label>

          <Button
            type="button"
            onClick={() => void fetchRepositories(true)}
            disabled={refreshing}
            className="text-xs"
          >
            {refreshing ? 'Syncing…' : '↻ Refresh'}
          </Button>
        </div>
      </div>

      {/* Rate limit status */}
      {rateLimit && (
        <div className="text-right text-xs text-zinc-500">
          GitHub API quota: {rateLimit.remaining} remaining
        </div>
      )}

      {/* Error display */}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      )}

      {/* Repository List */}
      {loading ? (
        <div className="flex justify-center p-12 text-sm text-zinc-500">
          Loading repositories from GitHub…
        </div>
      ) : filteredRepos.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
          {repos.length === 0
            ? 'No repositories found on authorized installations.'
            : 'No repositories match your current filters.'}
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900/40">
          {filteredRepos.map((repo) => (
            <li
              key={repo.id}
              className="flex flex-col gap-2 p-4 transition-colors hover:bg-zinc-50/50 sm:flex-row sm:items-center sm:justify-between dark:hover:bg-zinc-800/30"
            >
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-zinc-900 dark:text-zinc-100">
                    {repo.fullName}
                  </span>
                  <Badge tone={repo.visibility === 'public' ? 'muted' : 'warn'}>
                    {repo.visibility}
                  </Badge>
                  <Badge tone="default">{repo.defaultBranch}</Badge>
                  {repo.permissions.admin && <Badge tone="ok">admin</Badge>}
                  {repo.permissions.push && <Badge tone="default">push</Badge>}
                </div>
                {repo.description && (
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    {repo.description}
                  </p>
                )}
                {repo.localPath && (
                  <p className="text-xs text-zinc-400 font-mono truncate max-w-lg">
                    {repo.localPath}
                  </p>
                )}
              </div>

              <div className="flex items-center gap-2 self-start sm:self-auto">
                {repo.linkedProjectId ? (
                  <Link
                    to="/projects/$projectId"
                    params={{ projectId: String(repo.linkedProjectId) }}
                  >
                    <Button variant="primary" className="text-xs">
                      Open Board →
                    </Button>
                  </Link>
                ) : (
                  <>
                    <Button
                      type="button"
                      variant="primary"
                      onClick={() => setCloningRepo(repo)}
                      className="text-xs"
                    >
                      Clone
                    </Button>
                    <Button
                      type="button"
                      onClick={() => setLinkingRepo(repo)}
                      className="text-xs"
                    >
                      Link Local
                    </Button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Modals */}
      <CloneModal
        open={cloningRepo !== null}
        repo={cloningRepo}
        onClose={() => setCloningRepo(null)}
        onCloned={handleProjectLinked}
      />
      <LinkModal
        open={linkingRepo !== null}
        repo={linkingRepo}
        onClose={() => setLinkingRepo(null)}
        onLinked={handleProjectLinked}
      />
    </div>
  );
}
