# Email — Folder Utilities Specification

## Purpose

Define the behavior of `getFolderIdByName()` for resolving folder names and path-style folder references (e.g., `"Tramite/REQ-104951"`) to their Graph API folder IDs. All tools that accept a `targetFolder` string depend on this function.

## Requirements

### Requirement: Path Resolution

`getFolderIdByName()` MUST resolve folder paths separated by `/` by traversing the folder hierarchy level by level.

#### Scenario: Two-level path resolves to subfolder ID

- GIVEN a folder hierarchy with top-level folder "Tramite" containing child folder "REQ-104951"
- WHEN `getFolderIdByName("Tramite/REQ-104951")` is called
- THEN it MUST return the Graph API ID of "REQ-104951"

#### Scenario: Three-level path resolves to nested subfolder ID

- GIVEN a folder hierarchy "A" → "B" → "C"
- WHEN `getFolderIdByName("A/B/C")` is called
- THEN it MUST return the Graph API ID of "C"

### Requirement: Backwards Compatibility

`getFolderIdByName()` SHALL resolve flat folder names (no `/`) identically to current behavior.

#### Scenario: Flat folder name resolves via top-level lookup

- GIVEN a top-level folder "Inbox"
- WHEN `getFolderIdByName("Inbox")` is called
- THEN it MUST return the same result as a direct `me/mailFolders?$filter=displayName eq 'Inbox'` query

### Requirement: Case-Insensitive Fallback

Each path segment SHALL have case-insensitive fallback matching when the exact case lookup fails.

#### Scenario: Case-insensitive segment resolves to folder

- GIVEN a folder "Tramite" with child "REQ-104951"
- WHEN `getFolderIdByName("tramite/req-104951")` is called
- THEN it MUST return the ID of "REQ-104951"

### Requirement: Error Handling

If any segment in the path is not found, `getFolderIdByName()` MUST return `null`.

#### Scenario: Non-existent segment returns null

- GIVEN a top-level folder "Tramite" with no child named "NONEXISTENT"
- WHEN `getFolderIdByName("Tramite/NONEXISTENT")` is called
- THEN it MUST return `null`

#### Scenario: Non-existent top-level folder returns null

- GIVEN no folder named "NonExistent" exists
- WHEN `getFolderIdByName("NonExistent/Child")` is called
- THEN it MUST return `null`

### Requirement: Empty Segment Filtering

Empty segments resulting from consecutive `/` or leading/trailing separators SHALL be trimmed and filtered.

#### Scenario: Consecutive slashes are handled gracefully

- GIVEN a folder "Tramite" with child "REQ-104951"
- WHEN `getFolderIdByName("Tramite//REQ-104951")` is called
- THEN it MUST return the ID of "REQ-104951"

### Requirement: Strict Folder Resolution

When a named folder (or any path segment) cannot be found, `resolveFolderPath()` MUST throw a clear `Folder not found: '<name>'` error instead of silently falling back to the inbox. Callers surface the error in their tool response.

#### Scenario: Unknown folder name errors instead of searching the inbox

- GIVEN no folder named "NonExistent" exists
- WHEN a tool resolves folder "NonExistent"
- THEN the resolution MUST reject with an error containing `Folder not found: 'NonExistent'`
- AND no request SHALL be made against the inbox endpoint as a fallback

#### Scenario: Missing folder argument still defaults to inbox

- GIVEN no folder argument is provided
- WHEN a tool resolves the folder
- THEN the inbox endpoint SHALL be used (existing behavior unchanged)

### Requirement: Folder Listing Completeness

Folder enumeration (`list-folders`) MUST traverse every nesting level via `childFolders` and MUST follow `@odata.nextLink` pages at every level. Enumeration SHALL be bounded by depth and cycle guards so a pathological folder graph cannot loop indefinitely.

#### Scenario: Nested subfolder at depth three is enumerated

- GIVEN folders "A" → "B" → "C"
- WHEN `list-folders` is called with `includeChildren=true`
- THEN the response SHALL include "C" nested under "B"

#### Scenario: Folder level larger than one page is fully enumerated

- GIVEN a parent folder whose child listing returns an `@odata.nextLink`
- WHEN `list-folders` is called
- THEN all pages SHALL be followed before the response completes

#### Scenario: Folder graph cycle terminates

- GIVEN a folder graph that reports a folder as its own descendant
- WHEN `list-folders` is called
- THEN enumeration SHALL terminate within bounded calls without revisiting visited folders

### Requirement: Literal Slash Limitation

Folder names containing a literal `/` in their display name are NOT supported. The function SHALL treat `/` exclusively as a path separator.

#### Scenario: Folder with slash in name is not resolvable

- GIVEN a folder named "A/B" exists
- WHEN `getFolderIdByName("A/B")` is called
- THEN the function SHALL interpret it as path "A" → "B" and NOT as a single folder named "A/B"

---

### Requirement: Read Email with Attachment Metadata

When `read-email` is called for an email that has attachments (`hasAttachments=true`), the response MUST include attachment metadata (name, size, contentType, attachmentId) fetched from the Graph API attachments endpoint. The metadata SHALL be displayed as a structured list after the email body and before any raw HTML section.

(Previously: `read-email` returned email body and headers only — no attachment information beyond the `hasAttachments` boolean.)

#### Scenario: Email with attachments includes metadata in response

- GIVEN an email with `hasAttachments=true` and two attachments named "report.pdf" and "image.png"
- WHEN `read-email` is called with the email's ID
- THEN the response MUST include a section listing each attachment with its name, size, contentType, and attachmentId
- AND the `Has Attachments: Yes` line SHALL remain in the header

#### Scenario: Email without attachments returns no attachment section

- GIVEN an email with `hasAttachments=false`
- WHEN `read-email` is called with the email's ID
- THEN the response MUST NOT include an attachment metadata section
- AND the `Has Attachments: No` line SHALL appear in the header

#### Scenario: Graph API error during attachment fetch is non-fatal

- GIVEN an email with `hasAttachments=true`
- AND the Graph API call to `GET /me/messages/{id}/attachments` fails
- WHEN `read-email` is called
- THEN the email body SHALL still be returned
- AND a warning message SHALL indicate that attachment metadata could not be retrieved

#### Scenario: Inline attachments are flagged in read-email output

- GIVEN an email with both regular and inline attachments
- WHEN `read-email` is called
- THEN inline attachments (`isInline=true`) SHALL be flagged with `[INLINE]` in the attachment list

---

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

#### Scenario: `to` term with date range applies client-side recipient filter

- WHEN `search-emails` is called with `to` plus date range
- THEN `$filter` SHALL contain only the date predicate (Graph rejects `toRecipients/any` server-side)
- AND `to` SHALL be matched client-side against `toRecipients` in the results
- AND the result SHALL be reported with strategy `filter-with-recipient-client-side`

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
