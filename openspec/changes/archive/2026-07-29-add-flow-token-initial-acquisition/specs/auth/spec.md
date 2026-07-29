# Delta for Auth

## ADDED Requirements

### Requirement: Flow Auth Route

The auth server MUST expose a `GET /auth/flow` route that generates a Microsoft OAuth authorization URL with `FLOW_SCOPE` only, using the same `client_id`, `redirect_uri`, and CSRF state mechanism as the existing `/auth` route.

#### Scenario: /auth/flow returns redirect with FLOW_SCOPE

- GIVEN the auth server is running with valid `MS_CLIENT_ID` and `MS_CLIENT_SECRET`
- WHEN a GET request is made to `/auth/flow`
- THEN the response MUST be a 302 redirect to `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize`
- AND the `scope` query parameter MUST be `https://service.flow.microsoft.com/.default`
- AND the `client_id`, `redirect_uri`, `response_type=code`, and `state` parameters MUST be present

#### Scenario: /auth/flow returns 500 when credentials missing

- GIVEN the auth server has no `MS_CLIENT_ID` or `MS_CLIENT_SECRET` configured
- WHEN a GET request is made to `/auth/flow`
- THEN the response MUST be 500 with an HTML error page
- AND the error page MUST indicate missing credentials

### Requirement: Authenticate-Flow Tool

The `auth/tools.js` module MUST export an `authenticate-flow` tool that returns the URL to `http://localhost:3333/auth/flow` for the user to visit in their browser.

#### Scenario: authenticate-flow returns Flow auth URL

- GIVEN the auth server is running at `http://localhost:3333`
- WHEN the `authenticate-flow` tool is invoked
- THEN it MUST return a text response containing `http://localhost:3333/auth/flow`
- AND the response MUST instruct the user to visit the URL to authenticate with Power Automate

#### Scenario: authenticate-flow in test mode creates test flow tokens

- GIVEN `USE_TEST_MODE=true`
- WHEN the `authenticate-flow` tool is invoked
- THEN it MUST create test flow tokens via `tokenManager.createTestTokens()`
- AND it MUST return a success message indicating test mode authentication

### Requirement: Flow Token Detection in Callback

The auth server's `exchangeCodeForTokens()` MUST detect whether the token response is for Flow by inspecting the `scope` field, and call `TokenStorage.saveFlowTokens()` for Flow responses instead of writing Graph keys.

#### Scenario: Flow scope detected calls saveFlowTokens

- GIVEN a token response with `scope` containing `https://service.flow.microsoft.com/.default`
- WHEN `exchangeCodeForTokens()` processes the response
- THEN it MUST call `tokenStorage.saveFlowTokens()` with the token response
- AND it MUST NOT overwrite existing Graph token keys in the token file
- AND the success HTML page MUST indicate Flow authentication

#### Scenario: Graph scope detected writes Graph tokens normally

- GIVEN a token response with `scope` containing `Mail.Read` (no Flow scope)
- WHEN `exchangeCodeForTokens()` processes the response
- THEN it MUST write Graph token keys (`access_token`, `refresh_token`, `expires_at`) to the token file
- AND it MUST NOT call `saveFlowTokens()`

#### Scenario: Flow auth failure does not affect Graph tokens

- GIVEN a token file with valid Graph tokens (`access_token`, `refresh_token`, `expires_at`)
- WHEN the user completes a Flow OAuth flow and the token endpoint returns an error
- THEN the Graph token keys MUST remain unchanged in the token file
- AND the error HTML page MUST indicate Flow authentication failure

## MODIFIED Requirements

### Requirement: Scope Unification

All auth modules that request scopes from Microsoft identity platform MUST reference `config.js` as the single source of truth for scope lists.
(Previously: Only Graph scopes were unified; Flow scope was not used by auth server routes)

#### Scenario: All scope consumers reference config.js

- GIVEN `config.js` defines `AUTH_CONFIG.scopes` with the full scope set
- WHEN any auth module (`token-storage.js`, `outlook-auth-server.js`) constructs an OAuth request
- THEN it MUST use `config.AUTH_CONFIG.scopes` as the scope parameter
- AND it MUST NOT define its own inline scope list

#### Scenario: /auth/flow uses FLOW_SCOPE from config.js

- GIVEN `config.js` defines `FLOW_SCOPE` as `https://service.flow.microsoft.com/.default`
- WHEN the `/auth/flow` route constructs the OAuth authorization URL
- THEN it MUST use `config.FLOW_SCOPE` as the scope parameter
- AND it MUST NOT use `config.AUTH_CONFIG.scopes`

#### Scenario: MS_SCOPES env var overrides config.js scopes

- GIVEN `process.env.MS_SCOPES` is set
- WHEN `token-storage.js` initializes its config
- THEN it MUST use `MS_SCOPES` instead of `config.AUTH_CONFIG.scopes`
- AND `outlook-auth-server.js` MUST NOT use `MS_SCOPES` (it uses `config.js` directly)

### Requirement: Flow Token Methods in TokenStorage

TokenStorage MUST provide `getFlowAccessToken()`, `saveFlowTokens()`, `isFlowTokenExpired()`, and `getValidFlowAccessToken()` methods that read/write `flow_`-prefixed keys in the same token file.
(Previously: `getValidFlowAccessToken()` returned null on expiry without attempting refresh)

#### Scenario: getFlowAccessToken reads flow_access_token from file

- GIVEN a token file with `flow_access_token: "flow-token-123"` and `flow_expires_at` in the future
- WHEN `tokenStorage.getFlowAccessToken()` is called
- THEN it MUST return `"flow-token-123"`

#### Scenario: saveFlowTokens writes flow keys without removing Graph keys

- GIVEN a token file with `access_token: "graph-token"` and `refresh_token: "graph-refresh"`
- WHEN `tokenStorage.saveFlowTokens({ access_token: "flow-token", refresh_token: "flow-refresh", expires_in: 3600 })` is called
- THEN the file MUST contain both `access_token: "graph-token"` AND `flow_access_token: "flow-token"`
- AND the Graph keys MUST be unmodified

#### Scenario: saveFlowTokens handles initial acquisition response

- GIVEN a token file with valid Graph tokens and no `flow_` keys
- WHEN `tokenStorage.saveFlowTokens()` is called with the token response from the `/auth/flow` callback
- THEN `flow_access_token`, `flow_refresh_token`, and `flow_expires_at` MUST be added to the token file
- AND the Graph keys MUST remain unchanged
- AND `flow_refresh_token` MUST be stored for future refresh operations

#### Scenario: isFlowTokenExpired returns true for expired flow token

- GIVEN `flow_expires_at` is `Date.now() - 60000`
- WHEN `tokenStorage.isFlowTokenExpired()` is called
- THEN it MUST return `true`

#### Scenario: getValidFlowAccessToken attempts refresh on expiry

- GIVEN a token file with expired `flow_access_token` and a valid `flow_refresh_token`
- WHEN `tokenStorage.getValidFlowAccessToken()` is called
- THEN it MUST call `refreshFlowAccessToken()`
- AND it MUST return the refreshed access token on success

#### Scenario: getValidFlowAccessToken returns null when no flow_refresh_token exists

- GIVEN a token file with expired `flow_access_token` and no `flow_refresh_token`
- WHEN `tokenStorage.getValidFlowAccessToken()` is called
- THEN it MUST return `null`
- AND it MUST NOT attempt an OAuth refresh

#### Scenario: getValidFlowAccessToken returns null when refresh fails

- GIVEN a token file with expired `flow_access_token` and a `flow_refresh_token`
- WHEN `getValidFlowAccessToken()` calls `refreshFlowAccessToken()` and it throws
- THEN it MUST return `null`
- AND flow tokens MUST be invalidated in the token file

#### Scenario: getValidFlowAccessToken loads tokens from file when not cached

- GIVEN a token file with `flow_access_token: "file-flow-token"` and `flow_expires_at` in the future
- WHEN `tokenStorage.getValidFlowAccessToken()` is called with `this.tokens` null
- THEN it MUST load tokens from the file
- AND it MUST return `"file-flow-token"`
