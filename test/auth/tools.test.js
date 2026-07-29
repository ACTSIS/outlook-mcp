const { handleCheckAuthStatus, handleAuthenticateFlow } = require('../../auth/tools');
const TokenStorage = require('../../auth/token-storage');
const tokenManager = require('../../auth/token-manager');
const config = require('../../config');

jest.mock('../../auth/token-storage');
jest.mock('../../auth/token-manager', () => ({
  createTestTokens: jest.fn(),
}));

describe('auth/tools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('handleCheckAuthStatus', () => {
    it('returns "Authenticated and ready" when getValidAccessToken returns a token', async () => {
      const mockInstance = {
        getValidAccessToken: jest.fn().mockResolvedValue('valid_access_token'),
      };
      TokenStorage.mockImplementation(() => mockInstance);

      const result = await handleCheckAuthStatus();

      expect(TokenStorage).toHaveBeenCalledTimes(1);
      expect(mockInstance.getValidAccessToken).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        content: [{ type: 'text', text: 'Authenticated and ready' }],
      });
    });

    it('returns "Not authenticated" when getValidAccessToken returns null', async () => {
      const mockInstance = {
        getValidAccessToken: jest.fn().mockResolvedValue(null),
      };
      TokenStorage.mockImplementation(() => mockInstance);

      const result = await handleCheckAuthStatus();

      expect(TokenStorage).toHaveBeenCalledTimes(1);
      expect(mockInstance.getValidAccessToken).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        content: [{ type: 'text', text: 'Not authenticated' }],
      });
    });
  });

  describe('handleAuthenticateFlow', () => {
    const originalUseTestMode = config.USE_TEST_MODE;

    beforeEach(() => {
      config.USE_TEST_MODE = false;
    });

    afterEach(() => {
      config.USE_TEST_MODE = originalUseTestMode;
    });

    it('returns URL containing /auth/flow for production mode', async () => {
      const result = await handleAuthenticateFlow({});

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: expect.stringContaining('http://localhost:3333/auth/flow'),
          },
        ],
      });
      expect(result.content[0].text).toContain('Power Automate');
      expect(tokenManager.createTestTokens).not.toHaveBeenCalled();
    });

    it('creates test tokens in test mode', async () => {
      config.USE_TEST_MODE = true;
      tokenManager.createTestTokens.mockReturnValue({
        access_token: 'test-token',
        refresh_token: 'test-refresh',
        expires_at: Date.now() + 3600 * 1000,
      });

      const result = await handleAuthenticateFlow({});

      expect(tokenManager.createTestTokens).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: expect.stringContaining('test mode'),
          },
        ],
      });
    });
  });
});
// Adding a newline at the end of the file
