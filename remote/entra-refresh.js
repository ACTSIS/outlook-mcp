/**
 * Dedicated bounded Entra refresh-token service for the persistent OAuth
 * bridge (task T19, S5, S10, S11). The confidential client secret stays
 * server-side inside this module only; it redeems the service-held upstream
 * refresh credential at the tenant-pinned Microsoft token endpoint and
 * returns a strict, bounded credential contract for the provider seam:
 *
 *   const { createEntraTokenRefresher, ERROR_CODES } = require('./entra-refresh');
 *   const refresher = createEntraTokenRefresher({
 *     tenantId, clientId, clientSecret, scopes, // resource-qualified API scopes
 *     authorityHost?,  // optional, pinned HTTPS origin
 *     timeoutMs?,      // optional, at most 30000 (the default)
 *   });
 *   const { accessToken, expiresAt, refreshToken? } =
 *     await refresher.refresh({ refreshToken });
 *
 * Safety rules enforced here (mirroring remote/entra-login.js, its home
 * for the safe bounded HTTPS conventions):
 *   - The grant is `refresh_token` at the tenant-pinned HTTPS endpoint
 *     (`<authorityHost>/<tenantId>/oauth2/v2.0/token`); no resource or
 *     audience parameter is ever fabricated. The scope carries exactly the
 *     configured resource-qualified upstream API scope(s) plus
 *     `offline_access` (unioned once), so Microsoft keeps issuing a server
 *     refresh credential. `openid`/`profile` are never requested here.
 *   - Bounded transport: one HTTPS POST, bounded 64 KiB body, a request
 *     timeout at most 30 seconds, and response-stream error handling; a
 *     mid-body stream or socket failure rejects instead of hanging.
 *   - Success requires an access token (bounded, whitespace-free) and a
 *     positive finite `expires_in` (seconds, converted to an epoch-seconds
 *     `expiresAt`). A rotated `refresh_token` is returned only when it is
 *     a valid bounded credential; a missing one is reported as absent
 *     (the caller never pretends refresh was granted) and a malformed one
 *     is dropped, never propagated.
 *   - Classification is deliberately narrow. Only real user-consent
 *     reauth conditions (`invalid_grant`, `interaction_required`,
 *     `consent_required`, `login_required`) raise ERROR_CODES.REAUTH_REQUIRED;
 *     an AADSTS code inside a description alone decides nothing. Client or
 *     configuration failures (`invalid_client` and other 4xx OAuth
 *     errors) raise ERROR_CODES.SERVICE, which callers must treat as a
 *     service error that never wipes stored grants. Network problems,
 *     5xx responses, malformed/oversized bodies, and timeouts raise
 *     ERROR_CODES.TRANSIENT.
 *   - No token, secret, code, or response body is ever logged, and error
 *     messages are secret-redacted through the shared contextual-error
 *     helper.
 *
 * Bounded limitations: the module performs exactly one HTTP request per
 * refresh, has no retry, caching, or clock logic of its own, and performs
 * no token verification — verifying the renewed access token against this
 * deployment (audience, issuer, tenant, scopes, identity binding) is the
 * caller's job with the existing Entra verifier.
 */
const https = require('https');
const querystring = require('querystring');
const { createEntraOAuthError } = require('../auth/entra-error');
const { createContextualError } = require('../utils/network-error');

const DEFAULT_AUTHORITY_HOST = 'https://login.microsoftonline.com';
const DEFAULT_REFRESH_TIMEOUT_MS = 30000;
const MAX_REFRESH_TIMEOUT_MS = 30000;
const REFRESH_MAX_RESPONSE_BYTES = 64 * 1024;
const ENTRA_GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TOKEN_LENGTH = 4096;
/** Microsoft's own user-consent reauth conditions for the refresh grant. */
const REAUTH_CONDITION_ERROR_CODES = new Set([
  'invalid_grant',
  'interaction_required',
  'consent_required',
  'login_required',
]);
/** A resource-qualified delegated API scope (api://<app-id>/<scope> or https://<host>/<scope>). */
const RESOURCE_QUALIFIED_SCOPE_PATTERN = /^(?:api:\/\/|https:\/\/)[^\s]+$/i;

const ERROR_CODES = {
  CONFIG: 'entra-refresh-config-invalid',
  INVALID_PARAMETERS: 'entra-refresh-invalid-parameters',
  REAUTH_REQUIRED: 'entra-refresh-reauth-required',
  SERVICE: 'entra-refresh-service',
  TRANSIENT: 'entra-refresh-transient',
};

/** The reauth sentinel the HTTP wiring maps onto the provider seam. */
const REAUTH_REQUIRED = ERROR_CODES.REAUTH_REQUIRED;

class EntraRefreshError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EntraRefreshError';
    this.code = code;
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function configError(message) {
  return new EntraRefreshError(ERROR_CODES.CONFIG, message);
}

function parameterError(message) {
  return new EntraRefreshError(ERROR_CODES.INVALID_PARAMETERS, message);
}

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

function validateRefreshConfig(config) {
  if (!isPlainObject(config)) {
    throw configError('tenantId, client credentials, and upstream scopes are required');
  }
  const unknownKeys = Object.keys(config).filter(
    (key) =>
      !['tenantId', 'clientId', 'clientSecret', 'scopes', 'authorityHost', 'timeoutMs'].includes(
        key
      )
  );
  if (unknownKeys.length > 0) {
    throw configError(`unexpected Entra refresher options: ${unknownKeys.join(', ')}`);
  }

  if (!isNonEmptyString(config.tenantId) || !ENTRA_GUID_PATTERN.test(config.tenantId)) {
    throw configError('tenantId must be a specific trusted Entra directory (tenant) GUID');
  }
  if (!isNonEmptyString(config.clientId) || config.clientId.trim().length === 0) {
    throw configError('clientId must be a non-empty confidential client identifier');
  }
  if (!isNonEmptyString(config.clientSecret) || config.clientSecret.trim().length === 0) {
    throw configError('clientSecret must be a non-empty confidential client secret');
  }
  if (
    !Array.isArray(config.scopes) ||
    config.scopes.length === 0 ||
    config.scopes.some(
      (scope) => !isNonEmptyString(typeof scope === 'string' ? scope : '') || /\s/.test(scope)
    )
  ) {
    throw configError('scopes must be a non-empty array of resource-qualified scope strings');
  }
  const scopes = [...new Set(config.scopes)];
  if (
    scopes.some(
      (scope) => !RESOURCE_QUALIFIED_SCOPE_PATTERN.test(scope) || scope.length > MAX_TOKEN_LENGTH
    )
  ) {
    throw configError(
      'scopes must be resource-qualified delegated API scopes (api://<app-id>/<scope> or https://<host>/<scope>; no resource or audience parameter is ever fabricated by the refresh grant)'
    );
  }

  const authorityHost = normalizeAuthorityHost(
    config.authorityHost || process.env.MS_AUTHORITY_HOST || DEFAULT_AUTHORITY_HOST
  );

  const timeoutMs = config.timeoutMs === undefined ? DEFAULT_REFRESH_TIMEOUT_MS : config.timeoutMs;
  if (!Number.isFinite(timeoutMs) || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw configError('timeoutMs must be a positive integer number of milliseconds');
  }
  if (timeoutMs > MAX_REFRESH_TIMEOUT_MS) {
    throw configError(
      `timeoutMs must be at most ${MAX_REFRESH_TIMEOUT_MS / 1000} seconds for the refresh grant`
    );
  }

  return {
    tenantId: config.tenantId.toLowerCase(),
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    scopes,
    authorityHost,
    timeoutMs,
  };
}

/**
 * Validates one returned credential string the same strict way the login
 * and provider seams do: bounded, whitespace-free, string.
 */
function validateReturnedCredential(value) {
  if (!isNonEmptyString(typeof value === 'string' ? value : '')) {
    throw transientRefreshError('The token response carried no usable access token');
  }
  if (value.length > MAX_TOKEN_LENGTH || /\s/.test(value)) {
    throw transientRefreshError('The token response carried an unusable credential shape');
  }
  return value;
}

function transientRefreshError(message) {
  return new EntraRefreshError(ERROR_CODES.TRANSIENT, message);
}

function serviceRefreshError(message) {
  return new EntraRefreshError(ERROR_CODES.SERVICE, message);
}

/**
 * Builds the refresh-grant scope: exactly the configured resource-qualified
 * upstream scopes plus `offline_access`, unioned without duplicates.
 */
function buildRefreshScopeParam(scopes) {
  const union = [...scopes];
  if (!union.includes('offline_access')) {
    union.push('offline_access');
  }
  return union.join(' ');
}

/**
 * Classifies one non-2xx token endpoint response. Only the narrow set of
 * user-consent reauth conditions is permanent; every other OAuth error is a
 * service error, and transport-level problems are transient.
 */
function classifyOAuthRejection(responseBody, status, operation) {
  const oauthError = createEntraOAuthError(responseBody, status, operation);
  const errorCode = typeof oauthError.code === 'string' ? oauthError.code.toLowerCase() : '';
  if (REAUTH_CONDITION_ERROR_CODES.has(errorCode)) {
    const reauthError = new EntraRefreshError(
      ERROR_CODES.REAUTH_REQUIRED,
      'The upstream Microsoft refresh credential is no longer usable; repeat the Microsoft sign-in to receive new tokens'
    );
    reauthError.status = status;
    return reauthError;
  }
  const serviceError = serviceRefreshError(
    `The Microsoft token endpoint rejected the refresh grant (${errorCode || 'unknown-error'})`
  );
  serviceError.status = status;
  return serviceError;
}

/**
 * Creates one bounded Entra refresh-token refresher. Every instance pins its
 * tenant, endpoint, scope set, and timeout at creation; caller input can
 * never redirect the request anywhere else. Two deployments hold two
 * independent instances with no shared state.
 */
function createEntraTokenRefresher(config) {
  const normalized = validateRefreshConfig(config);
  const operation = 'Entra refresh-token grant redemption';
  const endpoint = `${normalized.authorityHost}/${normalized.tenantId}/oauth2/v2.0/token`;

  /**
   * Redeems the presented refresh credential. Resolves with
   * { accessToken, expiresAt, refreshToken? } or rejects with a
   * secret-free classified EntraRefreshError.
   */
  function refresh({ refreshToken } = {}) {
    if (
      !isNonEmptyString(typeof refreshToken === 'string' ? refreshToken : '') ||
      refreshToken.length > MAX_TOKEN_LENGTH ||
      /\s/.test(refreshToken)
    ) {
      return Promise.reject(
        parameterError('refreshToken must be the bounded, whitespace-free upstream credential')
      );
    }

    const postData = querystring.stringify({
      grant_type: 'refresh_token',
      client_id: normalized.clientId,
      client_secret: normalized.clientSecret,
      refresh_token: refreshToken,
      scope: buildRefreshScopeParam(normalized.scopes),
    });

    const requestOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const secrets = [normalized.clientSecret, refreshToken];

    return new Promise((resolve, reject) => {
      /**
       * Wraps every failure into the classified, secret-redacted error
       * shape; the response body is never carried along.
       */
      const fail = (error, { transient = false, service = false } = {}) => {
        if (error instanceof EntraRefreshError) {
          reject(error);
          return;
        }
        const contextual = createContextualError(operation, endpoint, error, {
          fallbackCode: ERROR_CODES.TRANSIENT,
          secrets,
        });
        if (transient) {
          reject(transientRefreshError(contextual.message));
          return;
        }
        if (service) {
          reject(serviceRefreshError(contextual.message));
          return;
        }
        reject(
          contextual instanceof EntraRefreshError
            ? contextual
            : transientRefreshError(contextual.message)
        );
      };

      let req;
      let requestAborted = false;
      let responseRejected = false;
      try {
        req = https.request(endpoint, requestOptions, (res) => {
          let responseData = '';
          let responseBytes = 0;
          res.on('data', (chunk) => {
            responseBytes += chunk.length;
            if (responseBytes > REFRESH_MAX_RESPONSE_BYTES && !responseRejected) {
              responseRejected = true;
              fail(new Error('The token response exceeded the maximum allowed size'));
              if (typeof req.destroy === 'function') {
                req.destroy();
              }
              return;
            }
            if (!responseRejected) {
              responseData += chunk;
            }
          });
          res.on('error', (error) => {
            if (!responseRejected) {
              responseRejected = true;
              fail(error, { transient: true });
            }
          });
          res.on('end', () => {
            if (responseRejected || requestAborted) {
              return;
            }
            responseRejected = true;
            if (res.statusCode >= 200 && res.statusCode < 300) {
              let responseBody;
              try {
                responseBody = JSON.parse(responseData || '{}');
              } catch {
                fail(new Error('The token response was not a usable JSON document'), {
                  transient: true,
                });
                return;
              }
              if (!isPlainObject(responseBody)) {
                fail(new Error('The token response was not a usable JSON document'), {
                  transient: true,
                });
                return;
              }
              try {
                const accessToken = validateReturnedCredential(responseBody.access_token);
                const expiresIn = Number(responseBody.expires_in);
                if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
                  throw transientRefreshError(
                    'The token response carried no positive finite expires_in'
                  );
                }
                if (responseBody.refresh_token !== undefined) {
                  // Strict shape validation: a malformed (or oversized, or
                  // whitespace-carrying) rotation is dropped, never stored
                  // or returned, and the result never pretends a grant.
                  const rotated = responseBody.refresh_token;
                  const rotatedValid =
                    isNonEmptyString(typeof rotated === 'string' ? rotated : '') &&
                    rotated.length <= MAX_TOKEN_LENGTH &&
                    !/\s/.test(rotated);
                  resolve({
                    accessToken,
                    expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
                    ...(rotatedValid ? { refreshToken: rotated } : {}),
                  });
                  return;
                }
                resolve({ accessToken, expiresAt: Math.floor(Date.now() / 1000) + expiresIn });
              } catch (error) {
                fail(
                  error instanceof EntraRefreshError ? error : transientRefreshError(error.message)
                );
              }
              return;
            }
            let responseBody = null;
            try {
              responseBody = isNonEmptyString(responseData)
                ? JSON.parse(responseData || '{}')
                : null;
            } catch {
              responseBody = null;
            }
            if (res.statusCode >= 500) {
              fail(new Error(`The token endpoint answered with status ${res.statusCode}`), {
                transient: true,
              });
              return;
            }
            if (!isPlainObject(responseBody)) {
              fail(
                new Error(
                  `The token endpoint answered with status ${res.statusCode} and no OAuth error`
                ),
                { transient: true }
              );
              return;
            }
            fail(classifyOAuthRejection(responseBody, res.statusCode, operation));
          });
        });
      } catch (error) {
        fail(error, { transient: true });
        return;
      }

      req.setTimeout(normalized.timeoutMs, () => {
        requestAborted = true;
        req.destroy(
          new Error(`Request timed out after ${Math.round(normalized.timeoutMs / 1000)} seconds`)
        );
      });
      req.on('error', (error) => {
        if (!responseRejected) {
          responseRejected = true;
          fail(error, { transient: true });
        }
      });
      req.write(postData);
      req.end();
    });
  }

  return { refresh };
}

module.exports = {
  createEntraTokenRefresher,
  EntraRefreshError,
  ERROR_CODES,
  REAUTH_REQUIRED,
};
