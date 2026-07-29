# Delta for Power Automate

## ADDED Requirements

### Requirement: Initial Token Acquisition Guidance

Power Automate handlers that detect missing or expired Flow tokens MUST surface a clear message directing the user to use the `authenticate-flow` tool before retrying.

#### Scenario: Missing flow token suggests authenticate-flow

- GIVEN a Power Automate handler calls `getValidFlowAccessToken()` and it returns `null`
- WHEN the handler prepares its error response
- THEN the response MUST include a message directing the user to use the `authenticate-flow` tool
- AND the message MUST include the URL `http://localhost:3333/auth/flow`

#### Scenario: Expired flow token with no refresh token suggests authenticate-flow

- GIVEN a token file with expired `flow_access_token` and no `flow_refresh_token`
- WHEN a Power Automate handler calls `getValidFlowAccessToken()`
- THEN the handler MUST return an error indicating Flow re-authentication is needed
- AND the error MUST reference the `authenticate-flow` tool

## MODIFIED Requirements

### Requirement: Flow Token Storage

`saveFlowTokens()` MUST write `flow_access_token`, `flow_refresh_token`, and `flow_expires_at` keys into the existing token file without removing Graph token keys.
(Previously: Only documented manual token injection; initial acquisition via OAuth callback was not covered)

#### Scenario: Save flow tokens merges with existing Graph tokens

- GIVEN a token file containing `access_token`, `refresh_token`, `expires_at`
- WHEN `saveFlowTokens({ access_token, refresh_token, expires_in })` is called
- THEN the file MUST contain both the original Graph keys AND `flow_access_token`, `flow_refresh_token`, `flow_expires_at`
- AND the Graph keys MUST be unchanged

#### Scenario: Save flow tokens creates file if missing

- GIVEN no token file exists at the configured path
- WHEN `saveFlowTokens({ access_token, refresh_token, expires_in })` is called
- THEN a new token file MUST be created with the `flow_` keys
- AND the file MUST be valid JSON

### Requirement: Flow Token Refresh

TokenStorage MUST provide `refreshFlowAccessToken()` that calls the Microsoft token endpoint with `grant_type=refresh_token` using the stored `flow_refresh_token` and `FLOW_SCOPE` from config. Concurrent calls MUST be deduplicated via a dedicated `_flowRefreshPromise`.
(Previously: No refresh capability existed for Flow tokens)

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
