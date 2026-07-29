# Tasks: Add Flow Token Auto-Refresh

## Review Workload Forecast

| Field                   | Value      |
| ----------------------- | ---------- |
| Estimated changed lines | ~210–280   |
| 400-line budget risk    | Low        |
| Chained PRs recommended | No         |
| Suggested split         | Single PR  |
| Delivery strategy       | auto-chain |
| Chain strategy          | pending    |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: pending
400-line budget risk: Low

### Suggested Work Units

| Unit | Goal                                | Likely PR | Focused test command                                 | Runtime harness                    | Rollback boundary                                                                                                               |
| ---- | ----------------------------------- | --------- | ---------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Flow token auto-refresh (single PR) | PR 1      | `npx jest test/auth/token-storage.test.js --verbose` | N/A — pure unit, no real API calls | Revert `getValidFlowAccessToken()` expired branch to `return null`; remove `refreshFlowAccessToken()` and `_flowRefreshPromise` |

## Phase 1: Foundation — Constructor & Instance State

- [x] 1.1 Add `flowScope` to ctor config: `flowScope: appConfig.FLOW_SCOPE` with spread-overridable default
- [x] 1.2 Init `this._flowRefreshPromise = null` in constructor alongside `_refreshPromise`

## Phase 2: Core — refreshFlowAccessToken()

- [x] 2.1 Add `refreshFlowAccessToken()` method mirroring `refreshAccessToken()` (lines 190–275): POST to `tokenEndpoint` with `grant_type=refresh_token`, `flow_refresh_token`, `flowScope`; dedup via `_flowRefreshPromise`
- [x] 2.2 On 2xx: update `flow_access_token`, `flow_expires_at`; update `flow_refresh_token` only if response contains one; persist via `_saveTokensToFile()`
- [x] 2.3 On failure: null out `flow_access_token` and `flow_refresh_token` only (preserve Graph keys), persist, reject
- [x] 2.4 Throw if no `flow_refresh_token` available

## Phase 3: Integration — Update getValidFlowAccessToken()

- [x] 3.1 Rewrite expired branch: if `flow_refresh_token` exists → call `refreshFlowAccessToken()`; on success return token, on failure null flow_* keys, persist, return null
- [x] 3.2 If expired + no `flow_refresh_token` → log warn, return null (no OAuth attempt)

## Phase 4: Testing — RED Tests (TDD)

- [x] 4.1 RED: `refreshFlowAccessToken` success updates `flow_access_token`, `flow_expires_at`, persists
- [x] 4.2 RED: Refresh-token rotation — response with/without `refresh_token`
- [x] 4.3 RED: Refresh failure invalidates ONLY flow_* keys (Graph keys preserved), persists, returns null
- [x] 4.4 RED: `_flowRefreshPromise` dedup — 2 concurrent calls → 1 `https.request`
- [x] 4.5 RED: Missing `flow_refresh_token` throws error
- [x] 4.6 RED: `getValidFlowAccessToken` expired + valid refresh → returns fresh token (replaces line 723 test)
- [x] 4.7 RED: `getValidFlowAccessToken` expired + no `flow_refresh_token` → null, no request
- [x] 4.8 RED: `getValidFlowAccessToken` refresh fails → null, flow tokens invalidated
- [x] 4.9 Run full suite: `npx jest test/auth/token-storage.test.js --verbose` — all pass
