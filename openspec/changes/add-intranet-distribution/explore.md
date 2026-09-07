# Exploration: Intranet distribution via ProGet (add-intranet-distribution)

Status: exploration complete — feasibility confirmed, no implementation performed.

## Scope and confirmed decisions (not re-litigated)

- Linux installer: `.deb` installing the SEA binary to `/usr/bin/outlook-mcp`.
- Windows installer: NSIS (Program Files, PATH entry, uninstall entry).
- Distribution: keep public GitHub Releases unchanged AND add intranet ProGet publication (ACTSIS ProGet Asset Directory).
- Reference implementation: ACTSIS/sgi-timetracker release workflow (same org pattern), read locally at `/home/rpinto/Workspace/sgi-timetracker`.

## Findings

### 1. Current pipeline (verified locally)

`.github/workflows/release.yml` (tag `v*` push only, no PR/branch trigger):

- `build` (matrix): `win-x64` on windows-latest, `linux-x64` on ubuntu-latest; `npm run package -- --target <t>` via `build/package.js` (ncc bundle → Node 22 SEA blob → postject; native-runner-only, atomic `dist/<target>/` commit). Outputs `dist/win-x64/outlook-mcp-win-x64.exe` and `dist/linux-x64/outlook-mcp-linux-x64`, uploaded as `artifact-win-x64` / `artifact-linux-x64`.
- `validate` (needs build): boots each binary in `mcp` mode (greps "connected and listening") and `auth` mode (curl `http://localhost:3333/` HTTP 200).
- `scan` (needs build, validate): `build/secret-scan.js` over merged `dist/`, fail-closed.
- `release` (needs build, validate, scan; contents: write): `gh release create "$GITHUB_REF_NAME" dist/outlook-mcp-win-x64.exe dist/outlook-mcp-linux-x64 --generate-notes`. No CHANGELOG.md exists.
- No cleanup job; actions pinned to v4; `permissions: contents: read` at workflow level.

`ci.yml`: quality (lint, format:check, `npm test` on Node 22.22.1 and 24) + health-badges job. Jest runs with default config; suites live under `test/` (e.g. `test/build/release-workflow.test.js` parses release.yml with `yaml` and asserts structure).

Repo facts: origin = ACTSIS/outlook-mcp, upstream = rafaga2469/outlook-mcp. `package.json` version 2.3.2. Repo variables/secrets already configured (parent-verified): `NETBIRD_SETUP_KEY`, `PROGET_API_KEY` (secrets); `NETBIRD_MANAGEMENT_URL=https://edge.actsis.com`, `PROGET_BASE_URL=https://artifacts.actsis.com`, `PROGET_ASSET_DIRECTORY=actsis-ai-policy`, `PROGET_TARGET_PREFIX=outlook-mcp` (variables).

### 2. Reference pattern (sgi-timetracker, verified locally)

`verify` → `build-windows` (choco install nsis; `makensis build\windows\installer.nsi`) → `build-linux` (binary + `.deb` via `build/linux/package-deb.sh` + `nfpm.yaml.tmpl` + AppImage) → `container-smoke` / `host-smoke` (docker Ubuntu 24.04 image; install/upgrade/downgrade/remove/purge with immutable user-data fixture) → `provenance` (aggregate `SHA256SUMS` + SBOM spdx) → `publish` (GitHub Release via softprops, notes from CHANGELOG) → `publish-artifacts` (NetBird `curl -fsSL https://pkgs.netbird.io/install.sh | sh`, `sudo netbird up --setup-key ...`, POST each asset to `{BASE_URL}/endpoints/{ASSET_DIRECTORY}/content/{TARGET_PREFIX}/<file>` with `X-ApiKey` + `Content-Type: application/octet-stream`, `--fail-with-body --retry 3`; then overwrite `latest-stable.json` manifest with version/date/notesUrl/assets(url+sha256 parsed from SHA256SUMS); `sudo netbird down` with `if: always()`) → `cleanup` (delete inter-job artifacts).

Key reference details:

- `build/linux/package-deb.sh`: requires `GITHUB_REF_NAME=vMAJOR.MINOR.PATCH` and `GITHUB_SHA` matching the tag; runs `dpkg-shlibdeps` on the binary to derive `Depends`; renders `nfpm.yaml.tmpl` (substituting `@VERSION@`, `@MAINTAINER@`, `@BINARY@`, `@DEPENDS@`, scripts); packages with nfpm fetched by `fetch-tools.sh` from a pinned `toolchain.lock.yaml` (sha256-verified, trusted-host-only redirects).
- `nfpm.yaml.tmpl`: `arch: amd64`, contents `src: <binary> dst: /usr/bin/<name> file_info: { mode: 0755 }`, `scripts: postinstall/postremove` (both no-op `exit 0` — user data lives in `~`, never touched).
- `build/windows/installer.nsi`: `x64.nsh` guard, `SetRegView 64`, MUI2 pages, `RequestExecutionLevel admin`, `WriteUninstaller`, uninstall registry key under `HKLM ...\Uninstall\<Key>`, shortcuts, `SetCompressor lzma`. Timetracker does NOT add PATH (GUI app) — outlook-mcp needs a PATH step (see open questions).
- `publish-artifacts` uses `PROGET_TARGET_PREFIX: releases/${{ needs.verify.outputs.version }}` and manifest at `releases/latest-stable.json`; concurrency group `proget-publish-<version>`; `netbird down` in `if: always()` step.

### 3. SEA binary relocation — verified safe, with one hard constraint

Read `bin/m365-mcp.js`, `runtime/load-runtime-env.js`, `runtime/load-env.js`:

- No cwd assumptions: `.env` is resolved beside the executable (`path.dirname(process.execPath)`); tokens at `~/.outlook-mcp-tokens.json` (HOME/USERPROFILE); Vault cache under `%LOCALAPPDATA%`/`XDG_CONFIG_HOME`; auth relaunch uses `process.execPath` with args `['auth']`. The binary works from `/usr/bin` and Program Files.
- **Hard constraint (SEA probe):** `shouldDispatch()` in `bin/m365-mcp.js` uses `process.execPath.includes('outlook-mcp')` (case-sensitive) as the SEA detection; if that fails it evaluates `require.main === module`, which throws under SEA (ncc rewrites it to a `require.cache[...]` read; `require.cache` is undefined). Therefore the installed executable name MUST contain the lowercase substring `outlook-mcp`. `/usr/bin/outlook-mcp` satisfies this; the NSIS script must install the exe as e.g. `outlook-mcp.exe` or keep `outlook-mcp-win-x64.exe` — never rename to something like "M365 Assistant MCP Server.exe".
- `.env` beside `/usr/bin` or Program Files is not user-writable; the primary credential path for installed users is the MCP-client `env` block or Vault (both already documented). README must say this explicitly for the installer paths.

### 4. What must be added (design-phase inventory)

| Item               | Location                                                                                                                                                                                                   | Notes                                                                                                                                                                                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NSIS script        | `build/windows/installer.nsi`                                                                                                                                                                              | Wraps the SEA exe; x64 guard; install to `$PROGRAMFILES64\outlook-mcp`; PATH entry; uninstall registry key; keep `outlook-mcp` in exe name                                                                                                                       |
| .deb packaging     | `build/linux/package-deb.sh`, `build/linux/nfpm.yaml.tmpl`, `build/linux/fetch-tools.sh`, `build/linux/toolchain.lock.yaml` (nfpm only — no AppImage/linuxdeploy), `build/linux/scripts/{postinst,postrm}` | Adapted from timetracker; no desktop/icon needed (CLI); binary → `/usr/bin/outlook-mcp` mode 0755                                                                                                                                                                |
| .deb smoke         | `build/linux/tests/container-smoke.sh` (adapted)                                                                                                                                                           | Docker Ubuntu image: install, `outlook-mcp mcp` boots ("connected and listening"), `outlook-mcp auth` serves :3333, remove/purge. Simpler than timetracker (no systemd, no GUI, no user-data fixture needed — token file is `~`-scoped and untouched)            |
| Manifest generator | `build/proget-manifest.js` (Node, Jest-testable, mirrors `build/package.js` culture)                                                                                                                       | Builds `latest-stable.json` from SHA256SUMS + version + notesUrl; unit-testable instead of inline bash                                                                                                                                                           |
| Workflow jobs      | `.github/workflows/release.yml`                                                                                                                                                                            | `installer-windows` (needs build; choco nsis + makensis), `installer-linux` (needs build; package-deb), `smoke` (needs installers), `provenance` (SHA256SUMS + SBOM), `publish-artifacts` (needs release + installers + provenance; NetBird + ProGet + manifest) |
| Tests              | `test/build/release-workflow.test.js` (extend), `test/build/proget-manifest.test.js` (new)                                                                                                                 | Follow existing Jest patterns                                                                                                                                                                                                                                    |
| Docs               | `README.md` (+ optional `docs/intranet-distribution.md`)                                                                                                                                                   | Intranet install instructions for Windows (.exe installer) and Linux (.deb)                                                                                                                                                                                      |

### 5. Critical test conflict (must be handled in design)

`test/build/release-workflow.test.js` "never references or receives OAuth client secrets" asserts `expect(raw).not.toMatch(/\bsecrets\./)` over the whole workflow file. Adding `secrets.NETBIRD_SETUP_KEY` / `secrets.PROGET_API_KEY` will fail this test. The design must scope the assertion to OAuth secrets (e.g. forbid `secrets.OUTLOOK_CLIENT_SECRET` / `secrets.MS_CLIENT_SECRET` and the literal env names) while explicitly allowing the two infra secrets, and add a positive assertion that the publish job consumes them.

### 6. Versioning and glibc notes

- Version source: tag (`GITHUB_REF_NAME` without `v`), matching timetracker. `build/package.js` already reads `package.json` version for Windows VERSIONINFO; recommend an optional fail-closed check that the tag equals `v{package.json version}` to prevent drift.
- glibc: `ubuntu-latest` is Ubuntu 24.04 (glibc 2.39); README claims "glibc 2.28+" for the raw binary. `dpkg-shlibdeps` on 24.04 will emit `Depends: libc6 (>= 2.39)`. Decide: target Ubuntu 24.04 for the `.deb` (consistent with timetracker; update README claim for the .deb path) or build on an older runner to preserve 2.28+.

### 7. Suggested job graph (for design phase)

```text
build (existing) ──> validate (existing) ──> scan (existing) ──> release (existing, unchanged)
build ──> installer-windows (NSIS) ─┐
build ──> installer-linux (.deb) ──┼──> smoke ──> provenance ──> publish-artifacts (NetBird+ProGet)
                                    └───────────────────────────────────────────┘
```

- `release` stays byte-for-byte unchanged (two binaries, `--generate-notes`) per the product decision.
- `publish-artifacts` needs: release, installer-windows, installer-linux, provenance; concurrency group `proget-publish-<version>`; `netbird down` with `if: always()`.
- Manifest path design: assets at `outlook-mcp/<version>/<file>` (PROGET_TARGET_PREFIX + version dir, mirroring timetracker's `releases/<version>`), manifest overwritten at `outlook-mcp/latest-stable.json`. `notesUrl` = `https://github.com/ACTSIS/outlook-mcp/releases/tag/v<version>`.
- Keep actions at v4 (repo convention) unless a bump is explicitly desired.

## Open questions for the design phase

1. **Manifest path**: confirm `outlook-mcp/<version>/<file>` for assets and `outlook-mcp/latest-stable.json` for the manifest (PROGET_TARGET_PREFIX is already `outlook-mcp`). Which assets enter the manifest — installer + .deb only, or also the two raw binaries?
2. **NSIS PATH entry mechanism**: registry-based append to `HKLM\Environment\Path` (with `WM_SETTINGCHANGE` broadcast) vs. the EnVar plugin (extra download/pinning). Uninstall must remove the entry. Also: installer file name (`outlook-mcp-setup.exe`?) and whether a Start Menu shortcut is wanted for a CLI.
3. **.deb smoke scope**: container-only (docker Ubuntu image) is sufficient for a CLI; confirm no host-smoke job is needed (timetracker's host-smoke exists for GUI/FUSE, which does not apply).
4. **PR-time packaging coverage**: release.yml is tag-only, so installer builds + smoke only run at release time. Should ci.yml (or a new workflow) build installers on PRs to catch packaging regressions early, or is release-time-only acceptable?
5. **Scan coverage**: extend `scan` to also scan the installer and .deb (defense in depth; they embed the already-scanned binaries) or keep scanning the raw binaries only?
6. **glibc baseline**: target Ubuntu 24.04 for the `.deb` (update README claim) vs. preserving the 2.28+ claim by building on an older runner. Timetracker chose 24.04.
7. **Version drift check**: add a fail-closed assertion that the pushed tag equals `v{package.json version}` before packaging?
8. **Cleanup job**: timetracker deletes inter-job artifacts (org storage quota). Add the same `cleanup` job to this workflow, or skip (current workflow has none)?
9. **nfpm acquisition**: mirror timetracker's `fetch-tools.sh` + `toolchain.lock.yaml` (sha256-pinned, trusted-host redirect check) or a lighter inline pin? Same question for the NSIS EnVar plugin if chosen.
10. **.env story for installed users**: confirm README guidance that installed binaries use the MCP-client `env` block or Vault (adjacent `.env` beside `/usr/bin` or Program Files is not user-writable), and that the binary must not be renamed (SEA probe constraint).

## Feasibility verdict

Feasible with low risk. The SEA binary is relocatable (no cwd assumptions), the org pattern is proven end-to-end in sgi-timetracker, and the required secrets/variables already exist. The two non-obvious traps are (a) the SEA-probe name constraint on installed executables and (b) the existing `/\bsecrets\./` workflow test that must be scoped to OAuth secrets. Both are design-time fixes, not blockers.
