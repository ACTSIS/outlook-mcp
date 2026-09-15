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

  describe('terms plus dates degrade to filter-only', () => {
    test('uses $filter only without $search or $orderby', async () => {
      setupSuccess();

      await handleSearchEmails({ query: 'report', receivedAfter: '2024-01-01' });

      expect(callGraphAPIPaginated).toHaveBeenCalledTimes(1);
      const params = callGraphAPIPaginated.mock.calls[0][3];
      expect(params.$filter).toBe('receivedDateTime ge 2024-01-01T00:00:00.000Z');
      expect(params.$search).toBeUndefined();
      expect(params.$orderby).toBeUndefined();
    });

    test('appends degradation note to the response text', async () => {
      setupSuccess();

      const result = await handleSearchEmails({
        query: 'report',
        receivedAfter: '2024-01-01',
      });

      expect(result.content[0].text).toContain(
        '(Keyword search was not applied: date filters cannot be combined with $search in Graph API)'
      );
    });

    test('field-based terms also degrade without $orderby', async () => {
      setupSuccess();

      await handleSearchEmails({
        from: 'jane@example.com',
        subject: 'lunch',
        receivedBefore: '2024-06-30',
      });

      const params = callGraphAPIPaginated.mock.calls[0][3];
      expect(params.$filter).toBe('receivedDateTime le 2024-06-30T23:59:59.999Z');
      expect(params.$search).toBeUndefined();
      expect(params.$orderby).toBeUndefined();
    });

    test('degraded response combines dates with booleans, dates first', async () => {
      setupSuccess();

      await handleSearchEmails({
        query: 'report',
        receivedAfter: '2024-01-01',
        unreadOnly: true,
      });

      const params = callGraphAPIPaginated.mock.calls[0][3];
      expect(params.$filter).toBe(
        'receivedDateTime ge 2024-01-01T00:00:00.000Z and isRead eq false'
      );
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
      // handler may only emit a single request per run.
      for (const dates of [
        { receivedAfter: '2024-01-01' },
        { receivedBefore: '2024-06-30' },
        { receivedAfter: '2024-01-01', receivedBefore: '2024-06-30' },
        { query: 'any', receivedAfter: '2024-01-01' },
      ]) {
        callGraphAPIPaginated.mockClear();
        setupSuccess();
        await handleSearchEmails(dates);
        expect(callGraphAPIPaginated).toHaveBeenCalledTimes(1);
        expect(callGraphAPIPaginated.mock.calls[0][3].$search).toBeUndefined();
      }
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
