# FEAT: #15 — forward-draft with empty recipients quoting the original thread

Issue: https://github.com/ACTSIS/outlook-mcp/issues/15
Branch: `feat/forward-draft-empty-recipients`
Source: internal IA-assistance report (SAC support pilot), "Draft e-mail capabilities" section.

## Evidence

- Assignment e-mails must quote the client's original thread faithfully (inline screenshots, signature) without the client as recipient. `draft-email` with `replyToId` inherits recipients; plain-text quoted recreations lose embedded images.
- Graph `createForward` produces a native forward draft quoting the message as embedded content.

## Tasks

### T1: forward-draft tool — RED→GREEN ✅

- Tests first in `test/email/forward.test.js` (15 tests) + `test/email/tools.test.js` schema assertions.
- Handler `email/forward.js`: validate `emailId` → compose caller text (managed signature optional, CID images) → `createForward` → PATCH body (composed text above quoted thread when signed; overrides otherwise) → PATCH `toRecipients/ccRecipients/bccRecipients` to `[]` (no inheritance) → POST composed CID + file attachments.
- Tool registered in `email/index.js` (`forward-draft`); error mapping identical to draft.js.

### T2: Docs + spec ✅

- `openspec/specs/email/spec.md`: "Forward Draft With Empty Recipients" requirement, 4 scenarios.
- `README.md`: tool count 45→46, Email section 9→10, forward-draft row.

## Checks

- Focused: jest forward/tools/draft — 48/48. Full suite: 760/760. ESLint + Prettier clean on touched files.
- Review focus: recipients-clearing PATCH on every path; signed body order (composed before quoted).

## Commits

- b9adeb1 feat(email): add forward-draft tool with empty recipients quoting the original thread

## Follow-up (non-blocking)

- `docs/email-signatures.md` prose says "every `send-email` and `draft-email` operation"; consider mentioning forward-draft there (outside this task's edit surfaces).
