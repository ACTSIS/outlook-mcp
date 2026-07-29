# Design: Add Email Attachment Tools

## Technical Approach

Enhance `read-email` to make a conditional second Graph call for attachment metadata when `hasAttachments=true`, and add two new single-purpose handlers (`email/list-attachments.js`, `email/download-attachment.js`) that reuse `callGraphAPI` and `ensureAuthenticated` exactly as the existing email handlers do. One handler per file mirrors the established `email/` layout (`list.js`, `read.js`, `send.js`, …). The download handler returns base64 content plus a `size` field so the consuming agent can decide whether to surface it; text-like content types are optionally decoded to readable text to avoid forcing the agent to base64-decode.

Maps to proposal Approach 1 and spec requirements: `read-email` attachment metadata, `list-attachments`, `download-attachment`, size warning, mock data.

## Architecture Decisions

| Decision                    | Option                                                                                                           | Tradeoff                                                                                            | Choice                       | Rationale                                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| File layout                 | (a) one `email/attachment.js` with both handlers (b) two files: `list-attachments.js` + `download-attachment.js` | (a) matches proposal text; (b) matches existing one-handler-per-file convention in `email/`         | (b) two files                | Consistency with `list.js`/`read.js`/`send.js`; smaller diffs; easier per-handler unit tests                                    |
| Attachments list pagination | (a) `callGraphAPI` single call (b) `callGraphAPIPaginated`                                                       | (a) simpler; Graph default page 10, attachments rarely exceed; (b) robust for many-attachment mails | (a) `callGraphAPI`           | Attachments per message are typically <10; keep handler simple; `@odata.nextLink` can be handled later if needed                |
| Inline attachments          | (a) filter out `isInline=true` (b) include all, flag inline                                                      | (a) cleaner list; (b) more info, agent decides                                                      | (b) include all, flag inline | Proposal scope says "filter inline attachments into separate section OR flag them"; flagging preserves info without losing data |
| Text content decoding       | (a) always return base64 (b) decode text/* + json + xml to text                                                  | (a) uniform, agent decodes; (b) friendlier, avoids round-trip                                       | (b) decode text-like types   | Reduces agent work for common small text attachments; gated by contentType prefix check                                         |
| Size threshold              | (a) constant in handler (b) config constant `ATTACHMENT_SIZE_WARNING_THRESHOLD`                                  | (a) local; (b) configurable, matches `ONEDRIVE_UPLOAD_THRESHOLD` pattern                            | (b) config                   | Consistent with `ONEDRIVE_UPLOAD_THRESHOLD`; tunable without code change                                                        |

## Data Flow

```
read-email (email/read.js)
   │ GET me/messages/{id}  → email.hasAttachments?
   │   yes → GET me/messages/{id}/attachments  → [{id,name,contentType,size,isInline}]
   │   append "Attachments:" section to formattedEmail
   ▼
MCP response (text)

list-attachments (email/list-attachments.js)
   │ GET me/messages/{emailId}/attachments  → value[]
   │ map → {id,name,contentType,size,isInline}
   ▼
MCP response (text: table + inline-flagged section)

download-attachment (email/download-attachment.js)
   │ GET me/messages/{emailId}/attachments/{attachmentId}  → {name,contentType,size,contentBytes}
   │ size > THRESHOLD? → warning string
   │ contentType ∈ text-like? → decode base64 → text field
   ▼
MCP response (text: metadata + contentBase64 / decoded text)
```

## Interfaces / Contracts

**New handlers (CommonJS, default-exported, same shape as `handleReadEmail`):**

```js
// email/list-attachments.js
async function handleListAttachments(args)
// args: { emailId: string }  → { content: [{type:'text', text}] }

// email/download-attachment.js
async function handleDownloadAttachment(args)
// args: { emailId: string, attachmentId: string, decodeAsText?: boolean }
// → { content: [{type:'text', text}] }
```

**Graph endpoints:**

| Tool                | Method | Endpoint                                           | `$select`                               |
| ------------------- | ------ | -------------------------------------------------- | --------------------------------------- |
| list-attachments    | GET    | `me/messages/{emailId}/attachments`                | `id,name,contentType,size,isInline`     |
| download-attachment | GET    | `me/messages/{emailId}/attachments/{attachmentId}` | `id,name,contentType,size,contentBytes` |

**Config constant (`config.js`):**

```js
ATTACHMENT_SIZE_WARNING_THRESHOLD: 10 * 1024 * 1024, // 10MB
```

**Text-like content types** (decoded when `decodeAsText !== false`): `text/*`, `application/json`, `application/xml`.

## File Changes

| File                                     | Action | Description                                                                                                                                                                          |
| ---------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `config.js`                              | Modify | Add `ATTACHMENT_SIZE_WARNING_THRESHOLD` constant (10MB).                                                                                                                             |
| `email/read.js`                          | Modify | After email fetch, if `hasAttachments`, call attachments endpoint; append attachment list to `formattedEmail`. No schema change.                                                     |
| `email/list-attachments.js`              | Create | `handleListAttachments`: auth, GET attachments, map to `{id,name,contentType,size,isInline}`, flag inline, format text response.                                                     |
| `email/download-attachment.js`           | Create | `handleDownloadAttachment`: auth, GET single attachment, warn if `size > THRESHOLD`, optionally decode text-like base64, return metadata + content.                                  |
| `email/index.js`                         | Modify | `require` both handlers; push two tool defs (`list-attachments`, `download-attachment`) onto `emailTools`; export handlers.                                                          |
| `utils/mock-data.js`                     | Modify | In `simulateGraphAPIResponse` GET branch, detect `/attachments` path: list returns `value:[{id,name,contentType,size,isInline,contentBytes}]`, single returns one attachment object. |
| `test/email/list-attachments.test.js`    | Create | Unit tests: mock `callGraphAPI`, assert endpoint/`$select`, inline flagging, empty list, auth error.                                                                                 |
| `test/email/download-attachment.test.js` | Create | Unit tests: mock `callGraphAPI`, assert endpoint, size warning >threshold, text decode, base64 passthrough, auth error.                                                              |
| `test/email/read.test.js`                | Modify | Add case: `hasAttachments=true` triggers second `callGraphAPI` call; formatted output includes attachments section.                                                                  |

## Testing Strategy

| Layer       | What to Test                                  | Approach                                                                               |
| ----------- | --------------------------------------------- | -------------------------------------------------------------------------------------- |
| Unit        | `handleListAttachments` endpoint + `$select`  | `jest.mock('../utils/graph-api')`; assert call args                                    |
| Unit        | `handleListAttachments` inline flagging       | Mock returns mix of inline/regular; assert flagged section                             |
| Unit        | `handleListAttachments` empty list            | Mock `value: []`; assert "No attachments" message                                      |
| Unit        | `handleDownloadAttachment` endpoint           | Assert `me/messages/{id}/attachments/{aid}` path                                       |
| Unit        | `handleDownloadAttachment` size warning       | Mock `size > THRESHOLD`; assert warning string present                                 |
| Unit        | `handleDownloadAttachment` text decode        | Mock `contentType: 'text/plain'`, `contentBytes: base64('hello')`; assert decoded text |
| Unit        | `handleDownloadAttachment` base64 passthrough | Mock `contentType: 'application/pdf'`; assert `contentBase64` field, no decode         |
| Unit        | `read-email` attachment section               | Mock email `hasAttachments:true` + attachments call; assert "Attachments:" in output   |
| Unit        | Auth error path                               | `ensureAuthenticated` rejects; assert "Authentication required" message                |
| Integration | test-mode server                              | Extend `mock-data.js`; manual smoke via `npm run test-mode`                            |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary. Change is confined to Graph API attachment endpoints.

## Migration / Rollout

No migration required. No schema or data changes. Rollback = `git revert` the change set (config + email/* + mock-data + tests); `read-email` reverts to current behavior, new tools disappear from MCP surface.

## Open Questions

None — all spec scenarios have a clear implementation path.
