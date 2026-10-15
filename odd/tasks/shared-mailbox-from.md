# FEAT: #28 — send/draft on shared mailbox via delegated .Shared scopes

Issue: https://github.com/ACTSIS/outlook-mcp/issues/28
Branch: `feat/shared-mailbox-from`
Source: user question (2026-10-14) about replicating the Outlook "From" behavior for SAC support.

## Specs

- S1 (user, 2026-10-14, verbatim): "a ciertos usuarios en Outlook, cuando van a enviar un correo, les permite cambiar el origen a por ejempo sac.soporte@actsis.com, sin que tengan que autenticar o hacer más nada, y solo les aparece a los usuarios especificos quese les dio ese permiso, como se replicaria eso a nivel de API, no se peude hacer algo similar sin abrir la baraja de permisos".
- S2: Resolved approach approved by the user: delegated `Mail.Send.Shared` / `Mail.ReadWrite.Shared` scopes + Exchange mailbox delegation (Send As / Send on Behalf / Full Access). Exchange enforces the per-user right; the MCP adds the capability, never bypasses it.
- S3: Additive and optional `from` parameter on `send-email` and `draft-email`; without it, existing `/me` behavior is untouched.
- S4: A caller lacking the Exchange right must get a clear error (HTTP 403 → propagated with a clear code), never a silent fallback.
- S5: No client credentials / app-only changes in this feature (issue #18 territory, stays separate).

## Tasks

### T1: `send-email` `from` parameter

- `email/send.js`: optional `from` (UPN). Present → `POST /users/{from}/sendMail`. Absent → unchanged `POST /me/sendMail`.
- Tests in `test/email/send.test.js`: success with `from`, 403 propagation, unchanged no-`from` path.

### T2: `draft-email` `from` parameter

- `email/draft.js` + shared draft creation path: drafts created under `/users/{from}/...`; `replyToId` inside the shared mailbox resolves via that mailbox. Signature selection behavior unchanged.
- Tests: validation, success, 403, untouched no-`from` path.

### T3: Scopes + docs + spec

- `config.js`: `Mail.Send.Shared`, `Mail.ReadWrite.Shared`, `Calendars.Read.Shared` added to `DEFAULT_AUTH_SCOPES`.
- `docs/authentication.md` (per-user enforcement note), README, OpenSpec email spec scenario.
- Full suite, lint, format.

## Checks per task

- Focused: `npx jest test/email/send.test.js test/email/draft.test.js`
- Guards before merge: full `npm test`, `npm run lint`, `npm run format:check`.

## Log

- L1 (2026-10-14): user question verbatim in S1; approach agreed: delegated `.Shared` scopes (not app-only) to mirror Outlook's per-user control.
- L2 (2026-10-14): Entra ID app "M365 MCP Server" permissions added by user: `Mail.Send.Shared`, `Mail.ReadWrite.Shared`, `Calendars.Read.Shared` (pending admin consent at doc time); consent via "Conceder consentimiento de administrador".
- L3 (2026-10-14): T1-T3 implemented test-first (RED: 29 focused failures observed; GREEN: 81/81 focused, 832/832 full). Worker run timed out once mid-bash and resumed; deliverables completed. Deviations: two pre-existing draft schema tests relaxed to `stringContaining` (descriptions still guard the contract); `forward-draft` deliberately out of scope (own copy of the native-reply flow — candidate for a later task). Commit evidence recorded after parent review.
