# GitHub Repository Browser, Git Credential Helper & Clone/Link Design (`GH-3`, `GH-4`, `GH-5`)

## 1. Overview & Context

This design implements Sub-Project 2 of Phase 3 GitHub Integration (Milestone B MVP), fulfilling stories:
- **`GH-3`**: Repository browser with installation discovery, ETag caching, search, filter, and error notices (SSO / Org install).
- **`GH-4`**: Repository cloning and existing local clone linking with remote URL normalization and project creation.
- **`GH-5`**: Production Git credential helper integration via local named pipe with one-time nonces and token isolation.

Spec References:
- `docs/superpowers/specs/2026-10-18-autonomous-ai-ide-design.md` §12.2, §12.3, §12.4, §13.4, §15.
- Milestone B (MVP) Acceptance Criteria for `GH-3`, `GH-4`, `GH-5`.

---

## 2. Architecture & Components

```
┌────────────────────────────────────────────────────────┐
│                        UI                              │
│  - Dashboard / Repositories Browser Tab & Modal        │
│  - Search & Filters (name, visibility, push access)    │
│  - Org notices (Install on Org, Authorize SSO)         │
│  - Clone dialog (Parent directory picker)              │
│  - Link existing dialog (Local repo folder picker)     │
└───────────────────────────┬────────────────────────────┘
                            │ HTTP API
┌───────────────────────────▼────────────────────────────┐
│                    Orchestrator                        │
│                                                        │
│  ┌──────────────────────────────────────────────────┐  │
│  │ Fastify Routes:                                  │  │
│  │   GET  /github/repositories                      │  │
│  │   POST /github/repositories/refresh              │  │
│  │   POST /github/repositories/:id/clone            │  │
│  │   POST /github/repositories/:id/link             │  │
│  └──────────────────────────┬───────────────────────┘  │
│                             │                          │
│  ┌──────────────────────────▼───────────────────────┐  │
│  │ GitHubRepositoryService:                         │  │
│  │  - /user/installations & /{id}/repositories      │  │
│  │  - ETag caching in `repository_connections`      │  │
│  │  - Proactive token retrieval from GitHubAuth     │  │
│  │  - Rate-limit & SSO header handling              │  │
│  └──────────────────────────┬───────────────────────┘  │
│                             │                          │
│  ┌──────────────────────────▼───────────────────────┐  │
│  │ GitHubCloneService:                              │  │
│  │  - URL normalization (ssh/https -> owner/repo)   │  │
│  │  - Target non-empty verification                 │  │
│  │  - Spawns `git clone` via GitCredentialServer    │  │
│  │  - Project creation & `remote_sync_runs` audit   │  │
│  └──────────────────────────┬───────────────────────┘  │
│                             │                          │
│  ┌──────────────────────────▼───────────────────────┐  │
│  │ GitCredentialServer (§13.4):                     │  │
│  │  - Named pipe: \\.\pipe\aikanban-cred-<random>   │  │
│  │  - 60s TTL, single-use one-time nonce            │  │
│  │  - Validates host === 'github.com'               │  │
│  │  - Returns username=x-access-token & password    │  │
│  │  - Zero token exposure in git args / config      │  │
│  └──────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────┘
```

---

## 3. Data Contracts (`packages/contracts`)

### 3.1 DTOs
```ts
export const GitHubRepositoryDTO = z.object({
  id: z.number(),
  githubRepoId: z.number(),
  owner: z.string(),
  name: z.string(),
  fullName: z.string(),
  description: z.string().nullable(),
  defaultBranch: z.string(),
  visibility: z.enum(['public', 'private', 'internal']),
  permissions: z.object({
    admin: z.boolean(),
    push: z.boolean(),
    pull: z.boolean(),
  }),
  installationId: z.number().nullable(),
  localPath: z.string().nullable(),
  linkedProjectId: z.number().nullable(),
  lastSyncedAt: z.number().nullable(),
});

export const GitHubInstallationDTO = z.object({
  id: z.number(),
  account: z.object({
    login: z.string(),
    type: z.enum(['User', 'Organization']),
    avatarUrl: z.string().optional(),
  }),
  htmlUrl: z.string(),
});

export const GitHubOrgNoticeDTO = z.object({
  org: z.string(),
  type: z.enum(['install_needed', 'sso_needed']),
  url: z.string(),
});

export const ListRepositoriesResponse = z.object({
  repositories: z.array(GitHubRepositoryDTO),
  installations: z.array(GitHubInstallationDTO),
  notices: z.array(GitHubOrgNoticeDTO),
  rateLimit: z.object({
    remaining: z.number(),
    reset: z.number(),
  }).optional(),
});

export const CloneRepositoryRequest = z.object({
  parentDirectory: z.string().min(1),
  projectKey: z.string().regex(/^[A-Z0-9]{2,10}$/).optional(),
  projectName: z.string().min(1).optional(),
});

export const LinkRepositoryRequest = z.object({
  localPath: z.string().min(1),
  projectKey: z.string().regex(/^[A-Z0-9]{2,10}$/).optional(),
  projectName: z.string().min(1).optional(),
});
```

### 3.2 URL Normalization Utility
```ts
export function normalizeGitHubRemoteUrl(url: string): string | null {
  // Handles:
  // https://github.com/owner/repo.git
  // https://token@github.com/owner/repo
  // git@github.com:owner/repo.git
  // ssh://git@github.com/owner/repo.git
  // Returns lowercase "owner/repo"
}
```

---

## 4. Git Credential Helper Server (§13.4)

### 4.1 Named Pipe Server & Nonce Flow
1. **Creation**:
   - On Windows, creates `\\.\pipe\aikanban-cred-${crypto.randomBytes(8).toString('hex')}`.
   - On non-Windows / test environments, creates a domain socket under OS temp directory.
2. **Nonce**:
   - Generated with `crypto.randomBytes(16).toString('hex')`.
   - Expires in 60 seconds (`TTL = 60_000ms`).
   - Single-use: once consumed for a request, it is marked `used` and cannot be replayed.
3. **Helper Protocol**:
   - Git runs helper script: `node <path>/git-credential-helper.cjs get`.
   - Helper reads git's key-value query on stdin (`protocol=https\nhost=github.com\n\n`).
   - Helper connects to pipe and sends `{ nonce, host }`.
   - Server validates:
     - Nonce exists, is not expired, and `!used`.
     - `host === 'github.com'`.
   - If valid, server marks nonce `used` and replies:
     `{ password: <access_token>, expires_in: ... }`
   - Helper writes:
     ```
     username=x-access-token
     password=<token>
     quit=1
     ```
4. **Zero Leakage Assurance**:
   - `git clone` arguments only contain `https://github.com/owner/repo.git`.
   - `git-config` overrides disable global GCM (`credential.helper=`).
   - No token appears in process args, `.git/config`, or environment variables outside the named pipe IPC.

---

## 5. Repository Browser & Clone Services

### 5.1 Caching & ETags
- Repositories fetched via GitHub API are cached in SQLite `repository_connections`.
- If cache timestamp is `< 10 minutes` old and manual refresh is false, return cached records.
- When requesting `/user/installations` and `/user/installations/{id}/repositories`, send `If-None-Match` header using stored ETag.
- If `304 Not Modified`, reuse cached records without burning API rate limit budget.

### 5.2 Clone & Link Operations
- **Clone**:
  - Validates `parentDirectory/<repo-name>` does not exist or is empty.
  - Spawns `git clone` with `gitWithCredentials`.
  - Records `remote_sync_runs` row with `kind: 'clone'`.
  - Creates project in `projects` table linked to `repository_connection_id`.
  - Updates `repository_connections.local_path`.
- **Link**:
  - Validates `localPath` exists and `git rev-parse --show-toplevel` succeeds.
  - Compares `remote.origin.url` to repo URL using `normalizeGitHubRemoteUrl`.
  - If mismatch, throws 400 with redacted URLs.
  - Links project and updates `repository_connections.local_path`.

---

## 6. Testing Strategy
- Unit tests for `normalizeGitHubRemoteUrl` covering diverse HTTPS/SSH variants.
- Unit/integration tests for `GitCredentialServer`:
  - Valid nonce and `github.com` host returns credential.
  - Expired nonce returns failure.
  - Reused nonce returns failure.
  - Wrong host returns failure.
  - Agent / check environment produces zero credentials.
- Integration tests for `GitHubRepositoryService`:
  - Installation listing & repository paging.
  - ETag 304 cache reuse.
  - SSO / org notice surfacing.
- Integration tests for Clone & Link:
  - Clone using local bare git repo / mock HTTP backend.
  - Non-empty folder rejection.
  - Remote mismatch rejection with redacted URLs.
- UI tests / visual checks for Repository browser, clone, and link flows.
