# Design: add-email-date-filter

## Context

`list-emails` and `search-emails` cannot target mail by date; reaching year-old mail sweeps every newer page (~200 calls for 10k messages at `email/list.js:27`'s hardcoded 50-page). `callGraphAPIPaginated(maxCount=0)` already supports unbounded nextLink sweeps (`utils/graph-api.js:141-194`), and `callGraphAPI` already URI-encodes `$filter` separately (`utils/graph-api.js:52-69`). Research (research.md Q1-Q6) confirms `receivedDateTime ge/le` is supported unquoted on both `/me/messages` and folder endpoints, nextLink preserves `$filter`, and the InefficientFilter rules constrain predicate ordering under `$orderby=receivedDateTime desc`.

## Goals / Non-Goals

**Goals**: date params on both tools; shared filter builder; `count=0` full sweep; `$filter`-only routing in search; `config.MAX_RESULT_COUNT` default; mock `$filter` support; `test/email/search.test.js`.

**Non-Goals**: `sentDateTime`, raw `$filter` passthrough, KQL date ranges (unverified, research Q4), relative dates, new pagination controls.

## Architecture Decisions

| #   | Decision                                                                                                                                   | Alternatives rejected               | Rationale                                                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Emission-first: date predicates lead `$filter`; keep `$orderby=receivedDateTime desc` when dates+booleans                                  | Drop `$orderby` when filter present | Research Q6: InefficientFilter requires orderby properties (receivedDateTime) to appear FIRST in `$filter`. Emitting dates first satisfies rules 1-3 while preserving the user-visible newest-first order. Dropping `$orderby` loses deterministic sort. Terms+dates path omits `$orderby` per spec (that path has no search sort anyway). |
| D2  | `$filter`-only gate: dates present → strategy 3 shape, `$search` never set                                                                 | KQL `received:<date>`               | KQL ranges UNVERIFIED (Q4); `$filter`+`$search` rejection documented in-code (`search.js:105`). Hard gate at strategy selection, not fallback.                                                                                                                                                                                             |
| D3  | `count=0` → `maxCount=0` passthrough; `$top` falls back to `config.DEFAULT_PAGE_SIZE` for sweeps                                           | Cap sweep page at MAX_RESULT_COUNT  | Transport already loops to exhaustion; `$top` is page-size efficiency only (1-1000 legal, Q5).                                                                                                                                                                                                                                             |
| D4  | Date-only `receivedAfter` → `T00:00:00.000Z`; date-only `receivedBefore` → `T23:59:59.999Z` (inclusive edge); offsets converted to UTC `Z` | Uniform `T00:00:00Z` for both       | Keeps "received before 2024-06-30" inclusive of that day's mail — least surprise for MCP clients; still UTC `Z` literals per spec.                                                                                                                                                                                                         |
| D5  | Handlers default to `config.MAX_RESULT_COUNT` when `count` absent (spec mandates); non-zero counts above 50 still paginate (unchanged)     | Cap requestedCount at 50            | Spec requirement "Configurable Default Result Count"; capping would regress existing >50 pagination.                                                                                                                                                                                                                                       |

## Module Design: `email/date-filter.js` (new)

```js
normalizeDateInput(value, paramName); // → '2024-01-01T00:00:00.000Z' | end-of-day for 'before'; throws Error(`Invalid receivedAfter: "..." is not a valid ISO 8601 date (e.g. 2024-01-31 or 2024-01-31T14:30:00Z)`)
buildDateFilter({ receivedAfter, receivedBefore }); // → null | 'receivedDateTime ge X' | 'receivedDateTime ge X and receivedDateTime le Y' (unquoted, Z literals)
```

- `normalizeDateInput`: accepts `YYYY-MM-DD` and full ISO 8601 (with or without offset); `new Date(value)` + NaN check + strict-ish shape check (`/^\d{4}-\d{2}-\d{2}/`); invalid → throws naming the offending param (spec: client-side, no Graph 400). Callers catch and route to the standard MCP error text response.
- `buildDateFilter`: no dates → `null` (absent params preserve behavior); composes with boolean predicates via a small `combineFilterConditions(dateConditions, otherConditions)` helper that places date conditions FIRST (D1).
- No state, no I/O — both handlers import it; zero duplication of normalization/emission logic.

## Integration Design

### `email/list.js`

After `resolveFolderPath`:

```
const dateFilter = buildDateFilter({ receivedAfter: args.receivedAfter, receivedBefore: args.receivedBefore });
```

- `requestedCount = args.count === undefined ? config.MAX_RESULT_COUNT : args.count` (D3/D5).
- `maxCount = requestedCount === 0 ? 0 : requestedCount`.
- `$top = requestedCount === 0 ? config.DEFAULT_PAGE_SIZE : Math.min(config.MAX_RESULT_COUNT, requestedCount)`.
- If `dateFilter`: `queryParams.$filter = dateFilter` (no boolean predicates exist here, so date conditions alone satisfy emission-first trivially).
- `count=0` semantics documented in the tool description update.

### `email/search.js`

`handleSearchEmails` normalizes/validates dates up front (fail-fast), then passes `dateFilter` into `progressiveSearch(endpoint, token, searchTerms, filterTerms, maxCount, dateFilter)`:

- **Gate at top of `progressiveSearch`**: if `dateFilter` is non-null, SKIP strategies 1 and 2 (all `$search` paths) entirely — this is the never-combined guarantee, enforced structurally (fallback cannot reach `$search` because the branch is skipped, not because an error occurred).
  - Terms present → degradation: build filter-only params (`$select`, NO `$orderby` per spec scenario), `$filter = combineFilterConditions(dateConditions, booleanConditions)`; attach `response._searchInfo.degradedKeywordSearch = true`; `formatSearchResults` appends: `(Keyword search was not applied: date filters cannot be combined with $search in Graph API)`.
  - No terms → filter-only with `$orderby: 'receivedDateTime desc'` (existing strategy-3 shape extended with dates).
- `buildSearchParams`/`addBooleanFilters` gain the date conditions via the shared combinator; `addBooleanFiltersAsKQL` untouched (never reached with dates).
- Existing no-date behavior byte-identical (spec: absent params preserve behavior).

### `utils/mock-data.js` (list branch, `:92-169`)

Replace `value` construction with `filterMockMessages(list, _queryParams)`:

- Parse `$filter` with exactly two regexes: `/receivedDateTime\s+ge\s+(\S+)/` and `/receivedDateTime\s+le\s+(\S+)/` — the only predicate shapes this change emits (D1/D4). Also recognize the existing `hasAttachments eq true` / `isRead eq false` strings joined by `and` so the boolean path stays testable; anything else in `$filter` is ignored by the mock (documented in-file as a known limitation).
- Compare `new Date(msg.receivedDateTime)` against `new Date(literal)`; `ge` → `>=`, `le` → `<=`. The three mock messages (now, -1d, -2d) support meaningful ranges via relative test dates.

## Testing Design

| File                                   | What                                                                                      | Key cases                                                                                                                                                                                                                                     |
| -------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/email/date-filter.test.js` (new) | Unit: normalize/build                                                                     | date-only, full ISO, offset→UTC, invalid throws naming param, single/both bounds, ordering (dates before booleans)                                                                                                                            |
| `test/email/search.test.js` (new)      | Strategy routing                                                                          | date-only → `$filter`+`$orderby`, NO `$search`; terms+dates → `$filter` only (no `$search`/`$orderby`) + degradation note in text; **never-combined assertion over every emitted param set**; no-dates behavior unchanged; auth/folder errors |
| `test/email/list.test.js` (extend)     | Merge + sweep + validation                                                                | `$filter` emitted with dates; `count=0` → `maxCount=0` passthrough; default limit = `config.MAX_RESULT_COUNT`; no Graph call on invalid date                                                                                                  |
| `test/utils/graph-api.test.js`         | No change needed — pagination/`$filter` encoding already covered (`:111-129`, `:194-244`) | —                                                                                                                                                                                                                                             |

Never-combined guarantee is enforced both by the code gate (D2) and a test that inspects the params object passed to `callGraphAPIPaginated` (mocked) for every input combination.

## Risks / Mitigations

| Risk                           | Mitigation                                                                  |
| ------------------------------ | --------------------------------------------------------------------------- |
| `InefficientFilter`            | Emission-first (D1) + ordering unit test; per research Q6                   |
| `$filter`+`$search` combined   | Strategy-selection gate + never-combined test (D2)                          |
| Throttling on unbounded sweeps | Document in tool description; sweep bounded by date-filtered set (proposal) |
| ISO validation errors          | Client-side throw naming param, before any Graph call (spec requirement)    |

## File Changes

| File                                                          | Action                                                                 |
| ------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `email/date-filter.js`                                        | Create                                                                 |
| `email/index.js`                                              | Modify — add `receivedAfter`/`receivedBefore` (string) to both schemas |
| `email/list.js`                                               | Modify — date filter, `count=0`, `config.MAX_RESULT_COUNT`             |
| `email/search.js`                                             | Modify — strategy gate, degradation note                               |
| `utils/mock-data.js`                                          | Modify — `$filter` parsing                                             |
| `test/email/date-filter.test.js`, `test/email/search.test.js` | Create                                                                 |
| `test/email/list.test.js`                                     | Modify                                                                 |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary.

## Migration / Rollout

None. Additive params; revert commit restores prior query shape.

## Work Breakdown Hint (for tasks phase)

1. `email/date-filter.js` + its unit tests (no handler coupling).
2. `email/index.js` schemas.
3. `list.js` integration + list.test.js extensions.
4. `search.js` gate + degradation + search.test.js.
5. `mock-data.js` filter support (+ mock-level assertions inside handler tests).
6. Lint/format; verify success criteria from proposal.md.

## Open Questions

- None blocking. Runtime confirmation that Graph rejects `$filter`+`$search` on messages remains a cheap live-verification item (research ledger) — the design is safe under either outcome because the gate never combines them.
