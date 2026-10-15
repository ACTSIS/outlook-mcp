# FEAT: #37 — forward-draft with optional from for shared mailbox

Issue: https://github.com/ACTSIS/outlook-mcp/issues/37
Branch: `feat/forward-draft-from`
Source: deferred task recorded in odd/tasks/shared-mailbox-from.md L3 (forward.js owns its own copy of the native-reply flow; #28 shipped `from` for send-email/draft-email only).

## Specs

- S1 (user, 2026-10-14, verbatim, from #28): "a ciertos usuarios en Outlook, cuando van a enviar un correo, les permite cambiar el origen a por ejempo sac.soporte@actsis.com, sin que tengan que autenticar o hacer más nada, y solo les aparece a los usuarios especificos quese les dio ese permiso, como se replicaria eso a nivel de API, no se peude hacer algo similar sin abrir la baraja de permisos"
- S2: `forward-draft` gains the same optional `from` (shared mailbox UPN). Present → the source message is addressed via `users/{from}/messages/{id}` and the forward draft is created under `users/{from}/...` (forward route equivalent to #28's createReply/createDraft routing). Absent → unchanged `/me` paths byte-for-byte.
- S3: Forward semantics unchanged: empty recipients, quoted thread as embedded content (inline images and quoted signature intact), managed-signature selection order, draft-only (never sends).
- S4: Graph 403 without Exchange Send As/Full Access on that mailbox → `MAILBOX_ACCESS_DENIED` naming the mailbox, no `/me` fallback; invalid `from` rejected pre-authentication.
- S5: No app-only / client-credentials changes (issue #18 stays separate).

## Tasks

### T1: `from` on forward-draft — DONE (commit a2ebfcc)

- `email/forward.js`: optional `from`; message fetch and draft creation route through `users/{from}/...`; reuse the #28 helpers (`isEmailLikeAddress`, `sharedMailboxPrefix`) from `email/graph-message-flow.js` instead of duplicating.
- Handler tests in `test/email/forward.test.js`: validation (invalid/empty from pre-auth), success with `from` (endpoints), 403 no-fallback, unchanged no-`from` path, signature/inline-image/empty-recipient regressions kept.

### T2: Docs + spec commit — DONE (commit ebe2abd)

- `email/index.js` schema description for `from` on forward-draft; README rows/section; `docs/authentication.md` note already mentions enforcement — extend if needed; OpenSpec `email` spec forward scenario.
- Focused: `npx jest test/email/forward.test.js test/email/graph-message-flow.test.js test/config/` then full suite, lint, Prettier.

## Checks per task

- Focused per T1; full `npm test` + `npm run lint` + `npm run format:check` before commit.

## Log

- L1 (2026-10-14): user mandate: "Ataquemos los pientes de una vez" (sic). Scope per S2-S4; forward.js owns its native flow copy, so reuse #28 helpers rather than duplicating again.
- L2 (2026-10-15): Implementation resumed and verified: forward.js routes createForward + draft patches via sharedMailboxPrefix (no source-message fetch needed; createForward quotes the thread server-side). Tests: focused forward 20/20, full suite 839/839, lint + Prettier clean. Commits a2ebfcc (T1), ebe2abd (T2).
