# Instructions for AI agents working in this repository

- Read the spec first: `agent-loop\index.md`; 
- Dependencies use exact versions only (`npm install -E`). `npm run check:pins` enforces this.
- Before claiming a task is done, run: `npm run check:pins && npm run lint && npm run typecheck && npm test`.
- Tests must never operate on a real repository. Use `apps/orchestrator/test/helpers/temp.ts`, which asserts paths are under the OS temp directory.
- Never log or persist secrets. Persisted process/provider output always goes through the redactor.
- Story status changes only through `WorkflowService` — never `UPDATE user_stories SET status` directly. (This rule binds product code; test helpers may force a status for arrange-step setup, as the plan's `forceStory` does on purpose.)
- Code under `spikes/` is throwaway; never import it.

# Mandatory Multiple agent spawn
Use at least 20 specialized sub-agents working in parallel whenever the task scope and environment support it.

Plan before delegating: Break the task into meaningful subtasks. Identify dependencies and which subtasks can run independently.

Assign clear responsibilities: Give each agent a specific objective, relevant context, ownership boundaries, expected deliverables, and acceptance criteria.

Prevent conflicting edits: Assign separate files or components where possible. Coordinate changes to shared files explicitly.

Coordinate actively: The primary agent must track progress, resolve blockers, share relevant findings, and prevent duplicated work.

Respect runtime limits: Never exceed agent or concurrency limits. Use smaller batches when necessary. If 20 agents are impractical, state the constraint and use the largest useful number supported.

Verify and integrate: Review agent outputs, reconcile inconsistencies, integrate changes, and run the required checks before declaring completion.

Report accurately: Summarize completed work, validation results, and unresolved issues. Never claim agents were spawned or checks passed unless confirmed.

Every agent must have a useful responsibility. Do not create redundant assignments merely to meet the agent count.