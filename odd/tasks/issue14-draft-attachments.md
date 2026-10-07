# FEAT: #14 — attachments on draft-email

Issue: https://github.com/ACTSIS/outlook-mcp/issues/14
Branch: `feat/draft-attachments`

## Design (from exploration)

- `composeEmail` (signature/composer.js) returns `attachments: []` today (only signature images). Draft payload assembly lives in `email/graph-message-flow.js` (`composeNewMessage` merges `composed.attachments` into POST payload; reply path posts each attachment to `me/messages/{id}/attachments`).
- Plan: accept `attachments` array on `draft-email` args with file paths; read bytes via `fs.promises`, base64-encode into Graph `fileAttachment` objects (`@odata.type`, `name`, `contentType` from extension via config map, `contentBytes`), pass through `composeNewMessage` for new drafts and through the reply attachment loop for `replyToId` drafts.
- Reuse Graph item-attachment posting pattern; cap total size within Graph draft limit reported (config constant `MAX_ATTACHMENT_*`).
- Keep credentials/tokens out; no schema-breaking changes: `attachments` is additive and optional.

## Tasks

### T1: Attachment payload builder (unit) — RED→GREEN

- New `email/attachment-builder.js` (+ tests in `test/email/attachment-builder.test.js`): `buildFileAttachments(paths[]) -> Graph fileAttachment[]`; rejects missing files with clear error; maps extension→MIME (pdf, png, jpg, xlsx, docx, txt, zip fallback octet-stream); size guard.

### T2: Wire into draft-email (new draft + reply path) — RED→GREEN

- Handler tests: draft with attachments posts payload containing attachments; reply draft posts to `/attachments`; invalid path → clear MCP error; success text lists attachment count/names.
- `email/index.js`: add `attachments` (array of strings, file paths) to `draft-email` schema; description update.

### T3: Reply/deliverNativeReply passthrough — covered inside T2 handler tests (same draft.js code path).

### T4: Docs + OpenSpec + commit

- `openspec/specs/email-attachments` or email spec scenario; `README.md` tool row update if present; full suite + lint/format; conventional commit.

## Checks

- Focused: `npx jest test/email/draft.test.js test/email/attachment-builder.test.js test/email/graph-message-flow.test.js`
- Full `npm test`; eslint + prettier on touched files.
