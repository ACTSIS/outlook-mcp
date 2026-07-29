# Proposal: Add Flow Token Initial Acquisition

## Intent

Power Automate handlers return "auth required" when no Flow token exists. `refreshFlowAccessToken()` works but needs a stored `flow_refresh_token` — there's no OAuth flow to obtain it. Users must manually craft a Flow auth URL, authenticate, extract the code, and call `saveFlowTokens()`. This change adds a proper two-step incremental consent flow so users can acquire Flow tokens through the same auth server.

## Scope

### In Scope

- New `/auth/flow` route in `outlook-auth-server.js` that generates an auth URL with only `FLOW_SCOPE`
- New `authenticate-flow` tool in `auth/tools.js` that returns the URL to `/auth/flow`
- Updated `exchangeCodeForTokens()` in auth server to detect Flow scope in the token response and call `saveFlowTokens()`
- Import `TokenStorage` singleton in auth server for `saveFlowTokens()`
- Updated test coverage for the new route and tool
- Updated README documentation for the new `authenticate-flow` tool

### Out of Scope

- Unified scope approach (adding Flow scope to existing Graph auth) — rejected due to `.default` scope creep concerns
- Modifying the existing `authenticate` tool or Graph auth flow
- Auto-triggering Flow auth when Power Automate handlers detect missing tokens
- Flow token revocation or management tools

## Capabilities

### New Capabilities

None — this change adds requirements to existing capabilities.

### Modified Capabilities

- `auth`: Adds Flow initial OAuth acquisition — new `/auth/flow` route, `authenticate-flow` tool, and Flow token detection in the callback handler
- `power-automate`: Adds requirement for initial token acquisition documentation and user-facing guidance

## Approach

Two-step incremental consent flow (Microsoft-recommended pattern):

1. **New `/auth/flow` route** in `outlook-auth-server.js` — generates auth URL with `FLOW_SCOPE` only (same `client_id`, same `redirect_uri`, different `scope`)
2. **New `authenticate-flow` tool** in `auth/tools.js` — returns the URL to `/auth/flow`, separate from the existing `authenticate` tool
3. **Updated `exchangeCodeForTokens()`** in auth server — detects whether the token response is for Flow (checks `scope` for `service.flow.microsoft.com`) and calls `saveFlowTokens()` on `TokenStorage` instead of overwriting Graph keys
4. **Import `TokenStorage`** in auth server — currently the auth server has its own inline `exchangeCodeForTokens()`; needs the singleton from `auth/index.js` to call `saveFlowTokens()`
5. The existing `/auth/callback` handles both flows transparently — Flow callback only writes `flow_*` keys, so it won't overwrite Graph tokens even if both auth windows are open

## Affected Areas

| Area                     | Impact    | Description                                                                                       |
| ------------------------ | --------- | ------------------------------------------------------------------------------------------------- |
| `outlook-auth-server.js` | Modified  | New `/auth/flow` route; updated `exchangeCodeForTokens()` for Flow detection; import TokenStorage |
| `auth/tools.js`          | Modified  | New `authenticate-flow` tool definition                                                           |
| `auth/token-storage.js`  | Unchanged | `saveFlowTokens()` already exists and works                                                       |
| `config.js`              | Unchanged | `FLOW_SCOPE` already defined                                                                      |
| `README.md`              | Modified  | Document new `authenticate-flow` tool in Power Automate section                                   |
| `power-automate/*.js`    | Unchanged | Handlers already use `getValidFlowAccessToken()`                                                  |

## Risks

| Risk                                                      | Likelihood | Mitigation                                                                               |
| --------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------- |
| TokenStorage import in auth server creates new dependency | Low        | Import singleton from `auth/index.js` — same pattern used elsewhere                      |
| Callback collision (both auth windows open)               | Low        | Flow callback only writes `flow_*` keys via `saveFlowTokens()`, never touches Graph keys |
| Token response scope detection fragile                    | Low        | Check `scope` string for `service.flow.microsoft.com` — standard OAuth field             |
| User confusion about two auth flows                       | Medium     | Clear tool naming (`authenticate` vs `authenticate-flow`) and README documentation       |

## Rollback Plan

1. Remove `/auth/flow` route from `outlook-auth-server.js`
2. Remove `authenticate-flow` tool from `auth/tools.js`
3. Revert `exchangeCodeForTokens()` to pre-change state
4. Remove TokenStorage import from auth server
5. Revert README changes

## Dependencies

- None — same Azure app, same token endpoint, no new infrastructure

## Success Criteria

- [ ] `GET /auth/flow` returns an auth URL with `scope=https://service.flow.microsoft.com/.default`
- [ ] Completing the Flow OAuth flow stores `flow_access_token`, `flow_refresh_token`, and `flow_expires_at` in the token file
- [ ] Existing Graph tokens are unmodified after Flow auth
- [ ] `authenticate-flow` tool is discoverable and returns the correct URL
- [ ] All existing tests pass
- [ ] Power Automate handlers work after Flow auth (no more "auth required")
