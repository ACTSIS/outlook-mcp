# Tasks: Add Email Attachment Tools

## Review Workload Forecast

| Field                   | Value                                                                    |
| ----------------------- | ------------------------------------------------------------------------ |
| Estimated changed lines | ~540                                                                     |
| 400-line budget risk    | Medium                                                                   |
| Chained PRs recommended | Yes                                                                      |
| Suggested split         | PR 1 (Foundation) → PR 2 (list-attachments) → PR 3 (download-attachment) |
| Delivery strategy       | auto-chain                                                               |
| Chain strategy          | stacked-to-main                                                          |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: Medium

### Suggested Work Units

| Unit | Goal                                        | Likely PR | Focused test command                              | Runtime harness                                                            | Rollback boundary                                          |
| ---- | ------------------------------------------- | --------- | ------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1    | Config + mock-data + read-email enhancement | PR 1      | `npx jest test/email/read.test.js`                | `npm run test-mode` + `list-emails` then `read-email` on simulated-email-2 | Revert config.js, mock-data.js, read.js, read.test.js      |
| 2    | list-attachments tool + tests               | PR 2      | `npx jest test/email/list-attachments.test.js`    | `npm run test-mode` + `list-attachments` on simulated-email-2              | Revert list-attachments.js, index.js changes, test file    |
| 3    | download-attachment tool + tests            | PR 3      | `npx jest test/email/download-attachment.test.js` | `npm run test-mode` + `download-attachment` on simulated attachment        | Revert download-attachment.js, index.js changes, test file |

## Phase 1: Foundation / Infrastructure

- [x] 1.1 `config.js` — Add `ATTACHMENT_SIZE_WARNING_THRESHOLD: 10 * 1024 * 1024` constant
- [x] 1.2 `utils/mock-data.js` — In `simulateGraphAPIResponse` GET branch, detect `/attachments` path: list returns `value:[{id,name,contentType,size,isInline,contentBytes}]`, single returns one attachment object
- [x] 1.3 `email/read.js` — After email fetch, if `hasAttachments`, call `me/messages/{id}/attachments` with `$select=id,name,contentType,size,isInline`; append `Attachments:` section to `formattedEmail` with `[INLINE]` flag for inline attachments; wrap attachment fetch in try/catch so failure is non-fatal
- [x] 1.4 `test/email/read.test.js` — Create: mock `callGraphAPI` for attachment fetch; test `hasAttachments=true` triggers second call, `hasAttachments=false` skips it, inline flagging, Graph error is non-fatal

## Phase 2: list-attachments Tool

- [x] 2.1 `email/list-attachments.js` — Create `handleListAttachments(args)`: auth, GET `me/messages/{emailId}/attachments` with `$select=id,name,contentType,size,isInline`, map to `{id,name,contentType,size,isInline}`, flag inline attachments, format text response with table + inline-flagged section
- [x] 2.2 `email/index.js` — Add `require('./list-attachments')`, push `list-attachments` tool def (input: `emailId` string required) onto `emailTools`, export handler
- [x] 2.3 `test/email/list-attachments.test.js` — Create: mock `callGraphAPI`; test endpoint + `$select`, inline flagging, empty list, auth error

## Phase 3: download-attachment Tool

- [x] 3.1 `email/download-attachment.js` — Create `handleDownloadAttachment(args)`: auth, GET `me/messages/{emailId}/attachments/{attachmentId}` with `$select=id,name,contentType,size,contentBytes`; warn if `size > ATTACHMENT_SIZE_WARNING_THRESHOLD`; decode text-like types (`text/*`, `application/json`, `application/xml`) from base64 when `decodeAsText !== false`; return metadata + content
- [x] 3.2 `email/index.js` — Add `require('./download-attachment')`, push `download-attachment` tool def (input: `emailId` + `attachmentId` required, `decodeAsText` optional boolean) onto `emailTools`, export handler
- [x] 3.3 `test/email/download-attachment.test.js` — Create: mock `callGraphAPI`; test endpoint, size warning >threshold, text decode, base64 passthrough, auth error

## Phase 4: Integration / Verification

- [x] 4.1 Run full test suite: `npm test` — all 188+ existing tests pass plus new attachment tests
- [ ] 4.2 Manual smoke test: `npm run test-mode` + verify `list-attachments` and `download-attachment` return mock data
