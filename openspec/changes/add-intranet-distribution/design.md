# Design: Intranet distribution via ProGet (add-intranet-distribution)

Status: design complete — all ten carried open questions resolved with ADR-style rationale.

## Context

The release pipeline today is tag-only (`v*`): `build` → `validate` → `scan` → `release` (GitHub Release with the two raw SEA binaries). This change adds, purely additively, native installers (`.deb`, NSIS), a container smoke gate, provenance (SHA256SUMS + SBOM), and NetBird-gated publication to the ACTSIS ProGet Asset Directory with a `latest-stable.json` manifest. The existing `release` job stays byte-for-byte unchanged.

Hard constraints carried from exploration:

- **SEA probe:** `shouldDispatch()` in `bin/m365-mcp.js` detects SEA via `process.execPath.includes('outlook-mcp')` (case-sensitive). Every installed executable name MUST contain the lowercase substring `outlook-mcp`, and users MUST be told not to rename it. Renamed executables fail startup loudly (the `require.main` fallback throws under SEA) — never a silent fallback to module dispatch, satisfying the spec's "Renaming breaks dispatch" scenario.
- **Test conflict:** `test/build/release-workflow.test.js` asserts `expect(raw).not.toMatch(/\bsecrets\./)` over the whole workflow. Adding `secrets.NETBIRD_SETUP_KEY` / `secrets.PROGET_API_KEY` breaks it; the assertion must be re-scoped to an OAuth-secret allowlist (ADR and Test Design below).
- **Relocatability:** the SEA binary resolves `.env` beside `process.execPath`, tokens at `~/.outlook-mcp-tokens.json`, Vault cache under `%LOCALAPPDATA%`/`XDG_CONFIG_HOME`. No runtime code changes needed.

Provisioned infrastructure (no new secrets required): secrets `NETBIRD_SETUP_KEY`, `PROGET_API_KEY`; variables `NETBIRD_MANAGEMENT_URL=https://edge.actsis.com`, `PROGET_BASE_URL=https://artifacts.actsis.com`, `PROGET_ASSET_DIRECTORY=actsis-ai-policy`, `PROGET_TARGET_PREFIX=outlook-mcp`.

## Architecture: pipeline job graph

```text
                          (existing, unchanged)                    (existing, unchanged)
build (matrix) ──> validate ──> scan ──────> release ─────────────────────────> [GitHub Release]
   │
   ├──> installer-windows (NSIS, needs build) ──┐
   │                                            ├──> smoke (container .deb) ──> provenance ──> publish-artifacts (NetBird + ProGet + manifest)
   └──> installer-linux (.deb, needs build) ─────┘                                              │
                                                                                               └──> cleanup (if: always())
```

- `installer-windows`, `installer-linux`: `needs: build`; both re-verify version drift before packaging (ADR-7).
- `smoke`: `needs: [installer-windows, installer-linux]`; docker Ubuntu 24.04 container install/upgrade/remove/purge + `mcp`/`auth` boot checks.
- `provenance`: `needs: [smoke]`; SHA256SUMS + SBOM over the full released asset set.
- `publish-artifacts`: `needs: [release, installer-windows, installer-linux, provenance]`; concurrency group `proget-publish-${GITHUB_REF_NAME}`; NetBird up → guard → uploads → manifest → `netbird down` (`if: always()`). Because `provenance` depends on `smoke`, a smoke failure transitively blocks publication (spec: "A smoke failure MUST block publication").
- `cleanup`: `needs: [release, installer-windows, installer-linux, smoke, provenance, publish-artifacts]`, `if: always()` (ADR-8).
- The `scan` → `release` critical path is untouched: no existing job gains new dependencies, so GitHub Release timing/content is unchanged.

## Sequence diagram: release + ProGet publish flow

```mermaid
sequenceDiagram
    actor Dev as Maintainer (tag push v*)
    participant GH as GitHub Actions
    participant B as build (matrix)
    participant R as release (unchanged)
    participant IW as installer-windows
    participant IL as installer-linux
    participant S as smoke (container)
    participant P as provenance
    participant PA as publish-artifacts
    participant NB as NetBird tunnel
    participant PG as ProGet (artifacts.actsis.com)

    Dev->>GH: push tag vX.Y.Z
    GH->>B: build win-x64 + linux-x64 SEA
    B->>R: artifacts (existing path: validate, scan)
    R-->>Dev: GitHub Release (2 raw binaries, --generate-notes)
    B->>IW: artifact-win-x64
    B->>IL: artifact-linux-x64
    IW->>IW: tag==v{pkg.version} check; makensis
    IL->>IL: tag==v{pkg.version} check; dpkg-shlibdeps; nfpm .deb; payload secret-scan
    IW->>S: installer artifacts
    IL->>S: installer artifacts
    S->>S: docker ubuntu:24.04: install, upgrade, mcp boot, auth :3333, remove, purge
    S->>P: success
    P->>P: SHA256SUMS + SBOM over raw binaries + installer + .deb
    P->>PA: provenance artifacts
    R->>PA: release success (needs gate)
    PA->>PA: fail-closed secret guard (NETBIRD_SETUP_KEY, PROGET_API_KEY)
    PA->>NB: netbird up --setup-key NETBIRD_SETUP_KEY
    PA->>PG: POST each asset to /endpoints/actsis-ai-policy/content/outlook-mcp/X.Y.Z/<file> (X-ApiKey, --fail-with-body --retry 3)
    PG-->>PA: 200 OK per asset
    PA->>PA: build/proget-manifest.js → latest-stable.json (version, date, notesUrl, assets+sha256)
    PA->>PG: POST outlook-mcp/latest-stable.json (overwrite)
    PA->>NB: netbird down (if: always())
    PA->>GH: cleanup job (if: always()) deletes inter-job artifacts
```

## ADR 1 — Manifest asset set and paths

**Decision.** Assets live at `outlook-mcp/<version>/<file>` (i.e. `{PROGET_BASE_URL}/endpoints/{PROGET_ASSET_DIRECTORY}/content/{PROGET_TARGET_PREFIX}/<version>/<file>`); the manifest is overwritten at `outlook-mcp/latest-stable.json`. The uploaded asset set per release is:

- `outlook-mcp-setup.exe` (NSIS installer)
- `outlook-mcp_<version>_amd64.deb`
- `outlook-mcp-win-x64.exe` (raw, same bytes as the GitHub Release)
- `outlook-mcp-linux-x64` (raw, same bytes as the GitHub Release)
- `SHA256SUMS` and `outlook-mcp-<version>-sbom.spdx.json` (provenance, uploaded for auditability)

The manifest lists the four product assets (both installers and both raw binaries) with per-asset URL and SHA-256; provenance files are uploaded but not listed as installable assets.

**Rationale.** ACTSIS collaborators run heterogeneous machines: some use non-Debian Linux or want the raw binary (e.g., custom PATH, containers), so excluding raw binaries from the intranet channel would force them back to the public internet — exactly the friction this change removes. Checksums come from the generated SHA256SUMS, so adding raw binaries costs nothing. The manifest is generated from SHA256SUMS, guaranteeing checksums match published bytes (spec scenario "Manifest checksums verify").

**Spec mapping.** Requirement "`latest-stable.json` Manifest" (all four scenarios: complete content, newest-release-only overwrite, checksum accuracy, unit-testability).

## ADR 2 — NSIS PATH mechanism, installer name, shortcuts

**Decision.**

- **PATH:** registry append to `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment\Path` (guarded against duplicate append), followed by a `WM_SETTINGCHANGE` broadcast (`SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment"`, `WinMessages.nsh`, included with stock NSIS). Uninstall removes the `$INSTDIR` entry and re-broadcasts. **No EnVar plugin.**
- **Installed exe name:** `outlook-mcp.exe` (installed via `File /oname=outlook-mcp.exe`). Installer artifact name: `outlook-mcp-setup.exe`.
- **Start Menu shortcut:** none — outlook-mcp is a CLI/server; a shortcut would open a console that immediately starts an MCP server on stdio, which is confusing. The uninstall entry in "Add/Remove Programs" is the only shell integration.

**Rationale.** The EnVar plugin is an extra third-party DLL that would need its own sha256-pinned download (expanding the toolchain lock surface) for behavior the NSIS built-ins already provide; the registry append + broadcast is the canonical, dependency-free mechanism and choco's `nsis` package ships `WinMessages.nsh`. `outlook-mcp.exe` satisfies the SEA probe (`process.execPath` = `C:\Program Files\outlook-mcp\outlook-mcp.exe` contains the lowercase substring) while giving users the natural `outlook-mcp` command; the `-win-x64` suffix is packaging metadata, not a command name.

**Spec mapping.** Requirements "Windows NSIS Installer" (all three scenarios) and "Installed Executable Name Constraint" (scenario "Every installed name satisfies the probe"). The x64 guard (`x64.nsh` + `${IfNot} ${RunningX64}` → abort before any write) covers the "32-bit Windows is refused" scenario.

## ADR 3 — `.deb` smoke scope: container-only

**Decision.** Container-only smoke (`docker run ubuntu:24.04`), no host-smoke job.

**Rationale.** outlook-mcp is a CLI with no GUI, no FUSE, no systemd units; timetracker's host-smoke exists for exactly those surfaces, which do not apply. The container exercises the full lifecycle the spec requires — install, upgrade (re-install via `dpkg -i` exercises dpkg's upgrade path), `mcp` boot grep ("connected and listening"), `auth` mode HTTP 200 on `:3333`, remove, purge — in a clean environment, which is stronger signal than a polluted host. The smoke script also asserts `/usr/bin/outlook-mcp` exists with mode 0755.

**Spec mapping.** Requirement "Release Pipeline Integrity for Installers" (scenario "Container smoke validates the `.deb`").

## ADR 4 — PR-time packaging coverage: release-time only

**Decision.** No PR-time installer builds. Installers are built only on `v*` tag pushes in `release.yml`. The packaging surface is still protected by: (a) the fail-closed smoke gate before publication, (b) workflow structure tests asserting the installer jobs' shape, (c) `test/build/proget-manifest.test.js` covering the manifest logic in CI on every PR, (d) a broken release is recoverable by deleting the tag/`gh release` and re-pushing (the public channel is unaffected by publish-job failure).

**Rationale.** Building both installers on PRs means running the full SEA build on windows-latest and ubuntu-latest per PR — roughly doubling CI minutes on every PR to guard files that change rarely. The org-accepted pattern (sgi-timetracker) is also tag-only. The cost/benefit favors release-time-only with structural test coverage; if packaging regressions become a real problem, a path-filtered PR job can be added later without touching this design's contracts.

**Spec mapping.** Requirement "Intranet ProGet Publication" (scenario "Non-tag events never publish" — release.yml remains tag-triggered; no PR workflow gains packaging or publish steps).

## ADR 5 — Scan coverage: `.deb` payload scanned in `installer-linux`; NSIS not re-scanned

**Decision.** The existing `scan` job stays unchanged (raw binaries only, `needs: [build, validate]` — preserving the `scan → release` critical path). Defense in depth moves to the installer jobs: `installer-linux` extracts the packaged `.deb` payload (`dpkg-deb --fsys-tarout | tar -x`) into a temp dir and runs `build/secret-scan.js` over it (`scanDirectory`, fail-closed) before uploading. The NSIS installer is **not** re-scanned: its payload is the already-scanned `outlook-mcp-win-x64.exe`, and LZMA compression makes pattern scanning of the setup exe both unreliable and redundant.

**Rationale.** The `.deb` payload is trivially extractable on the ubuntu runner, so scanning it is nearly free and catches nfpm-template surprises (e.g., accidentally packaged files). Re-compressing NSIS extraction would add a tool dependency for zero new information. Keeping `scan` unchanged also guarantees the existing release path (and its tests) is untouched.

**Spec mapping.** Requirements "Release Pipeline Integrity for Installers" (fail-closed gating philosophy) and "Public GitHub Release Channel Unchanged" (the `scan` job and its dependents are byte-identical).

## ADR 6 — glibc baseline: Ubuntu 24.04 (glibc ≥ 2.39); README corrected

**Decision.** Target Ubuntu 24.04 / glibc 2.39 for the `.deb` (consistent with the runner and with `dpkg-shlibdeps` output `libc6 (>= 2.39)`). Update README to state the actual supported baseline for **both** the raw Linux binary and the `.deb`: glibc ≥ 2.39 (Ubuntu 24.04+).

**Rationale.** The raw Linux binary is _already_ built on `ubuntu-latest` (24.04, glibc 2.39), so the README's "glibc 2.28+" claim is stale today, independent of this change. Preserving 2.28 would require pinning `ubuntu-22.04`/`ubuntu-20.04` runners for the whole build (a new, dual-runner matrix) for a platform class ACTSIS does not use; timetracker standardized on 24.04 and the ACTSIS fleet follows Ubuntu LTS. Correcting the docs is cheaper and more honest than maintaining a second build baseline.

**Spec mapping.** Requirement "End-User Intranet Installation Documentation" (README changes) and "Linux `.deb` Installer" (scenario "Package dependencies reflect the binary" — `dpkg-shlibdeps` on 24.04 emits the true floor).

## ADR 7 — Version-drift check: fail-closed, in both installer jobs

**Decision.** Add a first step in `installer-windows` and `installer-linux`: assert `GITHUB_REF_NAME == "v" + require('./package.json').version`, else exit 1 before any packaging.

**Rationale.** `build/package.js` already stamps the Windows binary's VERSIONINFO from `package.json` version, and the `.deb` version comes from the tag; a tag/`package.json` mismatch would produce installers whose embedded version disagrees with the release they're published under, and the manifest's `version` (tag) would disagree with the binary's self-reported version. Failing closed before packaging costs one `node -e` and prevents a confusing, hard-to-retract publication. It also gives `publish-artifacts` one unambiguous version source: the tag.

**Spec mapping.** Requirement "Linux `.deb` Installer" (scenario "Package version matches the tag") and "Release Pipeline Integrity for Installers" (fail-closed gating).

## ADR 8 — Cleanup job: include

**Decision.** Add a final `cleanup` job mirroring timetracker: `needs: [release, installer-windows, installer-linux, smoke, provenance, publish-artifacts]`, `if: always()`, deletes the workflow-run artifacts (upload-artifact v4 `delete-artifacts` or `gh api` deletion). It never gates anything.

**Rationale.** Each release run now uploads raw-binary artifacts plus installer artifacts plus provenance artifacts (6+ named artifacts, tens of MB each); without cleanup, org storage quota accumulates per tag. `if: always()` ensures artifacts are reaped even when a downstream job fails. The job is purely additive — it cannot affect the release or publish outcomes, only storage.

**Spec mapping.** Requirement "Release Pipeline Integrity for Installers" (operational hygiene; no scenario contradicts it) — non-normative hardening consistent with the org pattern.

## ADR 9 — Tool acquisition: `fetch-tools.sh` + `toolchain.lock.yaml` (sha256-pinned) for nfpm; choco for NSIS

**Decision.** Mirror timetracker's mechanism: `build/linux/toolchain.lock.yaml` pins the nfpm version, download URL, and sha256; `build/linux/fetch-tools.sh` downloads, verifies the hash, and rejects untrusted redirect hosts before installing to a tools dir on `PATH`. Scope: **nfpm only** (no linuxdeploy/AppImage — non-goal). NSIS comes from `choco install nsis` (version-pinned via `--version`) on `installer-windows` — stock NSIS needs no plugins under ADR 2, so there is no second pinning surface.

**Rationale.** The lockfile approach is the proven org pattern: auditable, reproducible, and fail-closed on hash mismatch or redirect-to-untrusted-host. A lighter inline pin (curl + hardcoded sha256 in the step) scatters the same information across the workflow file with less structure and no shared precedent in the org; consistency with sgi-timetracker also lowers review cost for the org team.

**Spec mapping.** Non-normative implementation choice (openspec config keeps tool acquisition design-phase); supports "Linux `.deb` Installer" reproducibility.

## ADR 10 — `.env` guidance for installed users: MCP-client `env` block / Vault; do-not-rename

**Decision.** README gains an "Intranet installation (ACTSIS ProGet)" section covering: (a) Windows steps (download `outlook-mcp-setup.exe` from ProGet, run, accept PATH, restart terminal); (b) Linux steps (download `.deb`, `sudo dpkg -i` / `apt install ./outlook-mcp_<version>_amd64.deb`); (c) credential configuration for installed paths: the `.env`-beside-executable mechanism does not work for installed binaries (`/usr/bin` and Program Files are not user-writable) — use the MCP-client `env` block (e.g. `OUTLOOK_CLIENT_ID`, `OUTLOOK_CLIENT_SECRET`, `OUTLOOK_TENANT_ID` in the client config) or Vault mode, exactly as already documented for those mechanisms; (d) an explicit do-not-rename warning: renaming `outlook-mcp(.exe)` breaks single-executable dispatch and startup will fail.

**Rationale.** The binary's env resolution (`runtime/load-runtime-env.js`) reads `.env` beside `process.execPath`; beside `/usr/bin/outlook-mcp` or `C:\Program Files\outlook-mcp\` that file cannot be created without elevation, so silently relying on it would produce a broken install experience. Vault and the MCP-client `env` block are first-class, already-documented mechanisms and require no code changes. The rename warning is mandatory product behavior (spec scenario "Renaming breaks dispatch").

**Spec mapping.** Requirement "End-User Intranet Installation Documentation" (scenario "Intranet install steps are documented") and "Installed Executable Name Constraint" (documentation half of both scenarios).

## Component designs

### `build/linux/package-deb.sh`

Bash, `set -euo pipefail`, mirroring timetracker's script adapted for a single CLI binary:

1. Requires `GITHUB_REF_NAME` matching `v<semver>` and `GITHUB_SHA`; strips `v` for the package version (spec scenario "Package version matches the tag").
2. Copies the downloaded SEA binary to a staging dir as `outlook-mcp` (mode 0755).
3. Runs `dpkg-shlibdeps` against the staged binary to derive `Depends` (emits `libc6 (>= 2.39)` plus anything else actually linked — spec scenario "Package dependencies reflect the binary").
4. Renders `nfpm.yaml.tmpl` with `@VERSION@`, `@MAINTAINER@`, `@BINARY@`, `@DEPENDS@`, `@SCRIPTS@`.
5. Calls nfpm (acquired via `fetch-tools.sh` from `toolchain.lock.yaml`, ADR 9) to produce `outlook-mcp_<version>_amd64.deb`.
6. Prints the resulting path for the workflow's `upload-artifact` step.

### `build/linux/nfpm.yaml.tmpl`

```yaml
name: outlook-mcp
arch: amd64
version: '@VERSION@'
maintainer: '@MAINTAINER@'
description: MCP server for Microsoft 365 (packaged for ACTSIS intranet)
depends:
  - '@DEPENDS@' # rendered from dpkg-shlibdeps output
contents:
  - src: '@BINARY@'
    dst: /usr/bin/outlook-mcp
    file_info:
      mode: 0755
scripts:
  postinstall: '@SCRIPTS@/postinst'
  postremove: '@SCRIPTS@/postrm'
```

`postinst`/`postrm` are no-op `#!/bin/sh\nexit 0` scripts: all user data (token file `~/.outlook-mcp-tokens.json`, Vault cache, config) is `~`-scoped and never touched by package operations (spec scenario "Maintainer scripts preserve user data"). Package name `outlook-mcp` and install path `/usr/bin/outlook-mcp` both satisfy the SEA probe (spec scenario "Every installed name satisfies the probe").

### `build/linux/tests/container-smoke.sh`

Runs on the ubuntu-latest runner with Docker; parameterized by the `.deb` path. Sequence inside `ubuntu:24.04`:

1. `dpkg -i <deb>` → assert `/usr/bin/outlook-mcp` exists, mode 0755.
2. `outlook-mcp mcp` in background → grep "connected and listening" in the log within 30s (same probe as the existing `validate` job).
3. `outlook-mcp auth` in background → `curl -sf http://localhost:3333/` returns 200.
4. `dpkg -i <deb>` again → exercises the upgrade path (postinst rerun, no user-data interference).
5. `dpkg -r outlook-mcp` → binary gone.
6. `dpkg -P outlook-mcp` → purge completes; assert `~`-scoped fixtures created during the run are untouched (the smoke asserts the token-file path is not modified by package operations).

Any step failing exits non-zero, which fails the `smoke` job and (via `provenance` → `publish-artifacts` needs-chain) blocks publication.

### `build/windows/installer.nsi`

- `!include "x64.nsh"`, `!include "WinMessages.nsh"`; `RequestExecutionLevel admin`; `SetCompressor lzma`.
- Guard: `${IfNot} ${RunningX64}` → `MessageBox` + `Abort` **before any write** (spec scenario "32-bit Windows is refused" — no system modification).
- `InstallDir "$PROGRAMFILES64\outlook-mcp"`; `SetRegView 64`.
- `File /oname=outlook-mcp.exe` the staged SEA exe (ADR 2; spec scenario "Installer sets up Windows machine").
- PATH: read `HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path"`; append `;$INSTDIR` if absent; `WriteRegExpandStr`; broadcast `WM_SETTINGCHANGE`.
- `WriteUninstaller "$INSTDIR\uninstall.exe"`; uninstall registry key under `HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\outlook-mcp"` with `DisplayName`, `DisplayVersion` (from package.json version, injected at build), `UninstallString`, `Publisher`.
- Uninstall section: delete installed files, remove the PATH entry (string-removal + re-write + broadcast), `DeleteRegKey` the uninstall entry (spec scenario "Uninstall cleans up completely").
- Output name `outlook-mcp-setup.exe` (ADR 2).
- Version is passed via `-DVERSION=...` on the `makensis` command line (single source: `package.json` version after the ADR 7 drift check passed against the tag).

### `build/proget-manifest.js` (Node, CommonJS, Jest-testable)

Mirrors the `build/package.js` culture: small, side-effect-free module + thin CLI entry. Contract:

```js
/**
 * Build the latest-stable.json manifest content.
 * @param {object} input
 * @param {string} input.version            - e.g. "2.3.2" (no "v" prefix)
 * @param {string} input.date               - ISO 8601 date string (caller-supplied for determinism)
 * @param {string} input.notesUrl           - https://github.com/ACTSIS/outlook-mcp/releases/tag/v<version>
 * @param {string} input.sha256sumsContent  - contents of SHA256SUMS ("<hash>  <filename>" lines)
 * @param {string[]} input.assets           - ordered asset file names to include (ADR 1 set)
 * @param {object} input.proget             - { baseUrl, assetDirectory, targetPrefix }
 * @returns {string} JSON manifest (stable key order, 2-space indent + trailing newline)
 */
function buildManifest(input) { ... }
module.exports = { buildManifest, parseSha256sums, assetUrl };
```

Behavioral requirements (all spec-scenario backed):

- **Deterministic:** the date is an input, not `new Date()`; key order is fixed; output is pure `JSON.stringify(..., null, 2)` — satisfies "Manifest generation is unit-testable".
- URL per asset: `${baseUrl}/endpoints/${assetDirectory}/content/${targetPrefix}/${version}/${name}` — every listed URL resolves under `outlook-mcp/<version>/` ("Manifest content is complete and accurate").
- Fails (throws with a clear message) on: version with a `v` prefix, an asset in `assets` missing from `sha256sumsContent`, a malformed checksum line — fail-closed generation.
- CLI mode (`node build/proget-manifest.js --version ... --assets ... < SHA256SUMS > latest-stable.json`) used by `publish-artifacts`; the module's pure function is what Jest tests.

Manifest shape:

```json
{
  "version": "2.3.2",
  "date": "2025-06-01T00:00:00Z",
  "notesUrl": "https://github.com/ACTSIS/outlook-mcp/releases/tag/v2.3.2",
  "assets": [
    {
      "name": "outlook-mcp-setup.exe",
      "url": "https://artifacts.actsis.com/endpoints/actsis-ai-policy/content/outlook-mcp/2.3.2/outlook-mcp-setup.exe",
      "sha256": "…"
    },
    { "name": "outlook-mcp_2.3.2_amd64.deb", "url": "…", "sha256": "…" },
    { "name": "outlook-mcp-win-x64.exe", "url": "…", "sha256": "…" },
    { "name": "outlook-mcp-linux-x64", "url": "…", "sha256": "…" }
  ]
}
```

The publish job overwrites it at `outlook-mcp/latest-stable.json` ("Manifest reflects only the newest release" — overwrite, never append).

## Workflow design (`.github/workflows/release.yml` — additive only)

All new jobs carry `permissions: contents: read` (workflow-level default), `timeout-minutes`, and actions at v4 per repo convention. The `release` job block is not touched.

### `installer-windows`

- `runs-on: windows-latest`, `needs: build`, downloads `artifact-win-x64`.
- Steps: checkout → Node 22.22.1 (NSIS step needs no npm deps; makensis consumes the built exe) → **ADR 7 drift check** (`node -e` comparing `GITHUB_REF_NAME` to `v`+`package.json` version) → `choco install nsis --version=<pinned>` → `makensis -DVERSION=<pkg version> build\windows\installer.nsi` → upload `outlook-mcp-setup.exe` as artifact `installer-win-x64`.

### `installer-linux`

- `runs-on: ubuntu-latest`, `needs: build`, downloads `artifact-linux-x64`.
- Steps: checkout → **ADR 7 drift check** → `build/linux/fetch-tools.sh` (nfpm from `toolchain.lock.yaml`, ADR 9) → `build/linux/package-deb.sh` (produces `outlook-mcp_<version>_amd64.deb`) → **ADR 5 `.deb` payload secret-scan** (`dpkg-deb --fsys-tarout … | tar -x` to temp; `node -e` with `scanDirectory`/`canPublish`, fail-closed) → upload the `.deb` as artifact `installer-linux-x64`.

### `smoke`

- `runs-on: ubuntu-latest`, `needs: [installer-windows, installer-linux]`, downloads both installer artifacts.
- Steps: checkout → `docker run` mounting the `.deb`, executing `build/linux/tests/container-smoke.sh` inside `ubuntu:24.04` (ADR 3). The Windows installer is a gate dependency (built and present) but is not executed in CI — Windows-install execution is out of scope for automated smoke and covered by the NSIS script review + structure; the spec's smoke requirement is `.deb`-container-based.

### `provenance`

- `runs-on: ubuntu-latest`, `needs: [smoke]`, downloads all four product artifacts (raw binaries from build artifacts, installers from smoke artifacts).
- Steps: checkout → `sha256sum` over the four assets → `SHA256SUMS` → SBOM via `anchore/sbom-action@v0` (syft, SPDX JSON, `outlook-mcp-<version>-sbom.spdx.json`) over the assets → upload `provenance` artifact (`SHA256SUMS` + SBOM).
- Ordering note: `provenance` sits after `smoke` so checksums cover exactly the assets that passed smoke, and so smoke failure transitively blocks `publish-artifacts` ("Publication ordering is enforced", "A smoke failure MUST block publication").

### `publish-artifacts`

- `runs-on: ubuntu-latest`, `needs: [release, installer-windows, installer-linux, provenance]` (spec scenario "Publication ordering is enforced": GitHub release + both installers + provenance; smoke via provenance).
- `concurrency: group: proget-publish-${{ github.ref }}`, `cancel-in-progress: false` (spec scenario "Same-version publications are serialized").
- Steps, in order:
  1. Checkout; download all artifacts (raw binaries, installers, provenance).
  2. **Fail-closed secret guard** (spec scenario "Missing secrets fail closed"): `if [ -z "${NETBIRD_SETUP_KEY}" ] || [ -z "${PROGET_API_KEY}" ]; then echo "::error::missing publish secret"; exit 1; fi` — runs before the tunnel is created, so no upload can happen.
  3. Install NetBird (`curl -fsSL https://pkgs.netbird.io/install.sh | sudo sh`), `sudo netbird up --setup-key "${NETBIRD_SETUP_KEY}" --management-url "${NETBIRD_MANAGEMENT_URL}"`.
  4. Upload each asset (ADR 1 set + `SHA256SUMS` + SBOM): `curl --fail-with-body --retry 3 -X POST -H "X-ApiKey: ${PROGET_API_KEY}" -H "Content-Type: application/octet-stream" --data-binary @<file> "${PROGET_BASE_URL}/endpoints/${PROGET_ASSET_DIRECTORY}/content/${PROGET_TARGET_PREFIX}/<version>/<file>"` — any non-2xx fails the job ("an upload failure MUST fail the publish job").
  5. Generate manifest: `node build/proget-manifest.js --version <ver> --date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --assets <ADR 1 list> < SHA256SUMS > latest-stable.json`; upload it (overwrite) at `outlook-mcp/latest-stable.json`.
  6. `sudo netbird down` with `if: always()` (spec scenario "NetBird tunnel is always torn down").
- Because the job only exists in the tag-triggered release workflow, branch pushes and PRs can never publish (spec scenario "Non-tag events never publish"), and because every upstream is in `needs`, upstream failure skips the job (spec scenario "Upstream failure blocks publication").
- Because `release` is a sibling `needs` entry and not modified, a `publish-artifacts` failure cannot affect the GitHub Release (spec scenario "ProGet failure does not affect the public channel" — the release job has already run and completed).

### `cleanup` (ADR 8)

- `needs: [release, installer-windows, installer-linux, smoke, provenance, publish-artifacts]`, `if: always()`, deletes this run's workflow artifacts. Never blocks anything.

## Test design

### `test/build/release-workflow.test.js` (modified)

Replace the "never references or receives OAuth client secrets" test's `/\bsecrets\./` blanket regex with a secret **allowlist**:

- **Fail-closed allowlist:** `expect(raw).not.toMatch(/\bsecrets\.(?!NETBIRD_SETUP_KEY|PROGET_API_KEY)\w/)` — any secret other than the two infrastructure keys is forbidden.
- **Explicit OAuth forbiddance:** `expect(raw).not.toMatch(/OUTLOOK_CLIENT_SECRET|MS_CLIENT_SECRET/)` — covers both `secrets.OUTLOOK_CLIENT_SECRET`-style refs and the literal environment variable names, satisfying the spec scenario "OAuth secrets remain forbidden".
- **Positive consumption assertion (new test):** parse the YAML and assert the `publish-artifacts` job consumes `secrets.NETBIRD_SETUP_KEY` and `secrets.PROGET_API_KEY` (via its guard/netbird env steps), satisfying "Infrastructure secrets are allowed and consumed".

Add structural assertions (extending the existing `describe` style):

- `installer-windows` / `installer-linux` need `build` ("Failed build blocks installers").
- `smoke` needs both installer jobs; `provenance` needs `smoke`; `publish-artifacts` needs `release`, both installers, and `provenance` ("Publication ordering is enforced").
- `publish-artifacts` has concurrency group keyed on the ref, a `netbird down` step with `if: always()`, and a pre-upload secret guard step.
- The `release` job remains exactly as before (the existing release-publication tests continue to pass unchanged — they are the regression net for "GitHub Release output is preserved").

### `test/build/proget-manifest.test.js` (new)

Jest unit tests over the pure `buildManifest`:

- Deterministic output for fixed inputs (snapshot or two-call equality).
- Correct URLs under `outlook-mcp/<version>/`, `notesUrl` shape, checksums parsed from `SHA256SUMS` lines (incl. two-space separator).
- Throws on: `v`-prefixed version; asset missing from SHA256SUMS; malformed checksum line; missing input fields.
- Stable key ordering and JSON formatting.

## Documentation changes

- `README.md`: new "Intranet installation (ACTSIS ProGet)" section per ADR 10, plus the glibc correction per ADR 6 (raw binary + `.deb` baseline: glibc ≥ 2.39 / Ubuntu 24.04+).

## Spec requirement coverage matrix

| Spec requirement                             | Design elements                                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Linux `.deb` Installer                       | `package-deb.sh`, `nfpm.yaml.tmpl`, no-op maintainer scripts, ADR 6/7, ADR 9                                        |
| Windows NSIS Installer                       | `installer.nsi`, ADR 2, `installer-windows` job                                                                     |
| Installed Executable Name Constraint         | ADR 2 exe name, `.deb` `/usr/bin/outlook-mcp`, ADR 10 do-not-rename docs                                            |
| Intranet ProGet Publication                  | `publish-artifacts` job (needs-gates, concurrency, NetBird up/down, secret guard, retry uploads), tag-only workflow |
| `latest-stable.json` Manifest                | `proget-manifest.js` contract, ADR 1 paths/assets, overwrite semantics                                              |
| Public GitHub Release Channel Unchanged      | additive-only workflow edits; `scan`/`release` untouched; ADR 5                                                     |
| Release Pipeline Integrity for Installers    | job graph (`installer-*` → `smoke` → `provenance` → `publish-artifacts`), `container-smoke.sh`, ADR 3, ADR 7        |
| Workflow Secrets Policy                      | re-scoped allowlist assertions + positive consumption test                                                          |
| End-User Intranet Installation Documentation | README section, ADR 6 + ADR 10                                                                                      |

## File inventory (implementation surface)

New: `build/linux/package-deb.sh`, `build/linux/nfpm.yaml.tmpl`, `build/linux/fetch-tools.sh`, `build/linux/toolchain.lock.yaml`, `build/linux/scripts/postinst`, `build/linux/scripts/postrm`, `build/linux/tests/container-smoke.sh`, `build/windows/installer.nsi`, `build/proget-manifest.js`, `test/build/proget-manifest.test.js`.

Modified: `.github/workflows/release.yml` (additive jobs only), `test/build/release-workflow.test.js` (re-scoped secrets assertions + new structural tests), `README.md` (intranet install + glibc correction).

Unchanged: `release` job, `scan` job, all runtime code (`bin/`, `runtime/`, `auth/`, etc.), `ci.yml` (ADR 4).

## Data flow summary

`build/package.js` SEA binaries → (unchanged path) GitHub Release; → `installer-*` jobs → `outlook-mcp-setup.exe` + `outlook-mcp_<version>_amd64.deb` → `smoke` (container lifecycle + boot checks) → `provenance` (SHA256SUMS + SBOM) → `publish-artifacts` (NetBird tunnel → per-asset POST under `outlook-mcp/<version>/` → `proget-manifest.js` from SHA256SUMS → manifest POST to `outlook-mcp/latest-stable.json` → tunnel down) → `cleanup`. Version flows from the tag (single source), validated against `package.json` (ADR 7), into the `.deb` version, the NSIS `DisplayVersion`, and the manifest `version`+`notesUrl`.

## Rollout

1. Land the test changes first where possible (the re-scoped secrets test will fail against the un-extended workflow if shipped alone — so workflow and test land together in the same PR; `npm test` green is the merge gate).
2. Merge the packaging scripts + `installer-*`/`smoke`/`provenance` jobs; first `v*` tag after merge exercises everything with `publish-artifacts` gated on the already-provisioned secrets.
3. Validate the first release: ProGet assets under `outlook-mcp/<version>/`, manifest at `outlook-mcp/latest-stable.json`, checksums re-verify, GitHub Release identical to prior format.
4. Update README (intranet section + glibc correction) in the same change; rollback follows the proposal's plan (revert workflow + build files; GitHub Release channel untouched throughout).

## Risks and mitigations

- **Two prior SDD attempts died before persisting the artifact** — this design is written to `openspec/changes/add-intranet-distribution/design.md` as the first substantive action.
- **SEA-probe rename trap** (a friendly product name in either installer would break dispatch): mitigated by ADR 2 name choice, spec constraint, docs warning, and smoke tests that boot via `/usr/bin/outlook-mcp`.
- **Test/PR ordering:** the re-scoped secrets test only passes with the extended workflow present; they must merge atomically (single PR) or CI fails — flagged in Rollout step 1.
- **Same-version republish semantics:** ProGet POST overwrites per file; concurrency group prevents interleaving; a partial failed upload leaves the old `latest-stable.json` pointing at the previous version (manifest is uploaded last), so intranet users never see a half-published release.
- **Runner glibc drift** (`ubuntu-latest` moving to a newer Ubuntu): would raise the `.deb` floor; acceptable and visible via `dpkg-shlibdeps`; pin to `ubuntu-24.04` explicitly in `installer-linux` if drift is observed.
- **Windows installer not execution-tested in CI:** NSIS script correctness relies on review + the proven org template; smoke covers the `.deb` only (spec-consistent). A future manual install checklist on an ACTSIS Windows host closes the gap.
