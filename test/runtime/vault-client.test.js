const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  DEFAULTS,
  VaultError,
  authenticateWithOidc,
  buildRedirectUri,
  exchangeOidcCallback,
  getVaultConfig,
  lookupSelf,
  listenForOidcCallback,
  loadVaultEnvironment,
  mapVaultEnvironment,
  openBrowser,
  readKvV2,
  renewSelf,
  requestAuthUrl,
} = require('../../runtime/vault-client');
const { readVaultTokenCache, writeVaultTokenCache } = require('../../runtime/vault-token-cache');

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
    tokenCachePath: null,
    tokenRenewThresholdSeconds: DEFAULTS.tokenRenewThresholdSeconds,
    tokenRenewIncrementSeconds: DEFAULTS.tokenRenewIncrementSeconds,
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
  let tempDirs;

  beforeEach(() => {
    tempDirs = [];
  });

  afterEach(() => {
    for (const directory of tempDirs) fs.rmSync(directory, { recursive: true, force: true });
  });

  function createCachePath() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'm365-vault-client-'));
    tempDirs.push(directory);
    return path.join(directory, 'vault-token.json');
  }

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
      tokenCachePath: null,
      tokenRenewThresholdSeconds: 5 * 60,
      tokenRenewIncrementSeconds: 60 * 60,
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
      VAULT_TOKEN_CACHE_PATH: 'C:/cache/vault-token.json',
      VAULT_TOKEN_RENEW_THRESHOLD_SECONDS: '42',
    });

    expect(config).toMatchObject({
      enabled: true,
      address: 'https://vault.example.test',
      oidcPort: 9123,
      namespace: 'team-a',
      skipBrowser: true,
      tokenCachePath: 'C:/cache/vault-token.json',
      tokenRenewThresholdSeconds: 42,
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

  it('looks up token metadata with the namespace, custom header, and Vault token', async () => {
    const requestJson = jest.fn().mockResolvedValue({
      data: {
        expire_time: '2030-01-01T00:00:00Z',
        ttl: 3600,
        renewable: true,
        policies: ['default'],
        id: 'must-not-be-returned',
      },
    });
    const config = createConfig({
      customHeaderName: CUSTOM_HEADER_NAME,
      customHeaderValue: CUSTOM_HEADER_VALUE,
    });

    await expect(lookupSelf(config, 'opaque-vault-token', { requestJson })).resolves.toEqual({
      expireTime: '2030-01-01T00:00:00Z',
      ttl: 3600,
      renewable: true,
      policies: ['default'],
    });

    const request = requestJson.mock.calls[0][0];
    expect(request.method).toBe('GET');
    expect(request.url).toBe('https://vault.example.test/v1/auth/token/lookup-self');
    expect(request.headers['X-Vault-Token']).toBe('opaque-vault-token');
    expect(request.headers['X-Vault-Namespace']).toBe('engineering');
    expect(request.headers[CUSTOM_HEADER_NAME]).toBe(CUSTOM_HEADER_VALUE);
    expect(JSON.stringify(request)).not.toContain('must-not-be-returned');
  });

  it('renews a token with a bounded one-hour increment and returns safe metadata', async () => {
    const requestJson = jest.fn().mockResolvedValue({
      auth: {
        client_token: 'renewed-vault-token',
        expire_time: '2030-01-01T00:00:00Z',
        lease_duration: 3600,
        renewable: true,
        policies: ['default'],
        accessor: 'must-not-be-returned',
      },
    });
    const config = createConfig({
      customHeaderName: CUSTOM_HEADER_NAME,
      customHeaderValue: CUSTOM_HEADER_VALUE,
      tokenRenewIncrementSeconds: 999999,
    });

    await expect(renewSelf(config, 'opaque-vault-token', { requestJson })).resolves.toEqual({
      token: 'renewed-vault-token',
      expireTime: '2030-01-01T00:00:00Z',
      ttl: 3600,
      renewable: true,
      policies: ['default'],
    });

    const request = requestJson.mock.calls[0][0];
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://vault.example.test/v1/auth/token/renew-self');
    expect(JSON.parse(request.body)).toEqual({ increment: 3600 });
    expect(request.headers['Content-Length']).toBe(Buffer.byteLength(request.body));
    expect(request.headers['X-Vault-Token']).toBe('opaque-vault-token');
    expect(request.headers['X-Vault-Namespace']).toBe('engineering');
    expect(request.headers[CUSTOM_HEADER_NAME]).toBe(CUSTOM_HEADER_VALUE);
    expect(JSON.stringify(request)).not.toContain('accessor');
  });

  it('accepts a state/code-only callback and exchanges with the stored nonce and client nonce', async () => {
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
      code: 'provider-code',
    });

    expect(address.address).toBe('127.0.0.1');
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('opaque-vault-token');
    await expect(callback.result).resolves.toBe('opaque-vault-token');

    const request = requestJson.mock.calls[0][0];
    expect(Object.fromEntries(new URL(request.url).searchParams)).toEqual({
      state: 'state-value',
      nonce: 'nonce-value',
      code: 'provider-code',
      client_nonce: 'client-nonce',
    });
  });

  it.each([
    ['mismatched state', { state: 'wrong-state', code: 'provider-code' }],
    ['missing code', { state: 'state-value' }],
    [
      'mismatched supplied nonce',
      { state: 'state-value', nonce: 'wrong-nonce', code: 'provider-code' },
    ],
  ])('rejects a callback with %s', async (_caseName, query) => {
    const requestJson = jest.fn();
    const callback = listenForOidcCallback(
      createConfig({ oidcPort: 0, callbackTimeoutMs: 2000 }),
      { state: 'state-value', nonce: 'nonce-value', clientNonce: 'client-nonce' },
      { requestJson }
    );
    const result = callback.result.catch((error) => error);

    await callback.ready;
    const address = callback.server.address();
    const response = await requestLocalCallback(address.port, query);

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

  it('passes the complete Windows provider URL to the protocol handler without shell parsing', () => {
    const authUrl =
      'https://login.example.test/authorize?client_id=client-id&code_challenge=challenge&redirect_uri=http%3A%2F%2Flocalhost%3A8250%2Foidc%2Fcallback&scope=openid%20profile&state=state-value';
    const unref = jest.fn();
    const spawn = jest.fn(() => ({ unref }));

    expect(openBrowser(authUrl, { platform: 'win32', childProcess: { spawn } })).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith('rundll32.exe', ['url.dll,FileProtocolHandler', authUrl], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    const [command, args] = spawn.mock.calls[0];
    expect(args[1]).toContain('&code_challenge=');
    expect(args[1]).toContain('&redirect_uri=');
    expect(args[1]).toContain('&scope=');
    expect(args[1]).toContain('&state=');
    expect(command).not.toMatch(/explorer\.exe|cmd\.exe|start/i);
    expect(args).not.toContain('explorer.exe');
    expect(args).not.toContain('cmd.exe');
    expect(args).not.toContain('start');
    expect(unref).toHaveBeenCalledTimes(1);
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
    const tokenCache = {
      readVaultTokenCache: jest.fn(),
      writeVaultTokenCache: jest.fn(),
      deleteVaultTokenCache: jest.fn(),
    };
    const requestJson = jest
      .fn()
      .mockRejectedValue(
        new VaultError('Vault request failed with HTTP status 403.', 'VAULT_UNAUTHORIZED', 403)
      );

    await expect(
      loadVaultEnvironment(createConfig({ token: 'opaque-vault-token' }), {
        authenticateWithOidc: authenticate,
        tokenCache,
        requestJson,
      })
    ).rejects.toMatchObject({ code: 'VAULT_UNAUTHORIZED', status: 403 });
    expect(authenticate).not.toHaveBeenCalled();
    expect(tokenCache.readVaultTokenCache).not.toHaveBeenCalled();
    expect(tokenCache.writeVaultTokenCache).not.toHaveBeenCalled();
    expect(tokenCache.deleteVaultTokenCache).not.toHaveBeenCalled();
    expect(requestJson.mock.calls.join('')).not.toContain('opaque-vault-token');
  });

  it('saves only Vault token metadata after the first OIDC load', async () => {
    const tokenCachePath = createCachePath();
    const config = createConfig({ tokenCachePath });
    const authenticate = jest.fn().mockResolvedValue('fresh-vault-token');
    const lookup = jest.fn().mockResolvedValue({
      expireTime: '2030-01-01T00:00:00Z',
      ttl: 3600,
      renewable: false,
      policies: ['default'],
    });
    const requestJson = jest.fn().mockResolvedValue({
      data: {
        data: {
          MS_CLIENT_ID: 'vault-client-id',
          MS_CLIENT_SECRET: 'fake-client-secret',
          MS_TENANT_ID: 'vault-tenant-id',
        },
      },
    });

    await expect(
      loadVaultEnvironment(config, {
        authenticateWithOidc: authenticate,
        lookupSelf: lookup,
        requestJson,
      })
    ).resolves.toMatchObject({ source: 'oidc', values: { MS_TENANT_ID: 'vault-tenant-id' } });

    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith(config, 'fresh-vault-token', expect.anything());
    const raw = fs.readFileSync(tokenCachePath, 'utf8');
    const entry = readVaultTokenCache(config);
    expect(entry).toMatchObject({
      token: 'fresh-vault-token',
      expireTime: '2030-01-01T00:00:00Z',
      ttl: 3600,
      renewable: false,
    });
    expect(raw).not.toContain('fake-client-secret');
    expect(raw).not.toContain('MS_CLIENT_SECRET');
  });

  it('reuses a cached token on the next load without opening OIDC', async () => {
    const config = createConfig({ tokenCachePath: createCachePath() });
    writeVaultTokenCache(config, 'cached-vault-token', {
      expireTime: '2030-01-01T00:00:00Z',
      ttl: 3600,
      renewable: false,
    });
    const authenticate = jest.fn();
    const lookup = jest.fn().mockResolvedValue({
      expireTime: '2030-01-01T00:00:00Z',
      ttl: 3600,
      renewable: false,
    });
    const requestJson = jest.fn().mockResolvedValue({
      data: { data: { MS_TENANT_ID: 'vault-tenant-id' } },
    });

    await expect(
      loadVaultEnvironment(config, {
        authenticateWithOidc: authenticate,
        lookupSelf: lookup,
        requestJson,
      })
    ).resolves.toMatchObject({ source: 'cache', values: { MS_TENANT_ID: 'vault-tenant-id' } });

    expect(authenticate).not.toHaveBeenCalled();
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(requestJson.mock.calls[0][0].headers['X-Vault-Token']).toBe('cached-vault-token');
  });

  it('renews a renewable near-expiry cached token and saves the new metadata', async () => {
    const config = createConfig({ tokenCachePath: createCachePath() });
    writeVaultTokenCache(config, 'expiring-vault-token', {
      expireTime: '2026-08-21T00:01:00Z',
      ttl: 60,
      renewable: true,
    });
    const renew = jest.fn().mockResolvedValue({
      token: 'renewed-vault-token',
      expireTime: '2030-01-01T00:00:00Z',
      ttl: 3600,
      renewable: true,
    });
    const requestJson = jest.fn().mockResolvedValue({
      data: { data: { MS_TENANT_ID: 'vault-tenant-id' } },
    });

    await loadVaultEnvironment(config, {
      authenticateWithOidc: jest.fn(),
      lookupSelf: jest.fn().mockResolvedValue({
        expireTime: '2026-08-21T00:01:00Z',
        ttl: 60,
        renewable: true,
      }),
      renewSelf: renew,
      now: Date.parse('2026-08-21T00:00:00Z'),
      requestJson,
    });

    expect(renew).toHaveBeenCalledWith(config, 'expiring-vault-token', expect.anything());
    expect(readVaultTokenCache(config)).toMatchObject({
      token: 'renewed-vault-token',
      expireTime: '2030-01-01T00:00:00Z',
      ttl: 3600,
      renewable: true,
    });
  });

  it.each([
    ['401', new VaultError('Vault rejected the token.', 'VAULT_UNAUTHORIZED', 401)],
    ['403', new VaultError('Vault rejected the token.', 'VAULT_UNAUTHORIZED', 403)],
    ['expired metadata', { expireTime: '2020-01-01T00:00:00Z', ttl: 0, renewable: false }],
  ])(
    'deletes an invalid cached token and performs exactly one OIDC fallback (%s)',
    async (_caseName, invalid) => {
      const config = createConfig();
      const tokenCache = {
        readVaultTokenCache: jest.fn().mockReturnValue({
          token: 'invalid-vault-token',
          expireTime: '2030-01-01T00:00:00Z',
          ttl: 3600,
          renewable: false,
        }),
        deleteVaultTokenCache: jest.fn().mockReturnValue({ deleted: true }),
        writeVaultTokenCache: jest.fn().mockReturnValue({ saved: true }),
      };
      const lookup = jest
        .fn()
        .mockImplementationOnce(() =>
          invalid instanceof Error ? Promise.reject(invalid) : Promise.resolve(invalid)
        )
        .mockResolvedValueOnce({
          expireTime: '2030-01-01T00:00:00Z',
          ttl: 3600,
          renewable: false,
        });
      const authenticate = jest.fn().mockResolvedValue('fresh-vault-token');
      const requestJson = jest.fn().mockResolvedValue({
        data: { data: { MS_TENANT_ID: 'vault-tenant-id' } },
      });

      await expect(
        loadVaultEnvironment(config, {
          tokenCache,
          lookupSelf: lookup,
          authenticateWithOidc: authenticate,
          requestJson,
        })
      ).resolves.toMatchObject({ source: 'oidc' });

      expect(tokenCache.deleteVaultTokenCache).toHaveBeenCalledTimes(1);
      expect(authenticate).toHaveBeenCalledTimes(1);
      expect(lookup).toHaveBeenCalledTimes(2);
      expect(tokenCache.writeVaultTokenCache).toHaveBeenCalledTimes(1);
    }
  );

  it('invalidates a cached token when the KV read is unauthorized, then retries OIDC once', async () => {
    const config = createConfig();
    const tokenCache = {
      readVaultTokenCache: jest.fn().mockReturnValue({ token: 'cached-vault-token' }),
      deleteVaultTokenCache: jest.fn().mockReturnValue({ deleted: true }),
      writeVaultTokenCache: jest.fn().mockReturnValue({ saved: true }),
    };
    const lookup = jest.fn().mockResolvedValue({ ttl: 3600, renewable: false });
    const requestJson = jest
      .fn()
      .mockRejectedValueOnce(new VaultError('Vault rejected the token.', 'VAULT_UNAUTHORIZED', 401))
      .mockResolvedValueOnce({ data: { data: { MS_TENANT_ID: 'vault-tenant-id' } } });

    await expect(
      loadVaultEnvironment(config, {
        tokenCache,
        lookupSelf: lookup,
        authenticateWithOidc: jest.fn().mockResolvedValue('fresh-vault-token'),
        requestJson,
      })
    ).resolves.toMatchObject({ source: 'oidc' });

    expect(tokenCache.deleteVaultTokenCache).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(requestJson).toHaveBeenCalledTimes(2);
  });

  it('continues the current startup when the token cache cannot be written', async () => {
    const tokenCache = {
      readVaultTokenCache: jest.fn().mockReturnValue(null),
      writeVaultTokenCache: jest.fn(() => {
        throw new Error('permission denied');
      }),
    };
    const result = await loadVaultEnvironment(createConfig(), {
      tokenCache,
      authenticateWithOidc: jest.fn().mockResolvedValue('fresh-vault-token'),
      lookupSelf: jest.fn().mockResolvedValue({ ttl: 3600, renewable: false }),
      requestJson: jest.fn().mockResolvedValue({
        data: { data: { MS_TENANT_ID: 'vault-tenant-id' } },
      }),
    });

    expect(result.cache).toEqual({
      saved: false,
      warning: 'Vault token cache could not be saved; this startup will continue safely.',
    });
    expect(JSON.stringify(result)).not.toContain('fresh-vault-token');
  });
});
