/**
 * List Teams chats functionality
 */
const config = require('../config');
const { callGraphAPI, callGraphAPIPaginated } = require('../utils/graph-api');
const { ensureAuthenticated } = require('../auth');

/**
 * List Teams chats handler
 * @param {object} args - Tool arguments
 * @returns {object} - MCP response
 */
async function handleListChats(args) {
  const requestedCount = args.count === undefined ? config.MAX_RESULT_COUNT : args.count;

  try {
    // Get access token
    const accessToken = await ensureAuthenticated();

    // nextLink passthrough: the URL already encodes the full query, so other
    // arguments are ignored. Fetch the page directly and format it.
    let response;
    if (args.nextLink) {
      const pageResponse = await callGraphAPI(accessToken, 'GET', args.nextLink, null, {});
      response = pageResponse;
    } else {
      const queryParams = {
        $top: Math.min(config.MAX_RESULT_COUNT, requestedCount),
        $select: config.CHAT_SELECT_FIELDS,
      };

      // Make API call with pagination support
      response = await callGraphAPIPaginated(
        accessToken,
        'GET',
        'me/chats',
        queryParams,
        requestedCount
      );
    }

    return formatListResults(response);
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
          text: `Error listing chats: ${error.message}`,
        },
      ],
    };
  }
}

/**
 * Formats a listing response into the MCP text result, appending the
 * pagination cursor when the source has more pages.
 * @param {object} response - Graph API response (possibly combined pages)
 * @returns {object} - MCP response
 */
function formatListResults(response) {
  if (!response.value || response.value.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: 'No chats found.',
        },
      ],
    };
  }

  // Format results
  const chatList = response.value
    .map((chat, index) => {
      const topic = chat.topic || '(unnamed chat)';
      const updated = chat.lastUpdatedDateTime
        ? new Date(chat.lastUpdatedDateTime).toLocaleString()
        : 'unknown date';
      const preview = chat.lastMessagePreview ? chat.lastMessagePreview.replace(/\r?\n/g, ' ') : '';

      return `${index + 1}. ${topic}\nLast updated: ${updated}\nID: ${chat.id}\n${preview}\n`;
    })
    .join('\n');

  // Surface the pagination cursor when the source has more pages
  const nextLinkNote = response.nextLink ? `\n(nextLink: ${response.nextLink})` : '';

  return {
    content: [
      {
        type: 'text',
        text: `Found ${response.value.length} chats:\n\n${chatList}${nextLinkNote}`,
      },
    ],
  };
}

module.exports = handleListChats;
