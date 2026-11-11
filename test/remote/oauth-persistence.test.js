/**
 * Narrow public persistent-integration tests for the chosen bridge
 * (task T19, S5, S10, S11): the real encrypted bridge store in an isolated
 * temporary directory driven through two actual HTTP listener lifecycles —
 * never through provider internals.
 *
 * P1  bridge mode creates the encrypted store at the explicit directory and
 *     a rotated MCP refresh family survives a real server restart
 * P2  an expired upstream Entra credential renews through the real tenant
 *     refresh grant, the renewed upstream verifies with the same Entra
 *     verifier and stays identity-bound, and the renewal survives another
 *     restart (no stale expired-token success)
 * P3  a wrong canonical deployment (tenant, or client, or base URL binding)
 *     refuses to load the store and never silently resets it
 * P4  direct Entra mode creates no store
 * P5  CLI startup persists to the platform state directory by default with
 *     a safe, token-free startup line
 *
 * Fully offline: synthetic RSA keys with an injected JWKS client and a
 * jest-muted https module for the upstream token endpoint; all storage in
 * per-test temporary directories that are removed again. No real
 * credentials, network, Docker, or tenant work.
 */
jest.mock('../../utils/graph-api', () => ({
  callGraphAPI: jest.fn(),
  callGraphAPIPaginated: jest.fn(),
  callGraphAPIDownload: jest.fn(),
}));

jest.mock('https');

const crypto = require('crypto');
const fs = require('node:fs');
const https = require('https');
const os = require('node:os');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const querystring = require('querystring');

const { callGraphAPI } = require('../../utils/graph-api');
const {
  createRemoteMcpHttpServer,
  resolveRemoteMcpConfig,
  startRemoteMCPHttpServer,
} = require('../../remote/http-server');
const { DATA_FILE_NAME, KEY_FILE_NAME } = require('../../remote/bridge-store');

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const AUDIENCE = '99988899-8888-4888-9888-888888888888';
const REQUIRED_SCOPE = 'mcp.access';
// The upstream access token is verified by the deployment verifier against
// the standard Microsoft tenant issuer, while the ID token of the upstream
// sign-in is verified against the configured authority issuer (T13).
const ENTRA_CLIENT_ID = 'entraid-confidential-client-id';
const ENTRA_CLIENT_SECRET = 'entraid-confidential-client-secret';
const AUTHORITY_HOST = 'https://login.contoso.example';
const EXTERNAL_BASE_URL = 'https://mcp.internal.example';
const OTHER_BASE_URL = 'https://other-deployment.example';
const UPSTREAM_SCOPE = 'api://outlook-mcp/mcp.access';
const CLIENT_SECRET = 'confidential-mcp-client-secret';
const CLIENT_REDIRECT = 'https://client.example/oauth/callback';
const OID = 'object-user';
const INITIAL_UPSTREAM_RT = 'upstream-refresh-credential-initial-v1';
const ROTATED_UPSTREAM_RT = 'upstream-refresh-credential-rotated-v2';

const { privateKey, publicKeyPem } = (function generateKeyPair() {
  const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privateKey: keys.privateKey,
    publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }),
  };
})();

const LOCAL_JWKS = {
  async getSigningKey() {
    return { getPublicKey: () => publicKeyPem };
  },
};

let mintedUpstreamTokens = new Set();

function mintUpstreamAccessToken({ oid = OID, expMinutes = 60 } = {}) {
  const token = jwt.sign(
    {
      iss: `https://login.microsoftonline.com/${TENANT_ID}/v2.0`,
      aud: AUDIENCE,
      sub: `subject-${oid}`,
      tid: TENANT_ID,
      oid,
      scp: REQUIRED_SCOPE,
      groups: [],
    },
    privateKey,
    { algorithm: 'RS256', keyid: 'test-key-1', expiresIn: `${expMinutes}m` }
  );
  mintedUpstreamTokens.add(token);
  return token;
}

function mintIdToken(nonce, { oid = OID } = {}) {
  return jwt.sign(
    {
      iss: `${AUTHORITY_HOST}/${TENANT_ID}/v2.0`,
      aud: ENTRA_CLIENT_ID,
      sub: `subject-${oid}`,
      tid: TENANT_ID,
      oid,
      preferred_username: 'user@example.com',
      nonce,
    },
    privateKey,
    { algorithm: 'RS256', expiresIn: '5m', keyid: 'test-key-1' }
  );
}

/**
 * Queues one mocked upstream token-endpoint response; by default a code
 * redemption returning short-lived upstream tokens plus an initial
 * refresh credential.
 */
function enqueueUpstreamRedemption({
  nonce,
  expiresIn = 1,
  refreshToken = INITIAL_UPSTREAM_RT,
  accessToken,
} = {}) {
  https.request.mockImplementationOnce((url, options, callback) => {
    const entry = {
      url: String(url),
      options,
      body: null,
      on: jest.fn(),
      setTimeout: jest.fn(),
      write: jest.fn((chunk) => {
        entry.body = querystring.parse(chunk);
      }),
      end: jest.fn(() => {
        const body = {
          token_type: 'Bearer',
          scope: `${UPSTREAM_SCOPE} offline_access`,
          expires_in: expiresIn,
          access_token: accessToken === undefined ? mintUpstreamAccessToken() : accessToken,
          ...(refreshToken !== undefined ? { refresh_token: refreshToken } : {}),
          id_token: mintIdToken(nonce),
        };
        const res = {
          statusCode: 200,
          on: (event, handler) => {
            if (event === 'data') {
              handler(Buffer.from(JSON.stringify(body)));
            }
            if (event === 'end') {
              handler();
            }
          },
        };
        queueMicrotask(() => callback(res));
      }),
    };
    return entry;
  });
}

let oboRequests = [];

function mockOboStoreFactory(requestConfig) {
  if (!requestConfig.token || !mintedUpstreamTokens.has(requestConfig.token)) {
    throw new Error('OBO_FACTORY_SAW_UNEXPECTED_TOKEN');
  }
  oboRequests.push(requestConfig);
  return {
    getValidAccessToken: async () => `obo-graph-${requestConfig.token.slice(-6)}`,
    getValidFlowAccessToken: async () => `obo-flow-${requestConfig.token.slice(-6)}`,
  };
}

function baseOauth() {
  return {
    clients: [
      {
        clientId: 'external-web-client',
        clientSecret: CLIENT_SECRET,
        redirectUris: [CLIENT_REDIRECT],
      },
    ],
    supportedScopes: ['mcp'],
    loginRedirectUri: `${EXTERNAL_BASE_URL}/login/callback`,
    upstreamScopes: [UPSTREAM_SCOPE],
  };
}

function serverConfig(overrides = {}) {
  const { oauth, ...rest } = overrides;
  return {
    port: 0,
    host: '127.0.0.1',
    tenantId: TENANT_ID,
    audience: AUDIENCE,
    clientId: ENTRA_CLIENT_ID,
    clientSecret: ENTRA_CLIENT_SECRET,
    requiredScopes: [REQUIRED_SCOPE],
    jwksClient: LOCAL_JWKS,
    createOboTokenStore: mockOboStoreFactory,
    externalBaseUrl: EXTERNAL_BASE_URL,
    entraLogin: { authorityHost: AUTHORITY_HOST, jwksClient: LOCAL_JWKS },
    oauth: oauth === null ? null : { ...baseOauth(), ...(oauth || {}) },
    ...rest,
  };
}

async function startServer(overrides = {}) {
  const instance = createRemoteMcpHttpServer(serverConfig(overrides));
  const started = await instance.start();
  return { instance, base: `http://127.0.0.1:${started.port}` };
}

async function stopServer(instance) {
  await instance.stop();
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function htmlFormValue(html, name) {
  const match = html.match(new RegExp(`name="${name}"[^>]*>`, 'i'));
  const value = match && match[0].match(/value="([^"]+)"/);
  if (!value) {
    throw new Error(`hidden input ${name} not found in consent page`);
  }
  return value[1];
}

/**
 * Drives the public browser-visible flow through the listener: authorize ->
 * consent (CSRF) -> upstream Entra sign-in (mocked token endpoint) ->
 * registered client redirect -> /token exchange. Returns the MCP tokens.
 */
async function runFullFlow({ base, expiresIn, refreshToken } = {}) {
  const pkcePair = pkce();
  const authorizeResponse = await fetch(
    `${base}/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: 'external-web-client',
      redirect_uri: CLIENT_REDIRECT,
      scope: 'mcp',
      state: 'client-state-1',
      code_challenge: pkcePair.challenge,
      code_challenge_method: 'S256',
    })}`,
    { redirect: 'manual' }
  );
  expect(authorizeResponse.status).toBe(302);
  const loginUrl = new URL(authorizeResponse.headers.get('location'), base);
  const ref = loginUrl.searchParams.get('mcp_authorization');
  expect(ref).toMatch(/^[\w-]{30,}$/);

  const loginPage = await fetch(`${base}/login?mcp_authorization=${ref}`);
  const loginHtml = await loginPage.text();
  expect(loginPage.status).toBe(200);

  const consent = await fetch(`${base}/login/consent`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      mcp_authorization: ref,
      csrf_token: htmlFormValue(loginHtml, 'csrf_token'),
    }).toString(),
  });
  expect(consent.status).toBe(302);
  const entraUrl = new URL(consent.headers.get('location'));
  expect(`${entraUrl.protocol}//${entraUrl.host}${entraUrl.pathname}`).toBe(
    `${AUTHORITY_HOST}/${TENANT_ID}/oauth2/v2.0/authorize`
  );

  enqueueUpstreamRedemption({
    nonce: entraUrl.searchParams.get('nonce'),
    ...(expiresIn !== undefined ? { expiresIn } : {}),
    ...(refreshToken !== undefined ? { refreshToken } : {}),
  });
  const callback = await fetch(
    `${base}/login/callback?${new URLSearchParams({
      state: entraUrl.searchParams.get('state'),
      code: 'upstream-code-value',
    })}`,
    { redirect: 'manual' }
  );
  expect(callback.status).toBe(302);
  const clientRedirect = new URL(callback.headers.get('location'));
  expect(`${clientRedirect.origin}${clientRedirect.pathname}`).toBe(new URL(CLIENT_REDIRECT).href);

  const tokenResponse = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: clientRedirect.searchParams.get('code'),
      code_verifier: pkcePair.verifier,
      client_id: 'external-web-client',
      client_secret: CLIENT_SECRET,
      redirect_uri: CLIENT_REDIRECT,
    }).toString(),
  });
  expect(tokenResponse.status).toBe(200);
  const tokenJson = await tokenResponse.json();
  return { mcpToken: tokenJson.access_token, mcpRefreshToken: tokenJson.refresh_token };
}

async function postMcpToolsList(base, mcpToken) {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${mcpToken}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} }),
  });
}

async function postTokenRefresh(base, { refreshToken, clientSecret = CLIENT_SECRET }) {
  return fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: 'external-web-client',
      ...(clientSecret ? { client_secret: clientSecret } : {}),
    }).toString(),
  });
}

let tempRoot;
let storeDir;

beforeEach(() => {
  mintedUpstreamTokens = new Set();
  oboRequests = [];
  callGraphAPI.mockReset();
  callGraphAPI.mockImplementation(async (accessToken) => ({
    value: [
      {
        id: `folder-${accessToken}`,
        displayName: `OBO:${accessToken}`,
        childFolderCount: 0,
        parentFolderId: null,
      },
    ],
  }));
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-persistence-test-'));
  storeDir = path.join(tempRoot, 'bridge-store');
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3 });
  jest.restoreAllMocks();
});

describe('P1 bridge mode creates the encrypted store and a rotation survives a real restart', () => {
  it('persists the refresh family through two actual listener lifecycles', async () => {
    // Lifecycle 1: sign in, issue, and rotate once.
    const first = await startServer({ oauth: { storeDirectory: storeDir } });
    try {
      // A fresh one-hour upstream keeps the renewal seam idle here; the
      // near-expiry renewal behavior is P2's subject.
      const flow = await runFullFlow({ base: first.base, expiresIn: 3600 });
      expect(flow.mcpToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(flow.mcpToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(flow.mcpRefreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const rotated = await postTokenRefresh(first.base, {
        refreshToken: flow.mcpRefreshToken,
      });
      expect(rotated.status).toBe(200);
      const rotatedBody = await rotated.json();

      // The store directory carries the encrypted snapshot; the raw bytes
      // never contain any plaintext credential material.
      const files = fs.readdirSync(storeDir);
      expect(files).toContain(DATA_FILE_NAME);
      const raw = fs.readFileSync(path.join(storeDir, DATA_FILE_NAME)).toString('latin1');
      expect(raw).not.toContain(flow.mcpToken);
      expect(raw).not.toContain(rotatedBody.refresh_token);
      expect(raw).not.toContain(flow.mcpRefreshToken);

      // Lifecycle 2: the persisted family keeps rotating on a fresh listener.
      const second = await startServer({ oauth: { storeDirectory: storeDir } });
      try {
        const restored = await postTokenRefresh(second.base, {
          refreshToken: rotatedBody.refresh_token,
        });
        expect(restored.status).toBe(200);
        const restoredBody = await restored.json();
        const verified = await fetch(`${second.base}/mcp`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${restoredBody.access_token}`,
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        });
        expect(verified.status).toBe(200);
      } finally {
        await stopServer(second.instance);
      }
    } finally {
      // Every lifecycle closes its listener in every path, so the suite can
      // never leave an open handle behind for Jest to wait on.
      await stopServer(first.instance);
    }
  });
});

describe('P2 upstream renewal across restarts (expired upstream, valid MCP grant)', () => {
  it('renews through the real tenant refresh grant once, binds the same identity, and survives another restart', async () => {
    // Lifecycle 1: login with a 1-second upstream access token.
    const first = await startServer({ oauth: { storeDirectory: storeDir } });
    let flow;
    try {
      flow = await runFullFlow({ base: first.base, expiresIn: 1 });
      await stopServer(first.instance);
    } catch (error) {
      await stopServer(first.instance);
      throw error;
    }

    let lifecycle2;
    try {
      // Lifecycle 2: the upstream is expired, the MCP token is valid.
      const renewedAccessToken = mintUpstreamAccessToken({ expMinutes: 60 });
      lifecycle2 = await startServer({ oauth: { storeDirectory: storeDir } });
      await new Promise((resolve) => setTimeout(resolve, 1200));
      oboRequests = [];
      https.request.mockClear();
      enqueueUpstreamRedemption({
        nonce: 'renewal-unused-nonce',
        expiresIn: 3600,
        refreshToken: ROTATED_UPSTREAM_RT,
        accessToken: renewedAccessToken,
      });
      const refreshed = await postMcpToolsList(lifecycle2.base, flow.mcpToken);
      expect(refreshed.status).toBe(200);

      // The renewal used the real tenant-pinned refresh grant with the
      // resource-qualified scope plus offline_access, and the on-behalf-of
      // dispatch used the RENEWED upstream credential, never the MCP token.
      const refreshRequest = https.request.mock.calls
        .map(([url]) => String(url))
        .find((url) => url.endsWith(`/${TENANT_ID}/oauth2/v2.0/token`));
      expect(refreshRequest).toContain(AUTHORITY_HOST.replace('https://', ''));
      expect(oboRequests).toHaveLength(1);
      expect(oboRequests[0].token).toBe(renewedAccessToken);
      // A second dispatch with the now-fresh upstream renews nothing.
      https.request.mockClear();
      const secondDispatch = await postMcpToolsList(lifecycle2.base, flow.mcpToken);
      expect(secondDispatch.status).toBe(200);
      expect(https.request).not.toHaveBeenCalled();
    } finally {
      await lifecycle2.instance.stop();
    }

    // Lifecycle 3: the persisted (renewed) upstream is still fresh and no
    // network call is needed; the persisted state still serves /mcp
    // through the on-behalf-of dispatch.
    let lifecycle3;
    try {
      lifecycle3 = await startServer({ oauth: { storeDirectory: storeDir } });
      https.request.mockClear();
      const dispatched = oboRequests.length;
      const served = await postMcpToolsList(lifecycle3.base, flow.mcpToken);
      expect(served.status).toBe(200);
      expect(https.request).not.toHaveBeenCalled();
      expect(oboRequests.length).toBe(dispatched + 1);
      expect(mintedUpstreamTokens.has(oboRequests[oboRequests.length - 1].token)).toBe(true);
    } finally {
      await lifecycle3.instance.stop();
    }
  });

  it('refuses a renewed upstream credential bound to another identity (immutable oid/tid)', async () => {
    const first = await startServer({ oauth: { storeDirectory: storeDir } });
    let flow;
    try {
      flow = await runFullFlow({ base: first.base, expiresIn: 1 });
      await stopServer(first.instance);
    } catch (error) {
      await stopServer(first.instance);
      throw error;
    }

    let lifecycle2;
    try {
      lifecycle2 = await startServer({ oauth: { storeDirectory: storeDir } });
      await new Promise((resolve) => setTimeout(resolve, 1200));
      mintedUpstreamTokens = new Set();
      https.request.mockImplementationOnce((url, options, callback) => {
        const entry = {
          url: String(url),
          options,
          on: jest.fn(),
          setTimeout: jest.fn(),
          write: jest.fn((chunk) => {
            entry.body = querystring.parse(chunk);
          }),
          end: jest.fn(() => {
            const body = {
              token_type: 'Bearer',
              scope: `${UPSTREAM_SCOPE} offline_access`,
              expires_in: 3600,
              access_token: mintUpstreamAccessToken({ oid: 'object-other-user' }),
              refresh_token: ROTATED_UPSTREAM_RT,
              id_token: mintIdToken('renewal-nonce', { oid: 'object-other-user' }),
            };
            const res = {
              statusCode: 200,
              on: (event, handler) => {
                if (event === 'data') {
                  handler(Buffer.from(JSON.stringify(body)));
                }
                if (event === 'end') {
                  handler();
                }
              },
            };
            queueMicrotask(() => callback(res));
          }),
        };
        return entry;
      });
      const refused = await postMcpToolsList(lifecycle2.base, flow.mcpToken);
      expect(refused.status).toBe(401);
      // No dispatch ever ran with the wrong-user credential.
      expect(oboRequests).toHaveLength(0);
      // The family was invalidated: a later refresh grant cannot resurrect.
      const stalled = await postTokenRefresh(lifecycle2.base, {
        refreshToken: flow.mcpRefreshToken,
      });
      expect(stalled.status).toBe(400);
      const stalledBody = await stalled.json();
      expect(stalledBody.error).toBe('invalid_grant');
    } finally {
      await lifecycle2.instance.stop();
    }
  });
});

describe('P3 wrong canonical deployment binding fails closed', () => {
  it('carries the explicit store directory into the explicit bridge oauth configuration', () => {
    const config = resolveRemoteMcpConfig({
      MCP_HTTP_PORT: '0',
      MCP_HTTP_HOST: '127.0.0.1',
      MCP_HTTP_ALLOW_LOCAL_HTTP: 'true',
      MCP_HTTP_EXTERNAL_BASE_URL: EXTERNAL_BASE_URL,
      ENTRA_TENANT_ID: TENANT_ID,
      ENTRA_CLIENT_ID: ENTRA_CLIENT_ID,
      ENTRA_CLIENT_SECRET: ENTRA_CLIENT_SECRET,
      MCP_HTTP_LOGIN_REDIRECT_URI: `${EXTERNAL_BASE_URL}/login/callback`,
      MCP_HTTP_OAUTH_CLIENTS:
        '[{"clientId":"external-web-client","clientSecret":"confidential-mcp-client-secret","redirectUris":["https://client.example/oauth/callback"]}]',
      MCP_HTTP_UPSTREAM_SCOPES: UPSTREAM_SCOPE,
      MCP_HTTP_BRIDGE_STORE_DIR: storeDir,
    });
    expect(config.oauth.storeDirectory).toBe(storeDir);
  });

  it('refuses to start a listener that binds a different canonical URL to the same encrypted store', async () => {
    const first = await startServer({ oauth: { storeDirectory: storeDir } });
    let flow;
    try {
      flow = await runFullFlow({ base: first.base });
    } finally {
      await stopServer(first.instance);
    }
    expect(flow.mcpToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    await expect(
      startServer({
        externalBaseUrl: OTHER_BASE_URL,
        oauth: {
          storeDirectory: storeDir,
          loginRedirectUri: `${OTHER_BASE_URL}/login/callback`,
          clients: [
            {
              clientId: 'external-web-client',
              clientSecret: CLIENT_SECRET,
              redirectUris: [CLIENT_REDIRECT],
            },
          ],
        },
      })
    ).rejects.toThrow(/BRIDGE_STORE_UNAUTHORIZED|wrong deployment|unauthorized/i);
  });
});

describe('P4 direct Entra mode creates no store', () => {
  it('resolves direct mode without any bridge store configuration even when store variables are set', () => {
    const config = resolveRemoteMcpConfig({
      MCP_HTTP_PORT: '0',
      MCP_HTTP_HOST: '127.0.0.1',
      MCP_HTTP_EXTERNAL_BASE_URL: OTHER_BASE_URL,
      ENTRA_TENANT_ID: TENANT_ID,
      ENTRA_CLIENT_ID: ENTRA_CLIENT_ID,
      ENTRA_CLIENT_SECRET: ENTRA_CLIENT_SECRET,
      MCP_HTTP_BRIDGE_STORE_DIR: storeDir,
      MCP_HTTP_BRIDGE_KEY_FILE: path.join(tempRoot, 'bridge.key'),
    });
    expect(config.authMode).toBe('entra');
    expect(config.oauth).toBeNull();
  });
});

describe('P5 CLI startup persists to the platform state directory by default', () => {
  it('selects ~/.outlook-mcp/remote-oauth, starts without errors, and logs a safe startup line', async () => {
    const homeDir = fs.mkdtempSync(path.join(tempRoot, 'home-fixture-'));
    // On Windows os.homedir() reads the shell profile folder directly, so
    // the platform state directory is redirected by stubbing homedir; all
    // writes stay inside the per-test temporary directory either way.
    jest.spyOn(os, 'homedir').mockReturnValue(homeDir);
    const startupLogs = [];
    jest.spyOn(console, 'error').mockImplementation((...args) => {
      startupLogs.push(args.join(' '));
    });
    let instance;
    try {
      instance = await startRemoteMCPHttpServer({
        MCP_HTTP_PORT: '0',
        MCP_HTTP_HOST: '127.0.0.1',
        ENTRA_TENANT_ID: TENANT_ID,
        ENTRA_CLIENT_ID: ENTRA_CLIENT_ID,
        ENTRA_CLIENT_SECRET: ENTRA_CLIENT_SECRET,
        MCP_HTTP_LOGIN_REDIRECT_URI: `${EXTERNAL_BASE_URL}/login/callback`,
        MCP_HTTP_OAUTH_CLIENTS:
          '[{"clientId":"external-web-client","redirectUris":["https://client.example/oauth/callback"]}]',
        MCP_HTTP_UPSTREAM_SCOPES: UPSTREAM_SCOPE,
      });
    } finally {
      if (instance) {
        await instance.instance.stop();
      }
    }

    const expectedStore = path.join(homeDir, '.outlook-mcp', 'remote-oauth');
    // The durable private key exists before any login; the encrypted data
    // file appears on the first committed state change (see P1/P2).
    expect(fs.readdirSync(expectedStore)).toContain(KEY_FILE_NAME);
    expect(startupLogs.join('\n')).toContain('bridge credential store');
    expect(startupLogs.join('\n')).not.toMatch(/bridge-store\.key|refresh|secret=|token=/i);
  });
});
