/**
 * SharePoint get site file download URL functionality (issue #18, delegated access;
 * issue #43: the pre-authenticated URL is obtained from the 302 redirect of the
 * `/content` endpoint, because `@microsoft.graph.downloadUrl` is not populated
 * in delegated contexts)
 */
const { callGraphAPI, callGraphAPIDownload } = require('../utils/graph-api');
const { ensureAuthenticated } = require('../auth');

function formatSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Get site file download URL handler
 * @param {object} args - Tool arguments
 * @returns {object} - MCP response
 */
async function handleDownloadSiteFile(args) {
  const siteId = args.siteId;
  const itemId = args.itemId;
  const path = args.path;

  if (!siteId) {
    return {
      content: [
        {
          type: 'text',
          text: 'siteId is required: pass the ID of the site (from list-sites).',
        },
      ],
    };
  }

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

    // Build endpoints - by ID or by path within the site's default drive
    let endpoint;
    let contentEndpoint;
    if (itemId) {
      endpoint = `sites/${encodeURIComponent(siteId)}/drive/items/${encodeURIComponent(itemId)}`;
      contentEndpoint = `${endpoint}/content`;
    } else {
      const normalizedPath = path.replace(/^\/+|\/+$/g, '');
      // Encode each segment; encoding the whole path would corrupt the '/' separators.
      const encodedPath = normalizedPath
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
      endpoint = `sites/${encodeURIComponent(siteId)}/drive/root:/${encodedPath}`;
      // The colon syntax is part of the Graph URL grammar and stays literal.
      contentEndpoint = `${endpoint}:/content`;
    }

    const queryParams = {
      $select: 'id,name,size,folder',
    };

    const response = await callGraphAPI(accessToken, 'GET', endpoint, null, queryParams);

    if (!response) {
      return {
        content: [
          {
            type: 'text',
            text: 'File not found in the site document library.',
          },
        ],
      };
    }

    if (response.folder) {
      return {
        content: [
          {
            type: 'text',
            text: `"${response.name}" is a folder and cannot be downloaded directly. List its files with list-site-files first.`,
          },
        ],
      };
    }

    // GET .../content responds 302 with a pre-authenticated download URL in the
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

    if (error.message && error.message.includes('status 403')) {
      return {
        content: [
          {
            type: 'text',
            text: `Access to file in site '${siteId}' was denied by Microsoft Graph (HTTP 403; error code: SITE_ACCESS_DENIED). Your account does not have read access to that site's document library, and no fallback identity was used. Ask the site owner or a SharePoint admin to grant you access; the delegated Sites.Read.All scope is enforced per-user by SharePoint permissions.`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: `Error getting site file download URL: ${error.message}`,
        },
      ],
    };
  }
}

module.exports = handleDownloadSiteFile;
