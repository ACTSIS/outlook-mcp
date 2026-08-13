# OpenSpec Traceability and Errata

This document maps current canonical specifications to the archived changes that produced them. Archived artifacts are immutable historical evidence: corrections belong in canonical specs and in this errata, not in `openspec/changes/archive/`.

## Canonical Map

| Current domain       | Canonical specification                                                      | Primary implementation evidence                                    |
| -------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Graph authentication | [`specs/auth/spec.md`](specs/auth/spec.md)                                   | `outlook-auth-server.js`, `auth/token-storage.js`, `auth/tools.js` |
| Flow token lifecycle | [`specs/flow-token-management/spec.md`](specs/flow-token-management/spec.md) | `outlook-auth-server.js`, `auth/token-storage.js`                  |
| Power Automate tools | [`specs/power-automate/spec.md`](specs/power-automate/spec.md)               | `power-automate/` handlers and `flow-api.js`                       |

## Archived Change Lineage

| Archived change                                                                                                       | Durable contribution                                                              | Current canonical owner                                                          |
| --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [`2026-07-28-fix-persistent-auth`](changes/archive/2026-07-28-fix-persistent-auth/)                                   | Graph scope configuration, refresh, and status behavior                           | `auth`                                                                           |
| [`2026-07-29-migrate-power-automate-token-storage`](changes/archive/2026-07-29-migrate-power-automate-token-storage/) | Flow-prefixed storage in TokenStorage and migration of five handlers              | `flow-token-management`; functional handler behavior belongs to `power-automate` |
| [`2026-07-29-add-flow-token-auto-refresh`](changes/archive/2026-07-29-add-flow-token-auto-refresh/)                   | Conditional Flow refresh, independent deduplication, and rotation                 | `flow-token-management`                                                          |
| [`2026-07-29-add-flow-token-initial-acquisition`](changes/archive/2026-07-29-add-flow-token-initial-acquisition/)     | `/auth/flow`, `authenticate-flow`, callback persistence, and acquisition guidance | `auth`, `flow-token-management`, and `power-automate`                            |

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

## Known Implementation Gaps

These gaps are tracked here to keep the canonical requirements honest without converting defects into required behavior:

| Gap                                                                               | Impact                                                                            | Desired invariant                                                                |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Initial Graph re-authentication raw-writes the token response                     | Existing `flow_*` keys can be erased                                              | Resource-specific writes preserve the other resource's credentials               |
| Graph refresh failure nulls the shared object before persistence                  | Flow state is lost in memory while stale disk data can survive                    | Permanent/transient policy is explicit and invalidation is persisted selectively |
| TokenStorage-only environment overrides differ from productive acquisition config | Initial auth and refresh can use inconsistent scopes, redirect URIs, or endpoints | Productive acquisition and refresh share one resolved configuration              |
| `authenticate.force` is advertised but ignored                                    | Callers cannot request enforced re-authentication                                 | Implement the argument or remove it from the public schema                       |
| Flow test authentication creates Graph-shaped test tokens                         | Test-mode success does not prove productive Flow credential behavior              | Create Flow-shaped fixtures or state the narrower simulation contract            |

## Maintenance Rule

When a future change modifies these behaviors:

1. Update the owning canonical domain, not an unrelated specification.
2. Preserve existing archive content.
3. Add lineage here only when synchronization or naming needs explanation.
4. Verify requirements against current code and tests before declaring archive synchronization complete.
