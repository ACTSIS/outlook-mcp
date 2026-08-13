# Design: Add Managed Email Signatures

## Technical Approach

Add a private versioned JSON store, strict signature-only HTML validation, and one composer used by `send-email` and `draft-email`. Preserve current Graph calls when unsigned; signed messages become HTML, bind managed images as inline `fileAttachment` values, and retain native reply semantics. `sanitize-html` is the CommonJS-compatible allowlist parser; the existing inbound `utils/html-sanitizer.js` is text extraction and is not reusable for outgoing HTML.

## Architecture Decisions

| Decision       | Choice                                                                                                                                                                                                                               | Alternatives / rationale                                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Persistence    | `~/.outlook-mcp-signatures.json`, schema v1, mode `0600`; process-wide mutation promise; reload, validate a clone, write/fsync a same-directory exclusive temp file, rename, then swap cache                                         | Token cache coupling leaks concerns; direct writes can truncate. Rename preserves the prior file on failure. One MCP process owns serialization.                                      |
| HTML safety    | Sanitize on mutation and again on composition with `sanitize-html`; allow formatting/table tags and bounded style properties, `mailto:`/`tel:` links, and only `cid:` image sources                                                  | Regex and the inbound text sanitizer cannot safely preserve HTML. Remote/data URLs, scripts, handlers, classes, and unknown CSS are removed; invalid image sources fail the mutation. |
| CID integrity  | HTML `cid:<contentId>` must map one-to-one to stored images; attach with matching `contentId`, `isInline: true`, MIME type, filename, and base64 bytes                                                                               | Remote loading creates privacy/SSRF risk; unbound or unused assets indicate malformed state.                                                                                          |
| Delivery       | New messages carry attachments in the existing single `sendMail`/draft-create payload. CID replies use `createReply`, patch composed body, add attachments, then optionally send                                                     | Single-call new-message flows preserve `saveToSentItems` and avoid partial drafts. Reply attachments require a native draft.                                                          |
| Failure policy | Missing store means unsigned state; corrupt/invalid configured state fails closed before Graph. Multi-step reply failures return stage and draft ID, leave the recoverable draft, and never call send before all attachments succeed | Silently omitting a requested/default signature is unsafe; deleting partial drafts can destroy recovery evidence.                                                                     |

## Data Flow

```text
tool args -> resolve opt-out > named > default -> outbound validation -> compose HTML + attachments
                                                       |
new send:   sendMail(message + inline attachments) <---+
new draft:  POST /me/messages (message + attachments) <-+
reply:      createReply -> PATCH body -> POST attachment(s) -> POST /send
reply draft:createReply -> PATCH body -> POST attachment(s) -> return draft
```

For signed plain text, escape the body and convert line breaks before appending a signature container. For reply drafts, place authored body plus signature before the Graph-generated quoted body so the thread remains intact.

## File Changes

| File                                                            | Action        | Description                                                   |
| --------------------------------------------------------------- | ------------- | ------------------------------------------------------------- |
| `signature/store.js`                                            | Create        | Versioned private store and serialized atomic mutations       |
| `signature/sanitizer.js`                                        | Create        | Outgoing allowlist, CID/base64/MIME checks, limits            |
| `signature/composer.js`                                         | Create        | Resolution, HTML composition, Graph attachment mapping        |
| `signature/index.js`                                            | Create        | Create/list/get/update/delete/set-default MCP tools           |
| `email/graph-message-flow.js`                                   | Create        | Shared four-flow Graph orchestration and staged errors        |
| `email/send.js`, `email/draft.js`, `email/index.js`, `index.js` | Modify        | Delegate composition, expose selection inputs, register tools |
| `package.json`, lockfiles                                       | Modify        | Add `sanitize-html`                                           |
| `test/signature/*.test.js`, `test/email/{send,draft}.test.js`   | Create/Modify | Store, security, schema, composition, and Graph contracts     |

## Interfaces / Contracts

```js
{ version: 1, defaultName: null, signatures: {
  work: { name: 'work', html: '<p>...</p>', images: [
    { contentId: 'brand-logo', fileName: 'logo.png', contentType: 'image/png', contentBytes: '...' }
  ] }
} }
```

Tools: `create-email-signature`, `list-email-signatures`, `get-email-signature`, `update-email-signature`, `delete-email-signature`, and `set-default-email-signature` (omitted `name` clears). Email inputs add `signatureName` and `includeSignature`.

Limits: 50 signatures, 100 KiB HTML, 10 images/signature, 1 MiB decoded/image, 2 MiB decoded/signature, and supported PNG/JPEG/GIF image types. Names and content IDs are 1–64 ASCII letters, digits, `.`, `_`, or `-`.

## Testing Strategy

| Layer       | What to Test                                                                                               | Approach                                                                       |
| ----------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Unit        | Queue ordering, atomic rollback, sanitization, limits, CID bijection, precedence, text escaping            | Jest with temporary HOME/store and injected filesystem failures                |
| Integration | Six tool schemas and all four Graph sequences, quote preservation, attachment payloads, no-send-on-failure | Mock `ensureAuthenticated` and `callGraphAPI`; assert exact order and payloads |
| Regression  | Unsigned payloads and errors                                                                               | Preserve existing email tests                                                  |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary.

## Migration / Rollout

No migration required. Absence of the v1 store preserves current behavior. Rollback removes registration/composition while retaining the store.

## Open Questions

None.
