# Feature: sites-content-redirect (issue #43)

Fix `onedrive-download-site-file` (sites/download-site-file.js): obtain the
pre-authenticated URL from the `/content` 302 redirect instead of the unpopulated
`@microsoft.graph.downloadUrl` property. Same pattern as issue #41 / PR #42.
Branch: `feat/sites-content-redirect`.

## Specs

- S1: "`onedrive-download-site-file` (delivered with issue #18) selects
  `@microsoft.graph.downloadUrl` and fails with 'Could not get download URL for this
  item.' when Graph does not populate that property." → the handler MUST obtain the
  pre-authenticated URL from `callGraphAPIDownload` against the site drive item's
  `/content` endpoint; the tool contract stays URL-returning.
- S2: "fetch item metadata with `$select=id,name,size,folder` (also makes the
  existing folder detection actually fire; today `$select` omits `folder`)" →
  folder behavior and its message stay; they are now observable with real metadata.
- S3: "keep the URL-returning contract and the 403 SITE_ACCESS_DENIED handling
  unchanged" → validation errors, auth errors, 403 mapping, and the generic error
  message must continue passing.
- S4: drive-path segment encoding (spaces, non-ASCII) stays exact; the `/content`
  suffix appends to the already-encoded endpoint.

## Tasks

- T1 (S1, S2, S4) test(sites): RED expectations for redirect-based download in
  test/sites/download-site-file.test.js (updating expectations that pinned the defect)
- T2 (S1, S2) fix(sites): redirect implementation in sites/download-site-file.js, GREEN + suite
- T3 (S3) verification: live end-to-end + full suite + lint + format
- T4 (S3) docs: OpenSpec sharepoint spec + README; commits; PR (Fixes #43)
  → DONE: commits f49dadd (fix), 4ec32ec (docs); PR #44 opened and MERGEABLE;
  native assess risk medium / reviewDue=false (under_budget, 5 files / 137 lines);
  CI PASS both runs (Node 22.22.1 + 24). Merge owner decision.

## Log

- L1: Issue ACTSIS/outlook-mcp#43 created from PR #42 follow-up note; owner
  instructed "Hagamos merge y luego seguimos con sites" (2026-10-15).
- L2: Live evidence 2026-10-15 (delegated token, Graph v1.0, site Test-BranchNET):
  `GET /sites/{id}/drive/items/{id}?$select=...,@microsoft.graph.downloadUrl` → 200
  without the property (Funcionalidades_ReunionInicial.docx, 19783 B);
  `GET /sites/{id}/drive/items/{id}/content` → 302 Found with pre-authenticated
  `Location`. Identical to the onedrive/behavior verified for issue #41.
