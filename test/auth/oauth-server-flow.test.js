const querystring = require('querystring');
const fs = require('fs');
const config = require('../../config');

const FLOW_SCOPE = config.FLOW_SCOPE;

function createMockResponse() {
  return {
    writeHead: jest.fn(),
    end: jest.fn(),
  };
}

function createMockRequest(url) {
  return { url, method: 'GET' };
}

function createMockHttps(
  responseStatus,
  responseBody,
  shouldError = false,
  requestError = new Error('Network error')
) {
  return jest.fn((options, callback) => {
    const mockReq = {
      write: jest.fn((data) => {
        options.body = data;
      }),
      end: jest.fn(() => {
        if (shouldError) {
          const errorHandler = mockReq.on.mock.calls.find((call) => call[0] === 'error')?.[1];
          if (errorHandler) errorHandler(requestError);
          return;
        }

        const mockRes = {
          statusCode: responseStatus,
          on: jest.fn((event, handler) => {
            if (event === 'data') {
              setImmediate(() => handler(Buffer.from(JSON.stringify(responseBody))));
            }
            if (event === 'end') {
              setImmediate(() => handler());
            }
          }),
        };

        callback(mockRes);
      }),
      on: jest.fn(),
    };

    return mockReq;
  });
}

describe('outlook-auth-server.js Flow support', () => {
  let createRequestHandler;
  let exchangeCodeForTokens;
  let pendingStates;
  let mockSaveFlowTokens;
  let writeFileSyncSpy;
  let handler;
  let httpsMock;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    pendingStates = new Map();
    mockSaveFlowTokens = jest.fn().mockResolvedValue();
    writeFileSyncSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    httpsMock = jest.fn();

    const authIndex = {
      tokenStorage: { saveFlowTokens: mockSaveFlowTokens },
    };

    ({ createRequestHandler, exchangeCodeForTokens } = require('../../outlook-auth-server'));

    handler = createRequestHandler({
      pendingStates,
      exchangeCodeForTokens,
      authConfig: {
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        tenantId: 'common',
        authorityHost: 'https://login.microsoftonline.com',
        redirectUri: config.AUTH_CONFIG.redirectUri,
        scopes: config.AUTH_CONFIG.scopes,
      },
      flowScope: FLOW_SCOPE,
      tokenStorage: authIndex.tokenStorage,
      https: { request: httpsMock },
    });
  });

  afterEach(() => {
    writeFileSyncSpy.mockRestore();
  });

  describe('pendingStates value shape', () => {
    it('stores {timestamp, flow} objects for /auth/flow generated states', () => {
      const res = createMockResponse();
      handler(createMockRequest('/auth/flow'), res);

      expect(pendingStates.size).toBe(1);
      const entry = pendingStates.values().next().value;
      expect(entry).toHaveProperty('timestamp');
      expect(typeof entry.timestamp).toBe('number');
      expect(entry.flow).toBe(true);
    });

    it('still supports cleanup by entry.timestamp', () => {
      const now = Date.now();
      pendingStates.set('old', { timestamp: now - 11 * 60 * 1000, flow: true });
      pendingStates.set('recent', { timestamp: now, flow: true });

      for (const [key, entry] of pendingStates.entries()) {
        if (now - entry.timestamp > 10 * 60 * 1000) {
          pendingStates.delete(key);
        }
      }

      expect(pendingStates.has('old')).toBe(false);
      expect(pendingStates.has('recent')).toBe(true);
    });
  });

  describe('GET /auth/flow route', () => {
    it('redirects to Microsoft OAuth with FLOW_SCOPE only', () => {
      const res = createMockResponse();
      handler(createMockRequest('/auth/flow'), res);

      expect(res.writeHead).toHaveBeenCalledWith(302, expect.any(Object));
      const location = res.writeHead.mock.calls[0][1].Location;
      expect(location).toContain('/oauth2/v2.0/authorize');
      const params = new URL(location).searchParams;
      expect(params.get('scope')).toBe(FLOW_SCOPE);
      expect(params.get('response_type')).toBe('code');
      expect(params.get('client_id')).toBe('test-client-id');
      expect(params.get('redirect_uri')).toBe(config.AUTH_CONFIG.redirectUri);
      expect(params.get('state')).toBeDefined();
    });

    it('returns 500 when credentials are missing', () => {
      const localHandler = createRequestHandler({
        pendingStates,
        exchangeCodeForTokens,
        authConfig: {
          clientId: '',
          clientSecret: '',
          tenantId: 'common',
          authorityHost: 'https://login.microsoftonline.com',
          redirectUri: config.AUTH_CONFIG.redirectUri,
          scopes: config.AUTH_CONFIG.scopes,
        },
        flowScope: FLOW_SCOPE,
        tokenStorage: { saveFlowTokens: mockSaveFlowTokens },
        https: { request: httpsMock },
      });

      const res = createMockResponse();
      localHandler(createMockRequest('/auth/flow'), res);

      expect(res.writeHead).toHaveBeenCalledWith(500, { 'Content-Type': 'text/html' });
      expect(res.end.mock.calls[0][0]).toContain('Configuration Error');
    });
  });

  describe('/auth/callback Flow detection', () => {
    it('detects Flow via pendingStates flow flag and sends FLOW_SCOPE in token POST', async () => {
      const res = createMockResponse();
      handler(createMockRequest('/auth/flow'), res);
      const state = new URL(res.writeHead.mock.calls[0][1].Location).searchParams.get('state');

      httpsMock.mockImplementation(
        createMockHttps(200, {
          access_token: 'flow-access-token',
          refresh_token: 'flow-refresh-token',
          expires_in: 3600,
          scope: FLOW_SCOPE,
        })
      );

      const callbackRes = createMockResponse();
      await new Promise((resolve) => {
        handler(createMockRequest(`/auth/callback?code=flow-code&state=${state}`), callbackRes);
        setImmediate(resolve);
      });

      const lastHttpsCall = httpsMock.mock.calls[httpsMock.mock.calls.length - 1];
      const postData = lastHttpsCall[0].body || lastHttpsCall[1];
      expect(querystring.parse(postData).scope).toBe(FLOW_SCOPE);
      expect(mockSaveFlowTokens).toHaveBeenCalledTimes(1);
      expect(writeFileSyncSpy).not.toHaveBeenCalled();
      expect(callbackRes.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'text/html' });
      expect(callbackRes.end.mock.calls[0][0]).toContain('Flow Authentication Successful');
    });

    it('preserves Graph tokens when saving Flow tokens', async () => {
      const res = createMockResponse();
      handler(createMockRequest('/auth/flow'), res);
      const state = new URL(res.writeHead.mock.calls[0][1].Location).searchParams.get('state');

      httpsMock.mockImplementation(
        createMockHttps(200, {
          access_token: 'flow-access-token',
          refresh_token: 'flow-refresh-token',
          expires_in: 3600,
          scope: FLOW_SCOPE,
        })
      );

      const callbackRes = createMockResponse();
      await new Promise((resolve) => {
        handler(createMockRequest(`/auth/callback?code=flow-code&state=${state}`), callbackRes);
        setImmediate(resolve);
      });

      const savedArg = mockSaveFlowTokens.mock.calls[0][0];
      expect(savedArg.access_token).toBe('flow-access-token');
      expect(savedArg.refresh_token).toBe('flow-refresh-token');
      expect(savedArg.expires_at).toBeDefined();
    });

    it('returns a Flow-specific error page when token exchange fails', async () => {
      const res = createMockResponse();
      handler(createMockRequest('/auth/flow'), res);
      const state = new URL(res.writeHead.mock.calls[0][1].Location).searchParams.get('state');

      httpsMock.mockImplementation(
        createMockHttps(400, { error: 'invalid_grant', error_description: 'Bad grant' })
      );

      const callbackRes = createMockResponse();
      await new Promise((resolve) => {
        handler(createMockRequest(`/auth/callback?code=flow-code&state=${state}`), callbackRes);
        setImmediate(resolve);
      });

      expect(callbackRes.writeHead).toHaveBeenCalledWith(500, { 'Content-Type': 'text/html' });
      expect(callbackRes.end.mock.calls[0][0]).toContain('Flow authentication failed');
      expect(writeFileSyncSpy).not.toHaveBeenCalled();
      expect(mockSaveFlowTokens).not.toHaveBeenCalled();
    });

    it.each([
      ['Graph', false, '/auth', 'Microsoft Graph token exchange'],
      ['Flow', true, '/auth/flow', 'Power Automate token exchange'],
    ])(
      'contextualizes a certificate failure for %s token exchange',
      async (_name, _isFlow, authPath, operation) => {
        const startResponse = createMockResponse();
        handler(createMockRequest(authPath), startResponse);
        const state = new URL(startResponse.writeHead.mock.calls[0][1].Location).searchParams.get(
          'state'
        );
        const certificateError = Object.assign(
          new Error('self-signed certificate in certificate chain'),
          { code: 'SELF_SIGNED_CERT_IN_CHAIN' }
        );
        httpsMock.mockImplementation(createMockHttps(0, {}, true, certificateError));

        const callbackResponse = createMockResponse();
        await new Promise((resolve) => {
          handler(
            createMockRequest(`/auth/callback?code=auth-code&state=${state}`),
            callbackResponse
          );
          setImmediate(resolve);
        });

        const page = callbackResponse.end.mock.calls[0][0];
        expect(page).toContain(`${operation} failed while connecting to`);
        expect(page).toContain('https://login.microsoftonline.com/common/oauth2/v2.0/token');
        expect(page).toContain('self-signed certificate in certificate chain');
        expect(page).toContain('(SELF_SIGNED_CERT_IN_CHAIN)');
        expect(page).toContain('Check network TLS trust/proxy configuration.');
        expect(page).not.toContain('test-client-secret');
        expect(page).not.toContain('auth-code');
        expect(page).not.toContain('?');
      }
    );

    it('does not invalidate the Vault cache when the user cancels Entra sign-in', async () => {
      const localStates = new Map();
      const invalidateVaultTokenCache = jest.fn().mockResolvedValue({ deleted: true });
      const localHandler = createRequestHandler({
        pendingStates: localStates,
        exchangeCodeForTokens,
        authConfig: {
          clientId: 'test-client-id',
          clientSecret: 'test-client-secret',
          tenantId: 'common',
          authorityHost: 'https://login.microsoftonline.com',
          redirectUri: config.AUTH_CONFIG.redirectUri,
          scopes: config.AUTH_CONFIG.scopes,
        },
        flowScope: FLOW_SCOPE,
        tokenStorage: { saveFlowTokens: mockSaveFlowTokens },
        https: { request: httpsMock },
        getVaultConfig: jest.fn().mockReturnValue({
          enabled: true,
          address: 'https://vault.example.test',
        }),
        invalidateVaultTokenCache,
      });
      const startResponse = createMockResponse();
      localHandler(createMockRequest('/auth'), startResponse);
      const state = new URL(startResponse.writeHead.mock.calls[0][1].Location).searchParams.get(
        'state'
      );

      const callbackResponse = createMockResponse();
      localHandler(
        createMockRequest(
          `/auth/callback?state=${state}&error=access_denied&error_description=AADSTS65004%3A%20User%20declined%20to%20consent`
        ),
        callbackResponse
      );
      await new Promise((resolve) => setImmediate(resolve));

      expect(invalidateVaultTokenCache).not.toHaveBeenCalled();
      expect(callbackResponse.writeHead).toHaveBeenCalledWith(400, {
        'Content-Type': 'text/html',
      });
    });
  });

  describe('exchangeCodeForTokens', () => {
    it('Flow path calls saveFlowTokens and not fs.writeFileSync', async () => {
      httpsMock.mockImplementation(
        createMockHttps(200, {
          access_token: 'flow-access-token',
          refresh_token: 'flow-refresh-token',
          expires_in: 3600,
          scope: FLOW_SCOPE,
        })
      );

      await exchangeCodeForTokens('flow-code', true, {
        authConfig: {
          clientId: 'test-client-id',
          clientSecret: 'test-client-secret',
          tenantId: 'common',
          authorityHost: 'https://login.microsoftonline.com',
          redirectUri: config.AUTH_CONFIG.redirectUri,
          scopes: config.AUTH_CONFIG.scopes,
        },
        flowScope: FLOW_SCOPE,
        tokenStorage: { saveFlowTokens: mockSaveFlowTokens },
        https: { request: httpsMock },
      });

      expect(mockSaveFlowTokens).toHaveBeenCalledTimes(1);
      expect(writeFileSyncSpy).not.toHaveBeenCalled();
    });

    it('Graph path keeps raw fs.writeFileSync and does not call saveFlowTokens', async () => {
      httpsMock.mockImplementation(
        createMockHttps(200, {
          access_token: 'graph-access-token',
          refresh_token: 'graph-refresh-token',
          expires_in: 3600,
          scope: 'Mail.Read',
        })
      );

      await exchangeCodeForTokens('graph-code', false, {
        authConfig: {
          clientId: 'test-client-id',
          clientSecret: 'test-client-secret',
          tenantId: 'common',
          authorityHost: 'https://login.microsoftonline.com',
          redirectUri: config.AUTH_CONFIG.redirectUri,
          scopes: config.AUTH_CONFIG.scopes,
        },
        flowScope: FLOW_SCOPE,
        tokenStorage: { saveFlowTokens: mockSaveFlowTokens },
        https: { request: httpsMock },
      });

      expect(mockSaveFlowTokens).not.toHaveBeenCalled();
      expect(writeFileSyncSpy).toHaveBeenCalledTimes(1);
      const written = JSON.parse(writeFileSyncSpy.mock.calls[0][1]);
      expect(written.access_token).toBe('graph-access-token');
      expect(written.expires_at).toBeDefined();
    });

    it('Flow path uses FLOW_SCOPE in token POST body', async () => {
      httpsMock.mockImplementation(
        createMockHttps(200, {
          access_token: 'flow-access-token',
          refresh_token: 'flow-refresh-token',
          expires_in: 3600,
          scope: FLOW_SCOPE,
        })
      );

      await exchangeCodeForTokens('flow-code', true, {
        authConfig: {
          clientId: 'test-client-id',
          clientSecret: 'test-client-secret',
          tenantId: 'common',
          authorityHost: 'https://login.microsoftonline.com',
          redirectUri: config.AUTH_CONFIG.redirectUri,
          scopes: config.AUTH_CONFIG.scopes,
        },
        flowScope: FLOW_SCOPE,
        tokenStorage: { saveFlowTokens: mockSaveFlowTokens },
        https: { request: httpsMock },
      });

      const lastCall = httpsMock.mock.calls[httpsMock.mock.calls.length - 1];
      const postData = lastCall[0].body || lastCall[1];
      expect(querystring.parse(postData).scope).toBe(FLOW_SCOPE);
    });

    it('Graph path uses Graph scopes in token POST body', async () => {
      httpsMock.mockImplementation(
        createMockHttps(200, {
          access_token: 'graph-access-token',
          refresh_token: 'graph-refresh-token',
          expires_in: 3600,
          scope: 'Mail.Read',
        })
      );

      await exchangeCodeForTokens('graph-code', false, {
        authConfig: {
          clientId: 'test-client-id',
          clientSecret: 'test-client-secret',
          tenantId: 'common',
          authorityHost: 'https://login.microsoftonline.com',
          redirectUri: config.AUTH_CONFIG.redirectUri,
          scopes: config.AUTH_CONFIG.scopes,
        },
        flowScope: FLOW_SCOPE,
        tokenStorage: { saveFlowTokens: mockSaveFlowTokens },
        https: { request: httpsMock },
      });

      const lastCall = httpsMock.mock.calls[httpsMock.mock.calls.length - 1];
      const postData = lastCall[0].body || lastCall[1];
      expect(querystring.parse(postData).scope).toBe(config.AUTH_CONFIG.scopes.join(' '));
    });

    it('invalidates the configured Vault cache for permanent Entra exchange failures', async () => {
      httpsMock.mockImplementation(
        createMockHttps(400, {
          error: 'invalid_client',
          error_description: 'Client authentication failed',
        })
      );
      const invalidateVaultTokenCache = jest.fn().mockResolvedValue({ deleted: true });
      const vaultConfig = { enabled: true, address: 'https://vault.example.test' };

      await expect(
        exchangeCodeForTokens('graph-code', false, {
          authConfig: {
            clientId: 'test-client-id',
            clientSecret: 'test-client-secret',
            tenantId: 'common',
            authorityHost: 'https://login.microsoftonline.com',
            redirectUri: config.AUTH_CONFIG.redirectUri,
            scopes: config.AUTH_CONFIG.scopes,
          },
          flowScope: FLOW_SCOPE,
          tokenStorage: { saveFlowTokens: mockSaveFlowTokens },
          https: { request: httpsMock },
          getVaultConfig: jest.fn().mockReturnValue(vaultConfig),
          invalidateVaultTokenCache,
        })
      ).rejects.toMatchObject({
        code: 'invalid_client',
        isPermanentEntraAuthFailure: true,
      });

      expect(invalidateVaultTokenCache).toHaveBeenCalledWith(vaultConfig);
    });

    it('does not invalidate the Vault cache for transient exchange failures', async () => {
      httpsMock.mockImplementation(createMockHttps(503, { error: 'invalid_grant' }));
      const invalidateVaultTokenCache = jest.fn().mockResolvedValue({ deleted: true });

      await expect(
        exchangeCodeForTokens('graph-code', false, {
          authConfig: {
            clientId: 'test-client-id',
            clientSecret: 'test-client-secret',
            tenantId: 'common',
            authorityHost: 'https://login.microsoftonline.com',
            redirectUri: config.AUTH_CONFIG.redirectUri,
            scopes: config.AUTH_CONFIG.scopes,
          },
          flowScope: FLOW_SCOPE,
          tokenStorage: { saveFlowTokens: mockSaveFlowTokens },
          https: { request: httpsMock },
          getVaultConfig: jest.fn().mockReturnValue({
            enabled: true,
            address: 'https://vault.example.test',
          }),
          invalidateVaultTokenCache,
        })
      ).rejects.toMatchObject({
        code: 'invalid_grant',
        isPermanentEntraAuthFailure: false,
      });

      expect(invalidateVaultTokenCache).not.toHaveBeenCalled();
    });
  });
});
