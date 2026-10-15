const handleListChats = require('../../teams/list-chats');
const { callGraphAPI, callGraphAPIPaginated } = require('../../utils/graph-api');
const { ensureAuthenticated } = require('../../auth');
const config = require('../../config');

jest.mock('../../utils/graph-api');
jest.mock('../../auth');

describe('handleListChats', () => {
  const mockAccessToken = 'dummy_access_token';
  const mockChats = [
    {
      id: 'chat-1',
      topic: 'Project Alpha',
      lastMessagePreview: 'Last message body',
      lastUpdatedDateTime: '2024-03-15T10:30:00Z',
    },
    {
      id: 'chat-2',
      topic: 'One-on-one',
      lastMessagePreview: 'Hello there',
      lastUpdatedDateTime: '2024-03-14T09:00:00Z',
    },
  ];

  beforeEach(() => {
    callGraphAPI.mockClear();
    callGraphAPIPaginated.mockClear();
    ensureAuthenticated.mockClear();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    console.error.mockRestore();
  });

  describe('successful retrieval', () => {
    test('should list chats with the default count', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      callGraphAPIPaginated.mockResolvedValue({ value: mockChats });

      const result = await handleListChats({});

      expect(ensureAuthenticated).toHaveBeenCalledTimes(1);
      expect(callGraphAPIPaginated).toHaveBeenCalledWith(
        mockAccessToken,
        'GET',
        'me/chats',
        expect.objectContaining({
          $top: config.MAX_RESULT_COUNT,
          $select: config.CHAT_SELECT_FIELDS,
        }),
        config.CHATS_SWEEP_LIMIT
      );
      expect(result.content[0].text).toContain('Found 2 chats');
      expect(result.content[0].text).toContain('Project Alpha');
      expect(result.content[0].text).toContain('ID: chat-1');
    });

    test('should respect a custom count parameter', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      // The sweep always pages up to CHATS_SWEEP_LIMIT; the custom count only
      // bounds the rendered result.
      callGraphAPIPaginated.mockResolvedValue({ value: [mockChats[0], mockChats[1]] });

      const result = await handleListChats({ count: 1 });

      expect(callGraphAPIPaginated).toHaveBeenCalledWith(
        mockAccessToken,
        'GET',
        'me/chats',
        expect.objectContaining({ $top: 1 }),
        config.CHATS_SWEEP_LIMIT
      );
      expect(result.content[0].text).toContain('Found 1 chats');
    });

    test('should expose the pagination cursor when more pages exist', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      callGraphAPIPaginated.mockResolvedValue({
        value: [mockChats[0]],
        nextLink: 'https://graph.microsoft.com/v1.0/me/chats?$skip=1',
      });

      const result = await handleListChats({ count: 1 });

      expect(result.content[0].text).toContain(
        'nextLink: https://graph.microsoft.com/v1.0/me/chats?$skip=1'
      );
    });

    test('should follow a nextLink passthrough instead of building a query', async () => {
      const nextLink = 'https://graph.microsoft.com/v1.0/me/chats?$skip=1';
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      callGraphAPI.mockResolvedValue({ value: mockChats });

      const result = await handleListChats({ nextLink });

      expect(callGraphAPI).toHaveBeenCalledWith(mockAccessToken, 'GET', nextLink, null, {});
      expect(callGraphAPIPaginated).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain('Found 2 chats');
    });

    test('should surface an unnamed topic for chats without one', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      callGraphAPIPaginated.mockResolvedValue({
        value: [
          {
            id: 'chat-3',
            lastMessagePreview: 'Hi',
            lastUpdatedDateTime: '2024-03-13T08:00:00Z',
          },
        ],
      });

      const result = await handleListChats({});

      expect(result.content[0].text).toContain('(unnamed chat)');
    });
  });

  describe('empty results', () => {
    test('should state that no chats were found', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      callGraphAPIPaginated.mockResolvedValue({ value: [] });

      const result = await handleListChats({});

      expect(result.content[0].text).toBe('No chats found.');
    });
  });

  describe('error handling', () => {
    test('should handle authentication error without calling the API', async () => {
      ensureAuthenticated.mockRejectedValue(new Error('Authentication required'));

      const result = await handleListChats({});

      expect(result.content[0].text).toBe(
        "Authentication required. Please use the 'authenticate' tool first."
      );
      expect(callGraphAPIPaginated).not.toHaveBeenCalled();
    });

    test('should propagate Graph API errors', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      callGraphAPIPaginated.mockRejectedValue(new Error('Graph API Error'));

      const result = await handleListChats({});

      expect(result.content[0].text).toBe('Error listing chats: Graph API Error');
    });

    test('should surface UNAUTHORIZED when Graph rejects the token', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      callGraphAPIPaginated.mockRejectedValue(new Error('UNAUTHORIZED'));

      const result = await handleListChats({});

      expect(result.content[0].text).toBe('Error listing chats: UNAUTHORIZED');
    });
  });

  describe('activity ordering (issue #35)', () => {
    test('sweeps unsorted pages and renders newest-first', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      // Graph pages accumulate unsorted (issue #35): the older chat can arrive
      // before the fresher one within the swept value array.
      callGraphAPIPaginated.mockResolvedValue({
        value: [
          { id: 'chat-old', topic: 'Old chat', lastUpdatedDateTime: '2024-01-01T00:00:00Z' },
          { id: 'chat-new', topic: 'Fresh chat', lastUpdatedDateTime: '2025-01-05T00:00:00Z' },
        ],
      });

      const result = await handleListChats({ count: 2 });

      const text = result.content[0].text;
      expect(text.indexOf('1. Fresh chat')).toBeGreaterThan(-1);
      expect(text.indexOf('Old chat')).toBeGreaterThan(text.indexOf('Fresh chat'));
    });
  });
});
