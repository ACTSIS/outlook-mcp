# Exploration: add-email-date-filter

Change: `add-email-date-filter` — enable date-based filtering of emails (complete sweeps of very old dates) in the email listing tools.

## Current State

### Tool schemas (email/index.js)

- `list-emails` (`email/index.js:16-34`): parameters `folder` (string, default `inbox`) and `count` (number, "default: 10, max: 50"). No date parameters, no query, no ordering control.
- `search-emails` (`email/index.js:36-77`): parameters `query`, `folder`, `from`, `to`, `subject`, `hasAttachments`, `unreadOnly`, `count` (same "default: 10, max: 50"). No date parameters.
- The "max 50" in both descriptions is documentation only — no schema validation enforces it; the effective ceiling lives in the handlers.

### Handlers

- `handleListEmails` (`email/list.js:14-96`):
  - `requestedCount = args.count || 10` (`email/list.js:16`).
  - Query params: `$top: Math.min(50, requestedCount)` (hardcoded cap, `email/list.js:27`), `$orderby: 'receivedDateTime desc'` (`email/list.js:28`), `$select: config.EMAIL_SELECT_FIELDS` (`email/list.js:29`).
  - Calls `callGraphAPIPaginated(accessToken, 'GET', endpoint, queryParams, requestedCount)` (`email/list.js:33-39`). So counts above 50 ARE achievable via nextLink pagination today; the gap is not the page size — it is the absence of any date predicate, which forces sweeping through ALL newer mail page-by-page to reach old messages.
- `handleSearchEmails` (`email/search.js:14-65`): delegates to `progressiveSearch` with 4 fallback strategies (`email/search.js:76-196`):
  1. Combined KQL `$search` (`email/search.js:80-93`),
  2. single-term `$search` fallbacks (`email/search.js:95-143`),
  3. boolean `$filter` only (`email/search.js:145-172`),
  4. recent-emails fallback (`email/search.js:174-196`).
  - `buildSearchParams` (`email/search.js:205-244`): when any search term is present it uses `$search` with KQL and deliberately omits `$orderby`/`$filter` ("Graph API does not support $orderby or $filter with $search", `email/search.js:105`, `email/search.js:233`). When no search terms are present it sets `$orderby: 'receivedDateTime desc'`and builds OData`$filter` from boolean filters (`addBooleanFilters`, `email/search.js:252-267`) — this is the existing precedent for building `$filter` strings server-side.
  - The search handler does NOT do client-side date filtering today; results are whatever Graph returns.

### Graph transport (utils/graph-api.js)

- `callGraphAPI(accessToken, method, path, data = null, queryParams = {})` (`utils/graph-api.js:17-130`).
  - `$filter` is extracted from `queryParams` and URI-encoded separately (`utils/graph-api.js:52-69`); all other params go through `URLSearchParams`. OData filter strings are already handled correctly.
  - Full-URL `nextLink` passthrough is supported: if `path` starts with `http(s)://` it is used verbatim and query params are ignored (`utils/graph-api.js:29-32`).
- `callGraphAPIPaginated(accessToken, method, path, queryParams = {}, maxCount = 0)` (`utils/graph-api.js:141-194`):
  - GET-only (`utils/graph-api.js:142-144`).
  - Loops following `response['@odata.nextLink']`, accumulates `value` arrays, stops when `allItems.length >= maxCount` (`maxCount > 0`) or when no nextLink (`utils/graph-api.js:152-179`).
  - `maxCount = 0` means "retrieve everything" (`utils/graph-api.js:138`, `utils/graph-api.js:182`) — unbounded sweeps are already mechanically supported.
  - Returns `{ value: finalItems, '@odata.count': finalItems.length }`.
- `$top`, `$skip`, `$orderby`, `$select`, `$search` are passed through as plain query params; only `$filter` gets special encoding. There is no explicit `$skip` usage anywhere in handlers today.

### Constants (config.js)

- `DEFAULT_PAGE_SIZE: 25` (`config.js:99`) and `MAX_RESULT_COUNT: 50` (`config.js:100`) — both exported but the email handlers hardcode `50` instead of reading `MAX_RESULT_COUNT`.
- `EMAIL_SELECT_FIELDS` includes `receivedDateTime` (`config.js:93-94`), so date fields are already selected in listing responses.

### Folder resolution (email/folder-utils.js) — brief

- `resolveFolderPath(accessToken, folderName)` (`email/folder-utils.js:24-53`) maps well-known names or resolves `Parent/Child` paths segment-by-segment to `me/mailFolders/{id}/messages`. Both `list-emails` and `search-emails` call it before querying (`email/list.js:23`, `email/search.js:29`). Date filtering composes cleanly on top: the resolved endpoint stays the same; only query params change.

### Test mode mock

- `utils/mock-data.js` `simulateGraphAPIResponse(method, path, data, _queryParams)` ignores query parameters entirely (`utils/mock-data.js:13`) — test mode cannot exercise `$filter` behavior without extending the mock.

### Existing tests

- `test/email/list.test.js`: default inbox, custom folder, custom count, formatting, empty results, auth/Graph/folder errors, inbox endpoint verification.
- `test/utils/graph-api.test.js` `callGraphAPIPaginated` describe block (`test/utils/graph-api.test.js:194-244`): combines pages following full nextLink, stops/trims at maxCount, rejects non-GET, empty page handling, error propagation. `callGraphAPI` tests cover filter-only query strings and nextLink passthrough (`test/utils/graph-api.test.js:111-129`).
- GAP: `email/search.js` has NO dedicated handler test file (no `test/email/search.test.js`; `handleSearchEmails` appears in no test). Any date-filter change to search would be untested territory.

### Canonical spec (openspec/specs/email/spec.md)

Current requirements cover folder path resolution (`Path Resolution`, `Backwards Compatibility`, `Case-Insensitive Fallback`, `Error Handling`, `Empty Segment Filtering`, `Literal Slash Limitation`) and `Read Email with Attachment Metadata`. There are NO requirements about `list-emails`/`search-emails` listing behavior, counts, pagination, or date filtering. `openspec/specs/email-attachments/spec.md` covers attachment tools only. This change will therefore introduce ADDED requirements (no MODIFIED/REMOVED collisions expected).

## Gap Analysis — what prevents date-filtered full sweeps today

1. **No date input surface**: neither tool schema (`email/index.js:19-32`, `email/index.js:38-74`) accepts a date, range, or raw `$filter`.
2. **No server-side date predicate**: handlers never emit `receivedDateTime`/`sentDateTime` conditions; `$filter` is only built for boolean flags (`email/search.js:252-267`).
3. **Sweep economics**: without a date predicate, reaching year-old mail requires paging through every newer message (`callGraphAPIPaginated` walks nextLink from newest). At 50 items/page a 10,000-message mailbox needs ~200 sequential Graph calls — impractical and rate-limit-prone.
4. **Hardcoded 50 cap** (`email/list.js:27`) bypasses `config.MAX_RESULT_COUNT`, duplicating the limit.
5. **No client-side filtering either**: handlers return Graph results verbatim, so a consumer cannot even post-filter by date.
6. **Search + date incompatibility risk**: when `$search` is present, Graph rejects `$filter`/`$orderby` (`email/search.js:105`), so naive `$filter` addition to `search-emails` will break the combined-search strategy unless routed to the no-`$search` strategies or expressed as KQL.

## Approaches Considered

| #   | Approach                                                                                                    | Pros                                                                                                                                                                                            | Cons                                                                                                                                                                    | Effort |
| --- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | **Structured date params (`receivedAfter`/`receivedBefore`, ISO 8601) → OData `$filter` built server-side** | Clean tool contract; matches existing `addBooleanFilters` precedent; Graph does the filtering so sweeps of old dates cost only the matched pages; composes with `count` and existing `$orderby` | New schema surface on both tools; must keep `$search` and `$filter` mutually exclusive in `search-emails` strategy selection; date input format validation needed       | Medium |
| 2   | **Opaque `$filter` passthrough parameter**                                                                  | Maximum flexibility (any OData predicate); no new date semantics to define; transport already encodes `$filter` (`utils/graph-api.js:52-69`)                                                    | Exposes OData internals to callers/LLMs; injection and escaping burden moves to every call site; hard for MCP clients to use correctly; overlaps with approach 1 anyway | Low    |
| 3   | **Client-side date filtering only**                                                                         | Zero Graph behavior change                                                                                                                                                                      | Requires fetching everything newer first — solves nothing for the sweep use case; inconsistent with server-side boolean filters                                         | Low    |
| 4   | **Cursor/nextLink pagination exposed as a tool parameter (return `@odata.nextLink` to caller)**             | Enables incremental manual paging without huge counts                                                                                                                                           | Requires threading opaque state through conversation; pagination already happens internally up to `maxCount`; does not address date targeting by itself                 | Medium |

**Recommended direction**: Approach 1 as the product surface (structured date range on `list-emails` and `search-emails`), optionally with Approach 2's `$filter` passthrough deferred or rejected; keep internal nextLink pagination as-is. In `search-emails`, when date filters are requested alongside search terms, they must go through the boolean/`$filter`-only strategies (no `$search`), or be translated to KQL date terms if Graph KQL supports them (needs verification in research/design).

## Open Product Questions (for the proposal phase)

1. Which tools get the filter — `list-emails` only, or also `search-emails`? (Sweep use case suggests both; search interaction with `$search` complicates the latter.)
2. Date semantics: `receivedDateTime` only, or also `sentDateTime` (relevant for the `sent` folder)? One-sided (`receivedAfter`) vs. range (`from`/`to`) parameter naming.
3. Input format: ISO 8601 datetime only, or also date-only strings / relative terms (e.g. "older than 1 year")?
4. Server-side `$filter` vs. any client-side post-filtering for `search-emails` when `$search` terms are present.
5. Default and effective `count`: keep default 10, and should the sweep use case raise/keep the 50-page size or rely on `maxCount = 0`-style full retrieval? Should handlers reference `config.MAX_RESULT_COUNT` instead of the hardcoded 50?
6. Should a `sentDateTime` variant be exposed for the `sent` folder, or is `receivedDateTime` acceptable everywhere?

## Risks / Constraints

- **Graph `$filter` + `$search` mutual exclusion**: confirmed in code comments (`email/search.js:105`, `email/search.js:233`); date filters on `search-emails` must respect strategy fallback order or fail predictably.
- **OData escaping**: filter literals must follow the established apostrophe-doubling convention (`email/folder-utils.js:67`); date literals need strict ISO 8601 formatting to avoid 400s. Transport already URI-encodes `$filter` (`utils/graph-api.js:63-68`).
- **Graph API limits**: page size caps (~1000 for messages) and throttling on unbounded sweeps; large `maxCount` loops should remain bounded or documented.
- **nextLink interaction**: `callGraphAPIPaginated` follows nextLink verbatim; any date predicate must be in the FIRST request so it survives into generated nextLinks — it does, since Graph bakes params into nextLink. Changing params mid-pagination is not possible.
- **Test-mode mock ignores query params** (`utils/mock-data.js:13`): `$filter` behavior is invisible in test mode unless `mock-data.js` is extended; existing `list.test.js` and `graph-api.test.js` patterns cover the transport, but handler-level date tests will need Graph mocks.
- **Spec surface is greenfield**: no existing email listing requirements to modify; delta spec will be ADDED-only, reducing regression risk.
- **Uncovered search handler**: no `test/email/search.test.js` exists; changes to `search-emails` would ship without a handler-level safety net unless tests are added.

## Key Learnings

1. Email listing already supports nextLink pagination via callGraphAPIPaginated, so counts above 50 work today and the real gap is the missing date predicate.
2. The email handlers hardcode the 50-item page cap instead of reading config MAX_RESULT_COUNT.
3. Graph rejects $filter and $orderby when $search is present, which constrains how date filters can join search-emails strategies.
4. The test-mode mock in utils/mock-data.js ignores all query parameters, so $filter behavior cannot be exercised there without extending the mock.
5. No dedicated handler tests exist for email/search.js, leaving any search date-filter change without a safety net.
