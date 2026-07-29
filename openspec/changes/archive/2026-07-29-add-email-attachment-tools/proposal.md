# Proposal: Add Email Attachment Tools

## Intent

Users can read, search, and send emails but cannot see or download attachments. The `hasAttachments` boolean exists but reveals nothing about what's attached. This change exposes attachment metadata and content through the MCP tool surface.

## Scope

### In Scope

- Enhance `read-email` to return attachment metadata (name, size, contentType) when `hasAttachments=true`
- New `list-attachments` tool: accepts `emailId`, returns attachment list with metadata
- New `download-attachment` tool: accepts `emailId` + `attachmentId`, returns base64 content + metadata
- Size warning for attachments >10MB
- Mock attachment data for test mode
- Unit/integration tests for new tools

### Out of Scope

- OneDrive save-as flow (future enhancement)
- Inline attachment handling (embedded images — `isInline` filtering only)
- Chunked download for files >150MB (Graph API limit)
- Attachment upload or send-with-attachment

## Capabilities

### New Capabilities

- `email-attachments`: List and download email attachments via Graph API. Covers `list-attachments` and `download-attachment` tools, base64 content delivery, size warnings, and mock data.

### Modified Capabilities

- `email`: `read-email` tool MUST include attachment metadata (name, size, contentType, attachmentId) in its response when the email has attachments.

## Approach

Follow exploration **Approach 1**: enhance `read-email` to show attachment metadata, add `email/attachment.js` with `handleListAttachments` and `handleDownloadAttachment`, register tools in `email/index.js`. Use `GET /me/messages/{id}/attachments` for listing and `GET /me/messages/{id}/attachments/{attachmentId}` for download. Return base64 content as labeled text. Warn when size >10MB.

## Affected Areas

| Area                  | Impact   | Description                                                      |
| --------------------- | -------- | ---------------------------------------------------------------- |
| `config.js`           | Modified | Add `attachments` to `EMAIL_DETAIL_FIELDS`                       |
| `email/read.js`       | Modified | Fetch and display attachment metadata when `hasAttachments=true` |
| `email/attachment.js` | New      | `handleListAttachments`, `handleDownloadAttachment` handlers     |
| `email/index.js`      | Modified | Register `list-attachments` and `download-attachment` tools      |
| `utils/mock-data.js`  | Modified | Add mock attachment data and endpoint simulations                |
| `utils/graph-api.js`  | Modified | Add attachment-specific API call helpers                         |
| `test/`               | New      | Tests for attachment handlers and mock data                      |

## Risks

| Risk                                              | Likelihood | Mitigation                                             |
| ------------------------------------------------- | ---------- | ------------------------------------------------------ |
| Large attachments (>10MB) hit MCP response limits | Med        | Warn user, suggest OneDrive save as alternative        |
| Base64 overhead (+33%) inflates response size     | High       | Acceptable for typical attachments; warn at threshold  |
| Inline images returned as attachments             | Low        | Filter `isInline=true` from attachment list by default |

## Rollback Plan

Revert `config.js` `EMAIL_DETAIL_FIELDS` change, remove `email/attachment.js`, unregister tools from `email/index.js`, revert mock data additions. No schema or data migration needed.

## Dependencies

- Existing `Mail.Read` Graph API scope (sufficient — no new Azure permissions)
- Existing `callGraphAPI` utility in `utils/graph-api.js`

## Success Criteria

- [ ] `read-email` returns attachment metadata for emails with attachments
- [ ] `list-attachments` returns name, size, contentType, attachmentId for each attachment
- [ ] `download-attachment` returns base64 content + metadata for a given attachmentId
- [ ] Size warning shown for attachments >10MB
- [ ] All existing tests pass + new tests cover attachment handlers
- [ ] Test mode works with mock attachment data
