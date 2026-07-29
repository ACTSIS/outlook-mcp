## Exploration: Add Flow Token Auto-Refresh

### Current State

The previous migration (2026-07-29) moved all Flow token methods into `TokenStorage` and updated the 5 power-automate handlers to use `tokenStorage.getValidFlowAccessToken()`. However, `getValidFlowAccessToken()` returns `null` when the Flow token is expired — it does NOT attempt to refresh using the stored `flow_refresh_token`.

Flow tokens use a completely independent OAuth scope (`https://service.flow.microsoft.com/.default`) from Graph tokens, but they use the **same** Microsoft identity token endpoint (`/oauth2/v2.0/token`). The `flow_refresh_token` IS already persisted by `saveFlowTokens()` in the token file alongside `flow_access_token` and `flow_expires_at` — it just sits unused.

The Graph token path (`getValidAccessToken()` → `refreshAccessToken()`) already has a working auto-refresh implementation with dedup via `_refreshPromise`. The Flow path has no equivalent.

### Affected Areas

- `auth/token-storage.js` — `getValidFlowAccessToken()` (lines 145-159) returns null on expiry; needs a `refreshFlowAccessToken()` method modeled after `refreshAccessToken()` (lines 190-275)
- `config.js` — `FLOW_SCOPE` (line 64) is defined but never consumed by TokenStorage; needs to be passed to the refresh call
- `auth/token-storage.js` — constructor needs to accept or derive the Flow scope for the refresh token grant
- `power-automate/flow-api.js` — no changes needed (it just receives an access token)
- `outlook-auth-server.js` — no changes needed (Flow token auto-refresh reuses the same endpoint, no new auth flow)
- `test/auth/token-storage.test.js` — needs new tests for `refreshFlowAccessToken()` and updated `getValidFlowAccessToken()` behavior

### Approaches

1. **Add `refreshFlowAccessToken()` to TokenStorage** (recommended)
   - Mirror `refreshAccessToken()` but use `flow_refresh_token` and `FLOW_SCOPE` instead of Graph refresh token and scopes
   - Reuse the same `_refreshPromise` dedup pattern (or a separate `_flowRefreshPromise`)
   - Update `getValidFlowAccessToken()` to call `refreshFlowAccessToken()` when expired, matching Graph behavior
   - Pros: Consistent with Graph pattern, no new files, reuses existing infrastructure
   - Cons: TokenStorage grows further (but it's already the token authority)
   - Effort: Medium

2. **Extract a generic `refreshToken()` method**
   - Refactor `refreshAccessToken()` to accept parameters (refresh_token, scope) and call it for both Graph and Flow
   - Pros: DRY, single refresh implementation
   - Cons: More refactoring, risk of breaking existing Graph refresh, the two paths have slightly different error handling
   - Effort: Medium-High

3. **Keep returning null, add external refresh trigger**
   - Add a separate tool/endpoint that the user can call to refresh Flow tokens
   - Pros: Minimal code change
   - Cons: User must manually trigger refresh, defeats the purpose of auto-refresh
   - Effort: Low

### Recommendation

**Approach 1** — Add `refreshFlowAccessToken()` to TokenStorage mirroring the existing `refreshAccessToken()`. The key insight is that Flow tokens use the **same** Microsoft identity token endpoint as Graph tokens — only the scope differs. The `flow_refresh_token` is already stored. The implementation is:

1. Add `refreshFlowAccessToken()` method that POSTs to the same `tokenEndpoint` with `grant_type=refresh_token`, `refresh_token=this.tokens.flow_refresh_token`, and `scope=config.FLOW_SCOPE`
2. Use a separate `_flowRefreshPromise` for dedup (don't share with Graph's `_refreshPromise` to avoid cross-contamination)
3. Update `getValidFlowAccessToken()` to call `refreshFlowAccessToken()` when expired, matching the Graph pattern in `getValidAccessToken()`
4. Pass `FLOW_SCOPE` from config into TokenStorage (or read it directly)

### Risks

- **No initial Flow token acquisition**: Auto-refresh only works once a valid `flow_refresh_token` exists. If the user has never obtained Flow tokens, they still need the external OAuth flow. This is a pre-existing limitation, not introduced by this change.
- **Flow refresh token rotation**: Microsoft may or may not return a new `flow_refresh_token` in the refresh response. The implementation must handle both cases (same as Graph does).
- **Concurrent refresh**: Two handlers calling `getValidFlowAccessToken()` simultaneously could trigger duplicate refresh attempts. Mitigation: use `_flowRefreshPromise` dedup (same pattern as Graph).
- **Scope mismatch**: If the stored `flow_refresh_token` was issued for a different scope than `FLOW_SCOPE`, the refresh will fail. This is unlikely in practice since there's only one Flow scope.
- **Test coverage**: The existing Flow token tests only cover the "return null on expiry" path. Tests must be updated to cover the refresh path.

### Ready for Proposal

Yes — the approach is clear, the implementation is a direct mirror of the existing Graph refresh pattern, and the scope is well bounded. The proposal should cover:

1. New `refreshFlowAccessToken()` method on TokenStorage
2. Updated `getValidFlowAccessToken()` to call refresh on expiry
3. Config integration for `FLOW_SCOPE`
4. Updated test coverage
5. No handler changes needed (they already call `getValidFlowAccessToken()`)
