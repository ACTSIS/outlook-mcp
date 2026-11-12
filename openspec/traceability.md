# OpenSpec Traceability and Errata

This document maps current canonical specifications to the archived changes that produced them. Archived artifacts are immutable historical evidence: corrections belong in canonical specs and in this errata, not in `openspec/changes/archive/`.

## Canonical Map

| Current domain        | Canonical specification                                                      | Primary implementation evidence                                             |
| --------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Graph authentication  | [`specs/auth/spec.md`](specs/auth/spec.md)                                   | `outlook-auth-server.js`, `auth/token-storage.js`, `auth/tools.js`          |
| Flow token lifecycle  | [`specs/flow-token-management/spec.md`](specs/flow-token-management/spec.md) | `outlook-auth-server.js`, `auth/token-storage.js`                           |
| Power Automate tools  | [`specs/power-automate/spec.md`](specs/power-automate/spec.md)               | `power-automate/` handlers and `flow-api.js`                                |
| SharePoint site tools | [`specs/sharepoint/spec.md`](specs/sharepoint/spec.md)                       | `sites/` handlers (`list-sites`, `list-site-files`, `download-site-file`)   |
| OneDrive file tools   | [`specs/onedrive/spec.md`](specs/onedrive/spec.md)                           | `onedrive/` handlers (`upload`, `upload-large`, `download`)                 |
| Remote HTTP auth      | [`specs/remote-auth/spec.md`](specs/remote-auth/spec.md)                     | `remote/http-server.js`, `remote/entra-auth.js`, `remote/oauth-provider.js` |
| Distribution          | [`specs/distribution/spec.md`](specs/distribution/spec.md)                   | `.github/workflows/release.yml`, `build/release-manifest.js`                |

## Archived Change Lineage

| Archived change                                                                                                       | Durable contribution                                                                            | Current canonical owner                                                          |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [`2026-07-28-fix-persistent-auth`](changes/archive/2026-07-28-fix-persistent-auth/)                                   | Graph scope configuration, refresh, and status behavior                                         | `auth`                                                                           |
| [`2026-07-29-migrate-power-automate-token-storage`](changes/archive/2026-07-29-migrate-power-automate-token-storage/) | Flow-prefixed storage in TokenStorage and migration of five handlers                            | `flow-token-management`; functional handler behavior belongs to `power-automate` |
| [`2026-07-29-add-flow-token-auto-refresh`](changes/archive/2026-07-29-add-flow-token-auto-refresh/)                   | Conditional Flow refresh, independent deduplication, and rotation                               | `flow-token-management`                                                          |
| [`2026-07-29-add-flow-token-initial-acquisition`](changes/archive/2026-07-29-add-flow-token-initial-acquisition/)     | `/auth/flow`, `authenticate-flow`, callback persistence, and acquisition guidance               | `auth`, `flow-token-management`, and `power-automate`                            |
| [`2026-09-15-add-email-date-filter`](changes/archive/2026-09-15-add-email-date-filter/)                               | Date-filtered listing and search, `count=0` sweep semantics, and the `$search` 1,000-result cap | `email`                                                                          |

## Canonicalization Errata

### Flow token domain was published under the wrong name

The migration archive contains `specs/flow-token-management/spec.md`, but its archive report records that delta as a newly created canonical `power-automate` spec. That made a storage/lifecycle specification appear to be the product-tool contract.

**Resolution:** `specs/flow-token-management/spec.md` now owns token lifecycle. `specs/power-automate/spec.md` now owns the five MCP tools and their user-visible behavior.

### Auto-refresh synchronization was incomplete

The auto-refresh archive reports that its delta was merged into `auth`, while the old canonical `power-automate` document continued to require **No Flow Auto-Refresh**. The repository implementation and tests use conditional auto-refresh.

**Resolution:** the contradictory no-refresh requirement is superseded by `flow-token-management` requirements for conditional refresh, independent `_flowRefreshPromise` deduplication, refresh-token rotation, and selective permanent-failure invalidation.

### Initial-acquisition Power Automate delta was omitted

The initial-acquisition archive contains both an `auth` delta and a `power-automate` delta, but its archive report lists only `auth` as synchronized. The Power Automate guidance was therefore absent from the canonical product contract.

**Resolution:** missing-credential behavior and operational guidance are represented in the canonical `power-automate` spec, while acquisition mechanics remain in `auth` and `flow-token-management`.

### Callback routing description diverged from the implementation

The initial-acquisition delta described Flow detection by inspecting the token response `scope`. Its design, implementation, and tests instead pass an `isFlow` intent derived from server-side CSRF state metadata.

**Resolution:** canonical auth and Flow-token specs require routing by stored state metadata. Response-scope detection is historical wording, not current behavior.

### The remote HTTP authentication work was first documented only in README/docs

The intranet HTTP listener (delegated Entra identity on `remote/http-server.js`) shipped with user-facing documentation only, so its mode-selector, discovery-metadata, and stateless-validation requirements had no canonical specification owner and the local stdio `auth` spec was wrongly implied to cover them.

**Resolution:** `specs/remote-auth/spec.md` now owns remote HTTP authentication (the `MCP_HTTP_AUTH_MODE=entra|bridge` selector semantics, direct-Entra discovery/challenge metadata with resource-qualified scopes, legacy bridge metadata preservation, and the stateless bearer boundary). The local `auth` spec keeps owning stdio acquisition and refresh only.

### The intranet ProGet distribution was replaced by GitHub-only publication

The `2026-09-07-add-intranet-distribution` archive documents publishing installer assets, `SHA256SUMS`, an SBOM, and `latest-stable.json` to the ACTSIS ProGet Asset Directory over NetBird with the `NETBIRD_SETUP_KEY` and `PROGET_API_KEY` secrets. The user later directed GitHub-only distribution; canonical `specs/distribution/spec.md` now owns the GitHub Release publisher (`publish-artifacts`), the repository-parameterized `build/release-manifest.js` generator, and the secrets-free publication contract. The archives remain unmodified.

### The first GHCR correction superseded the artifact-only Docker assumption

The v2.4.5 GitHub-only delivery was interpreted as covering the Docker image, but the repository's Packages page was empty while the Release carried only a tar.gz archive: an asset, not a registry package. The artifact-only no-registry assumption in `specs/distribution/spec.md` was therefore wrong for the container channel, and the user later selected «Pública — docker pull sin login». Canonical `specs/distribution/spec.md` now owns the container publication: OCI provenance labels with a `git rev-parse HEAD` revision at the original build, a `publish-container` job that loads the exact tested `docker-image` artifact, scoped `packages: write` on that job plus the reusable caller job in the version workflow, an isolated stdin-only ghcr.io login, the immutable version-tag preflight, the trusted latest-release guard, per-repository serialization, and honest first-package-private visibility guidance. This is a canonical-spec correction, not an archive edit; no ProGet/NetBird return, no new secrets or PAT, and no package-visibility mutation.

### The production pull-only Compose moved to the reverse-proxy HTTP shape

The `2026-09` pull-only production Compose work first shipped a pinned-version (`${MCP_HTTP_IMAGE:-ghcr.io/actsis/outlook-mcp:2.4.7}`) direct-TLS deployment with a certificate mount and interpolated published host/port. The user then directed the generic public-repo shape: the literal `:latest` GHCR image, no interpolation at all, a fixed `8444:8444` plain HTTP listener under the explicit `MCP_HTTP_REVERSE_PROXY_HTTP=true` opt-in with the canonical public `https://outlook-mcp.actsis.internal` origin, and TLS termination on an external reverse proxy on another server, with the plaintext upstream hop as the operator's responsibility. Canonical `specs/distribution/spec.md` now owns that minimal production Compose, `specs/remote-auth/spec.md` owns the reverse-proxy transport opt-in, and the older TLS-era descriptions remain as historical evidence in the archived changelog only.

## Known Implementation Gaps

These gaps are tracked here to keep the canonical requirements honest without converting defects into required behavior:

| Gap                                                              | Impact                                                               | Desired invariant                                                                |
| ---------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Initial Graph re-authentication raw-writes the token response    | Existing `flow_*` keys can be erased                                 | Resource-specific writes preserve the other resource's credentials               |
| Graph refresh failure nulls the shared object before persistence | Flow state is lost in memory while stale disk data can survive       | Permanent/transient policy is explicit and invalidation is persisted selectively |
| `authenticate.force` is advertised but ignored                   | Callers cannot request enforced re-authentication                    | Implement the argument or remove it from the public schema                       |
| Flow test authentication creates Graph-shaped test tokens        | Test-mode success does not prove productive Flow credential behavior | Create Flow-shaped fixtures or state the narrower simulation contract            |

## Maintenance Rule

When a future change modifies these behaviors:

1. Update the owning canonical domain, not an unrelated specification.
2. Preserve existing archive content.
3. Add lineage here only when synchronization or naming needs explanation.
4. Verify requirements against current code and tests before declaring archive synchronization complete.
