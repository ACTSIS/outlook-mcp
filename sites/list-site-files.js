/**
 * SharePoint list site files functionality (issue #18, delegated access)
 */
const config = require('../config');
const { callGraphAPI } = require('../utils/graph-api');
const { ensureAuthenticated } = require('../auth');

function formatSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * List site files handler
 * @param {object} args - Tool arguments
 * @returns {object} - MCP response
 */
async function handleListSiteFiles(args) {
  const siteId = args.siteId;
  const path = args.path || '';
  const count = args.count || 25;

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

  try {
    const accessToken = await ensureAuthenticated();

    // Build endpoint - default document library root or specific path
    let endpoint;
    if (!path || path === '/' || path === 'root') {
      endpoint = `sites/${encodeURIComponent(siteId)}/drive/root/children`;
    } else {
      const normalizedPath = path.replace(/^\/+|\/+$/g, '');
      // Encode each segment; encoding the whole path would corrupt the '/' separators.
      const encodedPath = normalizedPath
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
      endpoint = `sites/${encodeURIComponent(siteId)}/drive/root:/${encodedPath}:/children`;
    }

    const queryParams = {
      $top: Math.min(50, count),
      $select: config.ONEDRIVE_SELECT_FIELDS,
      $orderby: 'name',
    };

    const response = await callGraphAPI(accessToken, 'GET', endpoint, null, queryParams);

    if (!response.value || response.value.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No files found in site ${siteId}${path ? ` at ${path}` : ' (document library root)'}.`,
          },
        ],
      };
    }

    const fileList = response.value
      .map((item, index) => {
        const isFolder = item.folder ? '[FOLDER]' : '[FILE]';
        const size = item.size ? formatSize(item.size) : '';

        return `${index + 1}. ${isFolder} ${item.name}${size ? ` (${size})` : ''}\n   Modified: ${new Date(item.lastModifiedDateTime).toLocaleString()}\n   ID: ${item.id}`;
      })
      .join('\n\n');

    return {
      content: [
        {
          type: 'text',
          text: `${fileList}`,
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
            text: `Access to site '${siteId}' was denied by Microsoft Graph (HTTP 403; error code: SITE_ACCESS_DENIED). Your account does not have read access to that site's document library, and no fallback identity was used. Ask the site owner or a SharePoint admin to grant you access; the delegated Sites.Read.All scope is enforced per-user by SharePoint permissions.`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: `Error listing site files: ${error.message}`,
        },
      ],
    };
  }
}

module.exports = handleListSiteFiles;
