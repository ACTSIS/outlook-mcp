/**
 * OneDrive simple upload functionality (files < 4MB)
 */
const config = require('../config');
const { callGraphAPI } = require('../utils/graph-api');
const { ensureAuthenticated } = require('../auth');

/**
 * Simple upload handler (for files < 4MB)
 * @param {object} args - Tool arguments
 * @returns {object} - MCP response
 */
async function handleUpload(args) {
  const path = args.path;
  const content = args.content;
  const isBase64 = args.base64 === true;
  const conflictBehavior = args.conflictBehavior || 'rename'; // rename, replace, fail

  if (!path) {
    return {
      content: [
        {
          type: 'text',
          text: "Path is required (e.g., '/Documents/myfile.txt').",
        },
      ],
    };
  }

  if (!content) {
    return {
      content: [
        {
          type: 'text',
          text: 'Content is required.',
        },
      ],
    };
  }

  // Build the raw upload body: text content is sent verbatim as UTF-8, while
  // base64-flagged content is decoded to a Buffer so binary files reach Graph
  // unmodified instead of being wrapped in a JSON string literal.
  let rawBody;
  let contentType;
  if (isBase64) {
    rawBody = Buffer.from(content, 'base64');
    contentType = 'application/octet-stream';
  } else {
    rawBody = content;
    contentType = 'text/plain';
  }

  // Check size - this is for simple upload only.
  // Always measure the actual bytes on the wire: decoded base64 content may be
  // smaller (or larger) than its textual representation.
  const bodyBytes = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
  if (bodyBytes.length > config.ONEDRIVE_UPLOAD_THRESHOLD) {
    return {
      content: [
        {
          type: 'text',
          text: `File is too large for simple upload (${formatSize(bodyBytes.length)}). Use onedrive-upload-large for files over 4MB.`,
        },
      ],
    };
  }

  try {
    const accessToken = await ensureAuthenticated();

    // Normalize path
    const normalizedPath = path.replace(/^\/+|\/+$/g, '');
    const endpoint = `me/drive/root:/${normalizedPath}:/content`;

    // Add conflict behavior query param
    const queryParams = {
      '@microsoft.graph.conflictBehavior': conflictBehavior,
    };

    const response = await callGraphAPI(accessToken, 'PUT', endpoint, null, queryParams, {
      rawBody: rawBody,
      contentType: contentType,
    });

    if (!response || !response.id) {
      return {
        content: [
          {
            type: 'text',
            text: 'Upload failed - no response from server.',
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: `Successfully uploaded "${response.name}" (${formatSize(response.size)})\n\nID: ${response.id}\nWeb URL: ${response.webUrl}`,
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
          text: `Error uploading file: ${error.message}`,
        },
      ],
    };
  }
}

/**
 * Format file size to human-readable string
 */
function formatSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

module.exports = handleUpload;
