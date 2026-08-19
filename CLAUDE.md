# Repository development guide

This file is for contributors and coding agents. User setup and capability documentation belongs in [`README.md`](./README.md), [`docs/authentication.md`](./docs/authentication.md), and [`docs/power-automate.md`](./docs/power-automate.md).

## Before changing code

1. Install dependencies with `npm install`.
2. Read the module's `index.js` tool definitions and its handler tests.
3. Preserve the public tool name and input schema unless the change explicitly modifies the MCP contract.
4. Keep production token work in `auth/token-storage.js`; do not extend the legacy token manager.

## Commands

```bash
npm start              # stdio MCP server
npm run auth-server    # active OAuth callback server on localhost:3333
npm run test-mode      # MCP server with USE_TEST_MODE=true
npm run inspect        # MCP Inspector
npm test               # Jest suite
npm run lint           # ESLint
npm run lint:fix       # ESLint with fixes
npm run format         # Prettier write (entire repository)
npm run format:check   # Prettier check
```

Prefer focused Jest paths while developing, then run the full checks required by the change. Do not hard-code test counts in documentation; the suite evolves.

## Runtime architecture

`index.js` loads `.env`, combines seven module tool arrays, and serves them over MCP stdio:

```text
MCP client
  -> index.js / tools/call
  -> module handler
     -> ensureAuthenticated() -> TokenStorage -> Microsoft Graph API
     -> getValidFlowAccessToken() -> TokenStorage -> Power Automate API
```

| Area                         | Responsibility                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| `config.js`                  | Server metadata, Graph scopes/endpoints, field selections, limits, and Flow constants                   |
| `auth/index.js`              | Exposes the `TokenStorage` singleton and Graph `ensureAuthenticated()` guard                            |
| `auth/token-storage.js`      | Production Graph and Flow token load/save, expiry checks, refresh, and in-process refresh deduplication |
| `auth/token-manager.js`      | **Legacy** synchronous cache retained for `createTestTokens()` and compatibility only                   |
| `outlook-auth-server.js`     | **Active** standalone HTTP server for initial Graph and Flow acquisition                                |
| `auth/oauth-server.js`       | Inactive Express-oriented module used by its direct unit tests; not wired into either executable        |
| `utils/graph-api.js`         | Graph transport, pagination, download redirects, and Graph mock dispatch                                |
| `power-automate/flow-api.js` | Flow transport and inline test-mode responses                                                           |

Graph and Flow credentials share `~/.outlook-mcp-tokens.json`. Read the known asymmetries before modifying authentication: [`docs/authentication.md`](./docs/authentication.md#known-limitations).

## Modules and contracts

Each domain exports an array of `{name, description, inputSchema, handler}` objects from its `index.js`:

- `auth/`: five informational/authentication tools, including callback-server lifecycle control
- `calendar/`: event listing and mutations
- `email/`: mail, drafts, replies, deletion, and attachments
- `folder/`: mail-folder listing, creation, and message moves
- `rules/`: inbox-rule listing, creation, and sequence changes
- `onedrive/`: file/folder operations and uploads
- `power-automate/`: environments, flows, runs, execution, and state

Add a tool by implementing a handler, exporting its definition from the domain index, and including tests for validation, authentication, success, and API error behavior. The root `index.js` already spreads each domain array.

## Important behavior

### Authentication

- Production handlers use the singleton `TokenStorage`; they must not read the token file directly.
- Access tokens enter the refresh window five minutes before expiry.
- `_refreshPromise` and `_flowRefreshPromise` deduplicate concurrent refreshes within one process.
- Preserve a rotated refresh token when Microsoft supplies one; preserve the previous refresh token when it does not.
- Flow permanent `invalid_grant` failure invalidates only `flow_*` fields. Transient Flow errors leave stored tokens intact.
- The active initial-acquisition implementation is `outlook-auth-server.js`, not `auth/oauth-server.js`.
- `check-auth-status` checks Graph only.

### Mail folder paths

`email/folder-utils.js` resolves `Parent/Child/...` one segment at a time. `folder/create.js` and `folder/move.js` depend on it. OData string literals must escape apostrophes by doubling them. A literal `/` in a display name remains unsupported.

### API clients

- Graph: `utils/graph-api.js`; HTTP 401 becomes `UNAUTHORIZED`, other failures retain the status and response body.
- Flow: `power-automate/flow-api.js`; HTTP 401 becomes `FLOW_UNAUTHORIZED`, and HTTP 403 sets `error.code = 'FLOW_FORBIDDEN'`.
- OneDrive uploads use the 4 MB threshold from `config.js` to separate simple and chunked paths.

## Testing map

| Change area                                      | Focused tests                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------ |
| Token lifecycle and refresh                      | `test/auth/token-storage.test.js`                                              |
| Active standalone auth server / Flow acquisition | `test/auth/oauth-server-flow.test.js`                                          |
| Inactive Express OAuth module                    | `test/auth/oauth-server.test.js`                                               |
| Auth MCP tools                                   | `test/auth/tools.test.js`, `test/auth/index.test.js`                           |
| Flow transport and handlers                      | `test/power-automate/flow-api.test.js`, `test/power-automate/handlers.test.js` |
| Graph transport and pagination                   | `test/utils/graph-api.test.js`                                                 |
| Domain handlers                                  | matching files under `test/calendar/` and `test/email/`                        |

Test mode is not a complete authentication-system simulation: `authenticate-flow` currently creates only Graph-shaped legacy test tokens. Handler tests mock `TokenStorage` directly where Flow authentication state matters.

## Specification ownership

Canonical requirements are organized by behavior, not by the archive that introduced them:

- [`openspec/specs/auth/spec.md`](./openspec/specs/auth/spec.md): productive Graph OAuth, Graph refresh, authentication status, and legacy boundaries
- [`openspec/specs/flow-token-management/spec.md`](./openspec/specs/flow-token-management/spec.md): Flow acquisition, persistence, validity, refresh, and invalidation
- [`openspec/specs/power-automate/spec.md`](./openspec/specs/power-automate/spec.md): the five user-visible Power Automate tools and Flow API errors
- [`openspec/traceability.md`](./openspec/traceability.md): archive lineage, supersession, and known implementation gaps

Archived changes are historical evidence. Never edit an archive to correct current behavior; update the owning canonical specification and record any lineage correction in the traceability document.

## Quality rules

- CommonJS modules, two-space indentation, single quotes, semicolons, and Prettier's 100-column width.
- Keep credentials and token contents out of logs, fixtures, commits, and documentation examples.
- Keep tests with behavioral changes and update both user-facing docs and OpenSpec when a public contract changes.
- Do not add AI attribution or `Co-Authored-By` trailers to commits; use conventional commit messages.
