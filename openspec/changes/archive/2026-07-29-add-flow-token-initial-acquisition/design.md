# Design: Add Flow Token Initial Acquisition

## Technical Approach

Add a two-step incremental consent flow to the standalone auth server (`outlook-auth-server.js`): a new `/auth/flow` route generates a Microsoft OAuth URL with only `config.FLOW_SCOPE`, and the existing `/auth/callback` detects Flow callbacks via the CSRF `state` parameter (not the token response scope) and routes them to `TokenStorage.saveFlowTokens()` — preserving Graph keys. Graph auth remains untouched. This maps to proposal Approach 4 (two-step flow).

## Architecture Decisions

| Decision            | Choice                                                                       | Rejected                                                                                 | Rationale                                                                                                                                                                                                                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Callback routing    | Same `/auth/callback`, detect via `state` (Option B1)                        | Separate `/auth/flow/callback` (Option A); detect via token response `scope` (Option B2) | Azure app has one redirect URI; adding another requires portal changes (out of scope). State-based detection knows flow type BEFORE token exchange — lets us send correct `scope` in the POST. Response-scope detection (B2) requires exchange to complete first and depends on parsing a string that could change format. |
| State storage       | `pendingStates.set(state, { timestamp, flow: true })`                        | Separate Map; query-param flag on callback                                               | `pendingStates` already exists for CSRF validation — extending it to carry the flow flag is minimal. A query-param flag (`?flow=true` on callback) is forgeable; state is cryptographically random and server-issued.                                                                                                      |
| Token exchange      | Add `isFlow` param to existing `exchangeCodeForTokens(code, isFlow = false)` | Separate `exchangeCodeForFlowTokens()` function                                          | One function, two paths — matches existing inline style. `isFlow=false` default keeps Graph path byte-identical.                                                                                                                                                                                                           |
| Flow token storage  | `tokenStorage.saveFlowTokens({ access_token, refresh_token, expires_in })`   | Raw `fs.writeFileSync` (Graph's pattern)                                                 | `saveFlowTokens()` spreads `...this.tokens` (line 136) — preserves Graph keys. Raw write would overwrite Graph tokens with Flow's `access_token`/`refresh_token`.                                                                                                                                                          |
| TokenStorage import | `const { tokenStorage } = require('./auth/index')` singleton                 | `new TokenStorage()` inline                                                              | Proposal specifies singleton; `auth/index.js` is the established export point. Singleton reads same env vars (`MS_CLIENT_ID` etc.) as the auth server.                                                                                                                                                                     |
| Redirect URI        | Same (`http://localhost:3333/auth/callback`)                                 | New URI for Flow                                                                         | Standard incremental consent: same redirect URI, different scope. No Azure portal changes needed.                                                                                                                                                                                                                          |

## Data Flow

```
MCP Client ──authenticate-flow──→ /auth/flow
                                     │ state = randomBytes(32) + {flow:true}
                                     │ pendingStates.set(state, {ts, flow:true})
                                     └──302──→ Microsoft OAuth (scope=FLOW_SCOPE)
                                                  │
                                                  └──redirect──→ /auth/callback?code=...&state=...
                                                                    │
                                                                    ├─ pendingStates.get(state) → {flow:true}
                                                                    ├─ exchangeCodeForTokens(code, isFlow=true)
                                                                    │    POST token endpoint {scope: FLOW_SCOPE}
                                                                    │    → tokenStorage.saveFlowTokens({access_token,
                                                                    │       refresh_token, expires_in})
                                                                    │    → preserves Graph keys, writes flow_* keys
                                                                    └─ 200 ✅

Graph auth (unchanged): /auth → pendingStates.set(state, {ts, flow:false})
  → callback → exchangeCodeForTokens(code, false) → fs.writeFileSync (raw, existing)
```

## File Changes

| File                                  | Action    | Description                                                                                                                                                                                                                                  |
| ------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outlook-auth-server.js`              | Modify    | Add `/auth/flow` route; change `pendingStates` values to `{timestamp, flow}` objects; add `isFlow` param to `exchangeCodeForTokens()`; import `tokenStorage` singleton; Flow path calls `saveFlowTokens()` instead of raw `fs.writeFileSync` |
| `auth/tools.js`                       | Modify    | Add `handleAuthenticateFlow` handler + `authenticate-flow` tool definition                                                                                                                                                                   |
| `test/auth/tools.test.js`             | Modify    | Add `handleAuthenticateFlow` test (returns `/auth/flow` URL)                                                                                                                                                                                 |
| `test/auth/oauth-server-flow.test.js` | Create    | Unit tests for Flow exchange path: `isFlow=true` uses `FLOW_SCOPE`, calls `saveFlowTokens`, preserves Graph keys; `isFlow=false` unchanged                                                                                                   |
| `README.md`                           | Modify    | Document `authenticate-flow` tool in Power Automate section                                                                                                                                                                                  |
| `auth/token-storage.js`               | No change | `saveFlowTokens()` already exists (lines 133-144)                                                                                                                                                                                            |
| `config.js`                           | No change | `FLOW_SCOPE` already defined (line 64)                                                                                                                                                                                                       |

## Interfaces / Contracts

```js
// outlook-auth-server.js — pendingStates value shape changes:
//   pendingStates.set(state, { timestamp: number, flow: boolean })
// Cleanup interval: now - entry.timestamp > TEN_MINUTES

// outlook-auth-server.js — exchangeCodeForTokens signature:
async function exchangeCodeForTokens(code, isFlow = false)
// isFlow=false: existing behavior (Graph scopes, fs.writeFileSync raw response)
// isFlow=true: FLOW_SCOPE in POST body, tokenStorage.saveFlowTokens({access_token,
//              refresh_token, expires_in}) — preserves Graph keys

// auth/tools.js — new handler:
async function handleAuthenticateFlow(_args)
// Non-test mode: returns "Flow authentication required. Visit: {authServerUrl}/auth/flow"
// Test mode: calls tokenManager.createTestTokens() (same as Graph test mode — see Open Questions)
```

## Testing Strategy

| Layer      | What to Test                                                             | Approach                                                                             |
| ---------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Unit       | `handleAuthenticateFlow` returns URL containing `/auth/flow`             | Assert URL string in `auth/tools.test.js`                                            |
| Unit       | `exchangeCodeForTokens(code, true)` uses `FLOW_SCOPE` in POST body       | Mock `https.request`, assert `postData` scope field equals `config.FLOW_SCOPE`       |
| Unit       | Flow exchange calls `saveFlowTokens`, NOT `fs.writeFileSync`             | Mock both, assert only `saveFlowTokens` called                                       |
| Unit       | Flow exchange preserves existing Graph keys in token file                | Pre-populate token file with Graph keys, run Flow exchange, assert Graph keys intact |
| Unit       | `exchangeCodeForTokens(code, false)` unchanged — raw `fs.writeFileSync`  | Regression: existing behavior preserved                                              |
| Unit       | `/auth/flow` route generates 302 with `scope=FLOW_SCOPE` in redirect URL | Extract handler or use supertest with `http.createServer`                            |
| Unit       | `pendingStates` cleanup works with `{timestamp, flow}` objects           | Advance clock past `TEN_MINUTES`, assert expired entries deleted                     |
| Regression | All existing auth tests pass                                             | `npm test`                                                                           |

## Threat Matrix

N/A — the routing boundary is HTTP OAuth redirect routing, not shell/subprocess/VCS/PR automation. No matrix row (documentation paths, git repo selection, commit state, push state, PR commands) applies. CSRF is handled by the existing `pendingStates` mechanism, extended to carry the flow flag; the `state` parameter remains cryptographically random (`crypto.randomBytes(32)`) and server-validated before any token exchange occurs.

## Migration / Rollout

No data migration — token file format unchanged (`flow_*` keys pre-exist from `saveFlowTokens`). Users without Flow tokens see no change. Rollback: remove `/auth/flow` route, revert `pendingStates` values to `state → timestamp`, remove `isFlow` param from `exchangeCodeForTokens()`, remove `tokenStorage` import, remove `authenticate-flow` tool and handler.

## Open Questions

- [ ] Test mode: `handleAuthenticateFlow` in `USE_TEST_MODE` calls `tokenManager.createTestTokens()` which only creates Graph test tokens. Should it also create test Flow tokens, or is Graph test mode sufficient for Flow tool testing?
- [ ] Should `/auth/flow` also be added to the modular `auth/oauth-server.js` (Express version with `setupOAuthRoutes`), or only the standalone `outlook-auth-server.js`? Proposal targets the standalone server only — but the modular version has existing test coverage (supertest) that the standalone server lacks.
