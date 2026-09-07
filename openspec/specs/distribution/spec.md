# Distribution Specification

## Purpose

Define how outlook-mcp is packaged into native installers (`.deb` for Linux, NSIS for Windows), published to the ACTSIS ProGet Asset Directory over NetBird, advertised through the `latest-stable.json` manifest, and documented for intranet end users — while keeping the existing public GitHub Releases channel unchanged. This spec covers product-true distribution behavior; tool-acquisition mechanisms, runner choices, and other implementation selections are design-phase concerns.

## Requirements

### Requirement: Linux `.deb` Installer

The release pipeline MUST produce a Debian package for amd64 that installs the outlook-mcp SEA binary at `/usr/bin/outlook-mcp` with mode 0755. The package's declared runtime library dependencies MUST be derived from the packaged binary's actual shared-library requirements, not from a hard-coded guess. The package version MUST equal the release tag version without the `v` prefix.

#### Scenario: `.deb` installs a working binary

- GIVEN a `.deb` built from a `vX.Y.Z` tag push
- WHEN it is installed on a supported amd64 Debian-based distribution
- THEN the executable MUST exist at `/usr/bin/outlook-mcp` with mode 0755
- AND the installed file name MUST contain the lowercase substring `outlook-mcp`
- AND running `outlook-mcp` in `mcp` mode MUST boot the server

#### Scenario: Package dependencies reflect the binary

- GIVEN the packaged SEA binary's shared-library linkage
- WHEN the `.deb` control metadata is generated
- THEN the declared `Depends` MUST be derived from that linkage (e.g. via `dpkg-shlibdeps`)

#### Scenario: Maintainer scripts preserve user data

- GIVEN the `.deb`'s maintainer scripts
- WHEN the package is installed, removed, upgraded, or purged
- THEN user-scoped data (token file, Vault cache, configuration) MUST remain untouched

#### Scenario: Package version matches the tag

- GIVEN a `vX.Y.Z` tag push
- WHEN the `.deb` is built
- THEN the package version MUST be `X.Y.Z`

### Requirement: Windows NSIS Installer

The release pipeline MUST produce a 64-bit Windows NSIS installer that installs the outlook-mcp SEA executable into the 64-bit Program Files directory, adds the installation directory to `PATH`, and registers an uninstall entry. The installer MUST refuse to run on 32-bit Windows, and uninstall MUST remove the installed files, the `PATH` entry, and the uninstall registry entry.

#### Scenario: Installer sets up Windows machine

- GIVEN 64-bit Windows
- WHEN the NSIS installer is run
- THEN the executable MUST be installed under the 64-bit Program Files directory for `outlook-mcp`
- AND the installed executable file name MUST contain the lowercase substring `outlook-mcp`
- AND the installation directory MUST be added to `PATH`
- AND an uninstall entry MUST be registered in the Windows registry

#### Scenario: 32-bit Windows is refused

- GIVEN 32-bit Windows
- WHEN the NSIS installer is run
- THEN the installer MUST refuse to install and MUST NOT modify the system

#### Scenario: Uninstall cleans up completely

- GIVEN the NSIS installer has completed successfully
- WHEN the uninstaller is run
- THEN the installed files, the `PATH` entry, and the uninstall registry entry MUST be removed

### Requirement: Installed Executable Name Constraint

Because single-executable dispatch relies on a case-sensitive probe of `process.execPath` for the lowercase substring `outlook-mcp`, every distribution artifact that installs an executable MUST install it under a file name containing that lowercase substring. Installation MUST NOT rename the executable to a friendly product name, and user-facing documentation MUST state that the installed executable MUST NOT be renamed after installation.

#### Scenario: Every installed name satisfies the probe

- GIVEN the `.deb` installer and the NSIS installer
- WHEN each installs its executable
- THEN each installed file name MUST contain the lowercase substring `outlook-mcp`

#### Scenario: Renaming breaks dispatch

- GIVEN an installed executable whose file name no longer contains the lowercase substring `outlook-mcp`
- WHEN the executable is started in `mcp` mode
- THEN startup MUST NOT silently fall back to module dispatch and MUST fail
- AND this behavior MUST be documented as a do-not-rename constraint

### Requirement: Intranet ProGet Publication

The system MUST publish release assets to the ACTSIS ProGet Asset Directory only from a `v*` tag push, only after the GitHub release, installer, and provenance jobs have succeeded. Publication MUST occur over an established NetBird tunnel using `NETBIRD_SETUP_KEY`, MUST authenticate to ProGet with `PROGET_API_KEY`, MUST tear the tunnel down when the job ends regardless of outcome, and MUST serialize per version through a per-version concurrency group. If either secret is unavailable, the publish job MUST fail closed without publishing.

#### Scenario: Tag push publishes assets

- GIVEN a `vX.Y.Z` tag push and successful release, installer, and provenance jobs
- WHEN the publish job runs
- THEN each asset MUST be uploaded under the `outlook-mcp/<version>/` path in the configured ProGet Asset Directory using the ProGet API key
- AND an upload failure MUST fail the publish job

#### Scenario: Missing secrets fail closed

- GIVEN `NETBIRD_SETUP_KEY` or `PROGET_API_KEY` is not available
- WHEN the publish job runs
- THEN it MUST fail without uploading any asset

#### Scenario: NetBird tunnel is always torn down

- GIVEN a publish job run that succeeds or fails at any step
- WHEN the job concludes
- THEN the NetBird connection MUST be disconnected

#### Scenario: Same-version publications are serialized

- GIVEN a publish job for version `X.Y.Z` is in progress
- WHEN another run for the same version starts
- THEN the concurrency group MUST prevent interleaved partial publication

#### Scenario: Non-tag events never publish

- GIVEN a branch push or a pull request event
- WHEN the workflows run
- THEN nothing MUST be published to ProGet

#### Scenario: Upstream failure blocks publication

- GIVEN the GitHub release, an installer, or the provenance job failed
- WHEN the pipeline concludes
- THEN no asset MUST be published to ProGet

### Requirement: `latest-stable.json` Manifest

The system MUST generate a `latest-stable.json` manifest for each published release and overwrite it at `outlook-mcp/latest-stable.json` (not append or version it). The manifest MUST record the release version, a release date, a `notesUrl` pointing at the corresponding GitHub Release (`https://github.com/ACTSIS/outlook-mcp/releases/tag/v<version>`), and a list of assets where every entry carries a resolvable download URL and a SHA-256 checksum matching the published bytes.

#### Scenario: Manifest content is complete and accurate

- GIVEN a successfully published release
- WHEN `outlook-mcp/latest-stable.json` is read
- THEN it MUST contain the release version matching the tag
- AND a `notesUrl` equal to the corresponding GitHub Release URL
- AND an asset list where every entry has a URL and a SHA-256 checksum
- AND every listed URL MUST resolve to an asset published under `outlook-mcp/<version>/`

#### Scenario: Manifest reflects only the newest release

- GIVEN a `latest-stable.json` from a previous release
- WHEN a new release is published
- THEN the manifest MUST be replaced by one describing only the new release

#### Scenario: Manifest checksums verify

- GIVEN the SHA-256 checksums in the manifest
- WHEN they are recomputed over the downloaded assets
- THEN they MUST match exactly

#### Scenario: Manifest generation is unit-testable

- GIVEN SHA-256 checksums, a version, and a notes URL as inputs
- WHEN the manifest generator runs
- THEN the output MUST be deterministic and covered by automated tests

### Requirement: Public GitHub Release Channel Unchanged

The existing GitHub Release job MUST remain unchanged in trigger, content, and behavior: a `v*` tag push MUST produce a GitHub Release containing the two raw binaries with generated release notes. The public channel and the intranet channel MUST coexist, and a failure of the intranet publish job MUST NOT affect the published GitHub Release.

#### Scenario: GitHub Release output is preserved

- GIVEN a `v*` tag push that completes the existing jobs successfully
- WHEN the pipeline concludes
- THEN a GitHub Release MUST exist containing the two raw binaries and generated notes, identical in content to the pre-change release output

#### Scenario: ProGet failure does not affect the public channel

- GIVEN a `v*` tag push where the intranet publish job fails
- WHEN the pipeline concludes
- THEN the GitHub Release MUST still exist and be complete

### Requirement: Release Pipeline Integrity for Installers

The release pipeline MUST gate installer publication behind packaging and smoke verification. Installer jobs MUST depend on the existing build job. A smoke job MUST depend on the installer jobs and MUST verify, in a clean container environment, that the `.deb` can be installed, upgraded, removed, and purged and that the installed binary boots in both `mcp` and `auth` mode. A provenance job MUST produce SHA-256 checksums and an SBOM for the released assets. The publish job MUST depend on the GitHub release, the installer jobs, and the provenance job. A smoke failure MUST block publication.

#### Scenario: Failed build blocks installers

- GIVEN the build job failed
- WHEN the pipeline concludes
- THEN no installer artifacts MUST be produced or published

#### Scenario: Container smoke validates the `.deb`

- GIVEN installers built from a `v*` tag push
- WHEN the smoke job runs
- THEN the `.deb` MUST install, upgrade, remove, and purge cleanly in a container environment
- AND the installed binary MUST boot in `mcp` mode and serve `auth` mode
- AND a smoke failure MUST fail the pipeline before publication

#### Scenario: Provenance accompanies the release

- GIVEN a pipeline run that reaches the provenance job
- WHEN it completes
- THEN SHA-256 checksums and an SBOM MUST be produced covering the released assets

#### Scenario: Publication ordering is enforced

- GIVEN the release workflow
- WHEN the publish job's dependencies are inspected
- THEN it MUST depend on the GitHub release job, the installer jobs, and the provenance job

### Requirement: Workflow Secrets Policy

The automated workflow tests MUST continue to forbid OAuth client secrets in the release workflow while explicitly permitting the infrastructure secrets `NETBIRD_SETUP_KEY` and `PROGET_API_KEY`. The tests MUST include a positive assertion that the publish job consumes both permitted secrets.

#### Scenario: OAuth secrets remain forbidden

- GIVEN the release workflow file
- WHEN the workflow structure tests run
- THEN OAuth client secret references (`secrets.OUTLOOK_CLIENT_SECRET`, `secrets.MS_CLIENT_SECRET`, and their literal environment variable names) MUST be absent from the workflow

#### Scenario: Infrastructure secrets are allowed and consumed

- GIVEN the release workflow file
- WHEN the workflow structure tests run
- THEN `secrets.NETBIRD_SETUP_KEY` and `secrets.PROGET_API_KEY` MUST be permitted
- AND the publish job MUST be asserted to consume both

### Requirement: End-User Intranet Installation Documentation

The repository MUST document intranet installation for ACTSIS collaborators: Windows installation via the NSIS installer and Linux installation via the `.deb`. The documentation MUST state that credential configuration for installed binaries MUST use the MCP-client `env` block or Vault, because a `.env` file beside the installed executable is not user-writable, and MUST state the do-not-rename constraint on the installed executable.

#### Scenario: Intranet install steps are documented

- GIVEN the repository documentation
- WHEN an ACTSIS collaborator reads it
- THEN Windows installation steps via the installer and Linux installation steps via the `.deb` MUST be present
- AND the credential-configuration guidance for installed paths (MCP-client `env` block or Vault) MUST be present
- AND the do-not-rename constraint on the installed executable MUST be present
