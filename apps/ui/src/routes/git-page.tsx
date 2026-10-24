// apps/ui/src/routes/git-page.tsx
import type { ProjectDTO } from '@aik/contracts';
import { Link, useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { HistoryColumn } from '../components/git/history-column.tsx';
import { ScmPanel } from '../components/git/scm-panel.tsx';
import { TopBar } from '../components/shell/top-bar.tsx';
import { Button } from '../components/ui/button.tsx';
import { Dialog } from '../components/ui/dialog.tsx';
import { ApiRequestError, api } from '../lib/api.ts';
import { gitActions, useBranches, useGitLog, useGitStatus } from '../lib/git-view.ts';

export function GitPage() {
  const params = useParams({ strict: false }) as { projectId?: string };
  const id = Number(params.projectId);
  const [project, setProject] = useState<ProjectDTO | null>(null);
  const { status, error, refetch } = useGitStatus(id);
  const { branches, refetch: refetchBranches } = useBranches(id);
  const { log, openFiles } = useGitLog(id);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState<string | null>(null);
  const [switchTo, setSwitchTo] = useState<string | null>(null);

  useEffect(() => {
    void api.get<ProjectDTO>(`/projects/${id}`).then(setProject, () => setProject(null));
  }, [id]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      await Promise.all([refetch(), refetchBranches()]);
    } catch (err) {
      setActionError(err instanceof ApiRequestError ? err.reason : String(err));
    } finally {
      setBusy(false);
    }
  };

  const confirmDiscard = () => {
    const p = discarding;
    setDiscarding(null);
    if (p) void run(() => gitActions.discard(id, { paths: [p] }));
  };

  return (
    <div className="flex h-full flex-col">
      <TopBar data-testid="git-toolbar" title={project ? `${project.key} · ${project.name}` : 'Git'}>
        <div data-testid="project-tabs" className="inline-flex items-center gap-1 rounded-control border border-glass-border bg-surface-2/60 p-1">
          <Link to="/projects/$projectId" params={{ projectId: String(id) }} className="rounded-control px-2.5 py-1 text-xs font-semibold text-muted hover:text-foreground">Board</Link>
          <span aria-current="page" data-testid="tab-git" className="rounded-control bg-accent-soft px-2.5 py-1 text-xs font-semibold text-accent-soft-foreground">Git</span>
        </div>
        <Link to="/" className="ml-2 text-sm font-semibold text-muted hover:text-foreground">← Projects</Link>
      </TopBar>
      {(error ?? actionError) && (
        <p role="alert" data-testid="git-status-error" className="px-4 py-2 text-sm text-danger-foreground">{error ?? actionError}</p>
      )}
      {status === null ? (
        <p className="p-4 text-sm text-muted">Loading repository status…</p>
      ) : (
        <div className="flex min-h-0 flex-1">
          <ScmPanel
            status={status}
            branches={{ local: branches?.local ?? [], remote: branches?.remote ?? [] }}
            busy={busy}
            syncBusy={false}
            onStage={(paths) => run(() => gitActions.stage(id, paths ? { paths } : { all: true }))}
            onUnstage={(paths) => run(() => gitActions.unstage(id, paths ? { paths } : { all: true }))}
            onCommit={async (message) => {
              setActionError(null);
              try {
                await gitActions.commit(id, { message });
                await Promise.all([refetch(), refetchBranches()]);
              } catch (err) {
                setActionError(err instanceof ApiRequestError ? err.reason : String(err));
                throw err; // SCP commit keeps the typed message when this rejects.
              }
            }}
            onDiscard={(p) => setDiscarding(p)}
            onCheckout={async (name) => { const dirty = status.staged.length + status.changes.length > 0; if (dirty) setSwitchTo(name); else await run(() => gitActions.checkout(id, { name })); }}
            onCreate={(name) => run(() => gitActions.createBranch(id, { name }))}
            onPush={() => run(() => gitActions.push(id))}
            onPull={() => run(() => gitActions.pull(id))}
          />
          <HistoryColumn log={log} openFiles={openFiles} />
        </div>
      )}
      <Dialog open={discarding !== null} title="Discard changes?" onClose={() => setDiscarding(null)}>
        <p className="text-sm text-muted">
          Discarding <span className="font-mono">{discarding}</span> restores the file from the last commit. If it is an untracked file it will be deleted permanently.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={() => setDiscarding(null)}>Keep changes</Button>
          <Button variant="danger" data-testid="git-discard-confirm" onClick={confirmDiscard}>Discard</Button>
        </div>
      </Dialog>
      <Dialog open={switchTo !== null} title="Switch with uncommitted changes?" onClose={() => setSwitchTo(null)}>
        <p className="text-sm text-muted">
          There are uncommitted changes. AI Kanban refuses to switch with a dirty tree (or to stash without asking). Stage or discard your changes first, or switch from the terminal.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={() => setSwitchTo(null)}>Back</Button>
        </div>
      </Dialog>
    </div>
  );
}
