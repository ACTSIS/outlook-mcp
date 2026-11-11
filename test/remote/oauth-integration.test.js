/**
 * End-to-end integration tests for the standards-based MCP OAuth browser
 * sign-in flow (task T6, S1-S3, S5).
 *
 * Covers the whole external-client journey against one real listener on
 * 127.0.0.1 (ephemeral port):
 *
 * I1  discovery: authorization-server metadata and protected-resource
 *     metadata advertise the service OAuth flow next to the Entra issuer
 * I2  the browser-to-client handoff: /authorize -> consent page ->
 *     explicit consent (CSRF) -> upstream Entra sign-in -> exact
 *     registered redirect carrying code+state only
 * I3  the consent page identifies the client, the exact registered
 *     redirect, the requested permissions, enforces CSRF, and hardens
 *     framing
 * I4  the token endpoint issues only an MCP-scoped bearer token (no
 *     refresh token, no upstream token, no ID token)
 * I5  with the MCP token, the external client invokes tools as the same
 *     user through the per-request on-behalf-of exchange, with per-user
 *     OBO isolation preserved
 * I6  every /mcp request requires a valid token before any dispatch
 * I7  the flow fails closed: unknown/expired references, replayed
 *     callbacks, wrong PKCE, provider errors, unknown clients/redirects
 * I8  the upstream Entra access token, secrets, and codes never appear in
 *     any browser- or client-visible response
 * I9  every verified delegated identity runs tools the same way on both the
 *     OAuth path and the existing Entra bearer path, with no separate local
 *     mutation policy (S3)
 *
 * Fully offline: synthetic RSA signing keys with injected JWKS clients,
 * jest-mocked https for the upstream Entra token endpoint, and mocked
 * Graph calls. No real tenant, credentials, or network.
 */
jest.mock('../../utils/graph-api', () => ({
  callGraphAPI: jest.fn(),
  callGraphAPIPaginated: jest.fn(),
  callGraphAPIDownload: jest.fn(),
}));

jest.mock('https');

const crypto = require('crypto');
const https = require('https');
const jwt = require('jsonwebtoken');
const querystring = require('querystring');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const {
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const { callGraphAPI } = require('../../utils/graph-api');
const { createRemoteMcpHttpServer } = require('../../remote/http-server');

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT_ID = '22222222-2222-4222-8222-222222222222';
// v2 access tokens for a custom API carry the API app's client ID GUID in
// `aud` while their `scp` carries the short scope names; the resource-qualified
// api:// scope is only the Entra *authorization request* scope (T8 correction).
const AUDIENCE = '22222222-2222-4222-8222-222222222222';
const REQUIRED_SCOPE = 'mcp.access';
const UPSTREAM_SCOPE = 'api://outlook-mcp/mcp.access';
const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;
const ENTRA_CLIENT_ID = 'entraid-confidential-client-id';
const ENTRA_CLIENT_SECRET = 'entraid-confidential-client-secret';
const AUTHORITY_HOST = 'https://login.contoso.example';
const ENTRA_ISSUER = `${AUTHORITY_HOST}/${TENANT_ID}/v2.0`;
const CLIENT_ID = 'external-web-client';
const CLIENT_REDIRECT = 'https://client.example/oauth/callback';
const CLIENT_SECRET = 'synthetic-confidential-client-secret-v1';
const LOGIN_REDIRECT = 'https://mcp.internal.example/login/callback';
const MCP_SCOPE = 'mcp';
const UPSTREAM_CODE = 'upstream-entra-authorization-code';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const LOCAL_JWKS = {
  async getSigningKey() {
    return { getPublicKey: () => publicKey };
  },
};

function mintIdToken({ nonce, oid = 'object-user', groups = [], roles = [] } = {}) {
  return jwt.sign(
    {
      iss: ENTRA_ISSUER,
      aud: ENTRA_CLIENT_ID,
      tid: TENANT_ID,
      sub: `subject-${oid}`,
      oid,
      preferred_username: 'user@example.com',
      groups,
      roles,
      nonce,
    },
    privateKey,
    { algorithm: 'RS256', expiresIn: '5m', keyid: 'test-key-1' }
  );
}

/* --- mocked upstream Entra token endpoint ---------------------------------- */

let lastUpstreamAccessToken = null;

/** Every minted upstream JWT (tracked so the leak scanner and the OBO guard can check them). */
const mintedUpstreamTokens = new Set();

/**
 * Mints the upstream custom-API access token Entra's token endpoint would
 * return: signed by the tenant key, aud = the API app client GUID, short
 * scp scope names. Overrides let tests build wrong-resource, wrong-user, or
 * wrong-scope tokens to prove the bind-time validation fails closed.
 */
function mintUpstreamAccessToken({
  oid = 'object-user',
  scp = REQUIRED_SCOPE,
  aud = AUDIENCE,
  iss = ISSUER,
  tid = TENANT_ID,
  exp,
} = {}) {
  const token = jwt.sign(
    {
      iss,
      aud,
      sub: `subject-${oid}`,
      tid,
      oid,
      scp,
      groups: [],
      ...(exp ? { exp } : {}),
    },
    privateKey,
    { algorithm: 'RS256', keyid: 'test-key-1', ...(exp ? {} : { expiresIn: '5m' }) }
  );
  mintedUpstreamTokens.add(token);
  return token;
}

function enqueueUpstreamRedemption({ nonce, groups, roles, shortExpiry, upstream = {} } = {}) {
  https.request.mockImplementationOnce((url, options, callback) => {
    const entry = {
      url: String(url),
      options,
      body: null,
      on: jest.fn(),
      setTimeout: jest.fn(),
      destroy: jest.fn(),
      write: jest.fn((chunk) => {
        entry.body = querystring.parse(chunk);
      }),
      end: jest.fn(() => {
        const res = {
          statusCode: 200,
          on: (event, handler) => {
            if (event === 'data') {
              // mintIdToken already produces the complete signed JWS.
              const idToken = mintIdToken({ nonce, groups, roles });
              // The upstream access token is the API-qualified custom API
              // token Microsoft returns: aud = API client GUID, short scp.
              lastUpstreamAccessToken = mintUpstreamAccessToken({
                groups,
                ...upstream,
                ...(shortExpiry ? { exp: Math.floor(Date.now() / 1000) + 1 } : {}),
              });
              handler(
                Buffer.from(
                  JSON.stringify({
                    token_type: 'Bearer',
                    scope: UPSTREAM_SCOPE,
                    expires_in: shortExpiry ? 1 : 3600,
                    access_token: lastUpstreamAccessToken,
                    refresh_token: 'upstream-entra-refresh-token-never-issued',
                    id_token: idToken,
                  })
                )
              );
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

/* --- MCP OAuth client-side helpers ----------------------------------------- */

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function authorizeQuery({
  resource,
  scope = MCP_SCOPE,
  state = 'client-state-1',
  pkce: pkcePair,
} = {}) {
  const { challenge } = pkcePair || pkce();
  return {
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: CLIENT_REDIRECT,
    scope,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...(resource ? { resource } : {}),
  };
}

function htmlFormValue(html, name) {
  const match = html.match(new RegExp(`name="${name}"[^>]*>`, 'i'));
  if (!match) {
    throw new Error(`hidden input ${name} not found in consent page`);
  }
  const value = match[0].match(/value="([^"]+)"/);
  if (!value) {
    throw new Error(`hidden input ${name} has no value in consent page`);
  }
  return value[1];
}

/* --- server lifecycle and flow helpers ------------------------------------- */

let oboRequests = [];

function mockOboStoreFactory(requestConfig) {
  if (
    !requestConfig.token ||
    (!mintedUpstreamTokens.has(requestConfig.token) && !bearerTokens.has(requestConfig.token))
  ) {
    throw new Error('OBO_FACTORY_SAW_UNEXPECTED_TOKEN');
  }
  lastUpstreamAccessToken = requestConfig.token;
  oboRequests.push(requestConfig);
  return {
    getValidAccessToken: async () => `obo-graph-for-${requestConfig.token.slice(-8)}`,
    getValidFlowAccessToken: async () => `obo-flow-for-${requestConfig.token.slice(-8)}`,
  };
}

/* --- existing Entra bearer path (I9) --------------------------------------- */

const bearerTokens = new Set();

function signEntraToken(overrides = {}) {
  const token = jwt.sign(
    {
      iss: `https://login.microsoftonline.com/${TENANT_ID}/v2.0`,
      aud: AUDIENCE,
      sub: 'subject-bearer',
      tid: TENANT_ID,
      oid: 'object-bearer',
      scp: REQUIRED_SCOPE,
      preferred_username: 'bearer-user@example.com',
      groups: [],
    },
    privateKey,
    { algorithm: 'RS256', expiresIn: '5m', keyid: 'test-key-1', ...(overrides.signOptions || {}) }
  );
  bearerTokens.add(token);
  return token;
}

const baseOauth = {
  clients: [{ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUris: [CLIENT_REDIRECT] }],
  supportedScopes: [MCP_SCOPE],
  loginRedirectUri: LOGIN_REDIRECT,
  // The upstream Microsoft sign-in requests the resource-qualified custom API
  // scope; the short scp name it issues is verified separately (T8 correction).
  upstreamScopes: [UPSTREAM_SCOPE],
};

function serverConfig(overrides = {}) {
  const { oauth, entraLogin, ...rest } = overrides;
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
    entraLogin: { authorityHost: AUTHORITY_HOST, jwksClient: LOCAL_JWKS, ...(entraLogin || {}) },
    oauth: oauth === null ? null : { ...baseOauth, ...(oauth || {}) },
    ...rest,
  };
}

async function startServer(overrides = {}) {
  const instance = createRemoteMcpHttpServer(serverConfig(overrides));
  const started = await instance.start();
  return { instance, port: started.port, base: `http://127.0.0.1:${started.port}` };
}

async function withServer(overrides, run) {
  const { instance, base, port } = await startServer(overrides);
  try {
    await run({ base, port });
  } finally {
    await instance.stop();
  }
}

/**
 * Runs the complete browser-visible flow and the token exchange. Every
 * captured response is pushed into LEAK_SCANNER for the afterEach scan.
 */
async function runFullFlow({ base, resource, groups, roles } = {}) {
  const pkcePair = pkce();
  const query = authorizeQuery({ resource, pkce: pkcePair });
  const authorizeResponse = await fetch(`${base}/authorize?${new URLSearchParams(query)}`, {
    redirect: 'manual',
  });
  LEAK_SCANNER.push(await authorizeResponse.text());
  expect(authorizeResponse.status).toBe(302);
  const loginLocation = authorizeResponse.headers.get('location');
  LEAK_SCANNER.push(loginLocation);
  const ref = new URL(loginLocation).searchParams.get('mcp_authorization');
  expect(ref).toMatch(/^[\w-]{30,}$/);
  expect(loginLocation.startsWith(`${base}/login?`)).toBe(true);

  const loginPage = await fetch(`${base}/login?mcp_authorization=${ref}`);
  const loginHtml = await loginPage.text();
  LEAK_SCANNER.push(loginHtml);
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
  LEAK_SCANNER.push(await consent.clone().text(), consent.headers.get('location') || '');
  expect(consent.status).toBe(302);
  const entraUrl = new URL(consent.headers.get('location'));
  expect(`${entraUrl.protocol}//${entraUrl.host}${entraUrl.pathname}`).toBe(
    `${AUTHORITY_HOST}/${TENANT_ID}/oauth2/v2.0/authorize`
  );
  // The upstream authorization request carries the API-qualified custom API
  // scope (not the short scp name the issued tokens carry), plus the OIDC
  // openid and profile scopes (profile is required so Entra emits the oid
  // identity claim in the returned ID token) and offline_access, so Microsoft
  // issues the server-held upstream refresh credential (T19).
  expect(entraUrl.searchParams.get('scope')).toBe(
    `${UPSTREAM_SCOPE} openid profile offline_access`
  );

  enqueueUpstreamRedemption({ nonce: entraUrl.searchParams.get('nonce'), groups, roles });
  const callback = await fetch(
    `${base}/login/callback?${new URLSearchParams({
      state: entraUrl.searchParams.get('state'),
      code: UPSTREAM_CODE,
    })}`,
    { redirect: 'manual' }
  );
  LEAK_SCANNER.push(await callback.text(), callback.headers.get('location') || '');
  expect(callback.status).toBe(302);
  const clientRedirect = new URL(callback.headers.get('location'));
  expect(`${clientRedirect.origin}${clientRedirect.pathname}`).toBe(new URL(CLIENT_REDIRECT).href);
  const mcpCode = clientRedirect.searchParams.get('code');
  expect(clientRedirect.searchParams.get('state')).toBe('client-state-1');

  const tokenResponse = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: mcpCode,
      code_verifier: pkcePair.verifier,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: CLIENT_REDIRECT,
      ...(resource ? { resource } : {}),
    }).toString(),
  });
  const tokenBody = await tokenResponse.text();
  LEAK_SCANNER.push(tokenBody);
  expect(tokenResponse.status).toBe(200);
  const tokenJson = JSON.parse(tokenBody);
  return { ref, mcpCode, entraUrl, tokenJson, mcpToken: tokenJson.access_token, pkcePair };
}

/* --- leak scanner ----------------------------------------------------------- */

const LEAK_SCANNER = [];

beforeEach(() => {
  oboRequests = [];
  lastUpstreamAccessToken = null;
  LEAK_SCANNER.length = 0;
  bearerTokens.clear();
  https.request.mockClear();
  callGraphAPI.mockClear();
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
});

afterEach(() => {
  // I8: no browser- or client-visible response ever carries the upstream
  // Entra access/refresh token, either client secret, or the upstream code.
  const sensitiveValues = [
    ...mintedUpstreamTokens,
    'upstream-entra-refresh-token-never-issued',
    ENTRA_CLIENT_SECRET,
    CLIENT_SECRET,
    UPSTREAM_CODE,
  ];
  for (const captured of LEAK_SCANNER) {
    for (const sensitive of sensitiveValues) {
      if (captured && String(captured).includes(sensitive)) {
        throw new Error(
          `Sensitive value (${sensitive.slice(0, 24)}...) leaked into a browser/client-visible response: ${String(
            captured
          ).slice(0, 200)}`
        );
      }
    }
  }
  LEAK_SCANNER.length = 0;
});

describe('I1 discovery metadata for the service OAuth flow', () => {
  it('serves RFC 8414 authorization-server metadata with only the supported grants', async () => {
    await withServer({}, async ({ base }) => {
      const response = await fetch(`${base}/.well-known/oauth-authorization-server`);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toContain('no-store');
      const metadata = await response.json();
      expect(metadata.issuer).toBe(base);
      expect(metadata.authorization_endpoint).toBe(`${base}/authorize`);
      expect(metadata.token_endpoint).toBe(`${base}/token`);
      expect(metadata.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
      expect(metadata.code_challenge_methods_supported).toEqual(['S256']);
      expect(metadata.response_types_supported).toEqual(['code']);
      expect(metadata.scopes_supported).toContain(MCP_SCOPE);
      expect(metadata.registration_endpoint).toBeUndefined();
      expect(metadata.revocation_endpoint).toBeUndefined();
      expect(JSON.stringify(metadata)).not.toContain('revoke');
    });
  });

  it('lists this service first in the protected-resource authorization servers', async () => {
    await withServer({}, async ({ base }) => {
      const response = await fetch(`${base}/.well-known/oauth-protected-resource`);
      const metadata = await response.json();
      expect(metadata.authorization_servers).toEqual([base, ENTRA_ISSUER]);
      expect(metadata.resource).toBe(base);
      expect(metadata.scopes_supported).toContain(REQUIRED_SCOPE);
    });
  });

  it('keeps a bearer-only deployment free of OAuth metadata and Entra-only discovery', async () => {
    await withServer({ oauth: null }, async ({ base }) => {
      const oauthMetadata = await fetch(`${base}/.well-known/oauth-authorization-server`);
      expect(oauthMetadata.status).toBe(404);
      const metadata = await fetch(`${base}/.well-known/oauth-protected-resource`).then((r) =>
        r.json()
      );
      expect(metadata.authorization_servers).toEqual([ENTRA_ISSUER]);
    });
  });

  it('does not enable dynamic client registration by default', async () => {
    await withServer({}, async ({ base }) => {
      const registration = await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'probe-client',
          redirect_uris: ['https://probe.example/cb'],
          grant_types: ['authorization_code'],
          response_types: ['code'],
        }),
      });
      expect(registration.status).toBe(404);
      const metadata = await fetch(`${base}/.well-known/oauth-authorization-server`).then((r) =>
        r.json()
      );
      expect(metadata.registration_endpoint).toBeUndefined();
    });
  });
});

describe('I2 browser-to-client handoff with explicit consent', () => {
  it('completes the full standards flow and redirects the browser back to the exact registered client', async () => {
    await withServer({}, async ({ base }) => {
      const flow = await runFullFlow({ base });
      expect(flow.tokenJson.token_type).toBe('Bearer');
    });
  });

  it('exchanges the code only with the correct single-use PKCE verifier', async () => {
    await withServer({}, async ({ base }) => {
      const flow = await runFullFlow({ base });
      // A valid verifier that is not the one bound to the code must fail.
      const wrongResponse = await fetch(`${base}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: flow.mcpCode,
          code_verifier: crypto.randomBytes(32).toString('base64url'),
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          redirect_uri: CLIENT_REDIRECT,
        }).toString(),
      });
      LEAK_SCANNER.push(await wrongResponse.text());
      expect(wrongResponse.status).toBe(400);
    });
  });

  it('binds the issuance to the RFC 8707 resource and refuses a later mismatch on /mcp', async () => {
    await withServer({}, async ({ base }) => {
      const flow = await runFullFlow({ base, resource: base });
      expect(flow.tokenJson.access_token).toMatch(/^[\w-]{30,}$/);

      // A token bound to a different resource is refused by /mcp before any
      // dispatch: authorize+token with the wrong resource, with the exact
      // PKCE pair so the failure is the resource binding, not PKCE.
      const otherPkce = pkce();
      const otherResourceAuthorize = await fetch(
        `${base}/authorize?${new URLSearchParams(
          authorizeQuery({ resource: 'https://elsewhere.example/mcp', pkce: otherPkce })
        )}`,
        { redirect: 'manual' }
      );
      const otherLoginLocation = otherResourceAuthorize.headers.get('location');
      LEAK_SCANNER.push(otherLoginLocation || '');
      const otherRef = new URL(otherLoginLocation).searchParams.get('mcp_authorization');
      const otherLoginPage = await fetch(`${base}/login?mcp_authorization=${otherRef}`);
      const otherHtml = await otherLoginPage.text();
      LEAK_SCANNER.push(otherHtml);
      const otherConsent = await fetch(`${base}/login/consent`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          mcp_authorization: otherRef,
          csrf_token: htmlFormValue(otherHtml, 'csrf_token'),
        }).toString(),
      });
      const otherEntraUrl = new URL(otherConsent.headers.get('location'));
      enqueueUpstreamRedemption({ nonce: otherEntraUrl.searchParams.get('nonce') });
      const otherCallback = await fetch(
        `${base}/login/callback?${new URLSearchParams({
          state: otherEntraUrl.searchParams.get('state'),
          code: UPSTREAM_CODE,
        })}`,
        { redirect: 'manual' }
      );
      const otherClientRedirect = new URL(otherCallback.headers.get('location'));
      LEAK_SCANNER.push(otherCallback.headers.get('location') || '');
      const wrongResourceTokenResponse = await fetch(`${base}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: otherClientRedirect.searchParams.get('code'),
          code_verifier: otherPkce.verifier,
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          redirect_uri: CLIENT_REDIRECT,
          resource: base,
        }).toString(),
      });
      LEAK_SCANNER.push(await wrongResourceTokenResponse.text());
      expect(wrongResourceTokenResponse.status).toBe(400);
    });
  });

  it('issues a rotating refresh-token family and supports the HTTP refresh grant (T18)', async () => {
    await withServer({}, async ({ base }) => {
      const flow = await runFullFlow({ base });
      expect(Array.isArray(Object.keys(flow.tokenJson))).toBe(true);
      expect(flow.tokenJson.refresh_token).toMatch(/^[\w-]{30,}$/);
      expect(flow.tokenJson.scope).toBe(MCP_SCOPE);
      expect(flow.tokenJson.token_type).toBe('Bearer');
      expect(flow.tokenJson.expires_in).toBeGreaterThan(0);
      expect(JSON.stringify(flow.tokenJson)).not.toContain(
        'upstream-entra-refresh-token-never-issued'
      );

      // The same family rotates over the standard HTTP refresh grant.
      const rotated = await fetch(`${base}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: flow.tokenJson.refresh_token,
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
        }).toString(),
      });
      LEAK_SCANNER.push(await rotated.clone().text());
      expect(rotated.status).toBe(200);
      const rotatedJson = await rotated.json();
      expect(rotatedJson.access_token).toMatch(/^[\w-]{30,}$/);
      expect(rotatedJson.refresh_token).not.toBe(flow.tokenJson.refresh_token);
      expect(rotatedJson.scope).toBe(MCP_SCOPE);

      // The rotated MCP access token still invokes tools as the same user
      // through the per-request on-behalf-of exchange.
      const client = new Client({ name: 'external-refresh-test', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${rotatedJson.access_token}` } },
      });
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
      await client.close();
      expect(oboRequests.length).toBeGreaterThanOrEqual(1);

      // The consumed token's replay revokes the whole family.
      const replayed = await fetch(`${base}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: flow.tokenJson.refresh_token,
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
        }).toString(),
      });
      LEAK_SCANNER.push(await replayed.clone().text());
      expect(replayed.status).toBe(400);
      expect((await replayed.json()).error).toBe('invalid_grant');
    });
  });

  it('issues no upstream material in the MCP-scoped token', async () => {
    await withServer({}, async ({ base }) => {
      const flow = await runFullFlow({ base });
      expect(Object.keys(flow.tokenJson).sort()).toEqual([
        'access_token',
        'expires_in',
        'refresh_token',
        'scope',
        'token_type',
      ]);
      expect(flow.tokenJson.scope).toBe(MCP_SCOPE);
      expect(flow.tokenJson.token_type).toBe('Bearer');
      expect(flow.tokenJson.expires_in).toBeGreaterThan(0);
      expect(JSON.stringify(flow.tokenJson)).not.toContain(
        'upstream-entra-refresh-token-never-issued'
      );
    });
  });
});

describe('I3 consent page: identity, permissions, CSRF, framing', () => {
  it('identifies the client, exact registered redirect, and requested permissions', async () => {
    await withServer({}, async ({ base }) => {
      const authorizeResponse = await fetch(
        `${base}/authorize?${new URLSearchParams(authorizeQuery({ state: 'page-state' }))}`,
        { redirect: 'manual' }
      );
      const ref = new URL(authorizeResponse.headers.get('location')).searchParams.get(
        'mcp_authorization'
      );
      const loginResponse = await fetch(`${base}/login?mcp_authorization=${ref}`);
      const html = await loginResponse.text();
      LEAK_SCANNER.push(html);
      expect(loginResponse.status).toBe(200);
      expect(loginResponse.headers.get('content-type')).toContain('text/html');
      expect(html).toContain(CLIENT_ID);
      expect(html).toContain('https://client.example/oauth/callback');
      expect(html).toContain(MCP_SCOPE);
      expect(html).toContain('Microsoft');
      expect(html).toContain('csrf_token');
      expect(html).toMatch(/<form[^>]+method="post"[^>]+action="\/login\/consent"/i);
      // Nothing on the page mimics Microsoft's own sign-in UI.
      expect(html).not.toMatch(/<img/i);
    });
  });

  it('sends clickjacking and content-security hardening headers', async () => {
    await withServer({}, async ({ base }) => {
      const authorizeResponse = await fetch(
        `${base}/authorize?${new URLSearchParams(authorizeQuery())}`,
        {
          redirect: 'manual',
        }
      );
      const ref = new URL(authorizeResponse.headers.get('location')).searchParams.get(
        'mcp_authorization'
      );
      const loginResponse = await fetch(`${base}/login?mcp_authorization=${ref}`);
      LEAK_SCANNER.push(await loginResponse.text());
      const headers = loginResponse.headers;
      expect(headers.get('x-frame-options')).toMatch(/deny/i);
      expect(headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      // T14: the self target is the explicit canonical origin, not the CSP
      // keyword — the exact same access set, spelled out.
      expect(headers.get('content-security-policy')).toContain(
        `form-action ${new URL(base).origin}`
      );
      expect(headers.get('x-content-type-options')).toBe('nosniff');
      // T10/S7 correction: the policy must send at most the origin in BOTH
      // directions of the flow — a same-origin consent submission must
      // neither lose the true form Origin nor refer the page URL, whose
      // path and query carry the opaque OAuth authorization reference
      // (mcp_authorization). `strict-origin` is the exact policy that gives
      // the browser a known origin on both legs; nothing broader (no URL,
      // no path, no query) is ever referred — not even to this same
      // service — and nothing narrower would make Chromium send the form
      // Origin at all (`no-referrer` sent `Origin: null`).
      expect(headers.get('referrer-policy')).toBe('strict-origin');
      expect(headers.get('cache-control')).toContain('no-store');
    });
  });

  it('serves a referrer policy that sends at most the origin — never the authorization-reference URL — while letting a real browser submit the consent form with its true exact same-site Origin and an origin-only Referer (S7 regression)', async () => {
    await withServer({}, async ({ base }) => {
      const authorizeResponse = await fetch(
        `${base}/authorize?${new URLSearchParams(authorizeQuery())}`,
        {
          redirect: 'manual',
        }
      );
      const ref = new URL(authorizeResponse.headers.get('location')).searchParams.get(
        'mcp_authorization'
      );
      const loginResponse = await fetch(`${base}/login?mcp_authorization=${ref}`);
      expect(loginResponse.status).toBe(200);
      // A form-POST Origin of `null` is what a real Chromium/Edge/Chrome
      // browser sent for the same-origin consent submission while the page
      // served `referrer-policy: no-referrer` (observed at the public
      // interface with a real headless browser; it caused the user-reported
      // `{"error":"origin-denied"}`). The served policy must never produce
      // that behavior for a legitimate same-origin submission, and it must
      // refer at most the origin: `strict-origin` makes the browser send the
      // exact same-origin `Origin` and an origin-only `Referer` — the
      // authorization reference in the page URL is never referred anywhere,
      // cross-site or same-origin.
      expect(loginResponse.headers.get('referrer-policy')).toBe('strict-origin');
      const html = await loginResponse.text();
      // Exactly the request shape a real Chromium browser sends for the same
      // origin under `strict-origin`: exact origin Origin header, and a
      // Referer reduced to the bare origin with no path or query.
      const consent = await fetch(`${base}/login/consent`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: base,
          referer: `${base}/`,
        },
        body: new URLSearchParams({
          mcp_authorization: ref,
          csrf_token: htmlFormValue(html, 'csrf_token'),
        }).toString(),
      });
      expect(consent.status).toBe(302);
    });
  });

  it('keeps denying a cross-site consent POST while the CSRF value and pending authorization stay intact', async () => {
    await withServer({}, async ({ base }) => {
      const authorizeResponse = await fetch(
        `${base}/authorize?${new URLSearchParams(authorizeQuery())}`,
        {
          redirect: 'manual',
        }
      );
      const ref = new URL(authorizeResponse.headers.get('location')).searchParams.get(
        'mcp_authorization'
      );
      const loginResponse = await fetch(`${base}/login?mcp_authorization=${ref}`);
      const html = await loginResponse.text();
      const csrf = htmlFormValue(html, 'csrf_token');
      const crossSitePost = await fetch(`${base}/login/consent`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'https://evil.example',
          referer: 'https://evil.example/phishing',
        },
        body: new URLSearchParams({ mcp_authorization: ref, csrf_token: csrf }).toString(),
      });
      expect(crossSitePost.status).toBe(403);
      expect(await crossSitePost.json()).toMatchObject({ error: 'origin-denied' });
      // Refused at the gate before any state change: the same pending
      // authorization can still be completed from the legitimate origin.
      const retry = await fetch(`${base}/login/consent`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: base,
          referer: `${base}/`,
        },
        body: new URLSearchParams({ mcp_authorization: ref, csrf_token: csrf }).toString(),
      });
      expect(retry.status).toBe(302);
      expect(retry.headers.get('location')).toMatch(/^https:\/\/login\.contoso\.example\//);
    });
  });

  it('keeps denying an opaque (null-origin) consent POST while the CSRF value and pending authorization stay intact', async () => {
    await withServer({}, async ({ base }) => {
      const authorizeResponse = await fetch(
        `${base}/authorize?${new URLSearchParams(authorizeQuery())}`,
        {
          redirect: 'manual',
        }
      );
      const ref = new URL(authorizeResponse.headers.get('location')).searchParams.get(
        'mcp_authorization'
      );
      const loginResponse = await fetch(`${base}/login?mcp_authorization=${ref}`);
      const html = await loginResponse.text();
      const csrf = htmlFormValue(html, 'csrf_token');
      // Exactly what a sandboxed/opaque-origin browser context sends.
      const nullOriginPost = await fetch(`${base}/login/consent`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'null',
          referer: `${base}/`,
        },
        body: new URLSearchParams({ mcp_authorization: ref, csrf_token: csrf }).toString(),
      });
      expect(nullOriginPost.status).toBe(403);
      expect(await nullOriginPost.json()).toMatchObject({ error: 'origin-denied' });
      // The opaque origin was refused at the gate, before any state change:
      // the CSRF value was not consumed and the same pending authorization
      // continues to work for a correct same-origin submission.
      const retry = await fetch(`${base}/login/consent`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: base,
          referer: `${base}/`,
        },
        body: new URLSearchParams({ mcp_authorization: ref, csrf_token: csrf }).toString(),
      });
      expect(retry.status).toBe(302);
      expect(retry.headers.get('location')).toMatch(/^https:\/\/login\.contoso\.example\//);
    });
  });

  it('rejects a consent POST without, with a wrong, or with a reused CSRF value', async () => {
    await withServer({}, async ({ base }) => {
      const authorizeResponse = await fetch(
        `${base}/authorize?${new URLSearchParams(authorizeQuery())}`,
        {
          redirect: 'manual',
        }
      );
      const ref = new URL(authorizeResponse.headers.get('location')).searchParams.get(
        'mcp_authorization'
      );
      const loginResponse = await fetch(`${base}/login?mcp_authorization=${ref}`);
      const html = await loginResponse.text();
      const csrf = htmlFormValue(html, 'csrf_token');

      const absent = await fetch(`${base}/login/consent`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ mcp_authorization: ref }).toString(),
      });
      LEAK_SCANNER.push(await absent.text());
      expect(absent.status).toBe(403);

      const wrong = await fetch(`${base}/login/consent`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ mcp_authorization: ref, csrf_token: `${csrf}x` }).toString(),
      });
      LEAK_SCANNER.push(await wrong.text());
      expect(wrong.status).toBe(403);

      const right = await fetch(`${base}/login/consent`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ mcp_authorization: ref, csrf_token: csrf }).toString(),
      });
      LEAK_SCANNER.push(right.headers.get('location') || '');
      expect(right.status).toBe(302);

      // A second submission reusing the same consumed CSRF value fails.
      const reused = await fetch(`${base}/login/consent`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ mcp_authorization: ref, csrf_token: csrf }).toString(),
      });
      LEAK_SCANNER.push(await reused.text());
      expect(reused.status).toBe(403);
    });
  });

  describe('S8: the consent navigation must survive a real-browser form redirect (CSP form-action)', () => {
    function formActionDirective(policy) {
      return policy
        .split(';')
        .map((directive) => directive.trim())
        .find((directive) => directive.startsWith('form-action'));
    }

    it('allowlists exactly self and the configured trusted Entra authority origin for the consent page and its redirect', async () => {
      await withServer({}, async ({ base }) => {
        const authorizeResponse = await fetch(
          `${base}/authorize?${new URLSearchParams(authorizeQuery())}`,
          { redirect: 'manual' }
        );
        const ref = new URL(authorizeResponse.headers.get('location')).searchParams.get(
          'mcp_authorization'
        );
        const loginResponse = await fetch(`${base}/login?mcp_authorization=${ref}`);
        const html = await loginResponse.text();
        LEAK_SCANNER.push(html);
        expect(loginResponse.status).toBe(200);
        // Chromium re-checks the *initiating document's* form-action against
        // every redirect hop of the form navigation, so a real browser could
        // not follow the consent POST redirect to Microsoft while the policy
        // carried only 'self' (user-reported S8 block). The policy must
        // permit the navigation to exactly the server-trusted configured
        // Entra authorization origin and the registered client callback
        // origin (the final hop), and nothing else. T14: the self target
        // is spelled as the explicit canonical origin (trusted configuration)
        // rather than the CSP keyword; the client's own registered callback
        // origin is also an explicit named target because Chromium re-checks
        // the initiating form-action against that final redirect hop.
        expect(formActionDirective(loginResponse.headers.get('content-security-policy'))).toBe(
          `form-action ${base} ${new URL(CLIENT_REDIRECT).origin} ${AUTHORITY_HOST}`
        );
        // Any unregistered origin must never become a form-action target
        // (open-redirect and exfiltration remain impossible through this
        // directive).
        expect(
          formActionDirective(loginResponse.headers.get('content-security-policy'))
        ).not.toContain('attacker.example');

        // The redirect response itself carries the same exact allowlist, so
        // the cross-origin hop is the only permitted cross-origin target.
        const consent = await fetch(`${base}/login/consent`, {
          method: 'POST',
          redirect: 'manual',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            mcp_authorization: ref,
            csrf_token: htmlFormValue(html, 'csrf_token'),
          }).toString(),
        });
        LEAK_SCANNER.push(consent.headers.get('location') || '');
        expect(consent.status).toBe(302);
        expect(formActionDirective(consent.headers.get('content-security-policy'))).toBe(
          `form-action ${base} ${new URL(CLIENT_REDIRECT).origin} ${AUTHORITY_HOST}`
        );
      });
    });

    it('keeps error pages form-action self only and shows actionable single-use recovery guidance on a replayed consent', async () => {
      await withServer({}, async ({ base }) => {
        const errorPage = await fetch(`${base}/login?mcp_authorization=unknown-reference-value`);
        LEAK_SCANNER.push(await errorPage.text());
        expect(errorPage.status).toBe(400);
        expect(formActionDirective(errorPage.headers.get('content-security-policy'))).toBe(
          "form-action 'self'"
        );

        // The consent POST is single-use: after its CSRF value is consumed by
        // one submission, no replay of the same form may start another
        // Microsoft sign-in.
        const authorizeResponse = await fetch(
          `${base}/authorize?${new URLSearchParams(authorizeQuery())}`,
          { redirect: 'manual' }
        );
        const ref = new URL(authorizeResponse.headers.get('location')).searchParams.get(
          'mcp_authorization'
        );
        const loginResponse = await fetch(`${base}/login?mcp_authorization=${ref}`);
        const html = await loginResponse.text();
        LEAK_SCANNER.push(html);
        const csrf = htmlFormValue(html, 'csrf_token');
        const consent = await fetch(`${base}/login/consent`, {
          method: 'POST',
          redirect: 'manual',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ mcp_authorization: ref, csrf_token: csrf }).toString(),
        });
        LEAK_SCANNER.push(consent.headers.get('location') || '');
        expect(consent.status).toBe(302);

        const replay = await fetch(`${base}/login/consent`, {
          method: 'POST',
          redirect: 'manual',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ mcp_authorization: ref, csrf_token: csrf }).toString(),
        });
        const replayText = await replay.text();
        LEAK_SCANNER.push(replayText);
        expect(replay.status).toBe(403);
        expect(replay.headers.get('location')).toBeNull();
        const replayBody = JSON.parse(replayText);
        expect(replayBody).toMatchObject({ error: 'csrf-failed' });
        // The stranded user gets clear, safe recovery guidance (never a
        // replay of the consumed form value).
        expect(replayBody.message).toContain('Open the sign-in page again');

        // Deterministic recovery: the pending authorization is still open,
        // and re-opening the sign-in page issues a fresh one-time CSRF, so
        // one explicit re-consent works without weakening single-use.
        const recoveryPage = await fetch(`${base}/login?mcp_authorization=${ref}`);
        const recoveryHtml = await recoveryPage.text();
        LEAK_SCANNER.push(recoveryHtml);
        expect(recoveryPage.status).toBe(200);
        const freshCsrf = htmlFormValue(recoveryHtml, 'csrf_token');
        expect(freshCsrf).not.toBe(csrf);
        const recoveryConsent = await fetch(`${base}/login/consent`, {
          method: 'POST',
          redirect: 'manual',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ mcp_authorization: ref, csrf_token: freshCsrf }).toString(),
        });
        LEAK_SCANNER.push(recoveryConsent.headers.get('location') || '');
        expect(recoveryConsent.status).toBe(302);
        expect(recoveryConsent.headers.get('location')).toMatch(
          /^https:\/\/login\.contoso\.example\//
        );
      });
    });
  });

  it('renders a keyboard-friendly page: a real submit button with focus styles and no scripts', async () => {
    await withServer({}, async ({ base }) => {
      const authorizeResponse = await fetch(
        `${base}/authorize?${new URLSearchParams(authorizeQuery())}`,
        {
          redirect: 'manual',
        }
      );
      const ref = new URL(authorizeResponse.headers.get('location')).searchParams.get(
        'mcp_authorization'
      );
      const html = await fetch(`${base}/login?mcp_authorization=${ref}`).then((r) => r.text());
      LEAK_SCANNER.push(html);
      expect(html).toMatch(/<button[^>]+type="submit"/i);
      expect(html).toMatch(/<html[^>]+lang=/i);
      expect(html).not.toMatch(/<script/i);
      expect(html).toContain('focus-visible');
    });
  });
});

describe('I4/I5 MCP token tool access as the same user', () => {
  it('lists and calls tools through the MCP SDK client with the OAuth-issued token', async () => {
    await withServer({}, async ({ base }) => {
      const flow = await runFullFlow({ base });
      // The upstream code was redeemed once with the exact configured login
      // redirect URI and PKCE S256 verifier.
      const client = new Client({ name: 'external-web-client-test', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${flow.mcpToken}` } },
      });
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
      expect(tools.some((tool) => tool.name === 'list-folders')).toBe(true);
      const result = await client.callTool({ name: 'list-folders', arguments: {} });
      expect(result.isError).toBeUndefined();
      await client.close();
      // The per-request OBO exchange used the server-side resolved upstream
      // Entra token, never the MCP token and never the client's secrets.
      expect(oboRequests.length).toBeGreaterThanOrEqual(1);
      for (const requestConfig of oboRequests) {
        expect(requestConfig.token).toBe(lastUpstreamAccessToken);
        expect(Object.keys(requestConfig).sort()).toEqual([
          'clientId',
          'clientSecret',
          'tenantId',
          'token',
        ]);
        expect(requestConfig.clientId).toBe(ENTRA_CLIENT_ID);
        expect(requestConfig.clientSecret).toBe(ENTRA_CLIENT_SECRET);
        expect(requestConfig.tenantId).toBe(TENANT_ID);
      }
      expect(callGraphAPI.mock.calls[0][0]).toMatch(/^obo-graph-for-/);
    });
  });

  it('dispatches a mutation tool for an OAuth identity with no group or role claim', async () => {
    await withServer({}, async ({ base }) => {
      const flow = await runFullFlow({ base });
      const client = new Client({ name: 'external-mutator-test', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${flow.mcpToken}` } },
      });
      await client.connect(transport);
      const result = await client.callTool({
        name: 'send-chat-message',
        arguments: { chatId: 'chat-1', content: 'hello' },
      });
      expect(result.isError).toBeUndefined();
      await client.close();
      expect(
        callGraphAPI.mock.calls.some(
          (call) => call[1] === 'POST' && call[2] === 'chats/chat-1/messages'
        )
      ).toBe(true);
    });
  });

  it('treats an OAuth identity with ID-token group claims exactly the same', async () => {
    await withServer({}, async ({ base }) => {
      const flow = await runFullFlow({ base, groups: ['any-entra-group'] });
      const client = new Client({ name: 'external-mutator-test', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${flow.mcpToken}` } },
      });
      await client.connect(transport);
      const result = await client.callTool({
        name: 'send-email',
        arguments: { to: 'user@example.com', subject: 's', body: 'b' },
      });
      expect(result.isError).toBeUndefined();
      await client.close();
    });
  });

  it('answers 503 without fallback for /mcp once the upstream Entra token expired and renewal fails transiently', async () => {
    await withServer({ oauth: { accessTokenTtlSeconds: 3600 } }, async ({ base }) => {
      // This flow's mocked upstream redemption returns an access token with
      // expires_in: 1, while the MCP token stays valid for a full hour. After
      // a short real wait, /mcp attempts the T19 bridge renewal; the upstream
      // refresh endpoint is unreachable in this offline scenario, so the
      // renewal fails transiently and the request answers 503.
      const verifier = 'upstream-expiry-test-verifier-0123456789abcd';
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      const query = { ...authorizeQuery(), code_challenge: challenge };
      const authorizeResponse = await fetch(`${base}/authorize?${new URLSearchParams(query)}`, {
        redirect: 'manual',
      });
      const ref = new URL(authorizeResponse.headers.get('location')).searchParams.get(
        'mcp_authorization'
      );
      LEAK_SCANNER.push(authorizeResponse.headers.get('location') || '');
      const loginHtml = await fetch(`${base}/login?mcp_authorization=${ref}`).then((r) => r.text());
      LEAK_SCANNER.push(loginHtml);
      const consent = await fetch(`${base}/login/consent`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          mcp_authorization: ref,
          csrf_token: htmlFormValue(loginHtml, 'csrf_token'),
        }).toString(),
      });
      const entraUrl = new URL(consent.headers.get('location'));
      LEAK_SCANNER.push(consent.headers.get('location') || '');

      await new Promise((resolve) => setTimeout(resolve, 1100));
      enqueueUpstreamRedemption({
        nonce: entraUrl.searchParams.get('nonce'),
        shortExpiry: true,
      });
      const callback = await fetch(
        `${base}/login/callback?${new URLSearchParams({
          state: entraUrl.searchParams.get('state'),
          code: UPSTREAM_CODE,
        })}`,
        { redirect: 'manual' }
      );
      const redirectLocation = callback.headers.get('location') || '';
      LEAK_SCANNER.push(redirectLocation);
      expect(callback.status).toBe(302);
      const tokenResponse = await fetch(`${base}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: new URL(redirectLocation).searchParams.get('code'),
          code_verifier: verifier,
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          redirect_uri: CLIENT_REDIRECT,
        }).toString(),
      });
      const tokenBody = await tokenResponse.text();
      LEAK_SCANNER.push(tokenBody);
      expect(tokenResponse.status).toBe(200);
      const { access_token: mcpToken } = JSON.parse(tokenBody);

      // Determinism: wait out the one-second upstream lifetime after the
      // exchange, so the /mcp refusal is the expired upstream association
      // and not a race.
      await new Promise((resolve) => setTimeout(resolve, 1200));

      const response = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${mcpToken}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      LEAK_SCANNER.push(await response.text());
      // T19: /mcp with a valid MCP token and an expired upstream association
      // now attempts the bridge renewal first; the upstream refresh endpoint
      // is unreachable in this offline scenario, so the request answers 503
      // temporarily_unavailable (retryable, no forced sign-in, no
      // unauthorized fallback token) and never dispatches a tool.
      expect(response.status).toBe(503);
      expect(
        (
          await (
            await fetch(`${base}/mcp`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
                authorization: `Bearer ${mcpToken}`,
              },
              body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
            })
          ).json()
        ).error
      ).toBe('temporarily_unavailable');
      expect(oboRequests.length).toBe(0);
    });
  });
});

describe('I6 the /mcp gate denies everything before valid authentication', () => {
  it('rejects missing, opaque-garbage, and forged-JWT tokens without reaching the OBO factory', async () => {
    await withServer({}, async ({ base }) => {
      const unauthorized = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      LEAK_SCANNER.push(await unauthorized.text());
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers.get('www-authenticate')).toContain('resource_metadata=');

      const garbage = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer not-a-token-at-all',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      });
      LEAK_SCANNER.push(await garbage.text());
      expect(garbage.status).toBe(401);
      expect(garbage.headers.get('www-authenticate')).toContain('error="invalid_token"');
      expect(oboRequests.length).toBe(0);

      const forgedJwt = jwt.sign(
        {
          iss: ENTRA_ISSUER,
          aud: AUDIENCE,
          tid: TENANT_ID,
          oid: 'x',
          sub: 'x',
          scp: REQUIRED_SCOPE,
        },
        crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey,
        { algorithm: 'RS256' }
      );
      const forgedResponse = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${forgedJwt}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
      });
      LEAK_SCANNER.push(await forgedResponse.text());
      expect(forgedResponse.status).toBe(401);
      expect(oboRequests.length).toBe(0);
    });
  });
});

describe('I7 the browser flow fails closed', () => {
  it('refuses unknown and expired MCP authorization references', async () => {
    await withServer({}, async ({ base }) => {
      const unknown = await fetch(`${base}/login?mcp_authorization=unknown-reference-value`);
      LEAK_SCANNER.push(await unknown.text());
      expect(unknown.status).toBe(400);

      const missing = await fetch(`${base}/login`);
      LEAK_SCANNER.push(await missing.text());
      expect(missing.status).toBe(400);

      // An expired pending reference (one-second TTL) is refused and shows
      // no client identity.
      const shortServer = await startServer({
        oauth: { pendingAuthorizationTtlSeconds: 1 },
      });
      try {
        const authorizeResponse = await fetch(
          `${shortServer.base}/authorize?${new URLSearchParams(authorizeQuery())}`,
          { redirect: 'manual' }
        );
        const ref = new URL(authorizeResponse.headers.get('location')).searchParams.get(
          'mcp_authorization'
        );
        await new Promise((resolve) => setTimeout(resolve, 1200));
        const expired = await fetch(`${shortServer.base}/login?mcp_authorization=${ref}`);
        const expiredHtml = await expired.text();
        LEAK_SCANNER.push(expiredHtml);
        expect(expired.status).toBe(400);
        expect(expiredHtml).not.toContain(CLIENT_ID);
      } finally {
        await shortServer.instance.stop();
      }
    });
  });

  it('consumes the callback state so a replayed callback cannot issue a second code', async () => {
    await withServer({}, async ({ base }) => {
      const flow = await runFullFlow({ base });
      // The state was consumed, so the replay is refused before any upstream
      // redemption; no network mock is enqueued here (an unconsumed
      // one-shot mock would leak into a later test).
      const replay = await fetch(
        `${base}/login/callback?${new URLSearchParams({
          state: flow.entraUrl.searchParams.get('state'),
          code: UPSTREAM_CODE,
        })}`,
        { redirect: 'manual' }
      );
      LEAK_SCANNER.push(await replay.text(), replay.headers.get('location') || '');
      expect(replay.status).toBe(400);
    });
  });

  it('turns a provider-error callback into a bounded error page and keeps consent retryable', async () => {
    await withServer({}, async ({ base }) => {
      const authorizeResponse = await fetch(
        `${base}/authorize?${new URLSearchParams(authorizeQuery())}`,
        {
          redirect: 'manual',
        }
      );
      const ref = new URL(authorizeResponse.headers.get('location')).searchParams.get(
        'mcp_authorization'
      );
      const loginResponse = await fetch(`${base}/login?mcp_authorization=${ref}`);
      const html = await loginResponse.text();
      LEAK_SCANNER.push(html);

      const consent = await fetch(`${base}/login/consent`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          mcp_authorization: ref,
          csrf_token: htmlFormValue(html, 'csrf_token'),
        }).toString(),
      });
      const entraUrl = new URL(consent.headers.get('location'));
      LEAK_SCANNER.push(consent.headers.get('location') || '');

      const denied = await fetch(
        `${base}/login/callback?${new URLSearchParams({
          state: entraUrl.searchParams.get('state'),
          error: 'access_denied',
        })}`,
        { redirect: 'manual' }
      );
      const deniedHtml = await denied.text();
      LEAK_SCANNER.push(deniedHtml);
      expect(denied.status).toBe(400);
      expect(deniedHtml).not.toContain(ENTRA_CLIENT_ID);

      // The pending MCP authorization survives and can be consented again.
      const retryLogin = await fetch(`${base}/login?mcp_authorization=${ref}`);
      const retryHtml = await retryLogin.text();
      LEAK_SCANNER.push(retryHtml);
      expect(retryLogin.status).toBe(200);
    });
  });

  it('denies unknown clients and unregistered redirects at /authorize with a direct 400', async () => {
    await withServer({}, async ({ base }) => {
      const unknownClient = await fetch(
        `${base}/authorize?${new URLSearchParams({
          response_type: 'code',
          client_id: 'never-registered-client',
          redirect_uri: 'https://attacker.example/cb',
          scope: MCP_SCOPE,
          code_challenge: pkce().challenge,
          code_challenge_method: 'S256',
        })}`,
        { redirect: 'manual' }
      );
      LEAK_SCANNER.push(await unknownClient.text());
      expect(unknownClient.status).toBe(400);

      const unregisteredRedirect = await fetch(
        `${base}/authorize?${new URLSearchParams({
          ...authorizeQuery(),
          redirect_uri: 'https://attacker.example/cb',
        })}`,
        { redirect: 'manual' }
      );
      LEAK_SCANNER.push(await unregisteredRedirect.text());
      expect(unregisteredRedirect.status).toBe(400);
    });
  });

  it('never allows a completed MCP authorization reference to complete twice', async () => {
    await withServer({}, async ({ base }) => {
      const flow = await runFullFlow({ base });
      expect(flow.ref.length).toBeGreaterThan(0);
      // The consumed reference no longer renders a consent page.
      const replayLogin = await fetch(`${base}/login?mcp_authorization=${flow.ref}`);
      LEAK_SCANNER.push(await replayLogin.text());
      expect(replayLogin.status).toBe(400);
    });
  });

  /**
   * Runs the browser flow with one crafted upstream Entra access token and
   * returns the callback response plus the pending reference. The callback
   * must fail closed (generic bounded error page) whenever that token does
   * not verify for this API, issuer, tenant, delegation scopes, and the same
   * user object ID as the ID token, and must leave the pending authorization
   * alive for consent retry.
   */
  async function runFlowWithCraftedUpstreamToken({ base, upstream }) {
    const pkcePair = pkce();
    const authorizeResponse = await fetch(
      `${base}/authorize?${new URLSearchParams(authorizeQuery({ pkce: pkcePair, state: 'crafted-token-state' }))}`,
      { redirect: 'manual' }
    );
    const loginLocation = authorizeResponse.headers.get('location');
    LEAK_SCANNER.push(loginLocation || '');
    const ref = new URL(loginLocation, base).searchParams.get('mcp_authorization');
    const loginHtml = await fetch(`${base}/login?mcp_authorization=${ref}`).then((r) => r.text());
    LEAK_SCANNER.push(loginHtml);
    const consent = await fetch(`${base}/login/consent`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        mcp_authorization: ref,
        csrf_token: htmlFormValue(loginHtml, 'csrf_token'),
      }).toString(),
    });
    LEAK_SCANNER.push(consent.headers.get('location') || '');
    expect(consent.status).toBe(302);
    const entraUrl = new URL(consent.headers.get('location'));
    enqueueUpstreamRedemption({ nonce: entraUrl.searchParams.get('nonce'), upstream });
    const response = await fetch(
      `${base}/login/callback?${new URLSearchParams({
        state: entraUrl.searchParams.get('state'),
        code: UPSTREAM_CODE,
      })}`,
      { redirect: 'manual' }
    );
    return { ref, response, html: await response.text(), pkcePair };
  }

  describe('the upstream access token is verified before any MCP authorization binds (T8 correction)', () => {
    it('fails closed when the token was issued for a different API audience', async () => {
      await withServer({}, async ({ base }) => {
        const crafted = await runFlowWithCraftedUpstreamToken({
          base,
          upstream: { aud: 'https://wrong-resource.example/api' },
        });
        LEAK_SCANNER.push(crafted.html);
        expect(crafted.response.status).toBe(400);
        expect(crafted.html).toContain('Microsoft sign-in could not be completed');
        expect(crafted.html).not.toContain(CLIENT_SECRET);
        expect(oboRequests.length).toBe(0);
        // The pending MCP authorization survives for one explicit retry.
        const retry = await fetch(`${base}/login?mcp_authorization=${crafted.ref}`);
        LEAK_SCANNER.push(await retry.text());
        expect(retry.status).toBe(200);
      });
    });

    it('fails closed when the token lacks the required delegated scope', async () => {
      await withServer({}, async ({ base }) => {
        const crafted = await runFlowWithCraftedUpstreamToken({
          base,
          upstream: { scp: 'unrelated.scope' },
        });
        LEAK_SCANNER.push(crafted.html);
        expect(crafted.response.status).toBe(400);
        expect(oboRequests.length).toBe(0);
      });
    });

    it('refuses the API-qualified scope URI in scp: issued tokens carry short scope names', async () => {
      await withServer({}, async ({ base }) => {
        const crafted = await runFlowWithCraftedUpstreamToken({
          base,
          upstream: { scp: UPSTREAM_SCOPE },
        });
        LEAK_SCANNER.push(crafted.html);
        expect(crafted.response.status).toBe(400);
        expect(oboRequests.length).toBe(0);
      });
    });

    it('fails closed when the token belongs to a different user than the ID token', async () => {
      await withServer({}, async ({ base }) => {
        const crafted = await runFlowWithCraftedUpstreamToken({
          base,
          upstream: { oid: 'different-user-object-id' },
        });
        LEAK_SCANNER.push(crafted.html);
        expect(crafted.response.status).toBe(400);
        expect(oboRequests.length).toBe(0);
      });
    });

    it('fails closed when the token was issued for another tenant or issuer', async () => {
      await withServer({}, async ({ base }) => {
        const crafted = await runFlowWithCraftedUpstreamToken({
          base,
          upstream: {
            iss: `https://login.microsoftonline.com/${OTHER_TENANT_ID}/v2.0`,
            tid: OTHER_TENANT_ID,
          },
        });
        LEAK_SCANNER.push(crafted.html);
        expect(crafted.response.status).toBe(400);
        expect(oboRequests.length).toBe(0);
      });
    });
  });
});

describe('I9 the existing Entra bearer path keeps working while OAuth is enabled', () => {
  it('accepts the raw delegated Entra access token on /mcp and keeps discovery intact', async () => {
    await withServer({}, async ({ base }) => {
      const token = signEntraToken();
      const response = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.result.tools.length).toBeGreaterThan(0);
    });
  });

  it('refuses OAuth tokens that exceed the MCP token shape without authentication', async () => {
    await withServer({}, async ({ base }) => {
      // Two-dot JWT-shaped junk with the Entra verifier's audience fails.
      const junk = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer a.b.c',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      LEAK_SCANNER.push(await junk.text());
      expect(junk.status).toBe(401);
      expect(oboRequests.length).toBe(0);
    });
  });
});
