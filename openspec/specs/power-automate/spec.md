# Power Automate Tools Specification

## Purpose

Define the user-visible contract of the five Power Automate MCP tools. Token acquisition, persistence, expiry, and refresh are specified separately in [`../flow-token-management/spec.md`](../flow-token-management/spec.md).

## Requirements

### Requirement: Dedicated Flow API Client

Power Automate tools MUST call the Flow API with a Flow access token, not a Microsoft Graph access token.

#### Scenario: A Flow API request is sent

- GIVEN a valid Flow access token
- WHEN a Power Automate handler calls the API
- THEN the request MUST target `config.FLOW_API_ENDPOINT`
- AND the path MUST be under `/providers/Microsoft.ProcessSimple`
- AND it MUST use API version `2016-11-01`
- AND it MUST send the token as a Bearer credential

#### Scenario: Flow credentials are unavailable

- GIVEN `TokenStorage.getValidFlowAccessToken()` returns `null`
- WHEN any Power Automate tool is invoked
- THEN the tool MUST return an authentication-required response
- AND it MUST NOT call the Flow API

### Requirement: List Environments

`flow-list-environments` MUST list Power Platform environments available to the authenticated account.

#### Scenario: Environments are returned

- GIVEN the Flow API returns one or more environments
- WHEN `flow-list-environments` is invoked
- THEN the result MUST show each environment's display name and ID
- AND it SHOULD identify the default environment and region when available

#### Scenario: No environments are returned

- GIVEN the Flow API returns an empty collection
- WHEN `flow-list-environments` is invoked
- THEN the result MUST state that no Power Platform environments were found

### Requirement: List Flows

`flow-list` MUST list flows for a required `environmentId`.

#### Scenario: Environment identifier is absent

- GIVEN no `environmentId`
- WHEN `flow-list` is invoked
- THEN it MUST return a validation response
- AND it MUST direct the user to `flow-list-environments`

#### Scenario: Flows are returned

- GIVEN a valid `environmentId`
- WHEN the Flow API returns flows
- THEN the result MUST show each flow's display name, ID, state, trigger type, and creation date when available

#### Scenario: No accessible flows are returned

- GIVEN the Flow API returns an empty collection
- WHEN `flow-list` is invoked
- THEN the result MUST state that no flows were found
- AND it MUST explain that the API exposes solution-aware flows

### Requirement: Trigger Manual Flow

`flow-run` MUST trigger the manual endpoint of a flow using required `environmentId` and `flowId` arguments and optional JSON `inputs`.

#### Scenario: Required identifier is absent

- GIVEN `environmentId` or `flowId` is missing
- WHEN `flow-run` is invoked
- THEN it MUST return a validation response without calling the API

#### Scenario: Inputs are invalid JSON

- GIVEN `inputs` is a string that is not valid JSON
- WHEN `flow-run` is invoked
- THEN it MUST return an invalid-input response without calling the API

#### Scenario: Manual flow is triggered

- GIVEN valid identifiers, valid optional inputs, and sufficient permission
- WHEN `flow-run` is invoked
- THEN it MUST POST to `/environments/{environmentId}/flows/{flowId}/triggers/manual/run`
- AND it MUST return the run identifier when the API provides one
- AND it MUST direct the user to `flow-list-runs` for status

#### Scenario: Flow cannot be triggered

- GIVEN the API returns a forbidden response
- WHEN `flow-run` handles the failure
- THEN it MUST explain the manual-trigger, enabled-state, and permission prerequisites

### Requirement: List Flow Runs

`flow-list-runs` MUST show recent runs for required `environmentId` and `flowId` arguments.

#### Scenario: Run identifiers are absent

- GIVEN either required identifier is absent
- WHEN `flow-list-runs` is invoked
- THEN it MUST return a validation response without calling the API

#### Scenario: Recent runs are returned

- GIVEN the API returns run history
- WHEN `flow-list-runs` is invoked with optional `count`
- THEN it MUST return at most `count` entries, defaulting to 10
- AND each entry SHOULD include status, run ID, start time, and duration when available

#### Scenario: No run history exists

- GIVEN the API returns an empty collection
- WHEN `flow-list-runs` is invoked
- THEN the result MUST state that no run history was found

### Requirement: Toggle Flow State

`flow-toggle` MUST enable or disable a flow using required `environmentId` and `flowId` arguments and optional boolean `enable`.

#### Scenario: Flow is enabled by default

- GIVEN valid identifiers and no `enable` value
- WHEN `flow-toggle` is invoked
- THEN it MUST POST to `/environments/{environmentId}/flows/{flowId}/start`
- AND it MUST report the new state as `Started`

#### Scenario: Flow is disabled

- GIVEN `enable` is `false`
- WHEN `flow-toggle` is invoked
- THEN it MUST POST to `/environments/{environmentId}/flows/{flowId}/stop`
- AND it MUST report the new state as `Stopped`

#### Scenario: Caller cannot modify the flow

- GIVEN the Flow API returns a forbidden response
- WHEN `flow-toggle` handles the failure
- THEN it MUST explain that owner or editor permission is required

### Requirement: Flow API Error Mapping

The Flow API client and handlers MUST distinguish authentication and authorization failures from other API or network failures.

#### Scenario: API returns HTTP 401

- GIVEN the Flow API responds with HTTP 401
- WHEN a Power Automate handler processes the error
- THEN the client MUST expose `FLOW_UNAUTHORIZED`
- AND the handler MUST direct the user to re-authenticate with Flow scope

#### Scenario: API returns HTTP 403

- GIVEN the Flow API responds with HTTP 403
- WHEN the client processes the error
- THEN it MUST expose error code `FLOW_FORBIDDEN`
- AND the handler MUST return operation-specific permission guidance

#### Scenario: API or network failure is not 401 or 403

- GIVEN any other non-success status, invalid JSON response, or network error
- WHEN the handler processes the failure
- THEN it MUST return an operation-specific error response containing the diagnostic message

## Operational Constraints (Non-Normative)

- The API surface is intended for solution-aware flows.
- `flow-run` targets the `manual` trigger endpoint; scheduled, automated, and other trigger types are not started through this tool.
- Flow authentication is separate from Graph authentication. See the Flow token management specification for refresh and re-authentication behavior.
