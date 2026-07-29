## Exploration: Add Flow Token Initial Acquisition

### Current State

TokenStorage now has full Flow token lifecycle support:

- `saveFlowTokens()` — persists `flow_access_token`, `flow_refresh_token`, `flow_expires_at` to the token file
- `refreshFlowAccessToken()` — auto-refreshes expired Flow tokens using the stored `flow_refresh_token`
- `getValidFlowAccessToken()` — returns a valid token (fresh or auto-refreshed), or `null` if no `flow_refresh_token` exists

**The gap**: There is no way to obtain the initial `flow_refresh_token`. The existing OAuth flow (`outlook-auth-server.js`) only requests Graph scopes. Users must manually craft a Flow auth URL, authenticate, extract the code, and call `saveFlowTokens()` — or the token never gets populated. All 5 Power Automate handlers return "auth required" when no Flow token exists.

### Key Findings

1. **Same Azure app, same token endpoint**: Both Graph and Flow use the same `client_id`/`client_secret` from the same Azure app registration. Both hit the same `/oauth2/v2.0/token` endpoint. Only the **scope** differs.

2. **Flow scope is a `.default` scope**: `https://service.flow.microsoft.com/.default` — this is a resource-specific scope that requests all permissions the app has on the Power Automate resource. It's a different resource than Graph (`https://graph.microsoft.com`).

3. **The existing auth server** (`outlook-auth-server.js`):
   - Generates auth URL at `/auth` with `AUTH_CONFIG.scopes` (Graph scopes only)
   - Handles callback at `/auth/callback` — exchanges code for tokens, saves to file
   - The `exchangeCodeForTokens()` function writes the raw token response to the file — it only stores Graph keys (`access_token`, `refresh_token`, `expires_at`)
   - **It does NOT store Flow tokens** even if the response included them

4. **TokenStorage.exchangeCodeForTokens()** (in `token-storage.js`):
   - Also only stores Graph keys (`access_token`, `refresh_token`, `expires_in`, `expires_at`, `scope`, `token_type`)
   - Does NOT look for or store `flow_*` keys
   - This method is NOT currently called by the auth server (the auth server has its own inline `exchangeCodeForTokens`)

5. **The `handleAuthenticate` tool** (`auth/tools.js`):
   - Generates a simple URL pointing to `http://localhost:3333/auth`
   - No Flow-specific option exists

6. **No code populates `flow_refresh_token`**: The only code that writes `flow_refresh_token` is `saveFlowTokens()` in `token-storage.js`, and nothing calls it during the OAuth flow.

### Affected Areas

- `outlook-auth-server.js` — The auth server's `/auth` route only requests Graph scopes; its `exchangeCodeForTokens()` only saves Graph keys
- `auth/token-storage.js` — `exchangeCodeForTokens()` only stores Graph keys; `saveFlowTokens()` exists but is never called during OAuth
- `auth/tools.js` — `handleAuthenticate` only generates a Graph auth URL; no Flow option
- `config.js` — `FLOW_SCOPE` is defined but never used in auth URL generation
- `power-automate/list-environments.js` — Shows "auth required" message when no Flow token exists (5 handlers total)
- `README.md` — Documents that Flow auth is manual

### Approaches

1. **Unified scope — add Flow scope to existing Graph auth** (simplest, but risky)
   - Add `FLOW_SCOPE` to the scope list in `outlook-auth-server.js`'s auth URL
   - The token response from a single auth would include tokens for both resources
   - Update `exchangeCodeForTokens()` to detect and store `flow_*` keys from the response
   - Pros: Single auth flow, single callback, single tool
   - Cons: The `.default` scope combined with specific Graph scopes may cause issues — `.default` requests ALL permissions the app has on that resource, which could include permissions the user didn't consent to individually. The consent screen would show ALL Flow permissions. Also, the refresh token from a combined auth may only work for the original scope set, potentially causing scope creep concerns.
   - Effort: Low

2. **Separate Flow auth — new `/auth/flow` endpoint + new tool** (cleanest)
   - Add a new route `/auth/flow` to `outlook-auth-server.js` that generates an auth URL with only `FLOW_SCOPE`
   - Add a new `authenticate-flow` tool in `auth/tools.js` that points to `/auth/flow`
   - The existing `/auth/callback` handles both — the token response from a Flow-only auth would contain `access_token` and `refresh_token` for Flow
   - Update `exchangeCodeForTokens()` in the auth server to detect Flow scope in the response and call `saveFlowTokens()` instead of overwriting Graph tokens
   - Pros: Clean separation, optional (non-Flow users unaffected), Microsoft-supported pattern (incremental consent), no risk of scope conflicts
   - Cons: Two auth flows, user must authenticate twice if they want both Graph and Flow
   - Effort: Medium

3. **Incremental consent — separate auth URL, same callback, single tool** (balanced)
   - Keep the existing Graph auth as-is
   - Add a `flow` parameter to the existing `/auth` route (e.g., `/auth?flow=true`)
   - When `flow=true`, generate the auth URL with only `FLOW_SCOPE` (incremental consent)
   - The callback handles both cases by inspecting the scope in the token response
   - Update `handleAuthenticate` to accept a `flow` parameter
   - Pros: Single tool with optional parameter, same callback, Microsoft's recommended pattern for incremental/dynamic consent
   - Cons: Slightly more complex routing logic
   - Effort: Medium

4. **Two-step flow — Graph auth first, then optional Flow auth** (most explicit)
   - Step 1: User calls `authenticate` (Graph only, existing flow)
   - Step 2: User calls `authenticate-flow` (new tool) which opens a new auth URL with only Flow scope
   - The callback for step 2 detects the Flow scope and calls `saveFlowTokens()`
   - Pros: Most explicit, matches Microsoft's incremental consent pattern exactly, no scope mixing
   - Cons: Two separate user actions
   - Effort: Medium

### Recommendation

**Approach 4 (Two-step flow)** — This is the most explicit and matches Microsoft's recommended incremental consent pattern. The implementation:

1. Add a new route `/auth/flow` to `outlook-auth-server.js` that generates an auth URL with only `FLOW_SCOPE` (same `client_id`, same `redirect_uri`, different `scope`)
2. Add a new `authenticate-flow` tool in `auth/tools.js` that returns the URL to `/auth/flow`
3. Update the auth server's `exchangeCodeForTokens()` to detect whether the response contains Flow tokens (by checking if the scope includes `service.flow.microsoft.com`) and call `saveFlowTokens()` on `TokenStorage` instead of overwriting Graph tokens
4. The existing `/auth/callback` handles both flows transparently — the token response from a Flow-only auth contains `access_token` and `refresh_token` for the Flow resource

**Why not Approach 1 (unified scope)?** The `.default` scope is a wildcard — it requests ALL permissions the app has on the Flow resource. Combining it with specific Graph scopes in a single auth request is technically supported by Microsoft identity platform v2.0, but:

- The consent screen would show ALL Flow permissions (potentially confusing)
- The refresh token would be tied to the combined scope set
- If the Azure app later adds more Flow permissions, the existing refresh token would automatically include them (scope creep)
- It's harder to reason about which token is for which resource

**Why not Approach 3 (incremental consent via parameter)?** It's essentially the same as Approach 4 but with a parameter instead of a separate tool. A separate tool is more discoverable and explicit for the user.

### Risks

- **Token response detection**: The auth server's `exchangeCodeForTokens()` needs to detect whether the response is for Flow or Graph. The `scope` field in the token response contains the granted scopes — we can check for `service.flow.microsoft.com`.
- **TokenStorage import in auth server**: The auth server currently has its own inline `exchangeCodeForTokens()`. To call `saveFlowTokens()`, it would need to import `TokenStorage` (or the singleton from `auth/index.js`). This is a new dependency for the auth server.
- **Callback collision**: If a user has both auth windows open and completes them out of order, the second callback could overwrite the first. Mitigation: the Flow callback only writes `flow_*` keys (via `saveFlowTokens()`), so it won't overwrite Graph tokens.
- **User experience**: Two separate auth flows means two browser windows. The user needs clear instructions about which to do first.
- **README update**: The Power Automate section needs to document the new `authenticate-flow` tool.

### Ready for Proposal

Yes — the approach is clear, the implementation is well bounded, and the risks are manageable. The proposal should cover:

1. New `/auth/flow` route in `outlook-auth-server.js`
2. New `authenticate-flow` tool in `auth/tools.js`
3. Updated `exchangeCodeForTokens()` in auth server to detect and store Flow tokens
4. Import `TokenStorage` in auth server for `saveFlowTokens()`
5. Updated test coverage
6. Updated README documentation
