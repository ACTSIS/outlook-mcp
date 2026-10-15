# SharePoint Site Tools Specification

## Purpose

Define the user-visible contract of the three read-only SharePoint site MCP tools, exposed through Microsoft Graph with the delegated `Sites.Read.All` permission. Access to each site is enforced per-user by SharePoint permissions; no application-only or client-credentials flow is used (deferred in issue #18). Token acquisition, persistence, and refresh are specified separately in [`../auth/spec.md`](../auth/spec.md).

## Requirements

### Requirement: SharePoint Tools Use the Delegated Graph Sites Surface

SharePoint site tools MUST obtain a Graph access token via `ensureAuthenticated()` and target the Microsoft Graph `sites/` endpoints against a site's default document library; they MUST NOT use the Flow API, use a client-credentials flow, or read the token file directly.

#### Scenario: A site request is sent

- GIVEN a valid Graph access token
- WHEN a SharePoint site handler calls the API
- THEN the request MUST go through the shared Graph transport (`utils/graph-api.js`)
- AND the site ID and every path segment MUST be URI-encoded while the `root:/a/b` separator slashes stay literal

#### Scenario: The Graph token is rejected

- GIVEN Graph responds with HTTP 401
- WHEN a SharePoint site tool is invoked
- THEN the result MUST surface the UNAUTHORIZED error in its response text

### Requirement: List Sites

`list-sites` MUST search or list SharePoint team sites accessible to the signed-in user, selecting id, name, display name, and web URL, with the result count capped at 50.

#### Scenario: Sites are returned

- GIVEN Graph returns site documents
- WHEN `list-sites` runs with a `query`
- THEN the response MUST show each site's display name, web URL, and ID
- AND the Graph query MUST carry `$select` with the site select fields and `$search` with the trimmed query

#### Scenario: No query is provided

- GIVEN `query` is omitted
- WHEN `list-sites` runs
- THEN the Graph query MUST NOT carry `$search`
- AND the response MUST list the sites accessible to the account

#### Scenario: No sites are found

- GIVEN Graph returns an empty value array
- WHEN `list-sites` runs
- THEN the response MUST state no sites were found (naming the `query` when present)

### Requirement: List Site Files

`list-site-files` MUST list the items of a site's default document library at a path, defaulting to the library root, reusing the OneDrive item select fields, ordering by name, and capping the result count at 50.

#### Scenario: Items are returned

- GIVEN a valid site ID
- WHEN `list-site-files` runs for a folder path
- THEN the Graph query MUST hit `sites/{siteId}/drive/root:/{path}:/children`
- AND files MUST render `[FILE]` and folders `[FOLDER]` with size, modification time, and item ID

#### Scenario: The library root is listed

- GIVEN a valid site ID with `path` omitted
- WHEN `list-site-files` runs
- THEN the Graph query MUST hit `sites/{siteId}/drive/root/children`

#### Scenario: The site ID is missing

- GIVEN `siteId` is absent
- WHEN `list-site-files` runs
- THEN the tool MUST answer with a `siteId is required` validation message before authenticating

### Requirement: Download Site File

`download-site-file` MUST resolve a file's pre-authenticated `@microsoft.graph.downloadUrl` either by item ID (`sites/{siteId}/drive/items/{id}`) or by path (`sites/{siteId}/drive/root:/{path}`), selecting only id, name, size, and the download URL.

#### Scenario: A file download URL is returned

- GIVEN a valid site ID and either `itemId` or `path`
- WHEN `download-site-file` resolves a file
- THEN the response MUST include the file name, size, and pre-authenticated download URL
- AND the response MUST warn that the URL expires after a short time

#### Scenario: The item is a folder

- GIVEN Graph returns an item with a `folder` facet
- WHEN `download-site-file` runs
- THEN the tool MUST refuse it with a clear folder message and no download URL

#### Scenario: Neither item ID nor path is given

- GIVEN `itemId` and `path` are both absent, or `siteId` is absent
- WHEN `download-site-file` runs
- THEN the tool MUST answer with the matching validation message before authenticating

### Requirement: Delegated-Only Access With No Fallback

SharePoint site tools MUST operate under the delegated consent of the signed-in user; they MUST NOT fall back to another identity and MUST NOT request application permissions.

#### Scenario: Access to a site is not granted

- GIVEN Graph responds with HTTP 403 for a site operation
- WHEN the tool handles the error
- THEN the response MUST surface `SITE_ACCESS_DENIED` naming the site or scope of the denial
- AND the response MUST state that no fallback identity was used
- AND the response MUST direct the caller to obtain SharePoint access from the site owner or an admin

#### Scenario: The scope union is overridden

- GIVEN `MS_SCOPES` overrides the default scope union without `Sites.Read.All`
- WHEN credentials are acquired
- THEN the SharePoint site tools MUST NOT silently gain the scope
- AND `docs/authentication.md` MUST document that the override MUST include the scope explicitly
