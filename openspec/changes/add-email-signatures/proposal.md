# Proposal: Add Managed Email Signatures

## Intent

Let users manage reusable HTML signatures and apply them consistently to new messages, replies, and drafts. Today callers compose signatures manually, and the MCP cannot safely persist embedded logos.

## Scope

### In Scope

- Store named, sanitized HTML signatures with MCP-managed base64 images.
- Configure one default signature shared by send, reply, draft, and reply-draft flows.
- Support per-operation `signatureName` selection and `includeSignature: false` opt-out.
- Embed images as Graph inline CID attachments and persist them separately through atomic, serialized writes.
- Add MCP tools to manage signatures and select the default.

### Out of Scope

- Fetching or proxying remote image URLs.
- Context-specific defaults, selection rules, or Outlook signature synchronization.
- General-purpose outgoing file attachments or rich signature editing UI.

## Capabilities

### New Capabilities

- `email-signatures`: Lifecycle, secure storage, default selection, overrides, opt-out, and CID composition.

### Modified Capabilities

- `email`: Apply signatures across new-message, native-reply, draft, and reply-draft operations without changing unsigned behavior.

## Approach

Add a signature store and composer outside the authentication cache. Validate names, sanitize HTML with an allowlist, reject remote/data images, and bind `cid:` references to managed assets. Resolve `includeSignature` and `signatureName` centrally. For CID signatures, create Graph drafts, add inline `fileAttachment` objects, then save or send as required.

## Affected Areas

| Area                              | Impact       | Description                                           |
| --------------------------------- | ------------ | ----------------------------------------------------- |
| `signature/`                      | New          | Persistence, validation, composition, and tools       |
| `email/send.js`, `email/draft.js` | Modified     | Shared signature resolution and CID-aware Graph flows |
| `email/index.js`, `index.js`      | Modified     | Operation inputs and signature tool registration      |
| `test/signature/`, `test/email/`  | New/Modified | Security, persistence, and flow coverage              |

## Risks

| Risk                                          | Likelihood | Mitigation                                                |
| --------------------------------------------- | ---------- | --------------------------------------------------------- |
| Unsafe HTML or image references               | Medium     | Strict allowlist, CID validation, no network fetches      |
| Concurrent store corruption                   | Medium     | Mode `0600`, atomic rename, serialized mutations          |
| Reply formatting or CID placement regressions | Medium     | Central composer and focused Graph request-contract tests |

## Rollback Plan

Remove signature tools and composition hooks, restoring current send/draft paths. Preserve the separate signature file to avoid data loss.

## Dependencies

- Microsoft Graph message draft, inline `fileAttachment`, and send endpoints.
- A maintained CommonJS-compatible HTML sanitizer, selected during design.

## Success Criteria

- [ ] Users can manage multiple signatures and one shared default.
- [ ] Default, named override, and opt-out behavior works in all four email flows.
- [ ] Logos render from managed CID attachments without remote retrieval.
- [ ] Unsafe HTML/references are rejected or sanitized, and storage updates are atomic.
- [ ] Existing email behavior remains unchanged when no signature is configured.
