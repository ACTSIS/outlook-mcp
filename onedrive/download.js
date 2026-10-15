/**
 * OneDrive download URL functionality (issue #41: the pre-authenticated URL is
 * obtained from the 302 redirect of the `/content` endpoint, because
 * `@microsoft.graph.downloadUrl` is not populated in delegated contexts)
 */
const { callGraphAPI, callGraphAPIDownload } = require('../utils/graph-api');
const { ensureAuthenticated } = require('../auth');

/**
 * Get download URL handler
 * @param {object} args - Tool arguments
 * @returns {object} - MCP response
 */
async function handleDownload(args) {
  const itemId = args.itemId;
  const path = args.path;

  if (!itemId && !path) {
    return {
      content: [
        {
          type: 'text',
          text: 'Either itemId or path is required.',
        },
      ],
    };
  }

  try {
    const accessToken = await ensureAuthenticated();

    // Build endpoints - by ID or by path
    // Drive paths are encoded one segment at a time; the colon syntax of the
    // root:/ path stays literal because it is part of the Graph URL grammar.
    let metadataEndpoint;
    let contentEndpoint;
    if (itemId) {
      metadataEndpoint = `me/drive/items/${itemId}`;
      contentEndpoint = `me/drive/items/${itemId}/content`;
    } else {
      const normalizedPath = path.replace(/^\/+|\/+$/g, '');
      const encodedPath = normalizedPath
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
      metadataEndpoint = `me/drive/root:/${encodedPath}`;
      contentEndpoint = `me/drive/root:/${encodedPath}:/content`;
    }

    // Get item metadata (folder detection and the response header)
    const queryParams = {
      $select: 'id,name,size,folder',
    };

    const response = await callGraphAPI(accessToken, 'GET', metadataEndpoint, null, queryParams);

    if (!response) {
      return {
        content: [
          {
            type: 'text',
            text: 'File not found.',
          },
        ],
      };
    }

    if (response.folder) {
      return {
        content: [
          {
            type: 'text',
            text: `"${response.name}" is a folder and cannot be downloaded directly.`,
          },
        ],
      };
    }

    // GET /content responds 302 with a pre-authenticated download URL in the
    // Location header; the downloadUrl property is not populated reliably.
    const downloadUrl = await callGraphAPIDownload(accessToken, contentEndpoint);

    return {
      content: [
        {
          type: 'text',
          text: `Download URL for "${response.name}" (${formatSize(response.size)}):\n\n${downloadUrl}\n\nNote: This URL is pre-authenticated and expires after a short time.`,
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
          text: `Error getting download URL: ${error.message}`,
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

module.exports = handleDownload;
