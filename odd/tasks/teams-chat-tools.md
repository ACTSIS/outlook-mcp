# FEAT: #27 — Teams chat tools via Graph delegated access

Issue: https://github.com/ACTSIS/outlook-mcp/issues/27
Branch: `feat/teams-chat-tools`
Source: user conversation (2026-10-14): no Teams connectivity in the MCP; resolved as Microsoft Graph Teams chat REST endpoints with the delegated permission `Chat.ReadWrite`.

## Specs

- S1: "no tenemos capacidad para coectarnos de alguna manera al chat de teams, vía Graphql quizá?" (user, 2026-10-14).
- S2: Capability set approved by the user ("Iniciemos"): three tools in a new `teams/` domain — `list-chats`, `get-chat-messages`, `send-chat-message`.
- S3: Least-privilege scope agreed: `Chat.ReadWrite` only for the tools in S2; `Chat.Read`, `Chat.ReadBasic`, `Chat.Create` deliberately NOT requested (redundant or out of scope for this feature).
- S4: Architecture parity per CLAUDE.md: each tool is `{name, description, inputSchema, handler}` exported from the domain index; handlers call `ensureAuthenticated()` then Graph via `utils/graph-api.js`; HTTP 401 → `UNAUTHORIZED`; production handlers use the singleton `TokenStorage` (never read the token file directly).
- S5: Public tool names and input schemas must stay stable once shipped; this feature only ADDS tools and one scope string.

## Tasks

### T1: `list-chats` tool

- `teams/index.js` tool definition `{name:'list-chats', inputSchema, handler}`; `GET /me/chats` with `$select` (id, topic, lastMessagePreview, lastUpdatedDateTime, memberCount), `$top` page size + `nextLink` pagination pattern like `email/list.js`.
- Tests in `test/teams/list-chats.test.js`: validation, auth guard, success shape, API error propagation.

### T2: `get-chat-messages` tool

- `teams/get-chat-messages.js`; `GET /chats/{id}/messages` with pagination and optional date-range filter (`receivedAfter`/`receivedBefore` on message createdDateTime).
- Tests: validation (chat id required), auth guard, success, error.

### T3: `send-chat-message` tool

- `teams/send-chat-message.js`; `POST /chats/{id}/messages` with `{body:{contentType:'text'|'html', content}}`; plain text default.
- Tests: validation, auth guard, success, error.

### T4: Wiring, scope, docs, spec

- Root `index.js`: import `teamsTools` from `./teams` and spread into `TOOLS`.
- `config.js`: add `'Chat.ReadWrite'` to `DEFAULT_AUTH_SCOPES`.
- README: tool rows + scope note + re-acquisition step (`npm run auth-server`).
- New `openspec/specs/teams-chat/spec.md`: behavior requirements for the three tools.
- Focused + full Jest suite; ESLint; Prettier.

## Checks per task

- Focused: `npx jest test/teams/`
- Guards before merge: full `npm test`, `npm run lint`, `npm run format:check`.

## Log

- L1 (2026-10-14): user's original request verbatim: "Tenemos pendientes aquí?" → pending list → user: "no tenemos capacidad para coectarnos de alguna manera al chat de teams, vía Graphql quizá?" — resolved: Microsoft Graph (REST, delegated token), module proposal, user approval: "Iniciemos".
- L2 (2026-10-14): Entra ID permissions added by user (pending consent at doc time): `Chat.ReadWrite` (keep), plus redundant `Chat.Read`/`Chat.ReadBasic`/`Chat.Create` (recommended for removal).
- L3 (2026-10-14): T1-T4 implemented test-first by gentle-ai-worker (RED: missing modules; GREEN: 35 focused, 802 full). Commit `1a9124a`.
- L4 (2026-10-14): Native review `review-8c8f092db6ff80b8` (tier high, lenses risk + reliability) approved and acknowledged (authority burned). Non-blocking advisory findings for later work: R1-nextlink-passthrough (`teams/list-chats.js:24`), R3-001/R3-002 (`teams/get-chat-messages.js:79-90`, date post-filter), R3-003 (`test/teams/list-chats.test.js:57-59`, suggestion).
- L5 (2026-10-14): Independent gentle-ai-verify: PASS S1-S5; one doc finding fixed (README intro tool count 46 -> 49).
