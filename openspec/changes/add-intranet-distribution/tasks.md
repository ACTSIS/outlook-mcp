# Tasks: Intranet distribution via ProGet (add-intranet-distribution)

## Review Workload Forecast

| Field                   | Value                                      |
| ----------------------- | ------------------------------------------ |
| Estimated changed lines | ~950–1200 (10 new files, 3 modified files) |
| 400-line budget risk    | High                                       |
| Chained PRs recommended | Yes                                        |
| Suggested split         | PR 1 → PR 2 → PR 3 → PR 4 → PR 5           |
| Delivery strategy       | ask-on-risk                                |
| Chain strategy          | feature-branch-chain                       |

```text
Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High
```

Rationale: the change spans 13 files across packaging, workflow, tests, and docs. PR 4 (workflow + re-scoped secrets test) is the largest single unit (~300–360 lines) and cannot be split further because the design mandates the workflow additions and the re-scoped `/\bsecrets\./` test land atomically. Each PR merges to main independently green (`npm test`); PR 4 must follow PR 2 and PR 3 because the new jobs invoke `build/linux/` and `build/windows/` scripts.

### Work-unit boundaries

| PR                                                     | Start                                                               | Finish                                          | Verification                                        | Rollback                                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| PR 1 — Manifest module (TDD)                           | RED test in `test/build/proget-manifest.test.js`                    | CLI round-trip of `build/proget-manifest.js`    | `npm test` manifest suite green                     | Delete the two files; nothing else references them yet                                     |
| PR 2 — Linux packaging + smoke harness                 | `build/linux/toolchain.lock.yaml`                                   | `build/linux/tests/container-smoke.sh`          | `bash -n` on all scripts; scripts inert until PR 4  | Delete `build/linux/`; no workflow references yet                                          |
| PR 3 — Windows NSIS                                    | `build/windows/installer.nsi`                                       | `makensis` compiles                             | `makensis -V` compile with stock choco NSIS         | Delete `build/windows/`; no workflow references yet                                        |
| PR 4 — Workflow jobs + re-scoped secrets test (ATOMIC) | Re-scoped assertions in `test/build/release-workflow.test.js` (RED) | `cleanup` job added; full `npm test` green      | Full `npm test`; `release` job block byte-identical | Revert `release.yml` + test file; GitHub Release path untouched (proposal rollback step 1) |
| PR 5 — README/docs                                     | glibc correction at `README.md` line ~92                            | "Intranet installation (ACTSIS ProGet)" section | `npm run format:check`                              | Revert README hunks                                                                        |

## Atomicity constraint (design-mandated)

The re-scoped `/\bsecrets\./` assertions in `test/build/release-workflow.test.js` and the workflow additions in `.github/workflows/release.yml` MUST land in the same work unit (PR 4). Shipping the re-scoped test alone fails CI against the un-extended workflow (the positive consumption and structural assertions reference jobs that do not exist yet); shipping the workflow alone leaves the blanket `/\bsecrets\./` assertion failing. `npm test` green is the merge gate for PR 4.

## Phase 1 — Manifest module (TDD)

### RED

- [x] 1.1 Write `test/build/proget-manifest.test.js` with a first failing test: `buildManifest` exists and produces deterministic output (two calls, equal strings) for fixed inputs (`version`, `date`, `notesUrl`, `sha256sumsContent`, `assets`, `proget`). <!-- sdd-owner: implementation -->

### GREEN

- [x] 1.2 Implement `build/proget-manifest.js` exporting `buildManifest` as a pure, side-effect-free CommonJS function with fixed key order and `JSON.stringify(..., null, 2)` + trailing newline, enough to pass the first test. <!-- sdd-owner: implementation -->

### TRIANGULATE

- [x] 1.3 Extend `test/build/proget-manifest.test.js`: per-asset URL `${baseUrl}/endpoints/${assetDirectory}/content/${targetPrefix}/${version}/${name}`; `notesUrl` shape; checksum parsing from SHA256SUMS lines (two-space separator); throws on `v`-prefixed version, asset missing from `sha256sumsContent`, malformed checksum line, and missing input fields; stable key ordering. <!-- sdd-owner: implementation -->
- [x] 1.4 Implement `parseSha256sums` and `assetUrl` in `build/proget-manifest.js` plus the fail-closed validation (clear throw messages) to satisfy the new tests. <!-- sdd-owner: implementation -->

### REFACTOR

- [x] 1.5 Add the thin CLI mode to `build/proget-manifest.js` (`node build/proget-manifest.js --version <ver> --date <iso> --assets <list> < SHA256SUMS > latest-stable.json`) and verify its stdout equals the module's pure-function output for the same inputs. <!-- sdd-owner: implementation -->
- [x] 1.6 Verify: `npm test` and `npm run lint` green for the manifest suite; module matches the `build/package.js` culture (CommonJS, no side effects at require time). <!-- sdd-owner: verification -->

## Phase 2 — Linux packaging (scripts + smoke harness)

- [ ] 2.1 Create `build/linux/toolchain.lock.yaml` pinning the nfpm version, download URL, and sha256 (ADR 9; nfpm only — no linuxdeploy/AppImage). <!-- sdd-owner: implementation -->
- [ ] 2.2 Create `build/linux/fetch-tools.sh` (`set -euo pipefail`): downloads nfpm, verifies the sha256, rejects untrusted redirect hosts, installs to a tools dir placed on `PATH`; fail-closed on hash mismatch. <!-- sdd-owner: implementation -->
- [ ] 2.3 Create `build/linux/scripts/postinst` and `build/linux/scripts/postrm` as no-op `#!/bin/sh` + `exit 0` scripts (user data is `~`-scoped and must never be touched by package operations). <!-- sdd-owner: implementation -->
- [ ] 2.4 Create `build/linux/nfpm.yaml.tmpl` per the design: `name: outlook-mcp`, `arch: amd64`, `@VERSION@`/`@MAINTAINER@`/`@BINARY@`/`@DEPENDS@`/`@SCRIPTS@` placeholders, `dst: /usr/bin/outlook-mcp` (read-only, package-internal install destination) with `file_info.mode: 0755`, postinstall/postremove script hooks. <!-- sdd-owner: implementation -->
- [ ] 2.5 Create `build/linux/package-deb.sh` (`set -euo pipefail`): requires `GITHUB_REF_NAME` matching `v<semver>` and `GITHUB_SHA`; strips `v` for the package version; stages the SEA binary as `outlook-mcp` (0755); runs `dpkg-shlibdeps` to derive `Depends`; renders `nfpm.yaml.tmpl`; invokes nfpm; prints the resulting `outlook-mcp_<version>_amd64.deb` path for the workflow's upload step. <!-- sdd-owner: implementation -->
- [ ] 2.6 Create `build/linux/tests/container-smoke.sh` per ADR 3, parameterized by the `.deb` path, running inside `ubuntu:24.04`: `dpkg -i` → assert `/usr/bin/outlook-mcp` (read-only) exists with mode 0755; `outlook-mcp mcp` in background → grep "connected and listening" within 30s; `outlook-mcp auth` in background → `curl -sf http://localhost:3333/` returns 200; re-`dpkg -i` (upgrade path); `dpkg -r`; `dpkg -P`; assert `~`-scoped fixtures created during the run are untouched. Any step failing exits non-zero. <!-- sdd-owner: implementation -->
- [ ] 2.7 Verify: `bash -n` passes on all `build/linux/` scripts; the smoke docker invocation (mount `.deb`, execute `container-smoke.sh` inside `ubuntu:24.04`) matches the design. <!-- sdd-owner: verification -->

## Phase 3 — Windows NSIS

- [ ] 3.1 Create `build/windows/installer.nsi` per ADR 2: `!include "x64.nsh"` + `!include "WinMessages.nsh"`; `RequestExecutionLevel admin`; `SetCompressor lzma`; `${IfNot} ${RunningX64}` → `MessageBox` + `Abort` before any write; `InstallDir "$PROGRAMFILES64\outlook-mcp"`; `SetRegView 64`; `File /oname=outlook-mcp.exe` the staged SEA exe; PATH registry append to `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment\Path` (guarded against duplicate) + `WM_SETTINGCHANGE` broadcast; uninstall registry entry (`DisplayName`, `DisplayVersion` from `-DVERSION`, `UninstallString`, `Publisher`); uninstall section deleting files, removing the PATH entry + re-broadcast, and deleting the uninstall registry key; output name `outlook-mcp-setup.exe`. No EnVar plugin, no Start Menu shortcut. <!-- sdd-owner: implementation -->
- [ ] 3.2 Verify: `makensis -DVERSION=<pkg version> build\windows\installer.nsi` compiles with stock choco NSIS (no third-party plugins required). <!-- sdd-owner: verification -->

## Phase 4 — Workflow jobs + re-scoped secrets test (ATOMIC — single PR)

### RED

- [ ] 4.1 Modify `test/build/release-workflow.test.js` (before any workflow edit): replace the blanket `expect(raw).not.toMatch(/\bsecrets\./)` with the fail-closed allowlist `expect(raw).not.toMatch(/\bsecrets\.(?!NETBIRD_SETUP_KEY|PROGET_API_KEY)\w/)` plus explicit `expect(raw).not.toMatch(/OUTLOOK_CLIENT_SECRET|MS_CLIENT_SECRET/)`; add a positive consumption assertion that the `publish-artifacts` job consumes `secrets.NETBIRD_SETUP_KEY` and `secrets.PROGET_API_KEY`; add structural assertions: `installer-windows`/`installer-linux` need `build`; `smoke` needs both installer jobs; `provenance` needs `smoke`; `publish-artifacts` needs `release` + both installers + `provenance`; `publish-artifacts` has a concurrency group keyed on the ref, a pre-upload secret guard step, and a `netbird down` step with `if: always()`. These fail against the current workflow (RED). <!-- sdd-owner: implementation -->

### GREEN

- [ ] 4.2 Add the `installer-windows` job to `.github/workflows/release.yml` (windows-latest, `needs: build`, downloads `artifact-win-x64`): checkout → Node 22.22.1 → ADR 7 drift check (`node -e` asserting `GITHUB_REF_NAME == "v" + require('./package.json').version`, exit 1 on mismatch) → `choco install nsis --version=<pinned>` → `makensis -DVERSION=<pkg version> build\windows\installer.nsi` → upload `outlook-mcp-setup.exe` as artifact `installer-win-x64`. <!-- sdd-owner: implementation -->
- [ ] 4.3 Add the `installer-linux` job (ubuntu-latest, `needs: build`, downloads `artifact-linux-x64`): checkout → ADR 7 drift check → `build/linux/fetch-tools.sh` → `build/linux/package-deb.sh` → ADR 5 `.deb` payload secret-scan (`dpkg-deb --fsys-tarout … | tar -x` to a temp dir; `node -e` with `scanDirectory`/`canPublish` from `build/secret-scan.js`, fail-closed) → upload the `.deb` as artifact `installer-linux-x64`. <!-- sdd-owner: implementation -->
- [ ] 4.4 Add the `smoke` job (ubuntu-latest, `needs: [installer-windows, installer-linux]`, downloads both installer artifacts): `docker run ubuntu:24.04` mounting the `.deb` and executing `build/linux/tests/container-smoke.sh` (ADR 3). The Windows installer is a gate dependency only — not executed in CI. <!-- sdd-owner: implementation -->
- [ ] 4.5 Add the `provenance` job (ubuntu-latest, `needs: [smoke]`, downloads the four product artifacts): `sha256sum` over the four assets → `SHA256SUMS`; SBOM via `anchore/sbom-action@v0` (syft, SPDX JSON, `outlook-mcp-<version>-sbom.spdx.json`); upload the `provenance` artifact. <!-- sdd-owner: implementation -->
- [ ] 4.6 Add the `publish-artifacts` job (ubuntu-latest, `needs: [release, installer-windows, installer-linux, provenance]`, `concurrency: group: proget-publish-${{ github.ref }}`, `cancel-in-progress: false`): fail-closed secret guard before the tunnel (`if [ -z "${NETBIRD_SETUP_KEY}" ] || [ -z "${PROGET_API_KEY}" ]; then echo "::error::missing publish secret"; exit 1; fi`) → NetBird install + `sudo netbird up --setup-key … --management-url …` → per-asset `curl --fail-with-body --retry 3 -X POST -H "X-ApiKey: ${PROGET_API_KEY}" -H "Content-Type: application/octet-stream" --data-binary @<file> "${PROGET_BASE_URL}/endpoints/${PROGET_ASSET_DIRECTORY}/content/${PROGET_TARGET_PREFIX}/<version>/<file>"` for the ADR 1 asset set + `SHA256SUMS` + SBOM → `node build/proget-manifest.js --version <ver> --date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --assets <ADR 1 list> < SHA256SUMS > latest-stable.json` → overwrite POST to `outlook-mcp/latest-stable.json` → `sudo netbird down` with `if: always()`. <!-- sdd-owner: implementation -->
- [ ] 4.7 Add the `cleanup` job (ADR 8): `needs: [release, installer-windows, installer-linux, smoke, provenance, publish-artifacts]`, `if: always()`, deletes this run's workflow artifacts; never gates anything. <!-- sdd-owner: implementation -->

### Verification

- [ ] 4.8 Verify: the `release` job block in `release.yml` is byte-for-byte unchanged; every new job carries `permissions: contents: read` and `timeout-minutes` (keeps the existing "contents write only on release" test green); full `npm test` passes — re-scoped secrets suite, new structural assertions, and the unchanged release-publication regression tests. <!-- sdd-owner: verification -->

## Phase 5 — README/docs

- [ ] 5.1 Update `README.md` (line ~92): correct the Linux x64 baseline claim from "glibc 2.28+" to glibc ≥ 2.39 / Ubuntu 24.04+ for both the raw Linux binary and the `.deb` (ADR 6). <!-- sdd-owner: implementation -->
- [ ] 5.2 Add the "Intranet installation (ACTSIS ProGet)" section per ADR 10: Windows steps (download `outlook-mcp-setup.exe` from ProGet, run, accept PATH, restart terminal); Linux steps (download the `.deb`, `sudo dpkg -i` / `apt install ./outlook-mcp_<version>_amd64.deb`); credential configuration for installed paths via the MCP-client `env` block or Vault (a `.env` beside the installed executable is not user-writable); explicit do-not-rename warning for `outlook-mcp(.exe)`. <!-- sdd-owner: implementation -->
- [ ] 5.3 Verify: `npm run format:check` passes; README links and code blocks render correctly. <!-- sdd-owner: verification -->

## Phase 6 — Validation sweep

- [ ] 6.1 Verify: full `npm test`, `npm run lint`, and `npm run format:check` are green on the merged state. <!-- sdd-owner: verification -->
- [ ] 6.2 Verify: walk every requirement in `openspec/changes/add-intranet-distribution/specs/distribution/spec.md` (9 requirements, all scenarios) against the design's coverage matrix and the implemented files; confirm no scenario is unaddressed. <!-- sdd-owner: verification -->
- [ ] 6.3 Verify (informational, post-merge on the next `v*` tag): ProGet assets under `outlook-mcp/<version>/`, manifest overwritten at `outlook-mcp/latest-stable.json`, manifest checksums re-verify against downloaded assets, GitHub Release output identical to the pre-change format, `netbird down` observed on both success and failure paths. <!-- sdd-owner: verification -->
