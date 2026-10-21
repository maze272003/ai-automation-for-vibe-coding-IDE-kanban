# Instructions for AI agents working in this repository

- Read the spec first: `agent-loop\index.md`; 
- Dependencies use exact versions only (`npm install -E`). `npm run check:pins` enforces this.
- Before claiming a task is done, run: `npm run check:pins && npm run lint && npm run typecheck && npm test`.
- Tests must never operate on a real repository. Use `apps/orchestrator/test/helpers/temp.ts`, which asserts paths are under the OS temp directory.
- Never log or persist secrets. Persisted process/provider output always goes through the redactor.
- Story status changes only through `WorkflowService` — never `UPDATE user_stories SET status` directly. (This rule binds product code; test helpers may force a status for arrange-step setup, as the plan's `forceStory` does on purpose.)
- Code under `spikes/` is throwaway; never import it.
