# Teams Chat Tools Specification

## Purpose

Define the user-visible contract of the three Teams chat MCP tools, exposed through Microsoft Graph with the delegated `Chat.ReadWrite` permission. Token acquisition, persistence, and refresh are specified separately in [`../auth/spec.md`](../auth/spec.md).

## Requirements

### Requirement: Teams Chat Tools Use the Graph Chat Surface

Teams chat tools MUST obtain a Graph access token via `ensureAuthenticated()` and target the Microsoft Graph chat endpoints; they MUST NOT use the Flow API or read the token file directly.

#### Scenario: A chat request is sent

- GIVEN a valid Graph access token
- WHEN a Teams chat handler calls the API
- THEN the request MUST go through the shared Graph transport (`utils/graph-api.js`)
- AND a chat ID path segment MUST be URI-encoded

#### Scenario: The Graph token is rejected

- GIVEN Graph responds with HTTP 401
- WHEN a Teams chat tool is invoked
- THEN the result MUST surface the UNAUTHORIZED error in its response text

### Requirement: List Chats

`list-chats` MUST list Teams chats for the signed-in user, selecting id, topic, last message preview, last update time, and member count.

#### Scenario: Chats are returned

- GIVEN the signed-in user has chats
- WHEN `list-chats` is invoked
- THEN the result MUST show each chat's topic (or an unnamed marker), member count, last update date, and ID
- AND it MUST expose the pagination `nextLink` cursor when the source has more pages

#### Scenario: No chats are returned

- GIVEN the Graph API returns an empty collection
- WHEN `list-chats` is invoked
- THEN the result MUST state that no chats were found

### Requirement: Get Chat Messages

`get-chat-messages` MUST read chat messages for a required `chatId` and MUST accept an optional `count`, `nextLink`, and date-range filter (`receivedAfter`/`receivedBefore`).

#### Scenario: Chat identifier is absent

- GIVEN no `chatId`
- WHEN `get-chat-messages` is invoked
- THEN it MUST return a validation response
- AND it MUST NOT call the Graph API

#### Scenario: Messages are returned

- GIVEN a valid `chatId`
- WHEN the Graph API returns messages
- THEN the result MUST show each message's creation time, sender display name, content, and ID
- AND it MUST mark HTML messages so clients can distinguish formatting

#### Scenario: Date-range filter applies

- GIVEN `receivedAfter` and/or `receivedBefore` is provided
- WHEN `get-chat-messages` is invoked
- THEN the bounds MUST apply inclusively to the message `createdDateTime` as a client-side post-filter
- AND an invalid date input MUST fail client-side before any Graph call

### Requirement: Send Chat Message

`send-chat-message` MUST post a message to a required `chatId` with required message `content`, defaulting to plain text.

#### Scenario: Required parameters are absent

- GIVEN `chatId` or `content` is missing
- WHEN `send-chat-message` is invoked
- THEN it MUST return a validation response
- AND it MUST NOT call the Graph API

#### Scenario: Content type selection

- GIVEN `contentType` is omitted
- WHEN `send-chat-message` is invoked
- THEN the Graph payload MUST use the plain text content type
- AND `contentType: 'html'` MUST produce an HTML content type payload
- AND any other `contentType` value MUST be rejected as a validation response

#### Scenario: Message is sent

- GIVEN required parameters and a supported content type
- WHEN Graph accepts the POST to `/chats/{id}/messages`
- THEN the result MUST confirm the send with the chat ID and content length

### Requirement: Scope Boundary

Tokens acquired for the Teams chat tools MUST request only the `Chat.ReadWrite` Microsoft Graph permission among chat scopes; `Chat.Read`, `Chat.ReadBasic`, and `Chat.Create` are deliberately not requested.

#### Scenario: Default scope list contains one Teams chat scope

- GIVEN the default Graph scope list is used
- THEN it MUST contain `Chat.ReadWrite`
- AND it MUST NOT contain any other `Chat.*` scope

#### Scenario: Existing credentials predate the chat scope

- GIVEN a stored Graph token was acquired before `Chat.ReadWrite` existed
- WHEN the user wants to use Teams chat tools
- THEN re-acquisition via `npm run auth-server` MUST be the documented recovery path
