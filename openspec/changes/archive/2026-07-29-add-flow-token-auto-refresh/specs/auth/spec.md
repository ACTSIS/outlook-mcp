# Delta for Auth

## ADDED Requirements

### Requirement: Flow Token Refresh

TokenStorage MUST provide `refreshFlowAccessToken()` that calls the Microsoft token endpoint with `grant_type=refresh_token` using the stored `flow_refresh_token` and `FLOW_SCOPE` from config. Concurrent calls MUST be deduplicated via a dedicated `_flowRefreshPromise`.

#### Scenario: Successful refresh returns new access token

- GIVEN a token file with `flow_refresh_token: "valid-flow-refresh"` and `flow_access_token` expired
- WHEN `tokenStorage.refreshFlowAccessToken()` is called
- THEN the POST body MUST include `grant_type=refresh_token`, `refresh_token=valid-flow-refresh`, and `scope=https://service.flow.microsoft.com/.default`
- AND `flow_access_token` and `flow_expires_at` MUST be updated in the token file
- AND it MUST return the new `flow_access_token`

#### Scenario: Concurrent refresh calls share a single HTTP request

- GIVEN two concurrent calls to `refreshFlowAccessToken()` while the token is expired
- WHEN both calls are made
- THEN only one HTTP request SHALL be sent to the token endpoint
- AND both calls SHALL resolve with the same access token
- AND `_flowRefreshPromise` SHALL be null after resolution

#### Scenario: Refresh token rotation preserves new flow_refresh_token

- GIVEN a token file with `flow_refresh_token: "old-flow-refresh"`
- WHEN `refreshFlowAccessToken()` returns a response with a new `refresh_token`
- THEN `flow_refresh_token` MUST be updated to the new value in the token file

#### Scenario: Refresh without rotation preserves existing flow_refresh_token

- GIVEN a token file with `flow_refresh_token: "existing-flow-refresh"`
- WHEN `refreshFlowAccessToken()` returns a response without a `refresh_token` field
- THEN `flow_refresh_token` MUST remain `"existing-flow-refresh"` unchanged

#### Scenario: Refresh failure invalidates flow tokens

- GIVEN a token file with `flow_refresh_token: "invalid-refresh"` and `flow_access_token` expired
- WHEN `refreshFlowAccessToken()` is called and the token endpoint returns an error
- THEN `flow_access_token` and `flow_refresh_token` MUST be cleared from the token file
- AND the method MUST throw an error

#### Scenario: Missing flow_refresh_token throws error

- GIVEN a token file with no `flow_refresh_token`
- WHEN `refreshFlowAccessToken()` is called
- THEN it MUST throw an error indicating no refresh token is available

## MODIFIED Requirements

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
