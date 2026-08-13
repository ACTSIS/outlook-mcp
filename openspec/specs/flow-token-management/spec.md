# Flow Token Management Specification

## Purpose

Define acquisition, shared-file persistence, validity, refresh, rotation, concurrency, and failure handling for Power Automate credentials managed by TokenStorage.

## Requirements

### Requirement: Separate Flow Authorization

The productive auth server MUST acquire Flow credentials through `/auth/flow` using only `config.FLOW_SCOPE` and MUST bind the resulting callback to Flow through OAuth state metadata.

#### Scenario: Flow authorization starts

- GIVEN the auth server has valid Microsoft identity credentials
- WHEN a client requests `GET /auth/flow`
- THEN the server MUST redirect to Microsoft identity with scope `https://service.flow.microsoft.com/.default`
- AND it MUST store `{ flow: true }` with the generated CSRF state

#### Scenario: Flow code is exchanged

- GIVEN the callback contains a valid state marked as Flow
- WHEN the server exchanges its authorization code
- THEN the exchange MUST use `config.FLOW_SCOPE`
- AND the token response MUST be passed to `TokenStorage.saveFlowTokens()`

### Requirement: Shared Token File

Flow and Graph credentials MUST coexist in `~/.outlook-mcp-tokens.json`. Flow fields MUST use the `flow_` prefix, and Flow-specific writes MUST preserve Graph fields.

#### Scenario: Initial Flow credentials are saved

- GIVEN existing Graph credentials or an absent token file
- WHEN `saveFlowTokens()` receives an access token, refresh token, and lifetime
- THEN it MUST save `flow_access_token`, `flow_refresh_token`, and `flow_expires_at`
- AND it MUST preserve existing Graph keys
- AND the resulting file MUST be valid JSON created with mode `0600`

#### Scenario: Initial response omits a refresh token

- GIVEN stored Flow credentials already contain `flow_refresh_token`
- WHEN `saveFlowTokens()` receives a response without `refresh_token`
- THEN it MUST retain the existing `flow_refresh_token`

### Requirement: Flow Token Validity

Flow access tokens MUST be considered unusable when absent, when `flow_expires_at` is absent, or when the expiry falls within the five-minute refresh buffer.

#### Scenario: Flow access token remains valid

- GIVEN `flow_access_token` exists and `flow_expires_at` is more than five minutes in the future
- WHEN `getFlowAccessToken()` or `getValidFlowAccessToken()` is called
- THEN it MUST return the stored Flow access token
- AND it MUST NOT call the token endpoint

#### Scenario: Flow token is missing

- GIVEN no `flow_access_token` exists
- WHEN `getValidFlowAccessToken()` is called
- THEN it MUST return `null`
- AND it MUST NOT call the token endpoint

### Requirement: Conditional Flow Refresh

An expired or near-expiry Flow token MUST be refreshed only when `flow_refresh_token` is available.

#### Scenario: Expired Flow token can be refreshed

- GIVEN an unusable Flow access token and a stored `flow_refresh_token`
- WHEN `getValidFlowAccessToken()` is called
- THEN it MUST call `refreshFlowAccessToken()`
- AND it MUST return the refreshed access token on success

#### Scenario: Expired Flow token cannot be refreshed

- GIVEN an unusable Flow access token and no `flow_refresh_token`
- WHEN `getValidFlowAccessToken()` is called
- THEN it MUST return `null`
- AND it MUST NOT call the token endpoint

### Requirement: Flow Refresh Request

`refreshFlowAccessToken()` MUST call the configured Microsoft token endpoint with a 30-second timeout, the stored Flow refresh token, and `config.FLOW_SCOPE`.

#### Scenario: Token endpoint returns success

- GIVEN a stored `flow_refresh_token`
- WHEN the Flow refresh request succeeds
- THEN the request MUST use `grant_type=refresh_token`
- AND it MUST include the configured client credentials and `https://service.flow.microsoft.com/.default`
- AND TokenStorage MUST persist the new `flow_access_token` and `flow_expires_at`

#### Scenario: Flow refresh token rotates

- GIVEN Microsoft returns a new `refresh_token`
- WHEN the successful refresh is saved
- THEN `flow_refresh_token` MUST be replaced by the returned value

#### Scenario: Flow refresh token does not rotate

- GIVEN Microsoft omits `refresh_token` from a successful response
- WHEN the refreshed credentials are saved
- THEN the existing `flow_refresh_token` MUST be preserved

### Requirement: Independent Refresh Deduplication

Concurrent Flow refreshes MUST share a dedicated `_flowRefreshPromise` that is independent from Graph's `_refreshPromise`.

#### Scenario: Multiple callers need a Flow refresh

- GIVEN a Flow refresh is already in progress
- WHEN another caller requests a Flow refresh
- THEN only one token-endpoint request SHALL be sent
- AND all callers SHALL receive the same refreshed access token
- AND `_flowRefreshPromise` MUST be cleared after success or failure

#### Scenario: Graph and Flow refresh concurrently

- GIVEN Graph and Flow tokens both require refresh
- WHEN both refresh operations start
- THEN neither operation MUST reuse or block on the other resource's refresh promise

### Requirement: Selective Permanent-Failure Invalidation

Only a permanent OAuth `invalid_grant` response MUST invalidate persisted Flow credentials. Transient failures MUST preserve them for a later retry.

#### Scenario: Refresh token is permanently rejected

- GIVEN the token endpoint responds with HTTP 400 and error `invalid_grant`
- WHEN `refreshFlowAccessToken()` processes the response
- THEN it MUST set `flow_access_token` and `flow_refresh_token` to `null`
- AND it MUST persist that Flow-only invalidation
- AND Graph credentials MUST remain unchanged
- AND the request MUST fail

#### Scenario: Token endpoint has a transient failure

- GIVEN a network error, timeout, malformed response, or non-`invalid_grant` HTTP error
- WHEN the refresh fails
- THEN Flow credentials MUST remain stored
- AND Graph credentials MUST remain unchanged
- AND `getValidFlowAccessToken()` MUST return `null` for that attempt

### Requirement: Singleton Consumer

All five Power Automate handlers MUST obtain credentials from the singleton TokenStorage exported by `auth/index.js`.

#### Scenario: A Power Automate handler needs a token

- GIVEN any of `flow-list-environments`, `flow-list`, `flow-run`, `flow-list-runs`, or `flow-toggle`
- WHEN the handler prepares an API request
- THEN it MUST call `tokenStorage.getValidFlowAccessToken()`
- AND it MUST NOT read the token file or use `token-manager.js` directly

## Known Implementation Gaps (Non-Normative)

- Graph re-authentication currently replaces the shared token file and can erase otherwise valid `flow_*` credentials.
- Test-mode `authenticate-flow` creates only Graph-style test fields, so its success message does not establish the same credential shape as productive Flow authentication.

See [`../../traceability.md`](../../traceability.md) for the archive synchronization history behind this canonical domain.
