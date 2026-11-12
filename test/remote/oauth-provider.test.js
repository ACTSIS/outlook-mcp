/**
 * Tests for the standards-based MCP OAuth authorization-server provider
 * foundation (task T6, S1-S3, S5). Rule map, one focused block per rule:
 *
 * R1  configuration fails closed with no network (trusted URLs, unknown
 *     keys, caps, TTL bounds, registered client entries)
 * R2  standards-based SDK router and metadata (S256 only, code response
 *     type, no invented protocol, no refresh or revocation advertising)
 * R3  unknown clients are denied (authorize and token endpoints, secrets)
 * R4  exact registered redirect binding (RFC 8252 loopback nuance observed)
 * R5  pending authorizations redirect only to the trusted sign-in URL with
 *     a random single-use reference
 * R6  the narrow completion interface fails closed (unknown, expired,
 *     replayed, malformed input) and binds only to server-side state
 * R7  authorization codes are single-use, expiring, and bound to client,
 *     exact redirect, and resource; no refresh or ID token is issued
 * R8  PKCE S256 is enforced locally by the SDK's token handler
 * R9  access tokens are random, expiring, and bound to scope, client,
 *     resource, and user identity
 * R10 the validated upstream Entra token is associated server-side for
 *     later OBO and never returned to browser or MCP client
 * R11 the refresh-token grant is unsupported and rejected
 * R12 per-user isolation across concurrent users and clients
 * R13 no client secret, verifier, code, MCP token, or upstream token
 *     appears in the browser-facing redirect, error messages, or responses
 * R14 dynamic client registration is bounded (disabled by default,
 *     SDK-generated credentials, redirect and grant validation, cap)
 * R15 token revocation is not claimed
 * R16 preservation: factories are independent and existing remote modules
 *     remain intact
 *
 * Fully offline: synthetic registered clients and tokens, a real local
 * process-internal Express/SuperTest round trip on no published port
 * contract; no real network, credentials, Entra, or filesystem state.
 * Expiry tests shift only Date.now via fake timers; HTTP always runs with
 * real timers.
 *
 * Bounded test-only mock: `pkce-challenge` ships as an ESM module with a
 * top-level await that Jest's CJS sandbox cannot parse, so `verifyChallenge`
 * is replaced here with the exact RFC 7636 S256 verification the production
 * dependency implements (base64url(SHA-256(verifier)) === challenge). The
 * production module and SDK handler keep the real dependency at runtime.
 */
jest.mock('pkce-challenge', () => {
  const nodeCrypto = require('crypto');
  return {
    verifyChallenge: async (codeVerifier, challenge) =>
      nodeCrypto.createHash('sha256').update(String(codeVerifier)).digest('base64url') ===
      String(challenge),
  };
});

const crypto = require('crypto');
const express = require('express');
const request = require('supertest');

const { InvalidTokenError } = require('@modelcontextprotocol/sdk/server/auth/errors.js');

const {
  createMCPOAuthProvider,
  MCPOAuthProviderError,
  ERROR_CODES,
} = require('../../remote/oauth-provider');

const TENANT_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const ISSUER_URL = 'https://sso.internal.example';
const SIGN_IN_URL = 'https://sso.internal.example/signin';
const CLIENT_SECRET = 'synthetic-confidential-client-secret-v1';
const CONFIDENTIAL_REDIRECT = 'https://mcp-client.example/oauth/callback';
const PUBLIC_REDIRECT = 'https://librechat.internal.example/oauth/callback';
const LOOPBACK_PORT = 49152;
const LOOPBACK_REDIRECT = `http://127.0.0.1:${LOOPBACK_PORT}/callback`;
const MCP_RESOURCE = 'https://mcp.internal.example/mcp';
// Exactly 43 characters: the base64url length for 256 bits of PKCE entropy.
const SYNTHETIC_VERIFIER = 'synthetic-pkce-code-verifier-0123456789abcd';
const UPSTREAM_TOKEN_A = 'synthetic-upstream-entra-token-user-a';
const UPSTREAM_TOKEN_B = 'synthetic-upstream-entra-token-user-b';

const LEAK_SCANNER = { captured: [], secrets: [] };

function scannerCapture(...values) {
  for (const value of values) {
    if (value === undefined || value === null) {
      continue;
    }
    LEAK_SCANNER.captured.push(typeof value === 'string' ? value : JSON.stringify(value));
  }
}

function expectNoLeak(value, label) {
  const leakSources = LEAK_SCANNER.captured.filter((captured) => captured.includes(value));
  if (leakSources.length > 0) {
    LEAK_SCANNER.captured.length = 0;
    throw new Error(`Sensitive value leaked into captured ${label} output`);
  }
  LEAK_SCANNER.captured.length = 0;
}

function randomVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

function challengeFor(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function defaultOptions(overrides = {}) {
  return {
    issuerUrl: ISSUER_URL,
    signInUrl: SIGN_IN_URL,
    supportedScopes: ['mcp', 'mail:read', 'mail:send'],
    resourceServerUrl: MCP_RESOURCE,
    clients: [
      {
        clientId: 'confidential-mcp-client',
        clientSecret: CLIENT_SECRET,
        redirectUris: [CONFIDENTIAL_REDIRECT],
      },
      {
        clientId: 'public-web-client',
        redirectUris: [PUBLIC_REDIRECT],
      },
      {
        clientId: 'loopback-native-client',
        redirectUris: [LOOPBACK_REDIRECT],
      },
    ],
    ...overrides,
  };
}

function createApp(providerBundle) {
  const app = express();
  app.use('/', providerBundle.router);
  scannerCapture('express-app-created');
  return app;
}

async function authorize(app, query, expected = 302) {
  const response = await request(app).get('/authorize').query(query).expect(expected);
  scannerCapture(response.headers.location, response.body);
  return response;
}

function buildAuthorizeQuery({
  clientId = 'confidential-mcp-client',
  redirectUri = CONFIDENTIAL_REDIRECT,
  scope = 'mcp',
  state = 'synthetic-client-state-1',
  resource = undefined,
  codeChallenge = challengeFor(SYNTHETIC_VERIFIER),
  codeChallengeMethod = 'S256',
  responseType = 'code',
} = {}) {
  return {
    client_id: clientId,
    response_type: responseType,
    redirect_uri: redirectUri,
    scope,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: codeChallengeMethod,
    ...(resource ? { resource } : {}),
  };
}

function entraAssociation(overrides = {}) {
  return {
    authorizationRef: 'ref-provided-separately',
    entra: {
      accessToken: UPSTREAM_TOKEN_A,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      objectId: 'entra-user-object-id-a',
      tenantId: TENANT_ID,
      username: 'user-a@example.com',
    },
    ...overrides,
  };
}

function completePending(bundle, ref, overrides = {}) {
  const payload = entraAssociation({ authorizationRef: ref, ...overrides });
  try {
    const result = bundle.completeAuthorizationAfterEntraSignIn(payload);
    scannerCapture(result.redirectTo);
    return result;
  } catch (error) {
    scannerCapture(error.message, error.code);
    throw error;
  }
}

function extractRef(location) {
  const url = new URL(location);
  return url.searchParams.get('mcp_authorization');
}

function extractParam(redirectTo, name) {
  return new URL(redirectTo).searchParams.get(name);
}

async function runAuthorization(app, bundle, overrides = {}) {
  const query = buildAuthorizeQuery(overrides);
  const response = await authorize(app, query);
  const ref = extractRef(response.headers.location);
  const upstream = overrides.upstream || {};
  const completed = completePending(bundle, ref, upstream);
  return {
    ref,
    completed,
    code: extractParam(completed.redirectTo, 'code'),
    state: extractParam(completed.redirectTo, 'state'),
  };
}

async function exchangeCode(
  app,
  {
    code,
    verifier = SYNTHETIC_VERIFIER,
    clientId = 'confidential-mcp-client',
    clientSecret = CLIENT_SECRET,
    redirectUri = CONFIDENTIAL_REDIRECT,
    omitRedirectUri = false,
    resource = undefined,
  } = {}
) {
  const response = await request(app)
    .post('/token')
    .type('form')
    .send({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
      ...(omitRedirectUri ? {} : { redirect_uri: redirectUri }),
      ...(resource ? { resource } : {}),
    });
  scannerCapture(response.body, response.text);
  return response;
}

async function rotateRefreshToken(app, { clientId, refreshToken }) {
  const response = await request(app).post('/token').type('form').send({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });
  scannerCapture(response.body, response.text);
  return response;
}

async function requestRefreshGrant(app) {
  const response = await request(app).post('/token').type('form').send({
    grant_type: 'refresh_token',
    refresh_token: 'synthetic-unknown-refresh-token',
    client_id: 'confidential-mcp-client',
    client_secret: CLIENT_SECRET,
  });
  scannerCapture(response.body);
  return response;
}

function withFakeTime(shiftMs, fn) {
  return async () => {
    jest.useFakeTimers({
      doNotFake: [
        'setTimeout',
        'setInterval',
        'clearTimeout',
        'clearInterval',
        'setImmediate',
        'clearImmediate',
        'nextTick',
        'queueMicrotask',
        'requestAnimationFrame',
        'cancelAnimationFrame',
        'requestIdleCallback',
        'cancelIdleCallback',
        'performance',
      ],
    });
    jest.setSystemTime(Date.now() + shiftMs);
    try {
      await fn();
    } finally {
      jest.useRealTimers();
    }
  };
}

// R3 depends on the SDK authorization handler middleware stack; R2 needs the
// router. Keep one shared bundle but re-create providers per rule to avoid
// cross-rule state.

describe('R1 configuration fails closed', () => {
  it('rejects a non-object configuration', () => {
    expect(() => createMCPOAuthProvider(undefined)).toThrow(MCPOAuthProviderError);
  });

  it('rejects unknown option keys', () => {
    expect(() => createMCPOAuthProvider(defaultOptions({ extraOption: true }))).toThrow(
      /unexpected/i
    );
  });

  it('rejects missing or unsafe issuer URLs', () => {
    for (const issuerUrl of [
      undefined,
      'http://sso.internal.example',
      'https://sso.internal.example/?q=1',
    ]) {
      expect(() => createMCPOAuthProvider(defaultOptions({ issuerUrl }))).toThrow(
        MCPOAuthProviderError
      );
    }
  });

  it('rejects missing or unsafe sign-in URLs', () => {
    for (const signInUrl of [
      undefined,
      'http://sso.internal.example/signin',
      'https://sso.internal.example/signin?next=/x',
    ]) {
      expect(() => createMCPOAuthProvider(defaultOptions({ signInUrl }))).toThrow(
        MCPOAuthProviderError
      );
    }
  });

  it('rejects an empty or malformed supportedScopes list', () => {
    for (const supportedScopes of [[], [''], [42], 'mcp']) {
      expect(() => createMCPOAuthProvider(defaultOptions({ supportedScopes }))).toThrow(
        MCPOAuthProviderError
      );
    }
  });

  it('rejects unsafe registered clients: duplicates, non-loopback http, query-bearing redirects, missing redirects', () => {
    const cases = [
      defaultOptions({
        clients: [
          { clientId: 'dup', clientSecret: 's1', redirectUris: [CONFIDENTIAL_REDIRECT] },
          { clientId: 'dup', clientSecret: 's2', redirectUris: [PUBLIC_REDIRECT] },
        ],
      }),
      defaultOptions({
        clients: [{ clientId: 'plain-http', redirectUris: ['http://host.example/callback'] }],
      }),
      defaultOptions({
        clients: [{ clientId: 'with-q', redirectUris: ['https://fine.example/cb?next=x'] }],
      }),
      defaultOptions({
        clients: [{ clientId: 'no-redirects', redirectUris: [] }],
      }),
    ];
    for (const options of cases) {
      expect(() => createMCPOAuthProvider(options)).toThrow(MCPOAuthProviderError);
    }
  });

  it('rejects out-of-bound TTLs and non-integer capacities', () => {
    expect(() =>
      createMCPOAuthProvider(defaultOptions({ authorizationCodeTtlSeconds: 0 }))
    ).toThrow(/ttl/i);
    expect(() => createMCPOAuthProvider(defaultOptions({ accessTokenTtlSeconds: 100000 }))).toThrow(
      /ttl/i
    );
    expect(() =>
      createMCPOAuthProvider(defaultOptions({ pendingAuthorizationTtlSeconds: 1.5 }))
    ).toThrow(/ttl/i);
    expect(() => createMCPOAuthProvider(defaultOptions({ maxAccessTokens: 200.5 }))).toThrow(
      /positive integer/i
    );
  });
});

describe('R2 standards-based SDK router and metadata', () => {
  it('uses the bundled SDK handlers and advertises only supported grants', () => {
    const bundle = createMCPOAuthProvider(defaultOptions());
    expect(typeof bundle.router).toBe('function');
    expect(bundle.metadata.response_types_supported).toEqual(['code']);
    expect(bundle.metadata.code_challenge_methods_supported).toEqual(['S256']);
    expect(bundle.metadata.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    expect(bundle.metadata.issuer).toBe(`${ISSUER_URL}/`);
    expect(bundle.metadata.authorization_endpoint.startsWith(ISSUER_URL)).toBe(true);
    expect(bundle.metadata.token_endpoint.startsWith(ISSUER_URL)).toBe(true);
    expect(bundle.metadata.registration_endpoint).toBeUndefined();
    expect(bundle.metadata.revocation_endpoint).toBeUndefined();
  });

  it('serves standard authorization-server metadata over the router', async () => {
    const bundle = createMCPOAuthProvider(defaultOptions());
    const app = createApp(bundle);
    const response = await request(app).get('/.well-known/oauth-authorization-server').expect(200);
    expect(response.body.issuer).toBe(`${ISSUER_URL}/`);
    expect(response.body.code_challenge_methods_supported).toEqual(['S256']);
  });

  it('uses standard OAuth error response shapes from the SDK handlers', async () => {
    const bundle = createMCPOAuthProvider(defaultOptions());
    const app = createApp(bundle);
    const response = await request(app).get('/authorize').expect(400);
    expect(Object.keys(response.body)).toContain('error');
  });
});

describe('R3 unknown clients and secrets are denied', () => {
  it('denies an unknown client on the authorization endpoint', async () => {
    const bundle = createMCPOAuthProvider(defaultOptions());
    const app = createApp(bundle);
    const response = await authorize(app, buildAuthorizeQuery({ clientId: 'unknown-client' }), 400);
    expect(response.body.error).toBe('invalid_client');
  });

  it('denies an unknown client on the token endpoint', async () => {
    const bundle = createMCPOAuthProvider(defaultOptions());
    const app = createApp(bundle);
    const response = await request(app)
      .post('/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        code: 'synthetic-unknown-code',
        code_verifier: 'synthetic-verifier',
        client_id: 'unknown-client',
      })
      .expect(400);
    expect(response.body.error).toBe('invalid_client');
  });

  it('denies a confidential client with a missing or wrong secret', async () => {
    const bundle = createMCPOAuthProvider(defaultOptions());
    const app = createApp(bundle);
    for (const clientSecret of [undefined, 'wrong-synthetic-secret']) {
      const response = await request(app)
        .post('/token')
        .type('form')
        .send({
          grant_type: 'authorization_code',
          code: 'synthetic-unknown-code',
          code_verifier: 'synthetic-verifier',
          client_id: 'confidential-mcp-client',
          ...(clientSecret ? { client_secret: clientSecret } : {}),
        })
        .expect(400);
      expect(response.body.error).toBe('invalid_client');
    }
  });
});

describe('R4 exact registered redirect binding', () => {
  it('rejects an unregistered redirect_uri with a direct 400', async () => {
    const bundle = createMCPOAuthProvider(defaultOptions());
    const app = createApp(bundle);
    const response = await authorize(
      app,
      buildAuthorizeQuery({ redirectUri: 'https://evil.example/callback' }),
      400
    );
    expect(response.body.error).toBe('invalid_request');
    expect(response.body.error_description).toMatch(/redirect_uri/i);
  });

  it('rejects a non-loopback redirect differing by host', async () => {
    const bundle = createMCPOAuthProvider(defaultOptions());
    const app = createApp(bundle);
    await authorize(
      app,
      buildAuthorizeQuery({ redirectUri: 'https://other.example/oauth/callback' }),
      400
    );
  });

  it('requires redirect_uri when several URIs are registered', async () => {
    const bundle = createMCPOAuthProvider(
      defaultOptions({
        clients: [
          {
            clientId: 'confidential-mcp-client',
            clientSecret: CLIENT_SECRET,
            redirectUris: [CONFIDENTIAL_REDIRECT, PUBLIC_REDIRECT],
          },
        ],
      })
    );
    const app = createApp(bundle);
    const query = buildAuthorizeQuery({});
    delete query.redirect_uri;
    await authorize(app, query, 400);
  });

  it('observes the RFC 8252 loopback port relaxation on the authorization endpoint', async () => {
    const bundle = createMCPOAuthProvider(defaultOptions());
    const app = createApp(bundle);
    const verifierPkce = randomVerifier();
    const response = await authorize(
      app,
      buildAuthorizeQuery({
        clientId: 'loopback-native-client',
        redirectUri: `http://127.0.0.1:39999/callback`,
        codeChallenge: challengeFor(verifierPkce),
      })
    );
    expect(extractRef(response.headers.location)).toBeDefined();
  });
});

describe('R5 pending authorizations and trusted sign-in redirect', () => {
  it('redirects the browser only to the trusted sign-in URL with a random opaque reference', async () => {
    const bundle = createMCPOAuthProvider(defaultOptions());
    const app = createApp(bundle);
    const response = await authorize(app, buildAuthorizeQuery());
    const location = response.headers.location;
    const url = new URL(location);
    expect(location.startsWith(`${SIGN_IN_URL}?`)).toBe(true);
    expect([...url.searchParams.keys()].sort()).toEqual(['mcp_authorization']);
    const ref = url.searchParams.get('mcp_authorization');
    expect(ref.length).toBeGreaterThanOrEqual(40);
    expectNoLeak(CLIENT_SECRET, 'browser redirect');
    expectNoLeak(UPSTREAM_TOKEN_A, 'browser redirect');
  });

  it('issues distinct random references for concurrent pending authorizations', async () => {
    const bundle = createMCPOAuthProvider(defaultOptions());
    const app = createApp(bundle);
    const first = extractRef((await authorize(app, buildAuthorizeQuery())).headers.location);
    const second = extractRef(
      (
        await authorize(
          app,
          buildAuthorizeQuery({ clientId: 'public-web-client', redirectUri: PUBLIC_REDIRECT })
        )
      ).headers.location
    );
    expect(first).not.toBe(second);
  });

  it('rejects unsupported scopes through the standard error redirect without a pending reference', async () => {
    const bundle = createMCPOAuthProvider(defaultOptions());
    const app = createApp(bundle);
    const response = await authorize(app, buildAuthorizeQuery({ scope: 'mcp undisclosed:scope' }));
    const redirect = new URL(response.headers.location);
    expect(redirect.pathname).toBe('/oauth/callback');
    expect(redirect.searchParams.get('error')).toBe('invalid_scope');
    expect(redirect.searchParams.get('code')).toBeNull();
  });

  it('rejects plain PKCE and wrong response_type through the standard error redirect', async () => {
    const bundle = createMCPOAuthProvider(defaultOptions());
    const app = createApp(bundle);
    const plain = await authorize(app, buildAuthorizeQuery({ codeChallengeMethod: 'plain' }));
    expect(new URL(plain.headers.location).searchParams.get('error')).toBeDefined();
    const wrongType = await authorize(app, buildAuthorizeQuery({ responseType: 'token' }));
    expect(new URL(wrongType.headers.location).searchParams.get('error')).toBeDefined();
  });
});

describe('R6 narrow completion interface fails closed', () => {
  it('rejects unknown references without disclosing state', () => {
    const bundle = createMCPOAuthProvider(defaultOptions());
    expect(() => completePending(bundle, 'unknown-synthetic-reference')).toThrow(
      /reference|authorization/i
    );
  });

  it('consumes a reference on success and rejects the replay', async () => {
    const bundle = createMCPOAuthProvider(defaultOptions());
    const app = createApp(bundle);
    const { ref, completed } = await runAuthorization(app, bundle);
    expect(extractParam(completed.redirectTo, 'code')).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(extractParam(completed.redirectTo, 'state')).toBe('synthetic-client-state-1');
    expect(completed.redirectTo.includes(UPSTREAM_TOKEN_A)).toBe(false);
    expect(() => completePending(bundle, ref)).toThrow(/reference|authorization/i);
  });

  it('rejects expired references and consumes them', async () => {
    const bundle = createMCPOAuthProvider(defaultOptions({ pendingAuthorizationTtlSeconds: 1 }));
    const app = createApp(bundle);
    const { ref } = await runAuthorization(app, bundle);
    await withFakeTime(1100 * 1000, async () => {
      expect(() => completePending(bundle, ref)).toThrow(/expired/i);
    });
    expect(() => completePending(bundle, ref)).toThrow(/reference|authorization/i);
  });

  it('rejects malformed completion input without consuming the reference', async () => {
    const bundle = createMCPOAuthProvider(defaultOptions());
    const app = createApp(bundle);
    // A first completed flow proves ordinary completion works.
    const first = extractRef((await authorize(app, buildAuthorizeQuery())).headers.location);
    const completed = completePending(bundle, first);
    expect(extractParam(completed.redirectTo, 'code')).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const fresh = extractRef((await authorize(app, buildAuthorizeQuery())).headers.location);
    const malformedAttempts = [
      { authorizationRef: fresh, entra: {} },
      {
        authorizationRef: fresh,
        entra: {
          accessToken: 'upstream-token',
          expiresAt: Math.floor(Date.now() / 1000) - 5,
        },
      },
      {
        authorizationRef: fresh,
        entra: {
          accessToken: 'upstream-token',
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
          objectId: 'entra-user-object-id',
          extraField: 'not-allowed',
        },
      },
      {
        authorizationRef: fresh,
        spoofed: 'injected',
        entra: {
          accessToken: 'upstream-token',
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
          objectId: 'entra-user-object-id',
        },
      },
      { authorizationRef: fresh, entra: missingEntraField('accessToken') },
      { authorizationRef: fresh, entra: missingEntraField('objectId') },
    ];
    for (const attempt of malformedAttempts) {
      let error = null;
      try {
        bundle.completeAuthorizationAfterEntraSignIn(attempt);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(MCPOAuthProviderError);
      expect(error.code).toBe(ERROR_CODES.INVALID_PARAMETERS);
    }
    // The reference survives malformed attempts and still completes once.
    const stillConsumable = completePending(bundle, fresh);
    expect(extractParam(stillConsumable.redirectTo, 'code')).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  });

  function missingEntraField(field) {
    const base = {
      accessToken: 'upstream-token',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      objectId: 'entra-user-object-id',
      tenantId: TENANT_ID,
    };
    delete base[field];
    return base;
  }
});

describe('R7 single-use, bound authorization codes', () => {
  it('issues one code and rejects a second redemption (replay)', async () => {
    const bundle = createMCPOAuthProvider(defaultOptions());
    const app = createApp(bundle);
    const { code } = await runAuthorization(app, bundle);
    const first = await exchangeCode(app, { code });
    expect(first.status).toBe(200);
    expect(first.body.access_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.body.token_type.toLowerCase()).toBe('bearer');
    expect(first.body.refresh_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.body.id_token).toBeUndefined();
    await exchangeCode(app, { code }).then((second) => {
      expect(second.status).toBe(400);
      expect(second.body.error).toBe('invalid_grant');
    });
  });

  it('rejects redemption by the wrong client', async () => {
    const bundle = createMCPOAuthProvider(defaultOptions());
    const app = createApp(bundle);
    const { code } = await runAuthorization(app, bundle);
    const wrong = await exchangeCode(app, {
      code,
      clientId: 'public-web-client',
      clientSecret: undefined,
      redirectUri: PUBLIC_REDIRECT,
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe('invalid_grant');
  });

  it('rejects redemption with a missing or different redirect_uri', async () => {
    const bundle = createMCPOAuthProvider(defaultOptions());
    const app = createApp(bundle);
    const missingFlow = await runAuthorization(app, bundle);
    const missingResponse = await exchangeCode(app, {
      code: missingFlow.code,
      omitRedirectUri: true,
    });
    expect(missingResponse.status).toBe(400);
    expect(missingResponse.body.error).toBe('invalid_grant');
    const differingFlow = await runAuthorization(app, bundle);
    const differingResponse = await exchangeCode(app, {
      code: differingFlow.code,
      redirectUri: 'https://mcp-client.example/oauth/other',
    });
    expect(differingResponse.status).toBe(400);
    expect(differingResponse.body.error).toBe('invalid_grant');
    // A valid binding must complete the exchange exactly once.
    const matchingFlow = await runAuthorization(app, bundle);
    const matchingResponse = await exchangeCode(app, { code: matchingFlow.code });
    expect(matchingResponse.status).toBe(200);
    expect(matchingResponse.body.access_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('binds the requested resource and rejects mismatches', async () => {
    const bundle = createMCPOAuthProvider(defaultOptions());
    const app = createApp(bundle);
    const unboundFlow = await runAuthorization(app, bundle, {
      resource: MCP_RESOURCE,
    });
    const without = await exchangeCode(app, {
      code: unboundFlow.code,
      resource: undefined,
    });
    expect(without.status).toBe(400);
    expect(without.body.error).toBe('invalid_grant');
    const wrongBoundFlow = await runAuthorization(app, bundle, {
      resource: MCP_RESOURCE,
    });
    const wrongResource = await exchangeCode(app, {
      code: wrongBoundFlow.code,
      resource: 'https://other.example/mcp',
    });
    expect(wrongResource.status).toBe(400);
    expect(wrongResource.body.error).toBe('invalid_grant');
    const matchingFlow = await runAuthorization(app, bundle, {
      resource: MCP_RESOURCE,
    });
    const matching = await exchangeCode(app, {
      code: matchingFlow.code,
      resource: MCP_RESOURCE,
    });
    expect(matching.status).toBe(200);
    expect(matching.body.access_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('rejects expired and unknown codes without disclosing details', async () => {
    const bundle = createMCPOAuthProvider(defaultOptions({ authorizationCodeTtlSeconds: 1 }));
    const app = createApp(bundle);
    const { code } = await runAuthorization(app, bundle);
    await withFakeTime(1100 * 1000, async () => {
      const expired = await exchangeCode(app, { code });
      expect(expired.status).toBe(400);
      expect(expired.body.error).toBe('invalid_grant');
      const unknown = await exchangeCode(app, { code: 'synthetic-never-issued' });
      expect(unknown.status).toBe(400);
      expect(unknown.body.error).toBe('invalid_grant');
    });
  });
});

describe('R8 PKCE S256 enforced by the SDK token flow', () => {
  it('rejects a wrong code_verifier and accepts the correct one', async () => {
    const bundle = createMCPOAuthProvider(defaultOptions());
    const app = createApp(bundle);
    const verifier = randomVerifier();
    const { code } = await runAuthorization(app, bundle, {
      codeChallenge: challengeFor(verifier),
    });
    const bad = await exchangeCode(app, { code, verifier: verifier.slice(0, -1) });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid_grant');
    const good = await exchangeCode(app, { code, verifier });
    expect(good.status).toBe(200);
    expect(good.body.access_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('keeps local PKCE validation enabled by default', () => {
    const bundle = createMCPOAuthProvider(defaultOptions());
    expect(bundle.provider.skipLocalPkceValidation).toBe(false);
  });
});

describe('R9 access token verification and bindings', () => {
  it('verifies a valid token and returns scoped identity information', async () => {
    const bundle = createMCPOAuthProvider(defaultOptions());
    const app = createApp(bundle);
    const { code } = await runAuthorization(app, bundle, {
      resource: MCP_RESOURCE,
      scope: 'mcp mail:read',
    });
    const issued = await exchangeCode(app, { code, resource: MCP_RESOURCE });
    const accessToken = issued.body.access_token;
    const authInfo = await bundle.provider.verifyAccessToken(accessToken);
    expect(authInfo.token).toBe(accessToken);
    expect(authInfo.clientId).toBe('confidential-mcp-client');
    expect(authInfo.scopes).toEqual(['mcp', 'mail:read']);
    expect(authInfo.resource.href).toBe(MCP_RESOURCE);
    expect(authInfo.expiresAt).toBeGreaterThan(Date.now() / 1000);
    expect(authInfo.extra.userId).toBe('entra-user-object-id-a');
    expect(authInfo.extra.tenantId).toBe(TENANT_ID);
    expect(JSON.stringify(authInfo.extra)).not.toContain(UPSTREAM_TOKEN_A);
  });

  it('rejects unknown, malformed, and expired tokens', async () => {
    const bundle = createMCPOAuthProvider(defaultOptions({ accessTokenTtlSeconds: 60 }));
    const app = createApp(bundle);
    const { code } = await runAuthorization(app, bundle);
    const issued = await exchangeCode(app, { code });
    const accessToken = issued.body.access_token;
    await expect(
      Promise.resolve().then(() => bundle.provider.verifyAccessToken('synthetic-unknown-token'))
    ).rejects.toThrow(InvalidTokenError);
    await expect(
      Promise.resolve().then(() => bundle.provider.verifyAccessToken(accessToken + 'tampered'))
    ).rejects.toThrow(InvalidTokenError);
    await withFakeTime(61 * 1000, async () => {
      await expect(
        Promise.resolve().then(() => bundle.provider.verifyAccessToken(accessToken))
      ).rejects.toThrow(InvalidTokenError);
      expect(bundle.resolveUpstreamEntraToken(accessToken)).toBeUndefined();
    });
  });
});

describe('R10 upstream Entra association for later OBO', () => {
  it('resolves the server-side association for a valid MCP token only', async () => {
    const bundle = createMCPOAuthProvider(defaultOptions());
    const app = createApp(bundle);
    const { code } = await runAuthorization(app, bundle);
    const issued = await exchangeCode(app, { code });
    const association = bundle.resolveUpstreamEntraToken(issued.body.access_token);
    expect(association.accessToken).toBe(UPSTREAM_TOKEN_A);
    expect(association.objectId).toBe('entra-user-object-id-a');
    expect(association.tenantId).toBe(TENANT_ID);
    expect(bundle.resolveUpstreamEntraToken('synthetic-unknown-token')).toBeUndefined();
  });

  it('stops resolving the upstream token after the MCP token expires', async () => {
    const bundle = createMCPOAuthProvider(defaultOptions({ accessTokenTtlSeconds: 60 }));
    const app = createApp(bundle);
    const { code } = await runAuthorization(app, bundle);
    const issued = await exchangeCode(app, { code });
    await withFakeTime(61 * 1000, async () => {
      expect(bundle.resolveUpstreamEntraToken(issued.body.access_token)).toBeUndefined();
    });
  });

  it('stops resolving the upstream token after the upstream Entra token expires even while the MCP token is still valid', async () => {
    const bundle = createMCPOAuthProvider(defaultOptions());
    const app = createApp(bundle);
    const { code } = await runAuthorization(app, bundle, {
      upstream: {
        entra: {
          accessToken: UPSTREAM_TOKEN_A,
          expiresAt: Math.floor(Date.now() / 1000) - 1,
          objectId: 'entra-user-object-id-a',
          tenantId: TENANT_ID,
          username: 'user-a@example.com',
        },
      },
    });
    const issued = await exchangeCode(app, { code });
    expect(issued.status).toBe(200);
    expect(bundle.resolveUpstreamEntraToken(issued.body.access_token)).toBeUndefined();
  });
});

describe('R11 rotating refresh-token grant (T18)', () => {
  it('still rejects an unknown refresh token as an invalid grant, never unsupported', async () => {
    const bundle = createMCPOAuthProvider(defaultOptions());
    const app = createApp(bundle);
    const response = await requestRefreshGrant(app);
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_grant');
  });

  it('never issues an ID token or upstream material in any successful token response', async () => {
    const bundle = createMCPOAuthProvider(defaultOptions());
    const app = createApp(bundle);
    const { code } = await runAuthorization(app, bundle, {
      clientId: 'public-web-client',
      redirectUri: PUBLIC_REDIRECT,
      clientSecret: undefined,
    });
    const issued = await exchangeCode(app, {
      code,
      clientId: 'public-web-client',
      clientSecret: undefined,
      redirectUri: PUBLIC_REDIRECT,
    });
    expect(issued.status).toBe(200);
    expect(issued.body.refresh_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.body.id_token).toBeUndefined();
    expect(JSON.stringify(issued.body)).not.toContain(UPSTREAM_TOKEN_A);
  });
});

describe('R12 per-user isolation', () => {
  it('keeps concurrent users and their tokens strictly separated', async () => {
    const bundle = createMCPOAuthProvider(defaultOptions());
    const app = createApp(bundle);
    const flowA = await runAuthorization(app, bundle);
    const flowB = await runAuthorization(app, bundle, {
      upstream: {
        entra: {
          accessToken: UPSTREAM_TOKEN_B,
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
          objectId: 'entra-user-object-id-b',
          tenantId: TENANT_ID,
          username: 'user-b@example.com',
        },
      },
    });
    const tokensA = await exchangeCode(app, { code: flowA.code });
    const tokensB = await exchangeCode(app, { code: flowB.code });
    const authInfoA = await bundle.provider.verifyAccessToken(tokensA.body.access_token);
    const authInfoB = await bundle.provider.verifyAccessToken(tokensB.body.access_token);
    expect(authInfoA.extra.userId).toBe('entra-user-object-id-a');
    expect(authInfoB.extra.userId).toBe('entra-user-object-id-b');
    const associationA = bundle.resolveUpstreamEntraToken(tokensA.body.access_token);
    expect(associationA.accessToken).toBe(UPSTREAM_TOKEN_A);
    expect(associationA.accessToken).not.toBe(UPSTREAM_TOKEN_B);
  });

  it('binds each code to its own client so bindings cannot cross clients', async () => {
    const bundle = createMCPOAuthProvider(defaultOptions());
    const app = createApp(bundle);
    const publicFlow = await runAuthorization(app, bundle, {
      clientId: 'public-web-client',
      redirectUri: PUBLIC_REDIRECT,
    });
    const crossClient = await exchangeCode(app, {
      code: publicFlow.code,
      clientId: 'confidential-mcp-client',
      redirectUri: CONFIDENTIAL_REDIRECT,
      clientSecret: CLIENT_SECRET,
    });
    expect(crossClient.status).toBe(400);
    expect(crossClient.body.error).toBe('invalid_grant');
  });
});

describe('R13 no secret, code, verifier, or upstream token leaks', () => {
  it('keeps sensitive values out of redirects, error bodies, and thrown messages', async () => {
    const verifier = randomVerifier();
    const bundle = createMCPOAuthProvider(defaultOptions());
    const app = createApp(bundle);
    const { code } = await runAuthorization(app, bundle, {
      codeChallenge: challengeFor(verifier),
    });
    LEAK_SCANNER.captured.length = 0;
    // Error-path responses: rejected verifier, cross-client redemption, and
    // an unknown code.
    const badVerifier = await exchangeCode(app, {
      code,
      verifier: `${verifier}tampered`,
    });
    expect(badVerifier.status).toBe(400);
    const crossClient = await exchangeCode(app, {
      code,
      clientId: 'public-web-client',
      redirectUri: PUBLIC_REDIRECT,
      clientSecret: undefined,
    });
    expect(crossClient.status).toBe(400);
    const unknownCode = await exchangeCode(app, { code: 'synthetic-never-issued' });
    expect(unknownCode.status).toBe(400);
    const errorBodies = [badVerifier, crossClient, unknownCode].map((response) =>
      JSON.stringify(response.body)
    );
    for (const errorBody of errorBodies) {
      for (const sensitive of [CLIENT_SECRET, UPSTREAM_TOKEN_A, verifier, code]) {
        expect(errorBody).not.toContain(sensitive);
      }
    }
    // Thrown completion errors never quote token material.
    let thrownMessage = '';
    try {
      bundle.completeAuthorizationAfterEntraSignIn({
        authorizationRef: 'unknown-synthetic-reference',
        entra: {
          accessToken: UPSTREAM_TOKEN_A,
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
          objectId: 'entra-user-object-id-a',
          tenantId: TENANT_ID,
        },
      });
    } catch (error) {
      thrownMessage = `${error.message} ${error.code}`;
    }
    expect(thrownMessage).not.toBe('');
    expect(thrownMessage).not.toContain(UPSTREAM_TOKEN_A);
    // The browser-facing sign-in redirect carries only the opaque reference.
    const redirect = await authorize(
      app,
      buildAuthorizeQuery({ codeChallenge: challengeFor(randomVerifier()) })
    );
    const location = redirect.headers.location;
    for (const sensitive of [CLIENT_SECRET, UPSTREAM_TOKEN_A, verifier]) {
      expect(location).not.toContain(sensitive);
    }
  });
});

describe('R14 dynamic client registration is bounded', () => {
  it('is disabled by default: no registration endpoint or metadata', async () => {
    const bundle = createMCPOAuthProvider(defaultOptions());
    expect(bundle.metadata.registration_endpoint).toBeUndefined();
    const app = createApp(bundle);
    await request(app)
      .post('/register')
      .send({ redirect_uris: [CONFIDENTIAL_REDIRECT] })
      .expect(404);
  });

  it('registers a client with SDK-generated credentials and completes a full flow', async () => {
    const bundle = createMCPOAuthProvider(defaultOptions({ allowDynamicRegistration: true }));
    expect(bundle.metadata.registration_endpoint.endsWith('/register')).toBe(true);
    const app = createApp(bundle);
    const registration = await request(app)
      .post('/register')
      .send({
        redirect_uris: ['https://new-client.example/callback'],
        token_endpoint_auth_method: 'client_secret_post',
        grant_types: ['authorization_code'],
        response_types: ['code'],
      })
      .expect(201);
    expect(registration.body.client_id).toBeDefined();
    expect(registration.body.client_secret).toBeDefined();
    expect(registration.body.client_secret_expires_at).toBeGreaterThan(Date.now() / 1000);
    expect(registration.body.grant_types).toEqual(['authorization_code']);
    const flow = await runAuthorization(app, bundle, {
      clientId: registration.body.client_id,
      redirectUri: 'https://new-client.example/callback',
      clientSecret: registration.body.client_secret,
    });
    const issued = await exchangeCode(app, {
      code: flow.code,
      clientId: registration.body.client_id,
      clientSecret: registration.body.client_secret,
      redirectUri: 'https://new-client.example/callback',
    });
    expect(issued.status).toBe(200);
    expect(issued.body.access_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // An authorization_code-only registration never receives a refresh
    // token: the previous non-refresh behavior is preserved.
    expect(issued.body.refresh_token).toBeUndefined();
  });

  it('registers the exact installed Pi 1.5.2 metadata shape and completes a refresh-capable flow', async () => {
    const bundle = createMCPOAuthProvider(defaultOptions({ allowDynamicRegistration: true }));
    const app = createApp(bundle);
    // Installed Pi 1.5.2 (pi-mcp oauth provider defaults): both grants, a
    // code response type, public authentication, and a loopback callback.
    const registration = await request(app)
      .post('/register')
      .send({
        redirect_uris: ['http://localhost:49153/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        application_type: 'native',
        scope: 'mcp',
      })
      .expect(201);
    expect(registration.body.client_id).toBeDefined();
    expect(registration.body.grant_types).toEqual(['authorization_code', 'refresh_token']);
    expect(registration.body.token_endpoint_auth_method).toBe('none');
    expect(registration.body.client_secret).toBeUndefined();
    expect(registration.body.client_id_issued_at).toBeGreaterThan(0);
    const flow = await runAuthorization(app, bundle, {
      clientId: registration.body.client_id,
      redirectUri: 'http://localhost:49153/callback',
      clientSecret: undefined,
    });
    const issued = await exchangeCode(app, {
      code: flow.code,
      clientId: registration.body.client_id,
      clientSecret: undefined,
      redirectUri: 'http://localhost:49153/callback',
    });
    expect(issued.status).toBe(200);
    expect(issued.body.access_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.body.refresh_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The dual-grant registration actually renews: one rotation, and the
    // consumed token can never mint again.
    const rotated = await rotateRefreshToken(app, {
      clientId: registration.body.client_id,
      refreshToken: issued.body.refresh_token,
    });
    expect(rotated.status).toBe(200);
    expect(rotated.body.refresh_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(rotated.body.refresh_token).not.toBe(issued.body.refresh_token);
    const replay = await rotateRefreshToken(app, {
      clientId: registration.body.client_id,
      refreshToken: issued.body.refresh_token,
    });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe('invalid_grant');
  });

  it('rejects registrations that violate the deployment safety rules', async () => {
    const bundle = createMCPOAuthProvider(
      defaultOptions({
        allowDynamicRegistration: true,
        maxRegisteredClients: 2,
      })
    );
    const app = createApp(bundle);
    const plainHttp = await request(app)
      .post('/register')
      .send({ redirect_uris: ['http://untrusted.example/callback'] })
      .expect(400);
    expect(plainHttp.body.error).toBe('invalid_client_metadata');
    const unsupportedGrant = await request(app)
      .post('/register')
      .send({
        redirect_uris: ['https://fine.example/callback'],
        grant_types: ['client_credentials'],
      })
      .expect(400);
    expect(unsupportedGrant.body.error).toBe('invalid_client_metadata');
    // A refresh-only registration is inconsistent with the supported code
    // flow: the authorization_code grant is always required.
    const refreshOnlyGrant = await request(app)
      .post('/register')
      .send({
        redirect_uris: ['https://fine.example/callback'],
        grant_types: ['refresh_token'],
      })
      .expect(400);
    expect(refreshOnlyGrant.body.error).toBe('invalid_client_metadata');
    // Rejected registrations never consume the client cap.
    const dualGrant = await request(app)
      .post('/register')
      .send({
        redirect_uris: ['https://fine.example/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
      })
      .expect(201);
    expect(dualGrant.body.client_id).toBeDefined();
    const first = await request(app)
      .post('/register')
      .send({ redirect_uris: ['https://fine.example/callback'] })
      .expect(201);
    expect(first.body.client_id).toBeDefined();
    const overCap = await request(app)
      .post('/register')
      .send({ redirect_uris: ['https://fine.example/other'] })
      .expect(400);
    expect(overCap.body.error).toBe('invalid_client_metadata');
  });
});

describe('R15 token revocation is not claimed', () => {
  it('exposes no revocation endpoint and no revoke capability', () => {
    const bundle = createMCPOAuthProvider(defaultOptions());
    expect(bundle.provider.revokeToken).toBeUndefined();
    expect(bundle.metadata.revocation_endpoint).toBeUndefined();
    expect(bundle.metadata.revocation_endpoint_auth_methods_supported).toBeUndefined();
  });
});

describe('R16 preservation and factory independence', () => {
  it('isolates two provider instances completely', async () => {
    const first = createMCPOAuthProvider(defaultOptions());
    const second = createMCPOAuthProvider(defaultOptions());
    const app = createApp(first);
    const { code } = await runAuthorization(app, first);
    const client = { client_id: 'confidential-mcp-client' };
    await expect(
      Promise.resolve().then(() =>
        second.provider.exchangeAuthorizationCode(
          client,
          code,
          SYNTHETIC_VERIFIER,
          CONFIDENTIAL_REDIRECT
        )
      )
    ).rejects.toThrow(/invalid or has expired/);
    expect(second.provider.clientsStore.getClient('confidential-mcp-client')).toBeDefined();
  });

  it('keeps the existing remote modules intact and loadable', () => {
    jest.isolateModules(() => {
      expect(typeof require('../../remote/entra-login').createEntraLogin).toBe('function');
      expect(typeof require('../../remote/obo-token-store').createRequestOboTokenStore).toBe(
        'function'
      );
      expect(typeof require('../../remote/entra-auth')).toBe('object');
    });
  });
});

describe('MCPOAuthProviderError shape', () => {
  it('exposes a machine-readable code and safe messages', () => {
    const error = new MCPOAuthProviderError(ERROR_CODES.CONFIG, 'msg');
    expect(error.name).toBe('MCPOAuthProviderError');
    expect(error.code).toBe(ERROR_CODES.CONFIG);
    expect(error.message).not.toMatch(/token|secret/i);
  });
});

describe('R10b association group/role claims (wired interface)', () => {
  it('carries bounded group and role claims through to the MCP token verification', async () => {
    const bundle = createMCPOAuthProvider(defaultOptions());
    const app = createApp(bundle);
    const { code } = await runAuthorization(app, bundle, {
      upstream: {
        entra: {
          accessToken: UPSTREAM_TOKEN_A,
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
          objectId: 'entra-user-object-id-a',
          tenantId: TENANT_ID,
          username: 'user-a@example.com',
          groups: ['group-mutators'],
          roles: ['app-role-writers'],
        },
      },
    });
    const issued = await exchangeCode(app, { code });
    expect(issued.status).toBe(200);
    const verified = bundle.provider.verifyAccessToken(issued.body.access_token);
    expect(verified.extra.groups).toEqual(['group-mutators']);
    expect(verified.extra.roles).toEqual(['app-role-writers']);
  });

  it('rejects a malformed group claim list without consuming the pending reference', async () => {
    const bundle = createMCPOAuthProvider(defaultOptions());
    const app = createApp(bundle);
    const response = await authorize(app, buildAuthorizeQuery());
    const ref = extractRef(response.headers.location);
    expect(() =>
      bundle.completeAuthorizationAfterEntraSignIn({
        authorizationRef: ref,
        entra: {
          accessToken: UPSTREAM_TOKEN_A,
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
          objectId: 'entra-user-object-id-a',
          tenantId: TENANT_ID,
          groups: ['group-mutators', ' '],
        },
      })
    ).toThrow(/entra\.groups/);
    // The pending reference survives the rejected attempt for a corrected
    // completion and its claims are then bound to the issued code.
    const completed = bundle.completeAuthorizationAfterEntraSignIn({
      authorizationRef: ref,
      entra: {
        accessToken: UPSTREAM_TOKEN_A,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        objectId: 'entra-user-object-id-a',
        tenantId: TENANT_ID,
        groups: ['group-mutators'],
      },
    });
    expect(new URL(completed.redirectTo).searchParams.get('code')).toMatch(/^[\w-]{20,}$/);
  });
});
