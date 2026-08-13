# Authentication and token lifecycle

This guide describes the behavior implemented by the active executables: `index.js`, `outlook-auth-server.js`, and `auth/token-storage.js`. Microsoft Graph and Power Automate use separate OAuth grants but share one local token file.

## Authenticate successfully

1. Configure one Microsoft Entra app with the Web redirect URI `http://localhost:3333/auth/callback`.
2. Put `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, and `MS_TENANT_ID` in `.env`.
3. Run `npm run auth-server`.
4. Call the `authenticate` MCP tool and open its URL.
5. After consent, call `check-auth-status` to validate the Graph token.
6. If Power Automate is required, call `authenticate-flow` and complete its separate consent flow.

`check-auth-status` is Graph-only. Validate Flow authentication with a Flow operation such as `flow-list-environments`.

## OAuth grants and scopes

The active auth server uses the Microsoft identity platform v2 authorization-code grant.

Graph initial acquisition requests the configured built-in delegated scope union:

```text
offline_access User.Read Mail.Read Mail.ReadWrite Mail.Send
Calendars.Read Calendars.ReadWrite Contacts.Read Files.Read Files.ReadWrite
```

`offline_access` is required for Microsoft to issue a refresh token. Power Automate uses a separate authorization and token exchange with:

```text
https://service.flow.microsoft.com/.default
```

The active callback server creates a random 32-byte state value, keeps it in memory for up to ten minutes, records whether it belongs to Graph or Flow, and consumes it once at callback. Restarting the auth server invalidates outstanding states.

## Storage contract

The default token store is:

```text
~/.outlook-mcp-tokens.json
```

Writes request filesystem mode `0600` (owner read/write). Protect this file as a credential: never commit, copy into logs, or share it.

The JSON may contain Microsoft response fields plus the derived expiry fields below:

| Token family | Fields used by the runtime                                                         |
| ------------ | ---------------------------------------------------------------------------------- |
| Graph        | `access_token`, `refresh_token`, `expires_in`, `expires_at`, `scope`, `token_type` |
| Flow         | `flow_access_token`, `flow_refresh_token`, `flow_expires_at`                       |

Both families live at the top level of the same object. `saveFlowTokens()` merges `flow_*` values into existing Graph data. By contrast, active Graph initial acquisition currently raw-writes the Graph response; see [Known limitations](#known-limitations).

## Runtime lifecycle

### Graph

1. A Graph-backed handler calls `ensureAuthenticated()`.
2. The singleton `TokenStorage` loads the token file once on demand; concurrent first loads share `_loadPromise`.
3. If `access_token` is absent, the handler receives `Authentication required`.
4. If the token is valid beyond the five-minute buffer, it is returned.
5. If the token is expired or within five minutes of `expires_at`, `refreshAccessToken()` uses the refresh-token grant.
6. Concurrent Graph refresh callers share `_refreshPromise`.
7. A successful response replaces the access token and expiry. A returned rotated `refresh_token` replaces the old one; if Microsoft omits it, the old refresh token remains.
8. Updated tokens are written back to the shared file.

### Power Automate

1. Every Flow handler calls `getValidFlowAccessToken()`.
2. A valid `flow_access_token` is returned immediately.
3. An expired/near-expiry Flow token is refreshed **only if `flow_refresh_token` exists**.
4. Concurrent Flow refresh callers share `_flowRefreshPromise`.
5. Successful refresh updates `flow_access_token` and `flow_expires_at`; refresh-token rotation is handled when present and the old value is otherwise preserved.
6. A permanent OAuth `invalid_grant` clears only `flow_access_token` and `flow_refresh_token`, preserving Graph fields.
7. Network, timeout, and other transient Flow refresh errors return no usable token for that call but do not deliberately invalidate stored Flow credentials.

Auto-refresh cannot create an initial Flow grant. If the file has no Flow access token, or an expired Flow token has no refresh token, complete `authenticate-flow`.

## Refresh failure matrix

This table documents current behavior, including asymmetry rather than an idealized policy.

| Path and failure                                       | Classification            | Current in-memory result                                                                                               | Current disk result                                             | Recovery                                                                     |
| ------------------------------------------------------ | ------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Flow refresh HTTP 400 `invalid_grant`                  | Permanent                 | Clears Flow access/refresh only; Graph remains                                                                         | Persists cleared `flow_*` values                                | Run `authenticate-flow`                                                      |
| Flow refresh network/timeout/non-`invalid_grant` error | Transient or unknown      | Keeps token object; current call returns no token                                                                      | Stored token object is kept                                     | Retry; reauthenticate Flow only if the error persists                        |
| Flow token expired with no Flow refresh token          | Missing credential        | Keeps existing token object; returns no token                                                                          | Unchanged                                                       | Run `authenticate-flow`                                                      |
| Graph refresh error of any kind                        | Not distinguished         | Sets the entire in-memory token object to `null`, affecting Graph and Flow                                             | Intended invalidation is a no-op, so stale file content remains | Restart may reload stale data; complete Graph auth, then Flow auth if needed |
| Graph token expired with no refresh token              | Missing credential        | Same whole-object in-memory clear                                                                                      | Same no-op disk invalidation                                    | Complete Graph auth, then verify Flow                                        |
| Successful refresh but token-file save fails           | Local persistence failure | Refresh methods update memory before rejecting; Graph caller then clears all memory, while Flow keeps its token object | Old file content remains                                        | Fix file/home permissions and retry authentication                           |

## Configuration and precedence

The runtime `TokenStorage` resolves credentials as `MS_CLIENT_ID` before `OUTLOOK_CLIENT_ID`, and `MS_CLIENT_SECRET` before `OUTLOOK_CLIENT_SECRET`. It also honors `MS_TENANT_ID`, `MS_AUTHORITY_HOST`, `MS_SCOPES`, `MS_REDIRECT_URI`, and `MS_TOKEN_ENDPOINT`.

The active initial-acquisition server requires `MS_CLIENT_ID` and `MS_CLIENT_SECRET`, honors `MS_TENANT_ID` and `MS_AUTHORITY_HOST`, but obtains redirect URI and Graph scopes from `config.js` and constructs its own token endpoint. Therefore the three `TokenStorage` overrides are not a consistent end-to-end customization mechanism; see limitation 5 below.

## Known limitations

These are verified implementation limitations, not promised fixes:

1. **Graph invalidation is not persisted.** On a Graph refresh failure or an expired Graph token without a refresh token, `getValidAccessToken()` sets `this.tokens = null` and then calls `_saveTokensToFile()`. That save is a no-op when `this.tokens` is null, so stale credentials survive on disk and can be loaded after restart.
2. **Graph reauthentication can erase Flow credentials.** Active Graph initial acquisition in `outlook-auth-server.js` raw-writes the shared token file instead of merging with existing data. Existing `flow_*` fields are removed. Complete `authenticate-flow` again after Graph reauthentication when needed.
3. **Graph refresh failures are over-broad.** Graph does not distinguish permanent OAuth rejection from a transient network, timeout, response-parsing, or save error. Every failure clears the whole token object in memory, including Flow fields.
4. **Flow test authentication is incomplete.** With `USE_TEST_MODE=true`, `authenticate-flow` reports success but calls the legacy `createTestTokens()`, which writes only Graph-shaped keys. Flow handlers still find no `flow_access_token` unless their token dependency is mocked or a suitable token file already exists.
5. **Initial acquisition and refresh configuration can diverge.** `MS_SCOPES`, `MS_REDIRECT_URI`, and `MS_TOKEN_ENDPOINT` affect `TokenStorage` paths but are not consistently honored by active initial acquisition in `outlook-auth-server.js`.

Additional interface asymmetries:

- `authenticate` advertises a `force` input, but its handler ignores it and only returns an auth URL.
- `check-auth-status` checks Graph only; it does not report Flow state.
- There is no public MCP logout tool. `TokenStorage.clearTokens()` exists internally and deletes the shared file, but no tool invokes it.
- `auth/oauth-server.js` is an inactive Express-oriented implementation covered by direct unit tests. Neither `index.js` nor `outlook-auth-server.js` uses it; do not infer production routes or configuration from it.

## Test-mode boundary

`USE_TEST_MODE=true` changes Graph and Flow API clients to return mock responses when they receive recognized test-token prefixes. It does not faithfully simulate the two-token OAuth lifecycle. In particular, the shared legacy authentication helper creates only a Graph access token. Use focused unit tests with a mocked `TokenStorage` when validating Flow handler authentication behavior.

## Recovery without unnecessary data loss

- For a Graph-only problem, start with `check-auth-status`, then complete `authenticate` if needed.
- For a Flow-only problem, call `flow-list-environments`, then complete `authenticate-flow` if needed.
- After Graph reauthentication, verify Flow separately because the shared-file overwrite can remove Flow fields.
- Delete `~/.outlook-mcp-tokens.json` only when intentionally resetting **both** Graph and Flow. The server has no selective public logout.
- For HTTP 401, reauthenticate the corresponding token family; API 401 responses do not force local token invalidation. For HTTP 403, verify permissions, consent, ownership, and resource eligibility; repeating authentication alone may not fix authorization.
