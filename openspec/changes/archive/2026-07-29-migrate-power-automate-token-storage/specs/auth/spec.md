# Delta for Auth

## ADDED Requirements

### Requirement: Flow Token Methods in TokenStorage

TokenStorage MUST provide `getFlowAccessToken()`, `saveFlowTokens()`, `isFlowTokenExpired()`, and `getValidFlowAccessToken()` methods that read/write `flow_`-prefixed keys in the same token file.

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

#### Scenario: getValidFlowAccessToken returns null for expired flow token

- GIVEN a token file with expired `flow_access_token` and a valid `flow_refresh_token`
- WHEN `tokenStorage.getValidFlowAccessToken()` is called
- THEN it MUST return `null`
- AND it MUST NOT attempt an OAuth refresh

### Requirement: Five Handler Import Migration

All five power-automate handlers MUST import Flow token access from `auth/token-storage` instead of `auth/token-manager`.

#### Scenario: All handlers import from token-storage

- GIVEN `power-automate/list-environments.js`, `list-flows.js`, `list-runs.js`, `run-flow.js`, `toggle-flow.js`
- WHEN each file's imports are inspected
- THEN each MUST import `getFlowAccessToken` from `../auth/token-storage`
- AND none MUST import `getFlowAccessToken` from `../auth/token-manager`

### Requirement: token-manager.js Retention

`token-manager.js` MUST retain only `createTestTokens()` and remove `getFlowAccessToken()` and `saveFlowTokens()`.

#### Scenario: createTestTokens still works

- GIVEN `token-manager.js` after the migration
- WHEN `tokenManager.createTestTokens()` is called
- THEN it MUST create test tokens and save them to the token file
- AND it MUST return the test token object

#### Scenario: Flow methods removed from token-manager exports

- GIVEN `token-manager.js` after the migration
- WHEN `module.exports` is inspected
- THEN it MUST NOT include `getFlowAccessToken` or `saveFlowTokens`
- AND it MUST include `createTestTokens`
