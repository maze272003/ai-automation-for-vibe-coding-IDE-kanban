# SPK-4 — GitHub App device flow and credential-helper push

**Date:** 2026-10-18 · **Executor:** SPK-4 · **Status:** Complete

Prototype scripts: `spikes/spk-4/` (`device-flow.mjs`, `refresh.mjs`, `list-repos.mjs`, `cred-helper.mjs`, `push.mjs`, `merge-guard.mjs`, `gh.mjs`). Subsequent product implementation: `c09660c`, `91060c6`, `4ddebfb` (GH-1…GH-10).

---

## Results

| # | Question / Capability | Observed | Plan Expectation | Marker |
|---|---|---|---|---|
| 1 | Device flow without client secret | GitHub OAuth device code endpoint (`https://github.com/login/device/code`) issues `device_code`, `user_code`, `verification_uri`. Polling `https://github.com/login/oauth/access_token` exchanges user authorization for user-to-server tokens without requiring a client secret. | Supported without client secret | V |
| 2 | Token refresh without client secret | Refresh flow (`grant_type=refresh_token`, `client_id`, `refresh_token`) issues a new `access_token` and rotated `refresh_token` without a client secret. | Supported | V |
| 3 | Windows Credential Manager persistence | `@napi-rs/keyring` `Entry` API stores and retrieves serialized token JSON securely under Windows Credential Manager without exposing credentials in plaintext files or logs. | Secure storage verified | V |
| 4 | Token leakage prevention during git push | Ephemeral loopback named pipe relay (`\\.\pipe\aik-spike-cred-*`) with one-time nonce satisfies git credential helper requests. Verified: token **never** appears in `.git/config`, `git push` CLI arguments, process command lines (`Win32_Process`), or persistent `cmdkey` records. | No leakage | V |
| 5 | Replay rejection on credential helper | Second request using the same nonce is rejected (returns empty payload). Requests for foreign hosts (e.g. `evil.example`) are rejected. | Replay & host spoofing blocked | V |
| 6 | Remote merge `sha` guard | `PUT /repos/:owner/:repo/pulls/:number/merge` with a mismatched/stale SHA returns HTTP `409 Conflict`. Providing current `head.sha` succeeds (`merged: true`). | Enforces optimistic concurrency | V |

---

## Specific Questions Resolved

### Q-4: Does GitHub App Device Flow require a client secret?
**No.** GitHub Apps configured with device authorization flow permit public client authorization (client ID only) and refresh token rotation without a client secret.

### Q-5: Can Git Credential Helper push without writing tokens to disk?
**Yes.** Custom credential helper script reading from an in-memory named pipe with a one-time cryptographic nonce isolates the credential completely. The token exists in memory only during the active push operation and is purged immediately upon socket close.

---

## Verdict

**GO for Phase 3 (GH-1…GH-10).**

All architectural assumptions hold:
- Device flow operates purely in the client without a backend relay or client secret.
- Push authentication leaks zero tokens to git configuration or process monitoring.
- Merge operations can strictly bind to candidate SHA for atomic remote promotion.
