# OneDrive Tools Specification

## Purpose

Define the user-visible contract of the OneDrive file-delivery MCP tools exposed through Microsoft Graph with delegated permissions, as corrected by issue #41. Uploads must store the exact bytes the caller provided (text verbatim or base64-decoded binary), and downloads must obtain the pre-authenticated URL from the `/content` redirect because the `@microsoft.graph.downloadUrl` property is not populated in delegated contexts. Token acquisition, persistence, and refresh are specified separately in [`../auth/spec.md`](../auth/spec.md).

## Requirements

### Requirement: Simple Upload Preserves File Bytes

`onedrive-upload` MUST send the file content unmodified as the PUT request body of `me/drive/root:/{path}:/content`: text content verbatim (UTF-8, `text/plain`), and base64-flagged content decoded to bytes (`application/octet-stream`). The body MUST NOT be serialized as a JSON string literal, and the stored item size MUST equal the source byte length.

#### Scenario: Text content with JSON-escapable characters is stored intact

- GIVEN a file whose content contains quotes, newlines, or backslashes
- WHEN `onedrive-upload` runs without the `base64` flag
- THEN the PUT body MUST be the raw content string with `Content-Type: text/plain`
- AND the stored size MUST equal the source UTF-8 byte count (no JSON escape growth)

#### Scenario: Binary content is delivered natively through the base64 flag

- GIVEN content that is valid base64 and the `base64: true` argument
- WHEN `onedrive-upload` runs
- THEN the handler MUST decode the content to a Buffer
- AND the PUT body MUST be those bytes with `Content-Type: application/octet-stream`

#### Scenario: The simple-upload threshold is measured on decoded bytes

- GIVEN the `base64: true` argument
- WHEN the decoded payload exceeds `ONEDRIVE_UPLOAD_THRESHOLD` (4 MB)
- THEN the upload MUST be rejected with the too-large message before any Graph call
- AND WHEN the decoded payload is within the threshold while its base64 text is larger
- THEN the upload MUST proceed as a simple upload

### Requirement: Chunked Upload Preserves Binary Payloads

`onedrive-upload-large` MUST honor the same optional `base64` flag: the content is decoded to bytes before chunking, and each chunk PUT MUST stream raw bytes with an explicit `Content-Range` through the upload-session URL, never a JSON serialization.

#### Scenario: Binary payload is chunked intact

- GIVEN a base64-encoded binary payload over the threshold and `base64: true`
- WHEN `onedrive-upload-large` runs
- THEN the chunked PUTs MUST carry the decoded bytes verbatim
- AND the stored size MUST equal the decoded byte length

### Requirement: Download Uses the /content Redirect

`onedrive-download` MUST obtain the pre-authenticated download URL from the HTTP 302 `Location` header returned by `GET .../content` (through the shared `callGraphAPIDownload` transport). It MUST NOT depend on the `@microsoft.graph.downloadUrl` property being present in item metadata.

#### Scenario: A file download URL is returned without downloadUrl metadata

- GIVEN an existing file and a valid Graph access token
- WHEN `onedrive-download` runs with a path or itemId
- THEN the handler MUST fetch item metadata (`$select=id,name,size,folder`) for validation
- AND MUST request the `/content` endpoint to obtain the 302 pre-authenticated URL
- AND the response MUST keep the existing URL-returning contract with the expiry note

#### Scenario: Folder paths and drive-path encoding

- GIVEN a requested path whose display name contains spaces or non-ASCII characters
- WHEN the download endpoints are built
- THEN every drive path segment MUST be URI-encoded while the `root:` colon syntax stays literal
- AND WHEN the item is a folder
- THEN the handler MUST report that folders cannot be downloaded directly without a `/content` request
