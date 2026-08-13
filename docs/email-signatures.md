# Managed email signatures

The MCP stores reusable HTML signatures separately from authentication and can apply one shared
default to new sends, native replies, new drafts, and native reply drafts. No remote image is
downloaded while saving or composing a message.

## Manage signatures

Use `create-email-signature`, `list-email-signatures`, `get-email-signature`,
`update-email-signature`, `delete-email-signature`, and `set-default-email-signature`. Omitting
`name` from `set-default-email-signature` clears the default. Deleting the default also clears it.

Selection order for every `send-email` and `draft-email` operation is:

1. `includeSignature: false` omits a signature.
2. `signatureName` selects that stored signature and fails if it does not exist.
3. Otherwise, the shared default is used when configured.
4. Without a selected signature, the existing unsigned email behavior is preserved.

## HTML and CID images

Signature HTML is allowlisted. Scripts, event handlers, remote URLs, `data:` images, unsupported
CSS, and other executable or external content are removed or rejected. Images must use a CID that
matches exactly one managed image:

```json
{
  "name": "work",
  "html": "<p>Ricardo</p><img src=\"cid:brand-logo\" alt=\"Company logo\">",
  "images": [
    {
      "contentId": "brand-logo",
      "fileName": "logo.png",
      "contentType": "image/png",
      "contentBytes": "BASE64_BYTES"
    }
  ]
}
```

Supported image types are PNG, JPEG, and GIF. Names and content IDs accept 1–64 ASCII letters,
digits, `.`, `_`, or `-`. Limits are 50 signatures, 100 KiB HTML per signature, 10 images per
signature, 1 MiB decoded per image, and 2 MiB decoded across a signature.

## Storage and reply recovery

State is stored in `~/.outlook-mcp-signatures.json` with schema version 1 and private mode `0600`.
Mutations are serialized and replace the file atomically. A corrupt configured store fails closed;
it does not silently omit a requested signature.

Signed native replies use a Graph reply draft so the MCP can preserve the generated quoted body,
patch the authored HTML, and add inline attachments. A send occurs only after every CID attachment
succeeds. If body update, attachment creation, or send fails, the error identifies the stage and
draft ID; the recoverable draft is retained instead of deleted.

For safe validation, use `draft-email` with `replyToId`, then inspect the returned draft and
attachments. This exercises native threading and CID delivery without sending mail.
