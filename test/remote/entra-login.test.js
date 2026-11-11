/**
 * Tests for the Entra upstream authorization-code sign-in foundation
 * (task T6, S1-S3, S5). Rule map, one focused block per rule:
 *
 * R1 configuration fails closed with no network
 * R2 concurrent users and cryptographically random single-use transaction data
 * R3 PKCE S256 verifier/challenge binding
 * R4 the authorization URL is built only from trusted configuration
 * R5 transactions are short-lived and single use (expiry, replay, unknown state)
 * R6 the code is redeemed with the configured confidential client (safe transport)
 * R7 the ID token is validated (signature, issuer, audience, expiry, tenant, identity)
 * R8 nonce bound per transaction; no user overlap across transactions
 * R9 provider-error callbacks fail closed and consume the transaction
 * R10 no token, secret, or client-authentication suggestion is exposed
 * R11 return context binds only to prevalidated transaction data
 * R12 preservation: the factory is reusable per instance with no shared state
 *
 * Fully offline: synthetic RSA keys, a local JWKS mock, and jest-muted https.
 * No real credentials, no network, no filesystem access, no HTTP listener.
 */
const crypto = require('crypto');
const https = require('https');
const jsonwebtoken = require('jsonwebtoken');
const querystring = require('querystring');

jest.mock('https');

const { createEntraLogin, EntraLoginError, ERROR_CODES } = require('../../remote/entra-login');

const TENANT_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const OTHER_TENANT_ID = '11112222-3333-4444-5555-666677778888';
const CLIENT_ID = 'confidential-mcp-client-id';
const CLIENT_SECRET = 'confidential-client-secret-value';
const REDIRECT_URI = 'https://mcp.internal.example/auth/callback';
const AUTHORITY_HOST = 'https://login.contoso.example';
const ISSUER = `${AUTHORITY_HOST}/${TENANT_ID}/v2.0`;
const SCOPE = 'https://graph.microsoft.com/Mail.Read';

function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return { privateKey, publicKeyPem: publicKey };
}

const KEY_A = generateKeyPair();
const KEY_B = generateKeyPair();

function createLocalJwks(keyByKid) {
  return {
    async getSigningKey(kid) {
      if (!keyByKid[kid]) {
        const error = new Error(`Unable to find a signing key that matches: '${kid}'`);
        error.name = 'JwksNotFoundError';
        throw error;
      }
      return { getPublicKey: () => keyByKid[kid] };
    },
  };
}

function mintIdToken(overrides = {}, signOptions = {}) {
  return jsonwebtoken.sign(
    {
      iss: ISSUER,
      aud: CLIENT_ID,
      sub: 'subject-alice',
      tid: TENANT_ID,
      oid: 'object-alice',
      preferred_username: 'alice@example.com',
      ...overrides,
      nonce: overrides.nonce,
    },
    KEY_A.privateKey,
    { algorithm: 'RS256', expiresIn: '5m', keyid: 'test-key-1', ...signOptions }
  );
}

function validConfig() {
  return {
    tenantId: TENANT_ID,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
    scopes: [SCOPE],
    authorityHost: AUTHORITY_HOST,
    jwksClient: createLocalJwks({ 'test-key-1': KEY_A.publicKeyPem }),
  };
}

let requestLog;

/**
 * Queues one mocked token-endpoint response. The default body is a realistic
 * code-redemption success carrying access, refresh, and ID tokens; tests use
 * it to prove no field of it survives into results or errors.
 */
function enqueueTokenResponse({ status = 200, body, idToken, emitErrorOnWrite } = {}) {
  https.request.mockImplementationOnce((url, options, callback) => {
    let errorHandler = null;
    const entry = {
      url: String(url),
      options,
      body: null,
      setTimeout: jest.fn(),
      on: jest.fn((event, handler) => {
        if (event === 'error') {
          errorHandler = handler;
        }
        return entry;
      }),
      write: jest.fn((chunk) => {
        entry.body = querystring.parse(chunk);
        if (emitErrorOnWrite) {
          queueMicrotask(() => errorHandler(new Error('connect ECONNRESET')));
        }
      }),
      end: jest.fn(() => {
        if (emitErrorOnWrite) {
          return;
        }
        const responseBody =
          body === undefined
            ? {
                token_type: 'Bearer',
                scope: SCOPE,
                expires_in: 3600,
                access_token: `upstream_access_token_${requestLog.length}`,
                refresh_token: `upstream_refresh_token_${requestLog.length}`,
                id_token: idToken,
              }
            : body;
        const res = {
          statusCode: status,
          on: (event, handler) => {
            if (event === 'data') {
              handler(Buffer.from(JSON.stringify(responseBody)));
            }
            if (event === 'end') {
              handler();
            }
          },
        };
        queueMicrotask(() => callback(res));
      }),
    };
    requestLog.push(entry);
    return entry;
  });
}

function queuedRequest() {
  return {
    ...requestLog[requestLog.length - 1],
    parsedUrl: new URL(requestLog[requestLog.length - 1].url),
    parsedBody: requestLog[requestLog.length - 1].body,
  };
}

function authorizationQuery(authorizationUrl) {
  return new URL(authorizationUrl).searchParams;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Sync classification (parameters, state lookup, expiry, replay, provider error) throws. */
function expectSyncError(trigger, pattern, code) {
  let caught = null;
  try {
    trigger();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(EntraLoginError);
  expect(caught.message).toMatch(pattern);
  if (code) {
    expect(caught.code).toBe(code);
  }
}

beforeEach(() => {
  jest.resetAllMocks();
  requestLog = [];
});

describe('createEntraLogin', () => {
  beforeEach(() => {
    jest.useRealTimers();
  });

  describe('R1: configuration fails closed before any network work', () => {
    const cases = [
      ['a non-object configuration', null, /tenantId/],
      ['a missing tenant', { ...validConfig(), tenantId: undefined }, /tenantId/],
      ["Entra 'common' as tenant", { ...validConfig(), tenantId: 'common' }, /tenantId/],
      ['a non-GUID tenant', { ...validConfig(), tenantId: 'not-a-guid' }, /tenantId/],
      ['an empty client id', { ...validConfig(), clientId: '' }, /clientId/],
      ['a blank client secret', { ...validConfig(), clientSecret: '   ' }, /clientSecret/],
      [
        'an http redirect URI',
        { ...validConfig(), redirectUri: 'http://mcp.internal.example/auth/callback' },
        /redirectUri/,
      ],
      [
        'a redirect URI with a query',
        { ...validConfig(), redirectUri: `${REDIRECT_URI}?x=1` },
        /redirectUri/,
      ],
      [
        'a redirect URI with userinfo',
        { ...validConfig(), redirectUri: 'https://user:pass@mcp.internal.example/auth/callback' },
        /redirectUri/,
      ],
      ['a hostless redirect URI', { ...validConfig(), redirectUri: 'https://' }, /redirectUri/],
      ['empty scopes', { ...validConfig(), scopes: [] }, /scopes/],
      ['a non-string scope', { ...validConfig(), scopes: [SCOPE, 7] }, /scopes/],
      [
        'an http authority host',
        { ...validConfig(), authorityHost: 'http://login.contoso.example' },
        /authority/,
      ],
      ['a zero transaction TTL', { ...validConfig(), transactionTtlMs: 0 }, /transactionTtlMs/],
      ['negative clock tolerance', { ...validConfig(), clockTolerance: -5 }, /clockTolerance/],
      [
        'an unexpected configuration key',
        { ...validConfig(), redirectUriPrefix: 'https://evil.example' },
        /unexpected/,
      ],
    ];

    test.each(cases)('rejects %s without any network call', (_name, config, pattern) => {
      expect(() => createEntraLogin(config)).toThrow(pattern);
      expect(https.request).not.toHaveBeenCalled();
    });

    // T9 (S4-S6): the local development HTTP mode needs the exact loopback
    // Entra callback `http://localhost:8443/login/callback`. The plaintext
    // allowance is an explicit opt-in, restricted to exact loopback
    // hostnames; Microsoft documents plain HTTP redirect URIs only for
    // loopback addresses, and the production default keeps requiring HTTPS.
    it('accepts an exact loopback HTTP redirect URI only with the explicit local HTTP opt-in', () => {
      const loopbackHttp = 'http://localhost:8443/login/callback';

      // Default (production): plaintext redirect stays refused.
      expect(() => createEntraLogin({ ...validConfig(), redirectUri: loopbackHttp })).toThrow(
        /redirectUri/
      );

      // Opt-in: the exact loopback HTTP callback is accepted...
      expect(() =>
        createEntraLogin({
          ...validConfig(),
          redirectUri: loopbackHttp,
          allowLoopbackHttpRedirect: true,
        })
      ).not.toThrow();
      // ...and the browser is sent back to it later without modification.
      const login = createEntraLogin({
        ...validConfig(),
        redirectUri: loopbackHttp,
        allowLoopbackHttpRedirect: true,
      });
      expect(login.beginLogin().authorizationUrl).toContain(
        `redirect_uri=${encodeURIComponent(loopbackHttp)}`
      );

      // The opt-in never reaches beyond exact loopback hostnames.
      expect(() =>
        createEntraLogin({
          ...validConfig(),
          redirectUri: 'http://mcp.intranet.example/login/callback',
          allowLoopbackHttpRedirect: true,
        })
      ).toThrow(/redirectUri/);

      // A mistyped opt-in value must fail closed, never silently disable
      // the default HTTPS requirement.
      for (const bad of [false, 'true', 1]) {
        expect(() =>
          createEntraLogin({ ...validConfig(), allowLoopbackHttpRedirect: bad })
        ).toThrow(/allowLoopbackHttpRedirect/);
      }

      // HTTPS redirects keep working with the option enabled.
      expect(() =>
        createEntraLogin({ ...validConfig(), allowLoopbackHttpRedirect: true })
      ).not.toThrow();
    });
  });

  describe('R2: concurrent users get independent cryptographically random single-use transactions', () => {
    it('issues distinct states and authorization URLs to overlapping users', () => {
      const login = createEntraLogin(validConfig());
      const begins = Promise.all([
        Promise.resolve().then(() => login.beginLogin()),
        Promise.resolve().then(() => login.beginLogin()),
        Promise.resolve().then(() => login.beginLogin()),
      ]);

      return begins.then((transactions) => {
        const states = new Set(transactions.map((transaction) => transaction.state));
        expect(states.size).toBe(transactions.length);
        expect(new Set(transactions.map((t) => t.authorizationUrl)).size).toBe(3);
        for (const transaction of transactions) {
          expect(transaction.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
          expect(transaction.authorizationUrl).toContain(
            `state=${encodeURIComponent(transaction.state)}`
          );
        }
      });
    });

    it('draws non-repeating state values from a cryptographically strong source', () => {
      const login = createEntraLogin(validConfig());
      const configs = [validConfig(), { ...validConfig(), maxTransactions: 40 }];
      const second = createEntraLogin(configs[1]);
      const states = [];
      for (let index = 0; index < 40; index += 1) {
        states.push(login.beginLogin().state);
        states.push(second.beginLogin().state);
      }
      expect(new Set(states).size).toBe(80);
      // 256-bit entropy leaves ~2^-160 collision probability; any repeat is a broken source.
      expect(states.some((state) => states.indexOf(state) !== states.lastIndexOf(state))).toBe(
        false
      );
    });

    it('bounds concurrent transactions instead of growing without limit', () => {
      const login = createEntraLogin({ ...validConfig(), maxTransactions: 2 });
      expect(() => login.beginLogin()).not.toThrow();
      expect(() => login.beginLogin()).not.toThrow();
      expect(() => login.beginLogin()).toThrow(/too many/i);
    });
  });

  describe('R3: PKCE S256 verifier/challenge binding', () => {
    it('redeems the code with the verifier whose S256 digest equals the advertised challenge', async () => {
      const login = createEntraLogin(validConfig());
      const begin = login.beginLogin();
      const challenge = authorizationQuery(begin.authorizationUrl).get('code_challenge');
      const method = authorizationQuery(begin.authorizationUrl).get('code_challenge_method');

      expect(method).toBe('S256');
      expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(challenge).not.toBe('plain');

      enqueueTokenResponse({
        idToken: mintIdToken({ nonce: authorizationQuery(begin.authorizationUrl).get('nonce') }),
      });
      await login.completeLogin({ state: begin.state, code: 'upstream-code-value' });

      const redemption = queuedRequest();
      const verifier = redemption.parsedBody.code_verifier;
      expect(typeof verifier).toBe('string');
      expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(verifier).not.toBe(challenge);
      expect(crypto.createHash('sha256').update(verifier).digest('base64url')).toBe(challenge);
    });
  });

  describe('R4: the authorization URL is built only from trusted configuration', () => {
    it('builds the tenant authorize endpoint from configured trusted values only', () => {
      const login = createEntraLogin(validConfig());
      const begin = login.beginLogin();
      const url = new URL(begin.authorizationUrl);

      expect(
        begin.authorizationUrl.startsWith(`${AUTHORITY_HOST}/${TENANT_ID}/oauth2/v2.0/authorize`)
      ).toBe(true);
      expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
      expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('response_mode')).toBe('query');
      expect(url.searchParams.getAll('nonce')).toHaveLength(1);
      expect(url.searchParams.get('nonce').length).toBeGreaterThanOrEqual(30);
      expect(url.searchParams.getAll('state')).toHaveLength(1);
      expect(url.searchParams.get('state')).toBe(begin.state);
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('scope').split(' ')).toEqual(
        expect.arrayContaining([SCOPE, 'openid', 'profile'])
      );
    });

    it('rejects any caller attempt to influence the redirect destination', () => {
      const login = createEntraLogin(validConfig());
      expect(() => login.beginLogin({ redirectUri: 'https://evil.example/callback' })).toThrow(
        /accepts no options/
      );
      expect(() => login.beginLogin({ tenant: OTHER_TENANT_ID })).toThrow(/accepts no options/);

      const begin = login.beginLogin();
      expect(new URL(begin.authorizationUrl).searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
      expect(new URL(begin.authorizationUrl).origin).toBe(AUTHORITY_HOST);
    });
  });

  describe('R5: transactions are short-lived and single use', () => {
    it('rejects completion for an unknown state', () => {
      const login = createEntraLogin(validConfig());
      expectSyncError(
        () => login.completeLogin({ state: 'no-such-transaction', code: 'upstream-code-value' }),
        /state/i,
        ERROR_CODES.UNKNOWN_STATE
      );
      expect(https.request).not.toHaveBeenCalled();
    });

    it('rejects completion after the transaction expires', async () => {
      const login = createEntraLogin({ ...validConfig(), transactionTtlMs: 25 });
      const begin = login.beginLogin();
      await sleep(60);
      expectSyncError(
        () => login.completeLogin({ state: begin.state, code: 'upstream-code-value' }),
        /expired/i,
        ERROR_CODES.EXPIRED
      );
      expect(https.request).not.toHaveBeenCalled();
    });

    it('rejects replaying a state whose transaction was already completed', async () => {
      const login = createEntraLogin(validConfig());
      const begin = login.beginLogin();
      const nonce = authorizationQuery(begin.authorizationUrl).get('nonce');
      enqueueTokenResponse({ idToken: mintIdToken({ nonce }) });
      await expect(
        login.completeLogin({ state: begin.state, code: 'upstream-code-value' })
      ).resolves.toMatchObject({ mcpOauthFlowWired: false });

      enqueueTokenResponse({ idToken: mintIdToken({ nonce }) });
      expectSyncError(
        () => login.completeLogin({ state: begin.state, code: 'upstream-code-value' }),
        /state/i,
        ERROR_CODES.UNKNOWN_STATE
      );
      // Only the first completion reached the token endpoint.
      expect(https.request).toHaveBeenCalledTimes(1);
    });
  });

  describe('R6: the code is redeemed with the configured confidential client over a safe transport', () => {
    it('posts the authorization-code grant to the tenant token endpoint', async () => {
      const login = createEntraLogin(validConfig());
      const begin = login.beginLogin();
      const params = authorizationQuery(begin.authorizationUrl);
      enqueueTokenResponse({ idToken: mintIdToken({ nonce: params.get('nonce') }) });
      await login.completeLogin({ state: begin.state, code: 'upstream-code-value' });

      const redemption = queuedRequest();
      expect(`${redemption.parsedUrl.origin}${redemption.parsedUrl.pathname}`).toBe(
        `${AUTHORITY_HOST}/${TENANT_ID}/oauth2/v2.0/token`
      );
      expect(redemption.parsedUrl.protocol).toBe('https:');
      expect(redemption.options.method).toBe('POST');
      expect(redemption.options.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
      expect(redemption.parsedBody).toMatchObject({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code: 'upstream-code-value',
        redirect_uri: REDIRECT_URI,
      });
      expect(typeof redemption.parsedBody.code_verifier).toBe('string');
      expect(redemption.setTimeout).toHaveBeenCalledWith(expect.any(Number), expect.any(Function));
    });

    it('fails closed with secret-free context when the token endpoint is unreachable', async () => {
      const login = createEntraLogin(validConfig());
      const begin = login.beginLogin();
      enqueueTokenResponse({ emitErrorOnWrite: true });

      const failure = await login
        .completeLogin({ state: begin.state, code: 'upstream-code-value' })
        .then(() => null)
        .catch((error) => error);

      expect(failure.code).toBe(ERROR_CODES.REDEEM_FAILED);
      expect(failure.message).toMatch(/redemption/i);
      expect(failure.message.includes(CLIENT_SECRET)).toBe(false);
      expect(failure.message.includes('upstream-code-value')).toBe(false);
      expect(https.request).toHaveBeenCalledTimes(1);

      // Consumed single-use state: the retry is an unknown state, not a
      // second secret POST.
      expectSyncError(
        () => login.completeLogin({ state: begin.state, code: 'upstream-code-value' }),
        /state/i,
        ERROR_CODES.UNKNOWN_STATE
      );
      expect(https.request).toHaveBeenCalledTimes(1);
    });

    it('surfaces a typed provider error without echoing secrets', async () => {
      const login = createEntraLogin(validConfig());
      const begin = login.beginLogin();
      enqueueTokenResponse({
        status: 400,
        body: { error: 'invalid_grant', error_description: 'PKCE check failed' },
      });

      const failure = await login
        .completeLogin({ state: begin.state, code: 'upstream-code-value' })
        .then(() => null)
        .catch((error) => error);

      expect(failure.code).toBe('invalid_grant');
      expect(failure.status).toBe(400);
      expect(failure.isPermanentEntraAuthFailure).toBe(true);
      expect(failure.message).toMatch(/invalid_grant/i);
      expect(failure.message.includes(CLIENT_SECRET)).toBe(false);
      expect(failure.message.includes('upstream-code-value')).toBe(false);
    });
  });

  describe('R7: the returned ID token is validated with a maintained library', () => {
    it('verifies a correctly minted ID token and projects the delegated user identity', async () => {
      const login = createEntraLogin(validConfig());
      const begin = login.beginLogin();
      const nonce = authorizationQuery(begin.authorizationUrl).get('nonce');
      enqueueTokenResponse({
        idToken: mintIdToken({
          nonce,
          name: 'Alice Example',
          auth_time: 1700000000,
          groups: ['group-mutators'],
          roles: ['role-mutators'],
        }),
      });

      const completed = await login.completeLogin({
        state: begin.state,
        code: 'upstream-code-value',
      });

      expect(completed.identity).toMatchObject({
        subject: 'subject-alice',
        objectId: 'object-alice',
        tenantId: TENANT_ID,
        username: 'alice@example.com',
        name: 'Alice Example',
      });
      // Pinned probe (no meaningful RED; authored together with the groups/
      // roles projection): group and role claims stay compatible with the
      // separate mutation-authorization predicate, but never include tokens.
      expect(completed.identity.groups).toEqual(['group-mutators']);
      expect(completed.identity.roles).toEqual(['role-mutators']);
    });

    it('rejects an ID token signed outside the tenant JWKS', async () => {
      const login = createEntraLogin(validConfig());
      const begin = login.beginLogin();
      const nonce = authorizationQuery(begin.authorizationUrl).get('nonce');
      enqueueTokenResponse({
        idToken: jsonwebtoken.sign(
          { iss: ISSUER, aud: CLIENT_ID, sub: 'forged', tid: TENANT_ID, oid: 'x', nonce },
          KEY_B.privateKey,
          { algorithm: 'RS256', expiresIn: '5m', keyid: 'test-key-1' }
        ),
      });

      await expect(
        login.completeLogin({ state: begin.state, code: 'upstream-code-value' })
      ).rejects.toMatchObject({ code: ERROR_CODES.ID_TOKEN_UNTRUSTED });
    });

    it('rejects an ID token with another issuer, audience, tenant, or no delegated identity', async () => {
      const mintAndComplete = async (overrides) => {
        const login = createEntraLogin(validConfig());
        const begin = login.beginLogin();
        const nonce = authorizationQuery(begin.authorizationUrl).get('nonce');
        enqueueTokenResponse({ idToken: mintIdToken({ nonce, ...overrides }) });
        return login.completeLogin({ state: begin.state, code: 'upstream-code-value' });
      };

      await expect(
        mintAndComplete({ iss: `https://login.contoso.example/${OTHER_TENANT_ID}/v2.0` })
      ).rejects.toMatchObject({ code: ERROR_CODES.ID_TOKEN_INVALID });
      await expect(mintAndComplete({ aud: 'api://other-service' })).rejects.toMatchObject({
        code: ERROR_CODES.ID_TOKEN_INVALID,
      });
      await expect(mintAndComplete({ tid: OTHER_TENANT_ID })).rejects.toMatchObject({
        code: ERROR_CODES.ID_TOKEN_INVALID,
      });
      await expect(mintAndComplete({ oid: undefined })).rejects.toMatchObject({
        code: ERROR_CODES.ID_TOKEN_INVALID,
        message: expect.stringMatching(/delegated/i),
      });
    });

    it('rejects an expired or expiry-less ID token', async () => {
      const completeWithToken = async (idToken) => {
        const login = createEntraLogin(validConfig());
        const begin = login.beginLogin();
        enqueueTokenResponse({ idToken });
        return login.completeLogin({ state: begin.state, code: 'upstream-code-value' });
      };

      await expect(completeWithToken(mintIdToken({}, { expiresIn: -300 }))).rejects.toMatchObject({
        code: ERROR_CODES.ID_TOKEN_EXPIRED,
      });

      const header = Buffer.from(
        JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'test-key-1' })
      ).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          iss: ISSUER,
          aud: CLIENT_ID,
          sub: 'subject-no-exp',
          tid: TENANT_ID,
          oid: 'object-no-exp',
          preferred_username: 'alice@example.com',
        })
      ).toString('base64url');
      const signer = crypto.createSign('RSA-SHA256');
      signer.update(`${header}.${payload}`);
      const noExpiry = `${header}.${payload}.${signer.sign(KEY_A.privateKey, 'base64url')}`;
      expect(jsonwebtoken.decode(noExpiry).exp).toBeUndefined();

      await expect(completeWithToken(noExpiry)).rejects.toMatchObject({
        code: ERROR_CODES.ID_TOKEN_INVALID,
      });
    });
  });

  describe('T13: fail-safe value-free claim-name diagnostic on the delegated-identity-missing path', () => {
    /**
     * Captures stderr logging without mutating shared mocks: the spy stays
     * silent in tests, is restored at the end of each test, and never lets
     * diagnostic output leak into the Jest report.
     */
    function spyConsoleError() {
      return jest.spyOn(console, 'error').mockImplementation(() => {});
    }

    it('never logs on the valid delegated-identity path', async () => {
      const spy = spyConsoleError();
      try {
        const login = createEntraLogin(validConfig());
        const begin = login.beginLogin();
        const nonce = authorizationQuery(begin.authorizationUrl).get('nonce');
        enqueueTokenResponse({ idToken: mintIdToken({ nonce }) });

        await expect(
          login.completeLogin({ state: begin.state, code: 'upstream-code-value' })
        ).resolves.toMatchObject({ mcpOauthFlowWired: false });
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it('on the missing-oid path logs claim names only, never values, and keeps the rejection', async () => {
      const spy = spyConsoleError();
      try {
        const login = createEntraLogin(validConfig());
        const begin = login.beginLogin();
        const nonce = authorizationQuery(begin.authorizationUrl).get('nonce');
        enqueueTokenResponse({
          // A real-tenant-shaped v2 token without `oid`: distinctive claim
          // values so the assertion can prove only names ever reach the log.
          idToken: mintIdToken({
            oid: undefined,
            nonce,
            family_name: 'secret-family-name-value',
          }),
        });

        await expect(
          login.completeLogin({ state: begin.state, code: 'upstream-code-value' })
        ).rejects.toMatchObject({
          code: ERROR_CODES.ID_TOKEN_INVALID,
          message: expect.stringMatching(/delegated/i),
        });

        expect(spy).toHaveBeenCalledTimes(1);
        const diagnostic = spy.mock.calls[0].join(' ');
        expect(typeof diagnostic).toBe('string');
        expect(diagnostic).toContain('sub');
        expect(diagnostic).toContain('nonce');
        expect(diagnostic).toContain('tid');
        // Value-free and token-free: neither a claim value nor the minted
        // token text appears in the diagnostic line.
        expect(diagnostic).not.toContain('subject-alice');
        expect(diagnostic).not.toContain('alice@example.com');
        expect(diagnostic).not.toContain('secret-family-name-value');
        expect(diagnostic).not.toContain(nonce);
        expect(diagnostic).not.toContain(CLIENT_SECRET);
        expect(diagnostic).not.toContain('upstream-code-value');
      } finally {
        spy.mockRestore();
      }
    });

    it('classifies a v2 token by writing token-version=v2 and never the ver value', async () => {
      const spy = spyConsoleError();
      try {
        const login = createEntraLogin(validConfig());
        const begin = login.beginLogin();
        const nonce = authorizationQuery(begin.authorizationUrl).get('nonce');
        enqueueTokenResponse({
          idToken: mintIdToken({ oid: undefined, nonce, ver: '2.0' }),
        });

        await expect(
          login.completeLogin({ state: begin.state, code: 'upstream-code-value' })
        ).rejects.toMatchObject({ code: ERROR_CODES.ID_TOKEN_INVALID });

        expect(spy).toHaveBeenCalledTimes(1);
        const diagnostic = spy.mock.calls[0].join(' ');
        expect(diagnostic).toContain('token-version=v2');
        // The classification must stay value-free: the literal ver payload
        // never appears anywhere in the log line.
        expect(diagnostic.toLowerCase()).not.toContain('"ver"');
      } finally {
        spy.mockRestore();
      }
    });

    it('classifies a v1 token by writing token-version=v1 and never the ver value', async () => {
      const spy = spyConsoleError();
      try {
        const login = createEntraLogin(validConfig());
        const begin = login.beginLogin();
        const nonce = authorizationQuery(begin.authorizationUrl).get('nonce');
        enqueueTokenResponse({
          idToken: mintIdToken({ oid: undefined, nonce, ver: '1.0' }),
        });

        await expect(
          login.completeLogin({ state: begin.state, code: 'upstream-code-value' })
        ).rejects.toMatchObject({ code: ERROR_CODES.ID_TOKEN_INVALID });

        expect(spy).toHaveBeenCalledTimes(1);
        const diagnostic = spy.mock.calls[0].join(' ');
        expect(diagnostic).toContain('token-version=v1');
        expect(diagnostic).not.toContain('1.0');
      } finally {
        spy.mockRestore();
      }
    });

    it('classifies an unrecognized or absent ver as token-version=uncounted without its value', async () => {
      const spy = spyConsoleError();
      try {
        const login = createEntraLogin(validConfig());
        const begin = login.beginLogin();
        let nonce = authorizationQuery(begin.authorizationUrl).get('nonce');
        // An unrecognized ver value: its raw string must never reach the log.
        const unrecognizedVer = '9.9-distinctive-ver-value';
        enqueueTokenResponse({
          idToken: mintIdToken({ oid: undefined, nonce, ver: unrecognizedVer }),
        });
        await expect(
          login.completeLogin({ state: begin.state, code: 'upstream-code-value' })
        ).rejects.toMatchObject({ code: ERROR_CODES.ID_TOKEN_INVALID });
        expect(spy).toHaveBeenCalledTimes(1);
        const diagnostic = spy.mock.calls[0].join(' ');
        expect(diagnostic).toContain('token-version=uncounted');
        expect(diagnostic).not.toContain(unrecognizedVer);

        // Absent ver: the same uncounted classification.
        spy.mockClear();
        const second = createEntraLogin(validConfig());
        const secondBegin = second.beginLogin();
        nonce = authorizationQuery(secondBegin.authorizationUrl).get('nonce');
        enqueueTokenResponse({ idToken: mintIdToken({ oid: undefined, nonce }) });
        await expect(
          second.completeLogin({ state: secondBegin.state, code: 'upstream-code-value' })
        ).rejects.toMatchObject({ code: ERROR_CODES.ID_TOKEN_INVALID });
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0].join(' ')).toContain('token-version=uncounted');
      } finally {
        spy.mockRestore();
      }
    });

    it('bounds the diagnostic when the verified token carries many claims', async () => {
      const spy = spyConsoleError();
      try {
        const login = createEntraLogin(validConfig());
        const begin = login.beginLogin();
        const nonce = authorizationQuery(begin.authorizationUrl).get('nonce');
        const extras = {};
        for (let index = 1; index <= 50; index += 1) {
          const suffix = String(index).padStart(3, '0');
          extras[`xclaim${suffix}`] = `xvalue${suffix}`;
        }
        enqueueTokenResponse({ idToken: mintIdToken({ oid: undefined, nonce, ...extras }) });

        await expect(
          login.completeLogin({ state: begin.state, code: 'upstream-code-value' })
        ).rejects.toMatchObject({ code: ERROR_CODES.ID_TOKEN_INVALID });

        expect(spy).toHaveBeenCalledTimes(1);
        const diagnostic = spy.mock.calls[0].join(' ');
        // Names only, truncated with an explicit marker, and never a value.
        expect(diagnostic).toMatch(/xclaim0\d\d/);
        expect(diagnostic).not.toContain('xvalue');
        expect(diagnostic).toMatch(/\(\+\d+ more\)/);
        expect((diagnostic.match(/xclaim\d+/g) || []).length).toBeLessThanOrEqual(40);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('R8: the nonce binds each transaction; overlapping users never resolve into each other', () => {
    it('rejects an ID token minted for another nonce and never mixes identities', async () => {
      const login = createEntraLogin(validConfig());
      const beginOne = login.beginLogin();
      const beginTwo = login.beginLogin();
      const nonceOne = authorizationQuery(beginOne.authorizationUrl).get('nonce');
      const nonceTwo = authorizationQuery(beginTwo.authorizationUrl).get('nonce');
      expect(nonceOne).not.toBe(nonceTwo);

      // Completing transaction two with a token minted for transaction one's user fails.
      enqueueTokenResponse({ idToken: mintIdToken({ nonce: nonceOne }) });
      await expect(
        login.completeLogin({ state: beginTwo.state, code: 'upstream-code-value' })
      ).rejects.toMatchObject({ code: ERROR_CODES.NONCE_MISMATCH });
      expect(https.request).toHaveBeenCalledTimes(1);

      // The now-consumed transaction cannot be re-completed: no redemption,
      // no queued response, and the state is already gone.
      expectSyncError(
        () => login.completeLogin({ state: beginTwo.state, code: 'upstream-code-value' }),
        /state/i,
        ERROR_CODES.UNKNOWN_STATE
      );

      // User one completes with their own token and sees only their identity.
      enqueueTokenResponse({ idToken: mintIdToken({ nonce: nonceOne }) });
      const completedOne = await login.completeLogin({
        state: beginOne.state,
        code: 'upstream-code-value',
      });
      expect(completedOne.identity).toMatchObject({
        objectId: 'object-alice',
        tenantId: TENANT_ID,
      });
    });

    it('keeps concurrent completions isolated per instance', async () => {
      const loginA = createEntraLogin(validConfig());
      const loginB = createEntraLogin(validConfig());
      const begin = loginA.beginLogin();
      const params = authorizationQuery(begin.authorizationUrl);
      enqueueTokenResponse({ idToken: mintIdToken({ nonce: params.get('nonce') }) });
      expectSyncError(
        () => loginB.completeLogin({ state: begin.state, code: 'upstream-code-value' }),
        /state/i,
        ERROR_CODES.UNKNOWN_STATE
      );
      expect(https.request).not.toHaveBeenCalled();

      await expect(
        loginA.completeLogin({ state: begin.state, code: 'upstream-code-value' })
      ).resolves.toMatchObject({ mcpOauthFlowWired: false });
      expect(https.request).toHaveBeenCalledTimes(1);
    });
  });

  describe('R9: provider-error callbacks fail closed and consume the transaction', () => {
    it('rejects an access_denied callback without echoing provider text', () => {
      const login = createEntraLogin(validConfig());
      const begin = login.beginLogin();

      expectSyncError(
        () => login.completeLogin({ state: begin.state, error: 'access_denied' }),
        /access_denied/,
        ERROR_CODES.ACCESS_DENIED
      );
      expect(https.request).not.toHaveBeenCalled();

      // The consumed transaction cannot be replayed with a code afterwards.
      expectSyncError(
        () => login.completeLogin({ state: begin.state, code: 'upstream-code-value' }),
        /state/i,
        ERROR_CODES.UNKNOWN_STATE
      );
      expect(https.request).not.toHaveBeenCalled();
    });
  });

  describe('R10: no token, secret, or client-authentication suggestion is exposed', () => {
    it('returns only the identity projection and no MCP authentication claim', async () => {
      const login = createEntraLogin(validConfig());
      const begin = login.beginLogin();
      const params = authorizationQuery(begin.authorizationUrl);
      enqueueTokenResponse({ idToken: mintIdToken({ nonce: params.get('nonce') }) });

      const completed = await login.completeLogin({
        state: begin.state,
        code: 'upstream-code-value',
      });

      expect(completed.mcpOauthFlowWired).toBe(false);

      const allowedIdentityKeys = new Set([
        'subject',
        'objectId',
        'tenantId',
        'username',
        'name',
        'groups',
        'roles',
        'issuedAt',
        'authTime',
      ]);
      for (const key of Object.keys(completed.identity)) {
        expect(allowedIdentityKeys.has(key)).toBe(true);
      }

      const serialized = JSON.stringify(completed);
      expect(serialized.includes('upstream_access_token')).toBe(false);
      expect(serialized.includes('upstream_refresh_token')).toBe(false);
      expect(serialized.includes(CLIENT_SECRET)).toBe(false);
      expect(serialized.includes('upstream-code-value')).toBe(false);
      expect(serialized.toLowerCase()).not.toContain('access_token');
      expect(serialized.toLowerCase()).not.toContain('refresh_token');
      expect(serialized.toLowerCase()).not.toContain('id_token');
      expect(serialized.toLowerCase()).not.toContain('client_secret');
    });
  });

  describe('R11: return context binds only to prevalidated transaction data', () => {
    it('rejects caller-supplied identity, nonce, redirect, or tenant overrides', async () => {
      const login = createEntraLogin(validConfig());

      expect(() =>
        login.completeLogin({
          state: 'state-value',
          code: 'upstream-code-value',
          nonce: 'forged-nonce',
        })
      ).toThrow(/unexpected/);
      expect(() =>
        login.completeLogin({
          state: 'state-value',
          code: 'upstream-code-value',
          redirectUri: 'https://evil.example/callback',
        })
      ).toThrow(/unexpected/);
      expect(() =>
        login.completeLogin({
          state: 'state-value',
          code: 'upstream-code-value',
          tenantId: OTHER_TENANT_ID,
        })
      ).toThrow(/unexpected/);
      expect(() =>
        login.completeLogin({
          state: 'state-value',
          code: 'upstream-code-value',
          username: 'attacker@example.com',
        })
      ).toThrow(/unexpected/);
      expect(https.request).not.toHaveBeenCalled();
    });

    it('rejects malformed state and code inputs without consuming anything', () => {
      const login = createEntraLogin(validConfig());
      const begin = login.beginLogin();

      expectSyncError(
        () => login.completeLogin({ state: 42, code: 'upstream-code-value' }),
        /state/i
      );
      expectSyncError(
        () => login.completeLogin({ state: '', code: 'upstream-code-value' }),
        /state/i
      );
      expectSyncError(() => login.completeLogin({ state: begin.state, code: '' }), /code/i);
      expectSyncError(
        () => login.completeLogin({ state: begin.state, code: 'has space' }),
        /code/i
      );

      const params = authorizationQuery(begin.authorizationUrl);
      enqueueTokenResponse({ idToken: mintIdToken({ nonce: params.get('nonce') }) });
      return expect(
        login.completeLogin({ state: begin.state, code: 'upstream-code-value' })
      ).resolves.toMatchObject({ mcpOauthFlowWired: false });
    });
  });

  describe('R13: multi-audience ID tokens require a matching azp claim', () => {
    // The token must carry the transaction's own nonce, so the transaction is
    // begun first and the token minted from its authorization URL.
    const completeWithToken = async (overrides) => {
      const login = createEntraLogin(validConfig());
      const begin = login.beginLogin();
      const nonce = authorizationQuery(begin.authorizationUrl).get('nonce');
      enqueueTokenResponse({ idToken: mintIdToken({ nonce, ...overrides }) });
      return login.completeLogin({ state: begin.state, code: 'upstream-code-value' });
    };

    it('accepts a multi-audience token whose azp exactly equals the client id', async () => {
      await expect(
        completeWithToken({ aud: [CLIENT_ID, 'api://other-relying-party'], azp: CLIENT_ID })
      ).resolves.toMatchObject({ mcpOauthFlowWired: false });
    });

    it('accepts a single-audience token whose azp exactly equals the client id', async () => {
      await expect(completeWithToken({ azp: CLIENT_ID })).resolves.toMatchObject({
        mcpOauthFlowWired: false,
      });
    });

    it('rejects a multi-audience token without any azp claim', async () => {
      await expect(
        completeWithToken({ aud: [CLIENT_ID, 'api://other-relying-party'] })
      ).rejects.toMatchObject({ code: ERROR_CODES.ID_TOKEN_INVALID });
    });

    it('rejects a present azp that differs from the client id', async () => {
      await expect(completeWithToken({ azp: 'api://other-relying-party' })).rejects.toMatchObject({
        code: ERROR_CODES.ID_TOKEN_INVALID,
      });
      await expect(
        completeWithToken({ aud: [CLIENT_ID, 'api://third-party'], azp: 'api://third-party' })
      ).rejects.toMatchObject({ code: ERROR_CODES.ID_TOKEN_INVALID });
    });

    it('rejects a non-string azp regardless of audience shape', async () => {
      const login = createEntraLogin(validConfig());
      const begin = login.beginLogin();
      const nonce = authorizationQuery(begin.authorizationUrl).get('nonce');
      const header = Buffer.from(
        JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'test-key-1' })
      ).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          iss: ISSUER,
          aud: [CLIENT_ID, 'api://other-relying-party'],
          sub: 'subject-azp',
          tid: TENANT_ID,
          oid: 'object-azp',
          preferred_username: 'alice@example.com',
          nonce,
          azp: [CLIENT_ID],
        })
      ).toString('base64url');
      const signer = crypto.createSign('RSA-SHA256');
      signer.update(`${header}.${payload}`);
      const nonStringAzp = `${header}.${payload}.${signer.sign(KEY_A.privateKey, 'base64url')}`;

      enqueueTokenResponse({ idToken: nonStringAzp });
      await expect(
        login.completeLogin({ state: begin.state, code: 'upstream-code-value' })
      ).rejects.toMatchObject({ code: ERROR_CODES.ID_TOKEN_INVALID });
    });
  });

  describe('R14: the token endpoint response is size-bounded and timeouts fail safely', () => {
    function enqueueOversizedResponse() {
      https.request.mockImplementationOnce((url, options, callback) => {
        const entry = {
          url: String(url),
          options,
          body: null,
          setTimeout: jest.fn(),
          on: jest.fn(),
          write: jest.fn(),
          end: jest.fn(),
        };
        requestLog.push(entry);
        entry.write.mockImplementation((chunk) => {
          entry.body = querystring.parse(chunk);
        });
        entry.end.mockImplementation(() => {
          const oversized = 'x'.repeat(200 * 1024);
          const res = {
            statusCode: 200,
            on: (event, handler) => {
              if (event === 'data') {
                // Deliver in two chunks; the limit trips between them.
                handler(Buffer.from(oversized));
                handler(Buffer.from(oversized));
              }
            },
          };
          queueMicrotask(() => callback(res));
        });
        return entry;
      });
    }

    function enqueueTimeout() {
      https.request.mockImplementationOnce((_url, _options, _callback) => {
        let errorHandler = null;
        const entry = {
          url: String(_url),
          options: _options,
          body: null,
          setTimeout: jest.fn(),
          on: jest.fn((event, handler) => {
            if (event === 'error') {
              errorHandler = handler;
            }
            return entry;
          }),
          write: jest.fn((chunk) => {
            entry.body = querystring.parse(chunk);
          }),
          // A pending response that never ends: the timeout fires first.
          end: jest.fn(() => {
            entry.setTimeout.mock.calls[0][1]();
          }),
          destroy: jest.fn((error) => {
            queueMicrotask(() => {
              if (errorHandler) {
                errorHandler(error);
              }
            });
          }),
        };
        requestLog.push(entry);
        return entry;
      });
    }

    it('rejects an oversized token response before parsing it; the transaction stays consumed', async () => {
      const login = createEntraLogin(validConfig());
      const begin = login.beginLogin();
      enqueueOversizedResponse();

      const failure = await login
        .completeLogin({ state: begin.state, code: 'upstream-code-value' })
        .then(() => null)
        .catch((error) => error);

      expect(failure.code).toBe(ERROR_CODES.REDEEM_FAILED);
      expect(failure.message).toMatch(/maximum|size|large/i);
      expect(failure.message.includes(CLIENT_SECRET)).toBe(false);
      expect(failure.message.includes('upstream-code-value')).toBe(false);
      expect(failure.message).not.toMatch(/xxxxxxxxxxxxxxxx/);

      // Consumed single-use transaction: no second oversized redemption.
      expectSyncError(
        () => login.completeLogin({ state: begin.state, code: 'upstream-code-value' }),
        /state/i,
        ERROR_CODES.UNKNOWN_STATE
      );
      expect(https.request).toHaveBeenCalledTimes(1);
    });

    it('fails a timed out redemption with redacted context and a consumed transaction', async () => {
      const login = createEntraLogin(validConfig());
      const begin = login.beginLogin();
      enqueueTimeout();

      const failure = await login
        .completeLogin({ state: begin.state, code: 'upstream-code-value' })
        .then(() => null)
        .catch((error) => error);

      expect(failure.code).toBe(ERROR_CODES.REDEEM_FAILED);
      expect(failure.message).toMatch(/timed out/i);
      expect(failure.message.includes(CLIENT_SECRET)).toBe(false);
      expect(failure.message.includes('upstream-code-value')).toBe(false);
      const verifier = queuedRequest().parsedBody.code_verifier;
      expect(failure.message.includes(verifier)).toBe(false);

      expectSyncError(
        () => login.completeLogin({ state: begin.state, code: 'upstream-code-value' }),
        /state/i,
        ERROR_CODES.UNKNOWN_STATE
      );
      expect(https.request).toHaveBeenCalledTimes(1);
    });
  });

  describe('R12: preservation — the factory is a reusable unit with no shared state', () => {
    it('creates independent login instances per call without side effects', () => {
      const first = createEntraLogin(validConfig());
      const second = createEntraLogin(validConfig());

      expect(first.beginLogin).not.toBe(second.beginLogin);
      first.beginLogin();
      expect(second.beginLogin).not.toThrow();

      const exportKeys = Object.keys(require('../../remote/entra-login')).sort();
      expect(exportKeys).toEqual(['ERROR_CODES', 'EntraLoginError', 'createEntraLogin']);
      expect(process.env.OUTLOOK_MCP_TOKENS || undefined).toBeUndefined();
    });
  });

  describe('R15: the wiring variant resolves the server-side upstream association', () => {
    it('returns the verified identity plus the upstream access-token association with an epoch-seconds expiry', async () => {
      const login = createEntraLogin(validConfig());
      const begin = login.beginLogin();
      const nonce = authorizationQuery(begin.authorizationUrl).get('nonce');
      enqueueTokenResponse({ idToken: mintIdToken({ nonce }) });

      const completed = await login.completeLoginWithUpstream({
        state: begin.state,
        code: 'upstream-code-value',
      });

      expect(completed.identity).toMatchObject({ objectId: 'object-alice', tenantId: TENANT_ID });
      expect(completed.upstream.accessToken).toMatch(/^upstream_access_token_/);
      expect(completed.upstream.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
      // T19: the upstream refresh credential now surfaces in this
      // server-to-server wiring variant only (the provider consumes it for
      // renewals); it still never reaches a browser or MCP client and no
      // secret or code surfaces anywhere.
      expect(completed.upstream.refreshToken).toMatch(/^upstream_refresh_token_/);
      expect(JSON.stringify(completed)).not.toContain(CLIENT_SECRET);
      expect(JSON.stringify(completed)).not.toContain('upstream-code-value');
    });

    it('keeps the plain completeLogin result token-free (preservation)', async () => {
      const login = createEntraLogin(validConfig());
      const begin = login.beginLogin();
      const nonce = authorizationQuery(begin.authorizationUrl).get('nonce');
      enqueueTokenResponse({ idToken: mintIdToken({ nonce }) });

      const completed = await login.completeLogin({
        state: begin.state,
        code: 'upstream-code-value',
      });

      expect(completed.mcpOauthFlowWired).toBe(false);
      const serialized = JSON.stringify(completed);
      expect(serialized.toLowerCase()).not.toContain('access_token');
      expect(serialized.toLowerCase()).not.toContain('id_token');
    });

    it('fails closed when the token response carries no usable upstream access token', async () => {
      const login = createEntraLogin(validConfig());
      const begin = login.beginLogin();
      const nonce = authorizationQuery(begin.authorizationUrl).get('nonce');
      enqueueTokenResponse({
        body: {
          token_type: 'Bearer',
          scope: SCOPE,
          expires_in: 3600,
          id_token: mintIdToken({ nonce }),
        },
      });

      await expect(
        login.completeLoginWithUpstream({ state: begin.state, code: 'upstream-code-value' })
      ).rejects.toMatchObject({ code: ERROR_CODES.UPSTREAM_MISSING });
    });
  });

  describe('R16: T19 initial offline_access request and server-side refresh passthrough', () => {
    it('requests the signed-in upstream scopes plus openid, profile, and offline_access exactly once', () => {
      const login = createEntraLogin(validConfig());
      const begin = login.beginLogin();
      const scope = authorizationQuery(begin.authorizationUrl).get('scope').split(' ');
      expect(scope).toEqual(expect.arrayContaining([SCOPE, 'openid', 'profile', 'offline_access']));
      expect(scope.filter((entry) => entry === 'offline_access')).toHaveLength(1);
    });

    it('carries a rotated upstream refresh token only server-side in the wiring variant, never in the plain completion', async () => {
      const login = createEntraLogin(validConfig());
      const begin = login.beginLogin();
      const nonce = authorizationQuery(begin.authorizationUrl).get('nonce');
      enqueueTokenResponse({ idToken: mintIdToken({ nonce }) });

      const wired = await login.completeLoginWithUpstream({
        state: begin.state,
        code: 'upstream-code-value',
      });
      expect(wired.upstream.refreshToken).toMatch(/^upstream_refresh_token_/);

      const login2 = createEntraLogin(validConfig());
      const begin2 = login2.beginLogin();
      const nonce2 = authorizationQuery(begin2.authorizationUrl).get('nonce');
      enqueueTokenResponse({ idToken: mintIdToken({ nonce: nonce2 }) });
      const plain = await login2.completeLogin({
        state: begin2.state,
        code: 'another-upstream-code',
      });
      expect(JSON.stringify(plain)).not.toContain('upstream_refresh_token');
      expect(Object.keys(plain)).toEqual(['identity', 'mcpOauthFlowWired']);
    });

    it('drops a malformed upstream refresh credential while the login still completes', async () => {
      for (const refreshTokenValue of ['', ' ', 'has spaces', 'x'.repeat(4097), 7]) {
        const login = createEntraLogin(validConfig());
        const begin = login.beginLogin();
        const nonce = authorizationQuery(begin.authorizationUrl).get('nonce');
        enqueueTokenResponse({
          body: {
            token_type: 'Bearer',
            scope: SCOPE,
            expires_in: 3600,
            access_token: 'upstream_access_token_ok',
            refresh_token: refreshTokenValue,
            id_token: mintIdToken({ nonce }),
          },
        });
        const completed = await login.completeLoginWithUpstream({
          state: begin.state,
          code: 'upstream-code-value',
        });
        expect(completed.upstream.accessToken).toBe('upstream_access_token_ok');
        expect(completed.upstream.refreshToken).toBeUndefined();
      }
    });

    it('completes without any refresh credential when Microsoft issues none (no pretended grant)', async () => {
      const login = createEntraLogin(validConfig());
      const begin = login.beginLogin();
      const nonce = authorizationQuery(begin.authorizationUrl).get('nonce');
      enqueueTokenResponse({
        body: {
          token_type: 'Bearer',
          scope: SCOPE,
          expires_in: 3600,
          access_token: 'upstream_access_token_ok',
          id_token: mintIdToken({ nonce }),
        },
      });
      const completed = await login.completeLoginWithUpstream({
        state: begin.state,
        code: 'upstream-code-value',
      });
      expect(completed.upstream.refreshToken).toBeUndefined();
      expect(JSON.stringify(completed)).not.toContain('refreshToken');
    });
  });
});
