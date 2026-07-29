# Delta for Email

## MODIFIED Requirements

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
