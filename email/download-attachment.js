/**
 * Download email attachment functionality
 */
const config = require('../config');
const { callGraphAPI } = require('../utils/graph-api');
const { ensureAuthenticated } = require('../auth');

/**
 * Determine if a content type should be decoded as text
 * @param {string} contentType - MIME content type
 * @returns {boolean} - True if text-like
 */
function isTextLikeContentType(contentType) {
  if (!contentType) return false;
  const normalized = contentType.toLowerCase().trim();
  return (
    normalized.startsWith('text/') ||
    normalized === 'application/json' ||
    normalized === 'application/xml'
  );
}

/**
 * Download attachment handler
 * @param {object} args - Tool arguments
 * @param {string} args.emailId - Email ID (required)
 * @param {string} args.attachmentId - Attachment ID (required)
 * @param {boolean} args.decodeAsText - Whether to decode text-like content types (default true)
 * @returns {object} - MCP response
 */
async function handleDownloadAttachment(args) {
  const emailId = args.emailId;
  const attachmentId = args.attachmentId;
  const decodeAsText = args.decodeAsText !== false;

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

  if (!attachmentId) {
    return {
      content: [
        {
          type: 'text',
          text: 'Attachment ID is required.',
        },
      ],
    };
  }

  try {
    const accessToken = await ensureAuthenticated();

    const endpoint = `me/messages/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(attachmentId)}`;

    const attachment = await callGraphAPI(accessToken, 'GET', endpoint, null);

    if (!attachment) {
      return {
        content: [
          {
            type: 'text',
            text: `Attachment with ID ${attachmentId} not found.`,
          },
        ],
      };
    }

    const name = attachment.name || 'unnamed';
    const contentType = attachment.contentType || 'application/octet-stream';
    const size = attachment.size || 0;
    const contentBytes = attachment.contentBytes || '';

    let warning = '';
    if (size > config.ATTACHMENT_SIZE_WARNING_THRESHOLD) {
      const sizeMB = (size / (1024 * 1024)).toFixed(2);
      warning = `\n⚠️ Warning: This attachment is ${sizeMB} MB, which exceeds the ${config.ATTACHMENT_SIZE_WARNING_THRESHOLD / (1024 * 1024)} MB threshold.`;
    }

    let decodedText = null;
    if (decodeAsText && isTextLikeContentType(contentType) && contentBytes) {
      try {
        decodedText = Buffer.from(contentBytes, 'base64').toString('utf-8');
      } catch (decodeError) {
        console.error(`Error decoding attachment text: ${decodeError.message}`);
      }
    }

    const output = `Attachment: ${name}\nType: ${contentType}\nSize: ${size} bytes${warning}\n\n${decodedText !== null ? `Content (decoded text):\n${decodedText}` : `Content (base64):\n${contentBytes}`}`;

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
          text: `Error downloading attachment: ${error.message}`,
        },
      ],
    };
  }
}

module.exports = handleDownloadAttachment;
