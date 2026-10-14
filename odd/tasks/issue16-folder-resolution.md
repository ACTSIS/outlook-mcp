# FIX: #16 — folder listing misses nested subfolders; silent inbox fallback

Issue: https://github.com/ACTSIS/outlook-mcp/issues/16
Branch: `fix/folder-resolution-nesting`
Source: internal IA-assistance report (SAC support pilot), section "MCP server defects" (a) and (b).

## Status: COMPLETED (recovered orphaned doc)

- PR #19 merged into `main` (`c29ad12`); issue #16 closed at merge time (2026-10-07).
- T1 -> commit `1d9596c` (strict folder resolution: unknown folder throws "Folder not found", no silent inbox fallback).
- T2 -> commit `5e09c2f` (folder enumeration at every nesting level with full pagination).
- T3 -> included in both commits: `folder/index.js` description, `openspec/specs/email/spec.md` scenario, tests in `test/email/folder-utils.test.js` and `test/folder/list.test.js`.
- This tracking doc was authored before implementation but never committed; the PR branch merge did not carry it. Recovered and committed on 2026-10-14 as historical record.

## Evidence (local code)

- `email/folder-utils.js` `resolveFolderPath` silently falls back to `WELL_KNOWN_FOLDERS['inbox']` when a named folder is not found or the API call fails → searches run against inbox and return unrelated results without any error.
- `email/folder-utils.js` `resolveSegmentInParent` and `getAllFolders` use fixed `$top: 100`; folders past page 1 or deeper nesting levels are missing.
- `folder/list.js` `getAllFoldersHierarchy` descends only one level of children.

## Tasks

### T1: Strict folder resolution (no silent inbox fallback) — RED→GREEN

- Tests first in `test/email/folder-utils.test.js`: unknown folder must throw a clear `Folder not found` error; unchanged cases: no folder/empty → inbox endpoint, well-known folders, existing custom folders, path resolution.
- Update existing two tests that assert inbox fallback (behavior change is the point of the issue).
- Implementation: `resolveFolderPath` throws `Folder not found: "<name>"` when `getFolderIdByName` returns null or errors. Callers (`email/list.js`, `email/search.js`) already wrap errors into MCP error responses — verify in handler tests.

### T2: Paginated + recursive folder enumeration — RED→GREEN

- Tests first: page traversal past `$top` 100 (`callGraphAPIPaginated` semantics), recursive descent through all `childFolderCount > 0` levels, parent attribution for tree formatting, cycle/depth guard.
- Implementation: shared recursive loader in `email/folder-utils.js`; `folder/list.js` `getAllFoldersHierarchy` uses it; both top-level fetch and child fetches paginate fully.

### T3: Docs + OpenSpec + commit

- Update `folder/index.js` tool description if behavior wording changes; update `openspec` email spec scenario for strict folder resolution; run focused suites + full suite; commit `fix(folders): ...`.

## Checks per task

- `npx jest test/email/folder-utils.test.js test/folder/list.test.js test/email/list.test.js test/email/search.test.js`
- Full `npm test` before each commit; `npx eslint` + `npx prettier --check` on touched files.
