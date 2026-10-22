# GitHub Authentication & Device Flow (GH-1, GH-2, GH-10) Design Specification

| | |
|---|---|
| **Date** | 2026-10-22 |
| **Status** | Approved |
| **Stories** | `GH-1` (Registration & Client ID), `GH-2` (Device Flow & Token Storage), `GH-10` (Error Handling & Rate Limits) |
| **Parent Spec** | `docs/superpowers/specs/2026-10-18-autonomous-ai-ide-design.md` §11, §12.1, §14 |

---

## 1. Goal and Value

Provide secure, seamless GitHub authentication via the GitHub App Device Flow (`urn:ietf:params:oauth:grant-type:device_code`). The user registers their own GitHub App in minutes following an in-app checklist, enters their public Client ID, and authorizes the app without ever dealing with client secrets or pasting raw personal access tokens into the app.

---

## 2. Requirements & Acceptance Criteria

### GH-1: GitHub App Registration Guide & Client-ID Setting
1. **Guide:** Display an in-app setup checklist linking to `https://github.com/settings/apps/new` with:
   - App name (e.g. `AI Kanban - <Username>`)
   - Homepage URL (`https://github.com`)
   - Disable Webhooks (unchecked active webhook URL)
   - Enable Device Flow (checked)
   - Specific permissions (§11):
     - **Repository permissions:**
       - Metadata: `read` (mandatory)
       - Contents: `read & write`
       - Pull requests: `read & write`
       - Checks: `read`
       - Commit statuses: `read`
       - Workflows: **not granted** (safety net against automated workflow tampering)
   - Where can this app be installed: "Any account" or "Only on this account"
2. **Client ID Persistence:** The Client ID is validated (alphanumeric format, e.g. `Iv1.xxx` or `Iv23xxx`) and persisted in `app_settings` under key `github_app_client_id`.
3. **No Secrets:** No client-secret field or storage exists anywhere.

### GH-2: Device Flow Connect, Token Storage, Refresh & Disconnect
1. **Initiate Device Flow:**
   - Calls GitHub `POST https://github.com/login/device/code` with `client_id`.
   - Obtains `device_code`, `user_code`, `verification_uri`, `interval`, and `expires_in`.
   - Returns `user_code` and `verification_uri` to the UI while retaining `device_code` in memory.
   - UI displays `user_code` and opens `verification_uri` in the external browser.
2. **Poll Token:**
   - Polls `POST https://github.com/login/oauth/access_token` with `client_id`, `device_code`, and `grant_type=urn:ietf:params:oauth:grant-type:device_code`.
   - Handles `authorization_pending` (continues polling).
   - Handles `slow_down` (adds 5s to interval).
   - Handles `access_denied` and `expired_token` (aborts cleanly with descriptive status).
3. **Token Storage:**
   - Tokens (access token, refresh token, expiry dates) are stored strictly in the secure credential store (`CredentialStore` targeting `AiKanban/github/<github_user_id>`).
   - The database table `github_connections` stores only non-secret metadata: `github_user_id`, `login`, `app_client_id`, `status='connected'`, `access_expires_at`, `refresh_expires_at`, and `granted_permissions`.
4. **Proactive Refresh:**
   - A background check or proactive hook refreshes tokens 10 minutes prior to the 8-hour access token expiration using `grant_type=refresh_token`.
5. **Disconnect:**
   - Deletes the entry from `CredentialStore`.
   - Sets `github_connections.status = 'disconnected'`.
   - Displays a link to `https://github.com/settings/applications` for user revocation.

### GH-10: Rate-Limit, SSO, and Auth-Error Handling
1. **Auth Errors (401 / Revocation):**
   - If a refresh fails or GitHub returns 401: mark connection `status = 'expired'` or `'revoked'`.
   - Surface "Reconnect" prompt in UI.
2. **Rate Limits:**
   - Inspect `x-ratelimit-remaining` and `x-ratelimit-reset` headers on GitHub API calls.

---

## 3. Architecture & Contracts

### 3.1 CredentialStore Abstraction
```ts
export interface GitHubTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number; // unix ms
  refreshExpiresAt: number; // unix ms
}

export interface CredentialStore {
  saveTokens(userId: number, tokens: GitHubTokens): Promise<void>;
  loadTokens(userId: number): Promise<GitHubTokens | null>;
  deleteTokens(userId: number): Promise<void>;
}
```
- In Production: `KeyringCredentialStore` (using `@napi-rs/keyring`, target `AiKanban/github/<userId>`).
- In Tests / CI: `MemoryCredentialStore` (isolated in-memory map).

### 3.2 Fastify API Routes
- `GET /github/settings`: returns `{ clientId: string | null }`
- `PATCH /github/settings`: body `{ clientId: string }`, returns updated settings.
- `GET /github/connection`: returns active `GitHubConnectionDTO | null`.
- `POST /github/connection/device-start`: initiates device flow; returns `{ userCode, verificationUri, expiresIn, interval, sessionToken }`.
- `POST /github/connection/device-poll`: body `{ sessionToken }`, polls GitHub token endpoint. On success, persists metadata in `github_connections`, tokens in `CredentialStore`, and returns `{ status: 'complete', connection }`.
- `POST /github/connection/disconnect`: clears tokens and updates status.
- `POST /github/connection/refresh`: proactively tests/refreshes the access token.

### 3.3 UI Settings Component
In `apps/ui/src/routes/settings.tsx`:
- Dedicated **GitHub Integration** card.
- If no Client ID configured: shows registration guide accordion with permission checkboxes and Client ID input with Save button.
- If Client ID configured and disconnected: shows "Connect GitHub Account" button.
- During device flow: modal / banner displaying `user_code` with copy button and external link.
- When connected: shows GitHub avatar/login badge (`@username`), status indicator, expiry time, and "Disconnect" button.
