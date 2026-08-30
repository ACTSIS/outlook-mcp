const {
  handleAuthenticate,
  handleAuthenticateFlow,
  handleCheckAuthStatus,
  handleSetupVault,
  handleStopAuthServer,
} = require('../../auth/tools');
const { tokenStorage } = require('../../auth/index');
const tokenManager = require('../../auth/token-manager');
const config = require('../../config');

jest.mock('../../auth/index', () => ({
  tokenStorage: {
    getValidAccessToken: jest.fn(),
  },
  refreshRuntimeConfiguration: jest.fn(),
}));
jest.mock('../../auth/token-manager', () => ({
  createTestTokens: jest.fn(),
}));
jest.mock('../../auth/auth-server-manager', () => ({
  startAuthServer: jest.fn(),
  stopAuthServer: jest.fn(),
}));
jest.mock('../../runtime/load-runtime-env', () => ({
  loadRuntimeEnv: jest.fn(),
}));

const authServerManager = require('../../auth/auth-server-manager');
const { loadRuntimeEnv } = require('../../runtime/load-runtime-env');

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
      expect(result.content[0]).toEqual({
        type: 'text',
        text: 'http://localhost:3333/auth?client_id=test-client-id',
      });
      expect(result.content[1].text).toContain('Copy and open the URL shown above');
    });

    it('returns the auth URL even when callback-server readiness cannot be confirmed', async () => {
      authServerManager.startAuthServer.mockResolvedValue({
        started: false,
        running: false,
        message: 'Authentication server did not become ready.',
      });

      const result = await handleAuthenticate({});

      expect(result.content[0].text).toBe('http://localhost:3333/auth?client_id=test-client-id');
      expect(result.content[1].text).toContain(
        'The authentication callback server could not be confirmed'
      );
      expect(result.content[1].text).toContain('Copy and open the URL shown above');
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

      expect(result.content[0]).toEqual({
        type: 'text',
        text: 'http://localhost:3333/auth/flow',
      });
      expect(result.content[1].text).toContain('Power Automate');
      expect(result.content[1].text).toContain('Copy and open the URL shown above');
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

  describe('handleSetupVault', () => {
    const { refreshRuntimeConfiguration } = require('../../auth/index');

    it('forces Vault setup, refreshes the singleton, and returns only safe status', async () => {
      loadRuntimeEnv.mockResolvedValue({
        vault: {
          enabled: true,
          loaded: 3,
          source: 'oidc',
          cache: { saved: true },
        },
      });

      const result = await handleSetupVault();

      expect(loadRuntimeEnv).toHaveBeenCalledWith({ force: true, vaultSetup: true });
      expect(refreshRuntimeConfiguration).toHaveBeenCalledTimes(1);
      expect(result.content[0].text).toContain('Vault setup completed');
      expect(result.content[0].text).not.toContain('opaque-vault-token');
      expect(result.content[0].text).not.toContain('opaque-client-secret');
    });

    it('returns an actionable message when Vault is disabled', async () => {
      loadRuntimeEnv.mockResolvedValue({ vault: { enabled: false, loaded: 0 } });

      const result = await handleSetupVault();

      expect(result.content[0].text).toContain('Set VAULT_ADDR');
      expect(refreshRuntimeConfiguration).not.toHaveBeenCalled();
    });

    it('returns a safe status for setup failures without exposing error details', async () => {
      loadRuntimeEnv.mockRejectedValue(new Error('secret-value-and-token-value'));

      const result = await handleSetupVault();

      expect(result.content[0].text).toContain('VAULT_SETUP_FAILED');
      expect(result.content[0].text).not.toContain('secret-value-and-token-value');
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
