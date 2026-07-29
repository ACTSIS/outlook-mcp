# Proposal: Add Flow Token Auto-Refresh

## Intent

Flow tokens expire after ~1 hour and `getValidFlowAccessToken()` returns `null` on expiry with no refresh attempt, forcing users to re-authenticate. The `flow_refresh_token` is already persisted in the token file but never consumed. This change adds auto-refresh mirroring the existing Graph token refresh pattern.

## Scope

### In Scope

- Add `refreshFlowAccessToken()` method to `TokenStorage` (mirrors `refreshAccessToken()`)
- Update `getValidFlowAccessToken()` to call refresh on expiry instead of returning null
- Add `_flowRefreshPromise` for concurrent refresh dedup (separate from Graph's `_refreshPromise`)
- Wire `FLOW_SCOPE` from config into the refresh POST body
- Update test coverage for the new refresh path

### Out of Scope

- Initial Flow token acquisition flow (separate OAuth consent — pre-existing limitation)
- Handler changes (all 5 power-automate handlers already call `getValidFlowAccessToken()`)
- Refactoring `refreshAccessToken()` into a shared generic method (approach 2 from explore — higher risk, deferred)

## Capabilities

### New Capabilities

None

### Modified Capabilities

- `auth`: `getValidFlowAccessToken()` behavior changes from "returns null on expiry" to "attempts refresh on expiry". The existing spec requirement "Flow Token Methods in TokenStorage" needs a new scenario for the refresh path.

## Approach

Add `refreshFlowAccessToken()` to `TokenStorage` mirroring `refreshAccessToken()`:

1. POST to the same `tokenEndpoint` with `grant_type=refresh_token`, `refresh_token=this.tokens.flow_refresh_token`, and `scope=config.FLOW_SCOPE`
2. Use a separate `_flowRefreshPromise` for dedup (not shared with Graph's `_refreshPromise`)
3. Update `getValidFlowAccessToken()` to call `refreshFlowAccessToken()` when expired
4. On refresh failure, invalidate Flow tokens (same pattern as Graph)

## Affected Areas

| Area                              | Impact    | Description                                                                                   |
| --------------------------------- | --------- | --------------------------------------------------------------------------------------------- |
| `auth/token-storage.js`           | Modified  | Add `refreshFlowAccessToken()`, update `getValidFlowAccessToken()`, add `_flowRefreshPromise` |
| `config.js`                       | No change | `FLOW_SCOPE` already defined (line 64) — just needs to be consumed                            |
| `test/auth/token-storage.test.js` | Modified  | New tests for refresh path                                                                    |
| `power-automate/*.js`             | None      | Already call `getValidFlowAccessToken()`                                                      |

## Risks

| Risk                        | Likelihood          | Mitigation                                                     |
| --------------------------- | ------------------- | -------------------------------------------------------------- |
| Concurrent refresh race     | Low                 | `_flowRefreshPromise` dedup (same pattern as Graph)            |
| Flow refresh token rotation | Medium              | Handle both cases: new `flow_refresh_token` returned or not    |
| Scope mismatch on refresh   | Low                 | Only one Flow scope exists; unlikely to mismatch               |
| No initial Flow token       | High (pre-existing) | Auto-refresh only works if `flow_refresh_token` already stored |

## Rollback Plan

Revert `getValidFlowAccessToken()` to return `null` on expiry. Remove `refreshFlowAccessToken()` and `_flowRefreshPromise`. No handler changes needed since none are modified.

## Dependencies

- `flow_refresh_token` must already exist in the token file (pre-existing requirement)

## Success Criteria

- [ ] `getValidFlowAccessToken()` returns a fresh token when `flow_refresh_token` is valid
- [ ] `getValidFlowAccessToken()` returns `null` when no `flow_refresh_token` exists
- [ ] Concurrent calls to `getValidFlowAccessToken()` share a single refresh attempt
- [ ] All existing Flow token tests pass with updated expectations
