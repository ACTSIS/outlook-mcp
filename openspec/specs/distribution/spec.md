# Distribution Specification

## Purpose

Define how outlook-mcp is packaged into native installers (`.deb` for Linux, NSIS for Windows), published to the same GitHub Releases channel as the raw binaries and Docker bundle, advertised through the `latest-stable.json` manifest, and documented for end users. Distribution is GitHub-only: there is no artifact server, tunnel, or registry channel, and publication consumes no credentials beyond the built-in `github.token`. This spec covers product-true distribution behavior; tool-acquisition mechanisms, runner choices, and other implementation selections are design-phase concerns.

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

### Requirement: GitHub Release Publication of Installers and Provenance

The release pipeline MUST append the Windows installer, the Linux `.deb`, `SHA256SUMS`, the release SBOM, and `latest-stable.json` to the SAME GitHub Release that already carries the raw binaries and the Docker image bundle. The publishing job MUST keep the generic job id `publish-artifacts`, MUST depend on the GitHub release, both installer, and the provenance jobs (the provenance job itself follows the installer smoke gate), and MUST serialize same-version publications through a ref-keyed concurrency group with `cancel-in-progress: false`. `contents: write` MUST be granted to exactly the GitHub release job and this publisher; every other job MUST stay `contents: read`, and no registry or package permission may be requested. The publisher MUST use no custom secrets: `GH_TOKEN` MUST be the built-in `github.token`, the reusable release workflow MUST declare no `secrets` inputs, and the version workflow caller MUST pass none. The target repository MUST come from the trusted `GITHUB_REPOSITORY` context and be passed explicitly (for example with `--repo` on every `gh` command) so publication can never fall back to a wrong remote or fork default. The publisher MUST read the target release version before uploading, MUST verify that every required asset exists and that the provenance checksum file matches the collected assets before uploading, and MUST NOT overwrite assets that already exist on the release (no `--clobber`).

#### Scenario: Tag push appends the missing assets

- GIVEN a `vX.Y.Z` tag push and successful release, installer, and provenance jobs
- WHEN the publisher job runs
- THEN `outlook-mcp-setup.exe`, the versioned `.deb`, `SHA256SUMS`, `outlook-mcp-<version>-sbom.spdx.json`, and `latest-stable.json` MUST appear on the GitHub Release
- AND the binaries and Docker bundle attached by the release job MUST NOT be re-uploaded

#### Scenario: Required assets and checksums are verified before upload

- GIVEN collected artifacts that are missing an expected file or disagree with `SHA256SUMS`
- WHEN the publisher job runs its verification step
- THEN it MUST fail before uploading any asset

#### Scenario: Target release version is read before upload

- GIVEN the publisher job start
- WHEN it prepares to upload
- THEN it MUST resolve the target release for the pushed tag and fail if that release (and version) does not exist

#### Scenario: Existing assets are never overwritten

- GIVEN an asset that already exists on the target release
- WHEN the publisher uploads without `--clobber`
- THEN the upload MUST fail rather than replace the existing asset

#### Scenario: No custom secrets are declared or consumed

- GIVEN the release workflow file and its version workflow caller
- WHEN their `workflow_call` declarations and call payloads are inspected
- THEN no `secrets:` block MUST be declared or passed
- AND the only credential used by the publisher MUST be `${{ github.token }}`

#### Scenario: Publication is serialized per version

- GIVEN a publisher run for version `X.Y.Z` in progress
- WHEN another run for the same version starts
- THEN the ref-keyed concurrency group MUST prevent interleaved publication

#### Scenario: Non-tag events never publish

- GIVEN a branch push or a pull request event
- WHEN the workflows run
- THEN nothing MUST be published

#### Scenario: Upstream failure blocks publication

- GIVEN the GitHub release, an installer, or the provenance job failed
- WHEN the pipeline concludes
- THEN the publisher MUST NOT run and no asset MUST be appended

### Requirement: `latest-stable.json` Manifest

The system MUST generate a `latest-stable.json` manifest for each published release and attach it to that release as a release asset. The manifest MUST record the release version, a release date, a `notesUrl` pointing at the corresponding GitHub Release (`https://github.com/<owner>/<repo>/releases/tag/v<version>`), and an ordered list of assets where every entry carries its name, the GitHub Releases download URL (`https://github.com/<owner>/<repo>/releases/download/v<version>/<asset>`), and a SHA-256 checksum matching the published bytes. The stable `https://github.com/<owner>/<repo>/releases/latest/download/latest-stable.json` URL MUST always resolve to the newest published release's manifest. The manifest generator MUST be a pure, unit-testable function that takes the target repository instead of any artifact-server configuration, and it MUST refuse v-prefixed or malformed versions, missing or malformed repositories, traversal-sensitive asset names, missing checksums, and malformed checksum lines so no bad download links can be produced.

#### Scenario: Manifest content is complete and accurate

- GIVEN a successfully published release
- WHEN the release's `latest-stable.json` is read
- THEN it MUST contain the release version matching the tag
- AND a `notesUrl` equal to the corresponding GitHub Release URL
- AND an asset list where every entry has a name, a URL, and a SHA-256 checksum
- AND every listed URL MUST resolve to a release asset under `releases/download/v<version>/`

#### Scenario: Latest URL reflects the newest release

- GIVEN a `latest-stable.json` from a previous release
- WHEN a new release is published with its own manifest asset
- THEN the `/releases/latest/download/latest-stable.json` URL MUST resolve to the manifest describing only the new release

#### Scenario: Manifest checksums verify

- GIVEN the SHA-256 checksums in the manifest
- WHEN they are recomputed over the downloaded assets
- THEN they MUST match exactly

#### Scenario: Manifest generation is unit-testable and fail-closed

- GIVEN SHA-256 checksums, a version, a notes URL, and the target repository as inputs
- WHEN the manifest generator runs
- THEN the output MUST be deterministic, covered by automated tests, and identical in schema to the pre-migration manifest
- AND v-prefixed versions, malformed versions or repositories, traversal-sensitive asset names, missing checksums, and malformed checksum lines MUST be refused

#### Scenario: No artifact-server configuration is accepted

- GIVEN the migrated manifest generator
- WHEN a caller supplies artifact-server configuration instead of a repository
- THEN generation MUST fail with a repository guidance error

### Requirement: Single GitHub Release Channel (binaries, Docker image bundle, installers, provenance, manifest)

The `v*` tag push trigger, the gating behavior, and the generated release notes of the existing GitHub Release job MUST remain unchanged. A successful `v*` tag push MUST produce one GitHub Release containing the two raw binaries with generated release notes, the loadable Docker image archive and its SHA-256 sidecar, and — appended by the `publish-artifacts` publisher — the installer, checksum, SBOM, and manifest assets. There is no separate intranet channel, and publication MUST NOT modify or overwrite previously published release assets.

#### Scenario: GitHub Release output is preserved and extended

- GIVEN a `v*` tag push that completes the release and publisher jobs successfully
- WHEN the pipeline concludes
- THEN a GitHub Release MUST exist containing the two raw binaries, generated notes, the Docker image archive with its SHA-256 sidecar, and the five appended installer/provenance/manifest assets
- AND the binary and Docker assets published by the release job MUST be identical in content to the pre-migration release output

#### Scenario: Existing release assets are immutable to the publisher

- GIVEN a completed release with assets already attached
- WHEN the publisher runs
- THEN it MUST append only the missing assets and MUST NOT alter any existing asset

### Requirement: Release Pipeline Integrity for Installers

The release pipeline MUST gate installer publication behind packaging and smoke verification. Installer jobs MUST depend on the existing build job. A smoke job MUST depend on the installer jobs and MUST verify, in a clean container environment, that the `.deb` can be installed, upgraded, removed, and purged and that the installed binary boots in both `mcp` and `auth` mode. A provenance job MUST produce SHA-256 checksums and an SBOM for the four released product assets. The publisher job MUST depend on the GitHub release, the installer jobs, and the provenance job. A smoke failure MUST block publication.

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
- WHEN the publisher job's dependencies are inspected
- THEN it MUST depend on the GitHub release job, the installer jobs, and the provenance job

### Requirement: Workflow Secrets Policy (GitHub-only publication)

The automated workflow tests MUST forbid ALL custom secrets in the release workflow: the reusable workflow MUST declare no `secrets` inputs, the version workflow caller MUST pass none, and no `secrets.*` reference may appear anywhere in the workflow. The only allowed credential is the built-in `github.token` wherever `GH_TOKEN` is set. The former infrastructure-secret allowlist for the removed ProGet/NetBird publisher is intentionally retired; the OAuth client secrets remain forbidden as before.

#### Scenario: No custom secrets are declared or consumed

- GIVEN the release workflow file and its version workflow caller
- WHEN the workflow structure tests run
- THEN `workflow_call.secrets` MUST be absent from the release workflow and the caller's call payload
- AND literal `NETBIRD_SETUP_KEY`, `PROGET_API_KEY`, `OUTLOOK_CLIENT_SECRET`, and `MS_CLIENT_SECRET` references MUST be absent

#### Scenario: The built-in token is the only credential

- GIVEN any `GH_TOKEN` environment entry in the release workflow
- WHEN the workflow structure tests run
- THEN its value MUST be `${{ github.token }}`

### Requirement: End-User Installation Documentation (GitHub Releases)

The repository MUST document installation from this repository's GitHub Releases for Windows (NSIS installer) and Linux (`.deb`), including the versioned release download URL, the `latest-stable.json` manifest URL that always resolves to the newest release, the release notes URL, and the presence of `SHA256SUMS` and the SBOM among the release assets. The documentation MUST NOT require any artifact server request or NetBird connectivity from the user, and it MUST state that credential configuration for installed binaries uses the MCP-client `env` block or Vault because a `.env` file beside the installed executable is not user-writable, plus the do-not-rename constraint on the installed executable.

#### Scenario: GitHub Releases install steps are documented

- GIVEN the repository documentation
- WHEN a user reads the installation section
- THEN Windows installation steps via the NSIS installer and Linux installation steps via the `.deb` MUST be present
- AND the versioned download URL, the `latest-stable.json` manifest URL, and the release notes URL MUST be documented

#### Scenario: Checksums and SBOM presence are documented

- GIVEN the repository documentation
- WHEN a user reads the release asset description
- THEN `SHA256SUMS` and the SBOM asset name pattern MUST be documented

#### Scenario: Credential guidance and rename constraint are preserved

- GIVEN the repository documentation
- WHEN a user reads the credential and executable-name sections
- THEN the MCP-client `env` block / Vault guidance and the do-not-rename constraint MUST be present
- AND neither section MUST require an artifact server or NetBird

### Requirement: Downloadable Docker Image Artifact (GitHub-only channel)

The release pipeline MUST produce a loadable Docker image archive for linux/amd64 as a GitHub Release artifact, and ONLY there: the pipeline MUST NOT push the image to any container registry and MUST NOT request registry write permissions or consume any new secrets. The image MUST be built by the dedicated `docker-image` job from the committed Dockerfile at the exact release ref, tagged with the validated release version and the `local` tag referenced by the Compose configurations, gated behind the build, validation, and secret-scan jobs (the shared `build/secret-scan.js` detector MUST stay fail-closed on embedded credential patterns, suppressing only a bare PEM header that appears verbatim and alone inside quotes as the sole argument of an `indexOf` format comparison, while plain, assigned, truncated, split, and full private-key markers and any secret assignment elsewhere on the same line remain flagged), and uploaded under the unique Actions artifact name `docker-image` (which must never match the `artifact-*` or `installer-*` wildcards the provenance and publisher jobs download). The release job MUST wait for the image job, verify the archive against its SHA-256 sidecar, and attach both files to the GitHub Release. The `SHA256SUMS` payload and the `latest-stable.json` manifest MUST list exactly the pre-established four product assets, and the publisher MUST NOT re-upload the Docker bundle.

#### Scenario: Tag-bound loadable image

- GIVEN a `v*` tag push that passes build, validation, and secret scan
- WHEN the `docker-image` job runs
- THEN it MUST check out the exact release ref, build the committed Dockerfile on linux/amd64, and tag the image `outlook-mcp-http:<version>` (tag version equal to `package.json` version) and `outlook-mcp-http:local` before anything is uploaded
- AND a tag that does not match the package version MUST fail the job closed

#### Scenario: Loadable archive with checksums

- GIVEN a successfully built image
- WHEN the image is packaged
- THEN it MUST be archived with `docker image save` (never `docker export`) into a gzipped archive named `outlook-mcp-docker-image.tar.gz` with a `outlook-mcp-docker-image.tar.gz.sha256` sidecar
- AND a build, save, gzip, or checksum failure MUST fail the upload job closed
- AND `docker load` of the archive MUST restore both tags

#### Scenario: Release attachment is gated and verified

- GIVEN the `docker-image` job uploaded its bundle
- WHEN the release job runs
- THEN it MUST download the bundle under its exact artifact name, verify the SHA-256 sidecar, and attach the archive and the sidecar to the GitHub Release alongside the two original binaries

#### Scenario: GitHub-only distribution is preserved

- GIVEN the release workflow file
- WHEN its jobs and permissions are inspected
- THEN no job MUST push to a container registry or request `packages:write`
- AND the `docker-image` Actions artifact name MUST NOT match the `artifact-*` or `installer-*` download wildcards of the provenance and publisher jobs
- AND the `SHA256SUMS` payload and manifest assets MUST remain the original four-asset set without the image

#### Scenario: End users can load and run the image

- GIVEN the repository documentation
- WHEN a user reads the Docker artifact section
- THEN it MUST state the archive and sidecar names, the linux/amd64 platform, checksum verification from the download directory, the load command (`gzip -dc outlook-mcp-docker-image.tar.gz | docker load`), starting Compose with `--no-build --pull never` against the loaded `local` tag
- AND it MUST state that no runtime configuration is baked into the image and that persistence lives on the named volume
- AND it MUST state that the artifact appears only after a tagged Release run and is not distributed through any registry pull channel
