: Intranet distribution via ProGet — PR 1 (manifest module) + PR 2 (Linux packaging)

> Artifact retrieval note: the openspec planning files (`design.md`, `tasks.md`,
> `specs/distribution/spec.md`) are committed on the tracker branch
> `feat/intranet-distribution` but were not present on the child branch
> `feat/intranet-distribution-02-linux`. This progress was produced after reading
> those authoritative files directly from the tracker branch with `git show`.

## Work unit PR 1 — Manifest module (TDD)

- Branch: `feat/intranet-distribution-01-manifest`
- Scope: `build/proget-manifest.js` + `test/build/proget-manifest.test.js` only

### Completed tasks (Phase 1)

- [x] 1.1 Write RED test: `test/build/proget-manifest.test.js` first failed because `build/proget-manifest.js` did not exist.
- [x] 1.2 Implement `build/proget-manifest.js` exporting `buildManifest` as a pure CommonJS function.
- [x] 1.3 / 1.4 TRIANGULATE: extend tests for URLs, checksum parsing, fail-closed validation; implement `parseSha256sums`, `assetUrl`, and validation.
- [x] 1.5 Add thin CLI mode and verify round-trip stdout matches `buildManifest` output.
- [x] 1.6 Verify `npm test` and lint/format checks green.

### TDD Cycle Evidence (PR 1)

| Cycle       | Test action                                                                                                                           | Result                                                                       | Notes                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------- |
| RED         | Wrote `test/build/proget-manifest.test.js` with deterministic-output test                                                             | `npx jest test/build/proget-manifest.test.js` failed: module not found       | Confirmed module did not exist                                 |
| GREEN       | Implemented `build/proget-manifest.js` with `buildManifest`                                                                           | Focused Jest passed                                                          | Minimal implementation to satisfy first test                   |
| TRIANGULATE | Added tests for URL shape, checksum parsing, `v` prefix rejection, missing checksum, malformed line, missing inputs, stable key order | All passed after implementing `parseSha256sums`, `assetUrl`, `validateInput` | Fail-closed validation with clear `[proget-manifest]` messages |
| REFACTOR    | Added CLI `parseArgs`/`main`, stdin SHA256SUMS reader, environment-driven ProGet config; added CLI round-trip test                    | Focused Jest passed; full `npm test` passed                                  | CLI output equals pure-function output for same inputs         |

### Files changed (PR 1)

- `build/proget-manifest.js` (new)
- `test/build/proget-manifest.test.js` (new)
- `openspec/changes/add-intranet-distribution/tasks.md` (checkbox updates for 1.x)
- `openspec/changes/add-intranet-distribution/apply-progress.md` (this file)

### Verification commands and results (PR 1)

```text
npx jest test/build/proget-manifest.test.js --no-coverage                        PASS  12 tests
npx prettier --check build/proget-manifest.js test/build/proget-manifest.test.js OK
npx eslint build/proget-manifest.js test/build/proget-manifest.test.js          OK
npm test -- --runInBand --forceExit                                              PASS  527 tests, 35 suites
```

### Deviations from design (PR 1)

None. The CLI uses environment variables `PROGET_BASE_URL`, `PROGET_ASSET_DIRECTORY`, and `PROGET_TARGET_PREFIX` for ProGet configuration, which matches the planned `publish-artifacts` workflow environment and keeps the published command-line contract (`--version`, `--date`, `--assets`) identical to the design.

---

## Work unit PR 2 — Linux packaging + smoke harness

- Branch: `feat/intranet-distribution-02-linux`
- Scope: `build/linux/toolchain.lock.yaml`, `build/linux/fetch-tools.sh`, `build/linux/scripts/postinst`, `build/linux/scripts/postrm`, `build/linux/nfpm.yaml.tmpl`, `build/linux/package-deb.sh`, `build/linux/tests/container-smoke.sh`, `test/build/linux-packaging.test.js` (structural), and `.prettierignore` (so `nfpm.yaml.tmpl` does not break `prettier --check .`).
- Out of scope: Windows NSIS, workflow edits, README end-user docs, manifest module changes.

### Completed tasks (Phase 2)

- [x] 2.1 Create `build/linux/toolchain.lock.yaml` pinning nfpm 2.47.0, its GitHub release URL, and SHA-256 (`0660ca602b2d2d2ae4781a06c692b3eeb9d437ffea05b831d76e41f4a3188783`).
- [x] 2.2 Create `build/linux/fetch-tools.sh` (`set -euo pipefail`) that downloads nfpm, verifies the pinned SHA-256, rejects redirects to untrusted hosts, and installs the binary to a tools dir placed on `PATH`.
- [x] 2.3 Create `build/linux/scripts/postinst` and `build/linux/scripts/postrm` as no-op `#!/bin/sh` + `exit 0` scripts.
- [x] 2.4 Create `build/linux/nfpm.yaml.tmpl` with `name: outlook-mcp`, `arch: amd64`, the required placeholders, `/usr/bin/outlook-mcp` destination, mode `0755`, and postinstall/postremove hooks.
- [x] 2.5 Create `build/linux/package-deb.sh` (`set -euo pipefail`) that requires `GITHUB_REF_NAME=v<semver>` and `GITHUB_SHA`, derives `Depends` via `dpkg-shlibdeps`, renders the nfpm template, invokes nfpm, and prints the resulting `.deb` path.
- [x] 2.6 Create `build/linux/tests/container-smoke.sh` per ADR 3: container-only lifecycle smoke (install, `mcp` boot, `auth` HTTP 200, upgrade, remove, purge) that also asserts `~`-scoped fixtures are untouched.
- [x] 2.7 Verify: `bash -n` passes on all `build/linux/*.sh` scripts; structural Jest checks pass; full `npm test`, `npm run lint`, and `npm run format:check` are green.

### TDD Cycle Evidence (PR 2)

| Cycle       | Test action                                                                                                                                               | Result                                                                          | Notes                                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------- |
| RED         | Wrote `test/build/linux-packaging.test.js` asserting the packaging files exist, parse, and carry required placeholders                                    | `npx jest test/build/linux-packaging.test.js` failed: ENOENT / `bash -n` failed | Confirmed `build/linux/` did not exist              |
| GREEN       | Created the Linux packaging files (`toolchain.lock.yaml`, `fetch-tools.sh`, maintainer scripts, `nfpm.yaml.tmpl`, `package-deb.sh`, `container-smoke.sh`) | Focused Jest passed; `bash -n` passed on all scripts                            | Minimal implementation satisfying structural checks |
| TRIANGULATE | Ran `bash -n` on each shell script; ran `npm test` and lint/format over the repo                                                                          | All green                                                                       | Added `.prettierignore` entry for `.yaml.tmpl`      |
| REFACTOR    | None required; scripts stay verbose and fail-closed per ADR 9 / design                                                                                    | N/A                                                                             | No production code compression to fit budget        |

### Files changed (PR 2)

- `build/linux/toolchain.lock.yaml` (new)
- `build/linux/fetch-tools.sh` (new)
- `build/linux/scripts/postinst` (new)
- `build/linux/scripts/postrm` (new)
- `build/linux/nfpm.yaml.tmpl` (new)
- `build/linux/package-deb.sh` (new)
- `build/linux/tests/container-smoke.sh` (new)
- `test/build/linux-packaging.test.js` (new — structural Jest surface)
- `.prettierignore` (added `build/linux/nfpm.yaml.tmpl`)

### Verification commands and results (PR 2)

```text
npx jest test/build/linux-packaging.test.js --no-coverage                        PASS  4 tests
for s in build/linux/fetch-tools.sh build/linux/package-deb.sh build/linux/tests/container-smoke.sh; do bash -n "$s"; done   OK
npx prettier --check .                                                           OK
npm run lint                                                                     OK
npm test -- --runInBand --forceExit                                              PASS  531 tests, 36 suites
```

### Deviations from design (PR 2)

None. `package-deb.sh` keeps the design's placeholder names and no-op maintainer scripts, and `fetch-tools.sh` pins nfpm with the same lockfile shape used elsewhere in the org pattern. `container-smoke.sh` is parameterized by the `.deb` path and assumes it runs inside an `ubuntu:24.04` container, matching the `smoke` job design in PR 4.

### Docker limitation (recorded)

The container smoke harness was structured to run inside `docker run ubuntu:24.04`, but Docker is not available in this development environment, so the actual end-to-end `.deb` install/boot/purge path was not executed locally. The script is validated syntactically (`bash -n`) and structurally (Jest); PR 4's CI `smoke` job is the first automated execution surface.

### Remaining work (out of scope for this PR)

- Phase 3 — Windows NSIS (`build/windows/installer.nsi`).
- Phase 4 — Workflow jobs + re-scoped secrets test (`test/build/release-workflow.test.js`, `.github/workflows/release.yml`).
- Phase 5 — README intranet installation section and glibc correction.
- Phase 6 — Final validation sweep after all PRs land.

---

## Work unit PR 3 — Windows NSIS installer

- Branch: `feat/intranet-distribution-03-windows`
- Scope: `build/windows/installer.nsi` + `test/build/windows-installer.test.js` (structural Jest surface).
- Out of scope: Linux packaging files, workflow edits, README, manifest module changes.

### Completed tasks (Phase 3)

- [x] 3.1 Create `build/windows/installer.nsi` per ADR 2: `!include "x64.nsh"` + `!include "WinMessages.nsh"`; `RequestExecutionLevel admin`; `SetCompressor lzma`; `${IfNot} ${RunningX64}` → `MessageBox` + `Abort` before any write; `InstallDir "$PROGRAMFILES64\outlook-mcp"`; `SetRegView 64`; `File /oname=outlook-mcp.exe` the staged SEA exe; PATH registry append to `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment\Path` (guarded against duplicate) + `WM_SETTINGCHANGE` broadcast; uninstall registry entry (`DisplayName`, `DisplayVersion` from `-DVERSION`, `UninstallString`, `Publisher`); uninstall section deleting files, removing the PATH entry + re-broadcast, and deleting the uninstall registry key; output name `outlook-mcp-setup.exe`. No EnVar plugin, no Start Menu shortcut.
- [ ] 3.2 Verify: `makensis -DVERSION=<pkg version> build\windows\installer.nsi` compiles with stock choco NSIS. Deferred to CI because `makensis` is not installed in this environment.

### TDD Cycle Evidence (PR 3)

| Cycle       | Test action                                                                                                                               | Result                                                         | Notes                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------- |
| RED         | Wrote `test/build/windows-installer.test.js` asserting the required NSIS directives before `build/windows/installer.nsi` existed          | `npx jest test/build/windows-installer.test.js` failed: ENOENT | Confirmed `build/windows/installer.nsi` did not exist |
| GREEN       | Created `build/windows/installer.nsi` with the x64 guard, ProgramFiles64 install dir, PATH append/broadcast, uninstaller, and output name | Focused Jest passed                                            | Minimal implementation satisfying structural checks   |
| TRIANGULATE | Added assertions for `OutFile`, `RequestExecutionLevel admin`, `SetCompressor lzma`, and `WinMessages.nsh` inclusion                      | All focused tests passed                                       | Strengthens structural contract without compilation   |
| REFACTOR    | None required; NSIS script stays explicit and dependency-free per ADR 2                                                                   | N/A                                                            | No production code compression to fit budget          |

### Files changed (PR 3)

- `build/windows/installer.nsi` (new)
- `test/build/windows-installer.test.js` (new — structural Jest surface)
- `openspec/changes/add-intranet-distribution/tasks.md` (checkbox update for 3.1)
- `openspec/changes/add-intranet-distribution/apply-progress.md` (this file)

### Verification commands and results (PR 3)

```text
npx jest test/build/windows-installer.test.js --no-coverage                        PASS  8 tests
npx prettier --check . (after formatting)                                          OK
npm run lint                                                                     OK
npm test -- --runInBand --forceExit                                              PASS  539 tests, 37 suites
```

### makensis limitation (recorded)

The `makensis` compiler is not available in this development environment, so the script was not compiled locally. Correctness rests on the proven timetracker NSIS template, the structural Jest assertions, and review. PR 4's CI `installer-windows` job (`choco install nsis; makensis -DVERSION=<ver> build\windows\installer.nsi`) is the first automated compilation surface.

### Deviations from design (PR 3)

None. The script uses only stock NSIS headers (`x64.nsh`, `WinMessages.nsh`, `StrFunc.nsh`, `LogicLib.nsh`) and avoids the EnVar plugin and Start Menu shortcuts as required by ADR 2.

### Remaining work (out of scope for this PR)

- Phase 4 — Workflow jobs + re-scoped secrets test (`test/build/release-workflow.test.js`, `.github/workflows/release.yml`).
- Phase 5 — README intranet installation section and glibc correction.
- Phase 6 — Final validation sweep after all PRs land.

---

## Work unit PR 4 — Workflow jobs + re-scoped secrets test (ATOMIC)

- Branch: `feat/intranet-distribution-04-workflow`
- Scope: `.github/workflows/release.yml` (additive jobs only), `test/build/release-workflow.test.js` (re-scoped secrets assertions + structural tests for the new jobs).
- Out of scope: README/docs (PR 5), Linux/Windows build files (must not be modified — were read for wiring only).

### Atomicity rationale

The re-scoped `/\bsecrets\./` assertions reference jobs that do not exist until the workflow is extended; the extended workflow introduces `secrets.NETBIRD_SETUP_KEY` and `secrets.PROGET_API_KEY`, which the old blanket ban forbade. Either half fails `npm test`, so both must land in the same commit.

### Completed tasks (Phase 4)

- [x] 4.1 RED: re-scoped `test/build/release-workflow.test.js` with fail-closed secret allowlist, positive consumption assertions, and structural assertions for the six new jobs.
- [x] 4.2 GREEN: added `installer-windows` job (windows-latest, NSIS via choco, drift check, `makensis -DVERSION=<ver>`).
- [x] 4.3 GREEN: added `installer-linux` job (ubuntu-latest, `fetch-tools.sh`, `package-deb.sh`, `.deb` payload secret scan).
- [x] 4.4 GREEN: added `smoke` job (ubuntu-latest, docker `ubuntu:24.04`, `container-smoke.sh`).
- [x] 4.5 GREEN: added `provenance` job (ubuntu-latest, SHA256SUMS + SBOM via `anchore/sbom-action@v0`).
- [x] 4.6 GREEN: added `publish-artifacts` job (NetBird up, fail-closed secret guard, retry POST uploads to ProGet, `build/proget-manifest.js` → `latest-stable.json`, NetBird down `if: always()`, ref-keyed concurrency).
- [x] 4.7 GREEN: added `cleanup` job (`needs` all upstream jobs, `if: always()`, artifact deletion via `gh api`).
- [x] 4.8 Verification: `release` job block unchanged per `git diff`; every new job has `permissions: contents: read` and `timeout-minutes`; full `npm test` green.

### TDD Cycle Evidence (PR 4)

| Cycle       | Test action                                                                                                                                                                                    | Result                                                                                        | Notes                                                 |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| RED         | Extended `test/build/release-workflow.test.js`: allowlist regex, positive secret consumption, job-graph/needs, concurrency, guard, `if: always()`, manifest asset list, release-job invariants | `npx jest test/build/release-workflow.test.js` failed: 10 new assertions (new jobs undefined) | Confirmed workflow not yet extended                   |
| GREEN       | Added six additive jobs to `.github/workflows/release.yml`                                                                                                                                     | Focused Jest passed; `release` job step names and needs unchanged                             | Workflow parse confirms additive-only diff            |
| TRIANGULATE | Added assertions that `release` needs/permissions/concurrency/step names are unchanged; cleanup `if: always()`; installer scripts reference `package.json` version and `GITHUB_REF_NAME`       | All focused tests passed                                                                      | Guards against regressions on the public release path |
| REFACTOR    | Ran `npx prettier --write test/build/release-workflow.test.js`; no production-code compression                                                                                                 | `npm run format:check` green; focused Jest still green                                        | Formatting only; no logic change                      |

### Files changed (PR 4)

- `.github/workflows/release.yml` (modified — additive only; existing `build`/`validate`/`scan`/`release` jobs untouched)
- `test/build/release-workflow.test.js` (modified — re-scoped secret policy + intranet-distribution structural tests)
- `openspec/changes/add-intranet-distribution/tasks.md` (checkbox updates for 4.x)
- `openspec/changes/add-intranet-distribution/apply-progress.md` (this file)

### Verification commands and results (PR 4)

```text
npx jest test/build/release-workflow.test.js --no-coverage                        PASS  28 tests
npx prettier --check .                                                             OK
npm run lint                                                                       OK
npm test -- --runInBand --forceExit                                              PASS  550 tests, 37 suites
```

### Deviations from design (PR 4)

None. The implementation follows the design's Workflow section and ADRs 1/3/4/5/6/7/8/9:

- Tag-only trigger is preserved (existing `on: push: tags: - 'v*'`).
- `release` job block is byte-for-byte unchanged (`git diff` shows only appended lines after it).
- NetBird tunnel uses `NETBIRD_SETUP_KEY` and optional `NETBIRD_MANAGEMENT_URL`; teardown uses `if: always()`.
- ProGet uploads target `${PROGET_BASE_URL}/endpoints/${PROGET_ASSET_DIRECTORY}/content/${PROGET_TARGET_PREFIX}/<version>/<file>` with `X-ApiKey: ${PROGET_API_KEY}` and `--fail-with-body --retry 3`.
- Manifest is generated from SHA256SUMS via `build/proget-manifest.js` and POSTed last to `outlook-mcp/latest-stable.json`.
- Cleanup job is non-gating (`needs` all jobs, `if: always()`) and requires `permissions: actions: write` to delete artifacts via `gh api`.

### Notes / risks

- The NSIS choco version is pinned to `3.10`; this is the first time the workflow compiles the NSIS script (local `makensis` is unavailable).
- The `anchore/sbom-action@v0` SBOM generation and the ProGet/NetBird steps cannot be exercised locally; the first real run is the next `v*` tag push.
- The cleanup script lists artifacts by run ID and deletes each by ID. If GitHub changes the `actions/runs/{run_id}/artifacts` API shape, the cleanup step may need adjustment, but it never gates release or publish outcomes.

### Remaining work (out of scope for this PR)

- Phase 5 — README intranet installation section and glibc correction.
- Phase 6 — Final validation sweep after all PRs land.

---

## Work unit PR 5 — README end-user docs

- Branch: `feat/intranet-distribution-05-docs`
- Scope: `README.md` (intranet distribution section + glibc correction), `test/build/readme-distribution.test.js` (strict-TDD structural coverage), `openspec/changes/add-intranet-distribution/tasks.md` and `apply-progress.md` (checkbox/progress updates).
- Out of scope: code, workflow, build scripts, `docs/authentication.md` (no design-required edit; intranet section links to it).

### Completed tasks (Phase 5)

- [x] 5.1 Corrected the Linux x64 baseline claim from "glibc 2.28+" to **glibc ≥ 2.39 (Ubuntu 24.04+)** in the pre-built executables table, and noted the same baseline applies to the `.deb`.
- [x] 5.2 Added the "Intranet installation (ACTSIS ProGet)" subsection under `## Pre-built executables`, covering:
  - Asset location (`https://artifacts.actsis.com/endpoints/actsis-ai-policy/content/outlook-mcp/<version>/<file>` and `outlook-mcp/latest-stable.json`).
  - Windows NSIS install steps (`outlook-mcp-setup.exe`, Program Files `PATH`, terminal restart).
  - Linux `.deb` install steps (`outlook-mcp_<version>_amd64.deb`, `dpkg -i`, `apt install`, `/usr/bin/outlook-mcp`).
  - Credential guidance for installed paths: use the MCP-client `env` block or Vault; `.env` beside the installed executable is not user-writable.
  - Explicit do-not-rename warning for `outlook-mcp(.exe)` because the SEA dispatch probe depends on the lowercase substring.
- [x] 5.3 Verified `npm run format:check` and `npm run lint` pass; README renders cleanly.

### TDD Cycle Evidence (PR 5)

Strict TDD was active (`openspec/config.yaml` `strict_tdd: true`). Because the work unit is documentation, the "production code" is the `README.md` content; the failing test is a structural README test.

| Task | Test File                                | Layer | Safety Net | RED                     | GREEN     | TRIANGULATE                                                        | REFACTOR                 |
| ---- | ---------------------------------------- | ----- | ---------- | ----------------------- | --------- | ------------------------------------------------------------------ | ------------------------ |
| 5.1  | `test/build/readme-distribution.test.js` | Unit  | ✅ 550/550 | ✅ Written              | ✅ Passed | ✅ 2 cases (new claim present, old claim absent)                   | ✅ Prettier/ESLint clean |
| 5.2  | `test/build/readme-distribution.test.js` | Unit  | ✅ 550/550 | ✅ Written              | ✅ Passed | ✅ 5 scenario groups (assets, Windows, Linux, credentials, rename) | ✅ Prettier/ESLint clean |
| 5.3  | `test/build/readme-distribution.test.js` | Unit  | ✅ 550/550 | N/A (verification task) | ✅ Passed | ➖ N/A                                                             | ✅ Prettier/ESLint clean |

Triangulation note: documentation assertions are static-string contracts with no branching logic; the multiple scenario assertions (per requirement/spec) serve the same goal of proving the content is real and specific.

### Files changed (PR 5)

- `README.md` (modified — corrected glibc baseline; added "Intranet installation (ACTSIS ProGet)" section).
- `test/build/readme-distribution.test.js` (new — strict-TDD structural README coverage for ADR 6/10 requirements).
- `openspec/changes/add-intranet-distribution/tasks.md` (checkbox updates for 5.x).
- `openspec/changes/add-intranet-distribution/apply-progress.md` (this file).

### Verification commands and results (PR 5)

```text
npx jest test/build/readme-distribution.test.js --no-coverage                        PASS  7 tests
npx prettier --check .                                                             OK
npm run lint                                                                       OK
npm test -- --runInBand --forceExit                                              PASS  557 tests, 38 suites
```

### Deviations from design (PR 5)

None. The intranet section uses the exact asset directory, target prefix, manifest path, installer artifact names, install destinations, and credential mechanisms described in ADRs 6 and 10 and verified against `build/linux/nfpm.yaml.tmpl`, `build/windows/installer.nsi`, and `.github/workflows/release.yml`.

### Risks

- The README Windows/Linux steps match the CI-produced artifacts and installer scripts, but an actual end-to-end install on an ACTSIS Windows host and an `ubuntu:24.04` container is out of scope for this docs PR; the first real exercise is the next `v*` tag push (already covered by PR 4 workflow).
- The static-string tests guarantee the documented names/paths are present, but they cannot verify that future README edits keep them in sync; the existing workflow structural tests already assert the real artifact names in `release.yml`.

### Remaining work (out of scope for this PR)

- Phase 6 — Final validation sweep after all PRs land (full `npm test`, `npm run lint`, `npm run format:check`, spec coverage walk, post-merge tag validation).
