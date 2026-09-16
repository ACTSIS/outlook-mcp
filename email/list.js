/**
 * List emails functionality
 */
const config = require('../config');
const { callGraphAPI, callGraphAPIPaginated } = require('../utils/graph-api');
const { ensureAuthenticated } = require('../auth');
const { resolveFolderPath } = require('./folder-utils');
const { buildDateFilter } = require('./date-filter');

/**
 * List emails handler
 * @param {object} args - Tool arguments
 * @returns {object} - MCP response
 */
async function handleListEmails(args) {
  const folder = args.folder || 'inbox';
  const requestedCount = args.count === undefined ? config.MAX_RESULT_COUNT : args.count;

  // Validate dates client-side (fail-fast) before any Graph call. Skipped on
  // the nextLink passthrough path: the link already encodes the full query.
  let dateFilter = null;
  if (!args.nextLink) {
    try {
      dateFilter = buildDateFilter({
        receivedAfter: args.receivedAfter,
        receivedBefore: args.receivedBefore,
      });
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error listing emails: ${error.message}`,
          },
        ],
      };
    }
  }

  try {
    // Get access token
    const accessToken = await ensureAuthenticated();

    // nextLink passthrough: the URL already encodes the full query, so other
    // filter arguments are ignored. Fetch the page directly and format it.
    if (args.nextLink) {
      const pageResponse = await callGraphAPI(accessToken, 'GET', args.nextLink, null, {});
      return formatListResults(pageResponse, folder);
    }

    // Resolve the folder path
    const endpoint = await resolveFolderPath(accessToken, folder);

    // Add query parameters; count=0 sweeps all pages so $top only sets page size
    const queryParams = {
      $top:
        requestedCount === 0
          ? config.FOLDER_SWEEP_PAGE_SIZE
          : Math.min(config.MAX_RESULT_COUNT, requestedCount),
      $orderby: 'receivedDateTime desc',
      $select: config.EMAIL_SELECT_FIELDS,
    };

    // Date predicates persist across nextLink pages via $filter
    if (dateFilter) {
      queryParams.$filter = dateFilter;
    }

    // Make API call with pagination support (maxCount 0 = full sweep)
    const response = await callGraphAPIPaginated(
      accessToken,
      'GET',
      endpoint,
      queryParams,
      requestedCount === 0 ? 0 : requestedCount
    );

    return formatListResults(response, folder);
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
          text: `Error listing emails: ${error.message}`,
        },
      ],
    };
  }
}

/**
 * Formats a listing response into the MCP text result, appending the
 * pagination cursor when the source has more pages.
 * @param {object} response - Graph API response (possibly combined pages)
 * @param {string} folder - Folder display name for the result header
 * @returns {object} - MCP response
 */
function formatListResults(response, folder) {
  if (!response.value || response.value.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: `No emails found in ${folder}.`,
        },
      ],
    };
  }

  // Format results
  const emailList = response.value
    .map((email, index) => {
      const sender = email.from ? email.from.emailAddress : { name: 'Unknown', address: 'unknown' };
      const date = new Date(email.receivedDateTime).toLocaleString();
      const readStatus = email.isRead ? '' : '[UNREAD] ';

      return `${index + 1}. ${readStatus}${date} - From: ${sender.name} (${sender.address})\nSubject: ${email.subject}\nID: ${email.id}\n`;
    })
    .join('\n');

  // Surface the pagination cursor when the source has more pages
  const nextLinkNote = response.nextLink ? `\n(nextLink: ${response.nextLink})` : '';

  return {
    content: [
      {
        type: 'text',
        text: `Found ${response.value.length} emails in ${folder}:\n\n${emailList}${nextLinkNote}`,
      },
    ],
  };
}

module.exports = handleListEmails;
