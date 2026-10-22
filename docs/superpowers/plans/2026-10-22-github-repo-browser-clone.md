# GitHub Repository Browser, Credential Helper & Clone/Link (`GH-3`, `GH-4`, `GH-5`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement GitHub Repository Browser, Git Credential Helper named pipe IPC, and Clone/Link capabilities for Phase 3 Sub-Project 2 (`GH-3`, `GH-4`, `GH-5`).

**Architecture:**
- Orchestrator `GitCredentialServer` hosts a local named pipe to safely provide tokens to git subprocesses via one-time nonces without exposing credentials in command-lines or git configs.
- `GitHubRepositoryService` fetches authorized installations and repositories, enforces rate limits, parses SSO/org notices, and caches with ETags in SQLite `repository_connections`.
- `GitHubCloneService` performs URL normalization, target folder validation, clone via credential-helper environment, project registration, and audit logging in `remote_sync_runs`.
- UI provides a GitHub Repository Browser tab and dialogs for cloning or linking existing local repositories.

**Tech Stack:** Fastify, Drizzle ORM, better-sqlite3, Zod, Vitest, React, TanStack Router.

**Spec:** `docs/superpowers/specs/2026-10-22-github-repo-browser-clone-design.md`

## Global Constraints
- Exact versions only (`npm install -E`); enforced by `npm run check:pins`.
- Never log or persist secrets. Tokens exist only in `CredentialStore` and named pipe memory, never in SQLite tables or log files.
- Tests must never operate on a real repository or touch real Windows Credential Manager entries.

---

### Task 1: Contracts & URL Normalization (`packages/contracts`)

**Files:**
- Modify: `packages/contracts/src/github.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/test/github.test.ts`

**Interfaces:**
- Produces: `GitHubRepositoryDTO`, `GitHubInstallationDTO`, `GitHubOrgNoticeDTO`, `ListRepositoriesResponse`, `CloneRepositoryRequest`, `LinkRepositoryRequest`, `normalizeGitHubRemoteUrl(url: string): string | null`.

- [x] **Step 1: Write unit tests for repository DTOs and URL normalization**
  - Test valid parsing of `GitHubRepositoryDTO`, `ListRepositoriesResponse`, `CloneRepositoryRequest`, and `LinkRepositoryRequest`.
  - Test `normalizeGitHubRemoteUrl`:
    - `https://github.com/owner/repo.git` -> `owner/repo`
    - `https://github.com/owner/repo` -> `owner/repo`
    - `git@github.com:owner/repo.git` -> `owner/repo`
    - `ssh://git@github.com/owner/repo.git` -> `owner/repo`
    - `https://token@github.com/Owner/Repo.git` -> `owner/repo`
    - Non-github url `https://gitlab.com/owner/repo.git` -> `null`
    - Malformed string -> `null`

- [x] **Step 2: Implement schemas and `normalizeGitHubRemoteUrl` in `packages/contracts`**
  - Add DTO schemas and export helper in `packages/contracts/src/github.ts`.

- [x] **Step 3: Run contract tests**
  - Run `npx vitest run packages/contracts/test/github.test.ts`.

---

### Task 2: Git Credential Helper Server & Git Environment (§13.4, `GH-5`)

**Files:**
- Create: `apps/orchestrator/src/git/credential-helper-bin.cjs`
- Create: `apps/orchestrator/src/git/credential-server.ts`
- Modify: `apps/orchestrator/src/git/git.ts`
- Create: `apps/orchestrator/test/git-credentials.test.ts`

**Interfaces:**
- Consumes: `CredentialStore` from `apps/orchestrator/src/github/credentials.ts`.
- Produces: `GitCredentialServer`, `gitWithCredentials(args, opts)`.

- [x] **Step 1: Write tests for `GitCredentialServer`**
  - Test pipe communication: client connects with valid nonce and `host: 'github.com'` -> receives token and quits.
  - Test nonce reuse prevention: second connection with same nonce fails.
  - Test nonce expiration: connection after 60s (or simulated expiry) fails.
  - Test unauthorized host: connection with `host: 'example.com'` returns error/no credentials.
  - Test agent/check isolation: running git without pipe variables or in check environment receives no credentials.

- [x] **Step 2: Implement `credential-helper-bin.cjs` and `GitCredentialServer`**
  - Create standalone script `apps/orchestrator/src/git/credential-helper-bin.cjs` reading stdin, querying pipe, writing git credential output.
  - Implement `GitCredentialServer` managing named pipe / unix socket, registering short-lived nonces, validating single-use and host.
  - Implement `gitWithCredentials` in `apps/orchestrator/src/git/git.ts` setting `GIT_CONFIG_COUNT=2`, pipe and nonce environment.

- [x] **Step 3: Run git credentials tests**
  - Run `npx vitest run apps/orchestrator/test/git-credentials.test.ts`.

---

### Task 3: GitHub Repository Service & ETag Caching (`GH-3`)

**Files:**
- Create: `apps/orchestrator/src/github/repository-service.ts`
- Modify: `apps/orchestrator/src/api/routes/github.ts`
- Modify: `apps/orchestrator/src/app.ts`
- Create: `apps/orchestrator/test/github-repositories.test.ts`

**Interfaces:**
- Consumes: `GitHubAuthService`, `CredentialStore`, `AikDb`.
- Produces: `GitHubRepositoryService.listRepositories()`, `GET /github/repositories`, `POST /github/repositories/refresh`.

- [x] **Step 1: Write integration tests for repository listing and caching**
  - Test fetching `/user/installations` and `/user/installations/:id/repositories`.
  - Test upserting into `repository_connections` with permissions and visibility.
  - Test 304 response on refresh reusing cached database entries.
  - Test org notice generation when an org has missing installation or requires SSO.
  - Test cross-referencing existing `projects` table by `repository_connection_id` or normalized URL.

- [x] **Step 2: Implement `GitHubRepositoryService` and Fastify routes**
  - Implement pagination for `GET /user/installations/:id/repositories`.
  - Handle rate limits (`x-ratelimit-remaining`, `x-ratelimit-reset`).
  - Wire `GET /github/repositories` and `POST /github/repositories/refresh`.

- [x] **Step 3: Run repository service tests**
  - Run `npx vitest run apps/orchestrator/test/github-repositories.test.ts`.

---

### Task 4: Clone & Link Service (`GH-4`)

**Files:**
- Create: `apps/orchestrator/src/github/clone-service.ts`
- Modify: `apps/orchestrator/src/api/routes/github.ts`
- Create: `apps/orchestrator/test/github-clone.test.ts`

**Interfaces:**
- Consumes: `GitCredentialServer`, `ProjectService`, `GitHubRepositoryService`, `AikDb`.
- Produces: `POST /github/repositories/:id/clone`, `POST /github/repositories/:id/link`.

- [x] **Step 1: Write integration tests for clone and link**
  - Test clone into non-empty directory is rejected with 400.
  - Test clone into empty/new directory creates project, updates `repository_connections.local_path`, and logs `remote_sync_runs`.
  - Test link existing clone validates toplevel and matches normalized remote URL.
  - Test link mismatch fails with 400 and redacted URLs.

- [x] **Step 2: Implement `GitHubCloneService` and register routes**
  - Execute clone via `gitWithCredentials`.
  - Execute link verifying `git remote get-url origin`.
  - Register `POST /github/repositories/:id/clone` and `POST /github/repositories/:id/link`.

- [x] **Step 3: Run clone tests**
  - Run `npx vitest run apps/orchestrator/test/github-clone.test.ts`.

---

### Task 5: UI Repository Browser & Dialogs (`apps/ui`)

**Files:**
- Create: `apps/ui/src/components/github/repository-browser.tsx`
- Create: `apps/ui/src/components/github/clone-modal.tsx`
- Create: `apps/ui/src/components/github/link-modal.tsx`
- Modify: `apps/ui/src/routes/dashboard.tsx`

- [x] **Step 1: Implement UI components**
  - `RepositoryBrowser`: Search field, filter by visibility and push access, list of repos with badges, clone & link actions.
  - `CloneModal`: Target parent directory selector, project name and key inputs, clone progress indicator.
  - `LinkModal`: Local directory selector, remote URL verification notice.
  - Integrate into `DashboardPage` alongside local repository creation.

- [x] **Step 2: Verify UI components build and render cleanly**
  - Run `npm run typecheck` and `npm run lint`.

---

### Task 6: Full Verification Gate

- [x] **Step 1: Run full verification suite**
  - `npm run check:pins`
  - `npm run lint`
  - `npm run typecheck`
  - `npm test`
