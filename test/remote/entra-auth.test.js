/* Entra inbound access-token validation unit (T2, S1-S3).
 * Fully offline: synthetic signing keys and a local mocked JWKS only.
 * No HTTP listening, no real credentials, no network.
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const { createEntraTokenVerifier } = require('../../remote/entra-auth');

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT_ID = '22222222-2222-4222-8222-222222222222';
const AUDIENCE = 'api://outlook-mcp';
const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;
const REQUIRED_SCOPES = ['api.example.com/mcp.access'];

function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return { privateKey, publicKeyPem: publicKey };
}

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

function defaultConfig(overrides = {}) {
  return {
    tenantId: TENANT_ID,
    audience: AUDIENCE,
    requiredScopes: REQUIRED_SCOPES,
    jwksClient: createLocalJwks({ 'test-key-1': KEY_A.publicKeyPem }),
    ...overrides,
  };
}

function manuallySignedToken(payload, headerOverrides = {}) {
  const segments = [
    Buffer.from(
      JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'test-key-1', ...headerOverrides })
    ).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
  ];
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(segments.join('.'));
  segments.push(signer.sign(KEY_A.privateKey, 'base64url'));
  return segments.join('.');
}

function signToken(overrides = {}, options = {}) {
  const claims = {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: 'subject-1',
    tid: TENANT_ID,
    oid: 'object-1',
    scp: `${REQUIRED_SCOPES[0]} user.read`,
    preferred_username: 'user@example.com',
    groups: [],
    iat: Math.floor(Date.now() / 1000),
  };
  const payload = { ...claims, ...overrides };
  for (const key of Object.keys(payload)) {
    if (payload[key] === undefined) {
      delete payload[key];
    }
  }
  const signOptions = { algorithm: 'RS256', ...options };
  // With noTimestamp jsonwebtoken adds neither iat nor exp, so the default
  // expiresIn must be suppressed to mint a token without any expiry claim.
  if (!('expiresIn' in options) && !options.noTimestamp) {
    signOptions.expiresIn = '5m';
  }
  return jwt.sign(payload, KEY_A.privateKey, { ...signOptions, keyid: 'test-key-1' });
}

const KEY_A = generateKeyPair();
const KEY_B = generateKeyPair();
let verifier = null;
let config = null;

describe('Entra inbound token verifier', () => {
  beforeEach(() => {
    config = defaultConfig();
    verifier = createEntraTokenVerifier(config);
  });

  describe('R1: verifier configuration fails closed', () => {
    it('rejects an invalid verifier configuration', () => {
      expect(() => createEntraTokenVerifier(undefined)).toThrow(/tenantId/);
      expect(() => createEntraTokenVerifier({ ...config, tenantId: undefined })).toThrow(
        /tenantId/
      );
      expect(() => createEntraTokenVerifier({ ...config, tenantId: 'not-a-guid' })).toThrow(
        /tenantId/
      );
      expect(() => createEntraTokenVerifier({ ...config, audience: '' })).toThrow(/audience/);
      expect(() => createEntraTokenVerifier({ ...config, jwksClient: 'not-a-client' })).toThrow(
        /jwksClient/
      );
      expect(() => createEntraTokenVerifier({ ...config, clockTolerance: -5 })).toThrow(
        /clockTolerance/
      );
      expect(() => createEntraTokenVerifier({ ...config, unexpected: true })).toThrow(/unexpected/);
    });
  });

  describe('R2: signature validated against the tenant JWKS', () => {
    it('accepts a token signed by a trusted tenant JWKS key and returns the delegated identity', async () => {
      const identity = await verifier.verifyAccessToken(signToken());

      expect(identity.subject).toBe('subject-1');
      expect(identity.objectId).toBe('object-1');
      expect(identity.tenantId).toBe(TENANT_ID);
      expect(identity.username).toBe('user@example.com');
      expect(identity.scopes).toEqual(expect.arrayContaining(REQUIRED_SCOPES));
      expect(identity.groups).toEqual([]);
    });
  });

  describe('R3: tokens not signed by any tenant JWKS key are rejected', () => {
    it('rejects a token signed by a key that is absent from the tenant JWKS', async () => {
      const forged = jwt.sign(
        {
          iss: ISSUER,
          aud: AUDIENCE,
          sub: 'attacker',
          tid: TENANT_ID,
          oid: 'object-2',
          scp: REQUIRED_SCOPES[0],
        },
        KEY_B.privateKey,
        { algorithm: 'RS256', expiresIn: '5m', keyid: 'test-key-1' }
      );

      await expect(verifier.verifyAccessToken(forged)).rejects.toMatchObject({
        code: 'entra-token-untrusted',
      });
    });

    it('rejects a token whose kid is unknown to the tenant JWKS', async () => {
      const unknownKid = jwt.sign(
        {
          iss: ISSUER,
          aud: AUDIENCE,
          sub: 'user',
          tid: TENANT_ID,
          oid: 'object-3',
          scp: REQUIRED_SCOPES[0],
        },
        KEY_A.privateKey,
        { algorithm: 'RS256', expiresIn: '5m', keyid: 'absent-kid' }
      );

      await expect(verifier.verifyAccessToken(unknownKid)).rejects.toMatchObject({
        code: 'entra-token-untrusted',
      });
    });
  });

  describe('R4: issuer must match the configured tenant authority', () => {
    it('rejects a token issued by another issuer', async () => {
      const otherIssuer = jwt.sign(
        {
          iss: `https://login.microsoftonline.com/${OTHER_TENANT_ID}/v2.0`,
          aud: AUDIENCE,
          sub: 'subject-4',
          tid: TENANT_ID,
          oid: 'object-4',
          scp: REQUIRED_SCOPES[0],
        },
        KEY_A.privateKey,
        { algorithm: 'RS256', expiresIn: '5m', keyid: 'test-key-1' }
      );

      await expect(verifier.verifyAccessToken(otherIssuer)).rejects.toMatchObject({
        code: 'entra-token-invalid',
      });
    });
  });

  describe('R5: token must be minted for the configured MCP audience', () => {
    it('rejects a token intended for another audience', async () => {
      const otherAudience = signToken({ aud: 'api://something-else' });

      await expect(verifier.verifyAccessToken(otherAudience)).rejects.toMatchObject({
        code: 'entra-token-invalid',
      });
    });
  });

  describe('R6: expiration is enforced', () => {
    it('rejects an expired token', async () => {
      const expired = signToken({ iat: undefined }, { expiresIn: -120 });

      await expect(verifier.verifyAccessToken(expired)).rejects.toMatchObject({
        code: 'entra-token-expired',
      });
    });

    it('rejects a token without any expiry claim', async () => {
      const noExpiry = signToken({}, { noTimestamp: true });

      expect(jwt.decode(noExpiry).exp).toBeUndefined();
      await expect(verifier.verifyAccessToken(noExpiry)).rejects.toMatchObject({
        code: 'entra-token-invalid',
      });
    });

    it('rejects a token whose expiry claim is malformed or non-finite', async () => {
      const malformedExpiry = manuallySignedToken({ exp: 'next-tuesday' });
      const infiniteExpiry = manuallySignedToken({ exp: Infinity });

      expect(jwt.decode(malformedExpiry).exp).toBe('next-tuesday');
      expect(Number.isFinite(jwt.decode(infiniteExpiry).exp)).toBe(false);
      await expect(verifier.verifyAccessToken(malformedExpiry)).rejects.toMatchObject({
        code: 'entra-token-invalid',
      });
      await expect(verifier.verifyAccessToken(infiniteExpiry)).rejects.toMatchObject({
        code: 'entra-token-invalid',
      });
    });
  });

  describe('R7: tenant claim must match the configured tenant', () => {
    it('rejects a token whose tid does not match the configured tenant', async () => {
      const otherTenant = signToken({ tid: OTHER_TENANT_ID });

      await expect(verifier.verifyAccessToken(otherTenant)).rejects.toMatchObject({
        code: 'entra-token-invalid',
      });
    });
  });

  describe('R8: only delegated user tokens are accepted', () => {
    it('rejects an application token without delegated user identity or user scopes', async () => {
      const appOnly = signToken({ oid: undefined, scp: undefined, roles: ['Mail.Read'] });

      await expect(verifier.verifyAccessToken(appOnly)).rejects.toMatchObject({
        code: 'entra-token-delegated-required',
      });
    });

    it('rejects a token whose scp consists solely of whitespace', async () => {
      const blankScopes = signToken({ scp: '   ' });

      await expect(verifier.verifyAccessToken(blankScopes)).rejects.toMatchObject({
        code: 'entra-token-delegated-required',
      });
    });
  });

  describe('R9: delegated user scopes must satisfy the configured requirements', () => {
    it('rejects a token missing a required scope', async () => {
      const missingScope = signToken({ scp: 'user.read' });

      await expect(verifier.verifyAccessToken(missingScope)).rejects.toMatchObject({
        code: 'entra-token-insufficient-scope',
      });
    });

    it('accepts a token that carries every required scope', async () => {
      await expect(verifier.verifyAccessToken(signToken())).resolves.toMatchObject({
        objectId: 'object-1',
      });
    });
  });

  describe('R10: no separate local mutation policy', () => {
    it('exports no separate mutation-authorization predicate (S3)', () => {
      const entraAuth = require('../../remote/entra-auth');
      expect(entraAuth.isMutationAuthorized).toBeUndefined();
      expect(entraAuth.ERROR_CODES.MUTATION_FORBIDDEN).toBeUndefined();
    });
  });

  describe('R11: errors carry no token or key material', () => {
    it('fails closed with messages that contain no signed token', async () => {
      const token = signToken({ scp: 'user.read' });
      let message = null;
      try {
        await verifier.verifyAccessToken(token);
      } catch (error) {
        message = error.message;
      }

      expect(message).toBeTruthy();
      expect(message.includes(token)).toBe(false);
      expect(message).not.toMatch(/BEGIN (RSA )?PRIVATE KEY|BEGIN PUBLIC KEY/);
      expect(message.length).toBeLessThan(200);

      const forged = jwt.sign({}, KEY_B.privateKey, { algorithm: 'RS256', keyid: 'test-key-1' });
      try {
        await verifier.verifyAccessToken(forged);
      } catch (error) {
        expect(error.message.includes(forged)).toBe(false);
      }
    });
  });

  describe('R12: pinned independent security probes', () => {
    // These four probes already passed against the current implementation
    // before being pinned, so no meaningful RED observation exists for them;
    // intentionally recorded rather than fabricated.
    it('rejects an HS256 algorithm-confusion token signed with the public key as secret', async () => {
      const confused = jwt.sign(
        {
          iss: ISSUER,
          aud: AUDIENCE,
          sub: 'confused',
          tid: TENANT_ID,
          oid: 'object-hs',
          scp: REQUIRED_SCOPES[0],
          exp: Math.floor(Date.now() / 1000) + 300,
        },
        KEY_A.publicKeyPem,
        { algorithm: 'HS256', keyid: 'test-key-1' }
      );

      await expect(verifier.verifyAccessToken(confused)).rejects.toMatchObject({
        code: 'entra-token-invalid',
      });
    });

    it('rejects an unsigned alg:none token', async () => {
      const header = Buffer.from(
        JSON.stringify({ typ: 'JWT', alg: 'none', kid: 'test-key-1' })
      ).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          iss: ISSUER,
          aud: AUDIENCE,
          sub: 'unsigned',
          tid: TENANT_ID,
          oid: 'object-none',
          scp: REQUIRED_SCOPES[0],
        })
      ).toString('base64url');
      const unsigned = `${header}.${payload}.`;
      expect(unsigned.split('.')).toHaveLength(3);

      await expect(verifier.verifyAccessToken(unsigned)).rejects.toMatchObject({
        code: 'entra-token-invalid',
      });
    });

    it('rejects an expired token with zero clock tolerance and accepts it only inside the default tolerance', async () => {
      const strictVerifier = createEntraTokenVerifier(defaultConfig({ clockTolerance: 0 }));
      const freshlyExpired = signToken({ iat: undefined }, { expiresIn: -15 });

      await expect(strictVerifier.verifyAccessToken(freshlyExpired)).rejects.toMatchObject({
        code: 'entra-token-expired',
      });
      await expect(verifier.verifyAccessToken(freshlyExpired)).resolves.toMatchObject({
        objectId: 'object-1',
      });

      const longExpired = signToken({ iat: undefined }, { expiresIn: -120 });
      await expect(verifier.verifyAccessToken(longExpired)).rejects.toMatchObject({
        code: 'entra-token-expired',
      });
    });

    it('fails malformed tokens without exposing their content', async () => {
      const truncatedToken = signToken().slice(0, 48);
      for (const malformed of ['', 'not-a-jwt', truncatedToken, 'a.b.c.d.e']) {
        let message = null;
        try {
          await verifier.verifyAccessToken(malformed);
        } catch (error) {
          message = error.message;
        }

        expect(message).toBeTruthy();
        // The empty input has no content to echo, only the others must not appear.
        expect(malformed === '' || !message.includes(malformed)).toBe(true);
        expect(message.length).toBeLessThan(200);
      }
    });
  });

  describe('preservation: verifier factory is a reusable unit and emits no side effects', () => {
    it('creates independent verifiers per call without exposing HTTP or logging', () => {
      const second = createEntraTokenVerifier(defaultConfig());
      expect(second.verifyAccessToken).not.toBe(verifier.verifyAccessToken);
      expect(typeof verifier.verifyAccessToken).toBe('function');
      expect(verifier.exposeHttp).toBeUndefined();
    });
  });
});
