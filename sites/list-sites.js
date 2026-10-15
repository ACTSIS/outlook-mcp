/**
 * SharePoint list sites functionality (issue #18, delegated access)
 */
const config = require('../config');
const { callGraphAPI } = require('../utils/graph-api');
const { ensureAuthenticated } = require('../auth');

/**
 * Site access denial message (delegated flow, no fallback)
 * @param {string} context - what the caller was trying to do
 * @param {string} queryOrSite - query or site id surfaced to the caller
 * @returns {string} - user-facing denial text
 */
function siteAccessDenied(context, queryOrSite) {
  return `Access to ${context} was denied by Microsoft Graph (HTTP 403; error code: SITE_ACCESS_DENIED). Your account does not have read access to '${queryOrSite}' in SharePoint, and no fallback identity was used. Ask the site owner or a SharePoint admin to grant you access; the delegated Sites.Read.All scope is enforced per-user by SharePoint permissions.`;
}

/**
 * List sites handler
 * @param {object} args - Tool arguments
 * @returns {object} - MCP response
 */
async function handleListSites(args) {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  const count = args.count || 25;

  try {
    const accessToken = await ensureAuthenticated();

    const queryParams = {
      $select: config.SITE_SELECT_FIELDS,
      $top: Math.min(50, count),
    };
    if (query) {
      queryParams.$search = query;
    }

    const response = await callGraphAPI(accessToken, 'GET', 'sites', null, queryParams);

    if (!response.value || response.value.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: query
              ? `No sites found matching '${query}'.`
              : 'No sites are accessible with your account.',
          },
        ],
      };
    }

    const siteList = response.value
      .map((site, index) => {
        return `${index + 1}. ${site.displayName || site.name}\n   Web URL: ${site.webUrl || '(none)'}\n   ID: ${site.id}`;
      })
      .join('\n\n');

    return {
      content: [
        {
          type: 'text',
          text: `Found ${response.value.length} site(s):\n\n${siteList}`,
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
            text: siteAccessDenied('site listing', query || 'sites accessible to your account'),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: `Error listing sites: ${error.message}`,
        },
      ],
    };
  }
}

module.exports = handleListSites;
module.exports.siteAccessDenied = siteAccessDenied;
