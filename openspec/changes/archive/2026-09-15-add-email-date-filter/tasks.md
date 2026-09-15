# Tasks: add-email-date-filter

## Review Workload Forecast

| Field                   | Value                                     |
| ----------------------- | ----------------------------------------- |
| Estimated changed lines | ~590 (≈230 production, ≈360 tests)        |
| 400-line budget risk    | Medium (under orchestrator budget of 800) |
| Chained PRs recommended | Yes                                       |
| Suggested split         | PR 1 → PR 2 → PR 3 (feature-branch-chain) |
| Delivery strategy       | auto-chain                                |
| Chain strategy          | feature-branch-chain                      |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: Medium

Chain resolution (actsis-sgc-sdd-vcs-delivery): Git repo → tracker branch `feature/add-email-date-filter`; PR 1 base = tracker, PR 2 base = PR 1 branch, PR 3 base = PR 2 branch. Only the tracker merges to main/develop. Total (~590) fits the 800-line review budget; chaining is for review focus, not size exception.

### Suggested Work Units

| Unit | Goal                                                       | Likely PR | Focused test command                                         | Runtime harness                                                                   | Rollback boundary                                  |
| ---- | ---------------------------------------------------------- | --------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------- | -------------------------------------------------- |
| 1    | Date-filter module + schemas                               | PR 1      | `npx jest test/email/date-filter.test.js`                    | N/A — pure unit module, no runtime path yet                                       | New files + schema keys; delete to revert          |
| 2    | list-emails dates, count=0, config default; mock `$filter` | PR 2      | `npx jest test/email/list.test.js`                           | `USE_TEST_MODE=true npm run test-mode`, call `list-emails` with dates + `count:0` | Revert restores prior query shape; params additive |
| 3    | search-emails gate + degradation; full verification        | PR 3      | `npx jest test/email/search.test.js test/email/list.test.js` | `USE_TEST_MODE=true npm run test-mode`, call `search-emails` with terms+dates     | Revert restores strategy fallback chain            |

Conventional commits (no AI attribution):

- PR 1: `feat(email): add ISO date filter builder and tool schemas`
- PR 2: `feat(email): apply date filters in list-emails with count=0 sweep`
- PR 3: `feat(email): route date-filtered search through $filter-only strategy`

## Phase 1: Foundation — filter builder + schemas

- [x] 1.1 Create `email/date-filter.js`: `normalizeDateInput(value, paramName)` (date-only `receivedAfter` → `T00:00:00.000Z`, `receivedBefore` → `T23:59:59.999Z`; offsets → UTC `Z`; invalid → `Error` naming param with expected format, before any Graph call) + `buildDateFilter({receivedAfter, receivedBefore})` → `null` / `receivedDateTime ge X` / `ge X and le Y` (unquoted) + `combineFilterConditions(dateConditions, otherConditions)` placing dates FIRST (D1). Refs: R2, R6. Tests: 1.2. ~90 lines.
- [x] 1.2 Create `test/email/date-filter.test.js`: date-only both bounds, full ISO, offset→UTC, invalid throws naming param, single/both bounds, dates-before-booleans ordering. Refs: R2, R6. ~130 lines.
- [x] 1.3 Modify `email/index.js`: add optional `receivedAfter`/`receivedBefore` (string, ISO 8601) to both schemas; update `count` descriptions (default `config.MAX_RESULT_COUNT`; `count: 0` = full sweep without `$search`, capped 1,000 with `$search`). Refs: R1, R3. Test: schema-driven via 3.2. ~15 lines.

## Phase 2: list-emails integration + mock

- [x] 2.1 Modify `email/list.js`: build `dateFilter` before Graph call; `requestedCount = args.count === undefined ? config.MAX_RESULT_COUNT : args.count`; `maxCount = requestedCount === 0 ? 0 : requestedCount` (count=0 now passes through — current code coerces 0→10); `$top = requestedCount === 0 ? config.DEFAULT_PAGE_SIZE : Math.min(config.MAX_RESULT_COUNT, requestedCount)`; set `queryParams.$filter = dateFilter` when present. BEHAVIOR CHANGE: no-date default count changes 10 → `config.MAX_RESULT_COUNT` (50); no hardcoded 50/10 remains. Refs: R1, R3, R5, R6. Tests: 2.3. ~20 lines.
- [x] 2.2 Modify `utils/mock-data.js` (list branch): `filterMockMessages(list, _queryParams)` parsing `$filter` via exactly `/receivedDateTime\s+ge\s+(\S+)/` and `/receivedDateTime\s+le\s+(\S+)/` plus existing `hasAttachments eq true` / `isRead eq false` strings joined by `and`; `Date` comparisons; other `$filter` content ignored (documented limitation). Refs: R7. Tests: 2.3. ~45 lines.
- [x] 2.3 Extend `test/email/list.test.js`: `$filter` emitted with dates; `count=0` → `maxCount=0` passthrough to `callGraphAPIPaginated`; default limit = `config.MAX_RESULT_COUNT` (assert 50, not 10); invalid date errors with no Graph call; mock honors `$filter` (R7). Refs: R1, R3, R5, R6, R7. ~80 lines.

## Phase 3: search-emails gate + degradation

- [x] 3.1 Modify `email/search.js`: normalize/validate dates fail-fast in `handleSearchEmails`, pass `dateFilter` into `progressiveSearch`; hard gate: `dateFilter` present → SKIP strategies 1–2 (all `$search` paths, structurally); terms present → filter-only params (`$select`, NO `$orderby`), `$filter = combineFilterConditions(...)` (dates first), set `_searchInfo.degradedKeywordSearch = true`, and `formatSearchResults` appends "(Keyword search was not applied: date filters cannot be combined with $search in Graph API)"; no terms → strategy-3 shape + `$orderby: 'receivedDateTime desc'`; default count = `config.MAX_RESULT_COUNT`; `addBooleanFiltersAsKQL` untouched. Refs: R1, R2, R4, R5, R6. Tests: 3.2. ~60 lines.
- [x] 3.2 Create `test/email/search.test.js`: date-only → `$filter`+`$orderby`, NO `$search`; terms+dates → `$filter` only (no `$search`/`$orderby`) + degradation note in text; never-combined assertion over every input combination (mocked `callGraphAPIPaginated` param inspection); no-dates behavior unchanged; auth/folder errors. Refs: R4 (plus R1 regression). ~150 lines.

## Phase 4: Verification

- [x] 4.1 Run full `npm test`, `npm run lint`, `npm run format:check` (Prettier 100-col); confirm proposal success criteria (no `$filter`+`$search` anywhere; no hardcoded 50/10 defaults in handlers; Graph transport tests in `test/utils/graph-api.test.js` and token tests in `test/auth/` untouched per CLAUDE.md testing map). Refs: all. 0 lines. — Completed by post-remediation verification (commit 94ae85b): evidence command `npx jest --testPathIgnorePatterns /test/build/linux-packaging /test/signature/store` → 696/696 pass (the 4 excluded failures are pre-existing Windows-environment failures); lint exit 0; scoped Prettier check clean after CRLF normalization; verdict PASS WITH WARNINGS recorded in `verify-report.md`.
