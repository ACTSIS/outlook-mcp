# SDD Archive Report: add-email-date-filter

**Date**: 2026-09-15
**Status**: archived
**Archive path**: `openspec/changes/archive/2026-09-15-add-email-date-filter/`

## Executive Summary

The `add-email-date-filter` change has been fully implemented, verified, and archived. `list-emails` and `search-emails` now accept optional `receivedAfter`/`receivedBefore` ISO 8601 parameters filtered on `receivedDateTime` via a shared Graph `$filter` builder (`email/date-filter.js`), with emission-first predicate ordering, `count=0` full nextLink sweep semantics, a structural `$filter`-never-combined-with-`$search` gate, `config.MAX_RESULT_COUNT` defaults, client-side date validation, and test-mode `$filter` support. All 7 requirements and 15 scenarios are implemented and test-covered. Final test evidence: 696/696 passing on the recorded evidence command (environmental suites excluded); lint exit 0.

## Final-State Authority Record

The persisted `verify-report.md` in this archive describes the post-remediation state at
close; final-state facts below were corroborated by the orchestrator launch prompt and
memory observation #24. Where the report and later facts overlapped, they agree.

## Verification Verdict

| Field                 | Value                                                                                                                                                                                                                                                                                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Verdict               | **PASS WITH WARNINGS** (validator-admitted)                                                                                                                                                                                                                                                                                                                |
| First attempt         | FAIL — R3 scenario "$search path caps at 1,000" untested/unimplemented                                                                                                                                                                                                                                                                                     |
| Remediation           | Commit `94ae85b` — `MAX_SEARCH_RESULT_COUNT = 1000` clamp on `$search`-bearing paths only (`searchPathMaxCount()`, guarded by `params.$search` presence), count=0 passthrough preserved on non-`$search` paths, `_searchInfo.capReached` flag, cap communicated in response text and tool descriptions, 6 new passing tests in `test/email/search.test.js` |
| Evidence command      | `npx jest --testPathIgnorePatterns /test/build/linux-packaging /test/signature/store`                                                                                                                                                                                                                                                                      |
| Tests                 | 696/696 passing (41 suites); remediation delta +6 tests (689 → 695 → 696 accounting reflects suite-count shift; full-suite `npm test` = 701 passed / 4 failed / 705 total)                                                                                                                                                                                 |
| Pre-existing failures | 4, environmental on Windows, verified unrelated at base `7ba8ddd` and unchanged by remediation: `test/build/linux-packaging.test.js` ×3 (bash -n / executable bits), `test/signature/store.test.js` ×1 (fs mode 438 vs 0o600)                                                                                                                              |
| Lint                  | exit 0                                                                                                                                                                                                                                                                                                                                                     |
| Prettier              | Content-compliant after CRLF normalization; in-repo `format:check` warnings are the pre-existing `core.autocrlf=true` environment issue, not content drift                                                                                                                                                                                                 |
| Requirements          | 7/7                                                                                                                                                                                                                                                                                                                                                        |
| Scenarios             | 15/15 compliant with passing runtime evidence                                                                                                                                                                                                                                                                                                              |

### Warnings Carried Forward (advisory, non-blocking)

1. **R5 evidence depth**: no test re-stubs `config.MAX_RESULT_COUNT` to a different value at runtime; covering tests assert the constant alongside the emitted limit.
2. **Pre-existing hardcoded page caps**: `Math.min(50, maxCount)` page-size caps in `search.js` no-date paths predate this change; page caps, not default limits — recorded for the orchestrator, no action required for this verdict.

### Suggestions Recorded

1. The capReached note's literal cap-message string is not explicitly asserted in response text.
2. Repo-wide `npm run format:check` remains pre-existing-broken under CRLF; task text should reference the scoped Prettier check convention.

## Specs Synced

| Domain  | Action      | Details                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `email` | **Updated** | Appended all 7 ADDED requirements with their 15 scenarios to `openspec/specs/email/spec.md` (Date-Filtered Listing Parameters; Filter Compilation and Predicate Ordering; Full-Sweep Semantics for count=0; Search Strategy Routing for Date Filters; Configurable Default Result Count; Client-Side Date Validation; Test-Mode Filter Support). Canonical grew from 7 requirements / 12 scenarios to 14 requirements / 27 scenarios; no pre-existing requirement or scenario was modified or removed (verified: 115-line pure insertion; zero missing/duplicate requirement and scenario names). |

## Archive Contents

| Artifact              | Status | Notes                                                                              |
| --------------------- | ------ | ---------------------------------------------------------------------------------- |
| `proposal.md`         | ✅     | Intent, scope, risks, rollback plan                                                |
| `specs/email/spec.md` | ✅     | Delta spec (ADDED-only, 7 requirements) — merged into canonical email spec         |
| `design.md`           | ✅     | Decisions D1–D5, module and integration design                                     |
| `tasks.md`            | ✅     | 10/10 tasks complete (Phase 4 task 4.1 completed by post-remediation verification) |
| `verify-report.md`    | ✅     | PASS WITH WARNINGS, validator-admitted, post-remediation                           |
| `explore.md`          | ✅     | Exploration artifact                                                               |
| `research.md`         | ✅     | Graph capability research (research.md Q1–Q6)                                      |
| `archive-report.md`   | ✅     | This report (additive; not present in the pre-move snapshot)                       |

### Task Completion Gate

No reconciliation was required: the persisted `tasks.md` contains 9 numbered tasks across
4 phases, all checked (`[x]`), with 0 unchecked. Phase 4 task 4.1 was marked complete by
the post-remediation verification itself, per the verify phase.

## Source of Truth Updated

- `openspec/specs/email/spec.md` — now includes the 7 date-filter requirements appended after the existing folder-utilities and attachment-metadata requirements.

## Commits (feature/add-email-date-filter, in order)

- `a338fd4` feat(email): add ISO date filter builder with date-first combinator
- `1cef9ec` feat(email): add receivedAfter/receivedBefore params and count semantics to schemas
- `e52378e` feat(email): apply date filters in list-emails with count=0 sweep
- `ce63328` feat(email): route date-filtered search through $filter-only strategy
- `94ae85b` fix(email): cap $search-path sweeps at 1000 results

HEAD at archive time: `94ae85b`. Conventional commits, no AI attribution.

## Engram Observations (traceability)

| Observation                           | ID                      | Topic                                      |
| ------------------------------------- | ----------------------- | ------------------------------------------ |
| Verify report (post-remediation PASS) | #24                     | `sdd/add-email-date-filter/verify-report`  |
| Verify-phase session summary          | #23                     | session summary                            |
| Slice-2 session summary               | #20                     | session summary                            |
| Archive report                        | (saved at archive time) | `sdd/add-email-date-filter/archive-report` |

## Mechanical Verification

- Delta → canonical merge: 115-line pure insertion; requirement/scenario name readback confirmed all 7 delta requirements and 15 scenarios present, none missing, none duplicated, no pre-existing requirement altered.
- Archive move: recursive pre-move snapshot compared against the archived tree with `git diff --no-index` → exit 0, empty diff (byte-identical). The source directory is absent; destination collision guard passed; snapshot removed after readback.

## Risks

- **Low**: Live-Graph confirmation of success criterion 1 (both tools return date-filtered results from live Graph) remains a runtime item; verified at mock + handler-param test level per the verify report.
- **Low**: R5 evidence-depth warning (config re-stub test absent) — advisory only.
- **None new**: delivery (PR/merge of `feature/add-email-date-filter`) follows ordinary repository policy and is a human decision.

## SDD Cycle Complete

The change has been fully planned, implemented, verified, and archived. Ready for the next change.
