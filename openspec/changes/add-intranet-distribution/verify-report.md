```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:496196adfd015656e63850273bf649d1003205dcf196f883b713c98a5a86f6d3
verdict: pass_with_warnings
blockers: 0
critical_findings: 0
requirements: 9/9
scenarios: 28/28
test_command: npm test
test_exit_code: 0
test_output_hash: sha256:2ed42cf5e1e1705f7f68f330bf421d3f767e7399602b08ed381a9b6c6c2f13af
build_command: ''
build_exit_code: 0
build_output_hash: sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

# Verify Report — Intranet distribution via ProGet (add-intranet-distribution)

## Status

**PASS_WITH_WARNINGS** — `blockers: 0`, `critical_findings: 0`. 9/9 requirements and 28/28 scenarios addressed. Full `npm test`, `npm run lint`, and `npm run format:check` are green at HEAD `4741065` (branch `feat/intranet-distribution-05-docs`, which carries all five implemented work units). Two non-critical findings are recorded (mutable action tags WARNING, changed-line estimate NOTE), and two verification rows are deferred to CI/post-merge (tasks 3.2 and 6.3). No code changes were made by verification; defects are reported, never fixed.

## Scope and artifacts verified

- **Head:** `474106516744cea88d000ccbe8ea45ac09fe83bf` on `feat/intranet-distribution-05-docs` (chain terminus containing PRs 1–5).
- **Spec:** `specs/distribution/spec.md` (tracker branch `feat/intranet-distribution`) — 9 requirements, 28 scenarios (4 + 3 + 2 + 6 + 4 + 2 + 4 + 2 + 1).
- **Design:** `design.md` (tracker branch) — includes the spec requirement coverage matrix and ADRs 1–10.
- **Tasks:** `tasks.md` — 25/29 checked; the 4 unchecked rows are all `sdd-owner: verification` rows (3.2, 6.1, 6.2, 6.3). 6.1 and 6.2 were checked during this run ([x], markers preserved); 3.2 and 6.3 remain unchecked as recorded deferrals.
- **Apply-progress:** `apply-progress.md` — five work units, each with a `TDD Cycle Evidence` table.

## Executed checks (Task 6.1)

| Command                | Result                                  | Evidence                                                                  |
| ---------------------- | --------------------------------------- | ------------------------------------------------------------------------- |
| `npm test`             | PASS — 38 suites, 557 tests, exit 0     | `sha256:2ed42cf5e1e1705f7f68f330bf421d3f767e7399602b08ed381a9b6c6c2f13af` |
| `npm run lint`         | PASS — eslint clean, exit 0             | `sha256:f75cd18387c6bbd0cdb295dbcb34b3a1dc2da2fd82d4a6243cadc99480236a48` |
| `npm run format:check` | PASS — all files Prettier-clean, exit 0 | `sha256:30a6ea70858fba0c009410827bd08ec9c31fb7f7b0472290f3749e2dc3190377` |

Focused suites for every changed test surface (Task 6.2 cross-reference run): `npx jest test/build/proget-manifest.test.js test/build/linux-packaging.test.js test/build/windows-installer.test.js test/build/release-workflow.test.js test/build/readme-distribution.test.js` → **59/59 PASS** (12 + 4 + 8 + 28 + 7), exit 0.

`build_command` is empty because `openspec/config.yaml` declares `build_command: ''`; the repo's quality gates (`lint` + `format:check`) and full test suite serve as the build/CI evidence and are reported above.

## Requirements coverage walk (Task 6.2) — 9/9 PASS, 28/28 scenarios

| #   | Requirement                                  | Scenarios | Verdict  | Implementation evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Test evidence                                                                                                                                                                                                                                                       |
| --- | -------------------------------------------- | --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Linux `.deb` Installer                       | 4/4       | **PASS** | `build/linux/nfpm.yaml.tmpl` (`name: outlook-mcp`, `arch: amd64`, `dst: /usr/bin/outlook-mcp`, `mode: 0755`); `build/linux/package-deb.sh` (requires `GITHUB_REF_NAME=v<semver>` + `GITHUB_SHA`, strips `v`, `dpkg-shlibdeps`-derived `Depends`, `chmod 0755`); no-op `postinst`/`postrm` (`#!/bin/sh` + `exit 0`)                                                                                                                                                       | `test/build/linux-packaging.test.js` (4 tests): lockfile sha256 pin, maintainer-script no-ops, template placeholders (dst/mode), `bash -n` on all three scripts; `build/linux/tests/container-smoke.sh` asserts `/usr/bin/outlook-mcp` install + mode + boot        |
| 2   | Windows NSIS Installer                       | 3/3       | **PASS** | `build/windows/installer.nsi`: `${IfNot} ${RunningX64}` → `Abort` before any write; `InstallDir "$PROGRAMFILES64\outlook-mcp"`; `SetRegView 64`; `File /oname=outlook-mcp.exe`; PATH append to HKLM Session Manager guarded against duplicates + `WM_SETTINGCHANGE` broadcast; uninstall entry + uninstall section (delete files, PATH removal, `DeleteRegKey`)                                                                                                          | `test/build/windows-installer.test.js` (8 tests): x64 guard, ProgramFiles64 + reg view, exe name, PATH guard/broadcast, uninstall registry keys, no EnVar/StartMenu shortcuts, `OutFile outlook-mcp-setup.exe`, admin + LZMA                                        |
| 3   | Installed Executable Name Constraint         | 2/2       | **PASS** | SEA probe at `bin/m365-mcp.js` (`process.execPath.includes('outlook-mcp')`, case-sensitive); `.deb` name `/usr/bin/outlook-mcp` and NSIS `outlook-mcp.exe` both satisfy the probe; README do-not-rename warning                                                                                                                                                                                                                                                          | `windows-installer.test.js` (`File /oname=outlook-mcp.exe`), `linux-packaging.test.js` (`dst: /usr/bin/outlook-mcp`), `readme-distribution.test.js` (do-not-rename + `outlook-mcp.exe` present)                                                                     |
| 4   | Intranet ProGet Publication                  | 6/6       | **PASS** | `.github/workflows/release.yml` `publish-artifacts` job: tag-only trigger (`on: push: tags: ['v*']`); `needs: [release, installer-windows, installer-linux, provenance]`; `concurrency: group: proget-publish-${{ github.ref }}`, `cancel-in-progress: false`; fail-closed secret guard before tunnel; NetBird up with `NETBIRD_SETUP_KEY`; per-asset `curl --fail-with-body --retry 3` POST with `X-ApiKey: ${PROGET_API_KEY}`; `sudo netbird down` with `if: always()` | `test/build/release-workflow.test.js` (28 tests): needs graph, concurrency group, guard step, teardown `if: 'always()'`, manifest step referencing the four product assets, release-job invariants                                                                  |
| 5   | `latest-stable.json` Manifest                | 4/4       | **PASS** | `build/proget-manifest.js`: pure `buildManifest` with fixed key order, `parseSha256sums` (two-space format), `assetUrl` `${baseUrl}/endpoints/${dir}/content/${prefix}/${version}/${file}`, fail-closed validation (v-prefix, missing/malformed checksums, missing inputs); workflow generates manifest from SHA256SUMS and overwrite-POSTs `outlook-mcp/latest-stable.json`                                                                                             | `test/build/proget-manifest.test.js` (12 tests): determinism, exact shape + key order, per-asset URL, checksum resolution, all throw paths, CLI round-trip stdout equality                                                                                          |
| 6   | Public GitHub Release Channel Unchanged      | 2/2       | **PASS** | `release.yml` edit is additive-only (348 insertions, 0 deletions; the only `-` diff line is the `---` file header); `release` job untouched; `publish-artifacts` failure cannot affect the sibling `release` job (dependency direction is `publish-artifacts` → `release`)                                                                                                                                                                                               | `release-workflow.test.js`: `keeps the existing release job block byte-for-byte unchanged` (needs, permissions, timeout-minutes, concurrency, exact step names); secrets test suite (557 tests) still green                                                         |
| 7   | Release Pipeline Integrity for Installers    | 4/4       | **PASS** | Job graph: `installer-*` → `needs: build`; `smoke` → both installers (docker `ubuntu:24.04` runs `container-smoke.sh`); `provenance` → `smoke` (sha256sum → SHA256SUMS, SBOM via `anchore/sbom-action@v0`); `publish-artifacts` → `[release, installer-windows, installer-linux, provenance]`                                                                                                                                                                            | `release-workflow.test.js` (job-graph assertions); `container-smoke.sh` implements install → `mcp` boot → `auth` HTTP 200 → upgrade (`dpkg -i` re-run) → remove (`dpkg -r`) → purge (`dpkg -P`) with `~`-scoped fixture preservation (`~/.outlook-mcp-tokens.json`) |
| 8   | Workflow Secrets Policy                      | 2/2       | **PASS** | `.github/workflows/release.yml` uses `secrets.NETBIRD_SETUP_KEY` / `secrets.PROGET_API_KEY` only (mapped to job env); no OAuth client secret references                                                                                                                                                                                                                                                                                                                  | `release-workflow.test.js`: `expect(raw).not.toMatch(/OUTLOOK_CLIENT_SECRET                                                                                                                                                                                         | MS_CLIENT_SECRET/)`+ fail-closed allowlist`\bsecrets\.(?!NETBIRD_SETUP_KEY | PROGET_API_KEY)\w`; positive consumption test asserts`publish-artifacts` env carries both permitted secrets |
| 9   | End-User Intranet Installation Documentation | 1/1       | **PASS** | `README.md`: "Intranet installation (ACTSIS ProGet)" section — Windows NSIS steps, Linux `.deb` steps, asset/manifest locations, MCP-client `env` block or Vault credential guidance (`.env` beside installed exe not user-writable), do-not-rename warning; glibc baseline corrected to ≥ 2.39 / Ubuntu 24.04+                                                                                                                                                          | `test/build/readme-distribution.test.js` (7 tests): glibc correction (new claim present, old claim absent), section header, asset URLs, Windows steps, Linux steps, credentials, rename warning                                                                     |

## Strict TDD compliance (active: `openspec/config.yaml` `strict_tdd: true`)

- `apply-progress.md` contains a `TDD Cycle Evidence` table for each of the five work units (PRs 1–5), with RED/GREEN/TRIANGULATE/REFACTOR columns — **present**.
- Cross-reference of reported test files against the codebase: `test/build/proget-manifest.test.js`, `linux-packaging.test.js`, `windows-installer.test.js`, `release-workflow.test.js`, `readme-distribution.test.js` — all exist and pass (59/59 focused, 557/557 full). GREEN is confirmed true at verify time.
- Assertion quality audit: no tautologies, ghost loops, type-only assertions, or smoke-only tests; negative assertions verify forbidden content (`/OUTLOOK_CLIENT_SECRET|MS_CLIENT_SECRET/`, `/EnVar/`, `/CreateShortcut/`, old `glibc 2.28` claim); executable checks (`bash -n` via `spawnSync`); exact-equality CLI round-trip (stdout byte equality). Documentation assertions are static-string contracts with no branching — appropriate for the README work unit.
- Layer classification: 59 unit/structural tests across 5 files (fs, YAML, spawnSync). The integration surface is `container-smoke.sh` (docker `ubuntu:24.04`), executed in CI per ADR 4; no E2E layer is required by this change.
- **No CRITICAL TDD findings.**

## Findings (non-critical)

1. **WARNING — mutable action tags in new workflow jobs (candidate-caused, repo convention).** All 17 `uses:` references in `release.yml` (including the new `installer-*`, `smoke`, `provenance`, `publish-artifacts`, `cleanup` jobs) use `@v4` tags (`actions/checkout@v4`, `actions/setup-node@v4`, `actions/upload-artifact@v4`, `actions/download-artifact@v4`, `anchore/sbom-action@v0`). The reference timetracker repo pins full commit SHAs. This matches the existing convention in this repository (the pre-change `build`/`scan`/`release` jobs already used `@v4`), and the spec scopes product behavior only ("tool-acquisition mechanisms ... are design-phase concerns" per the spec Purpose). Recommended hardening follow-up: pin actions to full SHAs and rely on Dependabot for updates. **Non-blocking; does not affect the verdict.**
2. **NOTE — changed-line estimate exceeded.** Forecast was ~950–1200 changed lines; the diff against `main` shows 1527 insertions across 18 files. Attribution: three strict-TDD structural test suites added as safety-net surfaces beyond the 10-new/3-modified forecast (`linux-packaging.test.js` 61, `windows-installer.test.js` 68, `readme-distribution.test.js` 53 lines), the 242-line manifest module, and verbose fail-closed shell scripts per ADR 9. Every changed file maps to a planned task; this is an estimation variance, not scope creep. **Non-blocking.**
3. No `size:exception` was recorded — not required, as the chained-PR forecast was honored per work unit.

## Review workload / PR boundary verification

- Chained PRs recommended: **Yes**; chain strategy **feature-branch-chain**. Implemented exactly as the 5 planned work-unit boundaries (PR1 manifest module → PR2 Linux packaging → PR3 Windows NSIS → PR4 workflow + re-scoped secrets test (atomic) → PR5 README/docs). HEAD is the chain terminus carrying the complete change; verification ran against this merged state.
- PR 4 atomicity honored: the re-scoped `/\bsecrets\./` allowlist tests and the workflow additions landed together; verified by the single commit `c5ebb6b` and by full-suite green.
- `release.yml` edit is additive-only (348 insertions, 0 deletions); the `release` job block is byte-for-byte unchanged, asserted by `release-workflow.test.js`.

## Task completion status

Checked during this verification run (markers preserved):

- [x] 6.1 Verify: full `npm test`, `npm run lint`, and `npm run format:check` are green on the merged state. <!-- sdd-owner: verification --> — all three green (results above).
- [x] 6.2 Verify: walk every requirement in `openspec/changes/add-intranet-distribution/specs/distribution/spec.md` (9 requirements, all scenarios) against the design's coverage matrix and the implemented files; confirm no scenario is unaddressed. <!-- sdd-owner: verification --> — 9/9 requirements, 28/28 scenarios addressed (table above).

Remaining unchecked (recorded deferrals — verification rows, not implementation tasks; do not gate archive):

- [ ] 3.2 Verify: `makensis -DVERSION=<pkg version> build\windows\installer.nsi` compiles with stock choco NSIS. <!-- sdd-owner: verification --> — **Deferred to CI**: `makensis` is not installed locally; structural coverage exists via `windows-installer.test.js` (8 tests); first automated compile runs in the `installer-windows` CI job (`choco install nsis --version=3.10`, `makensis -DVERSION=...`).
- [ ] 6.3 Verify (informational, post-merge on the next `v*` tag): ProGet assets under `outlook-mcp/<version>/`, manifest overwritten at `outlook-mcp/latest-stable.json`, manifest checksums re-verify, GitHub Release output identical to pre-change format, `netbird down` on success and failure paths. <!-- sdd-owner: verification --> — **Deferred to post-merge**: by definition requires a real tag push with provisioned secrets.

**No unchecked implementation tasks remain.** Archive readiness: implementation complete; the two deferred items are verification-only and informational per the design's rollout plan.

## Exact blockers

None. `blockers: 0`, `critical_findings: 0`.
