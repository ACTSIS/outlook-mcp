# Flow Token Management Specification

## Purpose

Define the behavior of Power Automate (Flow) token lifecycle within TokenStorage: storage, retrieval, expiry checking, and backwards-compatible key access. Flow tokens use `flow_`-prefixed keys in the same token file as Graph tokens.

## Requirements

### Requirement: Flow Token Storage

`saveFlowTokens()` MUST write `flow_access_token`, `flow_refresh_token`, and `flow_expires_at` keys into the existing token file without removing Graph token keys.

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

### Requirement: Flow Token Retrieval

`getFlowAccessToken()` MUST return the `flow_access_token` value if it exists and is not expired.

#### Scenario: Returns valid flow token

- GIVEN a token file with `flow_access_token: "abc"` and `flow_expires_at` in the future
- WHEN `getFlowAccessToken()` is called
- THEN it MUST return `"abc"`

#### Scenario: Returns null when flow token is expired

- GIVEN a token file with `flow_access_token: "abc"` and `flow_expires_at` in the past
- WHEN `getFlowAccessToken()` is called
- THEN it MUST return `null`

#### Scenario: Returns null when no flow token exists

- GIVEN a token file with only Graph keys (no `flow_` keys)
- WHEN `getFlowAccessToken()` is called
- THEN it MUST return `null`

### Requirement: Flow Token Expiry

`isFlowTokenExpired()` MUST return `true` when `flow_expires_at` is in the past or absent, applying the same refresh buffer as Graph tokens.

#### Scenario: Expired flow token reports expired

- GIVEN `flow_expires_at` is `Date.now() - 60000`
- WHEN `isFlowTokenExpired()` is called
- THEN it MUST return `true`

#### Scenario: Valid flow token reports not expired

- GIVEN `flow_expires_at` is `Date.now() + 3600000`
- WHEN `isFlowTokenExpired()` is called
- THEN it MUST return `false`

### Requirement: No Flow Auto-Refresh

`getValidFlowAccessToken()` MUST return `null` for expired Flow tokens without attempting a refresh, preserving the current behavior from `token-manager.js`.

#### Scenario: Expired flow token returns null without refresh

- GIVEN a token file with expired `flow_access_token` and a valid `flow_refresh_token`
- WHEN `getValidFlowAccessToken()` is called
- THEN it MUST return `null`
- AND it MUST NOT call any OAuth token endpoint

### Requirement: Backwards Compatibility

Existing token files with `flow_` keys created by `token-manager.js` MUST be readable by the new TokenStorage methods without modification.

#### Scenario: Reads flow keys from existing token file

- GIVEN a token file at `~/.outlook-mcp-tokens.json` with `flow_access_token`, `flow_refresh_token`, `flow_expires_at` keys
- WHEN `getFlowAccessToken()` is called
- THEN it MUST return the same value as the old `tokenManager.getFlowAccessToken()` would have returned
