# GitHub Authentication & Device Flow (`GH-1`, `GH-2`, `GH-10`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Phase 3 GitHub connection via GitHub App Device Flow: guided setup checklist, public Client ID configuration, device code exchange, secure Windows Credential Manager token storage, proactive token refresh, and error/disconnect handling.

**Architecture:**
- Orchestrator `GitHubAuthService` coordinates device-flow authentication and token refresh with GitHub's OAuth API.
- Tokens (access token & refresh token) are persisted strictly in `CredentialStore` (using `@napi-rs/keyring` in production, memory store in tests).
- Metadata is tracked in SQLite (`app_settings` for Client ID, `github_connections` for `@login` and token expiration).
- UI provides a guided setup wizard on the Settings page with device code verification.

**Tech Stack:** Fastify, Drizzle ORM, better-sqlite3, Zod, Vitest, React, TanStack Router.

**Spec:** `docs/superpowers/specs/2026-10-22-github-auth-device-flow-design.md`

## Global Constraints
- Exact versions only (`npm install -E`); enforced by `npm run check:pins`.
- Never log or persist secrets. Tokens exist only in `CredentialStore`, never in SQLite tables or log files.
- Tests must never operate on a real repository or touch real Windows Credential Manager entries.

---

### Task 1: Contracts & Validation Schemas (`packages/contracts`)

**Files:**
- Create: `packages/contracts/src/github.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/test/github.test.ts`

- [x] **Step 1: Write unit tests for GitHub contracts**
  - Verify `GitHubClientIdSchema` validates alphanumeric format (e.g., `Iv1.1234567890abcdef`, `Iv23abcd`).
  - Verify `GitHubConnectionDTO` parses connection metadata.
  - Verify `DeviceCodeStartResponse` and `DeviceFlowPollResponse`.

- [x] **Step 2: Implement schemas in `packages/contracts/src/github.ts` and export from `index.ts`**
  - Define `GitHubClientIdSchema`, `GitHubSettingsDTO`, `GitHubConnectionDTO`, `DeviceCodeStartDTO`, `DeviceFlowPollDTO`.

- [x] **Step 3: Run contract tests**
  - Run `npx vitest run packages/contracts/test/github.test.ts`.

---

### Task 2: Credential Store Abstraction (`apps/orchestrator`)

**Files:**
- Create: `apps/orchestrator/src/github/credentials.ts`
- Create: `apps/orchestrator/test/github-credentials.test.ts`

- [x] **Step 1: Write unit tests for `MemoryCredentialStore` and `CredentialStore` interface**
  - Test saving, loading, and deleting token blobs.
  - Test isolation per GitHub user ID.

- [x] **Step 2: Implement `CredentialStore`, `MemoryCredentialStore`, and `KeyringCredentialStore`**
  - Define interface with `saveTokens`, `loadTokens`, `deleteTokens`.
  - Provide fallback to memory store if `@napi-rs/keyring` is unavailable or in test mode.

- [x] **Step 3: Run credential store tests**
  - Run `npx vitest run apps/orchestrator/test/github-credentials.test.ts`.

---

### Task 3: GitHub Auth Service & Fastify Routes (`apps/orchestrator`)

**Files:**
- Create: `apps/orchestrator/src/github/service.ts`
- Create: `apps/orchestrator/src/api/routes/github.ts`
- Modify: `apps/orchestrator/src/app.ts`
- Create: `apps/orchestrator/test/github-auth.test.ts`

- [x] **Step 1: Write integration tests with mock GitHub OAuth endpoint**
  - Test saving Client ID into `app_settings`.
  - Test device-flow initiation (`/github/connection/device-start`).
  - Test polling: pending, slow_down (+5s), complete (persists metadata, stores tokens in `CredentialStore`).
  - Test proactive token refresh prior to expiry.
  - Test disconnect: clears `CredentialStore` and updates status to `disconnected`.
  - Verify DB and log scans contain no access or refresh tokens.

- [x] **Step 2: Implement `GitHubAuthService` and register routes**
  - Implement `getClientId`, `setClientId`, `startDeviceFlow`, `pollDeviceFlow`, `refreshToken`, `disconnect`.
  - Register Fastify routes under `/github/settings` and `/github/connection`.
  - Wire into `startOrchestrator` in `apps/orchestrator/src/app.ts`.

- [x] **Step 3: Run GitHub auth tests**
  - Run `npx vitest run apps/orchestrator/test/github-auth.test.ts`.

---

### Task 4: UI Settings GitHub Card (`apps/ui`)

**Files:**
- Create: `apps/ui/src/components/settings/github-settings.tsx`
- Modify: `apps/ui/src/routes/settings.tsx`

- [x] **Step 1: Implement `GitHubSettingsCard` component**
  - Registration checklist with exact permissions and link to `https://github.com/settings/apps/new`.
  - Client ID input field with format validation and Save button.
  - Device flow connect button, active user code display, external URL link, and polling spinner.
  - Connected status display: `@username`, expiration date, and Disconnect button.

- [x] **Step 2: Integrate `GitHubSettingsCard` into `SettingsPage`**
  - Add section to `apps/ui/src/routes/settings.tsx`.

---

### Task 5: Monorepo Full Verification Gate

- [x] **Step 1: Run full verification suite**
  - `npm run check:pins`
  - `npm run lint`
  - `npm run typecheck`
  - `npm test`
