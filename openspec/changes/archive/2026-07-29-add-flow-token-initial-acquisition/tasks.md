# Tasks: Add Flow Token Initial Acquisition

## Review Workload Forecast

| Field                   | Value      |
| ----------------------- | ---------- |
| Estimated changed lines | ~290       |
| 400-line budget risk    | Medium     |
| Chained PRs recommended | No         |
| Suggested split         | Single PR  |
| Delivery strategy       | auto-chain |
| Chain strategy          | pending    |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: pending
400-line budget risk: Medium

### Suggested Work Units

| Unit | Goal                                                           | Likely PR | Focused test command                                                   | Runtime harness                                            | Rollback boundary                                                    |
| ---- | -------------------------------------------------------------- | --------- | ---------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------- |
| 1    | Full Flow token acquisition: auth server + tool + tests + docs | PR 1      | `npx jest test/auth/oauth-server-flow.test.js test/auth/tools.test.js` | `npm run auth-server` then invoke `authenticate-flow` tool | Revert `outlook-auth-server.js`, `auth/tools.js`, test files, README |

## Phase 1: Foundation — Auth Server Changes (RED tests first)

- [x] 1.1 RED: Write test for callback detects Flow via `pendingStates.get(state).flow` before exchange (oauth-server-flow.test.js)
- [x] 1.2 RED: Write test for `exchangeCodeForTokens(code, true)` uses `FLOW_SCOPE` in POST body
- [x] 1.3 RED: Write test for Flow exchange calls `tokenStorage.saveFlowTokens()`, NOT `fs.writeFileSync`
- [x] 1.4 RED: Write test for Flow exchange preserves existing Graph keys in token file
- [x] 1.5 RED: Write regression test: `exchangeCodeForTokens(code, false)` unchanged (raw `fs.writeFileSync`)
- [x] 1.6 RED: Write test for `/auth/flow` route generates 302 redirect with `scope=FLOW_SCOPE`
- [x] 1.7 RED: Write test for `pendingStates` cleanup works with `{timestamp, flow}` objects
- [x] 1.8 GREEN: Change `pendingStates` values from `timestamp` to `{timestamp, flow: boolean}` in outlook-auth-server.js; update cleanup interval to use `entry.timestamp`
- [x] 1.9 GREEN: Add `isFlow` param to `exchangeCodeForTokens(code, isFlow = false)`; Flow path calls `tokenStorage.saveFlowTokens()`, Graph path unchanged
- [x] 1.10 GREEN: Import `tokenStorage` singleton from `./auth/index` in outlook-auth-server.js

## Phase 2: Core Implementation — /auth/flow Route & Tool

- [x] 2.1 RED: Write test for `handleAuthenticateFlow` returns URL containing `/auth/flow` (tools.test.js)
- [x] 2.2 GREEN: Add `GET /auth/flow` route in outlook-auth-server.js — generates OAuth URL with `FLOW_SCOPE`, stores `{timestamp, flow: true}` in pendingStates
- [x] 2.3 GREEN: Add `handleAuthenticateFlow` handler + `authenticate-flow` tool definition in auth/tools.js
- [x] 2.4 GREEN: Wire Flow detection in `/auth/callback` — lookup `pendingStates.get(state).flow`, pass `isFlow=true` to exchangeCodeForTokens, show "Flow authentication" success page

## Phase 3: Testing — Integration & Regression

- [x] 3.1 Run `npm test` and verify all existing + new tests pass
- [x] 3.2 Verify Flow auth failure does not corrupt Graph tokens (error page path)
- [x] 3.3 Verify test mode: `handleAuthenticateFlow` with `USE_TEST_MODE=true` creates test tokens

## Phase 4: Documentation

- [x] 4.1 Update README.md: document `authenticate-flow` tool in Power Automate section with usage example
