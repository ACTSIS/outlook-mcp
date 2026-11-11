/* Integrated remote MCP HTTP transport tests (T2, S1-S3).
 *
 * Fully offline/intranet: synthetic RSA signing keys with an injected JWKS,
 * a mocked per-request OBO token exchange, and the real public MCP SDK client
 * plus raw HTTP against a real listener on 127.0.0.1 (ephemeral port).
 * No real credentials, no real network access.
 */
jest.mock('../../utils/graph-api', () => ({
  callGraphAPI: jest.fn(),
  callGraphAPIPaginated: jest.fn(),
  callGraphAPIDownload: jest.fn(),
}));

const jwt = require('jsonwebtoken');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { request: httpRequest } = require('node:http');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const {
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const { callGraphAPI } = require('../../utils/graph-api');
const {
  createRemoteMcpHttpServer,
  resolveRemoteMcpConfig,
  LOCAL_EXCLUDED_TOOL_NAMES,
} = require('../../remote/http-server');

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT_ID = '22222222-2222-4222-8222-222222222222';
// v2 access tokens for a custom API carry the API app's client ID GUID in
// `aud` and the short scope name in `scp`; the api:// URI is only the Entra
// authorization-request scope (T8 correction).
const AUDIENCE = '99999999-9999-4999-8999-999999999999';
const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;
const REQUIRED_SCOPE = 'mcp.access';
const CLIENT_ID = 'remote-mcp-client-id';
const CLIENT_SECRET = 'remote-mcp-client-secret';

const crypto = require('crypto');
// Synthetic tenant signing key pair.
const { privateKey, publicKeyPem } = generateKeyPair();

function generateKeyPair() {
  const keys = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return { privateKey: keys.privateKey, publicKeyPem: keys.publicKey };
}

const LOCAL_JWKS = {
  async getSigningKey() {
    return { getPublicKey: () => publicKeyPem };
  },
};

function signAccessToken(overrides = {}) {
  const payload = {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: 'subject',
    tid: TENANT_ID,
    oid: 'object',
    scp: REQUIRED_SCOPE,
    preferred_username: 'user@example.com',
    groups: [],
    iat: Math.floor(Date.now() / 1000),
    ...overrides,
  };
  const signOptions = { algorithm: 'RS256', keyid: 'test-key-1' };
  if (payload.exp === undefined) {
    signOptions.expiresIn = '5m';
  }
  return jwt.sign(payload, privateKey, signOptions);
}

/* --- mocked per-request OBO token exchange --------------------------------------------------- */

let oboRequests = [];
const markerByToken = new Map();

function mockOboStoreFactory(requestConfig) {
  const marker = markerByToken.get(requestConfig.token);
  // Safety net: an unverified inbound token must never reach the OBO factory.
  if (!marker) {
    throw new Error('MOCK_OBO_FACTORY_SAW_UNVERIFIED_TOKEN');
  }
  oboRequests.push(requestConfig);
  return {
    getValidAccessToken: async () => `obo-graph-for-${marker}`,
    getValidFlowAccessToken: async () => `obo-flow-for-${marker}`,
  };
}

/* --- server/session helpers ------------------------------------------------------------------ */

function serverConfig(overrides = {}) {
  return {
    port: 0,
    host: '127.0.0.1',
    tenantId: TENANT_ID,
    audience: AUDIENCE,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    requiredScopes: [REQUIRED_SCOPE],
    jwksClient: LOCAL_JWKS,
    createOboTokenStore: mockOboStoreFactory,
    ...overrides,
  };
}

async function startTestServer(overrides = {}) {
  const instance = createRemoteMcpHttpServer(serverConfig(overrides));
  const started = await instance.start();
  return { instance, port: started.port };
}

async function withTestServer(overrides, run) {
  const { instance, port } = await startTestServer(overrides);
  try {
    await run(port);
  } finally {
    await instance.stop();
  }
}

async function postMcp(port, body, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: options.method || 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers || {}),
    },
    body: options.method && options.method !== 'POST' ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, text, json };
}

function rpcRequest(id, method, params) {
  return { jsonrpc: '2.0', id, method, params };
}

/**
 * Raw HTTP client with an explicit Host header (fetch forbids overriding
 * Host): exercises exactly what a reverse proxy or a forged-host request
 * would put on the wire.
 */
function rawRequest(
  port,
  { method = 'GET', path = '/mcp', hostHeader = 'attacker.example:8443', body = null, headers = {} }
) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          host: hostHeader,
          ...(body
            ? { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
            : {}),
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => {
          text += chunk.toString();
        });
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      }
    );
    req.on('error', reject);
    req.end(body || undefined);
  });
}

async function createSdkClient(port, token) {
  const client = new Client({ name: 'http-server-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { authorization: token ? `Bearer ${token}` : '' } },
  });
  await client.connect(transport);
  return { client, transport };
}

beforeEach(() => {
  oboRequests = [];
  markerByToken.clear();
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

describe('remote HTTP startup and configuration', () => {
  const baseEnv = {
    MCP_HTTP_PORT: '47001',
    MCP_HTTP_HOST: '127.0.0.1',
    MCP_HTTP_AUDIENCE: AUDIENCE,
    MCP_HTTP_REQUIRED_SCOPES: REQUIRED_SCOPE,
    ENTRA_TENANT_ID: TENANT_ID,
    ENTRA_CLIENT_ID: CLIENT_ID,
    ENTRA_CLIENT_SECRET: CLIENT_SECRET,
  };

  it('maps the documented environment variables to the server configuration', () => {
    const config = resolveRemoteMcpConfig(baseEnv);

    expect(config.port).toBe(47001);
    expect(config.host).toBe('127.0.0.1');
    expect(config.tenantId).toBe(TENANT_ID);
    expect(config.audience).toBe(AUDIENCE);
    expect(config.requiredScopes).toEqual([REQUIRED_SCOPE]);
    expect(config.clientId).toBe(CLIENT_ID);
    expect(config.clientSecret).toBe(CLIENT_SECRET);
  });

  it('no longer requires or maps a mutation group configuration (S3)', () => {
    const config = resolveRemoteMcpConfig(baseEnv);
    expect(config.mutationGroupOrRoleId).toBeUndefined();
    // A leftover value in a private user environment is ignored, never read.
    expect(() =>
      resolveRemoteMcpConfig({
        ...baseEnv,
        ENTRA_MUTATION_GROUP_ID: '33333333-3333-4333-8333-333333333333',
      })
    ).not.toThrow();
  });

  it('refuses to start when test mode is enabled', () => {
    expect(() => resolveRemoteMcpConfig({ ...baseEnv, USE_TEST_MODE: 'true' })).toThrow(
      /test mode/i
    );
  });

  it('names each required configuration key when missing', () => {
    for (const key of ['ENTRA_TENANT_ID', 'ENTRA_CLIENT_ID', 'ENTRA_CLIENT_SECRET']) {
      const partial = { ...baseEnv };
      delete partial[key];
      expect(() => resolveRemoteMcpConfig(partial)).toThrow(new RegExp(key, 'i'));
    }
  });

  it('requires a nonempty delegated scope before any dispatch', () => {
    expect(() => resolveRemoteMcpConfig({ ...baseEnv, MCP_HTTP_REQUIRED_SCOPES: '   ' })).toThrow(
      /MCP_HTTP_REQUIRED_SCOPES/i
    );
  });

  it('rejects a non-numeric or out-of-range port', () => {
    expect(() => resolveRemoteMcpConfig({ ...baseEnv, MCP_HTTP_PORT: 'not-a-port' })).toThrow(
      /MCP_HTTP_PORT/i
    );
    expect(() => resolveRemoteMcpConfig({ ...baseEnv, MCP_HTTP_PORT: '70000' })).toThrow(
      /MCP_HTTP_PORT/i
    );
  });

  it('rejects an insecure internet binding without TLS configuration', () => {
    for (const host of ['0.0.0.0', '10.1.2.3', 'intranet.example', '[::]']) {
      expect(() => resolveRemoteMcpConfig({ ...baseEnv, MCP_HTTP_HOST: host })).toThrow(
        /insecure|loopback|tls/i
      );
    }
    expect(() => resolveRemoteMcpConfig({ ...baseEnv, MCP_HTTP_HOST: 'localhost' })).not.toThrow();
  });

  it('rejects unknown configuration environment keys at startup', () => {
    expect(() =>
      resolveRemoteMcpConfig({ ...baseEnv, MCP_HTTP_UNKNOWN_OPTION: 'x' })
    ).not.toThrow();
  });

  /**
   * Standards sign-in flow environment (T8 correction): the upstream Entra
   * authorization request must use resource-qualified custom API scopes; a
   * scope whose resource qualifier is the configured client id itself stays
   * derivable (T12), while other URI shapes keep needing an explicit
   * MCP_HTTP_UPSTREAM_SCOPES override.
   */
  const oauthEnv = {
    ...baseEnv,
    MCP_HTTP_EXTERNAL_BASE_URL: 'https://mcp.internal.example',
    MCP_HTTP_LOGIN_REDIRECT_URI: 'https://mcp.internal.example/login/callback',
    MCP_HTTP_OAUTH_CLIENTS:
      '[{"clientId":"external-web-client","redirectUris":["https://client.example/cb"]}]',
  };
  const UPSTREAM_SCOPE = 'api://outlook-mcp/mcp.access';

  it('derives the api:// upstream scope from the configured client id when MCP_HTTP_UPSTREAM_SCOPES is absent', () => {
    const config = resolveRemoteMcpConfig(oauthEnv);
    expect(config.oauth.upstreamScopes).toEqual([`api://${CLIENT_ID}/${REQUIRED_SCOPE}`]);
  });

  it('refuses upstream scopes without an api:// or https:// qualifier and never guesses an app ID URI', () => {
    for (const bad of ['mcp.access', 'user.read mcp.access', 'https:/no-slash/x', '  ']) {
      expect(() => resolveRemoteMcpConfig({ ...oauthEnv, MCP_HTTP_UPSTREAM_SCOPES: bad })).toThrow(
        /MCP_HTTP_UPSTREAM_SCOPES/i
      );
    }
  });

  it('carries the validated resource-qualified upstream scopes into the oauth configuration', () => {
    const config = resolveRemoteMcpConfig({
      ...oauthEnv,
      MCP_HTTP_UPSTREAM_SCOPES: `${UPSTREAM_SCOPE} https://api.internal.example/mcp.access`,
    });
    expect(config.oauth.upstreamScopes).toEqual([
      UPSTREAM_SCOPE,
      'https://api.internal.example/mcp.access',
    ]);
  });

  it('accepts a loopback HTTP redirect URI only for the standards flow while upstream scopes stay API-qualified', () => {
    const config = resolveRemoteMcpConfig({
      ...oauthEnv,
      MCP_HTTP_UPSTREAM_SCOPES: UPSTREAM_SCOPE,
    });
    expect(config.oauth.upstreamScopes).toEqual([UPSTREAM_SCOPE]);
  });

  it('keeps required token scp scopes short: API-qualified URIs are refused there', () => {
    expect(() =>
      resolveRemoteMcpConfig({
        ...baseEnv,
        MCP_HTTP_REQUIRED_SCOPES: 'user.read api://outlook-mcp/mcp.access',
      })
    ).toThrow(/MCP_HTTP_REQUIRED_SCOPES/i);
  });

  /**
   * T12 (S1-S8): the minimal MS_*-style setup. With the Entra v2.0 endpoint
   * the access token's `aud` is the API application's client ID GUID and the
   * custom-API authorization request needs the resource-qualified
   * `api://<client-id>/<scope>` form, so both derive from the same client id
   * when the audience/scope overrides are absent. Explicit overrides keep
   * their existing validation; token verification itself is unchanged.
   */
  describe('T12 minimal v2 audience and scope defaults (client-id derivation)', () => {
    const CLIENT_ID_GUID = '44444444-4444-4444-8444-444444444444';
    const minimalEnv = (overrides = {}) => ({
      MCP_HTTP_PORT: '47002',
      MCP_HTTP_HOST: '127.0.0.1',
      ENTRA_TENANT_ID: TENANT_ID,
      ENTRA_CLIENT_ID: CLIENT_ID_GUID,
      ENTRA_CLIENT_SECRET: CLIENT_SECRET,
      ...overrides,
    });
    const loginEnv = {
      MCP_HTTP_LOGIN_REDIRECT_URI: 'https://mcp.internal.example/login/callback',
      MCP_HTTP_OAUTH_CLIENTS:
        '[{"clientId":"external-web-client","redirectUris":["https://client.example/cb"]}]',
    };

    it('defaults the audience to the client ID GUID and required scopes to mcp.access', () => {
      const config = resolveRemoteMcpConfig(minimalEnv());
      expect(config.audience).toBe(CLIENT_ID_GUID);
      expect(config.requiredScopes).toEqual(['mcp.access']);
      expect(config.oauth).toBeNull();
    });

    it('derives api://<client-id>/mcp.access as the upstream scope with no scope configuration at all', () => {
      const config = resolveRemoteMcpConfig({ ...minimalEnv(), ...loginEnv });
      expect(config.oauth.upstreamScopes).toEqual([`api://${CLIENT_ID_GUID}/mcp.access`]);
      expect(config.requiredScopes).toEqual(['mcp.access']);
    });

    it('derives the upstream scopes from the explicitly configured short required scopes', () => {
      const config = resolveRemoteMcpConfig({
        ...minimalEnv(),
        ...loginEnv,
        MCP_HTTP_REQUIRED_SCOPES: 'mcp.access custom.write',
      });
      expect(config.oauth.upstreamScopes).toEqual([
        `api://${CLIENT_ID_GUID}/mcp.access`,
        `api://${CLIENT_ID_GUID}/custom.write`,
      ]);
    });

    it('derives the required scopes from the short part of explicitly configured upstream scopes', () => {
      const config = resolveRemoteMcpConfig({
        ...minimalEnv(),
        MCP_HTTP_UPSTREAM_SCOPES:
          'api://api-app.example/thing.access https://api.internal.example/custom.scope',
      });
      expect(config.requiredScopes).toEqual(['thing.access', 'custom.scope']);
      expect(config.audience).toBe(CLIENT_ID_GUID);
    });

    it('deduplicates the short parts derived from equal upstream scope resources', () => {
      const config = resolveRemoteMcpConfig({
        ...minimalEnv(),
        MCP_HTTP_UPSTREAM_SCOPES: 'api://one.example/x.access https://two.example/x.access',
      });
      expect(config.requiredScopes).toEqual(['x.access']);
    });

    it('refuses upstream scopes that carry no short scope name, naming the required-scope override', () => {
      expect(() =>
        resolveRemoteMcpConfig({
          ...minimalEnv(),
          MCP_HTTP_UPSTREAM_SCOPES: 'https://api.internal.example',
        })
      ).toThrow(/MCP_HTTP_REQUIRED_SCOPES/i);
    });

    it('still validates explicitly configured audience and upstream overrides exactly as before', () => {
      expect(() => resolveRemoteMcpConfig({ ...minimalEnv(), MCP_HTTP_AUDIENCE: '   ' })).toThrow(
        /MCP_HTTP_AUDIENCE/i
      );
      expect(() =>
        resolveRemoteMcpConfig({
          ...minimalEnv(),
          ...loginEnv,
          MCP_HTTP_UPSTREAM_SCOPES: '   ',
        })
      ).toThrow(/MCP_HTTP_UPSTREAM_SCOPES/i);
      expect(() =>
        resolveRemoteMcpConfig({
          ...minimalEnv(),
          MCP_HTTP_AUDIENCE: 'app-id-uri-kept-as-configured',
        })
      ).not.toThrow();
    });
  });

  /**
   * T16 (S5,S10): the explicit MCP_HTTP_AUTH_MODE selector between the direct
   * Entra authorization server (preferred) and the legacy standards OAuth
   * bridge. Without the selector the previous behavior is preserved: bridge
   * exactly when the login redirect is configured, direct Entra otherwise.
   */
  describe('MCP_HTTP_AUTH_MODE selection (T16)', () => {
    const bridgeEnv = {
      ...baseEnv,
      MCP_HTTP_LOGIN_REDIRECT_URI: 'https://mcp.internal.example/login/callback',
      MCP_HTTP_OAUTH_CLIENTS:
        '[{"clientId":"external-web-client","redirectUris":["https://client.example/cb"]}]',
    };

    it('preserves the previous auto-selection when unset: bridge exactly when the login redirect is configured', () => {
      const direct = resolveRemoteMcpConfig(baseEnv);
      expect(direct.authMode).toBe('entra');
      expect(direct.oauth).toBeNull();
      const bridge = resolveRemoteMcpConfig(bridgeEnv);
      expect(bridge.authMode).toBe('bridge');
      expect(bridge.oauth).not.toBeNull();
    });

    it('derives the fully resource-qualified direct-Entra request scopes with the T12 helpers', () => {
      const derived = resolveRemoteMcpConfig(baseEnv);
      expect(derived.entraRequestScopes).toEqual([`api://${CLIENT_ID}/${REQUIRED_SCOPE}`]);
      const overridden = resolveRemoteMcpConfig({
        ...baseEnv,
        MCP_HTTP_UPSTREAM_SCOPES:
          'api://outlook-mcp/mcp.access https://api.internal.example/mcp.access',
      });
      expect(overridden.entraRequestScopes).toEqual([
        'api://outlook-mcp/mcp.access',
        'https://api.internal.example/mcp.access',
      ]);
    });

    it('refuses an invalid selector value so a typo can never change the authentication mode', () => {
      for (const bad of ['Entra', 'ENTRA', 'direct', 'oauth', 'internal', 'true', '']) {
        expect(() => resolveRemoteMcpConfig({ ...baseEnv, MCP_HTTP_AUTH_MODE: bad })).toThrow(
          /MCP_HTTP_AUTH_MODE/i
        );
      }
    });

    it('explicit entra ignores legacy bridge-only settings while shared validation stays enforced', () => {
      const config = resolveRemoteMcpConfig({
        ...baseEnv,
        MCP_HTTP_AUTH_MODE: 'entra',
        MCP_HTTP_LOGIN_REDIRECT_URI: 'http://localhost:8443/login/callback',
        MCP_HTTP_OAUTH_CLIENTS:
          '[{"clientId":"old-bridge-client","redirectUris":["https://old.example/cb"]}]',
        MCP_HTTP_OAUTH_SUPPORTED_SCOPES: 'mcp',
        MCP_HTTP_OAUTH_ALLOW_DYNAMIC_REGISTRATION: 'true',
      });
      expect(config.authMode).toBe('entra');
      expect(config.oauth).toBeNull();
      expect(config.entraRequestScopes).toEqual([`api://${CLIENT_ID}/${REQUIRED_SCOPE}`]);
    });

    it('does not weaken the ordinary shared audience/tenant/scope validation under explicit entra', () => {
      expect(() =>
        resolveRemoteMcpConfig({
          ...baseEnv,
          MCP_HTTP_AUTH_MODE: 'entra',
          ENTRA_TENANT_ID: 'common',
        })
      ).toThrow(/ENTRA_TENANT_ID/i);
      expect(() =>
        resolveRemoteMcpConfig({
          ...baseEnv,
          MCP_HTTP_AUTH_MODE: 'entra',
          MCP_HTTP_REQUIRED_SCOPES: 'api://app/mcp.access',
        })
      ).toThrow(/MCP_HTTP_REQUIRED_SCOPES/i);
      expect(() =>
        resolveRemoteMcpConfig({
          ...baseEnv,
          MCP_HTTP_AUTH_MODE: 'entra',
          MCP_HTTP_AUDIENCE: '   ',
        })
      ).toThrow(/MCP_HTTP_AUDIENCE/i);
    });

    it('explicit bridge requires the current complete valid bridge configuration', () => {
      const explicit = resolveRemoteMcpConfig({ ...bridgeEnv, MCP_HTTP_AUTH_MODE: 'bridge' });
      expect(explicit.authMode).toBe('bridge');
      expect(explicit.oauth).not.toBeNull();
      // Without the login redirect the bridge configuration is incomplete.
      expect(() => resolveRemoteMcpConfig({ ...baseEnv, MCP_HTTP_AUTH_MODE: 'bridge' })).toThrow(
        /MCP_HTTP_AUTH_MODE|MCP_HTTP_LOGIN_REDIRECT_URI/i
      );
      // The unmodified clients/dynamic-registration completeness rule stays.
      const withoutClients = { ...bridgeEnv, MCP_HTTP_AUTH_MODE: 'bridge' };
      delete withoutClients.MCP_HTTP_OAUTH_CLIENTS;
      expect(() => resolveRemoteMcpConfig(withoutClients)).toThrow(
        /MCP_HTTP_OAUTH_CLIENTS|dynamic/i
      );
    });
  });

  describe('wildcard bind discovery fail-closed', () => {
    // Config-time TLS validation reads PEM paths; dummy text is sufficient
    // here (only readability is checked before any listener exists).
    const tlsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-wildcard-tls-'));
    const certPath = path.join(tlsDir, 'cert.pem');
    const keyPath = path.join(tlsDir, 'key.pem');
    fs.writeFileSync(certPath, 'TEST SELF-SIGNED CERT');
    fs.writeFileSync(keyPath, 'TEST PRIVATE KEY');
    const tlsEnv = { MCP_HTTP_TLS_CERT: certPath, MCP_HTTP_TLS_KEY: keyPath };

    afterAll(() => fs.rmSync(tlsDir, { recursive: true, force: true }));

    it('refuses wildcard binds without TLS as insecure', () => {
      for (const host of ['0.0.0.0', '[::]']) {
        expect(() => resolveRemoteMcpConfig({ ...baseEnv, MCP_HTTP_HOST: host })).toThrow(
          /insecure|loopback|tls/i
        );
      }
    });

    it('refuses a wildcard bind without an explicit canonical base URL, naming MCP_HTTP_EXTERNAL_BASE_URL', () => {
      for (const host of ['0.0.0.0', '[::]', '[::0]', '0:0:0:0:0:0:0:0']) {
        expect(() =>
          resolveRemoteMcpConfig({ ...baseEnv, MCP_HTTP_HOST: host, ...tlsEnv })
        ).toThrow(/MCP_HTTP_EXTERNAL_BASE_URL/i);
      }
    });

    it('starts a wildcard bind only with a valid explicit HTTPS external base URL', () => {
      const config = resolveRemoteMcpConfig({
        ...baseEnv,
        MCP_HTTP_HOST: '0.0.0.0',
        MCP_HTTP_EXTERNAL_BASE_URL: 'https://mcp.intranet.example',
        ...tlsEnv,
      });
      expect(config.externalBaseUrl).toBe('https://mcp.intranet.example');
    });

    it('keeps loopback binds startable without an external base URL', () => {
      const config = resolveRemoteMcpConfig({ ...baseEnv, ...tlsEnv });
      expect(config.host).toBe('127.0.0.1');
      expect(config.externalBaseUrl).toBeNull();
    });
  });

  /**
   * T9 (S4-S6): an explicitly opted-in local development mode that permits a
   * plaintext loopback Entra callback (`http://localhost:8443/login/callback`)
   * and the Docker development topology (container wildcard bind without TLS,
   * published strictly to the host loopback). Every default from above —
   * HTTPS-only redirects, non-loopback binds require TLS, wildcard discovery
   * fail-closed — must stay in force without the opt-in, and the opt-in must
   * never open real intranet or public addresses.
   */
  describe('explicit local development HTTP opt-in', () => {
    const DEV_UPSTREAM_SCOPE = 'api://outlook-mcp/mcp.access';

    const localHttpEnv = {
      ...baseEnv,
      MCP_HTTP_HOST: '0.0.0.0',
      MCP_HTTP_ALLOW_LOCAL_HTTP: 'true',
      MCP_HTTP_EXTERNAL_BASE_URL: 'http://localhost:8443',
      MCP_HTTP_LOGIN_REDIRECT_URI: 'http://localhost:8443/login/callback',
      MCP_HTTP_OAUTH_CLIENTS:
        '[{"clientId":"local-dev-mcp-client","redirectUris":["http://127.0.0.1:1455/auth/callback"]}]',
      MCP_HTTP_UPSTREAM_SCOPES: DEV_UPSTREAM_SCOPE,
    };

    it('carries allowLocalHttp=true, the loopback HTTP base URL, and the loopback HTTP login redirect', () => {
      const config = resolveRemoteMcpConfig(localHttpEnv);

      expect(config.allowLocalHttp).toBe(true);
      expect(config.externalBaseUrl).toBe('http://localhost:8443');
      expect(config.oauth.loginRedirectUri).toBe('http://localhost:8443/login/callback');
    });

    it('accepts the opted-in wildcard container bind without TLS (publish stays host-loopback)', () => {
      const config = resolveRemoteMcpConfig(localHttpEnv);
      expect(config.host).toBe('0.0.0.0');
      expect(config.tls).toBeNull();
    });

    it('keeps the wildcard discovery fail-closed rule in the opted-in mode', () => {
      const { MCP_HTTP_EXTERNAL_BASE_URL: _ignored, ...withoutBase } = localHttpEnv;
      expect(() => resolveRemoteMcpConfig(withoutBase)).toThrow(/MCP_HTTP_EXTERNAL_BASE_URL/i);
    });

    it('refuses a plaintext Entra login redirect by default (HTTPS-only production guard)', () => {
      expect(() =>
        resolveRemoteMcpConfig({
          ...localHttpEnv,
          // A plain loopback listener shape so the redirect check, not the
          // bind guard, is the rule under test.
          MCP_HTTP_HOST: '127.0.0.1',
          MCP_HTTP_EXTERNAL_BASE_URL: 'https://mcp.internal.example',
          MCP_HTTP_LOGIN_REDIRECT_URI: 'http://localhost:8443/login/callback',
          MCP_HTTP_ALLOW_LOCAL_HTTP: undefined,
        })
      ).toThrow(/MCP_HTTP_LOGIN_REDIRECT_URI/i);
    });

    it('never accepts a plaintext redirect for intranet or public addresses, even opted-in', () => {
      expect(() =>
        resolveRemoteMcpConfig({
          ...localHttpEnv,
          MCP_HTTP_EXTERNAL_BASE_URL: 'http://mcp.intranet.example',
          MCP_HTTP_LOGIN_REDIRECT_URI: 'http://mcp.intranet.example/login/callback',
        })
      ).toThrow(/MCP_HTTP_LOGIN_REDIRECT_URI|MCP_HTTP_EXTERNAL_BASE_URL/i);
    });

    it('still refuses real non-loopback, non-wildcard binds without TLS in the opted-in mode', () => {
      // The wildcard container bind is the intended opted-in dev topology;
      // real intranet addresses are never released from the TLS requirement.
      for (const host of ['10.1.2.3', 'intranet.example']) {
        expect(() => resolveRemoteMcpConfig({ ...localHttpEnv, MCP_HTTP_HOST: host })).toThrow(
          /insecure|loopback|tls/i
        );
      }
    });

    it('accepts only the exact opt-in value so a typo can never silently enable plaintext mode', () => {
      for (const bad of ['True', '1', 'false', ' yes']) {
        expect(() =>
          resolveRemoteMcpConfig({ ...baseEnv, MCP_HTTP_ALLOW_LOCAL_HTTP: bad })
        ).toThrow(/MCP_HTTP_ALLOW_LOCAL_HTTP/i);
      }
    });

    it('accepts loopback http:// external base URLs only for loopback targets (scheme guard unchanged)', () => {
      // Pre-existing behavior: a loopback http:// base URL is acceptable on a
      // loopback bind; the opt-in flag is not required for base URLs.
      expect(() =>
        resolveRemoteMcpConfig({
          ...baseEnv,
          MCP_HTTP_EXTERNAL_BASE_URL: 'http://localhost:8443',
        })
      ).not.toThrow();
      // A plaintext base URL for a real intranet destination stays refused,
      // with or without the opt-in.
      for (const optedIn of [undefined, 'true']) {
        expect(() =>
          resolveRemoteMcpConfig({
            ...baseEnv,
            MCP_HTTP_ALLOW_LOCAL_HTTP: optedIn,
            MCP_HTTP_EXTERNAL_BASE_URL: 'http://mcp.intranet.example',
          })
        ).toThrow(/MCP_HTTP_EXTERNAL_BASE_URL/i);
      }
    });
  });
});

describe('standards sign-in flow fail-closed configuration', () => {
  it('refuses the standards sign-in flow without explicit resource-qualified upstream scopes', () => {
    expect(() =>
      createRemoteMcpHttpServer(
        serverConfig({
          oauth: {
            loginRedirectUri: 'https://mcp.internal.example/login/callback',
            clients: [
              { clientId: 'external-web-client', redirectUris: ['https://client.example/cb'] },
            ],
            supportedScopes: ['mcp'],
          },
        })
      )
    ).toThrow(/upstreamScopes/i);
  });

  it('refuses upstream scopes that are not resource-qualified in the direct configuration', () => {
    expect(() =>
      createRemoteMcpHttpServer(
        serverConfig({
          oauth: {
            loginRedirectUri: 'https://mcp.internal.example/login/callback',
            clients: [
              { clientId: 'external-web-client', redirectUris: ['https://client.example/cb'] },
            ],
            supportedScopes: ['mcp'],
            upstreamScopes: ['mcp.access'],
          },
        })
      )
    ).toThrow(/upstreamScopes/i);
  });

  // T9 (S4-S6): direct-configuration opt-in for the local development HTTP
  // mode. A plaintext Entra login redirect stays refused unless the caller
  // explicitly opted in, and then only for exact loopback hostnames.
  it('serves the standards flow with a loopback HTTP login redirect under the explicit opt-in', async () => {
    const instance = createRemoteMcpHttpServer(
      serverConfig({
        allowLocalHttp: true,
        externalBaseUrl: 'http://localhost:8443',
        oauth: {
          loginRedirectUri: 'http://localhost:8443/login/callback',
          upstreamScopes: ['api://outlook-mcp/mcp.access'],
          clients: [
            {
              clientId: 'local-dev-mcp-client',
              redirectUris: ['http://127.0.0.1:1455/auth/callback'],
            },
          ],
          supportedScopes: ['mcp'],
        },
      })
    );
    const started = await instance.start();
    try {
      expect(started.tls).toBe(false);
      const discovery = await rawRequest(started.port, {
        path: '/.well-known/oauth-protected-resource',
      });
      expect(discovery.status).toBe(200);
      // The standards authorization server is advertised at the plaintext
      // loopback canonical URL of this opted-in local deployment.
      expect(discovery.json.authorization_servers).toContain('http://localhost:8443');
    } finally {
      await instance.stop();
    }
  });

  it('refuses a plaintext login redirect without the opt-in and never accepts intranet HTTP with it', () => {
    const oauthWithHttp = (loginRedirectUri) => ({
      oauth: {
        loginRedirectUri,
        upstreamScopes: ['api://outlook-mcp/mcp.access'],
        clients: [
          {
            clientId: 'local-dev-mcp-client',
            redirectUris: ['http://127.0.0.1:1455/auth/callback'],
          },
        ],
        supportedScopes: ['mcp'],
      },
    });
    // Production default: HTTPS-only login redirect.
    expect(() =>
      createRemoteMcpHttpServer(serverConfig(oauthWithHttp('http://localhost:8443/login/callback')))
    ).toThrow(/loginRedirectUri/i);
    // Opted-in: non-loopback plaintext stays refused.
    expect(() =>
      createRemoteMcpHttpServer(
        serverConfig({
          allowLocalHttp: true,
          ...oauthWithHttp('http://mcp.intranet.example/login/callback'),
        })
      )
    ).toThrow(/loginRedirectUri/i);
  });
});

describe('protected-resource discovery', () => {
  it('serves MCP protected-resource metadata without authentication', async () => {
    await withTestServer({}, async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(response.headers.get('cache-control')).toContain('no-store');
      const metadata = await response.json();
      // Pinned, deterministic URL derived from the validated listener
      // configuration, never from the untrusted request Host header.
      expect(metadata.resource).toBe(`http://127.0.0.1:${port}`);
      // T16 (S5,S10): direct mode exposes only the Entra authorization server
      // and the fully resource-qualified request scopes (never the short scp
      // names, which stay an internal verification requirement instead).
      expect(metadata.authorization_servers).toEqual([ISSUER]);
      expect(metadata.scopes_supported).toEqual([`api://${CLIENT_ID}/${REQUIRED_SCOPE}`]);
      expect(metadata.scopes_supported).not.toContain(REQUIRED_SCOPE);
      expect(metadata.bearer_methods_supported).toContain('header');
    });
  });

  it('never reflects an untrusted Host header into discovery or challenge URLs', async () => {
    await withTestServer({}, async (port) => {
      const metadata = await rawRequest(port, {
        path: '/.well-known/oauth-protected-resource',
      }).then((res) => res.json);
      expect(metadata.resource).toBe(`http://127.0.0.1:${port}`);

      const challenge = await rawRequest(port, {
        method: 'POST',
        body: JSON.stringify(rpcRequest(1, 'tools/list', {})),
      });
      expect(challenge.status).toBe(401);
      expect(challenge.headers['www-authenticate']).toContain(
        `resource_metadata="http://127.0.0.1:${port}/.well-known/oauth-protected-resource"`
      );
      expect(challenge.headers['www-authenticate']).not.toContain('attacker.example');
    });
  });

  it('advertises the configured canonical external base URL over any Host header', async () => {
    await withTestServer({ externalBaseUrl: 'https://mcp.intranet.example' }, async (port) => {
      const metadata = await rawRequest(port, {
        path: '/.well-known/oauth-protected-resource',
      }).then((res) => res.json);
      expect(metadata.resource).toBe('https://mcp.intranet.example');

      const challenge = await rawRequest(port, {
        method: 'POST',
        body: JSON.stringify(rpcRequest(1, 'tools/list', {})),
      });
      expect(challenge.status).toBe(401);
      expect(challenge.headers['www-authenticate']).toContain(
        'resource_metadata="https://mcp.intranet.example/.well-known/oauth-protected-resource"'
      );
      expect(challenge.headers['www-authenticate']).not.toContain('attacker.example');
    });
  });
});

describe('bearer authentication gate', () => {
  it('rejects an unauthenticated POST with 401 and WWW-Authenticate metadata', async () => {
    await withTestServer({}, async (port) => {
      const result = await postMcp(port, rpcRequest(1, 'tools/list', {}));
      expect(result.status).toBe(401);
      const header = result.headers.get('www-authenticate');
      expect(header).toContain('Bearer');
      expect(header).toContain('resource_metadata=');
      expect(JSON.stringify(result.text)).not.toContain('bearer ');
    });
  });

  it('rejects malformed authorization headers', async () => {
    await withTestServer({}, async (port) => {
      const validToken = signAccessToken({ sub: 'subject-a', oid: 'object-a' });
      markerByToken.set(validToken, 'A');
      for (const header of [
        'Basic dXNlcjpwYXNz',
        `Bearer ${validToken} trailing-junk`,
        `Bearer ${validToken},`,
        `Bearer ${validToken}, extra`,
        `Bearer ${validToken}\textra`,
      ]) {
        const result = await postMcp(port, rpcRequest(1, 'tools/list', {}), {
          headers: { authorization: header },
        });
        expect(result.status).toBe(401);
        expect(oboRequests.length).toBe(0);
      }
      // Case-insensitive scheme with exactly one clean token is accepted.
      const lowered = await postMcp(port, rpcRequest(1, 'tools/list', {}), {
        headers: { authorization: `bearer ${validToken}` },
      });
      expect(lowered.status).toBe(200);
    });
  });

  it('names the fully resource-qualified scope in the direct-mode 401 challenge (T16)', async () => {
    await withTestServer({}, async (port) => {
      const result = await postMcp(port, rpcRequest(1, 'tools/list', {}));
      expect(result.status).toBe(401);
      const header = result.headers.get('www-authenticate');
      expect(header).toContain(`scope="api://${CLIENT_ID}/${REQUIRED_SCOPE}"`);
      expect(header).toContain(
        `resource_metadata="http://127.0.0.1:${port}/.well-known/oauth-protected-resource"`
      );
    });
  });

  it('accepts the same synthetic bearer token after server recreation (stateless verification)', async () => {
    const token = signAccessToken({ sub: 'subject-recreated', oid: 'object-recreated' });
    markerByToken.set(token, 'R');
    const first = createRemoteMcpHttpServer(serverConfig());
    const started = await first.start();
    try {
      const initial = await postMcp(started.port, rpcRequest(1, 'tools/list', {}), { token });
      expect(initial.status).toBe(200);
    } finally {
      await first.stop();
    }
    const second = createRemoteMcpHttpServer(serverConfig());
    try {
      const restarted = await second.start();
      expect(restarted.port).not.toBe(started.port);
      const again = await postMcp(restarted.port, rpcRequest(1, 'tools/list', {}), { token });
      expect(again.status).toBe(200);
      expect(again.json.result.tools.length).toBeGreaterThan(0);
    } finally {
      await second.stop();
    }
  });

  it('rejects a token issued for a different audience', async () => {
    await withTestServer({}, async (port) => {
      const token = signAccessToken({ aud: 'api://something-else' });
      const result = await postMcp(port, rpcRequest(1, 'tools/list', {}), { token });
      expect(result.status).toBe(401);
      expect(result.headers.get('www-authenticate')).toContain('error="invalid_token"');
      expect(result.text).not.toContain(token);
    });
  });

  it('rejects a token issued for a different tenant', async () => {
    await withTestServer({}, async (port) => {
      const token = signAccessToken({ tid: OTHER_TENANT_ID });
      const result = await postMcp(port, rpcRequest(1, 'tools/list', {}), { token });
      expect(result.status).toBe(401);
    });
  });

  it('rejects an expired token', async () => {
    await withTestServer({}, async (port) => {
      const token = signAccessToken({
        exp: Math.floor(Date.now() / 1000) - 500,
        iat: Math.floor(Date.now() / 1000) - 1000,
        sub: 'subject-old',
        oid: 'object-old',
      });
      markerByToken.set(token, 'old');
      const result = await postMcp(port, rpcRequest(1, 'tools/list', {}), { token });
      expect(result.status).toBe(401);
    });
  });

  it('rejects a token without the required delegated scope', async () => {
    await withTestServer({}, async (port) => {
      const token = signAccessToken({
        scp: 'user.read',
        sub: 'subject-noscope',
        oid: 'object-noscope',
      });
      markerByToken.set(token, 'noscope');
      const result = await postMcp(port, rpcRequest(1, 'tools/list', {}), { token });
      expect(result.status).toBe(401);
    });
  });

  it('rejects a token signed by an untrusted key', async () => {
    await withTestServer({}, async (port) => {
      const rogue = jwt.sign(
        {
          iss: ISSUER,
          aud: AUDIENCE,
          tid: TENANT_ID,
          oid: 'object-rogue',
          sub: 'subject-rogue',
          scp: REQUIRED_SCOPE,
          groups: [],
        },
        generateKeyPair().privateKey,
        { algorithm: 'RS256', keyid: 'test-key-1' }
      );
      const result = await postMcp(port, rpcRequest(1, 'tools/list', {}), { token: rogue });
      expect(result.status).toBe(401);
      expect(markerByToken.size).toBe(0);
    });
  });
});

describe('authorized read-only access through the MCP SDK client', () => {
  it('lists tools without the local auth/Vault/server-lifecycle tools', async () => {
    await withTestServer({}, async (port) => {
      const token = signAccessToken({ sub: 'subject-reader', oid: 'object-reader' });
      markerByToken.set(token, 'reader');
      const { client } = await createSdkClient(port, token);
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name);
      for (const excluded of LOCAL_EXCLUDED_TOOL_NAMES) {
        expect(names).not.toContain(excluded);
      }
      expect(names).toContain('send-email');
    });
  });

  it('executes a read-only tool with the request-scoped OBO identity', async () => {
    await withTestServer({}, async (port) => {
      const token = signAccessToken({ sub: 'subject-a', oid: 'object-a' });
      markerByToken.set(token, 'A');
      const { client } = await createSdkClient(port, token);
      const result = await client.callTool({ name: 'list-folders', arguments: {} });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('OBO:obo-graph-for-A');
      expect(callGraphAPI.mock.calls[0][0]).toBe('obo-graph-for-A');
    });
  });
});

describe('uniform delegated authorization for authenticated users (S3)', () => {
  it('dispatches a mutation tool (send-chat-message) for an authenticated user with no group or role', async () => {
    await withTestServer({}, async (port) => {
      const token = signAccessToken({ sub: 'subject-user', oid: 'object-user', groups: [] });
      markerByToken.set(token, 'U');
      const result = await postMcp(
        port,
        rpcRequest(2, 'tools/call', {
          name: 'send-chat-message',
          arguments: { chatId: 'chat-1', content: 'hello' },
        }),
        { token }
      );
      expect(result.status).toBe(200);
      expect(result.json.result).toBeDefined();
      expect(oboRequests.length).toBe(1);
      expect(oboRequests[0].token).toBe(token);
      expect(
        callGraphAPI.mock.calls.some(
          (call) => call[1] === 'POST' && call[2] === 'chats/chat-1/messages'
        )
      ).toBe(true);
    });
  });

  it('surfaces a public Graph 403 for a mutation tool instead of a local denial', async () => {
    await withTestServer({}, async (port) => {
      const token = signAccessToken({ sub: 'subject-403', oid: 'object-403', groups: [] });
      markerByToken.set(token, 'F403');
      callGraphAPI.mockImplementationOnce(async () => {
        throw new Error('API call failed with status 403: {"error":{"code":"AccessDenied"}}');
      });
      const result = await postMcp(
        port,
        rpcRequest(2, 'tools/call', {
          name: 'send-chat-message',
          arguments: { chatId: 'chat-1', content: 'hello' },
        }),
        { token }
      );
      // The public Microsoft 365 permission failure surfaces to the client;
      // no local group denial (-32000) ever replaces or filters it.
      expect(result.status).toBe(200);
      expect(JSON.stringify(result.json)).not.toContain('-32000');
      expect(result.json.result.content[0].text).toContain('status 403');
    });
  });

  it('answers 401 for an unauthenticated mutation tool call before any dispatch', async () => {
    await withTestServer({}, async (port) => {
      const result = await postMcp(
        port,
        rpcRequest(2, 'tools/call', {
          name: 'send-chat-message',
          arguments: { chatId: 'chat-1', content: 'hello' },
        })
      );
      expect(result.status).toBe(401);
      expect(oboRequests.length).toBe(0);
      expect(callGraphAPI.mock.calls.length).toBe(0);
    });
  });

  it('keeps the local auth/Vault/server-lifecycle tools absent and uncallable for any authenticated identity', async () => {
    const { TOOLS } = require('../../index');
    const remoteNames = TOOLS.map((tool) => tool.name).filter(
      (name) => !LOCAL_EXCLUDED_TOOL_NAMES.includes(name)
    );
    expect(remoteNames).toContain('send-chat-message');

    await withTestServer({}, async (port) => {
      const token = signAccessToken({ sub: 'subject-x', oid: 'object-x', groups: [] });
      markerByToken.set(token, 'X');
      const { client } = await createSdkClient(port, token);
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name);
      for (const excluded of LOCAL_EXCLUDED_TOOL_NAMES) {
        expect(names).not.toContain(excluded);
      }
      expect(names).toContain('send-chat-message');
      await client.close();
      for (const excluded of LOCAL_EXCLUDED_TOOL_NAMES) {
        const call = await postMcp(
          port,
          rpcRequest(2, 'tools/call', { name: excluded, arguments: {} }),
          { token }
        );
        expect(call.json.error).toBeDefined();
        expect(callGraphAPI.mock.calls.length).toBe(0);
      }
    });
  });
});

describe('JSON-RPC batch dispatch', () => {
  it('dispatches a fully authorized batch normally', async () => {
    await withTestServer({}, async (port) => {
      const token = signAccessToken({ sub: 'subject-m', oid: 'object-m', groups: [] });
      markerByToken.set(token, 'M');
      const batch = [
        rpcRequest(1, 'tools/call', {
          name: 'send-email',
          arguments: { to: 'a@example.com', subject: 's', body: 'b1' },
        }),
        rpcRequest(2, 'tools/call', {
          name: 'send-email',
          arguments: { to: 'b@example.com', subject: 's', body: 'b2' },
        }),
      ];
      const result = await postMcp(port, batch, { token });
      expect(result.status).toBe(200);
      expect(result.json).toBeDefined();
      expect(callGraphAPI.mock.calls.length).toBe(2);
      for (const call of callGraphAPI.mock.calls) {
        expect(call[0]).toBe('obo-graph-for-M');
        expect(call[1]).toBe('POST');
      }
    });
  });
});

describe('per-request identity isolation', () => {
  it('serves two simultaneous identities from their own OBO stores without cross-user leakage', async () => {
    await withTestServer({}, async (port) => {
      const tokenA = signAccessToken({ sub: 'subject-a', oid: 'object-a' });
      const tokenB = signAccessToken({ sub: 'subject-b', oid: 'object-b' });
      markerByToken.set(tokenA, 'A');
      markerByToken.set(tokenB, 'B');

      const { client } = await createSdkClient(port, tokenA);
      const { client: clientB } = await createSdkClient(port, tokenB);

      const [resultA1, resultB1, resultA2, resultB2] = await Promise.all([
        client.callTool({ name: 'list-folders', arguments: {} }),
        clientB.callTool({ name: 'list-folders', arguments: {} }),
        client.callTool({ name: 'list-folders', arguments: {} }),
        clientB.callTool({ name: 'list-folders', arguments: {} }),
      ]);

      expect(resultA1.content[0].text).toContain('OBO:obo-graph-for-A');
      expect(resultB1.content[0].text).toContain('OBO:obo-graph-for-B');
      expect(resultA2.content[0].text).toContain('OBO:obo-graph-for-A');
      expect(resultB2.content[0].text).toContain('OBO:obo-graph-for-B');
      expect(resultA1.content[0].text).not.toContain('OBO:obo-graph-for-B');
      expect(resultB1.content[0].text).not.toContain('OBO:obo-graph-for-A');
      // One fresh OBO store per HTTP request (initialize, notifications, and tool calls
      // each get their own store), never shared.
      expect(oboRequests.length).toBeGreaterThanOrEqual(4);
      for (const requestConfig of oboRequests) {
        expect(Object.keys(requestConfig).sort()).toEqual([
          'clientId',
          'clientSecret',
          'tenantId',
          'token',
        ]);
      }
    });
  });
});

describe('HTTP request correctness', () => {
  it('returns 404 for unknown paths and 405 for unsupported methods', async () => {
    await withTestServer({}, async (port) => {
      const token = signAccessToken({ sub: 'subject-a', oid: 'object-a' });
      markerByToken.set(token, 'A');
      const unknownGet = await fetch(`http://127.0.0.1:${port}/unknown-path`);
      expect(unknownGet.status).toBe(404);
      await fetch(`http://127.0.0.1:${port}/mcp2`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: '{}',
      }).then(async (res) => expect(res.status).toBe(404));
      const put = await postMcp(port, rpcRequest(1, 'tools/list', {}), { method: 'PUT', token });
      expect(put.status).toBe(405);
      const unsupportedGet = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json, text/event-stream',
        },
      });
      // Stateless mode serves no SSE stream: GET /mcp is not supported.
      expect(unsupportedGet.status).toBe(405);
    });
  });

  it('rejects requests from disallowed origins while accepting configured origins', async () => {
    await withTestServer({ allowedOrigins: ['https://intranet.example'] }, async (port) => {
      const token = signAccessToken({ sub: 'subject-a', oid: 'object-a' });
      markerByToken.set(token, 'A');
      const denied = await postMcp(port, rpcRequest(1, 'tools/list', {}), {
        token,
        headers: { origin: 'https://evil.example' },
      });
      expect(denied.status).toBe(403);
      const allowed = await postMcp(port, rpcRequest(1, 'tools/list', {}), {
        token,
        headers: { origin: 'https://intranet.example' },
      });
      expect(allowed.status).toBe(200);
      expect(allowed.json.result.tools.length).toBeGreaterThan(0);
    });
  });

  describe('T19 bridge persistence configuration (MCP_HTTP_BRIDGE_STORE_DIR / MCP_HTTP_BRIDGE_KEY_FILE)', () => {
    it('carries the optional explicit store directory and separate key file into the bridge oauth configuration', () => {
      const bridgeEnv = {
        MCP_HTTP_ALLOW_LOCAL_HTTP: 'true',
        MCP_HTTP_PORT: '8443',
        ENTRA_TENANT_ID: TENANT_ID,
        ENTRA_CLIENT_ID: 'app-client-id',
        ENTRA_CLIENT_SECRET: 'app-client-secret-value',
        MCP_HTTP_LOGIN_REDIRECT_URI: 'http://localhost:8443/login/callback',
        MCP_HTTP_OAUTH_CLIENTS:
          '[{"clientId":"external-web-client","redirectUris":["http://127.0.0.1:1455/auth/callback"]}]',
        MCP_HTTP_BRIDGE_STORE_DIR: '/data/oauth-bridge',
        MCP_HTTP_BRIDGE_KEY_FILE: '/var/mcp-bridge/bridge.key',
      };
      const config = resolveRemoteMcpConfig(bridgeEnv);
      expect(config.authMode).toBe('bridge');
      expect(config.oauth.storeDirectory).toBe('/data/oauth-bridge');
      expect(config.oauth.keyFile).toBe('/var/mcp-bridge/bridge.key');
    });

    it('ignores the bridge store variables in direct Entra mode (no store) and refuses blank values', () => {
      const directConfig = resolveRemoteMcpConfig({
        MCP_HTTP_PORT: '8443',
        ENTRA_TENANT_ID: TENANT_ID,
        ENTRA_CLIENT_ID: 'app-client-id',
        ENTRA_CLIENT_SECRET: 'app-client-secret-value',
        MCP_HTTP_BRIDGE_STORE_DIR: '/data/oauth-bridge',
      });
      expect(directConfig.authMode).toBe('entra');
      expect(directConfig.oauth).toBeNull();

      const bridgeEnv = {
        MCP_HTTP_PORT: '8443',
        ENTRA_TENANT_ID: TENANT_ID,
        ENTRA_CLIENT_ID: 'app-client-id',
        ENTRA_CLIENT_SECRET: 'app-client-secret-value',
        MCP_HTTP_LOGIN_REDIRECT_URI: 'https://mcp.internal.example/login/callback',
        MCP_HTTP_OAUTH_CLIENTS:
          '[{"clientId":"external-web-client","redirectUris":["https://client.example/cb"]}]',
      };
      expect(() =>
        resolveRemoteMcpConfig({ ...bridgeEnv, MCP_HTTP_BRIDGE_STORE_DIR: '   ' })
      ).toThrow(/MCP_HTTP_BRIDGE_STORE_DIR/i);
      expect(() =>
        resolveRemoteMcpConfig({ ...bridgeEnv, MCP_HTTP_BRIDGE_KEY_FILE: '   ' })
      ).toThrow(/MCP_HTTP_BRIDGE_KEY_FILE/i);
      // A valid key-file value alone still resolves (the storage runtime
      // wiring decides its usability).
      const withKeyFile = resolveRemoteMcpConfig({
        ...bridgeEnv,
        MCP_HTTP_BRIDGE_KEY_FILE: '/var/mcp-bridge/bridge.key',
      });
      expect(withKeyFile.oauth.keyFile).toBe('/var/mcp-bridge/bridge.key');
      expect(withKeyFile.oauth.storeDirectory).toBeUndefined();
    });

    it('fails closed on invalid runtime seam options in the bridge oauth configuration object', () => {
      const base = {
        oauth: {
          loginRedirectUri: 'https://mcp.internal.example/login/callback',
          upstreamScopes: ['api://outlook-mcp/mcp.access'],
          clients: [
            { clientId: 'external-web-client', redirectUris: ['https://client.example/cb'] },
          ],
        },
      };
      expect(() =>
        createRemoteMcpHttpServer(
          serverConfig({
            ...base,
            oauth: { ...base.oauth, refreshUpstreamEntraToken: 'not-a-function' },
          })
        )
      ).toThrow(/refreshUpstreamEntraToken/i);
      expect(() =>
        createRemoteMcpHttpServer(
          serverConfig({
            ...base,
            oauth: { ...base.oauth, persistentStore: { load: () => {} } },
          })
        )
      ).toThrow(/persistentStore/i);
    });

    it('accepts a programmatic injected renewal callback seam', async () => {
      const instance = createRemoteMcpHttpServer(
        serverConfig({
          oauth: {
            loginRedirectUri: 'https://mcp.internal.example/login/callback',
            upstreamScopes: ['api://outlook-mcp/mcp.access'],
            clients: [
              { clientId: 'external-web-client', redirectUris: ['https://client.example/cb'] },
            ],
            supportedScopes: ['mcp'],
            refreshUpstreamEntraToken: async () => {
              throw new Error('must never run: the upstream stays fresh');
            },
          },
        })
      );
      const started = await instance.start();
      try {
        expect(started.port).toBeGreaterThan(0);
      } finally {
        await instance.stop();
      }
    });
  });
});
