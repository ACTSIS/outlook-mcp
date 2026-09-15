# Proposal: add-email-date-filter

## Why

**Problem**: `list-emails` and `search-emails` cannot target emails by date. Reaching year-old mail means paging through every newer message via nextLink (a 10k mailbox ≈ 200 Graph calls). `count=0` full retrieval already works in `callGraphAPIPaginated(maxCount=0)`, but without a date predicate it sweeps everything.

**User impact**: old-date sweeps become one cheap filtered call; keyword search gains date scoping.

## What Changes

ADDED requirements to the existing `email` capability (no REMOVED/MODIFIED):

- Both tools accept `receivedAfter`/`receivedBefore` (ISO 8601) on `receivedDateTime`.
- `count=0` = full nextLink sweep (no-`$search` path only; `$search` caps at 1,000).
- Handlers use `config.MAX_RESULT_COUNT` instead of hardcoded 50.
- Mock honors `$filter`; `test/email/search.test.js` created.

Out of scope: `sentDateTime`, raw `$filter` passthrough, KQL date ranges, relative dates.

## Capabilities

- **New**: None.
- **Modified**: `email` — ADDED date-filtered listing, filter compilation/ordering, `count=0` sweep semantics.

## Approach

1. **Schema**: optional `receivedAfter`/`receivedBefore` (string) on both tool schemas.
2. **Filter builder** (`email/date-filter.js`, new): emits `receivedDateTime ge <start> and receivedDateTime le <end>` — unquoted, UTC-normalized; date predicates FIRST (InefficientFilter rules under `$orderby=receivedDateTime desc`).
3. **`list-emails`**: merge date predicates into existing query params; `count=0` → `maxCount=0`.
4. **`search-emails`**: date params route through the `$filter`-only path (extends `addBooleanFilters`); terms+dates also `$filter`-only (keyword search unavailable — Graph rejects `$filter` with `$search` on messages; documented). KQL-in-`$search` rejected (ranges unverified).
5. **Tests**: extend `utils/mock-data.js` to apply `$filter`; add `test/email/search.test.js`; extend `list.test.js`.

## Affected Areas

| Area                                | Impact   | Description                                       |
| ----------------------------------- | -------- | ------------------------------------------------- |
| `email/index.js`                    | Modified | Date params, both schemas                         |
| `email/list.js`                     | Modified | Date filter; `config.MAX_RESULT_COUNT`; `count=0` |
| `email/search.js`                   | Modified | Strategy routing with dates                       |
| `email/date-filter.js`              | New      | ISO normalization + `$filter` builder             |
| `utils/mock-data.js`                | Modified | Honor `$filter`                                   |
| `test/email/*.test.js` (search new) | Mod/New  | Handler coverage                                  |
| `openspec/specs/email/spec.md`      | Modified | ADDED at archive                                  |

## Risks

| Risk                                        | Likelihood | Mitigation                                   |
| ------------------------------------------- | ---------- | -------------------------------------------- |
| `InefficientFilter` from predicate ordering | Low        | Date predicates first; tested                |
| `$filter`+`$search` rejection               | Low        | Enforced strategy routing                    |
| Unbounded `count=0` throttling              | Medium     | Document; sweep bounded by date-filtered set |
| Invalid dates → Graph 400                   | Low        | Client-side ISO validation                   |

## Rollback Plan

Revert the change commit. Date params are additive; absent params restore the current query shape.

## Dependencies

- None external; Graph `receivedDateTime` `$filter` verified (research.md).

## Success Criteria

- [ ] Both tools return date-filtered results from live Graph.
- [ ] `count=0` performs a full nextLink sweep (no-`$search` path).
- [ ] Search never sends `$filter` with `$search`.
- [ ] Handlers use `config.MAX_RESULT_COUNT`; no hardcoded 50.
- [ ] Jest tests pass; `npm run lint` clean.
