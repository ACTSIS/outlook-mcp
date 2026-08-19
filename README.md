# M365 Assistant MCP Server

[![CI](https://github.com/rafaga2469/outlook-mcp/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/rafaga2469/outlook-mcp/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Frafaga2469%2Foutlook-mcp%2Fbadges%2Fcoverage.json)](https://github.com/rafaga2469/outlook-mcp/actions/workflows/ci.yml)
[![Tests](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Frafaga2469%2Foutlook-mcp%2Fbadges%2Ftests.json)](https://github.com/rafaga2469/outlook-mcp/actions/workflows/ci.yml)

An independently maintained fork of [ryaker/outlook-mcp](https://github.com/ryaker/outlook-mcp). It exposes 37 MCP tools for Outlook mail and calendar, OneDrive, inbox rules, and Power Automate.

## Quick start

You need Node.js 22.22.1 or later and a Microsoft Entra app registration.

1. Install the server:

   ```bash
   git clone https://github.com/rafaga2469/outlook-mcp.git
   cd outlook-mcp
   npm install
   cp .env.example .env
   ```

2. Register a Web redirect URI of `http://localhost:3333/auth/callback` in Microsoft Entra ID and add these delegated Microsoft Graph permissions:

   ```text
   offline_access User.Read Mail.Read Mail.ReadWrite Mail.Send
   Calendars.Read Calendars.ReadWrite Contacts.Read Files.Read Files.ReadWrite
   ```

3. Put the application client ID, client secret **value**, and tenant ID in `.env`:

   ```dotenv
   MS_CLIENT_ID=your-application-client-id
   MS_CLIENT_SECRET=your-client-secret-value
   MS_TENANT_ID=your-directory-tenant-id
   USE_TEST_MODE=false
   ```

4. Add the MCP server to your client. For Claude Desktop:

   ```json
   {
     "mcpServers": {
       "m365-assistant": {
         "command": "node",
         "args": ["/absolute/path/to/outlook-mcp/index.js"],
         "env": {
           "OUTLOOK_CLIENT_ID": "your-application-client-id",
           "OUTLOOK_CLIENT_SECRET": "your-client-secret-value",
           "MS_TENANT_ID": "your-directory-tenant-id"
         }
       }
     }
   }
   ```

   See [`claude-config-sample.json`](./claude-config-sample.json) for a copyable file. The server uses stdio, so restart the MCP client after changing its configuration.

5. Call `authenticate`, open the returned URL, and complete sign-in. The MCP tool starts the browser callback server automatically. Then call `check-auth-status` and use a Graph-backed tool such as `list-emails`.

Power Automate is optional and requires a second consent flow. Complete the Graph flow first, then call `authenticate-flow`. See [Power Automate](./docs/power-automate.md).

## What the server can do

| Area                   | Supported operations                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| Outlook mail           | List, search, read, draft, send/reply, mark, delete, attachments, and folder moves                   |
| Calendar               | List, create, decline, cancel, and delete events                                                     |
| Mail folders and rules | List/create folders, move messages, and list/create/reorder inbox rules                              |
| OneDrive               | List/search, download URL, small and chunked uploads, sharing links, folders, and deletion           |
| Power Automate         | List environments and solution-aware flows, run manual-trigger flows, inspect runs, and toggle flows |

Nested mail-folder paths such as `Parent/Child/Archive` are resolved segment by segment by `create-folder` and `move-emails`. A literal `/` in a folder name is not supported because `/` is always the path separator.

## Tool inventory (43)

### Authentication (4)

| Tool                | Purpose                                                                             |
| ------------------- | ----------------------------------------------------------------------------------- |
| `about`             | Report server identity and supported service areas                                  |
| `authenticate`      | Start the callback server and return the Microsoft Graph browser-authentication URL |
| `check-auth-status` | Check and, when possible, refresh **Graph authentication only**                     |
| `authenticate-flow` | Start the callback server and return the separate Power Automate authentication URL |
| `stop-auth-server`  | Stop the callback server started by an authentication tool                          |

### Calendar (5)

| Tool            | Purpose                                          |
| --------------- | ------------------------------------------------ |
| `list-events`   | List upcoming events in an optional date range   |
| `create-event`  | Create an event with optional attendees and body |
| `decline-event` | Decline an event with an optional comment        |
| `cancel-event`  | Cancel an event with an optional comment         |
| `delete-event`  | Delete an event                                  |

### Email (9)

| Tool                  | Purpose                                                                     |
| --------------------- | --------------------------------------------------------------------------- |
| `list-emails`         | List recent messages in a mail folder                                       |
| `search-emails`       | Search by text, sender, recipient, subject, attachments, or unread state    |
| `read-email`          | Read sanitized visible content; raw HTML is an explicit unsafe debug option |
| `send-email`          | Send a new message or reply to an existing message                          |
| `draft-email`         | Create a new draft or reply draft                                           |
| `mark-as-read`        | Mark a message read or unread                                               |
| `delete-email`        | Move a message to Deleted Items or permanently delete it                    |
| `list-attachments`    | List attachment metadata for a message                                      |
| `download-attachment` | Return attachment content, optionally decoded when text-like                |

### Email signatures (6)

| Tool                          | Purpose                                      |
| ----------------------------- | -------------------------------------------- |
| `create-email-signature`      | Store sanitized HTML and managed CID images  |
| `list-email-signatures`       | List signatures and the shared default       |
| `get-email-signature`         | Read one stored signature                    |
| `update-email-signature`      | Replace a signature's HTML and images        |
| `delete-email-signature`      | Delete a signature and clear it if default   |
| `set-default-email-signature` | Set or clear the default used by email flows |

`send-email` and `draft-email` apply the shared default to new messages and native replies.
Use `signatureName` for a per-operation override or `includeSignature: false` to opt out. See
[Managed email signatures](docs/email-signatures.md) for CID image, storage, limit, and recovery
details.

### Mail folders (3)

| Tool            | Purpose                                                     |
| --------------- | ----------------------------------------------------------- |
| `list-folders`  | List mail folders, optionally including counts and children |
| `create-folder` | Create a folder, optionally below a nested parent path      |
| `move-emails`   | Move comma-separated message IDs to a folder path           |

### Inbox rules (3)

| Tool                 | Purpose                                                        |
| -------------------- | -------------------------------------------------------------- |
| `list-rules`         | List inbox rules, optionally with details                      |
| `create-rule`        | Create a sender/subject/attachment rule with supported actions |
| `edit-rule-sequence` | Change a named rule's execution sequence                       |

### OneDrive (8)

| Tool                     | Purpose                                                 |
| ------------------------ | ------------------------------------------------------- |
| `onedrive-list`          | List items at a path                                    |
| `onedrive-search`        | Search files by name or content                         |
| `onedrive-download`      | Get a pre-authenticated download URL by item ID or path |
| `onedrive-upload`        | Upload content smaller than 4 MB                        |
| `onedrive-upload-large`  | Upload content through a chunked upload session         |
| `onedrive-share`         | Create a view, edit, or embed sharing link              |
| `onedrive-create-folder` | Create a folder at a path                               |
| `onedrive-delete`        | Delete an item by ID or path                            |

### Power Automate (5)

| Tool                     | Purpose                                         |
| ------------------------ | ----------------------------------------------- |
| `flow-list-environments` | List Power Platform environments and their IDs  |
| `flow-list`              | List accessible flows in an environment         |
| `flow-run`               | Trigger a manual flow with optional JSON inputs |
| `flow-list-runs`         | List recent runs for a flow                     |
| `flow-toggle`            | Start or stop a flow                            |

## Authentication model

`TokenStorage` in `auth/token-storage.js` is the runtime token authority for both APIs. Graph handlers call `ensureAuthenticated()`, while Power Automate handlers call `getValidFlowAccessToken()`. Both token sets share `~/.outlook-mcp-tokens.json`; writes request owner-only mode `0600`.

Access tokens enter their refresh window five minutes before `expires_at`. Graph refresh is automatic when Graph-backed tools run. Flow refresh is automatic only when both an expired/near-expiry `flow_access_token` and a stored `flow_refresh_token` exist. Initial Flow consent is always separate.

`auth/token-manager.js` is legacy code retained for test-token creation and compatibility. New production paths must use `TokenStorage`.

> **Shared-file warning:** completing Graph authentication writes a new Graph token response directly to the shared file and can remove existing `flow_*` fields. If Power Automate stops authenticating after Graph reauthentication, run `authenticate-flow` again. Do not delete the token file as a first response to a Flow-only problem because that also removes Graph credentials.

For the token lifecycle, failure behavior, and current limitations, read [Authentication](./docs/authentication.md).

## Configuration reference

`.env` is loaded by both `index.js` and `outlook-auth-server.js`. Variables supplied by the MCP client are process environment variables and take precedence over `.env` through dotenv's default behavior.

| Variable                | Consumer                                     | Default / precedence                   | Notes                                                                                             |
| ----------------------- | -------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `MS_CLIENT_ID`          | MCP runtime, auth server, and `TokenStorage` | Fallback after `OUTLOOK_CLIENT_ID`     | Standard `.env` name                                                                              |
| `MS_CLIENT_SECRET`      | MCP runtime, auth server, and `TokenStorage` | Fallback after `OUTLOOK_CLIENT_SECRET` | Use the secret **value**, not its ID                                                              |
| `OUTLOOK_CLIENT_ID`     | MCP runtime, auth server, and `TokenStorage` | Preferred over `MS_CLIENT_ID`          | Convenient for MCP client configuration                                                           |
| `OUTLOOK_CLIENT_SECRET` | MCP runtime, auth server, and `TokenStorage` | Preferred over `MS_CLIENT_SECRET`      | Convenient for MCP client configuration                                                           |
| `MS_TENANT_ID`          | Both                                         | `common`                               | Use the tenant GUID for single-tenant applications                                                |
| `MS_AUTHORITY_HOST`     | Both                                         | `https://login.microsoftonline.com`    | Trailing slashes are removed                                                                      |
| `MS_SCOPES`             | `TokenStorage` refresh/exchange methods      | Built-in ten-scope Graph list          | Space-separated; include `offline_access`; standalone initial Graph acquisition does not honor it |
| `MS_REDIRECT_URI`       | `TokenStorage`                               | `http://localhost:3333/auth/callback`  | Standalone initial acquisition uses the fixed configured URI                                      |
| `MS_TOKEN_ENDPOINT`     | `TokenStorage`                               | Derived v2 token endpoint              | Standalone initial acquisition derives its endpoint separately                                    |
| `USE_TEST_MODE`         | MCP server                                   | `false`                                | Enables mocks; see test-mode limitation in the auth guide                                         |

The standalone auth server always listens on port `3333`; there is no environment-variable port override.

## Other MCP clients

Use the same absolute `node /path/to/outlook-mcp/index.js` command and environment values:

```toml
# ~/.codex/config.toml
[mcp_servers.m365-assistant]
command = "node"
args = ["/absolute/path/to/outlook-mcp/index.js"]

[mcp_servers.m365-assistant.env]
OUTLOOK_CLIENT_ID = "your-application-client-id"
OUTLOOK_CLIENT_SECRET = "your-client-secret-value"
MS_TENANT_ID = "your-directory-tenant-id"
```

OpenCode uses a command array instead:

```jsonc
{
  "mcp": {
    "m365-assistant": {
      "type": "local",
      "command": ["node", "/absolute/path/to/outlook-mcp/index.js"],
      "enabled": true,
      "environment": {
        "OUTLOOK_CLIENT_ID": "your-application-client-id",
        "OUTLOOK_CLIENT_SECRET": "your-client-secret-value",
        "MS_TENANT_ID": "your-directory-tenant-id",
      },
    },
  },
}
```

## Troubleshooting

### Microsoft Graph (Outlook, calendar, rules, and OneDrive)

| Symptom                                                                 | Recovery                                                                                                                      |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `Authentication required` or `check-auth-status` says not authenticated | Call `authenticate`, open its URL, and complete Graph consent; the callback server starts automatically                       |
| Graph returns `UNAUTHORIZED` (HTTP 401)                                 | The API rejected the submitted token; complete Graph authentication again because a 401 does not force local invalidation     |
| Graph returns HTTP 403 in an API error                                  | Authentication may be valid but the account/app lacks the required delegated permission; verify Entra permissions and consent |
| `AADSTS7000215` / invalid client secret                                 | Configure the client secret **value**, not the secret ID                                                                      |
| OAuth state is invalid or expired                                       | Start again from `authenticate`; pending state expires after ten minutes and is single-use                                    |
| Port 3333 is already in use                                             | Stop the existing process, or run `npx kill-port 3333`, then call `authenticate` again                                        |

### Power Automate

| Symptom                                           | Recovery                                                                                                              |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Flow authentication required                      | Call `authenticate-flow`; `check-auth-status` does not inspect Flow credentials                                       |
| `FLOW_UNAUTHORIZED` (HTTP 401)                    | The API rejected the submitted token; complete `authenticate-flow` again because a 401 does not invalidate it locally |
| `FLOW_FORBIDDEN` / HTTP 403                       | Verify Power Automate access, ownership/editor rights, environment and flow IDs, and that the flow is solution-aware  |
| A flow cannot be triggered                        | `flow-run` supports the manual trigger endpoint only; verify the flow is enabled and has a manual trigger             |
| Flow stopped working after Graph reauthentication | Graph acquisition may have removed `flow_*` from the shared file; call `authenticate-flow` again                      |

See [Power Automate troubleshooting](./docs/power-automate.md#errors-and-recovery) for the service-specific workflow.

## Development

```bash
npm run inspect       # MCP Inspector
npm run test-mode     # server with mock Graph/Flow responses
npm test              # Jest
npm run lint          # ESLint
npm run format:check  # Prettier check
```

The active server entry point is `index.js`; the active browser callback server is `outlook-auth-server.js`. Contributor architecture and verification guidance live in [`CLAUDE.md`](./CLAUDE.md).

## Credits and license

Built on [ryaker/outlook-mcp](https://github.com/ryaker/outlook-mcp) by [ryaker](https://github.com/ryaker). Licensed under [MIT](./LICENSE) © 2026 Ricardo Pinto; the original work is also MIT licensed.
