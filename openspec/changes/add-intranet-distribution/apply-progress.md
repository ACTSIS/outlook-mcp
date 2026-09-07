# Apply Progress: add-intranet-distribution — PR 1 (manifest module)

## Work unit

- PR 1 — Manifest module (TDD)
- Branch: `feat/intranet-distribution-01-manifest`
- Scope: `build/proget-manifest.js` + `test/build/proget-manifest.test.js` only

## Completed tasks (Phase 1)

- [x] 1.1 Write RED test: `test/build/proget-manifest.test.js` first failed because `build/proget-manifest.js` did not exist.
- [x] 1.2 Implement `build/proget-manifest.js` exporting `buildManifest` as a pure CommonJS function.
- [x] 1.3 / 1.4 TRIANGULATE: extend tests for URLs, checksum parsing, fail-closed validation; implement `parseSha256sums`, `assetUrl`, and validation.
- [x] 1.5 Add thin CLI mode and verify round-trip stdout matches `buildManifest` output.
- [x] 1.6 Verify `npm test` and lint/format checks green.

## TDD Cycle Evidence

| Cycle       | Test action                                                                                                                           | Result                                                                       | Notes                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------- |
| RED         | Wrote `test/build/proget-manifest.test.js` with deterministic-output test                                                             | `npx jest test/build/proget-manifest.test.js` failed: module not found       | Confirmed module did not exist                                 |
| GREEN       | Implemented `build/proget-manifest.js` with `buildManifest`                                                                           | Focused Jest passed                                                          | Minimal implementation to satisfy first test                   |
| TRIANGULATE | Added tests for URL shape, checksum parsing, `v` prefix rejection, missing checksum, malformed line, missing inputs, stable key order | All passed after implementing `parseSha256sums`, `assetUrl`, `validateInput` | Fail-closed validation with clear `[proget-manifest]` messages |
| REFACTOR    | Added CLI `parseArgs`/`main`, stdin SHA256SUMS reader, environment-driven ProGet config; added CLI round-trip test                    | Focused Jest passed; full `npm test` passed                                  | CLI output equals pure-function output for same inputs         |

## Files changed

- `build/proget-manifest.js` (new)
- `test/build/proget-manifest.test.js` (new)
- `openspec/changes/add-intranet-distribution/tasks.md` (checkbox updates for 1.x)
- `openspec/changes/add-intranet-distribution/apply-progress.md` (this file)

## Verification commands and results

```text
npx jest test/build/proget-manifest.test.js --no-coverage        PASS  12 tests
npx prettier --check build/proget-manifest.js test/build/proget-manifest.test.js   OK
npx eslint build/proget-manifest.js test/build/proget-manifest.test.js             OK
npm test -- --runInBand --forceExit                              PASS  527 tests, 35 suites
```

## Deviations from design

None. The CLI uses environment variables `PROGET_BASE_URL`, `PROGET_ASSET_DIRECTORY`, and `PROGET_TARGET_PREFIX` for ProGet configuration, which matches the planned `publish-artifacts` workflow environment and keeps the published command-line contract (`--version`, `--date`, `--assets`) identical to the design.

## Remaining work (out of scope for this PR)

Phase 2–6 tasks remain unchecked; they are assigned to PRs 2–5 per the chained PR plan.
