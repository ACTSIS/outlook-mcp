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
         "args": ["/absolute/path/to/outlook-mcp/bin/m365-mcp.js", "mcp"],
         "env": {
           "OUTLOOK_CLIENT_ID": "your-application-client-id",
           "OUTLOOK_CLIENT_SECRET": "your-client-secret-value",
           "MS_TENANT_ID": "your-directory-tenant-id"
         }
       }
     }
   }
   ```

4. With Vault:

   ```json
   {
     "mcpServers": {
       "outlook-assistant": {
         "type": "local",
         "command": [
           "C:\\mcp\\outlook\\outlook-mcp-win-x64.exe",
           "mcp"
         ],
         "environment": {
           "VAULT_ADDR": "https://vault.com",
           "VAULT_AUTH_MOUNT": "oidc",
           "VAULT_ROLE": "entra",
           "VAULT_OIDC_PORT": "8250",
           "VAULT_KV_MOUNT": "kv",
           "VAULT_SECRET_PATH": "apps/outlook-mcp/prod",
           "VAULT_SKIP_BROWSER": "false"
         },
         "enabled": true
       }
     }
   }
   ```

   See [`claude-config-sample.json`](./claude-config-sample.json) for a copyable file. The server uses stdio, so restart the MCP client after changing its configuration.

5. Call `authenticate`, copy the URL returned as the first response line, and open it in your browser. The browser is not opened automatically; the MCP tool starts the callback server automatically. Then call `check-auth-status` and use a Graph-backed tool such as `list-emails`.

Power Automate is optional and requires a second consent flow. Complete the Graph flow first, then call `authenticate-flow`. See [Power Automate](./docs/power-automate.md).

## Pre-built executables

Standalone executables are published as GitHub Release assets. They include the MCP server and the authentication callback server in one file, and **do not require Node.js or npm** on the machine that runs them.

| Target      | Artifact                  | Platform               |
| ----------- | ------------------------- | ---------------------- |
| Windows x64 | `outlook-mcp-win-x64.exe` | Windows 10/11, x64     |
| Linux x64   | `outlook-mcp-linux-x64`   | Linux x64, glibc 2.28+ |

Windows file Properties identify the executable as **M365 Assistant MCP Server** from **ACTSIS** and show the package/release version. The embedded Node.js runtime is an implementation detail of the standalone build.

1. Open the [Releases](https://github.com/rafaga2469/outlook-mcp/releases) page and pick a release whose version matches your needs. Releases are created only from pushed tags; branches never publish.
2. Download the artifact for your platform. On Linux, make it executable:

   ```bash
   chmod +x outlook-mcp-linux-x64
   ```

3. Configure the runtime credentials as described below.
4. Launch the MCP mode from the downloaded file. The MCP mode is the default, so the argument is optional:

   ```text
   outlook-mcp-win-x64.exe mcp
   ./outlook-mcp-linux-x64 mcp
   ```

   The `auth` mode serves the browser callback on `http://localhost:3333`:

   ```text
   outlook-mcp-win-x64.exe auth
   ./outlook-mcp-linux-x64 auth
   ```

   In MCP mode, the executable relaunches itself in `auth` mode when an authentication tool needs the callback server, so one file covers the whole flow. If a future release must use separate fallback artifacts, it will document `outlook-mcp-<target>-mcp` and `outlook-mcp-<target>-auth` names and the same mode-specific invocation.

### Runtime configuration for pre-built executables

Runtime configuration is external. The build does not receive OAuth credentials, and the downloaded binary does not contain them. Use either process environment variables or a `.env` file in the **same directory as the executable**.

#### Supported variables

The server can start without credentials, but the first Graph or Power Automate authentication and any token refresh require a client ID and client secret. Use one name from each alias pair; when both non-empty aliases are set, the `OUTLOOK_*` value wins.

| Variable                                      | Required?                               | Controls                                                                                                                                                                                                    |
| --------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OUTLOOK_CLIENT_ID` or `MS_CLIENT_ID`         | Required for authentication and refresh | Microsoft Entra application (client) ID. `OUTLOOK_CLIENT_ID` takes precedence over `MS_CLIENT_ID`.                                                                                                          |
| `OUTLOOK_CLIENT_SECRET` or `MS_CLIENT_SECRET` | Required for authentication and refresh | Microsoft Entra client secret **value**, not the secret ID. `OUTLOOK_CLIENT_SECRET` takes precedence over `MS_CLIENT_SECRET`.                                                                               |
| `MS_TENANT_ID`                                | Optional                                | Tenant used by the identity endpoints. Defaults to `common`; set a tenant GUID for a single-tenant app.                                                                                                     |
| `MS_AUTHORITY_HOST`                           | Optional                                | Identity authority host. Defaults to `https://login.microsoftonline.com`; trailing slashes are removed.                                                                                                     |
| `MS_SCOPES`                                   | Optional advanced override              | Space-separated scopes used by `TokenStorage` refresh and code-exchange operations. Include `offline_access` when overriding it. The active initial Graph auth server uses the built-in scope list instead. |
| `MS_REDIRECT_URI`                             | Optional advanced override              | Redirect URI used by `TokenStorage` refresh and code-exchange operations. Initial acquisition remains fixed at `http://localhost:3333/auth/callback`.                                                       |
| `MS_TOKEN_ENDPOINT`                           | Optional advanced override              | Token endpoint used by `TokenStorage` refresh and exchange operations. Initial acquisition derives its endpoint from `MS_AUTHORITY_HOST` and `MS_TENANT_ID`.                                                |
| `USE_TEST_MODE`                               | Optional                                | Uses test API responses when set to `true`; defaults to `false` and should remain disabled for real accounts.                                                                                               |

`MS_SCOPES`, `MS_REDIRECT_URI`, and `MS_TOKEN_ENDPOINT` are refresh/exchange overrides, not complete replacements for the active initial acquisition flow. Leave them unset unless you specifically need those `TokenStorage` behaviors.

#### HashiCorp Vault for intranet developers

Vault mode keeps OAuth values outside the public executable and outside developer MCP configuration. It is **intranet-only**: the developer machine must be able to reach `VAULT_ADDR` through the corporate network, VPN, or NetBird as required by the local environment. GitHub Actions does not connect to Vault, ProGet, or NetBird for the public release.

Set `VAULT_ADDR` to enable Vault mode. The other settings are optional:

| Variable                              | Default                 | Purpose                                                                                      |
| ------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------- |
| `VAULT_ADDR`                          | Disabled when unset     | Intranet Vault HTTP(S) address; enables Vault mode                                           |
| `VAULT_AUTH_MOUNT`                    | `oidc`                  | Vault JWT/OIDC auth mount                                                                    |
| `VAULT_ROLE`                          | `outlook-mcp-developer` | OIDC role used for developer login                                                           |
| `VAULT_OIDC_PORT`                     | `8250`                  | Loopback callback port                                                                       |
| `VAULT_KV_MOUNT`                      | `kv`                    | KV v2 mount                                                                                  |
| `VAULT_SECRET_PATH`                   | `outlook-mcp/actsis`    | KV v2 secret path                                                                            |
| `VAULT_NAMESPACE`                     | Unset                   | Optional Vault Enterprise namespace                                                          |
| `VAULT_SKIP_BROWSER`                  | `false`                 | Set to `true` for manual URL flow; the URL is printed to stderr and the callback stays local |
| `VAULT_CUSTOM_HEADER_NAME`            | Unset                   | Optional custom HTTP header name sent with every Vault API request                           |
| `VAULT_CUSTOM_HEADER_VALUE`           | Unset                   | Sensitive value paired with `VAULT_CUSTOM_HEADER_NAME`; never logged or persisted            |
| `VAULT_TOKEN_CACHE_PATH`              | OS-specific             | Optional local path override for the per-user Vault token cache                              |
| `VAULT_TOKEN_RENEW_THRESHOLD_SECONDS` | `300`                   | Renew a renewable cached token when this many seconds or less remain                         |
| `VAULT_TOKEN`                         | Unset                   | Automation/testing escape hatch; no browser flow, never persisted or logged                  |

When `VAULT_TOKEN` is absent, the first startup requests a short-lived Vault token through the Vault OIDC browser flow. The runtime stores that Vault token and safe lease metadata in a per-user local cache. Later OpenCode/MCP launches validate the cached token with Vault, renew it when it is renewable and near expiry, and read the KV values without opening a browser. The local listener accepts only `GET http://127.0.0.1:<port>/oidc/callback`; the Vault role and the OIDC provider must allow the matching `http://localhost:<port>/oidc/callback` URI. With the defaults, configure `http://localhost:8250/oidc/callback` exactly. Static `VAULT_TOKEN` values are not recommended for developer installs.
After sign-in, the identity-provider redirect must return the matching `state` and a `code`. The client retains the `nonce` from Vault's authorization URL for the callback exchange; if the provider returns a nonce too, it must match.

#### Vault token cache

The cache contains only the short-lived Vault client token, its expiration/TTL metadata, its renewable flag, and a save timestamp. It never contains `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TENANT_ID`, or any other KV value. Those values are fetched from Vault into process memory on every startup.

Default cache locations are:

| Platform    | Path                                                                                                 |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| Windows     | `%LOCALAPPDATA%\m365-mcp\vault-token.json` (falls back to `%APPDATA%`, then the user home directory) |
| Linux/POSIX | `${XDG_CONFIG_HOME:-~/.config}/m365-mcp/vault-token.json`                                            |

Set `VAULT_TOKEN_CACHE_PATH` to choose another local path for tests or administrator-managed installations. The cache is written atomically; POSIX systems use mode `0600`, and Windows applies restrictive best-effort file handling under the current user profile.

To force another Vault login, delete the cache file. Revoking the cached Vault token also causes the next startup to discard it and run OIDC once more.

Windows PowerShell:

```powershell
$cachePath = $env:VAULT_TOKEN_CACHE_PATH
if (-not $cachePath) {
  $base = $env:LOCALAPPDATA
  if (-not $base) { $base = $env:APPDATA }
  if (-not $base) { $base = $HOME }
  $cachePath = Join-Path (Join-Path $base 'm365-mcp') 'vault-token.json'
}
Remove-Item -LiteralPath $cachePath -Force -ErrorAction SilentlyContinue
```

Linux:

```bash
rm -f "${VAULT_TOKEN_CACHE_PATH:-${XDG_CONFIG_HOME:-$HOME/.config}/m365-mcp/vault-token.json}"
```

The code default for `VAULT_SECRET_PATH` remains `outlook-mcp/actsis` for compatibility with existing installations. For the Actsis Vault, set the path explicitly:

```dotenv
VAULT_ADDR=https://vault.edge.actsis.com
VAULT_KV_MOUNT=kv
VAULT_SECRET_PATH=apps/outlook-mcp/prod
VAULT_CUSTOM_HEADER_NAME=X-ACCESS-TOKEN
VAULT_CUSTOM_HEADER_VALUE=replace-with-local-secret
```

Replace `replace-with-local-secret` locally through the process environment, OpenCode secret configuration, or a protected local `.env` file. The header value is sensitive: never commit it, put it in a fixture or release workflow, or embed it in the executable. If either custom-header variable is set without the other, startup fails with `VAULT_CONFIG_INVALID`.

The custom header is sent only on the server-side HTTP requests to Vault: the OIDC authorization URL request, the OIDC callback exchange, token lookup/renewal, and the KV v2 read. Its value is never placed in the OAuth browser URL or sent to the identity provider by the browser. `VAULT_CUSTOM_HEADER_NAME` must be a legal HTTP header token and cannot replace Vault-controlled authentication or namespace headers.

Store the following fields in KV v2 at `kv/data/apps/outlook-mcp/prod` for the Actsis configuration:

```text
MS_CLIENT_ID
MS_CLIENT_SECRET
MS_TENANT_ID
```

The runtime also accepts the existing optional overrides `OUTLOOK_CLIENT_ID`, `OUTLOOK_CLIENT_SECRET`, `MS_AUTHORITY_HOST`, `MS_SCOPES`, `MS_REDIRECT_URI`, and `MS_TOKEN_ENDPOINT`. Unrelated KV fields are ignored. A least-privilege policy should grant read access only to this secret path:

```hcl
path "kv/data/apps/outlook-mcp/prod" {
  capabilities = ["read"]
}
```

Attach that policy to the `outlook-mcp-developer` OIDC role. Configure the Vault OIDC provider and role according to HashiCorp's [JWT/OIDC API](https://developer.hashicorp.com/vault/api-docs/auth/jwt) and [Azure OIDC provider guide](https://developer.hashicorp.com/vault/docs/auth/jwt/oidc-providers/azuread); use query response mode and the exact localhost callback URI. Do not put an OIDC client secret or a Vault token in this repository.

The runtime precedence is explicit:

1. Parent process and MCP-client environment values win, including intentionally empty values.
2. Vault values override only values that came from the adjacent `.env` file and fill missing runtime values.
3. The adjacent `.env` file fills values not supplied by the process or Vault.

If `VAULT_ADDR` is unset, Vault is skipped and the existing adjacent `.env`/process-environment behavior remains available.

#### Precedence

The server sees MCP-client values and shell/OS values together as `process.env`; it does not distinguish their origin. With Vault enabled, the effective order is:

1. Existing process environment values win. An MCP client's `env` block is passed into `process.env`, so it overrides both Vault and the adjacent `.env` file, including an intentionally empty value.
2. Vault values replace values loaded from the adjacent `.env` and fill missing runtime values.
3. The dispatcher reads the adjacent `.env` and fills only variables not supplied by the process or Vault.
4. If both names in an alias pair are non-empty, `OUTLOOK_CLIENT_ID` wins over `MS_CLIENT_ID`, and `OUTLOOK_CLIENT_SECRET` wins over `MS_CLIENT_SECRET`. The alias fallback uses JavaScript's `||`, so an empty `OUTLOOK_*` value falls back to its `MS_*` alias when that alias is also supplied by the process.

For a packaged executable, `.env` is resolved by the executable's directory, not by the MCP client's working directory. Keep the file beside the downloaded binary.

#### Windows PowerShell

Set variables for the current PowerShell session and start MCP mode:

```powershell
Set-Location 'C:\Tools\outlook-mcp'
$env:OUTLOOK_CLIENT_ID = 'your-application-client-id'
$env:OUTLOOK_CLIENT_SECRET = 'your-client-secret-value'
$env:MS_TENANT_ID = 'your-directory-tenant-id'
& '.\outlook-mcp-win-x64.exe' mcp
```

#### Windows Command Prompt

Set variables for the current Command Prompt session:

```bat
cd /d C:\Tools\outlook-mcp
set "OUTLOOK_CLIENT_ID=your-application-client-id"
set "OUTLOOK_CLIENT_SECRET=your-client-secret-value"
set "MS_TENANT_ID=your-directory-tenant-id"
outlook-mcp-win-x64.exe mcp
```

#### Linux shell

```bash
cd /opt/outlook-mcp
export OUTLOOK_CLIENT_ID='your-application-client-id'
export OUTLOOK_CLIENT_SECRET='your-client-secret-value'
export MS_TENANT_ID='your-directory-tenant-id'
./outlook-mcp-linux-x64 mcp
```

#### `.env` beside the executable

Windows layout and file contents:

```text
C:\Tools\outlook-mcp\outlook-mcp-win-x64.exe
C:\Tools\outlook-mcp\.env
```

```dotenv
# C:\Tools\outlook-mcp\.env
MS_CLIENT_ID=your-application-client-id
MS_CLIENT_SECRET=your-client-secret-value
MS_TENANT_ID=your-directory-tenant-id
```

Run it from any working directory; the file is found beside the executable:

```powershell
& 'C:\Tools\outlook-mcp\outlook-mcp-win-x64.exe' mcp
```

Linux layout and file contents:

```text
/opt/outlook-mcp/outlook-mcp-linux-x64
/opt/outlook-mcp/.env
```

```dotenv
# /opt/outlook-mcp/.env
MS_CLIENT_ID=your-application-client-id
MS_CLIENT_SECRET=your-client-secret-value
MS_TENANT_ID=your-directory-tenant-id
```

Restrict the file to the account that runs the server. On Linux, use `chmod 600 /opt/outlook-mcp/.env`; on Windows, use a user-only ACL for the containing directory and `.env` file.

#### MCP client JSON

An MCP client can pass the same values in its `env` block instead of using `.env`. This Claude Desktop-style example uses the Windows executable; use the Linux path and executable name on Linux:

```json
{
  "mcpServers": {
    "m365-assistant": {
      "command": "C:\\Tools\\outlook-mcp\\outlook-mcp-win-x64.exe",
      "args": ["mcp"],
      "env": {
        "OUTLOOK_CLIENT_ID": "your-application-client-id",
        "OUTLOOK_CLIENT_SECRET": "your-client-secret-value",
        "MS_TENANT_ID": "your-directory-tenant-id"
      }
    }
  }
}
```

The MCP client supplies these values when it starts the process. Do not place a real client secret in a repository, shared configuration sample, issue, or chat transcript.

### Runtime safety and release credentials

- Do not commit `.env`, `.env.*`, token caches, or real credentials. `.env.example` remains intentionally trackable.
- The executable and GitHub Release artifacts are secret-free. The release workflow builds without OAuth variables, scans the artifacts for embedded credentials, and publishes only after the scan passes.
- The inspected workflows use no OAuth client secrets. The release job uses GitHub's built-in `github.token` only to publish the release; it is not a Microsoft credential and is not embedded in the binary.
- Build-time GitHub Actions credentials, if a future maintenance workflow needs them, are CI/release infrastructure credentials. They must never be used as substitutes for the end user's runtime Microsoft Entra values.

The existing npm installation remains supported through `bin/m365-mcp.js`, which bootstraps the same runtime environment as the pre-built executable. Its `.env` lives in the project directory, while a pre-built executable reads `.env` beside the binary. Both paths use the same `OUTLOOK_*`/`MS_*` variables, and both `mcp` and `auth` modes use the same runtime environment.

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

`TokenStorage` in `auth/token-storage.js` is the runtime token authority for both APIs. Graph handlers call `ensureAuthenticated()`, while Power Automate handlers call `getValidFlowAccessToken()`. Both token sets share `~/.outlook-mcp-tokens.json`; writes request owner-only mode `0600`. The runtime uses `HOME` first and `USERPROFILE` second to locate that file; these are OS home-directory variables, not OAuth settings that normally belong in `.env`.

Access tokens enter their refresh window five minutes before `expires_at`. Graph refresh is automatic when Graph-backed tools run. Flow refresh is automatic only when both an expired/near-expiry `flow_access_token` and a stored `flow_refresh_token` exist. Initial Flow consent is always separate.

`auth/token-manager.js` is legacy code retained for test-token creation and compatibility. New production paths must use `TokenStorage`.

> **Shared-file warning:** completing Graph authentication writes a new Graph token response directly to the shared file and can remove existing `flow_*` fields. If Power Automate stops authenticating after Graph reauthentication, run `authenticate-flow` again. Do not delete the token file as a first response to a Flow-only problem because that also removes Graph credentials.

For the token lifecycle, failure behavior, and current limitations, read [Authentication](./docs/authentication.md).

## Configuration reference

For the npm path, `bin/m365-mcp.js` loads the project `.env` before starting either mode. For a pre-built executable, the same dispatcher loads `.env` beside the executable. In both paths, existing process environment variables, including values supplied by an MCP client's `env` block, take precedence over file values; see the Vault precedence section when Vault mode is enabled.

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

Use the same absolute `node /path/to/outlook-mcp/bin/m365-mcp.js` command and environment values:

```toml
# ~/.codex/config.toml
[mcp_servers.m365-assistant]
command = "node"
args = ["/absolute/path/to/outlook-mcp/bin/m365-mcp.js", "mcp"]

[mcp_servers.m365-assistant.env]
OUTLOOK_CLIENT_ID = "your-application-client-id"
OUTLOOK_CLIENT_SECRET = "your-client-secret-value"
MS_TENANT_ID = "your-directory-tenant-id"
```

OpenCode uses a command array instead:

The environment block needs only non-secret Vault connection settings and the
protected gateway header. It intentionally contains no Microsoft OAuth values
and no `VAULT_TOKEN`; the OIDC token is cached locally after the first login.

```jsonc
{
  "mcp": {
    "m365-assistant": {
      "type": "local",
      "command": ["node", "/absolute/path/to/outlook-mcp/bin/m365-mcp.js"],
      "args": ["mcp"],
      "enabled": true,
      "environment": {
        "VAULT_ADDR": "https://vault.edge.actsis.com",
        "VAULT_AUTH_MOUNT": "oidc",
        "VAULT_ROLE": "outlook-mcp-developer",
        "VAULT_OIDC_PORT": "8250",
        "VAULT_KV_MOUNT": "kv",
        "VAULT_SECRET_PATH": "apps/outlook-mcp/prod",
        "VAULT_CUSTOM_HEADER_NAME": "X-ACCESS-TOKEN",
        "VAULT_CUSTOM_HEADER_VALUE": "replace-with-local-secret",
      },
    },
  },
}
```

Replace the custom-header placeholder locally with the protected secret value. Keep it in OpenCode's local secret configuration, the process environment, or a protected local `.env`; do not commit it or embed it in the executable. The value is used only for Vault API requests and is not included in the OAuth browser URL.

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
