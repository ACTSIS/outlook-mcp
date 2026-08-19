const {
  handleAuthenticate,
  handleAuthenticateFlow,
  handleCheckAuthStatus,
  handleStopAuthServer,
} = require('../../auth/tools');
const { tokenStorage } = require('../../auth/index');
const tokenManager = require('../../auth/token-manager');
const config = require('../../config');

jest.mock('../../auth/index', () => ({
  tokenStorage: {
    getValidAccessToken: jest.fn(),
  },
}));
jest.mock('../../auth/token-manager', () => ({
  createTestTokens: jest.fn(),
}));
jest.mock('../../auth/auth-server-manager', () => ({
  startAuthServer: jest.fn(),
  stopAuthServer: jest.fn(),
}));

const authServerManager = require('../../auth/auth-server-manager');

describe('auth/tools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    authServerManager.startAuthServer.mockResolvedValue({
      started: true,
      running: true,
      message: 'Authentication server started.',
    });
  });

  describe('handleAuthenticate', () => {
    const originalUseTestMode = config.USE_TEST_MODE;
    const originalClientId = config.AUTH_CONFIG.clientId;

    beforeEach(() => {
      config.USE_TEST_MODE = false;
      config.AUTH_CONFIG.clientId = 'test-client-id';
    });

    afterEach(() => {
      config.USE_TEST_MODE = originalUseTestMode;
      config.AUTH_CONFIG.clientId = originalClientId;
    });

    it('starts the callback server and returns a complete auth URL', async () => {
      const result = await handleAuthenticate({});

      expect(authServerManager.startAuthServer).toHaveBeenCalledTimes(1);
      expect(result.content[0].text).toContain(
        'http://localhost:3333/auth?client_id=test-client-id'
      );
    });

    it('reports callback-server startup failures without returning a dead URL', async () => {
      authServerManager.startAuthServer.mockResolvedValue({
        started: false,
        running: false,
        message: 'Authentication server did not become ready.',
      });

      const result = await handleAuthenticate({});

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: 'Authentication server could not be started. Authentication server did not become ready.',
          },
        ],
      });
    });
  });

  describe('handleCheckAuthStatus', () => {
    it('returns "Authenticated and ready" when getValidAccessToken returns a token', async () => {
      tokenStorage.getValidAccessToken.mockResolvedValue('valid_access_token');

      const result = await handleCheckAuthStatus();

      expect(tokenStorage.getValidAccessToken).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        content: [{ type: 'text', text: 'Authenticated and ready' }],
      });
    });

    it('returns "Not authenticated" when getValidAccessToken returns null', async () => {
      tokenStorage.getValidAccessToken.mockResolvedValue(null);

      const result = await handleCheckAuthStatus();

      expect(tokenStorage.getValidAccessToken).toHaveBeenCalledTimes(1);
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
      expect(authServerManager.startAuthServer).toHaveBeenCalledTimes(1);
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
      expect(authServerManager.startAuthServer).not.toHaveBeenCalled();
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

  describe('handleStopAuthServer', () => {
    it('delegates stopping the callback server to the manager', async () => {
      authServerManager.stopAuthServer.mockResolvedValue({
        stopped: true,
        message: 'Authentication server stopped (pid 1234).',
      });

      const result = await handleStopAuthServer();

      expect(authServerManager.stopAuthServer).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        content: [{ type: 'text', text: 'Authentication server stopped (pid 1234).' }],
      });
    });
  });
});
// Adding a newline at the end of the file
