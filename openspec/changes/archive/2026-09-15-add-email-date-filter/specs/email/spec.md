# Delta for email

## ADDED Requirements

### Requirement: Date-Filtered Listing Parameters

`list-emails` and `search-emails` SHALL accept optional `receivedAfter` and `receivedBefore` string parameters (ISO 8601) filtering on `receivedDateTime` via Graph `$filter`.

#### Scenario: Received-after filter limits results

- GIVEN emails exist received before and after 2024-01-01
- WHEN `list-emails` is called with `receivedAfter: "2024-01-01"`
- THEN only emails received on or after that date SHALL be returned

#### Scenario: Date range bounds both edges

- WHEN `list-emails` is called with both date parameters
- THEN only emails within the inclusive range SHALL be returned

#### Scenario: Absent date parameters preserve behavior

- WHEN either tool is called without date parameters
- THEN the query SHALL contain no date predicate and behavior SHALL be unchanged

### Requirement: Filter Compilation and Predicate Ordering

The system SHALL compile date parameters through a shared builder emitting `receivedDateTime ge <start>` and/or `receivedDateTime le <end>` joined with `and` — unquoted, UTC `Z`-normalized. With `$orderby=receivedDateTime desc`, date predicates MUST precede any other filter predicates (Graph `InefficientFilter` rules).

#### Scenario: Both bounds compile to a single and-chain

- WHEN both date parameters are provided
- THEN `$filter` SHALL be `receivedDateTime ge <start> and receivedDateTime le <end>` with unquoted UTC literals

#### Scenario: Date predicates precede others under orderby

- GIVEN a date filter combined with other predicates
- WHEN the query is emitted with `$orderby=receivedDateTime desc`
- THEN `receivedDateTime` predicates SHALL appear first in `$filter`

### Requirement: Full-Sweep Semantics for count=0

Without `$search`, `count=0` SHALL sweep the entire date-filtered set via `@odata.nextLink` until exhaustion; the date predicate SHALL persist across pages. With `$search`, results SHALL cap at 1,000 regardless of `count=0`; the cap SHALL be documented.

#### Scenario: count=0 sweeps all nextLink pages

- GIVEN a date-filtered query spanning multiple pages
- WHEN `list-emails` is called with `count: 0`
- THEN all pages SHALL be retrieved until no nextLink remains, each carrying the predicate

#### Scenario: $search path caps at 1000

- GIVEN search terms with `count: 0`
- WHEN `search-emails` runs
- THEN at most 1,000 results SHALL be returned and the cap SHALL be communicated

### Requirement: Search Strategy Routing for Date Filters

`search-emails` SHALL route date-filtered queries through the `$filter`-only strategy. `$filter` MUST NEVER be combined with `$search`. With both terms and dates, the tool SHALL degrade to filter-only (keyword search unavailable) and document the loss in the response.

#### Scenario: Date-only query uses filter-only path

- WHEN `search-emails` is called with dates and no terms
- THEN the request SHALL use `$filter` and SHALL NOT include `$search`

#### Scenario: Terms plus dates degrade to filter-only

- WHEN `search-emails` is called with terms and dates
- THEN the request SHALL use `$filter` only (no `$search`, no `$orderby`)
- AND the response SHALL state keyword search was not applied

#### Scenario: Filter and search are never combined

- GIVEN any input combination
- WHEN the request is emitted
- THEN `$filter` and `$search` SHALL NOT both be present

### Requirement: Configurable Default Result Count

Both handlers SHALL take their default result limit from `config.MAX_RESULT_COUNT` instead of hardcoded 50.

#### Scenario: Handlers reference the config constant

- WHEN either tool is invoked without `count`
- THEN the limit SHALL equal `config.MAX_RESULT_COUNT`; no hardcoded `50` SHALL remain

#### Scenario: Changing config changes behavior

- GIVEN `config.MAX_RESULT_COUNT` is changed
- WHEN either tool is called without `count`
- THEN the page size SHALL reflect the new value

### Requirement: Client-Side Date Validation

Both tools SHALL validate date parameters as ISO 8601 before calling Graph. Invalid input MUST produce a clear client-side error naming the parameter; Graph 400 passthrough SHALL NOT occur.

#### Scenario: Malformed date returns a clear error

- GIVEN `receivedAfter: "not-a-date"`
- WHEN `list-emails` is called
- THEN a client-side error SHALL name `receivedAfter` and state the expected format, with no Graph request

#### Scenario: Valid date-only input is accepted

- GIVEN `receivedBefore: "2024-06-30"`
- WHEN either tool is called
- THEN the input SHALL be accepted and UTC-normalized

### Requirement: Test-Mode Filter Support

The test-mode mock SHALL honor `$filter` on message listings so date-filter behavior is verifiable without live Graph.

#### Scenario: Mock applies $filter to listings

- GIVEN test mode is enabled
- WHEN a listing request includes a `$filter` with date predicates
- THEN the mock SHALL return only messages satisfying the filter
