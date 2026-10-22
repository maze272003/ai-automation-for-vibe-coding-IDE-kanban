// apps/ui/src/components/github/pull-request-card.tsx
import { type PullRequestDTO, type StoryDTO } from '@aik/contracts';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiRequestError } from '../../lib/api.ts';
import { Badge } from '../ui/badge.tsx';
import { Button } from '../ui/button.tsx';
import { useToast } from '../ui/toast.tsx';

export interface PullRequestCardProps {
  story: StoryDTO;
  onChanged?: () => Promise<void>;
}

export function PullRequestCard({ story, onChanged }: PullRequestCardProps) {
  const toast = useToast();
  const [pr, setPr] = useState<PullRequestDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [publishing, setPublishing] = useState(false);
  const [polling, setPolling] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideNote, setOverrideNote] = useState('');
  const [overriding, setOverriding] = useState(false);

  const fetchPr = useCallback(async () => {
    try {
      const res = await api.get<PullRequestDTO | null>(`/stories/${story.id}/pr`);
      setPr(res);
    } catch {
      setPr(null);
    } finally {
      setLoading(false);
    }
  }, [story.id]);

  useEffect(() => {
    void fetchPr();
  }, [fetchPr]);

  const handlePublish = async () => {
    if (!story.candidateSha) return;
    setPublishing(true);
    try {
      await api.post(`/stories/${story.id}/transitions`, {
        event: 'approve_publish',
        sha: story.candidateSha,
        expectedVersion: story.statusVersion,
      });
      toast('Publish approved! Generating evidence and publishing to GitHub…', 'info');
      await fetchPr();
      await onChanged?.();
    } catch (err) {
      if (err instanceof ApiRequestError) {
        toast(err.reason, 'error');
      } else {
        toast(String(err), 'error');
      }
    } finally {
      setPublishing(false);
    }
  };

  const handlePoll = async () => {
    setPolling(true);
    try {
      await api.post(`/stories/${story.id}/poll-pr`, {});
      toast('Refreshed PR status from GitHub', 'info');
      await fetchPr();
      await onChanged?.();
    } catch (err) {
      toast(String(err), 'error');
    } finally {
      setPolling(false);
    }
  };

  const handleSyncBase = async () => {
    setSyncing(true);
    try {
      const res = await api.post<{ ok: boolean; baseMoved: boolean; error?: string }>(`/stories/${story.id}/sync-base`, {
        expectedVersion: story.statusVersion,
      });
      if (res.baseMoved) {
        toast('Upstream base moved; story updated and returned to TESTING for reverification', 'info');
        await onChanged?.();
      } else {
        toast('Base branch is already up to date', 'info');
      }
    } catch (err) {
      toast(String(err), 'error');
    } finally {
      setSyncing(false);
    }
  };

  const handleOverrideReview = async () => {
    if (!overrideNote.trim() || !story.candidateSha) return;
    setOverriding(true);
    try {
      await api.post(`/stories/${story.id}/transitions`, {
        event: 'override_remote_review',
        sha: story.candidateSha,
        note: overrideNote.trim(),
        expectedVersion: story.statusVersion,
      });
      toast('Remote review changes overridden', 'info');
      setOverrideOpen(false);
      setOverrideNote('');
      await fetchPr();
      await onChanged?.();
    } catch (err) {
      toast(String(err), 'error');
    } finally {
      setOverriding(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-xs text-zinc-500 font-mono">
        <span className="inline-block animate-spin mr-2">⟳</span> Loading GitHub status…
      </div>
    );
  }

  if (!pr) {
    return (
      <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/40 p-4">
        <div className="flex items-start justify-between">
          <div>
            <h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
              <svg className="h-4 w-4 text-zinc-500" fill="currentColor" viewBox="0 0 16 16">
                <path fillRule="evenodd" d="M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.628a2.251 2.251 0 101.5 0V5A2.5 2.5 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
              </svg>
              GitHub Pull Request
            </h4>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              No pull request has been published for this story yet.
            </p>
          </div>
          {story.status === 'AWAITING_MERGE' && (
            <Button
              type="button"
              onClick={handlePublish}
              disabled={publishing || !story.candidateSha}
              className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium"
            >
              {publishing ? 'Publishing…' : 'Publish Pull Request'}
            </Button>
          )}
        </div>
      </div>
    );
  }

  const checks = pr.checksSummary;
  const reviews = pr.reviewsSummary;
  const isChecksFailing = checks?.conclusion === 'failure';
  const isChangesRequested = reviews?.state === 'CHANGES_REQUESTED';

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 p-4 shadow-sm space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-100 dark:border-zinc-800/80 pb-3">
        <div className="flex items-center gap-2.5">
          <svg className="h-4 w-4 text-zinc-600 dark:text-zinc-400 shrink-0" fill="currentColor" viewBox="0 0 16 16">
            <path fillRule="evenodd" d="M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.628a2.251 2.251 0 101.5 0V5A2.5 2.5 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
          </svg>
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            className="text-sm font-semibold text-indigo-600 dark:text-indigo-400 hover:underline flex items-center gap-1"
          >
            PR #{pr.number} ↗
          </a>
          <Badge tone={pr.state === 'merged' ? 'ok' : pr.state === 'closed' ? 'muted' : 'default'}>
            {pr.state.toUpperCase()}
          </Badge>
          <span className="font-mono text-xs text-zinc-400">
            {pr.headBranch} → {pr.baseBranch}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleSyncBase}
            disabled={syncing}
            className="flex items-center gap-1 rounded border border-zinc-200 dark:border-zinc-700 px-2 py-1 text-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            title="Fetch upstream base branch and sync into candidate"
          >
            <span>{syncing ? 'Syncing…' : 'Sync Base'}</span>
          </button>
          <button
            type="button"
            onClick={handlePoll}
            disabled={polling}
            className="flex items-center gap-1 rounded border border-zinc-200 dark:border-zinc-700 px-2 py-1 text-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            title="Poll PR status, checks, and reviews with ETag caching"
          >
            <span>{polling ? 'Refreshing…' : 'Refresh'}</span>
          </button>
        </div>
      </div>

      {/* Changes Requested Warning */}
      {isChangesRequested && (
        <div className="rounded-md border border-amber-300 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-950/20 p-3">
          <div className="flex items-start justify-between">
            <div>
              <h5 className="text-xs font-semibold text-amber-800 dark:text-amber-300 flex items-center gap-1.5">
                <span>⚠️</span> GitHub Changes Requested
              </h5>
              <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                A reviewer on GitHub requested changes. Merging is disabled until reworked or overridden.
              </p>
            </div>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setOverrideOpen(true)}
              className="text-xs border border-amber-400 text-amber-800 dark:text-amber-200 dark:border-amber-600 hover:bg-amber-100 dark:hover:bg-amber-900/40"
            >
              Override Review
            </Button>
          </div>
        </div>
      )}

      {/* Override Dialog */}
      {overrideOpen && (
        <div className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/80 p-3 space-y-2">
          <h5 className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
            Record Human Override for Remote Review
          </h5>
          <textarea
            value={overrideNote}
            onChange={(e) => setOverrideNote(e.target.value)}
            placeholder="Explain why this review was overridden (e.g. reviewed offline, false positive)..."
            className="w-full rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            rows={2}
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setOverrideOpen(false)} className="text-xs">
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={overriding || !overrideNote.trim()}
              onClick={handleOverrideReview}
              className="text-xs"
            >
              {overriding ? 'Recording…' : 'Confirm Override'}
            </Button>
          </div>
        </div>
      )}

      {/* Grid: Checks & Reviews */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Checks */}
        <div className="rounded border border-zinc-100 dark:border-zinc-800/80 p-3 bg-zinc-50/50 dark:bg-zinc-950/20">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
              CI Checks ({checks?.total ?? 0})
            </span>
            {checks && (
              <Badge tone={isChecksFailing ? 'danger' : checks.conclusion === 'success' ? 'ok' : 'warn'}>
                {checks.conclusion.toUpperCase()}
              </Badge>
            )}
          </div>
          {checks && checks.checks.length > 0 ? (
            <div className="space-y-1.5 max-h-36 overflow-y-auto">
              {checks.checks.map((c, i) => (
                <div key={i} className="flex items-center justify-between text-xs py-0.5 font-mono">
                  <span className="truncate text-zinc-600 dark:text-zinc-400 max-w-[180px]">
                    {c.url ? (
                      <a href={c.url} target="_blank" rel="noreferrer" className="hover:underline">
                        {c.name}
                      </a>
                    ) : (
                      c.name
                    )}
                  </span>
                  <span
                    className={
                      c.conclusion === 'success'
                        ? 'text-emerald-500'
                        : c.conclusion === 'failure'
                        ? 'text-red-500'
                        : 'text-amber-500'
                    }
                  >
                    {c.conclusion ?? c.status}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-zinc-400 italic">No checks reported yet</p>
          )}
        </div>

        {/* Reviews */}
        <div className="rounded border border-zinc-100 dark:border-zinc-800/80 p-3 bg-zinc-50/50 dark:bg-zinc-950/20">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
              Reviews
            </span>
            {reviews && (
              <Badge
                tone={
                  reviews.state === 'APPROVED'
                    ? 'ok'
                    : reviews.state === 'CHANGES_REQUESTED'
                    ? 'danger'
                    : 'muted'
                }
              >
                {reviews.state}
              </Badge>
            )}
          </div>
          {reviews && reviews.reviews.length > 0 ? (
            <div className="space-y-1.5 max-h-36 overflow-y-auto">
              {reviews.reviews.map((r, i) => (
                <div key={i} className="flex items-center justify-between text-xs py-0.5">
                  <span className="font-medium text-zinc-700 dark:text-zinc-300">@{r.user}</span>
                  <span
                    className={
                      r.state === 'APPROVED'
                        ? 'text-emerald-500 font-semibold'
                        : r.state === 'CHANGES_REQUESTED'
                        ? 'text-red-500 font-semibold'
                        : 'text-zinc-400'
                    }
                  >
                    {r.state}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-zinc-400 italic">No GitHub reviews submitted</p>
          )}
        </div>
      </div>
    </div>
  );
}
