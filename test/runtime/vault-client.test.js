const http = require('http');

const {
  DEFAULTS,
  VaultError,
  authenticateWithOidc,
  buildRedirectUri,
  exchangeOidcCallback,
  getVaultConfig,
  listenForOidcCallback,
  loadVaultEnvironment,
  mapVaultEnvironment,
  readKvV2,
  requestAuthUrl,
} = require('../../runtime/vault-client');

const CUSTOM_HEADER_NAME = 'X-ACCESS-TOKEN';
const CUSTOM_HEADER_VALUE = 'fake-header-value';

function createConfig(overrides = {}) {
  return {
    enabled: true,
    address: 'https://vault.example.test',
    authMount: 'oidc',
    role: 'outlook-mcp-developer',
    oidcPort: DEFAULTS.oidcPort,
    kvMount: 'kv',
    secretPath: 'outlook-mcp/actsis',
    namespace: 'engineering',
    token: null,
    customHeaderName: null,
    customHeaderValue: null,
    skipBrowser: false,
    requestTimeoutMs: DEFAULTS.requestTimeoutMs,
    callbackTimeoutMs: DEFAULTS.callbackTimeoutMs,
    ...overrides,
  };
}

function requestLocalCallback(port, query) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      {
        hostname: '127.0.0.1',
        port,
        path: `/oidc/callback?${new URLSearchParams(query).toString()}`,
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (body += chunk));
        response.on('end', () => resolve({ statusCode: response.statusCode, body }));
      }
    );
    request.on('error', reject);
  });
}

describe('runtime/vault-client', () => {
  it('defaults Vault configuration and keeps Vault disabled without VAULT_ADDR', () => {
    expect(getVaultConfig({ VAULT_TOKEN: 'ignored-without-address' })).toEqual({
      enabled: false,
      address: null,
      authMount: 'oidc',
      role: 'outlook-mcp-developer',
      oidcPort: 8250,
      kvMount: 'kv',
      secretPath: 'outlook-mcp/actsis',
      namespace: null,
      token: null,
      customHeaderName: null,
      customHeaderValue: null,
      skipBrowser: false,
      requestTimeoutMs: 10000,
      callbackTimeoutMs: 5 * 60 * 1000,
    });
  });

  it('normalizes configured Vault settings and uses the documented callback URI', () => {
    const config = getVaultConfig({
      VAULT_ADDR: 'https://vault.example.test/',
      VAULT_AUTH_MOUNT: 'oidc',
      VAULT_ROLE: 'outlook-mcp-developer',
      VAULT_OIDC_PORT: '9123',
      VAULT_KV_MOUNT: 'kv',
      VAULT_SECRET_PATH: '/outlook-mcp/actsis/',
      VAULT_NAMESPACE: 'team-a',
      VAULT_SKIP_BROWSER: 'true',
    });

    expect(config).toMatchObject({
      enabled: true,
      address: 'https://vault.example.test',
      oidcPort: 9123,
      namespace: 'team-a',
      skipBrowser: true,
    });
    expect(buildRedirectUri(config)).toBe('http://localhost:9123/oidc/callback');
  });

  it('normalizes the documented Actsis Vault path and custom header configuration', () => {
    const config = getVaultConfig({
      VAULT_ADDR: 'https://vault.edge.actsis.com/',
      VAULT_KV_MOUNT: '/kv/',
      VAULT_SECRET_PATH: '/apps/outlook-mcp/prod/',
      VAULT_CUSTOM_HEADER_NAME: ` ${CUSTOM_HEADER_NAME} `,
      VAULT_CUSTOM_HEADER_VALUE: CUSTOM_HEADER_VALUE,
    });

    expect(config).toMatchObject({
      address: 'https://vault.edge.actsis.com',
      kvMount: 'kv',
      secretPath: 'apps/outlook-mcp/prod',
      customHeaderName: CUSTOM_HEADER_NAME,
      customHeaderValue: CUSTOM_HEADER_VALUE,
    });
  });

  it('rejects an incomplete custom header pair without exposing the value', () => {
    expect(() =>
      getVaultConfig({
        VAULT_ADDR: 'https://vault.example.test',
        VAULT_CUSTOM_HEADER_NAME: CUSTOM_HEADER_NAME,
      })
    ).toThrow('VAULT_CUSTOM_HEADER_NAME and VAULT_CUSTOM_HEADER_VALUE must be set together.');

    let error;
    try {
      getVaultConfig({
        VAULT_ADDR: 'https://vault.example.test',
        VAULT_CUSTOM_HEADER_VALUE: CUSTOM_HEADER_VALUE,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({ code: 'VAULT_CONFIG_INVALID' });
    expect(error.message).not.toContain(CUSTOM_HEADER_VALUE);
  });

  it.each([
    'host',
    'Content-Length',
    'connection',
    'Authorization',
    'X-Vault-Token',
    'x-vault-namespace',
    'not a header',
    'invalid\nheader',
  ])('rejects reserved or invalid custom header name %j safely', (name) => {
    let error;
    try {
      getVaultConfig({
        VAULT_ADDR: 'https://vault.example.test',
        VAULT_CUSTOM_HEADER_NAME: name,
        VAULT_CUSTOM_HEADER_VALUE: CUSTOM_HEADER_VALUE,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({ code: 'VAULT_CONFIG_INVALID' });
    expect(error.message).not.toContain(CUSTOM_HEADER_VALUE);
  });

  it('requests an OIDC authorization URL with role, redirect URI, and client nonce', async () => {
    const requestJson = jest.fn().mockResolvedValue({
      data: {
        auth_url: 'https://login.example.test/authorize?state=state-value&nonce=nonce-value',
      },
    });

    const result = await requestAuthUrl(createConfig(), 'client-nonce', { requestJson });
    const request = requestJson.mock.calls[0][0];
    const body = JSON.parse(request.body);

    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://vault.example.test/v1/auth/oidc/oidc/auth_url');
    expect(request.headers['X-Vault-Namespace']).toBe('engineering');
    expect(request.headers[CUSTOM_HEADER_NAME]).toBeUndefined();
    expect(request.headers['Content-Type']).toBe('application/json');
    expect(request.headers['Content-Length']).toBe(Buffer.byteLength(request.body));
    expect(body).toEqual({
      role: 'outlook-mcp-developer',
      redirect_uri: 'http://localhost:8250/oidc/callback',
      client_nonce: 'client-nonce',
    });
    expect(result).toEqual({
      authUrl: 'https://login.example.test/authorize?state=state-value&nonce=nonce-value',
      state: 'state-value',
      nonce: 'nonce-value',
      clientNonce: 'client-nonce',
    });
  });

  it('exchanges validated OIDC callback values without sending a Vault token', async () => {
    const requestJson = jest
      .fn()
      .mockResolvedValue({ auth: { client_token: 'opaque-vault-token' } });

    const token = await exchangeOidcCallback(
      createConfig(),
      {
        state: 'state-value',
        nonce: 'nonce-value',
        code: 'provider-code',
        clientNonce: 'client-nonce',
      },
      { requestJson }
    );
    const request = requestJson.mock.calls[0][0];
    const parsedUrl = new URL(request.url);

    expect(token).toBe('opaque-vault-token');
    expect(parsedUrl.pathname).toBe('/v1/auth/oidc/oidc/callback');
    expect(Object.fromEntries(parsedUrl.searchParams)).toEqual({
      state: 'state-value',
      nonce: 'nonce-value',
      code: 'provider-code',
      client_nonce: 'client-nonce',
    });
    expect(request.headers['X-Vault-Token']).toBeUndefined();
    expect(request.headers[CUSTOM_HEADER_NAME]).toBeUndefined();
  });

  it('attaches the custom header to OIDC and KV requests without changing controlled headers', async () => {
    const requestJson = jest
      .fn()
      .mockResolvedValueOnce({
        data: {
          auth_url: 'https://login.example.test/authorize?state=state-value&nonce=nonce-value',
        },
      })
      .mockResolvedValueOnce({ auth: { client_token: 'opaque-vault-token' } })
      .mockResolvedValueOnce({ data: { data: { MS_TENANT_ID: 'vault-tenant-id' } } });
    const config = createConfig({
      customHeaderName: CUSTOM_HEADER_NAME,
      customHeaderValue: CUSTOM_HEADER_VALUE,
    });

    const auth = await requestAuthUrl(config, 'client-nonce', { requestJson });
    await exchangeOidcCallback(
      config,
      {
        state: auth.state,
        nonce: auth.nonce,
        code: 'provider-code',
        clientNonce: 'client-nonce',
      },
      { requestJson }
    );
    await readKvV2(config, 'opaque-vault-token', { requestJson });

    const requests = requestJson.mock.calls.map(([request]) => request);
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request.headers[CUSTOM_HEADER_NAME]).toBe(CUSTOM_HEADER_VALUE);
      expect(request.url).not.toContain(CUSTOM_HEADER_VALUE);
    }
    expect(auth.authUrl).not.toContain(CUSTOM_HEADER_VALUE);
    expect(requests[0].headers['Content-Type']).toBe('application/json');
    expect(requests[0].headers['Content-Length']).toBe(Buffer.byteLength(requests[0].body));
    expect(requests[1].headers['X-Vault-Namespace']).toBe('engineering');
    expect(requests[1].headers['X-Vault-Token']).toBeUndefined();
    expect(requests[2].headers['X-Vault-Token']).toBe('opaque-vault-token');
    expect(requests[2].headers['X-Vault-Namespace']).toBe('engineering');
  });

  it('listens only on loopback, validates state/nonce/code, and does not expose the Vault token', async () => {
    const requestJson = jest
      .fn()
      .mockResolvedValue({ auth: { client_token: 'opaque-vault-token' } });
    const callback = listenForOidcCallback(
      createConfig({ oidcPort: 0, callbackTimeoutMs: 2000 }),
      {
        state: 'state-value',
        nonce: 'nonce-value',
        clientNonce: 'client-nonce',
      },
      { requestJson }
    );

    await callback.ready;
    const address = callback.server.address();
    const response = await requestLocalCallback(address.port, {
      state: 'state-value',
      nonce: 'nonce-value',
      code: 'provider-code',
    });

    expect(address.address).toBe('127.0.0.1');
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('opaque-vault-token');
    await expect(callback.result).resolves.toBe('opaque-vault-token');
  });

  it('rejects a callback with missing or mismatched required parameters', async () => {
    const requestJson = jest.fn();
    const callback = listenForOidcCallback(
      createConfig({ oidcPort: 0, callbackTimeoutMs: 2000 }),
      { state: 'state-value', nonce: 'nonce-value', clientNonce: 'client-nonce' },
      { requestJson }
    );
    const result = callback.result.catch((error) => error);

    await callback.ready;
    const address = callback.server.address();
    const response = await requestLocalCallback(address.port, {
      state: 'wrong-state',
      code: 'provider-code',
    });

    expect(response.statusCode).toBe(400);
    expect(requestJson).not.toHaveBeenCalled();
    expect((await result).code).toBe('VAULT_OIDC_CALLBACK_INVALID');
  });

  it('prints only the provider URL when browser launch is skipped', async () => {
    const requestJson = jest.fn().mockResolvedValue({
      data: { auth_url: 'https://login.example.test/authorize?state=s&nonce=n' },
    });
    const listenForCallback = jest.fn(() => ({
      ready: Promise.resolve(),
      result: Promise.resolve('opaque-vault-token'),
      close: jest.fn(),
    }));
    const stderr = { write: jest.fn() };

    const token = await authenticateWithOidc(
      createConfig({
        skipBrowser: true,
        customHeaderName: CUSTOM_HEADER_NAME,
        customHeaderValue: CUSTOM_HEADER_VALUE,
      }),
      {
        requestJson,
        randomBytes: () => Buffer.alloc(32, 1),
        listenForOidcCallback: listenForCallback,
        stderr,
      }
    );

    expect(token).toBe('opaque-vault-token');
    expect(stderr.write).toHaveBeenCalledWith(
      'https://login.example.test/authorize?state=s&nonce=n\n'
    );
    expect(stderr.write.mock.calls.join('')).not.toContain('opaque-vault-token');
    expect(stderr.write.mock.calls.join('')).not.toContain(CUSTOM_HEADER_VALUE);
  });

  it('redacts a custom header value from wrapped request errors', async () => {
    const requestJson = jest
      .fn()
      .mockRejectedValue(new Error(`transport rejected ${CUSTOM_HEADER_VALUE}`));

    let error;
    try {
      await requestAuthUrl(
        createConfig({
          customHeaderName: CUSTOM_HEADER_NAME,
          customHeaderValue: CUSTOM_HEADER_VALUE,
        }),
        'client-nonce',
        { requestJson }
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({ code: 'VAULT_OIDC_AUTH_URL_FAILED' });
    expect(error.message).toContain('[REDACTED]');
    expect(error.message).not.toContain(CUSTOM_HEADER_VALUE);
  });

  it('reads KV v2 through the data path and maps only allowlisted string fields', async () => {
    const requestJson = jest.fn().mockResolvedValue({
      data: {
        data: {
          MS_CLIENT_ID: 'vault-client-id',
          MS_CLIENT_SECRET: 'opaque-client-secret',
          MS_TENANT_ID: 'vault-tenant-id',
          MS_AUTHORITY_HOST: 'https://login.example.test',
          UNRELATED_FIELD: 'ignored',
          MS_SCOPES: { invalid: true },
        },
      },
    });

    const fields = await readKvV2(createConfig(), 'opaque-vault-token', { requestJson });
    const request = requestJson.mock.calls[0][0];
    const mapped = mapVaultEnvironment(fields);

    expect(request.method).toBe('GET');
    expect(request.url).toBe('https://vault.example.test/v1/kv/data/outlook-mcp/actsis');
    expect(request.headers['X-Vault-Token']).toBe('opaque-vault-token');
    expect(mapped).toEqual({
      MS_CLIENT_ID: 'vault-client-id',
      MS_CLIENT_SECRET: 'opaque-client-secret',
      MS_TENANT_ID: 'vault-tenant-id',
      MS_AUTHORITY_HOST: 'https://login.example.test',
    });
  });

  it('uses an explicit token without starting browser authentication and hides HTTP bodies on failure', async () => {
    const authenticate = jest.fn();
    const requestJson = jest
      .fn()
      .mockRejectedValue(
        new VaultError('Vault request failed with HTTP status 403.', 'VAULT_UNAUTHORIZED', 403)
      );

    await expect(
      loadVaultEnvironment(createConfig({ token: 'opaque-vault-token' }), {
        authenticateWithOidc: authenticate,
        requestJson,
      })
    ).rejects.toMatchObject({ code: 'VAULT_UNAUTHORIZED', status: 403 });
    expect(authenticate).not.toHaveBeenCalled();
    expect(requestJson.mock.calls.join('')).not.toContain('opaque-vault-token');
  });
});
