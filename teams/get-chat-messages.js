/**
 * Get Teams chat messages functionality
 */
const config = require('../config');
const { callGraphAPI, callGraphAPIPaginated } = require('../utils/graph-api');
const { ensureAuthenticated } = require('../auth');
// Reuse the ISO 8601 date normalization semantics of the email module so the
// same inclusive date-only edge rules (midnight / end of day) apply everywhere.
const { normalizeDateInput } = require('../email/date-filter');

/**
 * Get chat messages handler
 * @param {object} args - Tool arguments
 * @returns {object} - MCP response
 */
async function handleGetChatMessages(args) {
  // Validate required parameters
  if (!args.chatId) {
    return {
      content: [
        {
          type: 'text',
          text: 'Chat ID (chatId) is required. Use list-chats to find chat IDs.',
        },
      ],
    };
  }

  // Validate dates client-side (fail-fast) before any Graph call.
  let receivedAfterTime = null;
  let receivedBeforeTime = null;
  try {
    if (args.receivedAfter !== undefined) {
      receivedAfterTime = new Date(normalizeDateInput(args.receivedAfter, 'receivedAfter'));
    }
    if (args.receivedBefore !== undefined) {
      receivedBeforeTime = new Date(normalizeDateInput(args.receivedBefore, 'receivedBefore'));
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error reading chat messages: ${error.message}`,
        },
      ],
    };
  }

  const requestedCount = args.count === undefined ? config.MAX_RESULT_COUNT : args.count;

  try {
    // Get access token
    const accessToken = await ensureAuthenticated();

    // nextLink passthrough: the URL already encodes paging details, so other
    // arguments other than the client-side date filter are ignored.
    let response;
    if (args.nextLink) {
      const pageResponse = await callGraphAPI(accessToken, 'GET', args.nextLink, null, {});
      response = pageResponse;
    } else {
      const queryParams = {
        $top: Math.min(config.MAX_RESULT_COUNT, requestedCount),
        // Graph guarantees no ordering without an explicit $orderby (its
        // implicit order follows lastModifiedDateTime, so edited or embedded
        // messages float around); newest-first must be requested explicitly.
        $orderby: 'createdDateTime desc',
      };

      // Make API call with pagination support
      response = await callGraphAPIPaginated(
        accessToken,
        'GET',
        `chats/${encodeURIComponent(args.chatId)}/messages`,
        queryParams,
        requestedCount
      );
    }

    // Graph does not accept a server-side $filter on chat message
    // createdDateTime, so the date range is applied as a post-filter.
    let messages = response.value || [];
    if (receivedAfterTime || receivedBeforeTime) {
      messages = messages.filter((message) => {
        const created = new Date(message.createdDateTime);
        return (
          (receivedAfterTime === null || created >= receivedAfterTime) &&
          (receivedBeforeTime === null || created <= receivedBeforeTime)
        );
      });
    }

    return formatMessagesResult(messages);
  } catch (error) {
    if (error.message === 'Authentication required') {
      return {
        content: [
          {
            type: 'text',
            text: "Authentication required. Please use the 'authenticate' tool first.",
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: `Error reading chat messages: ${error.message}`,
        },
      ],
    };
  }
}

/**
 * Formats a message collection into the MCP text result.
 * @param {Array<object>} messages - Chat messages after optional filtering
 * @returns {object} - MCP response
 */
function formatMessagesResult(messages) {
  if (messages.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: 'No messages found in this chat.',
        },
      ],
    };
  }

  const messageList = messages
    .map((message, index) => {
      const sender = message.from && message.from.user ? message.from.user.displayName : 'Unknown';
      const date = new Date(message.createdDateTime).toLocaleString();
      const type = message.body && message.body.contentType ? message.body.contentType : 'text';
      const content = message.body && message.body.content ? message.body.content : '';
      const contentTypeNote = type === 'html' ? ' [html]' : '';

      return `${index + 1}. ${date}${contentTypeNote} - From: ${sender}\nContent: ${content}\nID: ${message.id}\n`;
    })
    .join('\n');

  return {
    content: [
      {
        type: 'text',
        text: `Found ${messages.length} messages in this chat:\n\n${messageList}`,
      },
    ],
  };
}

module.exports = handleGetChatMessages;
