/**
 * Improved search emails functionality
 */
const config = require('../config');
const { callGraphAPI, callGraphAPIPaginated } = require('../utils/graph-api');
const { ensureAuthenticated } = require('../auth');
const { resolveFolderPath } = require('./folder-utils');
const { buildDateFilter, combineFilterConditions } = require('./date-filter');

// Graph API caps $search responses at 1,000 results regardless of paging.
// Spec R3: client-side sweeps down a $search path must respect that cap so a
// count=0 request never paginates past it. Non-$search strategies keep the
// maxCount passthrough so count=0 still means a full sweep.
const MAX_SEARCH_RESULT_COUNT = 1000;

/**
 * Search emails handler
 * @param {object} args - Tool arguments
 * @returns {object} - MCP response
 */
async function handleSearchEmails(args) {
  const folder = args.folder || 'inbox';
  const requestedCount = args.count === undefined ? config.MAX_RESULT_COUNT : args.count;
  const query = args.query || '';
  const from = args.from || '';
  const to = args.to || '';
  const subject = args.subject || '';
  const hasAttachments = args.hasAttachments;
  const unreadOnly = args.unreadOnly;

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
            text: `Error searching emails: ${error.message}`,
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
      return formatSearchResults(pageResponse);
    }

    // Resolve the folder path
    const endpoint = await resolveFolderPath(accessToken, folder);
    console.error(`Using endpoint: ${endpoint} for folder: ${folder}`);

    // Execute progressive search with pagination
    const response = await progressiveSearch(
      endpoint,
      accessToken,
      { query, from, to, subject },
      { hasAttachments, unreadOnly },
      requestedCount,
      dateFilter
    );

    // Loud-failure results (keyword terms that cannot ride a date-filtered
    // request) pass through unchanged so they keep their isError flag.
    if (response.isError) {
      return response;
    }

    return formatSearchResults(response);
  } catch (error) {
    // Handle authentication errors
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

    // General error response
    return {
      content: [
        {
          type: 'text',
          text: `Error searching emails: ${error.message}`,
        },
      ],
    };
  }
}

/**
 * Execute a search with progressively simpler fallback strategies
 *
 * When dateFilter is present, all $search strategies (1 and 2) are skipped
 * structurally: Graph API does not support combining $filter with $search, so
 * the gate below prevents any $search path from ever carrying a date filter.
 * @param {string} endpoint - API endpoint
 * @param {string} accessToken - Access token
 * @param {object} searchTerms - Search terms (query, from, to, subject)
 * @param {object} filterTerms - Filter terms (hasAttachments, unreadOnly)
 * @param {number} maxCount - Maximum number of results to retrieve
 * @param {string|null} dateFilter - Compiled date predicate (or null)
 * @returns {Promise<object>} - Search results
 */
async function progressiveSearch(
  endpoint,
  accessToken,
  searchTerms,
  filterTerms,
  maxCount,
  dateFilter
) {
  // Hard gate: date filters must NEVER ride a $search request. Skip the
  // $search strategies entirely and run the $filter-only path instead.
  if (dateFilter) {
    return searchWithFiltersOnly(
      endpoint,
      accessToken,
      searchTerms,
      filterTerms,
      maxCount,
      dateFilter
    );
  }

  // Track search strategies attempted
  const searchAttempts = [];

  // 1. Try combined search (most specific)
  try {
    const params = buildSearchParams(searchTerms, filterTerms, Math.min(50, maxCount));
    console.error('Attempting combined search with params:', params);
    searchAttempts.push('combined-search');

    // Strategy 1 emits $search only when search terms exist; without terms it
    // is a $filter/$orderby request and keeps the count=0 sweep passthrough.
    const effectiveMaxCount = params.$search ? searchPathMaxCount(maxCount) : maxCount;

    const response = await callGraphAPIPaginated(
      accessToken,
      'GET',
      endpoint,
      params,
      effectiveMaxCount
    );
    if (response.value && response.value.length > 0) {
      console.error(`Combined search successful: found ${response.value.length} results`);
      return withSearchCapInfo(response, response.value.length);
    }
  } catch (error) {
    console.error(`Combined search failed: ${error.message}`);
  }

  // 2. Try each search term individually, starting with most specific
  const searchPriority = ['subject', 'from', 'to', 'query'];

  for (const term of searchPriority) {
    if (searchTerms[term]) {
      try {
        console.error(`Attempting search with only ${term}: "${searchTerms[term]}"`);
        searchAttempts.push(`single-term-${term}`);

        // For single term search, only use $search with that term
        // Graph API does not support $orderby or $filter with $search
        const simplifiedParams = {
          $top: Math.min(50, maxCount),
          $select: config.EMAIL_SELECT_FIELDS,
        };

        // Build KQL terms for search
        const kqlParts = [];

        // Add the search term in the appropriate KQL syntax
        if (term === 'query') {
          // General query doesn't need a prefix
          kqlParts.push(searchTerms[term]);
        } else {
          // Specific field searches use field:value syntax
          kqlParts.push(`${term}:${searchTerms[term]}`);
        }

        // Add boolean filters as KQL (can't use $filter with $search)
        addBooleanFiltersAsKQL(kqlParts, filterTerms);

        simplifiedParams.$search = `"${kqlParts.join(' ')}"`;

        const response = await callGraphAPIPaginated(
          accessToken,
          'GET',
          endpoint,
          simplifiedParams,
          searchPathMaxCount(maxCount)
        );
        if (response.value && response.value.length > 0) {
          console.error(`Search with ${term} successful: found ${response.value.length} results`);
          return withSearchCapInfo(response, response.value.length);
        }
      } catch (error) {
        console.error(`Search with ${term} failed: ${error.message}`);
      }
    }
  }

  // 3. Try with only boolean filters
  if (filterTerms.hasAttachments === true || filterTerms.unreadOnly === true) {
    try {
      console.error('Attempting search with only boolean filters');
      searchAttempts.push('boolean-filters-only');

      const filterOnlyParams = {
        $top: Math.min(50, maxCount),
        $select: config.EMAIL_SELECT_FIELDS,
        $orderby: 'receivedDateTime desc',
      };

      // Add the boolean filters
      addBooleanFilters(filterOnlyParams, filterTerms);

      const response = await callGraphAPIPaginated(
        accessToken,
        'GET',
        endpoint,
        filterOnlyParams,
        maxCount
      );
      console.error(`Boolean filter search found ${response.value?.length || 0} results`);
      return response;
    } catch (error) {
      console.error(`Boolean filter search failed: ${error.message}`);
    }
  }

  // 4. Final fallback: just get recent emails with pagination
  console.error('All search strategies failed, falling back to recent emails');
  searchAttempts.push('recent-emails');

  const basicParams = {
    $top: Math.min(50, maxCount),
    $select: config.EMAIL_SELECT_FIELDS,
    $orderby: 'receivedDateTime desc',
  };

  const response = await callGraphAPIPaginated(accessToken, 'GET', endpoint, basicParams, maxCount);
  console.error(`Fallback to recent emails found ${response.value?.length || 0} results`);

  // Add a note to the response about the search attempts
  response._searchInfo = {
    attemptsCount: searchAttempts.length,
    strategies: searchAttempts,
    originalTerms: searchTerms,
    filterTerms: filterTerms,
  };

  return response;
}

/**
 * Clamp the pagination bound for a request that carries $search (spec R3):
 * a count=0 sweep becomes the 1,000-result cap and any larger explicit count
 * is clamped down to it. Requests without $search never call this, so
 * count=0 keeps meaning a full sweep on $filter/$orderby paths.
 * @param {number} maxCount - Requested maximum number of results
 * @returns {number} - maxCount clamped to MAX_SEARCH_RESULT_COUNT
 */
function searchPathMaxCount(maxCount) {
  return maxCount > 0 ? Math.min(maxCount, MAX_SEARCH_RESULT_COUNT) : MAX_SEARCH_RESULT_COUNT;
}

/**
 * Flag a $search-path response when it hit the 1,000-result cap exactly, so
 * callers can tell a truncated sweep from genuine exhaustion (spec R3).
 * @param {object} response - Graph API response from a $search strategy
 * @param {number} resultCount - Number of results returned
 * @returns {object} - Same response with _searchInfo.capReached when capped
 */
function withSearchCapInfo(response, resultCount) {
  if (resultCount >= MAX_SEARCH_RESULT_COUNT) {
    response._searchInfo = { ...(response._searchInfo || {}), capReached: true };
  }
  return response;
}

/**
 * Filter-only search path used whenever a date filter is present.
 *
 * Builds params without $search (Graph API does not support $filter + $search).
 * `to` and `from` translate into OData recipient predicates
 * (toRecipients/any, from/emailAddress/address) so they are honored on this
 * path. `query` and `subject` have NO OData translation: instead of silently
 * dropping them, the path fails loudly with a
 * filter_dropped_due_to_strategy_degradation error result.
 * @param {string} endpoint - API endpoint
 * @param {string} accessToken - Access token
 * @param {object} searchTerms - Search terms (query, from, to, subject)
 * @param {object} filterTerms - Filter terms (hasAttachments, unreadOnly)
 * @param {number} maxCount - Maximum number of results to retrieve
 * @param {string} dateFilter - Compiled date predicate
 * @returns {Promise<object>} - Search results
 */
async function searchWithFiltersOnly(
  endpoint,
  accessToken,
  searchTerms,
  filterTerms,
  maxCount,
  dateFilter
) {
  // query/subject cannot ride $filter (only $search, which conflicts with
  // dates). Fail loudly rather than returning silently wrong results.
  const droppedTerms = [];
  if (searchTerms.query) {
    droppedTerms.push('query');
  }
  if (searchTerms.subject) {
    droppedTerms.push('subject');
  }
  if (droppedTerms.length > 0) {
    return buildDegradationError(droppedTerms);
  }

  const recipientConditions = buildRecipientFilterConditions(searchTerms);

  const params = {
    $top: Math.min(config.MAX_RESULT_COUNT, maxCount),
    $select: config.EMAIL_SELECT_FIELDS,
    $orderby: 'receivedDateTime desc',
  };

  // Date predicates go FIRST (Graph InefficientFilter rules), then boolean
  // filters, then recipient predicates (distinct properties from the $filter
  // and $orderby targets, so $orderby stays safe).
  const booleanConditions = [];
  if (filterTerms.hasAttachments === true) {
    booleanConditions.push('hasAttachments eq true');
  }
  if (filterTerms.unreadOnly === true) {
    booleanConditions.push('isRead eq false');
  }

  const combinedFilter = combineFilterConditions(dateFilter, [
    ...booleanConditions,
    ...recipientConditions,
  ]);
  if (combinedFilter) {
    params.$filter = combinedFilter;
  }

  const response = await callGraphAPIPaginated(accessToken, 'GET', endpoint, params, maxCount);
  console.error(`Filter-only search found ${response.value?.length || 0} results`);

  response._searchInfo = {
    strategies: recipientConditions.length > 0 ? ['filter-with-recipient'] : ['date-filter-only'],
    originalTerms: searchTerms,
    filterTerms: filterTerms,
  };

  return response;
}

/**
 * Translates `to`/`from` search terms into OData recipient predicates for the
 * $filter-only path. Apostrophes are escaped by doubling them (OData string
 * literal convention used across this repo).
 * @param {object} searchTerms - Search terms (query, from, to, subject)
 * @returns {string[]} - OData predicate strings (empty when neither is set)
 */
function buildRecipientFilterConditions(searchTerms) {
  const conditions = [];

  if (searchTerms.from) {
    const escaped = searchTerms.from.replace(/'/g, "''");
    conditions.push(`from/emailAddress/address eq '${escaped}'`);
  }

  if (searchTerms.to) {
    const escaped = searchTerms.to.replace(/'/g, "''");
    conditions.push(`toRecipients/any(r: r/emailAddress/address eq '${escaped}')`);
  }

  return conditions;
}

/**
 * Builds the loud-failure result for keyword terms (query/subject) that would
 * be silently dropped by the filter-only strategy.
 * @param {string[]} droppedTerms - Names of the dropped keyword parameters
 * @returns {object} - MCP error result
 */
function buildDegradationError(droppedTerms) {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text:
          `Error: filter_dropped_due_to_strategy_degradation — the requested keyword filter ` +
          `(${droppedTerms.join(', ')}) cannot be combined with receivedAfter/receivedBefore ` +
          `because Graph API does not allow $search and $filter together. Re-run without the ` +
          `date range, or filter by 'to'/'from' which now support date-ranged $filter.`,
      },
    ],
  };
}

/**
 * Build search parameters from search terms and filter terms
 * @param {object} searchTerms - Search terms (query, from, to, subject)
 * @param {object} filterTerms - Filter terms (hasAttachments, unreadOnly)
 * @param {number} count - Maximum number of results
 * @returns {object} - Query parameters
 */
function buildSearchParams(searchTerms, filterTerms, count) {
  const params = {
    $top: count,
    $select: config.EMAIL_SELECT_FIELDS,
  };

  // Handle search terms
  const kqlTerms = [];

  if (searchTerms.query) {
    // General query doesn't need a prefix
    kqlTerms.push(searchTerms.query);
  }

  if (searchTerms.subject) {
    kqlTerms.push(`subject:"${searchTerms.subject}"`);
  }

  if (searchTerms.from) {
    kqlTerms.push(`from:"${searchTerms.from}"`);
  }

  if (searchTerms.to) {
    kqlTerms.push(`to:"${searchTerms.to}"`);
  }

  // Add $search if we have any search terms
  if (kqlTerms.length > 0) {
    // Graph API does not support $orderby or $filter with $search
    // Move boolean filters into KQL syntax instead
    addBooleanFiltersAsKQL(kqlTerms, filterTerms);
    params.$search = `"${kqlTerms.join(' ')}"`;
  } else {
    // No search terms — safe to use $orderby and $filter
    params.$orderby = 'receivedDateTime desc';
    addBooleanFilters(params, filterTerms);
  }

  return params;
}

/**
 * Add boolean filters to query parameters as OData $filter
 * Only use when $search is NOT present (they conflict in Graph API)
 * @param {object} params - Query parameters
 * @param {object} filterTerms - Filter terms (hasAttachments, unreadOnly)
 */
function addBooleanFilters(params, filterTerms) {
  const filterConditions = [];

  if (filterTerms.hasAttachments === true) {
    filterConditions.push('hasAttachments eq true');
  }

  if (filterTerms.unreadOnly === true) {
    filterConditions.push('isRead eq false');
  }

  // Add $filter parameter if we have any filter conditions
  if (filterConditions.length > 0) {
    params.$filter = filterConditions.join(' and ');
  }
}

/**
 * Add boolean filters as KQL terms for use with $search
 * Use this instead of addBooleanFilters when $search is present
 * @param {string[]} kqlTerms - Array of KQL terms to append to
 * @param {object} filterTerms - Filter terms (hasAttachments, unreadOnly)
 */
function addBooleanFiltersAsKQL(kqlTerms, filterTerms) {
  if (filterTerms.hasAttachments === true) {
    kqlTerms.push('hasAttachments:true');
  }

  if (filterTerms.unreadOnly === true) {
    kqlTerms.push('isRead:false');
  }
}

/**
 * Format search results into a readable text format
 * @param {object} response - The API response object
 * @returns {object} - MCP response object
 */
function formatSearchResults(response) {
  if (!response.value || response.value.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: `No emails found matching your search criteria.`,
        },
      ],
    };
  }

  // Format results
  const emailList = response.value
    .map((email, index) => {
      const sender = email.from?.emailAddress || { name: 'Unknown', address: 'unknown' };
      const date = new Date(email.receivedDateTime).toLocaleString();
      const readStatus = email.isRead ? '' : '[UNREAD] ';

      return `${index + 1}. ${readStatus}${date} - From: ${sender.name} (${sender.address})\nSubject: ${email.subject}\nID: ${email.id}\n`;
    })
    .join('\n');

  // Add search strategy info if available
  let additionalInfo = '';
  if (response._searchInfo) {
    if (response._searchInfo.strategies) {
      additionalInfo = `\n(Search used ${
        response._searchInfo.strategies[response._searchInfo.strategies.length - 1]
      } strategy)`;
    }
    if (response._searchInfo.capReached) {
      additionalInfo +=
        '\n(Results capped at 1,000: $search responses cannot return more than 1,000 results)';
    }
  }

  // Surface the pagination cursor when the source has more pages
  if (response.nextLink) {
    additionalInfo += `\n(nextLink: ${response.nextLink})`;
  }

  return {
    content: [
      {
        type: 'text',
        text: `Found ${response.value.length} emails matching your search criteria:${additionalInfo}\n\n${emailList}`,
      },
    ],
  };
}

module.exports = handleSearchEmails;
