/**
 * Send Teams chat message functionality
 */
const { callGraphAPI } = require('../utils/graph-api');
const { ensureAuthenticated } = require('../auth');

/**
 * Send chat message handler
 * @param {object} args - Tool arguments
 * @returns {object} - MCP response
 */
async function handleSendChatMessage(args) {
  const { chatId, content, contentType = 'text', subject } = args;

  // Validate required parameters
  if (!chatId) {
    return {
      content: [
        {
          type: 'text',
          text: 'Chat ID (chatId) is required. Use list-chats to find chat IDs.',
        },
      ],
    };
  }

  if (!content) {
    return {
      content: [
        {
          type: 'text',
          text: 'Message content is required.',
        },
      ],
    };
  }

  if (contentType !== 'text' && contentType !== 'html') {
    return {
      content: [
        {
          type: 'text',
          text: 'contentType must be one of: text, html.',
        },
      ],
    };
  }

  try {
    // Get access token
    const accessToken = await ensureAuthenticated();

    // Build the chat message payload
    const message = {
      body: {
        contentType,
        content,
      },
    };
    if (subject) {
      message.subject = subject;
    }

    // Make API call to send the chat message
    await callGraphAPI(
      accessToken,
      'POST',
      `chats/${encodeURIComponent(chatId)}/messages`,
      message
    );

    return {
      content: [
        {
          type: 'text',
          text: `Chat message sent successfully!\n\nChat: ${chatId}\nContent type: ${contentType}\nContent Length: ${content.length} characters`,
        },
      ],
    };
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
          text: `Error sending chat message: ${error.message}`,
        },
      ],
    };
  }
}

module.exports = handleSendChatMessage;
