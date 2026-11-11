'use strict';

/**
 * T20 (S4-S6, S11) bridge persistence smoke: only the public provider API
 * (clientsStore.getClient, provider.authorize, completeAuthorizationAfter
 * EntraSignIn, exchangeAuthorizationCode, exchangeRefreshToken,
 * verifyAccessToken) plus createBridgeStore.
 *
 * Synthetic credentials only: no environment/tenant/Graph/token reads, no
 * network, and no token, key, or ciphertext printed. stdout carries only
 * `PASS: <check>` lines; any failure prints one `FAIL: <check>` line and
 * exits 1. Two disposable processes share the same isolated volume:
 *   node test/docker/bridge-persistence-smoke.js issue \
 *     --store-dir /app/data/oauth --fixture-dir /app/data/smoke-fixture
 *   node test/docker/bridge-persistence-smoke.js resume \
 *     --store-dir /app/data/oauth --fixture-dir /app/data/smoke-fixture
 */

const crypto = require('node:crypto');
const { createBridgeStore } = require('../../remote/bridge-store');
const { createMCPOAuthProvider } = require('../../remote/oauth-provider');

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const RESOURCE = 'https://mcp-smoke.internal/mcp';
const CLIENT_ID = 'smoke-confidential-client';
const CLIENT_SECRET = 'smoke-synthetic-client-secret';
const REDIRECT_URI = 'https://client-smoke.internal/oauth/callback';
const DEPLOYMENT_ID = `${RESOURCE}|${TENANT_ID}|${CLIENT_ID}`;
const FIXTURE_DEPLOYMENT_ID = 'bridge-persistence-smoke-fixture';
const USER_A = {
  oid: 'smoke-user-oid-a',
  username: 'user-a',
  upstreamRefresh: 'synthetic-upstream-refresh-a',
};

function fail(name) {
  console.error(`FAIL: ${name}`);
  process.exit(1);
}

function pass(name) {
  console.log(`PASS: ${name}`);
}

function check(condition, name) {
  if (!condition) fail(name);
}

/** Provider bound to the dedicated synthetic store at `storeDir`. */
function providerBundleFor(storeDir) {
  return createMCPOAuthProvider({
    issuerUrl: 'https://mcp-smoke.internal',
    signInUrl: 'https://mcp-smoke.internal/signin',
    supportedScopes: ['mcp'],
    resourceServerUrl: RESOURCE,
    clients: [{ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUris: [REDIRECT_URI] }],
    persistentStore: createBridgeStore({ directory: storeDir, deploymentId: DEPLOYMENT_ID }),
    rateLimit: false,
  });
}

/** One full sign-in through the public provider API (the test-control fixture). */
function fixtureStore(fixtureDir) {
  return createBridgeStore({ directory: fixtureDir, deploymentId: FIXTURE_DEPLOYMENT_ID });
}

async function signIn(bundle, user) {
  const client = bundle.clientsStore.getClient(CLIENT_ID);
  check(client, 'registered-client-lookup');
  const verifier = crypto.randomBytes(32).toString('base64url');
  let location = null;
  await bundle.provider.authorize(
    client,
    {
      redirectUri: REDIRECT_URI,
      codeChallenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
      scopes: ['mcp'],
      state: 'smoke-state',
      resource: new URL(RESOURCE),
    },
    {
      redirect: (_status, href) => {
        location = href;
      },
    }
  );
  const ref = location && new URL(location).searchParams.get('mcp_authorization');
  check(ref, 'authorization-reference-issued');
  const { redirectTo } = bundle.completeAuthorizationAfterEntraSignIn({
    authorizationRef: ref,
    entra: {
      accessToken: `synthetic-upstream-${user.oid}`,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      objectId: user.oid,
      tenantId: TENANT_ID,
      username: user.username,
    },
    upstream: { refreshToken: user.upstreamRefresh },
  });
  const code = redirectTo && new URL(redirectTo).searchParams.get('code');
  check(code, 'authorization-code-issued');
  const tokens = bundle.provider.exchangeAuthorizationCode(
    client,
    code,
    verifier,
    REDIRECT_URI,
    new URL(RESOURCE)
  );
  check(tokens.access_token && tokens.refresh_token, 'token-endpoint-issued-mcp-pair');
  const verified = bundle.provider.verifyAccessToken(tokens.access_token).extra;
  check(verified.userId === user.oid, 'access-token-bound-to-signing-in-user');
  return tokens;
}

/**
 * Direct provider-API refresh — the exact public path the SDK token
 * handler calls. Returns {errorCode} instead of throwing on rejection.
 */
async function refresh(bundle, refreshToken) {
  try {
    return await bundle.provider.exchangeRefreshToken(
      { client_id: CLIENT_ID },
      refreshToken,
      ['mcp'],
      new URL(RESOURCE)
    );
  } catch (error) {
    return { errorCode: error && error.errorCode };
  }
}

async function issuePhase(storeDir, fixtureDir) {
  const bundle = providerBundleFor(storeDir);
  try {
    const tokens = await signIn(bundle, USER_A);
    const fixture = fixtureStore(fixtureDir);
    fixture.load(); // required commit precondition of the store contract
    fixture.commit({ userARefresh: tokens.refresh_token, userAAccess: tokens.access_token });
    fixture.close();
    pass('issue: MCP tokens issued through the public provider API and verified');
  } finally {
    bundle.close();
  }
}

async function resumePhase(storeDir, fixtureDir) {
  const bundle = providerBundleFor(storeDir);
  try {
    const fixture = fixtureStore(fixtureDir);
    const persisted = fixture.load();
    fixture.close();
    check(persisted.exists, 'fixture-persisted');
    check(bundle.clientsStore.getClient(CLIENT_ID), 'registered-client-lookup');
    const rotated = await refresh(bundle, persisted.snapshot.userARefresh);
    check(rotated.access_token && rotated.refresh_token, 'refresh-rotates-after-restart');
    const renewed = bundle.provider.verifyAccessToken(rotated.access_token).extra;
    check(renewed.userId === USER_A.oid, 'renewed-access-token-accepted');
    const original = bundle.provider.verifyAccessToken(persisted.snapshot.userAAccess).extra;
    check(original.userId === USER_A.oid, 'access-token-accepted-after-restart');
    pass('resume: persisted family rotated; both MCP tokens accepted after restart');
  } finally {
    bundle.close();
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const phase = argv.shift();
  const storeDir = argv[argv.indexOf('--store-dir') + 1];
  const fixtureDir = argv[argv.indexOf('--fixture-dir') + 1] || `${storeDir}fixture`;
  if (phase === 'issue') await issuePhase(storeDir, fixtureDir);
  else if (phase === 'resume') await resumePhase(storeDir, fixtureDir);
  else fail('usage: issue|resume --store-dir <dir> [--fixture-dir <dir>]');
}

main().catch((error) => {
  // Safe classification only: error class and code — never token material,
  // messages, or paths.
  console.error(
    `FAIL: unexpected-${(error && (error.errorCode || error.code || error.name)) || 'Unknown'}`
  );
  process.exit(1);
});
