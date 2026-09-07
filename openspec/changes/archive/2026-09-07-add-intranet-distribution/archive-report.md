# SDD Archive Report: add-intranet-distribution

**Date**: 2026-09-07
**Status**: archived (PASS)
**Archive path**: `openspec/changes/archive/2026-09-07-add-intranet-distribution/`
**Final state**: `main` at `61a651d` (tracker PR #1 merged; full feature on main)

## Executive Summary

The `add-intranet-distribution` change is fully implemented, verified, and archived. It adds intranet distribution of outlook-mcp to the ACTSIS ProGet Asset Directory over NetBird: native installers (`.deb` for Linux, NSIS for Windows), a container smoke gate, provenance (SHA256SUMS + SBOM), a `latest-stable.json` manifest, and end-user intranet install documentation — while keeping the public GitHub Releases channel byte-for-byte unchanged. Verification verdict: **PASS_WITH_WARNINGS** (`blockers: 0`, `critical_findings: 0`; 9/9 requirements, 28/28 scenarios). Full suite at integration: **557 tests / 38 suites green**; `npm run lint` and `npm run format:check` green.

## Verification Verdict

| Field             | Value                                                                     |
| ----------------- | ------------------------------------------------------------------------- |
| Verdict           | **PASS_WITH_WARNINGS**                                                    |
| Blockers          | 0                                                                         |
| Critical findings | 0                                                                         |
| Requirements      | 9/9                                                                       |
| Scenarios         | 28/28                                                                     |
| Tests             | 557/557 (38 suites), exit 0                                               |
| Lint / format     | `npm run lint` green; `npm run format:check` green                        |
| Evidence revision | `sha256:496196adfd015656e63850273bf649d1003205dcf196f883b713c98a5a86f6d3` |

## Lineage (integration)

- **Five chained child PRs** (ACTSIS/outlook-mcp #2–#6), strategy **feature-branch-chain**, matching the five planned work-unit boundaries:
  - PR 1 — manifest module (`build/proget-manifest.js` + tests)
  - PR 2 — Linux packaging + smoke harness (`build/linux/`)
  - PR 3 — Windows NSIS (`build/windows/installer.nsi`)
  - PR 4 — workflow jobs + re-scoped secrets test (ATOMIC: `release.yml` + `release-workflow.test.js` in one commit `c5ebb6b`)
  - PR 5 — README/docs (intranet install section + glibc correction)
- **Integration merge** `e45848e` merged the chain terminus (`feat/intranet-distribution-05-docs`) into the tracker after cascade interleaving left the tracker with only PR 1's unit.
- **Tracker PR #1** merged to `main` as `61a651d` — full feature now on main.
- Verification ran at chain terminus `4741065` (all five work units present); final state on main is `61a651d`.

## Specs Synced (canonical promotion)

| Domain         | Action      | Details                                                                                                                                                                                  |
| -------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `distribution` | **Created** | New canonical domain spec at `openspec/specs/distribution/spec.md` — full-domain copy of the change spec (9 requirements, 28 scenarios), byte-identical to `specs/distribution/spec.md`. |

### Requirement names (all ADDED — new capability, no MODIFIED/REMOVED)

1. Linux `.deb` Installer
2. Windows NSIS Installer
3. Installed Executable Name Constraint
4. Intranet ProGet Publication
5. `latest-stable.json` Manifest
6. Public GitHub Release Channel Unchanged
7. Release Pipeline Integrity for Installers
8. Workflow Secrets Policy
9. End-User Intranet Installation Documentation

**Destructive merge guard**: none required — no existing canonical spec was modified or removed; the promotion is a pure ADD of a new domain. No destructive approvals were needed.

**Active same-domain change warnings**: none — the only other active change (`add-email-signatures`) touches the `email-signatures`/`email` domains; no active change touches `specs/distribution/spec.md`.

## Archive Contents

| Artifact                     | Status | Notes                                                                    |
| ---------------------------- | ------ | ------------------------------------------------------------------------ |
| `proposal.md`                | ✅     | Intent, scope, rollback plan, 10 open questions                          |
| `design.md`                  | ✅     | ADRs 1–10, job graph, sequence diagram, coverage matrix, rollout         |
| `specs/distribution/spec.md` | ✅     | Full capability spec — promoted to `openspec/specs/distribution/spec.md` |
| `tasks.md`                   | ✅     | 27/29 checked; 2 unchecked rows are verification deferrals (below)       |
| `apply-progress.md`          | ✅     | Five work units, each with TDD Cycle Evidence tables                     |
| `verify-report.md`           | ✅     | PASS_WITH_WARNINGS, 0 blockers, 0 critical findings                      |
| `sync-report.md`             | ✅     | SYNCED; canonical promotion deferred to archive per parent direction     |
| `explore.md`                 | ✅     | Exploration artifact preserved                                           |
| `archive-report.md`          | ✅     | This file                                                                |

## Task Completion Gate

Re-read `tasks.md` immediately before archive: the only unchecked markers are:

- `- [ ] 3.2 Verify: makensis -DVERSION=<pkg version> build\windows\installer.nsi compiles with stock choco NSIS` — `sdd-owner: verification`; **deferred to CI** (first automated compile runs in the `installer-windows` job on the next `v*` tag; structural coverage via `test/build/windows-installer.test.js`, 8 tests).
- `- [ ] 6.3 Verify (informational, post-merge on the next v* tag): ProGet assets, manifest overwrite, checksum re-verify, GitHub Release format, netbird down` — `sdd-owner: verification`; **deferred to post-merge** (requires a real tag push with provisioned secrets).

**No unchecked implementation task markers remain.** No stale-checkbox reconciliation was required; the two unchecked rows are verification-only deferrals explicitly recorded in `verify-report.md` and `sync-report.md` as NON-GATING.

## Deferred Verification Items (non-gating, with pointers)

1. **Task 3.2 — makensis compile gate**: first automated NSIS compile runs in the `installer-windows` CI job (`choco install nsis --version=3.10` → `makensis -DVERSION=...`) on the next `v*` tag push. Structural contract: `test/build/windows-installer.test.js`.
2. **Task 6.3 — ProGet/manifest/netbird post-merge verification**: on the next `v*` tag push with provisioned secrets — ProGet assets under `outlook-mcp/<version>/`, manifest overwrite at `outlook-mcp/latest-stable.json`, manifest checksums re-verify, GitHub Release output identical to pre-change format, `netbird down` observed on success and failure paths.

## Non-Critical Hardening Follow-up

- **Pin action SHAs instead of `@v4`/`@v0` tags** in `release.yml` (verify finding 1, WARNING): all 17 `uses:` references use mutable tags, matching this repo's existing convention but diverging from the reference timetracker repo's full-SHA pinning. Recommended: pin to full commit SHAs and rely on Dependabot. Repo-convention change; recorded in `sync-report.md`. Non-blocking.
- Verify finding 2 (NOTE): changed-line estimate exceeded (~1527 insertions across 18 files vs ~950–1200 forecast) — estimation variance from strict-TDD structural test suites, not scope creep.

## Structured Status and actionContext Findings

- changeName: `add-intranet-distribution`; artifactStore: `openspec`; changeRoot: `/home/rpinto/.outlook-mcp/openspec/changes/add-intranet-distribution`.
- taskProgress: 27/29 — the 2 unchecked rows (3.2, 6.3) are `sdd-owner: verification` deferrals; no unchecked implementation tasks.
- actionContext: mode `repo-local`, workspaceRoot `/home/rpinto/.outlook-mcp`; not workspace-planning mode, so no `allowedEditRoots` requirement applied.
- Archive rules (`openspec/config.yaml` `rules.archive`): "Warn before merging destructive deltas" — no destructive deltas existed (new canonical domain); "Preserve archived artifacts as immutable historical evidence" — the change directory was moved intact to the dated archive, nothing deleted or modified.

## Risks

- **Low**: NSIS script not compiled locally (deferred to CI, task 3.2) — structural Jest coverage (8 tests) plus the proven org template mitigate.
- **Low**: End-to-end ProGet/NetBird publication not exercised locally (deferred to next `v*` tag, task 6.3) — fail-closed secret guard, needs-gates, and concurrency group mitigate.
- **Low**: Mutable action tags in `release.yml` (repo convention) — recorded as hardening follow-up.

## SDD Cycle Complete

The change has been fully planned, implemented, verified, synced, and archived. Canonical spec promoted to `openspec/specs/distribution/spec.md`; change preserved at `openspec/changes/archive/2026-09-07-add-intranet-distribution/` as immutable evidence. Ready for the next change.
