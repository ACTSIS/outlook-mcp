# Feature: onedrive-content-raw (issue #41)

Fix `onedrive_upload` content corruption (JSON.stringify body wrap) and broken
`onedrive_download` (`@microsoft.graph.downloadUrl` not populated), per
ACTSIS/outlook-mcp#41. Branch: `feat/onedrive-content-raw`.

## Specs

- S1: "`onedrive_upload` stores files as JSON string literals instead of raw content.
  The shared Graph API helper serializes every PUT body with `JSON.stringify()` and
  pins `Content-Type: application/json`, so any file whose content contains characters
  that JSON escapes (quotes, newlines, backslashes) is stored corrupted."
  → onedrive-upload must send text content bytes unmodified (no JSON wrap) with a
  correct non-JSON Content-Type; the stored size must equal the source UTF-8 size.
- S2: "optionally accept a `base64` flag or a local file path (the same way
  `draft_email` attachments already read from the MCP host filesystem) so binary
  files work natively." → onedrive-upload accepts optional base64-encoded content
  decoded to a Buffer and sent as `application/octet-stream`.
  Decision (2026-10-15, owner-confirmed scope "upload + download"): local file path
  option excluded to keep the MCP contract minimal.
- S3: "For downloads, follow the 302 redirect of the `/content` endpoint instead of
  depending on the `downloadUrl` property." → onedrive-download obtains the
  pre-authenticated URL from the 302 `Location` of `/content` (verified live
  2026-10-15: downloadUrl absent in delegated metadata; `/content` returns 302 +
  Location). Tool contract stays URL-returning (Log L2).
- S4: "Preserve the public tool name and input schema unless the change explicitly
  modifies the MCP contract." → only additive optional params; existing tool names,
  required params, and response shapes for other tools unchanged.
- S5: callGraphAPI JSON default behavior unchanged for every existing caller; raw
  bodies are opt-in via explicit options; 401 still maps to `UNAUTHORIZED`; raw
  bodies set explicit `Content-Length`.

## Tasks

- T1 (S2, S5) feat(graph-api): raw body option in callGraphAPI + tests
  → DONE: commit 12ef7d0 (RED 2 failed → GREEN 36/36 test/utils/graph-api.test.js)
- T2 (S1, S2) fix(onedrive): upload sends raw body with correct Content-Type + base64 support + tests
  → DONE: commit 1438d40 (RED 5 failed → GREEN 49/49 test/onedrive/ + graph-api suite)
- T3 (S3) fix(onedrive): download via `/content` 302 Location redirect + tests
  → DONE: commit 34ba749 (RED 4 failed → GREEN 21/21 test/onedrive/)
- T4 (S5) verification: live end-to-end + full suite + lint + format
  → DONE: commit 0d15e29 (runtime/verify-issue41.js; TEXT 845 B / BIN 1024 B byte-identical=true;
  900/900 tests, eslint clean, prettier clean; drive test artifacts deleted)
- T5 (S4) docs: README + OpenSpec onedrive spec; record evidence
  → DONE: commit 27fdea9 (new openspec/specs/onedrive/spec.md + traceability row)
- T6 delivery: PR #42 (Fixes #41, base main, head feat/onedrive-content-raw).
  Native assess: risk medium, reviewDue=false (under_budget, base-diff 13 files / 874 lines,
  plan writerSelfVerification only) — no native review lineage opened per contract.
  CI (Node 22.22.1/24: npm ci, lint, test): both runs PASS — merged as accf2c8.

## Log

- L1: User request (2026-10-15): "Tenemos un nuevo issue reportado, revisalo" —
  issue ACTSIS/outlook-mcp#41 by rafaga2469; owner approved full scope
  (upload + download) via explicit choice.
- L2: Decision: `onedrive-download` keeps its URL-returning contract; it obtains the
  URL from the `/content` 302 `Location` (reusing `callGraphAPIDownload`) instead of
  returning file bytes.
- L3: Live evidence 2026-10-15 (delegated token, Graph v1.0):
  `GET /me/drive/items/{id}?$select=@microsoft.graph.downloadUrl` → 200 without the
  property; `GET /me/drive/items/{id}/content` → 302 Found with pre-authenticated
  `Location` (Document.docx, 9412 B). Folder items → 404 on `/content` as expected.
- L4: Follow-up finding (same root cause family, outside this issue's explicit scope):
  sites/download-site-file.js (issue #18) still selects `@microsoft.graph.downloadUrl`,
  which the live check showed not populated in delegated contexts — same fix pattern
  (callGraphAPIDownload on the site's `/content` endpoint) applies. Surfaced at close
  for a follow-up issue.
