## Exploration: add-email-attachment-tools

### Current State

The outlook-mcp MCP server can read, list, search, send, and delete emails, but has **zero attachment handling**. The `read-email` tool reports `hasAttachments: Yes/No` but exposes no attachment metadata (name, size, MIME type, attachmentId). No `list-attachments` or `download-attachment` tools exist. The codebase has no attachment-related code beyond the `hasAttachments` boolean field.

### Affected Areas

- `config.js` — `EMAIL_DETAIL_FIELDS` and `EMAIL_SELECT_FIELDS` do NOT include `attachments` or any attachment-related properties
- `email/read.js` — reads `hasAttachments` from the API response but discards it after formatting; no attachment metadata is returned
- `email/list.js` — uses `EMAIL_SELECT_FIELDS` (has `hasAttachments`) but doesn't display it
- `email/search.js` — uses `EMAIL_SELECT_FIELDS`; has `hasAttachments` filter but doesn't display attachment info
- `email/index.js` — no attachment tools registered
- `utils/graph-api.js` — has `callGraphAPI`, `callGraphAPIPaginated`, and `callGraphAPIDownload` (OneDrive-specific); no attachment-specific API calls
- `utils/mock-data.js` — mock emails have `hasAttachments: true/false` but no attachment data; no attachment endpoint simulations
- `email/` — new file(s) needed for attachment handlers
- `test/` — new test files needed

### Graph API Attachment Endpoints

- **List attachments**: `GET /me/messages/{id}/attachments` → returns `{ value: [{ @odata.type, id, name, contentType, size, isInline, lastModifiedDateTime, contentBytes }] }`
- **Get single attachment**: `GET /me/messages/{id}/attachments/{attachmentId}` → returns full object with `contentBytes` (base64-encoded)
- **Get raw binary**: `GET /me/messages/{id}/attachments/{attachmentId}/$value` → returns raw binary stream (more efficient for large files)
- **Attachment types**: `fileAttachment` (standard), `itemAttachment` (embedded Outlook item), `referenceAttachment` (cloud link)
- **Size limit**: Graph API returns `contentBytes` inline for attachments up to ~150MB; beyond that, use `/$value` for streaming

### Approaches

1. **Enhance `read-email` + add `download-attachment` tool (RECOMMENDED)**
   - Add `attachments` to `EMAIL_DETAIL_FIELDS` in config.js
   - Modify `read.js` to fetch and display attachment metadata (name, size, contentType) when `hasAttachments` is true
   - Create `email/attachment.js` with `handleListAttachments` and `handleDownloadAttachment`
   - Register new tools in `email/index.js`
   - Pros: Clean separation of concerns; read-email shows what's available; download-attachment fetches content; follows existing module pattern
   - Cons: Two new tools to maintain
   - Effort: Medium

2. **Add `list-attachments` + `download-attachment` as separate tools only**
   - No changes to `read-email`
   - Pros: Minimal changes to existing code
   - Cons: Users must use a separate tool just to see attachment names; less discoverable
   - Effort: Medium

3. **Embed all attachment data in `read-email` response**
   - Fetch attachments inline when reading an email
   - Return base64 content directly in the read response
   - Pros: Single tool for everything
   - Cons: Bloated responses; can't selectively download; MCP response size limits for large attachments
   - Effort: Low

### Recommendation

**Approach 1**: Enhance `read-email` to show attachment metadata (names, sizes, types) when `hasAttachments` is true, and add a dedicated `download-attachment` tool that returns base64-encoded content. This follows the existing pattern (read shows metadata, dedicated tool fetches content) and keeps responses manageable.

For binary content delivery in MCP: return base64-encoded content as `type: 'text'` with clear labeling (filename, size, MIME type). The MCP protocol doesn't natively support binary resources in the stdio transport, so base64 text is the most portable approach. For very large files (>10MB), consider warning the user and offering OneDrive save as an alternative.

### Risks

- **Large file handling**: Attachments over ~10MB may hit MCP response size limits. Mitigation: warn on large files, offer OneDrive save option.
- **Base64 overhead**: Base64 encoding adds ~33% size overhead. For a 10MB file, the response would be ~13.3MB of text.
- **Mock data**: No attachment mock data exists — test mode will need new mock responses for attachment endpoints.
- **Permissions**: The existing `Mail.Read` scope is sufficient for reading attachments (same as reading email content). No new Azure permissions needed.
- **Inline attachments**: `isInline: true` attachments (embedded images) should be filtered or handled differently from regular file attachments.

### Ready for Proposal

Yes — the approach is clear, the Graph API surface is well-documented, and the existing code patterns are straightforward to extend.
