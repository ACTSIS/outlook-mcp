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
