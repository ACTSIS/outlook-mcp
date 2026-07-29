/**
 * List email attachments functionality
 */
const { callGraphAPI } = require('../utils/graph-api');
const { ensureAuthenticated } = require('../auth');

/**
 * List attachments handler
 * @param {object} args - Tool arguments
 * @param {string} args.emailId - Email ID (required)
 * @returns {object} - MCP response
 */
async function handleListAttachments(args) {
  const emailId = args.emailId;

  if (!emailId) {
    return {
      content: [
        {
          type: 'text',
          text: 'Email ID is required.',
        },
      ],
    };
  }

  try {
    const accessToken = await ensureAuthenticated();

    const endpoint = `me/messages/${encodeURIComponent(emailId)}/attachments`;
    const queryParams = {
      $select: 'id,name,contentType,size,isInline',
    };

    const response = await callGraphAPI(accessToken, 'GET', endpoint, null, queryParams);

    if (!response.value || response.value.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'No attachments found for this email.',
          },
        ],
      };
    }

    const regularAttachments = [];
    const inlineAttachments = [];

    for (const attachment of response.value) {
      const inlineFlag = attachment.isInline ? ' [INLINE]' : '';
      const formatted = `- ${attachment.name}${inlineFlag}\n  ID: ${attachment.id}\n  Type: ${attachment.contentType}\n  Size: ${attachment.size} bytes`;
      if (attachment.isInline) {
        inlineAttachments.push(formatted);
      } else {
        regularAttachments.push(formatted);
      }
    }

    let output = `Found ${response.value.length} attachment(s):\n\n`;
    output += regularAttachments.join('\n\n');

    if (inlineAttachments.length > 0) {
      output += `\n\nInline attachments:\n${inlineAttachments.join('\n\n')}`;
    }

    return {
      content: [
        {
          type: 'text',
          text: output,
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

    if (error.message === 'UNAUTHORIZED') {
      return {
        content: [
          {
            type: 'text',
            text: "Authentication expired. Please use the 'authenticate' tool first.",
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: `Error listing attachments: ${error.message}`,
        },
      ],
    };
  }
}

module.exports = handleListAttachments;
