# FIX: #17 — reported attachment size differs from actual binary size

Issue: https://github.com/ACTSIS/outlook-mcp/issues/17
Branch: `fix/attachment-size-binary` (to create from main)
Source: internal IA-assistance report (SAC support pilot), "Defects observed in the MCP server".

## Evidence

- `email/download-attachment.js:78` reports `attachment.size` (Graph metadata) while outputting the decoded/base64 content; the actual binary consistently differs (~450 bytes).
- `email/list-attachments.js:53` and `email/read.js:126` report the same metadata in listings (metadata-only source — document, don't over-fetch).

## Tasks

### T1: real binary size in download-attachment — RED→GREEN

- Compute real size from `Buffer.from(contentBytes, 'base64').length`; report it as the authoritative size (keep metadata size labeled as such when both available); base the warning threshold on the real size.
- Tests with a known fixture asserting reported size == decoded binary length; cover empty content, text decode path, warning-on-real-size.

### T2: document listing semantics + commit

- Note in tool descriptions/README/OpenSpec that listing sizes are Graph metadata and may differ from the actual binary; download reports the exact binary size.

## Checks

- `npx jest test/email/download-attachment.test.js test/email/list-attachments.test.js test/email/read.test.js`; full suite before commit; lint/format on touched files.
