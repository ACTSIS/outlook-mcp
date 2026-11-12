/**
 * Tests for the MCP bridge rotating refresh-token families and their
 * persistence (task T18, S5, S10, S11). One focused block per rule:
 *
 * R1  standard refresh issuance and one-time rotation (the code grant now
 *     also issues a refresh token; the refresh grant rotates it one-time)
 * R2  replay of a consumed refresh token revokes exactly that family
 *     (all access + refresh tokens of the family) while unrelated grants
 *     keep working; a stale expired tombstone never revokes a live family
 * R3  unknown/cross-client/wrong-resource/invalid-scope refresh requests
 *     fail with the exact standard errors and never mutate stored state
 * R4  bounded sliding refresh expiry with a finite default TTL
 * R5  persistence: snapshot round trip through the encrypted bridge store,
 *     hash-keyed tokens (no plaintext on disk), tombstones across restart,
 *     fail-closed corruption/validation, persisted dynamic clients, and
 *     no partial state on persistence failure
 * R6  the optional upstream renewal seam: ensureUpstreamEntraToken with a
 *     per-family singleflight, identity immutability, fail-closed without
 *     a callback, permanent-vs-transient callback failures, and the
 *     optional upstream.refreshToken association preserved
 *
 * The persistent store seam is the exact T17 bridge-store public API
 * (load once {exists, generation, snapshot}, commit(snapshot), close()).
 * Encrypted snapshots live in per-test temporary directories that are
 * removed again; no Docker, no real network, no real credentials.
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
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');

const { InvalidTokenError } = require('@modelcontextprotocol/sdk/server/auth/errors.js');

const {
  createMCPOAuthProvider,
  MCPOAuthProviderError,
  ERROR_CODES,
  UPSTREAM_REAUTH_REQUIRED,
} = require('../../remote/oauth-provider');
const { createBridgeStore, DATA_FILE_NAME } = require('../../remote/bridge-store');

const TENANT_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const ISSUER_URL = 'https://sso.internal.example';
const SIGN_IN_URL = 'https://sso.internal.example/signin';
const PUBLIC_CLIENT = 'public-web-client';
const PUBLIC_REDIRECT = 'https://librechat.internal.example/oauth/callback';
const CONFIDENTIAL_CLIENT = 'confidential-mcp-client';
const CONFIDENTIAL_REDIRECT = 'https://mcp-client.example/oauth/callback';
const CONFIDENTIAL_SECRET = 'synthetic-confidential-client-secret-v1';
const MCP_RESOURCE = 'https://mcp.internal.example/mcp';
const UPSTREAM_TOKEN_A = 'synthetic-upstream-entra-token-user-a';
const UPSTREAM_TOKEN_B = 'synthetic-upstream-entra-token-user-b';

let tempRoot;

function keyFor(seed) {
  return crypto.createHash('sha256').update(seed).digest();
}

function makeStoreDir(name) {
  const dir = path.join(tempRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeStore(dir, overrides = {}) {
  return createBridgeStore({
    directory: dir,
    key: keyFor('test-store-key'),
    deploymentId: 'oauth-refresh-test',
    ...overrides,
  });
}

function defaultOptions(overrides = {}) {
  return {
    issuerUrl: ISSUER_URL,
    signInUrl: SIGN_IN_URL,
    supportedScopes: ['mcp', 'mail:read', 'mail:send'],
    resourceServerUrl: MCP_RESOURCE,
    clients: [
      {
        clientId: CONFIDENTIAL_CLIENT,
        clientSecret: CONFIDENTIAL_SECRET,
        redirectUris: [CONFIDENTIAL_REDIRECT],
      },
      {
        clientId: PUBLIC_CLIENT,
        redirectUris: [PUBLIC_REDIRECT],
      },
    ],
    ...overrides,
  };
}

function createBundle(options) {
  return createMCPOAuthProvider(defaultOptions(options));
}

function appFor(bundle) {
  const app = express();
  app.use('/', bundle.router);
  return app;
}

function randomVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

function challengeFor(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function extractRef(location) {
  return new URL(location).searchParams.get('mcp_authorization');
}

function extractParam(redirectTo, name) {
  return new URL(redirectTo).searchParams.get(name);
}

function entraAssociation(overrides = {}) {
  return {
    accessToken: UPSTREAM_TOKEN_A,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    objectId: 'entra-user-object-id-a',
    tenantId: TENANT_ID,
    username: 'user-a@example.com',
    ...overrides,
  };
}

/**
 * The standard authorization query for one client.
 */
function authorizeQueryFor({
  clientId = PUBLIC_CLIENT,
  redirectUri = PUBLIC_REDIRECT,
  scope = 'mcp',
  resource = undefined,
  verifier = randomVerifier(),
} = {}) {
  return {
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope,
    state: 'refresh-test-state',
    code_challenge: challengeFor(verifier),
    code_challenge_method: 'S256',
    ...(resource ? { resource } : {}),
  };
}

/**
 * Runs authorize -> completion -> code exchange and returns the issued
 * token response plus the PKCE verifier used.
 */
async function runPublicFlow(
  app,
  bundle,
  {
    clientId = PUBLIC_CLIENT,
    redirectUri = PUBLIC_REDIRECT,
    clientSecret = undefined,
    scope = 'mcp',
    resource = undefined,
    entra = {},
    codeExchange = {},
  } = {}
) {
  const verifier = randomVerifier();
  const query = authorizeQueryFor({ clientId, redirectUri, scope, resource, verifier });
  const authorizeResponse = await request(app).get('/authorize').query(query);
  expect(authorizeResponse.status).toBe(302);
  const ref = extractRef(authorizeResponse.headers.location);
  expect(ref).toMatch(/^[\w-]{30,}$/);
  const association = {
    authorizationRef: ref,
    entra: entraAssociation(entra),
  };
  if (codeExchange.upstreamAssociations) {
    association.upstream = codeExchange.upstreamAssociations;
  }
  const completed = bundle.completeAuthorizationAfterEntraSignIn(association);
  const code = extractParam(completed.redirectTo, 'code');
  expect(code).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  const tokenResponse = await request(app)
    .post('/token')
    .type('form')
    .send({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
      redirect_uri: redirectUri,
      ...(resource ? { resource } : {}),
    });
  return { tokenResponse, verifier };
}

async function postTokenExchange(app, body) {
  return request(app).post('/token').type('form').send(body);
}

async function postRefresh(
  app,
  {
    refreshToken,
    clientId = PUBLIC_CLIENT,
    scope = undefined,
    resource = undefined,
    clientSecret = undefined,
  }
) {
  return postTokenExchange(app, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    ...(clientSecret ? { client_secret: clientSecret } : {}),
    ...(scope ? { scope } : {}),
    ...(resource ? { resource } : {}),
  });
}

/**
 * Direct provider-API refresh (the exact public path the SDK token handler
 * calls) for tests that need fake timers.
 */
function providerRefresh(bundle, refreshToken, { clientId = PUBLIC_CLIENT, scope, resource } = {}) {
  return bundle.provider.exchangeRefreshToken(
    { client_id: clientId },
    refreshToken,
    scope,
    resource
  );
}

function snapshotBytes(dir) {
  return fs.readFileSync(path.join(dir, DATA_FILE_NAME));
}

function withFakeTime(shiftMs, run) {
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
    ],
  });
  jest.setSystemTime(Date.now() + shiftMs);
  return Promise.resolve()
    .then(run)
    .finally(() => {
      jest.useRealTimers();
    });
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-refresh-test-'));
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3 });
});

describe('R1 standard refresh issuance and rotation', () => {
  it('issues a refresh token with the code grant and rotates one-time on the refresh grant', async () => {
    const bundle = createBundle();
    const app = appFor(bundle);
    const { tokenResponse } = await runPublicFlow(app, bundle);
    expect(tokenResponse.status).toBe(200);
    const issued = tokenResponse.body;
    expect(issued.token_type).toBe('Bearer');
    expect(issued.access_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.refresh_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.refresh_token).not.toBe(issued.access_token);
    expect(issued.scope).toBe('mcp');

    const rotated = await postRefresh(app, { refreshToken: issued.refresh_token });
    expect(rotated.status).toBe(200);
    const rotatedBody = rotated.body;
    expect(rotatedBody.access_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(rotatedBody.refresh_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(rotatedBody.access_token).not.toBe(issued.access_token);
    expect(rotatedBody.refresh_token).not.toBe(issued.refresh_token);
    expect(rotatedBody.scope).toBe('mcp');
    expect(rotatedBody.token_type).toBe('Bearer');
    expect(rotatedBody.expires_in).toBeGreaterThan(0);
  });

  it('keeps the family binding across rotation: same client, user, tenant, and resource', async () => {
    const bundle = createBundle();
    const app = appFor(bundle);
    const { tokenResponse } = await runPublicFlow(app, bundle, { resource: MCP_RESOURCE });
    const originalAccess = tokenResponse.body.access_token;
    const rotated = await postRefresh(app, {
      refreshToken: tokenResponse.body.refresh_token,
      resource: MCP_RESOURCE,
    });
    expect(rotated.status).toBe(200);
    const verified = await bundle.provider.verifyAccessToken(rotated.body.access_token);
    expect(verified.clientId).toBe(PUBLIC_CLIENT);
    expect(verified.scopes).toEqual(['mcp']);
    expect(verified.resource.href).toBe(MCP_RESOURCE);
    expect(verified.extra.userId).toBe('entra-user-object-id-a');
    expect(verified.extra.tenantId).toBe(TENANT_ID);
    expect(verified.extra.username).toBe('user-a@example.com');
    // An unrelated rotation leaves the previous access token untouched.
    const stillValid = await bundle.provider.verifyAccessToken(originalAccess);
    expect(stillValid.extra.userId).toBe('entra-user-object-id-a');
  });

  it('allows the refresh grant to narrow the requested scope and restores the granted set when omitted', async () => {
    const bundle = createBundle();
    const app = appFor(bundle);
    const { tokenResponse } = await runPublicFlow(app, bundle, { scope: 'mcp mail:read' });
    const narrowed = await postRefresh(app, {
      refreshToken: tokenResponse.body.refresh_token,
      scope: 'mcp',
    });
    expect(narrowed.status).toBe(200);
    expect(narrowed.body.scope).toBe('mcp');
    const narrowedVerified = await bundle.provider.verifyAccessToken(narrowed.body.access_token);
    expect(narrowedVerified.scopes).toEqual(['mcp']);

    // A later rotation without a scope restores the family's granted scope.
    const restored = await postRefresh(app, {
      refreshToken: narrowed.body.refresh_token,
    });
    expect(restored.status).toBe(200);
    expect(restored.body.scope).toBe('mcp mail:read');
  });

  it('supports the refresh grant for confidential clients with their exact registered secret', async () => {
    const bundle = createBundle();
    const app = appFor(bundle);
    const { tokenResponse } = await runPublicFlow(app, bundle, {
      clientId: CONFIDENTIAL_CLIENT,
      redirectUri: CONFIDENTIAL_REDIRECT,
      clientSecret: CONFIDENTIAL_SECRET,
    });
    expect(tokenResponse.status).toBe(200);
    const issued = tokenResponse.body;
    expect(issued.refresh_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The confidential client must authenticate its refresh grant.
    const withoutSecret = await postRefresh(app, {
      refreshToken: issued.refresh_token,
      clientId: CONFIDENTIAL_CLIENT,
    });
    expect(withoutSecret.status).toBe(400);
    expect(withoutSecret.body.error).toBe('invalid_client');
    const rotated = await postRefresh(app, {
      refreshToken: issued.refresh_token,
      clientId: CONFIDENTIAL_CLIENT,
      clientSecret: CONFIDENTIAL_SECRET,
    });
    expect(rotated.status).toBe(200);
    expect(rotated.body.refresh_token).not.toBe(issued.refresh_token);
    expect(rotated.body.access_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('never issues a refresh token when a registered client explicitly restricts its grants', async () => {
    const bundle = createBundle({
      clients: [
        {
          clientId: 'code-only-client',
          redirectUris: ['https://code-only.example/callback'],
          grants: ['authorization_code'],
        },
      ],
    });
    const app = appFor(bundle);
    // The default remains: refresh alongside code.
    expect(bundle.metadata.grant_types_supported).toEqual(
      expect.arrayContaining(['authorization_code', 'refresh_token'])
    );
    const { tokenResponse } = await runPublicFlow(app, bundle, {
      clientId: 'code-only-client',
      redirectUri: 'https://code-only.example/callback',
    });
    expect(tokenResponse.status).toBe(200);
    expect(tokenResponse.body.access_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokenResponse.body.refresh_token).toBeUndefined();
    // An explicit grants entry missing the authorization grant fails closed.
    expect(() =>
      createBundle({
        clients: [
          {
            clientId: 'refresh-only-client',
            redirectUris: ['https://refresh-only.example/callback'],
            grants: ['refresh_token'],
          },
        ],
      })
    ).toThrow(/grant/i);
    expect(() =>
      createBundle({
        clients: [
          {
            clientId: 'bad-grants-client',
            redirectUris: ['https://bad.example/callback'],
            grants: ['authorization_code', 'client_credentials'],
          },
        ],
      })
    ).toThrow(/grant/i);
  });
});

describe('R2 replay revokes exactly the compromised family', () => {
  it('revokes all access and refresh tokens of the family on replay and isolates other grants', async () => {
    const bundle = createBundle();
    const app = appFor(bundle);
    const first = await runPublicFlow(app, bundle);
    expect(first.tokenResponse.status).toBe(200);
    const compromised = first.tokenResponse.body;
    const second = await runPublicFlow(app, bundle, {
      entra: entraAssociation({
        accessToken: UPSTREAM_TOKEN_B,
        objectId: 'entra-user-object-id-b',
        username: 'user-b@example.com',
      }),
    });
    expect(second.tokenResponse.status).toBe(200);
    const intact = second.tokenResponse.body;

    // One legitimate rotation first consumes the original refresh token.
    const rotation = await postRefresh(app, { refreshToken: compromised.refresh_token });
    expect(rotation.status).toBe(200);
    const rotatedAccess = rotation.body.access_token;

    // Reusing the consumed (correctly-bound) token revokes the family.
    const replayed = await postRefresh(app, { refreshToken: compromised.refresh_token });
    expect(replayed.status).toBe(400);
    expect(replayed.body.error).toBe('invalid_grant');

    // The compromised family is fully revoked: every access token it
    // issued stops verifying, including the one the rotation just minted.
    expect(() => bundle.provider.verifyAccessToken(compromised.access_token)).toThrow(
      InvalidTokenError
    );
    expect(() => bundle.provider.verifyAccessToken(rotatedAccess)).toThrow(InvalidTokenError);
    // The consumed token can never mint again, even by a repeated replay.
    const replayedAgain = await postRefresh(app, { refreshToken: compromised.refresh_token });
    expect(replayedAgain.status).toBe(400);

    // The unrelated family (second user) keeps working exactly as before.
    const isolated = await postRefresh(app, { refreshToken: intact.refresh_token });
    expect(isolated.status).toBe(200);
    const isolatedVerified = await bundle.provider.verifyAccessToken(isolated.body.access_token);
    expect(isolatedVerified.extra.userId).toBe('entra-user-object-id-b');
    expect(isolatedVerified.extra.tenantId).toBe(TENANT_ID);
    expect(() => bundle.provider.verifyAccessToken(compromised.access_token)).toThrow(
      InvalidTokenError
    );
  });

  it('does not revoke a live family for a stale expired replayed tombstone', async () => {
    const bundle = createBundle({ refreshTokenTtlSeconds: 10 });
    const app = appFor(bundle);
    const { tokenResponse } = await runPublicFlow(app, bundle);
    const issued = tokenResponse.body;

    // t+2s: rotate once, so the consumed token's tombstone dies at t+12s
    // while the family (slid at t+2s) still lives until t+12s.
    const firstRotation = await withFakeTime(2 * 1000, async () => {
      const rotation = await providerRefresh(bundle, issued.refresh_token);
      expect(rotation.access_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      return rotation;
    });
    // t+6s: rotate again so the family lives past the stale tombstone.
    const secondRotation = await withFakeTime(6 * 1000, async () => {
      const rotation = await providerRefresh(bundle, firstRotation.refresh_token);
      expect(rotation.access_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      return rotation;
    });
    // About t+15s: replay the long-consumed token; its tombstone expired
    // near t+12s, so it is simply unknown and must NOT revoke the live
    // family (which still lives past its slid deadline).
    await withFakeTime(15 * 1000, async () => {
      await expect(providerRefresh(bundle, issued.refresh_token)).rejects.toThrow(
        /invalid or has expired/i
      );
      // The live family keeps rotating with its current refresh token.
      const live = await providerRefresh(bundle, secondRotation.refresh_token);
      const liveVerified = await bundle.provider.verifyAccessToken(live.access_token);
      expect(liveVerified.extra.tenantId).toBe(TENANT_ID);
    });
  });
});

describe('R3 invalid refresh requests never mutate stored state', () => {
  it('rejects an unknown refresh token with invalid_grant and leaves valid state intact', async () => {
    const bundle = createBundle();
    const app = appFor(bundle);
    const { tokenResponse } = await runPublicFlow(app, bundle);
    const unknown = await postRefresh(app, { refreshToken: 'synthetic-never-issued-token' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toBe('invalid_grant');
    const stillWorks = await postRefresh(app, {
      refreshToken: tokenResponse.body.refresh_token,
    });
    expect(stillWorks.status).toBe(200);
  });

  it('rejects cross-client refresh without mutation (no cross-client revoke DoS)', async () => {
    const bundle = createBundle();
    const app = appFor(bundle);
    const { tokenResponse } = await runPublicFlow(app, bundle);
    // An authenticated different client is a strict binding failure.
    await expect(
      bundle.provider.exchangeRefreshToken(
        { client_id: CONFIDENTIAL_CLIENT },
        tokenResponse.body.refresh_token
      )
    ).rejects.toThrow(/not issued to this client/i);
    // The wrong-client attempt must not have tombstoned or deleted the
    // token: the legitimate owner still rotates immediately after.
    const stillWorks = await postRefresh(app, {
      refreshToken: tokenResponse.body.refresh_token,
    });
    expect(stillWorks.status).toBe(200);
    const stillValid = await bundle.provider.verifyAccessToken(tokenResponse.body.access_token);
    expect(stillValid.extra.userId).toBe('entra-user-object-id-a');
  });

  it('rejects resource mismatches with invalid_grant and without mutation', async () => {
    const bundle = createBundle();
    const app = appFor(bundle);
    const { tokenResponse } = await runPublicFlow(app, bundle, { resource: MCP_RESOURCE });
    for (const resource of [undefined, 'https://other.example/mcp']) {
      const mismatch = await postRefresh(app, {
        refreshToken: tokenResponse.body.refresh_token,
        ...(resource ? { resource } : {}),
      });
      expect(mismatch.status).toBe(400);
      expect(mismatch.body.error).toBe('invalid_grant');
    }
    const stillWorks = await postRefresh(app, {
      refreshToken: tokenResponse.body.refresh_token,
      resource: MCP_RESOURCE,
    });
    expect(stillWorks.status).toBe(200);
  });

  it('rejects unsupported and expanded scopes with invalid_scope and without mutation', async () => {
    const bundle = createBundle();
    const app = appFor(bundle);
    const { tokenResponse } = await runPublicFlow(app, bundle, { scope: 'mcp mail:read' });
    const unsupported = await postRefresh(app, {
      refreshToken: tokenResponse.body.refresh_token,
      scope: 'mcp undisclosed:scope',
    });
    expect(unsupported.status).toBe(400);
    expect(unsupported.body.error).toBe('invalid_scope');
    const expanded = await postRefresh(app, {
      refreshToken: tokenResponse.body.refresh_token,
      scope: 'mcp mail:read mail:send',
    });
    expect(expanded.status).toBe(400);
    expect(expanded.body.error).toBe('invalid_scope');
    // The refusal never consumed the token nor narrowed the family.
    const stillWorks = await postRefresh(app, {
      refreshToken: tokenResponse.body.refresh_token,
    });
    expect(stillWorks.status).toBe(200);
    expect(stillWorks.body.scope).toBe('mcp mail:read');
  });
});

describe('R4 bounded sliding refresh expiry', () => {
  it('rejects out-of-bound TTL configuration and accepts the finite default', () => {
    expect(() => createBundle({ refreshTokenTtlSeconds: 0 })).toThrow(/ttl/i);
    expect(() => createBundle({ refreshTokenTtlSeconds: 1.5 })).toThrow(/ttl/i);
    expect(() => createBundle({ refreshTokenTtlSeconds: Number.MAX_SAFE_INTEGER })).toThrow(/ttl/i);
    expect(() => createBundle({ refreshTokenTtlSeconds: 90 * 24 * 60 * 60 })).not.toThrow();
    const bundle = createBundle();
    expect(bundle.metadata.grant_types_supported).toContain('refresh_token');
  });

  it('mints nothing for an expired family while access tokens keep their own TTL', async () => {
    const bundle = createBundle({ refreshTokenTtlSeconds: 1 });
    const app = appFor(bundle);
    const { tokenResponse } = await runPublicFlow(app, bundle);
    const issued = tokenResponse.body;
    await withFakeTime(2 * 1000, async () => {
      await expect(providerRefresh(bundle, issued.refresh_token)).rejects.toThrow(
        /invalid or has expired/i
      );
      // The access token stays governed only by its own TTL.
      const stillValid = await bundle.provider.verifyAccessToken(issued.access_token);
      expect(stillValid.extra.userId).toBe('entra-user-object-id-a');
    });
  });

  it('slides the family window forward on every successful rotation', async () => {
    const bundle = createBundle({ refreshTokenTtlSeconds: 10 });
    const app = appFor(bundle);
    const { tokenResponse } = await runPublicFlow(app, bundle);
    const issued = tokenResponse.body;
    // t+8s (inside the first 10s window): rotation slides the family to
    // about t+18s, so a later rotation past the original deadline works.
    const firstRotation = await withFakeTime(8 * 1000, async () => {
      const rotation = await providerRefresh(bundle, issued.refresh_token);
      expect(rotation.access_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      return rotation;
    });
    // t+14s, past the original deadline but inside the slid window.
    const secondRotation = await withFakeTime(14 * 1000, async () => {
      const rotation = await providerRefresh(bundle, firstRotation.refresh_token);
      expect(rotation.access_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      return rotation;
    });
    // About t+25s: past even the second slid window; the family is dead.
    await withFakeTime(25 * 1000, async () => {
      await expect(providerRefresh(bundle, secondRotation.refresh_token)).rejects.toThrow(
        /invalid or has expired/i
      );
      // Access tokens minted while the family lived still verify under
      // their own TTL.
      const access = await bundle.provider.verifyAccessToken(secondRotation.access_token);
      expect(access.extra.userId).toBe('entra-user-object-id-a');
    });
  });
});

describe('R5 persistence across restart through the encrypted bridge store', () => {
  it('restores access and refresh credentials for a second provider instance over the same snapshot', async () => {
    const dir = makeStoreDir('restart');
    const first = createBundle({ persistentStore: makeStore(dir) });
    const app = appFor(first);
    const { tokenResponse } = await runPublicFlow(app, first);
    expect(tokenResponse.status).toBe(200);
    const issuedAccess = tokenResponse.body.access_token;
    const issuedRefresh = tokenResponse.body.refresh_token;
    first.close();

    const second = createBundle({ persistentStore: makeStore(dir) });
    const restored = await second.provider.verifyAccessToken(issuedAccess);
    expect(restored.extra.userId).toBe('entra-user-object-id-a');
    expect(restored.clientId).toBe(PUBLIC_CLIENT);
    // The same refresh credential continues its family on the new instance.
    const rotated = await postRefresh(appFor(second), { refreshToken: issuedRefresh });
    expect(rotated.status).toBe(200);
    expect(rotated.body.refresh_token).not.toBe(issuedRefresh);
    const rotatedVerified = await second.provider.verifyAccessToken(rotated.body.access_token);
    expect(rotatedVerified.extra.tenantId).toBe(TENANT_ID);
    second.close();
  });

  it('keeps MCP access and refresh tokens out of the snapshot in plaintext form', async () => {
    const dir = makeStoreDir('no-plaintext');
    const bundle = createBundle({ persistentStore: makeStore(dir) });
    const app = appFor(bundle);
    const { tokenResponse } = await runPublicFlow(app, bundle, { resource: MCP_RESOURCE });
    const access = tokenResponse.body.access_token;
    const refresh = tokenResponse.body.refresh_token;
    const bytes = snapshotBytes(dir);
    const raw = bytes.toString('latin1');
    for (const secret of [access, refresh]) {
      expect(raw).not.toContain(secret);
      expect(bytes.toString('base64')).not.toContain(Buffer.from(secret).toString('base64'));
      expect(bytes.toString('hex')).not.toContain(Buffer.from(secret).toString('hex'));
    }
    // Hash-keyed map entries exist: a restart still recognizes the tokens.
    const second = createBundle({ persistentStore: makeStore(dir) });
    expect((await second.provider.verifyAccessToken(access)).extra.tenantId).toBe(TENANT_ID);
    second.close();
  });

  it('persists used-token tombstones so replay across restart still revokes the family', async () => {
    const dir = makeStoreDir('tombstones');
    const first = createBundle({ persistentStore: makeStore(dir) });
    const app = appFor(first);
    const { tokenResponse } = await runPublicFlow(app, first);
    const issuedAccess = tokenResponse.body.access_token;
    const issuedRefresh = tokenResponse.body.refresh_token;
    // One legitimate rotation consumes the original token and tombstones it.
    const rotation = await postRefresh(app, { refreshToken: issuedRefresh });
    expect(rotation.status).toBe(200);
    first.close();

    const second = createBundle({ persistentStore: makeStore(dir) });
    const replayed = await postRefresh(appFor(second), { refreshToken: issuedRefresh });
    expect(replayed.status).toBe(400);
    expect(replayed.body.error).toBe('invalid_grant');
    // The revocation itself was persisted: a restart sees the family dead.
    second.close();
    const third = createBundle({ persistentStore: makeStore(dir) });
    expect(() => third.provider.verifyAccessToken(issuedAccess)).toThrow(InvalidTokenError);
    third.close();
  });

  it('fails closed on a corrupt snapshot instead of starting with lost state', async () => {
    const dir = makeStoreDir('corrupt');
    const bundle = createBundle({ persistentStore: makeStore(dir) });
    const app = appFor(bundle);
    const { tokenResponse } = await runPublicFlow(app, bundle);
    expect(tokenResponse.status).toBe(200);
    bundle.close();
    const dataFile = path.join(dir, DATA_FILE_NAME);
    const bytes = Buffer.from(fs.readFileSync(dataFile));
    bytes[bytes.length - 1] ^= 0x01;
    fs.writeFileSync(dataFile, bytes);
    expect(() => createBundle({ persistentStore: makeStore(dir) })).toThrow();
  });

  it('fails closed with validation codes on schema violations and prototype-pollution keys', async () => {
    const dir = makeStoreDir('validation');
    const now = Math.floor(Date.now() / 1000);
    const validFamily = {
      userId: 'user-oid',
      tenantId: TENANT_ID,
      clientId: PUBLIC_CLIENT,
      scopes: ['mcp'],
      resource: null,
      upstream: { accessToken: 'synthetic-upstream-token', expiresAt: now + 3600 },
      familyExpiresAt: Date.now() + 1000 * 60 * 60,
      createdAt: Date.now(),
    };
    const cases = [
      {
        name: 'version',
        snapshot: { snapshotVersion: 99, families: {}, accessTokens: {} },
      },
      {
        name: 'unknown-key',
        snapshot: { snapshotVersion: 1, families: {}, bogus: true },
      },
      {
        // Built through JSON.parse so "__proto__" survives as an own key.
        name: 'pollution',
        snapshot: JSON.parse(
          '{"snapshotVersion":1,"families":{"__proto__":{"userId":"u"}},"accessTokens":{},"refreshTokens":{},"usedRefreshTokens":{}}'
        ),
      },
      {
        name: 'bad-expiry',
        snapshot: {
          snapshotVersion: 1,
          families: { fam: { ...validFamily, familyExpiresAt: 'not-a-number' } },
          accessTokens: {},
          refreshTokens: {},
          usedRefreshTokens: {},
        },
      },
      {
        name: 'unknown-field',
        snapshot: {
          snapshotVersion: 1,
          families: { fam: { ...validFamily, sneakyField: 'x' } },
          accessTokens: {},
          refreshTokens: {},
          usedRefreshTokens: {},
        },
      },
    ];
    for (const { name, snapshot } of cases) {
      const caseDir = path.join(dir, name);
      const writer = makeStore(caseDir);
      writer.load();
      writer.commit(snapshot);
      writer.close();
      let error = null;
      try {
        createBundle({ persistentStore: makeStore(caseDir) });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(MCPOAuthProviderError);
      expect(error.code).toBe(ERROR_CODES.PERSISTED_STATE);
    }
  });

  it('persists dynamic client registrations when enabled and refuses to load them when disabled', async () => {
    const dir = makeStoreDir('dynamic');
    const first = createBundle({
      persistentStore: makeStore(dir),
      allowDynamicRegistration: true,
    });
    const app = appFor(first);
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
    first.close();

    const second = createBundle({
      persistentStore: makeStore(dir),
      allowDynamicRegistration: true,
    });
    expect(second.clientsStore.getClient(registration.body.client_id)).toBeDefined();
    second.close();

    // A snapshot with persisted dynamic clients cannot load when dynamic
    // registration is no longer enabled: an honest failure for the
    // unsupported persistent dynamic mode.
    expect(() =>
      createBundle({
        persistentStore: makeStore(dir),
        allowDynamicRegistration: false,
      })
    ).toThrow(/dynamic/i);
  });

  it('persists dual-grant dynamic clients and renews their refresh families after restart', async () => {
    const dir = makeStoreDir('dynamic-dual-grant');
    const first = createBundle({
      persistentStore: makeStore(dir),
      allowDynamicRegistration: true,
    });
    const firstApp = appFor(first);
    const registration = await request(firstApp)
      .post('/register')
      .send({
        redirect_uris: ['https://new-dual.example/callback'],
        token_endpoint_auth_method: 'client_secret_post',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      })
      .expect(201);
    expect(registration.body.client_id).toBeDefined();
    expect(registration.body.grant_types).toEqual(['authorization_code', 'refresh_token']);
    // The registered dual-grant client mints a rotating refresh token
    // through the public routes only.
    const { tokenResponse } = await runPublicFlow(firstApp, first, {
      clientId: registration.body.client_id,
      redirectUri: 'https://new-dual.example/callback',
      clientSecret: registration.body.client_secret,
    });
    expect(tokenResponse.status).toBe(200);
    expect(tokenResponse.body.refresh_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const preRestartRefresh = tokenResponse.body.refresh_token;
    first.close();

    // A fresh process loads the same store: the persisted client and its
    // secret complete another public flow (authorize would refuse an
    // unknown client), and the pre-restart refresh token still rotates.
    const second = createBundle({
      persistentStore: makeStore(dir),
      allowDynamicRegistration: true,
    });
    const secondApp = appFor(second);
    const reissued = await runPublicFlow(secondApp, second, {
      clientId: registration.body.client_id,
      redirectUri: 'https://new-dual.example/callback',
      clientSecret: registration.body.client_secret,
    });
    expect(reissued.tokenResponse.status).toBe(200);
    const rotated = await postRefresh(secondApp, {
      refreshToken: preRestartRefresh,
      clientId: registration.body.client_id,
      clientSecret: registration.body.client_secret,
    });
    expect(rotated.status).toBe(200);
    expect(rotated.body.refresh_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(rotated.body.refresh_token).not.toBe(preRestartRefresh);
    second.close();
  });

  it('returns no tokens and leaves no partially changed state when persistence fails', async () => {
    const dir = makeStoreDir('exchange-failure');
    const inner = makeStore(dir);
    let failNextCommit = true;
    const flaky = {
      load: () => inner.load(),
      commit: (snapshot) => {
        if (failNextCommit) {
          failNextCommit = false;
          throw new Error('synthetic-commit-failure');
        }
        return inner.commit(snapshot);
      },
      close: () => inner.close(),
    };
    const bundle = createBundle({ persistentStore: flaky });
    const app = appFor(bundle);
    const flowVerifier = randomVerifier();
    const authorizeResponse = await request(app)
      .get('/authorize')
      .query(authorizeQueryFor({ verifier: flowVerifier }));
    const ref = extractRef(authorizeResponse.headers.location);
    const completed = bundle.completeAuthorizationAfterEntraSignIn({
      authorizationRef: ref,
      entra: entraAssociation(),
    });
    const code = extractParam(completed.redirectTo, 'code');
    const failedExchange = await postTokenExchange(app, {
      grant_type: 'authorization_code',
      code,
      code_verifier: flowVerifier,
      client_id: PUBLIC_CLIENT,
      redirect_uri: PUBLIC_REDIRECT,
    });
    expect(failedExchange.status).toBe(500);
    expect(failedExchange.body.error).toBe('server_error');
    expect(failedExchange.body.access_token).toBeUndefined();
    expect(failedExchange.body.refresh_token).toBeUndefined();

    // No partial state: the very same code is still exchangeable once the
    // store commits successfully, and it yields valid credentials.
    const retriedExchange = await postTokenExchange(app, {
      grant_type: 'authorization_code',
      code,
      code_verifier: flowVerifier,
      client_id: PUBLIC_CLIENT,
      redirect_uri: PUBLIC_REDIRECT,
    });
    expect(retriedExchange.status).toBe(200);
    const access = retriedExchange.body.access_token;
    const restored = await bundle.provider.verifyAccessToken(access);
    expect(restored.extra.tenantId).toBe(TENANT_ID);
  });

  it('leaves the stored family untouched when a rotation commit fails', async () => {
    const dir = makeStoreDir('rotation-failure');
    const inner = makeStore(dir);
    let failureArmed = false;
    const flaky = {
      load: () => inner.load(),
      commit: (snapshot) => {
        if (failureArmed) {
          failureArmed = false;
          throw new Error('synthetic-commit-failure');
        }
        return inner.commit(snapshot);
      },
      close: () => inner.close(),
    };
    const bundle = createBundle({ persistentStore: flaky });
    const app = appFor(bundle);
    const { tokenResponse } = await runPublicFlow(app, bundle);
    const issued = tokenResponse.body;
    failureArmed = true;
    const failed = await postRefresh(app, { refreshToken: issued.refresh_token });
    expect(failed.status).toBe(500);
    expect(failed.body.access_token).toBeUndefined();
    // The original refresh token is still exactly where it was: rotation
    // retries once the store recovers and succeeds with no tombstone.
    const retried = await postRefresh(app, { refreshToken: issued.refresh_token });
    expect(retried.status).toBe(200);
    expect(retried.body.access_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('R6 optional upstream renewal seam (runtime wiring pending T19)', () => {
  it('returns the upstream association for a fresh token without invoking any callback', async () => {
    let callbackCalls = 0;
    const bundle = createBundle({
      refreshUpstreamEntraToken: async () => {
        callbackCalls += 1;
        return {
          accessToken: 'refreshed-upstream-token',
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        };
      },
    });
    const app = appFor(bundle);
    const { tokenResponse } = await runPublicFlow(app, bundle);
    const association = await bundle.ensureUpstreamEntraToken(tokenResponse.body.access_token);
    expect(callbackCalls).toBe(0);
    expect(association.accessToken).toBe(UPSTREAM_TOKEN_A);
    expect(association.objectId).toBe('entra-user-object-id-a');
    expect(await bundle.ensureUpstreamEntraToken('synthetic-unknown-token')).toBeUndefined();
  });

  it('renews a near-expiry upstream once per family through the injected callback with an immutable identity', async () => {
    const seen = [];
    const bundle = createBundle({
      refreshUpstreamEntraToken: async ({ upstream, identity }) => {
        seen.push({ upstream, identity });
        return {
          accessToken: 'refreshed-upstream-token-value',
          expiresAt: Math.floor(Date.now() / 1000) + 7200,
          objectId: 'attacker-oid',
          tenantId: 'attacker-tenant',
        };
      },
    });
    const app = appFor(bundle);
    const { tokenResponse } = await runPublicFlow(app, bundle, {
      entra: entraAssociation({ expiresAt: Math.floor(Date.now() / 1000) + 60 }),
    });
    const association = await bundle.ensureUpstreamEntraToken(tokenResponse.body.access_token);
    expect(association.accessToken).toBe('refreshed-upstream-token-value');
    expect(association.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000) + 3600);
    // The callback observed the stored identity (never attacker-forged),
    // and the stored identity stays immutable regardless of what the
    // callback put into its own result object.
    expect(seen).toHaveLength(1);
    expect(seen[0].identity.objectId).toBe('entra-user-object-id-a');
    expect(seen[0].identity.tenantId).toBe(TENANT_ID);
    expect(seen[0].upstream.accessToken).toBe(UPSTREAM_TOKEN_A);
    // The renewal was committed before it became observable, so a second
    // ensure sees the fresh credential without renewing again (fresh now).
    const persistedAssociation = await bundle.ensureUpstreamEntraToken(
      tokenResponse.body.access_token
    );
    expect(persistedAssociation.accessToken).toBe('refreshed-upstream-token-value');
    expect(seen).toHaveLength(1);
  });

  it('serializes concurrent ensure calls through one per-family singleflight', async () => {
    let callbackCalls = 0;
    const bundle = createBundle({
      refreshUpstreamEntraToken: async ({ upstream }) => {
        callbackCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          accessToken: `refreshed-${upstream.accessToken}-value`,
          expiresAt: Math.floor(Date.now() / 1000) + 7200,
        };
      },
    });
    const app = appFor(bundle);
    const { tokenResponse } = await runPublicFlow(app, bundle, {
      entra: entraAssociation({ expiresAt: Math.floor(Date.now() / 1000) + 30 }),
    });
    const [first, second, third] = await Promise.all([
      bundle.ensureUpstreamEntraToken(tokenResponse.body.access_token),
      bundle.ensureUpstreamEntraToken(tokenResponse.body.access_token),
      bundle.ensureUpstreamEntraToken(tokenResponse.body.access_token),
    ]);
    expect(callbackCalls).toBe(1);
    expect(first.accessToken).toBe(`refreshed-${UPSTREAM_TOKEN_A}-value`);
    expect(second.accessToken).toBe(first.accessToken);
    expect(third.accessToken).toBe(first.accessToken);
  });

  it('fails closed when no callback exists and the upstream went stale: no fake refresh', async () => {
    const bundle = createBundle();
    const app = appFor(bundle);
    const { tokenResponse } = await runPublicFlow(app, bundle, {
      entra: entraAssociation({ expiresAt: Math.floor(Date.now() / 1000) + 1 }),
    });
    await new Promise((resolve) => setTimeout(resolve, 3100));
    expect(await bundle.ensureUpstreamEntraToken(tokenResponse.body.access_token)).toBeUndefined();
    // The refresh grant mints no MCP token on a stale upstream either.
    const stalled = await postRefresh(app, { refreshToken: tokenResponse.body.refresh_token });
    expect(stalled.status).toBe(400);
    expect(stalled.body.error).toBe('invalid_grant');
    expect(stalled.body.access_token).toBeUndefined();
  });

  it('treats the permanent re-auth sentinel from the callback as final and fails invalid_grant', async () => {
    const bundle = createBundle({
      refreshUpstreamEntraToken: async () => {
        const error = new Error('user must repeat the Microsoft sign-in');
        error.code = UPSTREAM_REAUTH_REQUIRED;
        throw error;
      },
    });
    const app = appFor(bundle);
    const { tokenResponse } = await runPublicFlow(app, bundle, {
      entra: entraAssociation({ expiresAt: Math.floor(Date.now() / 1000) + 30 }),
    });
    const stalled = await postRefresh(app, { refreshToken: tokenResponse.body.refresh_token });
    expect(stalled.status).toBe(400);
    expect(stalled.body.error).toBe('invalid_grant');
    expect(stalled.body.access_token).toBeUndefined();
    // The family state is intact for the documented recovery path.
    expect(await bundle.ensureUpstreamEntraToken(tokenResponse.body.access_token)).toBeUndefined();
  });

  it('surfaces callback failures as transient errors and leaves stored state untouched', async () => {
    let attempts = 0;
    const bundle = createBundle({
      refreshUpstreamEntraToken: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('synthetic transient network failure');
        }
        return {
          accessToken: 'recovered-upstream-token',
          expiresAt: Math.floor(Date.now() / 1000) + 7200,
        };
      },
    });
    const app = appFor(bundle);
    const { tokenResponse } = await runPublicFlow(app, bundle, {
      entra: entraAssociation({ expiresAt: Math.floor(Date.now() / 1000) + 30 }),
    });
    await expect(
      bundle.ensureUpstreamEntraToken(tokenResponse.body.access_token)
    ).rejects.toMatchObject({ code: ERROR_CODES.UPSTREAM_TRANSIENT });
    // Stored state untouched: the same refresh token still rotates after
    // the callback recovers, and the rotated family carries the renewed
    // upstream association.
    const rotated = await postRefresh(app, { refreshToken: tokenResponse.body.refresh_token });
    expect(rotated.status).toBe(200);
    const association = await bundle.ensureUpstreamEntraToken(rotated.body.access_token);
    expect(association.accessToken).toBe('recovered-upstream-token');
    expect(attempts).toBe(2);
  });

  it('preserves the optional upstream.refreshToken association field through to the callback', async () => {
    const seen = [];
    const bundle = createBundle({
      refreshUpstreamEntraToken: async ({ upstream }) => {
        seen.push(upstream);
        return {
          accessToken: 'refreshed-with-rt-token',
          expiresAt: Math.floor(Date.now() / 1000) + 7200,
        };
      },
    });
    const app = appFor(bundle);
    const verifier = randomVerifier();
    const authorizeResponse = await request(app)
      .get('/authorize')
      .query(authorizeQueryFor({ verifier }));
    const ref = extractRef(authorizeResponse.headers.location);
    const completed = bundle.completeAuthorizationAfterEntraSignIn({
      authorizationRef: ref,
      entra: entraAssociation({ expiresAt: Math.floor(Date.now() / 1000) + 30 }),
      upstream: { refreshToken: 'synthetic-upstream-refresh-credential' },
    });
    const issued = await postTokenExchange(app, {
      grant_type: 'authorization_code',
      code: extractParam(completed.redirectTo, 'code'),
      code_verifier: verifier,
      client_id: PUBLIC_CLIENT,
      redirect_uri: PUBLIC_REDIRECT,
    });
    expect(issued.status).toBe(200);
    await bundle.ensureUpstreamEntraToken(issued.body.access_token);
    expect(seen).toHaveLength(1);
    expect(seen[0].refreshToken).toBe('synthetic-upstream-refresh-credential');
    // Strict property validation still rejects unknown association keys.
    const freshAuthorize = await request(app)
      .get('/authorize')
      .query(authorizeQueryFor({ verifier: randomVerifier() }));
    const freshRef = extractRef(freshAuthorize.headers.location);
    expect(() =>
      bundle.completeAuthorizationAfterEntraSignIn({
        authorizationRef: freshRef,
        entra: entraAssociation(),
        upstream: { refreshToken: 'x', extraField: 'nope' },
      })
    ).toThrow(/unexpected/i);
  });
});

describe('R7 T19 seam-gap closures (upstream rotation persistence, permanent revocation, singleflight sharing, rotation races)', () => {
  it('persists a rotated upstream refreshToken from the callback and presents the rotated credential at the next renewal', async () => {
    const seen = [];
    const RT_V1 = 'synthetic-upstream-refresh-credential-v1';
    const RT_V2 = 'synthetic-upstream-refresh-credential-rotated-v2';
    const bundle = createBundle({
      refreshUpstreamEntraToken: async ({ upstream }) => {
        seen.push(upstream);
        return {
          accessToken: `renewed-access-${seen.length}`,
          // Stays inside the 5-minute renewal window so the next ensure runs
          // the callback again and proves the rotated credential propagates.
          expiresAt: Math.floor(Date.now() / 1000) + 240,
          refreshToken: upstream.refreshToken === RT_V1 ? RT_V2 : undefined,
        };
      },
    });
    const app = appFor(bundle);
    const verifier = randomVerifier();
    const authorizeResponse = await request(app)
      .get('/authorize')
      .query(authorizeQueryFor({ verifier }));
    const ref = extractRef(authorizeResponse.headers.location);
    const completed = bundle.completeAuthorizationAfterEntraSignIn({
      authorizationRef: ref,
      entra: entraAssociation({ expiresAt: Math.floor(Date.now() / 1000) + 30 }),
      upstream: { refreshToken: RT_V1 },
    });
    const issued = await postTokenExchange(app, {
      grant_type: 'authorization_code',
      code: extractParam(completed.redirectTo, 'code'),
      code_verifier: verifier,
      client_id: PUBLIC_CLIENT,
      redirect_uri: PUBLIC_REDIRECT,
    });
    expect(issued.status).toBe(200);
    await bundle.ensureUpstreamEntraToken(issued.body.access_token);
    expect(seen[0].refreshToken).toBe(RT_V1);
    await bundle.ensureUpstreamEntraToken(issued.body.access_token);
    expect(seen[1].refreshToken).toBe(RT_V2);

    // A renewal result without a refresh credential keeps the previously
    // stored rotation (never drops the granted refresh capability).
    const bundleKeepOld = createBundle({
      refreshUpstreamEntraToken: async ({ upstream }) => {
        seen.push(upstream);
        return {
          accessToken: 'renewed-access-keep-old',
          expiresAt: Math.floor(Date.now() / 1000) + 7200,
        };
      },
    });
    const appKeepOld = appFor(bundleKeepOld);
    const verifierKeepOld = randomVerifier();
    const authorizeKeepOld = await request(appKeepOld)
      .get('/authorize')
      .query(authorizeQueryFor({ verifier: verifierKeepOld }));
    const refKeepOld = extractRef(authorizeKeepOld.headers.location);
    const completedKeepOld = bundleKeepOld.completeAuthorizationAfterEntraSignIn({
      authorizationRef: refKeepOld,
      entra: entraAssociation({ expiresAt: Math.floor(Date.now() / 1000) + 30 }),
      upstream: { refreshToken: RT_V1 },
    });
    const issuedKeepOld = await postTokenExchange(appKeepOld, {
      grant_type: 'authorization_code',
      code: extractParam(completedKeepOld.redirectTo, 'code'),
      code_verifier: verifierKeepOld,
      client_id: PUBLIC_CLIENT,
      redirect_uri: PUBLIC_REDIRECT,
    });
    await bundleKeepOld.ensureUpstreamEntraToken(issuedKeepOld.body.access_token);
    await bundleKeepOld.ensureUpstreamEntraToken(issuedKeepOld.body.access_token);
    expect(seen[seen.length - 1].refreshToken).toBe(RT_V1);
  });

  it('persists the permanent re-auth condition: the family stays revoked after the failure, never a stale success', async () => {
    const seen = [];
    const dir = makeStoreDir('permanent-revocation');
    const store = makeStore(dir);
    const bundle = createBundle({
      persistentStore: store,
      refreshUpstreamEntraToken: async () => {
        seen.push(1);
        const error = new Error('the user must repeat the Microsoft sign-in');
        error.code = UPSTREAM_REAUTH_REQUIRED;
        throw error;
      },
    });
    const app = appFor(bundle);
    const verifier = randomVerifier();
    const authorizeResponse = await request(app)
      .get('/authorize')
      .query(authorizeQueryFor({ verifier }));
    const ref = extractRef(authorizeResponse.headers.location);
    const completed = bundle.completeAuthorizationAfterEntraSignIn({
      authorizationRef: ref,
      entra: entraAssociation({ expiresAt: Math.floor(Date.now() / 1000) + 30 }),
      upstream: { refreshToken: 'synthetic-upstream-refresh-credential' },
    });
    const issued = await postTokenExchange(app, {
      grant_type: 'authorization_code',
      code: extractParam(completed.redirectTo, 'code'),
      code_verifier: verifier,
      client_id: PUBLIC_CLIENT,
      redirect_uri: PUBLIC_REDIRECT,
    });
    expect(issued.status).toBe(200);

    const stalled = await postRefresh(app, { refreshToken: issued.body.refresh_token });
    expect(stalled.status).toBe(400);
    expect(stalled.body.error).toBe('invalid_grant');
    expect(seen).toHaveLength(1);

    // A concurrent follower shares the leader's permanent outcome: no stale
    // upstream success and no resurrection once the inflight completed.
    await expect(
      providerRefresh(bundle, issued.body.refresh_token, { clientId: PUBLIC_CLIENT })
    ).rejects.toMatchObject({ name: 'InvalidGrantError' });

    // The revocation is persisted (family-level only, others untouched):
    // a fresh provider on the same store sees no live family for these
    // credentials and answers invalid_grant, never a minted token.
    const revived = createBundle({ persistentStore: makeStore(dir) });
    await expect(
      providerRefresh(revived, issued.body.refresh_token, { clientId: PUBLIC_CLIENT })
    ).rejects.toMatchObject({ name: 'InvalidGrantError' });
    // The MCP access token issued before the permanent failure is dead too.
    expect(() => revived.provider.verifyAccessToken(issued.body.access_token)).toThrow();
  });

  it('shares a transient leader failure with every concurrent follower, then recovers', async () => {
    let attempts = 0;
    const bundle = createBundle({
      refreshUpstreamEntraToken: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('synthetic transient failure');
        }
        return {
          accessToken: `renewed-after-${attempts}`,
          expiresAt: Math.floor(Date.now() / 1000) + 7200,
        };
      },
    });
    const app = appFor(bundle);
    const { tokenResponse } = await runPublicFlow(app, bundle, {
      entra: entraAssociation({ expiresAt: Math.floor(Date.now() / 1000) + 30 }),
    });
    await expect(
      Promise.all([
        bundle.ensureUpstreamEntraToken(tokenResponse.body.access_token),
        bundle.ensureUpstreamEntraToken(tokenResponse.body.access_token),
        bundle.ensureUpstreamEntraToken(tokenResponse.body.access_token),
      ])
    ).rejects.toMatchObject({ code: ERROR_CODES.UPSTREAM_TRANSIENT });
    expect(attempts).toBe(1);

    // Recovery: the next renewal attempt succeeds and no stale expired
    // upstream association is ever returned.
    const association = await bundle.ensureUpstreamEntraToken(tokenResponse.body.access_token);
    expect(association.accessToken).toBe('renewed-after-2');
  });

  it('rejects a refresh TTL above the tightened bounded cap (365 days)', () => {
    expect(() => createBundle({ refreshTokenTtlSeconds: 10 * 365 * 24 * 60 * 60 })).toThrow(
      /refreshTokenTtlSeconds/i
    );
    expect(() => createBundle({ refreshTokenTtlSeconds: 365 * 24 * 60 * 60 })).not.toThrow();
  });

  it('never mints two valid rotations for one refresh token presented twice concurrently', async () => {
    const bundle = createBundle({
      refreshUpstreamEntraToken: async () => ({
        accessToken: 'renewed-through-singleflight',
        expiresAt: Math.floor(Date.now() / 1000) + 7200,
      }),
    });
    const app = appFor(bundle);
    const { tokenResponse } = await runPublicFlow(app, bundle, {
      entra: entraAssociation({ expiresAt: Math.floor(Date.now() / 1000) + 30 }),
    });
    const presented = tokenResponse.body.refresh_token;
    const [first, second] = await Promise.allSettled([
      providerRefresh(bundle, presented),
      providerRefresh(bundle, presented),
    ]);

    // Exactly one of the two concurrent presentations mints a credential;
    // the replay presentation of the consumed token never yields a second
    // still-valid rotation (and per the replay rule the family revokes).
    const successes = [first, second].filter((outcome) => outcome.status === 'fulfilled');
    expect(successes).toHaveLength(1);
    const rotations = successes.map((outcome) => outcome.value);
    expect(rotations[0].access_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The replay discipline applies: the family was revoked, so the token
    // minted by the winning rotation no longer verifies (revocation).
    expect(() => bundle.provider.verifyAccessToken(rotations[0].access_token)).toThrow();
    const rejected = [first, second].find((outcome) => outcome.status === 'rejected');
    expect(rejected.reason).toMatchObject({ name: 'InvalidGrantError' });
  });
});
