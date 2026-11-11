/**
 * Per-request Entra on-behalf-of (OBO) token store for the future intranet
 * MCP HTTP transport (task T2, S1-S3).
 *
 * Bounded unit: for one already-validated inbound delegated access token
 * (verified by `remote/entra-auth.js`), this store exchanges confidential
 * client credentials plus that token against the tenant-specific Entra
 * token endpoint to obtain:
 *   - a Microsoft Graph token (`getValidAccessToken`), and
 *   - a Power Automate token (`getValidFlowAccessToken`),
 * mirroring the async contracts the existing handlers already use through
 * `auth/index.js` (`tokenStorage.getValidAccessToken` and
 * `tokenStorage.getValidFlowAccessToken`).
 *
 * Safety rules enforced here:
 *   - The inbound token travels only inside the OBO `assertion` field to the
 *     tenant token endpoint; it is never attached to any downstream service
 *     request, and no Authorization header is built from it.
 *   - No local file cache and no singleton fallback: every cache entry is
 *     local to this store instance (one HTTP server request).
 *   - Caching and in-flight deduplication are lazy and per resource; a
 *     failed Flow exchange never invalidates the Graph cache.
 *   - Configuration is validated up front and fails closed; tenant is a
 *     specific Entra GUID, never `common`.
 *   - Errors never contain the inbound token, client secret, or any
 *     exchanged token.
 *
 * Not wired here by design: no HTTP listener, no login flow, and no local
 * token-file access. Wiring into the MCP HTTP transport is a later task.
 * Note: Flow OBO is not assumed to work against a real tenant; a failed
 * Flow exchange is a self-contained rejection.
 */
const https = require('https');
const querystring = require('querystring');
const appConfig = require('../config');
const { createEntraOAuthError } = require('../auth/entra-error');
const { createContextualError } = require('../utils/network-error');

const OBO_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const OBO_REQUESTED_TOKEN_USE = 'on_behalf_of';
const OBO_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const ENTRA_GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const OBO_CONFIG_ERROR_CODE = 'MCP_OBO_CONFIG_INVALID';
const OBO_EXCHANGE_FAILED_CODE = 'MCP_OBO_TOKEN_EXCHANGE_FAILED';

const ALLOWED_CONFIG_KEYS = [
  'token',
  'tenantId',
  'clientId',
  'clientSecret',
  'graphScopes',
  'flowScope',
  'expiryBufferMs',
];

const RESOURCES = Object.freeze({
  graph: 'Microsoft Graph',
  flow: 'Power Automate',
});

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function configError(message) {
  const error = new Error(message);
  error.code = OBO_CONFIG_ERROR_CODE;
  return error;
}

/**
 * Validates the per-request OBO configuration. Unknown keys, a missing
 * validated inbound token, non-tenant credentials, or empty down-scopes all
 * fail closed before any network work. Messages never quote secret values.
 */
function validateOboConfig(config) {
  if (!isPlainObject(config)) {
    throw configError('A configuration object with an already-validated inbound token is required');
  }

  const unknownKeys = Object.keys(config).filter((key) => !ALLOWED_CONFIG_KEYS.includes(key));
  if (unknownKeys.length > 0) {
    throw configError(`unexpected OBO store options: ${unknownKeys.join(', ')}`);
  }

  if (!isNonEmptyString(config.token)) {
    throw configError('token is required and must be an already-validated inbound access token');
  }
  if (!isNonEmptyString(config.tenantId) || !ENTRA_GUID_PATTERN.test(config.tenantId)) {
    throw configError('tenantId must be a specific Entra directory (tenant) GUID');
  }
  const tenantId = config.tenantId.toLowerCase();
  if (!isNonEmptyString(config.clientId)) {
    throw configError('clientId must be a non-empty confidential client identifier');
  }
  if (!isNonEmptyString(config.clientSecret)) {
    throw configError('clientSecret must be a non-empty confidential client secret');
  }

  let graphScopes = config.graphScopes;
  if (graphScopes === undefined) {
    graphScopes = appConfig.AUTH_CONFIG.scopes;
  }
  if (
    !Array.isArray(graphScopes) ||
    graphScopes.length === 0 ||
    graphScopes.some((scope) => !isNonEmptyString(typeof scope === 'string' ? scope.trim() : scope))
  ) {
    throw configError('graphScopes must resolve to a non-empty array of non-empty scope strings');
  }
  graphScopes = graphScopes.map((scope) => scope.trim());

  let flowScope = config.flowScope;
  if (flowScope === undefined) {
    flowScope = appConfig.FLOW_SCOPE;
  }
  if (!isNonEmptyString(typeof flowScope === 'string' ? flowScope.trim() : flowScope)) {
    throw configError('flowScope must resolve to a non-empty scope string');
  }
  flowScope = flowScope.trim();

  let expiryBufferMs = config.expiryBufferMs;
  if (expiryBufferMs === undefined) {
    expiryBufferMs = DEFAULT_EXPIRY_BUFFER_MS;
  }
  if (!Number.isFinite(expiryBufferMs) || expiryBufferMs < 0) {
    throw configError('expiryBufferMs must be a finite non-negative number of milliseconds');
  }

  const normalized = {
    token: config.token,
    tenantId,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    graphScopes,
    flowScope,
    expiryBufferMs,
  };

  // The tenant-specific endpoint is pinned at creation so a later environment
  // change can never redirect an in-flight request's secrets elsewhere.
  normalized.tokenEndpoint = `${normalizeAuthorityHost(
    process.env.MS_AUTHORITY_HOST || DEFAULT_AUTHORITY_HOST
  )}/${tenantId}/oauth2/v2.0/token`;

  return normalized;
}

/**
 * Validates MS_AUTHORITY_HOST (or its default) as a strict HTTPS origin
 * appropriate for an Entra token endpoint: a parseable URL, https scheme, a
 * hostname, no embedded credentials, and no path, query, or hash. Fails
 * closed with a configuration error before any request (and any secret) can
 * be sent to an invalid authority.
 */
const DEFAULT_AUTHORITY_HOST = 'https://login.microsoftonline.com';

function normalizeAuthorityHost(rawHost) {
  const host = String(rawHost || '').replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(host);
  } catch {
    throw configError('The Entra authority host must be a valid HTTPS origin');
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname) {
    throw configError('The Entra authority host must be a valid HTTPS origin');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw configError(
      'The Entra authority host must be an origin without credentials, query, or hash'
    );
  }
  if (parsed.pathname && parsed.pathname !== '/') {
    throw configError('The Entra authority host must be an origin without a path');
  }
  return parsed.origin;
}

/**
 * Runs one on-behalf-of exchange for one resource scope. Resolves with the
 * raw successful token response; every failure path is wrapped through the
 * shared contextual error helper so tokens and secrets are redacted.
 */
function performTokenExchange(config, resource) {
  const resourceLabel = RESOURCES[resource];
  const operation = `${resourceLabel} on-behalf-of token exchange`;
  const endpoint = config.tokenEndpoint;

  const postData = querystring.stringify({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: OBO_GRANT_TYPE,
    assertion: config.token,
    requested_token_use: OBO_REQUESTED_TOKEN_USE,
    scope: resource === 'graph' ? config.graphScopes.join(' ') : config.flowScope,
  });

  const requestOptions = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postData),
    },
  };

  const secrets = [config.clientSecret, config.token];

  return new Promise((resolve, reject) => {
    const fail = (error) => {
      reject(
        createContextualError(operation, endpoint, error, {
          fallbackCode: OBO_EXCHANGE_FAILED_CODE,
          secrets,
        })
      );
    };

    let req;
    try {
      req = https.request(endpoint, requestOptions, (res) => {
        let responseData = '';
        res.on('data', (chunk) => {
          responseData += chunk;
        });
        // A socket or stream failure mid-response rejects the exchange
        // instead of leaving the caller (and the in-flight slot) hanging.
        res.on('error', fail);
        res.on('end', () => {
          try {
            const responseBody = JSON.parse(responseData || '{}');
            if (res.statusCode >= 200 && res.statusCode < 300) {
              if (!isNonEmptyString(responseBody.access_token)) {
                fail(new Error('The token response did not include a usable access token'));
                return;
              }
              if (!Number.isFinite(responseBody.expires_in) || responseBody.expires_in < 0) {
                fail(new Error('The token response did not include a valid expiration'));
                return;
              }
              resolve(responseBody);
            } else {
              fail(createEntraOAuthError(responseBody, res.statusCode, operation));
            }
          } catch (error) {
            fail(error);
          }
        });
      });
    } catch (error) {
      fail(error);
      return;
    }

    req.setTimeout(OBO_REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`Request timed out after ${OBO_REQUEST_TIMEOUT_MS / 1000} seconds`));
    });
    req.on('error', fail);
    req.write(postData);
    req.end();
  });
}

/**
 * Creates one request-scoped OBO token store. The inbound token must already
 * be validated (e.g. by `remote/entra-auth.js`) for the intended MCP
 * deployment; no verification happens here.
 *
 * The returned object exposes `getValidAccessToken` and
 * `getValidFlowAccessToken` with the same async contracts the existing
 * handlers consume: each resolves with a token while a cached one is valid
 * and rejects with a safe, secret-free error otherwise. There is no local
 * singleton fallback, and no token is ever persisted.
 */
function createRequestOboTokenStore(config) {
  const normalized = validateOboConfig(config);

  const resources = {
    graph: { cached: null, cachedExpiresAt: 0, inFlight: null },
    flow: { cached: null, cachedExpiresAt: 0, inFlight: null },
  };

  function getValid(resource) {
    const state = resources[resource];
    if (state.inFlight) {
      return state.inFlight;
    }
    if (state.cached && Date.now() < state.cachedExpiresAt - normalized.expiryBufferMs) {
      return Promise.resolve(state.cached);
    }
    const exchange = performTokenExchange(normalized, resource).then((responseBody) => {
      state.inFlight = null;
      state.cached = responseBody.access_token;
      state.cachedExpiresAt = Date.now() + responseBody.expires_in * 1000;
      return state.cached;
    });
    state.inFlight = exchange;
    // A failed exchange clears only this resource's in-flight slot; any other
    // resource's cache is untouched.
    exchange.catch(() => {
      state.inFlight = null;
    });
    return exchange;
  }

  return {
    getValidAccessToken() {
      return getValid('graph');
    },
    getValidFlowAccessToken() {
      return getValid('flow');
    },
  };
}

module.exports = {
  createRequestOboTokenStore,
};
