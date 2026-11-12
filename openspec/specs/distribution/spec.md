# Distribution Specification

## Purpose

Define how outlook-mcp is packaged into native installers (`.deb` for Linux, NSIS for Windows), published to the same GitHub Releases channel as the raw binaries and Docker image archive, advertised through the `latest-stable.json` manifest, and documented for end users, and how the tested container image is published to the repository's GitHub Packages container registry (GHCR) so `docker pull` is the primary image channel. Publication consumes no credentials beyond the built-in `github.token`; there is no artifact server, tunnel, ProGet, or third-party registry. This spec covers product-true distribution behavior; tool-acquisition mechanisms, runner choices, and other implementation selections are design-phase concerns.

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

The release pipeline MUST append the Windows installer, the Linux `.deb`, `SHA256SUMS`, the release SBOM, and `latest-stable.json` to the SAME GitHub Release that already carries the raw binaries and the Docker image bundle. The publishing job MUST keep the generic job id `publish-artifacts`, MUST depend on the GitHub release, both installer, and the provenance jobs (the provenance job itself follows the installer smoke gate), and MUST serialize same-version publications through a ref-keyed concurrency group with `cancel-in-progress: false`. `contents: write` MUST be granted to exactly the GitHub release job and this publisher; every other job inside this workflow MUST stay `contents: read`. `packages: write` MUST be granted exclusively to the GHCR container publication job (and, at job level only, the reusable-caller job in the version workflow, because a called workflow can never exceed its caller); no workflow-level default and no other job may request it. The publisher MUST use no custom secrets: `GH_TOKEN` MUST be the built-in `github.token`, the reusable release workflow MUST declare no `secrets` inputs, and the version workflow caller MUST pass none. The target repository MUST come from the trusted `GITHUB_REPOSITORY` context and be passed explicitly (for example with `--repo` on every `gh` command) so publication can never fall back to a wrong remote or fork default. The publisher MUST read the target release version before uploading, MUST verify that every required asset exists and that the provenance checksum file matches the collected assets before uploading, and MUST NOT overwrite assets that already exist on the release (no `--clobber`).

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

### Requirement: End-User Installation Documentation (GitHub Releases and GHCR)

The repository MUST document installation from this repository's GitHub Releases for Windows (NSIS installer) and Linux (`.deb`), including the versioned release download URL, the `latest-stable.json` manifest URL that always resolves to the newest release, the release notes URL, and the presence of `SHA256SUMS` and the SBOM among the release assets. The documentation MUST present the container image pull (`docker pull ghcr.io/actsis/outlook-mcp:<version>` or `:latest`) as the primary image channel, distinguish the GitHub Packages channel from the Release-asset channel, document the `MCP_HTTP_IMAGE` production Compose override (`MCP_HTTP_IMAGE=ghcr.io/actsis/outlook-mcp:<version> docker compose -f compose.yaml up -d --no-build --pull always`), the preserved local `outlook-mcp-http:local` default plus loadable archive fallback, and the minimal literal-latest reverse-proxy production Compose (see below), and state honestly that a first GHCR package may be PRIVATE even for a public repository until a package owner confirms Public under the package's Package settings. The documentation MUST NOT require any artifact server request or NetBird connectivity from the user, and it MUST state that credential configuration for installed binaries uses the MCP-client `env` block or Vault because a `.env` file beside the installed executable is not user-writable, plus the do-not-rename constraint on the installed executable. It MUST NOT advertise GHCR or other registry credentials inside a client MCP JSON configuration, and it MUST NOT claim a per-agent Entra application registration.

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

#### Scenario: Container image pull and honest public visibility are documented

- GIVEN the repository documentation
- WHEN a user reads the container image sections
- THEN the GHCR pull commands for a version tag and `latest`, the `MCP_HTTP_IMAGE` production Compose override with `--no-build --pull always`, the preserved local/archive fallback, and the minimal literal-latest reverse-proxy production Compose MUST be present
- AND the Packages-versus-Releases channel distinction and the first-package-may-be-private Package settings confirmation MUST be stated without claiming anonymous pulls are proven

### Requirement: Minimal Reverse-Proxy Production Compose (Public GHCR Image)

The repository MUST ship `compose.production.yaml` as the generic, minimal production deployment shape a public-repo user can start without editing variables: it MUST carry the literal published image `ghcr.io/actsis/outlook-mcp:latest` with no `build:` section and no Compose `${...}` interpolation anywhere (no image and no published-port variables), a fixed `8444:8443` port mapping (fixed host port 8444 to the standard internal listener port 8443), the explicit `MCP_HTTP_REVERSE_PROXY_HTTP=true` reverse-proxy opt-in with the canonical public `https://` origin `https://outlook-mcp.actsis.internal` and its exact `https://outlook-mcp.actsis.internal/login/callback` Entra Web redirect under the forced `MCP_HTTP_AUTH_MODE=bridge` central login, empty `MCP_HTTP_TLS_CERT`/`MCP_HTTP_TLS_KEY` Compose-environment overrides that guarantee no accidental TLS, no build and no certificate mount, the same durable `bridge_oauth_prod` mounted volume at `/app/data/oauth` with the same store directory as the TLS deployment, the same hardened container posture (read-only root filesystem, `/tmp` tmpfs, dropped capabilities, no-new-privileges, exactly one replica), and an optional `.env.docker` env_file as the ONLY runtime source of Entra identifiers, secrets, and external MCP client registrations (no credentials baked into the Compose file itself, no new provider credentials, and no per-agent Entra applications). The documentation MUST present this as the external-reverse-proxy deployment shape — client TLS terminates on the operator's reverse proxy, which may be a different server, and forwards to `http://<this-server>:8444` — and MUST state that protection of the plaintext HTTP upstream hop is the operator's responsibility. The older direct-TLS production shape and the local development Compose configurations stay unchanged, and the minimal file MUST stay comment-free so it reads as a small starting point, not a guide.

#### Scenario: The production Compose stays minimal on the literal published image

- GIVEN `compose.production.yaml`
- WHEN it is parsed
- THEN it carries the literal `ghcr.io/actsis/outlook-mcp:latest` image, no build section, no `${...}` interpolation, no comment lines, the fixed `8444:8443` mapping, the exact reverse-proxy flag and HTTPS origin/callback values, the empty TLS overrides, the durable store mount, and the hardened posture

#### Scenario: Runtime credentials stay outside the Compose file

- GIVEN an operator copying the documented dummy sample to `.env.docker`
- WHEN the deployment starts
- THEN the Compose environment carries no Entra identifier or secret, the optional env_file remains the only runtime source, and no new provider credential or per-agent application is introduced

### Requirement: Docker Image Build and Release Archive

The release pipeline MUST produce a loadable Docker image archive for linux/amd64 as a GitHub Release artifact. The image MUST be built by the dedicated `docker-image` job from the committed Dockerfile at the exact release ref, tagged with the validated release version and the `local` tag referenced by the Compose configurations, labeled with `org.opencontainers.image.source` (from the trusted `GITHUB_SERVER_URL`/`GITHUB_REPOSITORY` context), `org.opencontainers.image.version`, and `org.opencontainers.image.revision` (from `git rev-parse HEAD` of the exact release checkout — never a caller-provided `github.sha`) at the ORIGINAL build, before any archive or registry publication exists, gated behind the build, validation, and secret-scan jobs (the shared `build/secret-scan.js` detector MUST stay fail-closed on embedded credential patterns, suppressing only a bare PEM header that appears verbatim and alone inside quotes as the sole argument of an `indexOf` format comparison, while plain, assigned, truncated, split, and full private-key markers and any secret assignment elsewhere on the same line remain flagged), and uploaded under the unique Actions artifact name `docker-image` (which must never match the `artifact-*` or `installer-*` wildcards the provenance, publisher, and container publication jobs download). The release job MUST wait for the image job, verify the archive against its SHA-256 sidecar, and attach both files to the GitHub Release. The `SHA256SUMS` payload and the `latest-stable.json` manifest MUST list exactly the pre-established four product assets, and the publisher MUST NOT re-upload the Docker bundle. The archive REMAINS attached to the Release as the fallback for hosts that cannot pull from a registry; the primary image channel is the GHCR publication defined below.

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

#### Scenario: Registry publication starts only from the container publication job

- GIVEN the release workflow file
- WHEN its jobs, permissions, and scripts are inspected
- THEN the `docker-image` job MUST NOT push the image to any container registry or request `packages: write`
- AND only the GHCR container publication job defined below may push, and the `docker-image` Actions artifact name MUST NOT match the `artifact-*` or `installer-*` download wildcards of the provenance, publisher, and container publication jobs
- AND the `SHA256SUMS` payload and manifest assets MUST remain the original four-asset set without the image

#### Scenario: Provenance labels are built in and verified before publication

- GIVEN a `v*` tag push that passes build, validation, and secret scan
- WHEN the image is built
- THEN the OCI `source`, `version`, and `revision` labels MUST exist on the built image before the archive is saved, with the revision label taken from the checked-out release ref via `git rev-parse HEAD`
- AND the publication job MUST verify the image command is exactly `node bin/m365-mcp.js http` and that the source and version labels match the trusted repository context and release version before any login or push

#### Scenario: End users can load and run the image

- GIVEN the repository documentation
- WHEN a user reads the Docker artifact section
- THEN it MUST state the archive and sidecar names, the linux/amd64 platform, checksum verification from the download directory, the load command (`gzip -dc outlook-mcp-docker-image.tar.gz | docker load`), starting Compose with `--no-build --pull never` against the loaded `local` tag
- AND it MUST state that no runtime configuration is baked into the image and that persistence lives on the named volume
- AND it MUST state that the archive appears only after a tagged Release run, that the primary pull channel is the GHCR image, and that the GHCR package lives in Packages rather than among Release assets

### Requirement: GHCR Container Publication (GitHub Packages)

A dedicated `publish-container` job MUST publish the tested image to the repository-linked GHCR namespace after the full publication chain (release, installers publisher, provenance) succeeds. It MUST hold exactly `contents: read` plus `packages: write`, and — because a called workflow can never exceed its caller — the reusable release-caller job in the version workflow MUST also declare `packages: write` at job level only; no workflow-level default, no version-bump job, and no CI or pull-request job MAY carry it. The job MUST depend on the exact `docker-image` artifact, MUST verify its SHA-256 sidecar before any load or login, MUST load the archive without rebuilding (the SAME tested image, never a registry-job rebuild), and MUST refuse publication when the loaded image command is not exactly `node bin/m365-mcp.js http` or when the source or version OCI labels do not match the trusted repository context and release version. It MUST log in ONLY to `ghcr.io` with the built-in `github.token` passed through `--password-stdin` for the `GITHUB_ACTOR` username (never as a command argument or in logs) from an isolated `DOCKER_CONFIG` directory under `RUNNER_TEMP` created with `umask 077`, with no namespace or credential fallback when access is denied. The version tag MUST be pushed first on the canonical `ghcr.io/<lowercase GITHUB_REPOSITORY>` image after an immutability preflight: an existing version manifest whose config digest matches the local image id is an idempotent skip, a different digest or an unknown manifest schema MUST fail the job, and ONLY a proven manifest-not-found is a new publication; authentication, permission, and network errors MUST NOT be classified as absent. `latest` MUST be pushed only when the pushed `RELEASE_TAG` equals the trusted `gh api repos/$GITHUB_REPOSITORY/releases/latest --jq .tag_name`, so an old version may re-publish its version tag without advancing latest. Publication MUST be serialized through a concurrency group keyed by the repository (not the ref) with `cancel-in-progress: false`. Because GitHub starts a first package PRIVATE even for a public repository and no documented visibility mutation exists, the job MUST record a step summary stating that visibility is NOT proven and pointing a package owner at the package's Package settings for the one-time Public confirmation, and MUST NOT claim anonymous pulls work before they are proven.

#### Scenario: Permission allowlist

- GIVEN the release workflow, the version workflow, and the CI workflow
- WHEN their permissions are inspected
- THEN `packages: write` MUST appear on exactly the `publish-container` job and the reusable caller job
- AND the workflow-level defaults, the version job, and every CI/pull-request job MUST stay free of `packages: write`

#### Scenario: The registry job consumes the exact tested archive

- GIVEN a successful docker-image job
- WHEN the container publication job runs
- THEN it MUST download the `docker-image` artifact, verify its sidecar checksum before loading or logging in, load the gzipped archive with `docker load`, and never run a build, commit, or import in the registry job

#### Scenario: Command and provenance verification precedes login

- GIVEN a loaded image
- WHEN the publication job verifies it
- THEN a image command other than `[["node","bin/m365-mcp.js","http"]]`, a foreign source label, or a mismatched version label MUST fail the job before login and before any push

#### Scenario: Login isolation

- GIVEN the publication job
- WHEN it authenticates
- THEN the login MUST target ghcr.io only, pass the built-in token exclusively through stdin (`--password-stdin`), write credentials under an isolated `DOCKER_CONFIG` in `RUNNER_TEMP` with umask 077, and never echo the token or fall back to another namespace or credential on denial

#### Scenario: Version tags are immutable for different images

- GIVEN a version tag already present in the registry
- WHEN the preflight inspect finds a config digest that matches the local image id
- THEN the version push MUST be skipped as idempotent
- AND a different digest or an unknown manifest schema MUST fail the job without pushing
- AND only a proven manifest-not-found response MUST be treated as a new publication; auth, denial, and network failures MUST fail the job instead

#### Scenario: Latest advances only for the current latest release

- GIVEN an old release re-publishing its versioned tag
- WHEN the trusted latest-release lookup returns a different tag
- THEN the version tag MUST still publish and `latest` MUST NOT be pushed
- AND a latest-lookup failure MUST fail the job closed instead of silently skipping or pushing

#### Scenario: Publication serializes per repository

- GIVEN concurrent publication runs in one repository
- WHEN the container publication jobs start
- THEN the concurrency group keyed by the repository MUST serialize them with `cancel-in-progress: false`

#### Scenario: Visibility honesty

- GIVEN any successful publication
- WHEN the job concludes
- THEN its step summary MUST state that package visibility is NOT proven and MUST point the package owner at the package's Package settings for the provider-owned Public confirmation
- AND the workflow MUST NOT claim anonymous pull access is guaranteed and MUST NOT attempt any package-visibility mutation
