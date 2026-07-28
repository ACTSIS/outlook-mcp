# M365 Assistant MCP Server (maintained fork)

> Independent fork of [ryaker/outlook-mcp](https://github.com/ryaker/outlook-mcp) with additional fixes and improvements.

A comprehensive MCP (Model Context Protocol) server that connects Claude with Microsoft 365 services through the Microsoft Graph API and Power Automate API. This fork is independently maintained and adds subfolder path resolution, dotenv support in the entrypoint, and a newer MCP Inspector.

## Supported Services

| Service | Capabilities |
|---------|--------------|
| **Outlook** | Email, calendar, folders, rules |
| **OneDrive** | Files, folders, search, sharing |
| **Power Automate** | Flows, environments, run history |

## What's different in this fork

- [x] **Subfolder path resolution** for `move-emails` (e.g. `Tramite/REQ-104951`) — resolves nested folder hierarchies segment-by-segment via `resolveSegmentInParent`
- [x] **dotenv support in `index.js`** — loads `.env` at server startup so credentials are picked up without extra wiring
- [x] **MCP Inspector bumped to 0.22.0** for current inspector features
- [x] New `email/folder-utils.js` module with `getFolderIdByName`, `resolveSegmentInParent`, `resolveFolderPath`

See [Credits](#credits) for the original work this builds on.

## Quick Start

1. **Install**: `npm install`
2. **Azure setup**: Register an app in Azure Portal (see [Azure App Registration](#azure-app-registration--configuration))
3. **Configure**: `cp .env.example .env` and fill in your Azure credentials
4. **Wire up Claude**: Add the server to your Claude Desktop config (see [Claude Desktop Configuration](#claude-desktop-configuration))
5. **Authenticate**: `npm run auth-server`, then use the `authenticate` tool in Claude to complete OAuth
6. **Use it**: Access your M365 data through Claude

## Available Tools

### Outlook (Email & Calendar)
| Tool | Description |
|------|-------------|
| `list-emails` | List recent emails from inbox |
| `search-emails` | Search emails with filters |
| `read-email` | Read email content |
| `send-email` | Send a new email |
| `mark-as-read` | Mark email as read/unread |
| `list-events` | List calendar events |
| `create-event` | Create calendar event |
| `accept-event` | Accept event invitation |
| `decline-event` | Decline event invitation |
| `delete-event` | Delete calendar event |
| `list-folders` | List mail folders |
| `create-folder` | Create mail folder (supports nested paths like `Parent/Child`) |
| `move-emails` | Move emails between folders (supports nested paths like `Tramite/REQ-104951`) |
| `list-rules` | List inbox rules |
| `create-rule` | Create inbox rule |

### OneDrive
| Tool | Description |
|------|-------------|
| `onedrive-list` | List files in a path |
| `onedrive-search` | Search files by query |
| `onedrive-download` | Get download URL |
| `onedrive-upload` | Upload small file (<4MB) |
| `onedrive-upload-large` | Chunked upload (>4MB) |
| `onedrive-share` | Create sharing link |
| `onedrive-create-folder` | Create folder |
| `onedrive-delete` | Delete file or folder |

### Power Automate
| Tool | Description |
|------|-------------|
| `flow-list-environments` | List Power Platform environments |
| `flow-list` | List flows in environment |
| `flow-run` | Trigger a manual flow |
| `flow-list-runs` | Get flow run history |
| `flow-toggle` | Enable/disable a flow |

## Folder Path Resolution

`move-emails` and `create-folder` accept folder paths using `/` as a separator.

- **Nested paths**: `Parent/Child/Grandchild` resolves each segment in order, descending into the matching child folder.
- **Backwards compatible**: passing a flat name (no `/`) behaves identically to the original implementation — it matches a top-level folder.
- **Resolution helper**: `email/folder-utils.js` exposes `resolveFolderPath(path)` → splits on `/` and walks each segment via `resolveSegmentInParent(parentId, name)`.
- **Known limitation**: folder names that contain a literal `/` character are **not supported** — the character is always treated as a path separator.

| Input | Behavior |
|-------|----------|
| `Inbox` | Top-level folder lookup (legacy) |
| `Tramite/REQ-104951` | Find `Tramite`, then `REQ-104951` under it |
| `A/B/C` | Walk A → B → C, fail if any segment is missing |

## Directory Structure

```
├── index.js                 # Main entry point
├── config.js                # Configuration settings
├── auth/                     # Authentication modules
│   ├── index.js              # Authentication exports
│   ├── token-manager.js      # Token storage and refresh (Graph + Flow)
│   └── tools.js              # Auth-related tools
├── calendar/                 # Calendar functionality
│   ├── index.js              # Calendar exports
│   ├── list.js               # List events
│   ├── create.js             # Create event
│   ├── delete.js             # Delete event
│   ├── cancel.js             # Cancel event
│   ├── accept.js             # Accept event
│   └── decline.js            # Decline event
├── email/                    # Email functionality
│   ├── index.js              # Email exports
│   ├── list.js               # List emails
│   ├── search.js             # Search emails
│   ├── read.js               # Read email
│   ├── send.js               # Send email
│   ├── mark-as-read.js       # Mark email read/unread
│   └── folder-utils.js       # Folder name + path resolution (getFolderIdByName, resolveSegmentInParent, resolveFolderPath)
├── folder/                   # Folder functionality
│   ├── index.js              # Folder exports
│   ├── list.js               # List folders
│   ├── create.js             # Create folder (path-aware)
│   └── move.js               # Move emails (path-aware)
├── rules/                    # Email rules functionality
│   ├── index.js              # Rules exports
│   ├── list.js               # List rules
│   └── create.js             # Create rule
├── onedrive/                 # OneDrive functionality
│   ├── index.js              # OneDrive exports
│   ├── list.js               # List files/folders
│   ├── search.js             # Search files
│   ├── download.js           # Get download URL
│   ├── upload.js             # Simple upload (<4MB)
│   ├── upload-large.js       # Chunked upload (>4MB)
│   ├── share.js              # Create sharing link
│   └── folder.js             # Create/delete folders
├── power-automate/           # Power Automate functionality
│   ├── index.js              # Power Automate exports
│   ├── flow-api.js           # Flow API client
│   ├── list-environments.js  # List environments
│   ├── list-flows.js         # List flows
│   ├── run-flow.js           # Trigger flow
│   ├── list-runs.js          # Run history
│   └── toggle-flow.js        # Enable/disable flow
└── utils/                    # Utility functions
    ├── graph-api.js          # Microsoft Graph API helper
    ├── odata-helpers.js      # OData query building
    └── mock-data.js          # Test mode data
```

## Features

- **Authentication**: OAuth 2.0 authentication with Microsoft Graph API (+ Flow API for Power Automate)
- **Email Management**: List, search, read, send, and organize emails — including **nested folder paths**
- **Calendar Management**: List, create, accept, decline, and delete calendar events
- **OneDrive Integration**: List, search, upload, download, and share files
- **Power Automate**: List environments/flows, trigger flows, view run history
- **Modular Structure**: Clean separation of concerns for maintainability
- **Test Mode**: Simulated responses for testing without real API calls

## Installation

### Prerequisites
- Node.js 14.0.0 or higher
- npm or yarn package manager
- Azure account for app registration

### Clone & Install

```bash
git clone https://github.com/rafaga2469/outlook-mcp.git
cd outlook-mcp
npm install
```

## Azure App Registration & Configuration

### App Registration

1. Open [Azure Portal](https://portal.azure.com/)
2. Search for "App registrations"
3. Click "New registration"
4. Name: "M365 MCP Server"
5. Account type: "Accounts in any organizational directory and personal Microsoft accounts"
6. Redirect URI: Web → `http://localhost:3333/auth/callback`
7. Click "Register"
8. Copy the "Application (client) ID" for your `.env` file

### App Permissions

1. Go to "API permissions" under Manage
2. Click "Add a permission" → "Microsoft Graph" → "Delegated permissions"
3. Add these permissions:
   - `offline_access`
   - `User.Read`
   - `Mail.Read`, `Mail.ReadWrite`, `Mail.Send`
   - `Calendars.Read`, `Calendars.ReadWrite`
   - `Files.Read`, `Files.ReadWrite`
4. Click "Add permissions"

**For Power Automate** (optional):
- Requires additional Azure AD configuration with Flow API scope
- See Power Automate section below for details

### Client Secret

1. Go to "Certificates & secrets" → "Client secrets"
2. Click "New client secret"
3. Add description and select expiration
4. **Copy the VALUE** (not the Secret ID)

## Configuration

### Environment Variables

```bash
cp .env.example .env
```

Edit `.env`:
```bash
# Get these values from Azure Portal > App Registrations > Your App
MS_CLIENT_ID=your-application-client-id-here
MS_CLIENT_SECRET=your-client-secret-VALUE-here
MS_TENANT_ID=your-tenant-id-here
USE_TEST_MODE=false
```

**Important Notes:**
- Use `MS_CLIENT_ID` and `MS_CLIENT_SECRET` in the `.env` file
- Set `MS_TENANT_ID` for single-tenant apps to avoid `/common` endpoint errors
- For Claude Desktop config, you'll use `OUTLOOK_CLIENT_ID` and `OUTLOOK_CLIENT_SECRET`
- Always use the client secret **VALUE**, never the Secret ID

### Claude Desktop Configuration

Add to your Claude Desktop config:

```json
{
  "mcpServers": {
    "m365-assistant": {
      "command": "node",
      "args": ["/path/to/outlook-mcp/index.js"],
      "env": {
        "USE_TEST_MODE": "false",
        "OUTLOOK_CLIENT_ID": "your-client-id",
        "OUTLOOK_CLIENT_SECRET": "your-client-secret"
      }
    }
  }
}
```

> If you cloned the fork into a known location, point `args` at that path (e.g. `C:\\Users\\you\\outlook-mcp\\index.js` on Windows, or `/home/you/outlook-mcp/index.js` on Linux).

## Authentication

### Graph API (Outlook + OneDrive)

1. Start auth server: `npm run auth-server`
2. Use the `authenticate` tool in Claude
3. Visit the provided URL and sign in
4. Tokens saved to `~/.outlook-mcp-tokens.json`

### Power Automate (Optional)

Power Automate requires a separate token with the Flow API scope. Configure additional Azure AD permissions for `https://service.flow.microsoft.com//.default` scope.

**Limitations:**
- Only solution-aware flows are accessible
- Only manual trigger flows can be run via API
- Requires environment ID for most operations

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Cannot find module` | `npm install` |
| Port 3333 in use | `npx kill-port 3333` then `npm run auth-server` |
| `Invalid client secret` (AADSTS7000215) | Use the secret **VALUE**, not the Secret ID |
| `Authentication required` | Delete `~/.outlook-mcp-tokens.json` and re-authenticate |

## Testing

```bash
# Run with MCP Inspector
npm run inspect

# Run in test mode (mock data)
npm run test-mode

# Run Jest tests
npm test
```

## Extending the Server

1. Create new module directory
2. Implement tool handlers in separate files
3. Export tool definitions from module index
4. Import and add to `TOOLS` array in `index.js`

## Contributing

This is an independently maintained fork. Please open issues and pull requests against the fork:

- **Issues**: https://github.com/rafaga2469/outlook-mcp/issues
- **Pull requests**: https://github.com/rafaga2469/outlook-mcp/pulls

When reporting a bug, include:
- [ ] Steps to reproduce
- [ ] Expected vs. actual behavior
- [ ] Node.js version and OS
- [ ] Whether the issue reproduces in test mode (`npm run test-mode`)

## Credits

Built on the original [ryaker/outlook-mcp](https://github.com/ryaker/outlook-mcp) by [ryaker](https://github.com/ryaker). This fork adds subfolder path resolution, dotenv startup loading, and dependency refreshes while keeping the modular architecture intact.

## License

[MIT](./LICENSE) © 2026 Ricardo Pinto. Based on the original work by ryaker, also licensed under MIT.