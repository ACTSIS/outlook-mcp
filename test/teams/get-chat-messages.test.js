const handleGetChatMessages = require('../../teams/get-chat-messages');
const { callGraphAPI, callGraphAPIPaginated } = require('../../utils/graph-api');
const { ensureAuthenticated } = require('../../auth');

jest.mock('../../utils/graph-api');
jest.mock('../../auth');

describe('handleGetChatMessages', () => {
  const mockAccessToken = 'dummy_access_token';
  const mockMessages = [
    {
      id: 'msg-1',
      createdDateTime: '2024-03-15T10:30:00Z',
      body: { contentType: 'text', content: 'First message' },
      from: { user: { displayName: 'Alice', id: 'user-1' } },
    },
    {
      id: 'msg-2',
      createdDateTime: '2024-03-14T09:00:00Z',
      body: { contentType: 'text', content: 'Second message' },
      from: { user: { displayName: 'Bob', id: 'user-2' } },
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

  describe('validation', () => {
    test('should reject a missing chatId before authenticating', async () => {
      const result = await handleGetChatMessages({});

      expect(result.content[0].text).toContain('Chat ID (chatId) is required');
      expect(ensureAuthenticated).not.toHaveBeenCalled();
      expect(callGraphAPIPaginated).not.toHaveBeenCalled();
    });

    test('should reject an invalid receivedAfter value client-side', async () => {
      const result = await handleGetChatMessages({ chatId: 'chat-1', receivedAfter: 'not-a-date' });

      expect(result.content[0].text).toContain('Invalid receivedAfter');
      expect(ensureAuthenticated).not.toHaveBeenCalled();
    });

    test('should reject an invalid receivedBefore value client-side', async () => {
      const result = await handleGetChatMessages({
        chatId: 'chat-1',
        receivedBefore: 'not-a-date',
      });

      expect(result.content[0].text).toContain('Invalid receivedBefore');
      expect(ensureAuthenticated).not.toHaveBeenCalled();
    });
  });

  describe('successful retrieval', () => {
    test('should read messages from the requested chat', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      callGraphAPIPaginated.mockResolvedValue({ value: mockMessages });

      const result = await handleGetChatMessages({ chatId: 'chat-1' });

      expect(ensureAuthenticated).toHaveBeenCalledTimes(1);
      expect(callGraphAPIPaginated).toHaveBeenCalledWith(
        mockAccessToken,
        'GET',
        `chats/${encodeURIComponent('chat-1')}/messages`,
        expect.objectContaining({ $top: 50 }),
        50
      );
      expect(result.content[0].text).toContain('Found 2 messages');
      expect(result.content[0].text).toContain('First message');
      expect(result.content[0].text).toContain('Alice');
      expect(result.content[0].text).toContain('ID: msg-1');
    });

    test('should encode special characters in the chat ID path segment', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      callGraphAPIPaginated.mockResolvedValue({ value: mockMessages });

      await handleGetChatMessages({ chatId: '19:meeting@thread/abc' });

      expect(callGraphAPIPaginated).toHaveBeenCalledWith(
        mockAccessToken,
        'GET',
        'chats/19%3Ameeting%40thread%2Fabc/messages',
        expect.any(Object),
        expect.any(Number)
      );
    });

    test('should apply the date range as a client-side filter on createdDateTime', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      callGraphAPIPaginated.mockResolvedValue({ value: mockMessages });

      const result = await handleGetChatMessages({
        chatId: 'chat-1',
        receivedAfter: '2024-03-15',
      });

      expect(result.content[0].text).toContain('Found 1 messages');
      expect(result.content[0].text).toContain('First message');
      expect(result.content[0].text).not.toContain('Second message');
    });

    test('should apply receivedBefore as an inclusive upper bound', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      callGraphAPIPaginated.mockResolvedValue({ value: mockMessages });

      const result = await handleGetChatMessages({
        chatId: 'chat-1',
        receivedBefore: '2024-03-14',
      });

      expect(result.content[0].text).toContain('Second message');
      expect(result.content[0].text).not.toContain('First message');
    });

    test('should follow a nextLink passthrough instead of building a query', async () => {
      const nextLink = 'https://graph.microsoft.com/v1.0/chats/chat-1/messages?$skip=1';
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      callGraphAPI.mockResolvedValue({ value: mockMessages });

      const result = await handleGetChatMessages({ chatId: 'chat-1', nextLink });

      expect(callGraphAPI).toHaveBeenCalledWith(mockAccessToken, 'GET', nextLink, null, {});
      expect(callGraphAPIPaginated).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain('Found 2 messages');
    });

    test('should format HTML messages with their content type', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      callGraphAPIPaginated.mockResolvedValue({
        value: [
          {
            id: 'msg-3',
            createdDateTime: '2024-03-15T11:00:00Z',
            body: { contentType: 'html', content: '<b>Bold statement</b>' },
            from: { user: { displayName: 'Alice', id: 'user-1' } },
          },
        ],
      });

      const result = await handleGetChatMessages({ chatId: 'chat-1' });

      expect(result.content[0].text).toContain('[html]');
    });
  });

  describe('empty results', () => {
    test('should state that no messages were found', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      callGraphAPIPaginated.mockResolvedValue({ value: [] });

      const result = await handleGetChatMessages({ chatId: 'chat-1' });

      expect(result.content[0].text).toBe('No messages found in this chat.');
    });

    test('should state when the date range excludes every message', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      callGraphAPIPaginated.mockResolvedValue({ value: mockMessages });

      const result = await handleGetChatMessages({
        chatId: 'chat-1',
        receivedAfter: '2030-01-01',
      });

      expect(result.content[0].text).toBe('No messages found in this chat.');
    });
  });

  describe('error handling', () => {
    test('should handle authentication error without calling the API', async () => {
      ensureAuthenticated.mockRejectedValue(new Error('Authentication required'));

      const result = await handleGetChatMessages({ chatId: 'chat-1' });

      expect(result.content[0].text).toBe(
        "Authentication required. Please use the 'authenticate' tool first."
      );
      expect(callGraphAPIPaginated).not.toHaveBeenCalled();
    });

    test('should propagate Graph API errors', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      callGraphAPIPaginated.mockRejectedValue(new Error('Graph API Error'));

      const result = await handleGetChatMessages({ chatId: 'chat-1' });

      expect(result.content[0].text).toBe('Error reading chat messages: Graph API Error');
    });

    test('should surface UNAUTHORIZED when Graph rejects the token', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      callGraphAPIPaginated.mockRejectedValue(new Error('UNAUTHORIZED'));

      const result = await handleGetChatMessages({ chatId: 'chat-1' });

      expect(result.content[0].text).toBe('Error reading chat messages: UNAUTHORIZED');
    });
  });
});
