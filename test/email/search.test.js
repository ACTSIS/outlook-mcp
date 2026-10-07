const handleSearchEmails = require('../../email/search');
const { callGraphAPIPaginated } = require('../../utils/graph-api');
const { ensureAuthenticated } = require('../../auth');
const { resolveFolderPath, WELL_KNOWN_FOLDERS } = require('../../email/folder-utils');
const config = require('../../config');

jest.mock('../../utils/graph-api');
jest.mock('../../auth');
jest.mock('../../email/folder-utils');

describe('handleSearchEmails', () => {
  const mockAccessToken = 'dummy_access_token';
  const mockEmails = [
    {
      id: 'email-1',
      subject: 'Quarterly Report',
      from: {
        emailAddress: {
          name: 'John Doe',
          address: 'john@example.com',
        },
      },
      receivedDateTime: '2024-01-15T10:30:00Z',
      isRead: false,
    },
    {
      id: 'email-2',
      subject: 'Lunch plans',
      from: {
        emailAddress: {
          name: 'Jane Smith',
          address: 'jane@example.com',
        },
      },
      receivedDateTime: '2024-01-14T15:20:00Z',
      isRead: true,
    },
  ];

  beforeEach(() => {
    callGraphAPIPaginated.mockClear();
    ensureAuthenticated.mockClear();
    resolveFolderPath.mockClear();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    console.error.mockRestore();
  });

  function setupSuccess() {
    ensureAuthenticated.mockResolvedValue(mockAccessToken);
    resolveFolderPath.mockResolvedValue(WELL_KNOWN_FOLDERS['inbox']);
    callGraphAPIPaginated.mockResolvedValue({ value: mockEmails });
  }

  // Captures every params object passed to callGraphAPIPaginated across all
  // strategies attempted during one handler run.
  function capturedParamSets() {
    return callGraphAPIPaginated.mock.calls.map((call) => call[3]);
  }

  describe('date-only query routes through $filter (no $search)', () => {
    test('emits $filter and $orderby without $search', async () => {
      setupSuccess();

      await handleSearchEmails({ receivedAfter: '2024-01-01', receivedBefore: '2024-06-30' });

      expect(callGraphAPIPaginated).toHaveBeenCalledTimes(1);
      const params = callGraphAPIPaginated.mock.calls[0][3];
      expect(params.$filter).toBe(
        'receivedDateTime ge 2024-01-01T00:00:00.000Z and receivedDateTime le 2024-06-30T23:59:59.999Z'
      );
      expect(params.$orderby).toBe('receivedDateTime desc');
      expect(params.$search).toBeUndefined();
    });

    test('emits single ge predicate for receivedAfter only', async () => {
      setupSuccess();

      await handleSearchEmails({ receivedAfter: '2024-01-01' });

      const params = callGraphAPIPaginated.mock.calls[0][3];
      expect(params.$filter).toBe('receivedDateTime ge 2024-01-01T00:00:00.000Z');
      expect(params.$orderby).toBe('receivedDateTime desc');
      expect(params.$search).toBeUndefined();
    });

    test('combines dates with boolean filters, dates first', async () => {
      setupSuccess();

      await handleSearchEmails({
        receivedAfter: '2024-01-01',
        unreadOnly: true,
        hasAttachments: true,
      });

      const params = callGraphAPIPaginated.mock.calls[0][3];
      expect(params.$filter).toBe(
        'receivedDateTime ge 2024-01-01T00:00:00.000Z and hasAttachments eq true and isRead eq false'
      );
      expect(params.$orderby).toBe('receivedDateTime desc');
      expect(params.$search).toBeUndefined();
    });
  });

  describe('keyword terms plus dates fail loudly instead of degrading', () => {
    test('query plus dates returns the loud degradation error', async () => {
      setupSuccess();

      const result = await handleSearchEmails({ query: 'report', receivedAfter: '2024-01-01' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('filter_dropped_due_to_strategy_degradation');
      expect(result.content[0].text).toContain('query');
      expect(callGraphAPIPaginated).not.toHaveBeenCalled();
    });

    test('subject plus dates returns the loud degradation error', async () => {
      setupSuccess();

      const result = await handleSearchEmails({
        subject: 'lunch',
        receivedBefore: '2024-06-30',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('filter_dropped_due_to_strategy_degradation');
      expect(result.content[0].text).toContain('subject');
      expect(callGraphAPIPaginated).not.toHaveBeenCalled();
    });

    test('to plus query plus dates fails loudly (query would still be dropped)', async () => {
      setupSuccess();

      const result = await handleSearchEmails({
        to: 'bob@example.com',
        query: 'report',
        receivedAfter: '2024-01-01',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('filter_dropped_due_to_strategy_degradation');
      expect(callGraphAPIPaginated).not.toHaveBeenCalled();
    });

    test('query and subject both present are listed in the error', async () => {
      setupSuccess();

      const result = await handleSearchEmails({
        query: 'report',
        subject: 'lunch',
        receivedAfter: '2024-01-01',
      });

      expect(result.content[0].text).toContain('(query, subject)');
    });
  });

  describe('recipient terms plus dates translate to $filter', () => {
    test('to plus dates keeps to server-side-free: dates only in $filter, to matched client-side', async () => {
      setupSuccess();
      callGraphAPIPaginated.mockResolvedValue({
        value: [
          {
            id: 'm1',
            subject: 'Matched',
            toRecipients: [{ emailAddress: { address: 'bob@example.com' } }],
          },
          {
            id: 'm2',
            subject: 'Not matched',
            toRecipients: [{ emailAddress: { address: 'carol@example.com' } }],
          },
        ],
      });

      const result = await handleSearchEmails({
        to: 'bob@example.com',
        receivedAfter: '2024-01-01',
      });

      expect(callGraphAPIPaginated).toHaveBeenCalledTimes(1);
      const params = callGraphAPIPaginated.mock.calls[0][3];
      // Graph rejects toRecipients/any(...) server-side filters, so `to` must
      // NOT appear in $filter; it is applied as a client-side post-filter.
      expect(params.$filter).toBe('receivedDateTime ge 2024-01-01T00:00:00.000Z');
      expect(params.$orderby).toBe('receivedDateTime desc');
      expect(params.$search).toBeUndefined();
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).not.toContain('Keyword search was not applied');
      expect(result.content[0].text).toContain('filter-with-recipient');
      expect(result.content[0].text).toContain('Matched');
      expect(result.content[0].text).not.toContain('Not matched');
    });

    test('from plus dates uses from/emailAddress/address predicate', async () => {
      setupSuccess();

      const result = await handleSearchEmails({
        from: 'jane@example.com',
        receivedBefore: '2024-06-30',
      });

      const params = callGraphAPIPaginated.mock.calls[0][3];
      expect(params.$filter).toBe(
        "receivedDateTime le 2024-06-30T23:59:59.999Z and from/emailAddress/address eq 'jane@example.com'"
      );
      expect(params.$orderby).toBe('receivedDateTime desc');
      expect(params.$search).toBeUndefined();
      expect(result.content[0].text).toContain('filter-with-recipient');
    });

    test('escapes apostrophes by doubling them in recipient predicates', async () => {
      setupSuccess();

      await handleSearchEmails({
        from: "o'brien@x.com",
        receivedAfter: '2024-01-01',
      });

      const params = callGraphAPIPaginated.mock.calls[0][3];
      expect(params.$filter).toContain("from/emailAddress/address eq 'o''brien@x.com'");
    });

    test('recipient predicates come after date and boolean predicates', async () => {
      setupSuccess();

      await handleSearchEmails({
        from: 'jane@example.com',
        receivedAfter: '2024-01-01',
        unreadOnly: true,
      });

      const params = callGraphAPIPaginated.mock.calls[0][3];
      expect(params.$filter).toBe(
        "receivedDateTime ge 2024-01-01T00:00:00.000Z and isRead eq false and from/emailAddress/address eq 'jane@example.com'"
      );
    });

    test('date-only path still reports the plain date-filter-only strategy', async () => {
      setupSuccess();

      const result = await handleSearchEmails({ receivedAfter: '2024-01-01' });

      expect(result.content[0].text).toContain('(Search used date-filter-only strategy)');
      expect(result.content[0].text).not.toContain('Keyword search was not applied');
    });
  });

  describe('never-combined guarantee over every input combination', () => {
    // Every combination of search-term inputs and date/boolean filters the
    // tool accepts. The gate must keep $filter and $search mutually exclusive
    // on EVERY request emitted, regardless of strategy.
    const termVariants = [
      {},
      { query: 'budget' },
      { from: 'alice@example.com' },
      { to: 'bob@example.com' },
      { subject: 'invoice' },
      { query: 'budget', subject: 'q3', from: 'alice@example.com', to: 'bob@example.com' },
    ];
    const dateVariants = [
      {},
      { receivedAfter: '2024-01-01' },
      { receivedBefore: '2024-06-30' },
      { receivedAfter: '2024-01-01', receivedBefore: '2024-06-30' },
    ];
    const booleanVariants = [{}, { unreadOnly: true }, { hasAttachments: true }];

    test.each(
      termVariants.flatMap((terms) =>
        dateVariants.flatMap((dates) =>
          booleanVariants.map((booleans) => ({ ...terms, ...dates, ...booleans }))
        )
      )
    )('never emits $filter and $search together for args %j', async (toolArgs) => {
      setupSuccess();

      await handleSearchEmails(toolArgs);

      for (const params of capturedParamSets()) {
        const hasFilter = typeof params.$filter === 'string';
        const hasSearch = typeof params.$search === 'string';
        if (hasFilter && hasSearch) {
          throw new Error(
            `$filter and $search were combined in one request: ${JSON.stringify(params)}`
          );
        }
      }
    });

    test('date inputs always reach exactly one request without $search', async () => {
      setupSuccess();

      // With dates present the gate must skip strategies 1-2 entirely, so the
      // handler may only emit a single request per run. Keyword-only terms
      // (query/subject) fail loudly instead, with zero Graph calls.
      for (const dates of [
        { receivedAfter: '2024-01-01' },
        { receivedBefore: '2024-06-30' },
        { receivedAfter: '2024-01-01', receivedBefore: '2024-06-30' },
        { to: 'any@example.com', receivedAfter: '2024-01-01' },
      ]) {
        callGraphAPIPaginated.mockClear();
        setupSuccess();
        await handleSearchEmails(dates);
        expect(callGraphAPIPaginated).toHaveBeenCalledTimes(1);
        expect(callGraphAPIPaginated.mock.calls[0][3].$search).toBeUndefined();
      }
    });

    test('keyword terms with dates emit zero Graph requests', async () => {
      setupSuccess();

      await handleSearchEmails({ query: 'any', receivedAfter: '2024-01-01' });

      expect(callGraphAPIPaginated).not.toHaveBeenCalled();
    });
  });

  describe('no-date behavior unchanged', () => {
    test('search terms still route through $search without dates', async () => {
      setupSuccess();

      await handleSearchEmails({ query: 'report' });

      const params = callGraphAPIPaginated.mock.calls[0][3];
      expect(params.$search).toContain('report');
      expect(params.$filter).toBeUndefined();
      expect(params.$orderby).toBeUndefined();
      expect(callGraphAPIPaginated.mock.calls[0][4]).toBe(config.MAX_RESULT_COUNT);
    });

    test('no terms and no dates still falls back to recent emails with $orderby', async () => {
      setupSuccess();

      const result = await handleSearchEmails({});

      const params = callGraphAPIPaginated.mock.calls[0][3];
      expect(params.$orderby).toBe('receivedDateTime desc');
      expect(params.$search).toBeUndefined();
      expect(params.$filter).toBeUndefined();
      expect(result.content[0].text).toContain('Found 2 emails matching your search criteria');
    });

    test('boolean filters without dates still use strategy fallback chain', async () => {
      setupSuccess();

      await handleSearchEmails({ unreadOnly: true });

      const params = callGraphAPIPaginated.mock.calls[0][3];
      expect(params.$filter).toBe('isRead eq false');
      expect(params.$search).toBeUndefined();
      expect(params.$orderby).toBe('receivedDateTime desc');
    });

    test('default count is config.MAX_RESULT_COUNT', async () => {
      setupSuccess();

      await handleSearchEmails({ receivedAfter: '2024-01-01' });

      expect(callGraphAPIPaginated.mock.calls[0][4]).toBe(config.MAX_RESULT_COUNT);
      expect(config.MAX_RESULT_COUNT).toBe(50);
    });

    test('response text has no degradation note without dates', async () => {
      setupSuccess();

      const result = await handleSearchEmails({ query: 'report' });

      expect(result.content[0].text).not.toContain('Keyword search was not applied');
    });
  });

  describe('$search path caps at 1000 results', () => {
    test('count=0 on a $search path passes maxCount=1000, not 0', async () => {
      setupSuccess();

      await handleSearchEmails({ query: 'report', count: 0 });

      // Combined search is the first strategy attempted and carries $search.
      const firstCall = callGraphAPIPaginated.mock.calls[0];
      expect(firstCall[3].$search).toContain('report');
      expect(firstCall[4]).toBe(1000);
    });

    test('count=0 on a single-term $search path also passes maxCount=1000', async () => {
      setupSuccess();
      // Force the combined strategy to find nothing so the single-term
      // strategies run with their own pagination bound.
      callGraphAPIPaginated.mockResolvedValueOnce({ value: [] });

      await handleSearchEmails({ query: 'report', count: 0 });

      const searchCalls = callGraphAPIPaginated.mock.calls.filter(
        (call) => typeof call[3].$search === 'string'
      );
      expect(searchCalls.length).toBeGreaterThan(0);
      for (const call of searchCalls) {
        expect(call[4]).toBe(1000);
      }
    });

    test('count=0 on the date-only filter path still passes maxCount=0 through', async () => {
      setupSuccess();

      await handleSearchEmails({
        receivedAfter: '2024-01-01',
        receivedBefore: '2024-06-30',
        count: 0,
      });

      expect(callGraphAPIPaginated).toHaveBeenCalledTimes(1);
      const onlyCall = callGraphAPIPaginated.mock.calls[0];
      expect(onlyCall[3].$search).toBeUndefined();
      expect(onlyCall[3].$filter).toBe(
        'receivedDateTime ge 2024-01-01T00:00:00.000Z and receivedDateTime le 2024-06-30T23:59:59.999Z'
      );
      expect(onlyCall[4]).toBe(0);
    });

    test('count=0 with boolean filters only keeps maxCount=0 passthrough (no $search)', async () => {
      setupSuccess();

      await handleSearchEmails({ unreadOnly: true, count: 0 });

      // Boolean-only requests ride strategy 1 but emit $filter/$orderby
      // without $search, so the sweep stays unbounded (R3 no-$search clause).
      const onlyCall = callGraphAPIPaginated.mock.calls[0];
      expect(onlyCall[3].$filter).toBe('isRead eq false');
      expect(onlyCall[3].$search).toBeUndefined();
      expect(onlyCall[4]).toBe(0);
    });

    test('maxCount is clamped to 1000 when count exceeds it on a $search path', async () => {
      setupSuccess();

      await handleSearchEmails({ query: 'report', count: 5000 });

      const firstCall = callGraphAPIPaginated.mock.calls[0];
      expect(firstCall[3].$search).toContain('report');
      expect(firstCall[4]).toBe(1000);
    });

    test('flags capReached when a $search path returns exactly 1000 results', async () => {
      setupSuccess();
      const cappedPage = Array.from({ length: 1000 }, (_, i) => ({
        id: `email-${i}`,
        subject: 'Report',
        from: { emailAddress: { name: 'John Doe', address: 'john@example.com' } },
        receivedDateTime: '2024-01-15T10:30:00Z',
        isRead: false,
      }));
      callGraphAPIPaginated.mockResolvedValue({ value: cappedPage });

      const result = await handleSearchEmails({ query: 'report', count: 0 });

      expect(callGraphAPIPaginated.mock.calls[0][4]).toBe(1000);
      expect(result.content[0].text).toContain('Found 1000 emails');
    });
  });

  describe('nextLink passthrough', () => {
    // graph-api is mocked wholesale, so both callGraphAPI and
    // callGraphAPIPaginated come from the same mock registry.
    const { callGraphAPI } = require('../../utils/graph-api');

    test('requests the nextLink URL directly, skipping filter building', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      const nextLink = 'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=abc';
      callGraphAPI.mockResolvedValue({ value: mockEmails });

      const result = await handleSearchEmails({
        nextLink,
        query: 'ignored',
        receivedAfter: '2024-01-01',
      });

      expect(callGraphAPI).toHaveBeenCalledWith(mockAccessToken, 'GET', nextLink, null, {});
      expect(callGraphAPIPaginated).not.toHaveBeenCalled();
      expect(resolveFolderPath).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain('Found 2 emails matching your search criteria');
    });

    test('appends the nextLink line when the page reports more data', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      const nextLink = 'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=def';
      callGraphAPI.mockResolvedValue({ value: mockEmails, nextLink });

      const result = await handleSearchEmails({ nextLink });

      expect(result.content[0].text).toContain(`(nextLink: ${nextLink})`);
    });
  });

  describe('error handling', () => {
    test('should handle authentication error', async () => {
      ensureAuthenticated.mockRejectedValue(new Error('Authentication required'));

      const result = await handleSearchEmails({});

      expect(result.content[0].text).toBe(
        "Authentication required. Please use the 'authenticate' tool first."
      );
      expect(callGraphAPIPaginated).not.toHaveBeenCalled();
    });

    test('should handle folder resolution error', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      resolveFolderPath.mockRejectedValue(new Error('Folder resolution failed'));

      const result = await handleSearchEmails({ folder: 'InvalidFolder' });

      expect(result.content[0].text).toBe('Error searching emails: Folder resolution failed');
    });

    test('should handle Graph API error', async () => {
      setupSuccess();
      callGraphAPIPaginated.mockRejectedValue(new Error('Graph API Error'));

      const result = await handleSearchEmails({ query: 'report' });

      expect(result.content[0].text).toBe('Error searching emails: Graph API Error');
    });

    test('errors client-side on invalid date without calling Graph', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      resolveFolderPath.mockResolvedValue(WELL_KNOWN_FOLDERS['inbox']);

      const result = await handleSearchEmails({ receivedBefore: 'not-a-date' });

      expect(result.content[0].text).toBe(
        'Error searching emails: Invalid receivedBefore: "not-a-date" is not a valid ISO 8601 date (e.g. 2024-01-31 or 2024-01-31T14:30:00Z)'
      );
      expect(callGraphAPIPaginated).not.toHaveBeenCalled();
      expect(resolveFolderPath).not.toHaveBeenCalled();
    });
  });
});
