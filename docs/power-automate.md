# Power Automate workflow

Power Automate support uses the Flow API, not Microsoft Graph. It has a separate OAuth scope and separate token fields, but stores them beside Graph tokens in the same local JSON file.

## Complete the workflow

1. Complete normal Graph authentication first.
2. Call `authenticate-flow`, copy the URL returned as the first response line, and open it in your browser. The browser is not opened automatically; the MCP process starts the callback server automatically.
3. Consent to `https://service.flow.microsoft.com/.default`.
4. Call `flow-list-environments` and copy an environment ID such as `Default-12345`.
5. Call `flow-list` with that `environmentId` and copy the flow ID from its `ID` field.
6. Use the exact environment and flow IDs with `flow-run`, `flow-list-runs`, or `flow-toggle`.

Display names are for people; API operations require IDs. Do not substitute an environment display name or flow display name for its `name`/ID value.

## Tools

| Tool                     | Required input                                              | Result                                                                      |
| ------------------------ | ----------------------------------------------------------- | --------------------------------------------------------------------------- |
| `flow-list-environments` | None                                                        | Environment display name, ID, region, and default marker when available     |
| `flow-list`              | `environmentId`                                             | Accessible flows with ID, state, trigger name, and creation date            |
| `flow-run`               | `environmentId`, `flowId`; optional `inputs` JSON string    | Invokes `/triggers/manual/run` and reports a returned run ID or `initiated` |
| `flow-list-runs`         | `environmentId`, `flowId`; optional `count` (default 10)    | Recent run ID, status, start time, and duration                             |
| `flow-toggle`            | `environmentId`, `flowId`; optional `enable` (default true) | Calls the flow `start` or `stop` action                                     |

Example inputs:

```json
{
  "environmentId": "Default-12345",
  "flowId": "00000000-0000-0000-0000-000000000000",
  "inputs": "{\"requestId\":\"REQ-42\"}"
}
```

`inputs` must be valid JSON when supplied as a string. The server parses it before sending the request body.

## Authentication behavior

The initial Flow grant is separate from Graph because it requests only the Flow resource scope. `TokenStorage.saveFlowTokens()` merges these fields into `~/.outlook-mcp-tokens.json`:

- `flow_access_token`
- `flow_refresh_token`, when Microsoft returns one
- `flow_expires_at`

Every Flow handler asks `TokenStorage` for a valid Flow token. An access token within five minutes of expiry is automatically refreshed only when a `flow_refresh_token` exists. Concurrent requests in one process share a single refresh operation. A rotated Flow refresh token is saved when returned.

`check-auth-status` does **not** check this token family. Use `flow-list-environments` as the functional status check.

> Graph and Flow share one file. Current Graph reauthentication can overwrite the file and remove `flow_*` fields. If that happens, run `authenticate-flow` again. Deleting the file also removes valid Graph credentials.

See [Authentication and token lifecycle](./authentication.md) for the complete failure matrix and known limitations.

## Functional limits

- `flow-list` reports only flows the Flow API returns for the authenticated account and environment. The implementation explicitly warns that only solution-aware flows are accessible.
- `flow-run` calls the `manual` trigger endpoint. Automated, scheduled, button variants with incompatible trigger contracts, or flows without a manual trigger cannot be started by this tool.
- A flow must be enabled and the account must be allowed to run it.
- Toggle operations require sufficient owner/editor permission.
- Most operations require both the environment ID and flow ID; the server does not resolve display names.
- The server uses Flow API version `2016-11-01` at `https://api.flow.microsoft.com/providers/Microsoft.ProcessSimple`.
- The implementation does not paginate Flow API collections. Results are limited to the single response page, and `flow-list-runs` applies `count` after receiving that page.

## Errors and recovery

| Result                                   | Meaning                                                                                                   | Recovery                                                                                             |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `Power Automate authentication required` | No usable `flow_access_token`, or refresh could not produce one                                           | Complete `authenticate-flow`; do not rely on `check-auth-status`                                     |
| `FLOW_UNAUTHORIZED` / HTTP 401           | Flow rejected the submitted access token; this response does not invalidate it locally                    | Complete `authenticate-flow` again                                                                   |
| `FLOW_FORBIDDEN` / HTTP 403              | Authenticated, but access or resource eligibility is insufficient                                         | Verify Power Automate licensing/access, environment, ownership/editor rights, and solution awareness |
| `Invalid inputs format`                  | `flow-run.inputs` could not be parsed as JSON                                                             | Send a valid JSON string or omit `inputs`                                                            |
| No environments                          | The account has no visible Power Platform environments                                                    | Verify tenant/account and Power Automate access                                                      |
| No flows                                 | No accessible flows were returned for that environment/page                                               | Verify the environment ID and that flows are solution-aware and shared with the account              |
| Manual trigger failure                   | The chosen flow does not expose the expected manual trigger, is disabled, or cannot be run by the account | Use a manual-trigger flow, enable it, and verify run permission                                      |
| Toggle forbidden                         | The account cannot modify the flow                                                                        | Use an owner/editor account or update permissions                                                    |
| Flow auth disappears after Graph auth    | Graph acquisition overwrote the shared token JSON                                                         | Complete `authenticate-flow` again                                                                   |
| Network or other HTTP error              | Transport or Flow API failure                                                                             | Retry transient failures; preserve the full status/body when reporting a reproducible issue          |

With `USE_TEST_MODE=true`, the Flow API client can simulate responses for a recognized test token, but `authenticate-flow` currently creates only Graph-shaped test credentials. Test mode is therefore not an end-to-end Flow authentication test.
