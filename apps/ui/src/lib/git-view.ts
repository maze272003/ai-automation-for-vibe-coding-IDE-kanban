// apps/ui/src/lib/git-view.ts
import type {
  BranchListDTO, CommitFilesDTO, CommitLogDTO, GitBranchCheckoutRequest, GitBranchCreateRequest, GitCommitRequest,
  GitDiscardRequest, GitStageRequest, GitStatusDTO,
} from '@aik/contracts';
import { useEffect, useState } from 'react';
import { api } from './api.ts';

const POLL_MS = 5_000;

/** Status + 5 s poll while the tab is visible; refetch() after every mutation. */
export function useGitStatus(projectId: number) {
  const [status, setStatus] = useState<GitStatusDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = async () => {
    try {
      setStatus(await api.get<GitStatusDTO>(`/projects/${projectId}/git/status`));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  useEffect(() => {
    void refetch();
    const t = setInterval(() => {
      if (!document.hidden) void refetch();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [projectId]);
  return { status, error, refetch };
}

export function useBranches(projectId: number) {
  const [branches, setBranches] = useState<BranchListDTO | null>(null);
  const refetch = async () => setBranches(await api.get<BranchListDTO>(`/projects/${projectId}/git/branches`));
  useEffect(() => {
    void refetch();
  }, [projectId]);
  return { branches, refetch: refetch };
}

export function useGitLog(projectId: number) {
  const [log, setLog] = useState<CommitLogDTO | null>(null);
  const load = async () => setLog(await api.get<CommitLogDTO>(`/projects/${projectId}/git/log?limit=50`));
  useEffect(() => {
    void load();
  }, [projectId]);
  return { log, openFiles: async (sha: string) => api.get<CommitFilesDTO>(`/projects/${projectId}/git/commits/${sha}/files`) };
}

/** Every action returns a fresh GitStatusDTO so the panel redraws from one source. */
export const gitActions = {
  stage: (projectId: number, body: GitStageRequest) => api.post<GitStatusDTO>(`/projects/${projectId}/git/stage`, body),
  unstage: (projectId: number, body: GitStageRequest) => api.post<GitStatusDTO>(`/projects/${projectId}/git/unstage`, body),
  commit: (projectId: number, body: GitCommitRequest) => api.post<GitStatusDTO>(`/projects/${projectId}/git/commit`, body),
  discard: (projectId: number, body: GitDiscardRequest) => api.post<GitStatusDTO>(`/projects/${projectId}/git/discard`, body),
  push: (projectId: number) => api.post<GitStatusDTO>(`/projects/${projectId}/git/push`, {}),
  pull: (projectId: number) => api.post<GitStatusDTO>(`/projects/${projectId}/git/pull`, {}),
  checkout: (projectId: number, body: GitBranchCheckoutRequest) => api.post<GitStatusDTO>(`/projects/${projectId}/git/branches/checkout`, body),
  createBranch: (projectId: number, body: GitBranchCreateRequest) => api.post<GitStatusDTO>(`/projects/${projectId}/git/branches/create`, body),
};
