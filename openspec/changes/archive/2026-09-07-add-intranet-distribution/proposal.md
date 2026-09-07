# Proposal: Intranet distribution via ProGet (add-intranet-distribution)

Status: proposed — ready for the design phase.

## Why

ACTSIS collaborators currently obtain outlook-mcp only from public GitHub Releases. Inside the ACTSIS network this adds friction: users must reach the public internet, download a raw binary, and manage it manually. The organization already operates a ProGet Asset Directory reachable over NetBird and has a proven release pattern in ACTSIS/sgi-timetracker (verify → build installers → smoke → provenance → GitHub Release → NetBird + ProGet asset upload → `latest-stable.json` manifest). This change brings the same intranet distribution to outlook-mcp: native installers (`.deb` for Linux, NSIS for Windows) published to the ACTSIS ProGet Asset Directory, plus a `latest-stable.json` manifest, so collaborators can install and update with minimal friction.

Goal: minimize end-user friction for ACTSIS collaborators installing and using outlook-mcp, while keeping the public GitHub Releases channel unchanged.

## What Changes

Grouped by capability. Scope is distribution only: installer packaging, ProGet publication, manifest, and end-user docs. Non-goals: in-app auto-updater, macOS targets, npm-package publication to ProGet npm feeds, and changes to the existing GitHub Release job content.

### Capability 1: Linux `.deb` installer

- New `build/linux/package-deb.sh` that packages the SEA binary into a `.deb` installing to `/usr/bin/outlook-mcp` (mode 0755), deriving `Depends` via `dpkg-shlibdeps`.
- New `build/linux/nfpm.yaml.tmpl`, `build/linux/fetch-tools.sh`, `build/linux/toolchain.lock.yaml` (nfpm only, sha256-pinned, trusted-host-only redirects), and no-op `postinst`/`postrm` scripts — user data lives in `~` and is never touched.
- The installed executable name MUST contain the lowercase substring `outlook-mcp` (SEA-probe constraint in `bin/m365-mcp.js`); `/usr/bin/outlook-mcp` satisfies this.

### Capability 2: Windows NSIS installer

- New `build/windows/installer.nsi`: x64 guard, install to `$PROGRAMFILES64\outlook-mcp`, PATH entry, uninstall registry entry, `SetCompressor lzma`.
- The installed executable name MUST keep the lowercase substring `outlook-mcp` (SEA-probe constraint), e.g. `outlook-mcp.exe`; it MUST NOT be renamed to a friendly product name.
- The PATH mechanism (registry append with `WM_SETTINGCHANGE` broadcast vs. the EnVar plugin) is a design-phase decision (open question 2).

### Capability 3: Intranet ProGet publication (NetBird-gated)

- New `publish-artifacts` job in `.github/workflows/release.yml`: NetBird up with `NETBIRD_SETUP_KEY`, POST each asset to `{PROGET_BASE_URL}/endpoints/{PROGET_ASSET_DIRECTORY}/content/{PROGET_TARGET_PREFIX}/<version>/<file>` with `X-ApiKey` and `Content-Type: application/octet-stream`, `--fail-with-body --retry 3`; `netbird down` in an `if: always()` step.
- Concurrency group `proget-publish-<version>`; the job MUST depend on the release, installer, and provenance jobs.
- The existing `release` job (GitHub Release, two raw binaries, `--generate-notes`) stays byte-for-byte unchanged.

### Capability 4: `latest-stable.json` manifest

- New `build/proget-manifest.js` (Node, Jest-testable, mirroring the `build/package.js` culture) that builds `latest-stable.json` from SHA256SUMS + version + `notesUrl` (`https://github.com/ACTSIS/outlook-mcp/releases/tag/v<version>`), overwritten at `outlook-mcp/latest-stable.json`.

### Capability 5: Release pipeline integrity

- New `installer-windows` and `installer-linux` jobs (needs: build); new `smoke` job (needs: installers; container-based `.deb` install/upgrade/remove/purge plus `mcp`/`auth` mode boot checks); new `provenance` job (SHA256SUMS + SBOM).
- The existing `test/build/release-workflow.test.js` assertion `/\bsecrets\./` over the whole workflow MUST be scoped to OAuth secrets (forbid `secrets.OUTLOOK_CLIENT_SECRET` / `secrets.MS_CLIENT_SECRET` and the literal env names) while explicitly allowing `secrets.NETBIRD_SETUP_KEY` and `secrets.PROGET_API_KEY`, and a positive assertion MUST verify the publish job consumes them.
- Optional fail-closed check that the pushed tag equals `v{package.json version}` before packaging (open question 7).

### Capability 6: End-user documentation

- README updates (or a new `docs/intranet-distribution.md`): intranet install instructions for Windows (`.exe` installer) and Linux (`.deb`), the `.env`-beside-executable caveat for installed paths (not user-writable; use the MCP-client `env` block or Vault), and the do-not-rename constraint.

## Impact

### Affected specs

- No existing canonical spec covers distribution or release. A new capability spec `openspec/specs/distribution/spec.md` MUST be created in the design phase covering installer packaging, ProGet publication, the manifest, and end-user install behavior. No deltas to existing specs (`auth`, `email`, `email-attachments`, `flow-token-management`, `power-automate`) are needed.

### Code files

- New: `build/linux/package-deb.sh`, `build/linux/nfpm.yaml.tmpl`, `build/linux/fetch-tools.sh`, `build/linux/toolchain.lock.yaml`, `build/linux/scripts/postinst`, `build/linux/scripts/postrm`, `build/linux/tests/container-smoke.sh`, `build/windows/installer.nsi`, `build/proget-manifest.js`.
- Modified: none in runtime code (`bin/`, `runtime/`, `auth/`, etc.) — the SEA binary is relocatable and requires no code changes.

### Workflow files

- Modified: `.github/workflows/release.yml` (new jobs: `installer-windows`, `installer-linux`, `smoke`, `provenance`, `publish-artifacts`; the `release` job unchanged).
- Possibly modified: `ci.yml` (PR-time packaging coverage — open question 4).

### Test files

- Modified: `test/build/release-workflow.test.js` (scope the secrets assertion; add publish-job assertions).
- New: `test/build/proget-manifest.test.js`.

### Docs

- Modified: `README.md` (intranet install section; glibc claim per open question 6).
- New (optional): `docs/intranet-distribution.md`.

## Rollback plan

This change is moderate risk (new CI jobs, new secrets consumption, new publication target). Rollback:

1. **Code/workflow rollback**: revert the `release.yml` changes and delete the new `build/` files. The existing GitHub Release path is untouched and remains the fallback distribution channel; because the `release` job stays byte-for-byte unchanged, a revert restores the exact current behavior.
2. **ProGet assets**: assets are versioned under `outlook-mcp/<version>/`; a bad publication is superseded by re-running the job for a corrected version. The manifest `latest-stable.json` is overwritten, not appended, so pointing it back at a previous version (or removing it) reverts what intranet users see.
3. **Secrets**: `NETBIRD_SETUP_KEY` and `PROGET_API_KEY` are already provisioned; if publication misbehaves, removing the `publish-artifacts` job from the workflow disables intranet publication without affecting the GitHub Release.
4. **Installer defects**: installers are only published at release time; a defective installer is never promoted to `latest-stable.json` if the smoke job fails (fail-closed gate). If one slips through, the manifest is overwritten with the previous good version and the bad asset can be deleted from the ProGet Asset Directory.
5. **No runtime code changes**: the SEA binary and runtime behavior are unchanged, so there is no runtime rollback surface.

## Success criteria

- A `v*` tag push produces, in addition to the existing GitHub Release, a Windows NSIS installer and a Linux `.deb` that pass smoke, are published to the ACTSIS ProGet Asset Directory under `outlook-mcp/<version>/`, and are referenced by an updated `outlook-mcp/latest-stable.json`.
- An ACTSIS collaborator on NetBird can install outlook-mcp on Windows (installer, PATH entry, uninstall entry) and Linux (`.deb` → `/usr/bin/outlook-mcp`) and run `mcp`/`auth` modes without touching the public internet.
- The existing GitHub Release job output is unchanged.
- `npm test` passes, including the re-scoped secrets assertion and the new manifest tests.

## Open questions carried to the design phase (design-level, not answered here)

1. Manifest path and asset set: `outlook-mcp/<version>/<file>` for assets and `outlook-mcp/latest-stable.json` for the manifest; which assets enter the manifest (installer + `.deb` only, or also the two raw binaries).
2. NSIS PATH mechanism (registry append + `WM_SETTINGCHANGE` vs. EnVar plugin); installer file name; whether a Start Menu shortcut is wanted for a CLI.
3. `.deb` smoke scope: container-only (docker Ubuntu image) is sufficient for a CLI; confirm no host-smoke job is needed.
4. PR-time packaging coverage: build installers + smoke on PRs (ci.yml or a new workflow) vs. release-time-only.
5. Scan coverage: extend `scan` to the installer and `.deb` vs. raw binaries only.
6. glibc baseline for the `.deb`: target Ubuntu 24.04 (update README claim) vs. preserve the 2.28+ claim by building on an older runner.
7. Fail-closed tag-vs-version drift check before packaging.
8. Cleanup job for inter-job artifacts (org storage quota) vs. skip (current workflow has none).
9. nfpm acquisition: mirror timetracker's `fetch-tools.sh` + `toolchain.lock.yaml` vs. a lighter inline pin; same question for the NSIS EnVar plugin if chosen.
10. `.env` story for installed users: README guidance that installed binaries use the MCP-client `env` block or Vault, and that the binary must not be renamed (SEA-probe constraint).
