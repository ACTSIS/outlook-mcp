# Email Attachments Specification

## Purpose

Define the behavior of `list-attachments` and `download-attachment` tools for listing and downloading email attachments via the Microsoft Graph API. These tools enable users to inspect and retrieve file content attached to emails without leaving the MCP tool surface.

## Requirements

### Requirement: List Attachments

`list-attachments` MUST accept an `emailId` parameter and return a list of all attachments on that email, with metadata for each.

#### Scenario: List attachments returns metadata for each attachment

- GIVEN an email with two attachments: "report.pdf" (1.2MB, application/pdf) and "photo.jpg" (500KB, image/jpeg)
- WHEN `list-attachments` is called with the email's ID
- THEN the response MUST include both attachments
- AND each entry MUST contain `name`, `size`, `contentType`, and `attachmentId`

#### Scenario: Email with no attachments returns empty list

- GIVEN an email with `hasAttachments=false`
- WHEN `list-attachments` is called with the email's ID
- THEN the response MUST indicate no attachments were found

#### Scenario: Inline attachments are filtered from default list

- GIVEN an email with one regular attachment and one inline image (`isInline=true`)
- WHEN `list-attachments` is called with the email's ID
- THEN the response MUST include only the regular attachment
- AND the response MUST note that inline attachments were filtered

### Requirement: Download Attachment

`download-attachment` MUST accept `emailId` and `attachmentId` parameters and return the attachment's base64-encoded content along with its metadata.

#### Scenario: Download attachment returns base64 content and metadata

- GIVEN an email with attachment "report.pdf" (attachmentId: "att-123")
- WHEN `download-attachment` is called with `emailId` and `attachmentId="att-123"`
- THEN the response MUST include the base64-encoded content of the file
- AND the response MUST include the attachment's name, contentType, and size

#### Scenario: Download attachment with invalid attachmentId returns error

- GIVEN an email with no attachment matching "att-invalid"
- WHEN `download-attachment` is called with `attachmentId="att-invalid"`
- THEN the response MUST return an error message indicating the attachment was not found

### Requirement: Size Warning

The system MUST warn the user when an attachment exceeds 10MB in size.

#### Scenario: Large attachment triggers size warning

- GIVEN an attachment of 15MB
- WHEN `download-attachment` is called
- THEN the response MUST include a warning that the file is large (>10MB)
- AND the base64 content SHALL still be returned

#### Scenario: Small attachment has no size warning

- GIVEN an attachment of 500KB
- WHEN `download-attachment` is called
- THEN the response MUST NOT include a size warning

### Requirement: Error Handling

The system MUST handle common error conditions gracefully with descriptive messages.

#### Scenario: Email not found returns clear error

- GIVEN a non-existent email ID
- WHEN `list-attachments` or `download-attachment` is called
- THEN the response MUST return an error message indicating the email was not found

#### Scenario: Graph API authentication failure returns auth error

- GIVEN an expired or invalid access token
- WHEN any attachment tool is called
- THEN the response MUST return an authentication error message

#### Scenario: Graph API network failure returns error

- GIVEN the Graph API is unreachable
- WHEN any attachment tool is called
- THEN the response MUST return a descriptive error about the API failure

### Requirement: Mock Data for Test Mode

When `USE_TEST_MODE=true`, attachment tools MUST return simulated data without calling the real Graph API.

#### Scenario: List attachments in test mode returns mock data

- GIVEN `USE_TEST_MODE=true`
- WHEN `list-attachments` is called with a simulated email ID
- THEN the response MUST include mock attachment entries with realistic metadata

#### Scenario: Download attachment in test mode returns mock base64 content

- GIVEN `USE_TEST_MODE=true`
- WHEN `download-attachment` is called with a simulated email ID and attachment ID
- THEN the response MUST include mock base64 content and metadata
