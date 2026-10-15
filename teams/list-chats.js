/**
 * List Teams chats functionality
 */
const config = require('../config');
const { callGraphAPI, callGraphAPIPaginated } = require('../utils/graph-api');
const { ensureAuthenticated } = require('../auth');

/**
 * Reads the newest message's creation time for one chat.
 * Graph v1.0 keeps `lastUpdatedDateTime` stale for some chat types (notably
 * oneOnOne chats), so their real activity can only be seen via messages.
 * Returns ISO string or null when Graph returns no message.
 * @param {string} accessToken - Graph access token
 * @param {string} chatId - Chat ID
 * @returns {Promise<string|null>} - Newest message createdDateTime
 */
async function fetchLatestMessageDateTime(accessToken, chatId) {
  const response = await callGraphAPI(
    accessToken,
    'GET',
    `me/chats/${encodeURIComponent(chatId)}/messages`,
    { $top: 1, $select: 'id,createdDateTime' },
    {}
  );
  const messages = response && Array.isArray(response.value) ? response.value : [];
  const first = messages[0];
  return first && first.createdDateTime ? first.createdDateTime : null;
}

/**
 * Runs an async task over items with bounded concurrency, tolerating and
 * swallowing per-item failures.
 * @param {Array} items - Items to process
 * @param {number} limit - Maximum concurrent tasks
 * @param {(item: object) => Promise<void>} task - Async task per item
 * @returns {Promise<void>}
 */
async function runWithConcurrency(items, limit, task) {
  const queue = items.slice();
  const workers = [];
  const size = Math.max(1, limit);
  for (let i = 0; i < size && i < queue.length; i++) {
    workers.push(
      (async () => {
        for (;;) {
          const item = queue.shift();
          if (item === undefined) break;
          await task(item);
        }
      })()
    );
  }
  await Promise.all(workers);
}

/**
 * List Teams chats handler
 * @param {object} args - Tool arguments
 * @returns {object} - MCP response
 */
async function handleListChats(args) {
  const requestedCount = args.count === undefined ? config.MAX_RESULT_COUNT : args.count;

  try {
    // Get access token
    const accessToken = await ensureAuthenticated();

    // nextLink passthrough: the URL already encodes the full query, so other
    // arguments are ignored. Fetch the page directly and format it.
    let response;
    if (args.nextLink) {
      const pageResponse = await callGraphAPI(accessToken, 'GET', args.nextLink, null, {});
      response = pageResponse;
    } else {
      const queryParams = {
        $top: config.MAX_RESULT_COUNT >= requestedCount ? requestedCount : config.MAX_RESULT_COUNT,
        $select: config.CHAT_SELECT_FIELDS,
      };

      // Graph v1.0 rejects $orderby on lastUpdatedDateTime (issue #35), so the
      // page order is arbitrary: sweep up to CHATS_SWEEP_LIMIT chats and sort
      // newest-first client-side before returning the requested count.
      const sweepLimit = Math.max(config.CHATS_SWEEP_LIMIT, requestedCount);
      const swept = await callGraphAPIPaginated(
        accessToken,
        'GET',
        'me/chats',
        queryParams,
        sweepLimit
      );
      const chats = Array.isArray(swept.value) ? swept.value : [];

      // Graph keeps lastUpdatedDateTime stale for some chat types (notably
      // oneOnOne chats), which hides recent activity behind months-old
      // metadata. Probe the newest message of each non-meeting chat and use
      // its createdDateTime as the effective activity time, falling back to
      // the metadata when the probe fails or returns nothing. Meeting chats
      // keep the swept metadata: no staleness observed for them.
      if (config.CHATS_ACTIVITY_PROBING) {
        const probeTargets = chats.filter((chat) => chat.chatType !== 'meeting');
        await runWithConcurrency(probeTargets, config.CHATS_PROBE_CONCURRENCY, async (chat) => {
          try {
            const latest = await fetchLatestMessageDateTime(accessToken, chat.id);
            if (latest) {
              chat.lastActivityDateTime = latest;
            }
          } catch (error) {
            console.error(`Activity probe failed for chat ${chat.id}: ${error.message}`);
          }
        });
      }

      response = {
        ...swept,
        value: chats
          .sort(
            (a, b) =>
              new Date(b.lastActivityDateTime || b.lastUpdatedDateTime || 0) -
              new Date(a.lastActivityDateTime || a.lastUpdatedDateTime || 0)
          )
          .slice(0, requestedCount),
      };
    }

    return formatListResults(response);
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
          text: `Error listing chats: ${error.message}`,
        },
      ],
    };
  }
}

/**
 * Formats a listing response into the MCP text result, appending the
 * pagination cursor when the source has more pages.
 * @param {object} response - Graph API response (possibly combined pages)
 * @returns {object} - MCP response
 */
function formatListResults(response) {
  if (!response.value || response.value.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: 'No chats found.',
        },
      ],
    };
  }

  // Format results
  const chatList = response.value
    .map((chat, index) => {
      const topic = chat.topic || '(unnamed chat)';
      const updated = chat.lastActivityDateTime
        ? new Date(chat.lastActivityDateTime).toLocaleString()
        : chat.lastUpdatedDateTime
          ? new Date(chat.lastUpdatedDateTime).toLocaleString()
          : 'unknown date';
      const preview = chat.lastMessagePreview ? chat.lastMessagePreview.replace(/\r?\n/g, ' ') : '';

      return `${index + 1}. ${topic}\nLast updated: ${updated}\nID: ${chat.id}\n${preview}\n`;
    })
    .join('\n');

  // Surface the pagination cursor when the source has more pages
  const nextLinkNote = response.nextLink ? `\n(nextLink: ${response.nextLink})` : '';

  return {
    content: [
      {
        type: 'text',
        text: `Found ${response.value.length} chats:\n\n${chatList}${nextLinkNote}`,
      },
    ],
  };
}

module.exports = handleListChats;
