const handleSendChatMessage = require('../../teams/send-chat-message');
const { callGraphAPI } = require('../../utils/graph-api');
const { ensureAuthenticated } = require('../../auth');

jest.mock('../../utils/graph-api');
jest.mock('../../auth');

describe('handleSendChatMessage', () => {
  const mockAccessToken = 'dummy_access_token';

  beforeEach(() => {
    callGraphAPI.mockClear();
    ensureAuthenticated.mockClear();
    callGraphAPI.mockResolvedValue({});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    console.error.mockRestore();
  });

  describe('validation', () => {
    test('should reject a missing chatId before authenticating', async () => {
      const result = await handleSendChatMessage({ content: 'Hello' });

      expect(result.content[0].text).toContain('Chat ID (chatId) is required');
      expect(ensureAuthenticated).not.toHaveBeenCalled();
      expect(callGraphAPI).not.toHaveBeenCalled();
    });

    test('should reject missing message content before authenticating', async () => {
      const result = await handleSendChatMessage({ chatId: 'chat-1' });

      expect(result.content[0].text).toContain('Message content is required');
      expect(ensureAuthenticated).not.toHaveBeenCalled();
      expect(callGraphAPI).not.toHaveBeenCalled();
    });

    test('should reject an unsupported contentType', async () => {
      const result = await handleSendChatMessage({
        chatId: 'chat-1',
        content: 'Hello',
        contentType: 'markdown',
      });

      expect(result.content[0].text).toContain('contentType must be one of: text, html');
      expect(ensureAuthenticated).not.toHaveBeenCalled();
      expect(callGraphAPI).not.toHaveBeenCalled();
    });
  });

  describe('successful send', () => {
    test('should POST the message with plain text by default', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);

      const result = await handleSendChatMessage({ chatId: 'chat-1', content: 'Hello team' });

      expect(ensureAuthenticated).toHaveBeenCalledTimes(1);
      expect(callGraphAPI).toHaveBeenCalledWith(
        mockAccessToken,
        'POST',
        `chats/${encodeURIComponent('chat-1')}/messages`,
        { body: { contentType: 'text', content: 'Hello team' } }
      );
      expect(result.content[0].text).toContain('Chat message sent successfully');
      expect(result.content[0].text).toContain('text');
    });

    test('should honor an explicit html content type', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);

      const result = await handleSendChatMessage({
        chatId: 'chat-1',
        content: '<b>Hello</b>',
        contentType: 'html',
      });

      expect(callGraphAPI).toHaveBeenCalledWith(
        mockAccessToken,
        'POST',
        `chats/${encodeURIComponent('chat-1')}/messages`,
        { body: { contentType: 'html', content: '<b>Hello</b>' } }
      );
      expect(result.content[0].text).toContain('html');
    });

    test('should encode special characters in the chat ID path segment', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);

      await handleSendChatMessage({ chatId: '19:meeting@thread/abc', content: 'Hi' });

      expect(callGraphAPI).toHaveBeenCalledWith(
        mockAccessToken,
        'POST',
        'chats/19%3Ameeting%40thread%2Fabc/messages',
        expect.any(Object)
      );
    });
  });

  describe('error handling', () => {
    test('should handle authentication error without calling the API', async () => {
      ensureAuthenticated.mockRejectedValue(new Error('Authentication required'));

      const result = await handleSendChatMessage({ chatId: 'chat-1', content: 'Hello' });

      expect(result.content[0].text).toBe(
        "Authentication required. Please use the 'authenticate' tool first."
      );
      expect(callGraphAPI).not.toHaveBeenCalled();
    });

    test('should propagate Graph API errors', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      callGraphAPI.mockRejectedValue(new Error('Graph API Error'));

      const result = await handleSendChatMessage({ chatId: 'chat-1', content: 'Hello' });

      expect(result.content[0].text).toBe('Error sending chat message: Graph API Error');
    });

    test('should surface UNAUTHORIZED when Graph rejects the token', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      callGraphAPI.mockRejectedValue(new Error('UNAUTHORIZED'));

      const result = await handleSendChatMessage({ chatId: 'chat-1', content: 'Hello' });

      expect(result.content[0].text).toBe('Error sending chat message: UNAUTHORIZED');
    });
  });
});
