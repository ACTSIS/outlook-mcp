# Design: Add Flow Token Auto-Refresh

## Technical Approach

Add `refreshFlowAccessToken()` to `TokenStorage` mirroring the existing `refreshAccessToken()` (lines 190-275), then update `getValidFlowAccessToken()` (lines 145-159) to call it on expiry instead of returning null — mirroring `getValidAccessToken()` (lines 161-188). Flow tokens use the same Microsoft identity `/oauth2/v2.0/token` endpoint as Graph; only the scope (`config.FLOW_SCOPE`) and the stored key prefix (`flow_`) differ. A separate `_flowRefreshPromise` dedups concurrent refreshes without cross-contaminating Graph's `_refreshPromise`. This maps to proposal Approach 1.

## Architecture Decisions

| Decision                     | Choice                                                                       | Rejected alternative                                         | Rationale                                                                                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where refresh lives          | `refreshFlowAccessToken()` on TokenStorage                                   | Generic `refreshToken(params)` refactor (explore Approach 2) | Mirrors proven Graph pattern; avoids touching working Graph refresh; token file + endpoint already shared                                                     |
| Dedup promise                | Separate `_flowRefreshPromise`                                               | Share `_refreshPromise`                                      | Graph and Flow tokens expire independently; sharing would block one while the other refreshes and risk scope/key confusion                                    |
| Flow scope source            | `this.config.flowScope` (new ctor field, defaults to `appConfig.FLOW_SCOPE`) | Inline string; read `config.FLOW_SCOPE` ad-hoc               | Matches how `scopes` is configured (ctor field, spread-overridable); single source of truth = `config.js` per Scope Unification requirement                   |
| Refresh-failure invalidation | Surgical: null out `flow_*` keys only, persist, preserve Graph keys          | `this.tokens = null` (Graph's pattern)                       | Flow failure must NOT destroy Graph tokens — Graph refresh is independent and may still succeed                                                               |
| `flow_expires_at` on success | `Date.now() + expires_in * 1000` (from response)                             | Store `flow_expires_in` too                                  | Matches `saveFlowTokens` existing format (only `flow_expires_at`, no `flow_expires_in`); keeps token-file format stable (Backwards Compatibility requirement) |
| Refresh-token rotation       | Update `flow_refresh_token` only if response contains one                    | Always overwrite; always skip                                | Microsoft may or may not rotate; Graph handles this identically (lines 228-230)                                                                               |

## Data Flow

    Handler ──await──→ getValidFlowAccessToken()
                         │
                         ├─ getTokens() [cached]
                         ├─ no flow_access_token → null
                         ├─ !isFlowTokenExpired() → return flow_access_token
                         └─ isFlowTokenExpired():
                              ├─ no flow_refresh_token → null (log warn)
                              └─ try refreshFlowAccessToken():
                                   ├─ _flowRefreshPromise dedup
                                   ├─ POST tokenEndpoint { grant_type=refresh_token,
                                   │     refresh_token=flow_refresh_token, scope=flowScope }
                                   ├─ 2xx → update flow_access_token, flow_refresh_token?,
                                   │        flow_expires_at → persist → return flow_access_token
                                   └─ fail → null flow_* keys → persist → return null

## File Changes

| File                              | Action    | Description                                                                                                                                         |
| --------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth/token-storage.js`           | Modify    | Add `flowScope` to ctor config; init `_flowRefreshPromise`; add `refreshFlowAccessToken()`; rewrite expired branch of `getValidFlowAccessToken()`   |
| `test/auth/token-storage.test.js` | Modify    | Replace "expired → null, no OAuth" test with refresh-path tests; add `refreshFlowAccessToken` suite (success, rotation, failure-invalidates, dedup) |
| `config.js`                       | No change | `FLOW_SCOPE` (line 64) already correct — consumed, not redefined                                                                                    |

## Interfaces / Contracts

```js
// New ctor config field (constructor, ~line 18-32):
//   flowScope: appConfig.FLOW_SCOPE   // overridable via config spread

// New instance field (constructor, ~line 35):
//   this._flowRefreshPromise = null;

// New method — mirrors refreshAccessToken() with flow_ keys + flowScope:
async refreshFlowAccessToken() -> string   // resolves flow_access_token; rejects on failure

// Updated behavior — mirrors getValidAccessToken() expired branch:
async getValidFlowAccessToken() -> string | null
//   expired + flow_refresh_token present → attempts refresh
//   expired + no flow_refresh_token → null
//   refresh failure → nulls flow_* keys, persists, returns null
```

## Testing Strategy

| Layer      | What to Test                                                                                | Approach                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Unit       | `refreshFlowAccessToken` success updates `flow_access_token`, `flow_expires_at`, persists   | Mock `https.request` → 200 with `access_token` + `expires_in`; assert `fs.writeFile` payload + returned token |
| Unit       | Refresh-token rotation: response with/without `refresh_token`                               | Two mock responses; assert `flow_refresh_token` updated only when present                                     |
| Unit       | Refresh failure invalidates ONLY flow_* keys (Graph keys preserved), persists, returns null | Mock 400; assert `flow_access_token===null`, `access_token` unchanged, `fs.writeFile` called                  |
| Unit       | `_flowRefreshPromise` dedup: 2 concurrent calls → 1 `https.request`                         | Call twice before first resolves; assert single request                                                       |
| Unit       | `getValidFlowAccessToken` expired + no `flow_refresh_token` → null, no request              | Existing-style mock, no refresh token                                                                         |
| Unit       | `getValidFlowAccessToken` expired + valid refresh → returns fresh token                     | Mock refresh success                                                                                          |
| Regression | Existing valid-token, saveFlowTokens, getFlowAccessToken tests unchanged                    | Run existing suite                                                                                            |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary. The change is an HTTPS POST to Microsoft identity platform using the already-trusted token endpoint.

## Migration / Rollout

No data migration — token file format unchanged (`flow_*` keys pre-exist from `saveFlowTokens`). Users with a stored `flow_refresh_token` gain auto-refresh immediately; users without see no change (null path). Rollback: revert `getValidFlowAccessToken()` expired branch to `return null`; remove `refreshFlowAccessToken()` and `_flowRefreshPromise`; restore the two invalidated spec scenarios (see Open Questions).

## Open Questions

- [ ] Spec deltas needed (sdd-spec scope): `openspec/specs/auth/spec.md` scenario "getValidFlowAccessToken returns null for expired flow token" (lines 117-122, asserts MUST NOT refresh) and `openspec/specs/power-automate/spec.md` lines 67-72 (same assertion) must be replaced with refresh-path scenarios. Design assumes this change; flagging so spec phase rewrites them.
- [ ] Flow scope value confirmed as `https://service.flow.microsoft.com/.default` (single slash, per `config.js` line 64). Orchestrator context cited a double-slash variant — rejected as a typo; existing config + all project references use single slash.
