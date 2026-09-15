/**
 * List emails functionality
 */
const config = require('../config');
const { callGraphAPIPaginated } = require('../utils/graph-api');
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

  // Validate dates client-side (fail-fast) before any Graph call
  let dateFilter;
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

  try {
    // Get access token
    const accessToken = await ensureAuthenticated();

    // Resolve the folder path
    const endpoint = await resolveFolderPath(accessToken, folder);

    // Add query parameters; count=0 sweeps all pages so $top only sets page size
    const queryParams = {
      $top:
        requestedCount === 0
          ? config.DEFAULT_PAGE_SIZE
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
        const sender = email.from
          ? email.from.emailAddress
          : { name: 'Unknown', address: 'unknown' };
        const date = new Date(email.receivedDateTime).toLocaleString();
        const readStatus = email.isRead ? '' : '[UNREAD] ';

        return `${index + 1}. ${readStatus}${date} - From: ${sender.name} (${sender.address})\nSubject: ${email.subject}\nID: ${email.id}\n`;
      })
      .join('\n');

    return {
      content: [
        {
          type: 'text',
          text: `Found ${response.value.length} emails in ${folder}:\n\n${emailList}`,
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
          text: `Error listing emails: ${error.message}`,
        },
      ],
    };
  }
}

module.exports = handleListEmails;
