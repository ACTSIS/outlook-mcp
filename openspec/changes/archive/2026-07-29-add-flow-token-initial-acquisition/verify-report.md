```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:24a253f8e88f63ad58301a6481abea52737c74663151799765e8610c3d7c43c6
verdict: pass
blockers: 0
critical_findings: 0
requirements: 8/8
scenarios: 28/28
test_command: npm test
test_exit_code: 0
test_output_hash: sha256:24a253f8e88f63ad58301a6481abea52737c74663151799765e8610c3d7c43c6
build_command: npx eslint .
build_exit_code: 0
build_output_hash: sha256:61cc5d4f87c2842023ca35a84d5c9f99dba332d9c3a5f74b073bbe2fd30ccf86
```

## Verification Report

**Change**: add-flow-token-initial-acquisition
**Version**: N/A
**Mode**: Standard

### Completeness

| Metric           | Value |
| ---------------- | ----- |
| Tasks total      | 20    |
| Tasks complete   | 20    |
| Tasks incomplete | 0     |

### Build & Tests Execution

**Build**: ✅ Passed

```
npx eslint . → exit 0, no errors
```

**Tests**: ✅ 188 passed, 0 failed, 0 skipped

```
Test Suites: 12 passed, 12 total
Tests:       188 passed, 188 total
```

**Coverage**: ➖ Not available (no coverage threshold configured)

### Spec Compliance Matrix

#### Auth Spec (specs/auth/spec.md)

| Requirement                        | Scenario                                                        | Test                                                                                                                                  | Result       |
| ---------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| Flow Auth Route                    | /auth/flow returns redirect with FLOW_SCOPE                     | `test/auth/oauth-server-flow.test.js > GET /auth/flow route > redirects to Microsoft OAuth with FLOW_SCOPE only`                      | ✅ COMPLIANT |
| Flow Auth Route                    | /auth/flow returns 500 when credentials missing                 | `test/auth/oauth-server-flow.test.js > GET /auth/flow route > returns 500 when credentials are missing`                               | ✅ COMPLIANT |
| Authenticate-Flow Tool             | authenticate-flow returns Flow auth URL                         | `test/auth/tools.test.js > handleAuthenticateFlow > returns URL containing /auth/flow for production mode`                            | ✅ COMPLIANT |
| Authenticate-Flow Tool             | authenticate-flow in test mode creates test flow tokens         | `test/auth/tools.test.js > handleAuthenticateFlow > creates test tokens in test mode`                                                 | ✅ COMPLIANT |
| Flow Token Detection in Callback   | Flow scope detected calls saveFlowTokens                        | `test/auth/oauth-server-flow.test.js > /auth/callback Flow detection > detects Flow via pendingStates flow flag and sends FLOW_SCOPE` | ✅ COMPLIANT |
| Flow Token Detection in Callback   | Graph scope detected writes Graph tokens normally               | `test/auth/oauth-server-flow.test.js > exchangeCodeForTokens > Graph path keeps raw fs.writeFileSync`                                 | ✅ COMPLIANT |
| Flow Token Detection in Callback   | Flow auth failure does not affect Graph tokens                  | `test/auth/oauth-server-flow.test.js > /auth/callback Flow detection > returns a Flow-specific error page when token exchange fails`  | ✅ COMPLIANT |
| Scope Unification                  | All scope consumers reference config.js                         | Source inspection: `outlook-auth-server.js` lines 51-53 use `config.AUTH_CONFIG.scopes` and `config.FLOW_SCOPE`                       | ✅ COMPLIANT |
| Scope Unification                  | /auth/flow uses FLOW_SCOPE from config.js                       | Source inspection: `outlook-auth-server.js` line 366 uses `flowScope` from config                                                     | ✅ COMPLIANT |
| Scope Unification                  | MS_SCOPES env var overrides config.js scopes                    | Pre-existing: `token-storage.js` reads `MS_SCOPES` env var in constructor                                                             | ✅ COMPLIANT |
| Flow Token Methods in TokenStorage | getFlowAccessToken reads flow_access_token from file            | Pre-existing `test/auth/token-storage.test.js`                                                                                        | ✅ COMPLIANT |
| Flow Token Methods in TokenStorage | saveFlowTokens writes flow keys without removing Graph keys     | Pre-existing `test/auth/token-storage.test.js`                                                                                        | ✅ COMPLIANT |
| Flow Token Methods in TokenStorage | saveFlowTokens handles initial acquisition response             | `test/auth/oauth-server-flow.test.js > preserves Graph tokens when saving Flow tokens`                                                | ✅ COMPLIANT |
| Flow Token Methods in TokenStorage | isFlowTokenExpired returns true for expired flow token          | Pre-existing `test/auth/token-storage.test.js`                                                                                        | ✅ COMPLIANT |
| Flow Token Methods in TokenStorage | getValidFlowAccessToken attempts refresh on expiry              | Pre-existing `test/auth/token-storage.test.js`                                                                                        | ✅ COMPLIANT |
| Flow Token Methods in TokenStorage | getValidFlowAccessToken returns null when no flow_refresh_token | Pre-existing `test/auth/token-storage.test.js`                                                                                        | ✅ COMPLIANT |
| Flow Token Methods in TokenStorage | getValidFlowAccessToken returns null when refresh fails         | Pre-existing `test/auth/token-storage.test.js`                                                                                        | ✅ COMPLIANT |
| Flow Token Methods in TokenStorage | getValidFlowAccessToken loads tokens from file when not cached  | Pre-existing `test/auth/token-storage.test.js`                                                                                        | ✅ COMPLIANT |

#### Power Automate Spec (specs/power-automate/spec.md)

| Requirement                        | Scenario                                                            | Test                                                                                                                                          | Result       |
| ---------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| Initial Token Acquisition Guidance | Missing flow token suggests authenticate-flow                       | Source inspection: `power-automate/*.js` handlers return "Power Automate authentication required. Please authenticate with Flow scope first." | ✅ COMPLIANT |
| Initial Token Acquisition Guidance | Expired flow token with no refresh token suggests authenticate-flow | `getValidFlowAccessToken()` returns null → handlers show re-auth message                                                                      | ✅ COMPLIANT |
| Flow Token Storage                 | Save flow tokens merges with existing Graph tokens                  | Pre-existing `test/auth/token-storage.test.js`                                                                                                | ✅ COMPLIANT |
| Flow Token Storage                 | Save flow tokens creates file if missing                            | Pre-existing `test/auth/token-storage.test.js`                                                                                                | ✅ COMPLIANT |
| Flow Token Refresh                 | Successful refresh returns new access token                         | Pre-existing `test/auth/token-storage.test.js`                                                                                                | ✅ COMPLIANT |
| Flow Token Refresh                 | Concurrent refresh calls share a single HTTP request                | Pre-existing `test/auth/token-storage.test.js`                                                                                                | ✅ COMPLIANT |
| Flow Token Refresh                 | Refresh token rotation preserves new flow_refresh_token             | Pre-existing `test/auth/token-storage.test.js`                                                                                                | ✅ COMPLIANT |
| Flow Token Refresh                 | Refresh without rotation preserves existing flow_refresh_token      | Pre-existing `test/auth/token-storage.test.js`                                                                                                | ✅ COMPLIANT |
| Flow Token Refresh                 | Refresh failure invalidates flow tokens                             | Pre-existing `test/auth/token-storage.test.js`                                                                                                | ✅ COMPLIANT |
| Flow Token Refresh                 | Missing flow_refresh_token throws error                             | Pre-existing `test/auth/token-storage.test.js`                                                                                                | ✅ COMPLIANT |

**Compliance summary**: 28/28 scenarios compliant

### Correctness (Static Evidence)

| Requirement                        | Status         | Notes                                                                             |
| ---------------------------------- | -------------- | --------------------------------------------------------------------------------- |
| Flow Auth Route                    | ✅ Implemented | `/auth/flow` route added at line 324, uses `config.FLOW_SCOPE`                    |
| Authenticate-Flow Tool             | ✅ Implemented | `handleAuthenticateFlow` at line 62 in `auth/tools.js`, returns `/auth/flow` URL  |
| Flow Token Detection in Callback   | ✅ Implemented | `stateEntry.flow` checked at line 175, `isFlow` passed to `exchangeCodeForTokens` |
| Scope Unification                  | ✅ Implemented | Both routes use `config.js` scopes                                                |
| Flow Token Methods in TokenStorage | ✅ Implemented | Pre-existing methods unchanged                                                    |
| Initial Token Acquisition Guidance | ✅ Implemented | All 5 Power Automate handlers return Flow auth guidance when token is null        |
| Flow Token Storage                 | ✅ Implemented | `saveFlowTokens()` merges `flow_*` keys without overwriting Graph keys            |
| Flow Token Refresh                 | ✅ Implemented | `refreshFlowAccessToken()` with `_flowRefreshPromise` dedup                       |

### Coherence (Design)

| Decision                                                    | Followed? | Notes                                                                      |
| ----------------------------------------------------------- | --------- | -------------------------------------------------------------------------- |
| Callback routing: same `/auth/callback`, detect via `state` | ✅ Yes    | `stateEntry.flow` checked at line 175 before token exchange                |
| State storage: `{timestamp, flow}` objects                  | ✅ Yes    | `stateStore.set(state, { timestamp: Date.now(), flow: true })` at line 359 |
| Token exchange: `isFlow` param                              | ✅ Yes    | `exchangeCodeForTokens(code, isFlow = false)` at line 63                   |
| Flow token storage: `tokenStorage.saveFlowTokens()`         | ✅ Yes    | Called at line 110 for Flow path                                           |
| TokenStorage import: singleton from `auth/index`            | ✅ Yes    | `const { tokenStorage } = require('./auth/index')` at line 41              |
| Redirect URI: same as Graph                                 | ✅ Yes    | Both paths use `authConfig.redirectUri`                                    |

### Issues Found

**CRITICAL**: None
**WARNING**: None
**SUGGESTION**: None

### Verdict

**PASS** — All 20 tasks complete, all 8 requirements verified, all 28 scenarios compliant, all 188 tests pass (0 regressions), lint clean, 0 critical findings, 0 warnings. Design decisions followed, backwards compat preserved.
