/**
 * Teams chat module for Outlook MCP server
 */
const handleListChats = require('./list-chats');
const handleGetChatMessages = require('./get-chat-messages');
const handleSendChatMessage = require('./send-chat-message');

// Teams tool definitions
const teamsTools = [
  {
    name: 'list-chats',
    description:
      'Lists Microsoft Teams chats (one-on-one and group) for the signed-in user, most recent first. Supports count paging via nextLink.',
    inputSchema: {
      type: 'object',
      properties: {
        count: {
          type: 'number',
          description: 'Number of chats to retrieve (default: 50)',
        },
        nextLink: {
          type: 'string',
          description:
            'Opaque @odata.nextLink from a previous response to fetch the next page. When provided, other filter arguments are ignored (the link already encodes them).',
        },
      },
      required: [],
    },
    handler: handleListChats,
  },
  {
    name: 'get-chat-messages',
    description:
      'Reads messages from a specified Teams chat by chat ID. Supports pagination via nextLink and optional date-range filtering on message timestamps (receivedAfter/receivedBefore apply to createdDateTime).',
    inputSchema: {
      type: 'object',
      properties: {
        chatId: {
          type: 'string',
          description: "ID of the chat to read (from 'list-chats')",
        },
        count: {
          type: 'number',
          description: 'Number of messages to retrieve (default: 50)',
        },
        nextLink: {
          type: 'string',
          description:
            'Opaque @odata.nextLink from a previous response to fetch the next page. When provided, paging arguments are ignored (the link already encodes them); the date-range filter still applies.',
        },
        receivedAfter: {
          type: 'string',
          description:
            'Only messages created on or after this date/time (ISO 8601, e.g. 2024-01-31 or 2024-01-31T14:30:00Z)',
        },
        receivedBefore: {
          type: 'string',
          description:
            'Only messages created on or before this date/time (ISO 8601, e.g. 2024-06-30 or 2024-06-30T23:59:59Z)',
        },
      },
      required: ['chatId'],
    },
    handler: handleGetChatMessages,
  },
  {
    name: 'send-chat-message',
    description:
      "Sends a message to a specified Teams chat by chat ID. Plain text by default; set contentType to 'html' for formatted content.",
    inputSchema: {
      type: 'object',
      properties: {
        chatId: {
          type: 'string',
          description: "ID of the chat to post to (from 'list-chats')",
        },
        content: {
          type: 'string',
          description: 'Message body content (plain text or HTML)',
        },
        contentType: {
          type: 'string',
          description: 'Content type of the message body',
          enum: ['text', 'html'],
        },
        subject: {
          type: 'string',
          description: 'Optional message subject',
        },
      },
      required: ['chatId', 'content'],
    },
    handler: handleSendChatMessage,
  },
];

module.exports = {
  teamsTools,
  handleListChats,
  handleGetChatMessages,
  handleSendChatMessage,
};
