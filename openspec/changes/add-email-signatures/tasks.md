# Tasks: Add Managed Email Signatures

## Review Workload Forecast

| Field                   | Value                                                                         |
| ----------------------- | ----------------------------------------------------------------------------- |
| Estimated changed lines | 900–1,300                                                                     |
| 400-line budget risk    | High                                                                          |
| Chained PRs recommended | Yes                                                                           |
| Suggested split         | PR 1 storage/tools → PR 2 composition/new messages → PR 3 native replies/docs |
| Delivery strategy       | approved chained PRs                                                          |
| Chain strategy          | stacked-to-main                                                               |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

### Suggested Work Units

| Unit | Goal                                 | Likely PR | Focused test command                                                       | Runtime harness                                        | Rollback boundary                      |
| ---- | ------------------------------------ | --------- | -------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------- |
| 1    | Secure lifecycle and MCP tools       | PR 1      | `npm test -- --runInBand test/signature`                                   | `npm run inspect`; create/list/default/delete only     | `signature/`, registration, dependency |
| 2    | Compose signatures in new send/draft | PR 2      | `npm test -- --runInBand test/email/send.test.js test/email/draft.test.js` | Inspector: create signed draft; never send             | composer and new-message hooks         |
| 3    | Native reply flows and guidance      | PR 3      | `npm test -- --runInBand test/email`                                       | Inspector: create signed `replyToId` draft; never send | reply orchestration and signature docs |

## Phase 1: Work Unit 1 — Secure Lifecycle

- [x] 1.1 **RED:** Add `test/signature/sanitizer.test.js` for allowlisting, remote/data rejection, CID bijection, MIME/base64/name limits, and state-preserving invalid mutations.
- [x] 1.2 **GREEN:** Add `sanitize-html` and implement `signature/sanitizer.js` with the specified limits and fail-closed validation.
- [x] 1.3 **RED:** Add `test/signature/store.test.js` for CRUD/default semantics, mode `0600`, corruption, concurrent serialization, and injected atomic-write rollback.
- [x] 1.4 **GREEN:** Implement schema-v1 `signature/store.js` using reload-copy-validate, exclusive same-directory temp write/fsync/rename, and post-rename cache swap.
- [x] 1.5 **RED:** Add `test/signature/tools.test.js` asserting six tool schemas, results, missing targets, and clear-default behavior.
- [x] 1.6 **GREEN/REFACTOR:** Implement `signature/index.js`; register tools in `index.js`; deduplicate validation and keep auth storage untouched.

## Phase 2: Work Unit 2 — Composition and New Messages

- [x] 2.1 **RED:** Add `test/signature/composer.test.js` for opt-out/override/default precedence, unknown overrides, second-pass sanitization, text escaping, single append, and attachment mapping.
- [x] 2.2 **GREEN:** Implement `signature/composer.js` and expose `signatureName`/`includeSignature` through `email/index.js`.
- [x] 2.3 **RED:** Extend `test/email/send.test.js` and `test/email/draft.test.js` for signed new-message payloads, unsigned regression, CID attachments, and no Graph call after composition failure.
- [x] 2.4 **GREEN/REFACTOR:** Add `email/graph-message-flow.js`; adapt `email/send.js` and `email/draft.js` while preserving unsigned Graph contracts.

## Phase 3: Work Unit 3 — Native Replies and Delivery Evidence

- [x] 3.1 **RED:** Extend email tests for reply/reply-draft `createReply→PATCH→attachments→send`, quoted-body preservation, staged failure with draft ID, and never-send-before-all-attachments.
- [x] 3.2 **GREEN/REFACTOR:** Complete reply orchestration in `email/graph-message-flow.js`; retain recoverable partial drafts and native threading.
- [x] 3.3 Document tools, limits, CID images, precedence, storage, recovery, and draft-only validation in `README.md` and `docs/email-signatures.md`.
- [x] 3.4 Record each unit’s exact focused-test result, Inspector draft-only result, rollback boundary, and changed-line count; then run `npm test`, coverage, lint, format check, and `git diff --check`.
