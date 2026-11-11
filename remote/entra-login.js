/**
 * Entra upstream authorization-code sign-in foundation for the future intranet
 * MCP HTTP transport (task T6, S1-S3, S5).
 *
 * Bounded unit: for one concurrent login at a time-independent in-memory
 * transaction, this module
 *   - draws cryptographically random one-time `state`, `nonce`, and PKCE
 *     S256 `code_verifier`/`code_challenge` values,
 *   - builds the tenant authorization URL strictly from a trusted configured
 *     tenant and the configured exact redirect URI (HTTPS, or an exact
 *     loopback http:// URL only under the explicit local development opt-in;
 *     callers can never influence either), and
 *   - redeems the one-time authorization code with the configured
 *     confidential client, then validates the returned ID token signature,
 *     issuer, audience, expiry, tenant, nonce, and delegated user identity
 *     using jsonwebtoken against the tenant JWKS.
 *
 * Safety rules enforced here:
 *   - Transactions are short-lived and strictly single use: an unknown,
 *     expired, or already-consumed state is always rejected, and a provider
 *     error callback consumes the transaction too.
 *   - Return context binds only to prevalidated transaction data; the caller
 *     cannot inject nonce, redirect, tenant, or identity values.
 *   - No token, client secret, code, or verifier is ever stored, logged, or
 *     returned to a browser. The result carries only a minimal identity
 *     projection; the wiring-only `completeLoginWithUpstream` additionally
 *     resolves the server-side upstream access-token association (with an
 *     explicit expiry) that the standards-based MCP OAuth flow consumes
 *     through `completeAuthorizationAfterEntraSignIn` for its later
 *     on-behalf-of exchange. That association never leaves the server
 *     process and is not a stored credential: when it expires, the flow
 *     must be repeated.
 *   - Errors never contain secret material; token-endpoint failures go
 *     through the shared redacting contextual-error and Entra-OAuth-error
 *     helpers.
 *   - No cookies, no global user token, no token-file storage, no HTTP
 *     endpoints, and no Graph passthrough live in this module.
 *
 * The upstream Microsoft sign-in alone authenticates no MCP client: the
 * standards-based MCP OAuth authorization-server flow (authorization
 * endpoint, discovery, consent, and browser-to-external-client handoff for
 * OpenCode/LibreChat/Claude/Codex-style clients) lives in the HTTP wiring
 * (`remote/http-server.js`) on top of `remote/oauth-provider.js`.
 */
const crypto = require('crypto');
const https = require('https');
const querystring = require('querystring');
const jwt = require('jsonwebtoken');
const jwksRsa = require('jwks-rsa');
const { createEntraOAuthError } = require('../auth/entra-error');
const { createContextualError } = require('../utils/network-error');

const DEFAULT_AUTHORITY_HOST = 'https://login.microsoftonline.com';
const DEFAULT_TRANSACTION_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_TRANSACTIONS = 200;
const REDEEM_TIMEOUT_MS = 30000;
const REDEEM_MAX_RESPONSE_BYTES = 64 * 1024;
const ENTRA_GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_STATE_LENGTH = 512;
const MAX_CODE_LENGTH = 2048;
/** T19: the refresh credential shape matches the shared bounded credential bound. */
const MAX_TOKEN_LENGTH = 4096;
// T13 (S1-S9) real-tenant diagnostic bound: the claim-NAME list emitted on
// the delegated-identity-missing path is truncated to this many names plus
// an explicit count so the log line stays short no matter what the tenant
// mints into the token.
const MAX_DIAGNOSTIC_CLAIM_NAMES = 40;

const ERROR_CODES = {
  CONFIG: 'entra-config-invalid',
  INVALID_PARAMETERS: 'entra-login-invalid-parameters',
  UNKNOWN_STATE: 'entra-login-unknown-state',
  EXPIRED: 'entra-login-expired',
  CAPACITY: 'entra-login-capacity',
  ACCESS_DENIED: 'entra-login-access-denied',
  REDEEM_FAILED: 'entra-login-redeem-failed',
  UPSTREAM_MISSING: 'entra-login-upstream-token-missing',
  ID_TOKEN_INVALID: 'entra-login-id-token-invalid',
  ID_TOKEN_EXPIRED: 'entra-login-id-token-expired',
  ID_TOKEN_UNTRUSTED: 'entra-login-id-token-untrusted',
  NONCE_MISMATCH: 'entra-login-nonce-mismatch',
};

const ALLOWED_CONFIG_KEYS = [
  'tenantId',
  'clientId',
  'clientSecret',
  'redirectUri',
  'scopes',
  'authorityHost',
  'issuer',
  'jwksClient',
  'transactionTtlMs',
  'maxTransactions',
  'clockTolerance',
  // T9 (S4-S6): explicit opt-in that additionally accepts an exact loopback
  // plaintext callback (for example http://localhost:8443/login/callback).
  // Microsoft documents plain HTTP redirect URIs only for loopback
  // addresses; without the option the redirect URI must be HTTPS.
  'allowLoopbackHttpRedirect',
];

const ALLOWED_COMPLETION_KEYS = ['state', 'code', 'error'];

class EntraLoginError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EntraLoginError';
    this.code = code;
  }
}

function isError(message, code) {
  const error = new EntraLoginError(code, message);
  return error;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function configError(message) {
  return isError(message, ERROR_CODES.CONFIG);
}

function parameterError(message) {
  return isError(message, ERROR_CODES.INVALID_PARAMETERS);
}

/**
 * Exact loopback hostnames for the explicitly opted-in local development
 * HTTP callback: a plaintext redirect URI is never accepted for an intranet
 * or public address, even when the option is enabled.
 */
const LOOPBACK_REDIRECT_HOSTNAMES = new Set([
  '127.0.0.1',
  'localhost',
  'localhost.localdomain',
  '::1',
]);

/**
 * Validates a callback endpoint like validateHttpsUrl, but additionally
 * accepts a plaintext http:// URL when, and only when, its hostname is an
 * exact loopback address. Callers opt into this through the explicit local
 * development mode; the unbracketed lowercase hostname is matched against
 * the exact loopback set.
 */
function validateCallbackUrl(rawUrl, label, allowLoopbackHttp) {
  const httpsError = () =>
    allowLoopbackHttp
      ? `${label} must be an HTTPS or exact loopback HTTP URL without credentials, query, or hash`
      : `${label} must be a valid HTTPS URL`;
  const credentialError = () => `${label} must be an HTTPS URL without embedded credentials`;
  const structureError = () => `${label} must be an HTTPS URL without query or hash`;
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch {
    throw configError(httpsError());
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const isLoopback = LOOPBACK_REDIRECT_HOSTNAMES.has(hostname);
  const protocolAllowed =
    parsed.protocol === 'https:' ||
    (allowLoopbackHttp === true && parsed.protocol === 'http:' && isLoopback);
  if (!protocolAllowed || !parsed.hostname) {
    throw configError(httpsError());
  }
  if (parsed.username || parsed.password) {
    throw configError(credentialError());
  }
  if (parsed.search || parsed.hash) {
    throw configError(structureError());
  }
  return parsed;
}

/**
 * Validates an authority or callback endpoint as a strict HTTPS URL: a
 * parseable URL, https scheme, a hostname, no embedded credentials, and no
 * query or hash. The redirect URI must additionally be returned exactly as
 * configured, so only its safety (never its shape) is normalized here.
 */
function validateHttpsUrl(rawUrl, label) {
  return validateCallbackUrl(rawUrl, label, false);
}

/**
 * Mirrors the strict MS_AUTHORITY_HOST normalization used by the OBO token
 * store: an HTTPS origin without credentials, path, query, or hash.
 */
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

function isClientLike(value) {
  return value !== null && typeof value === 'object' && typeof value.getSigningKey === 'function';
}

/**
 * Validates and pins every network-relevant endpoint at creation time so a
 * later environment change can never redirect in-flight secrets elsewhere.
 */
function validateLoginConfig(config) {
  if (!isPlainObject(config)) {
    throw configError('tenantId, client credentials, redirectUri, and scopes are required');
  }

  const unknownKeys = Object.keys(config).filter((key) => !ALLOWED_CONFIG_KEYS.includes(key));
  if (unknownKeys.length > 0) {
    throw configError(`unexpected Entra login options: ${unknownKeys.join(', ')}`);
  }
  // The loopback plaintext allowance is opt-in and boolean: any other value
  // (including mistyped strings) fails closed instead of silently disabling
  // the default HTTPS requirement.
  if (config.allowLoopbackHttpRedirect !== undefined && config.allowLoopbackHttpRedirect !== true) {
    throw configError(
      'allowLoopbackHttpRedirect must be exactly true when provided; it opts into plaintext loopback callbacks for local development only'
    );
  }

  if (!isNonEmptyString(config.tenantId) || !ENTRA_GUID_PATTERN.test(config.tenantId)) {
    throw configError(
      'tenantId must be a specific trusted Entra directory (tenant) GUID, never common'
    );
  }
  const tenantId = config.tenantId.toLowerCase();

  if (!isNonEmptyString(config.clientId) || config.clientId.trim().length === 0) {
    throw configError('clientId must be a non-empty confidential client identifier');
  }
  if (!isNonEmptyString(config.clientSecret) || config.clientSecret.trim().length === 0) {
    throw configError('clientSecret must be a non-empty confidential client secret');
  }
  if (!isNonEmptyString(config.redirectUri)) {
    throw configError('redirectUri must be a non-empty exact HTTPS callback URL');
  }
  validateCallbackUrl(config.redirectUri, 'redirectUri', config.allowLoopbackHttpRedirect);

  if (
    !Array.isArray(config.scopes) ||
    config.scopes.length === 0 ||
    config.scopes.some(
      (scope) => !isNonEmptyString(typeof scope === 'string' ? scope.trim() : scope)
    )
  ) {
    throw configError('scopes must be a non-empty array of non-empty scope strings');
  }

  const authorityHost = normalizeAuthorityHost(
    config.authorityHost || process.env.MS_AUTHORITY_HOST || DEFAULT_AUTHORITY_HOST
  );

  const issuer = config.issuer || `${authorityHost}/${tenantId}/v2.0`;
  if (!isNonEmptyString(issuer)) {
    throw configError('issuer must be a non-empty string when provided');
  }
  validateHttpsUrl(issuer, 'issuer');

  if (config.jwksClient !== undefined && !isClientLike(config.jwksClient)) {
    throw configError('jwksClient, when provided, must be a JWKS client with getSigningKey');
  }

  let transactionTtlMs = config.transactionTtlMs;
  if (transactionTtlMs === undefined) {
    transactionTtlMs = DEFAULT_TRANSACTION_TTL_MS;
  }
  if (!Number.isFinite(transactionTtlMs) || transactionTtlMs <= 0) {
    throw configError('transactionTtlMs must be a finite positive number of milliseconds');
  }

  let maxTransactions = config.maxTransactions;
  if (maxTransactions === undefined) {
    maxTransactions = DEFAULT_MAX_TRANSACTIONS;
  }
  if (!Number.isInteger(maxTransactions) || maxTransactions <= 0) {
    throw configError('maxTransactions must be a positive integer');
  }

  let clockTolerance = config.clockTolerance;
  if (clockTolerance === undefined) {
    clockTolerance = 60;
  }
  if (!Number.isFinite(clockTolerance) || clockTolerance < 0) {
    throw configError('clockTolerance must be a finite non-negative number of seconds');
  }

  return {
    tenantId,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: config.redirectUri,
    scopes: config.scopes
      .map((scope) => scope.trim())
      .filter((scope, index, all) => all.indexOf(scope) === index),
    authorityHost,
    issuer,
    jwksUri: `${authorityHost}/${tenantId}/discovery/v2.0/keys`,
    tokenEndpoint: `${authorityHost}/${tenantId}/oauth2/v2.0/token`,
    authorizeEndpoint: `${authorityHost}/${tenantId}/oauth2/v2.0/authorize`,
    jwksClient: config.jwksClient,
    transactionTtlMs,
    maxTransactions,
    clockTolerance,
  };
}

/**
 * The OIDC `openid` scope is always included so Entra returns an ID token
 * whose nonce can be validated. The OIDC `profile` scope is also always
 * included: Entra only emits the delegated `oid` (and profile) identity
 * claims in ID tokens when the `profile` scope was requested. The caller's
 * configured scopes stay intact.
 *
 * T19: the OIDC `offline_access` scope is also always included exactly once,
 * so Microsoft issues the server-side upstream refresh credential the
 * persistent bridge renews delegated access with. The caller's configured
 * upstream API scopes stay intact.
 */
function buildScopeParam(scopes) {
  const union = [...scopes];
  if (!union.includes('openid')) {
    union.push('openid');
  }
  if (!union.includes('profile')) {
    union.push('profile');
  }
  if (!union.includes('offline_access')) {
    union.push('offline_access');
  }
  return union.join(' ');
}

/**
 * Constant-time comparison for equal-purpose base64url strings of possibly
 * differing length; length differences fail immediately by design.
 */
function timingSafeEqualString(left, right) {
  if (!isNonEmptyString(left) || !isNonEmptyString(right) || left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

/**
 * OIDC authorized-party check: a multi-audience ID token may only be trusted
 * when its `azp` claim names this exact client, and any present `azp` must
 * equal this client. Single-audience tokens without `azp` stay accepted.
 */
function validateAuthorizedParty(payload, normalized) {
  const authorizedParty = typeof payload.azp === 'string' ? payload.azp : null;
  const multiAudience = Array.isArray(payload.aud) && payload.aud.length > 1;
  if (authorizedParty !== null) {
    if (authorizedParty !== normalized.clientId) {
      throw isError(
        'The upstream ID token was issued for a different authorized party',
        ERROR_CODES.ID_TOKEN_INVALID
      );
    }
  } else if (multiAudience) {
    throw isError(
      'The upstream ID token names multiple audiences without the required azp claim',
      ERROR_CODES.ID_TOKEN_INVALID
    );
  }
}

function mapJwtError(error) {
  if (error instanceof EntraLoginError) {
    return error;
  }
  if (error && error.name === 'TokenExpiredError') {
    return isError('The upstream ID token has expired', ERROR_CODES.ID_TOKEN_EXPIRED);
  }
  if (error instanceof jwt.JsonWebTokenError) {
    if (/invalid signature|unable to match|secret or public key/i.test(error.message)) {
      return isError(
        'The upstream ID token signature is not trusted for this tenant',
        ERROR_CODES.ID_TOKEN_UNTRUSTED
      );
    }
    return isError(
      'The upstream ID token failed issuer, audience, or format validation',
      ERROR_CODES.ID_TOKEN_INVALID
    );
  }
  return isError('The upstream ID token could not be validated', ERROR_CODES.ID_TOKEN_INVALID);
}

/**
 * Classifies a verified ID token's `ver` claim into a fixed, value-free
 * bucket (`token-version=v2` / `v1` / `uncounted`) without ever returning or
 * logging the raw claim value itself.
 */
function classifyTokenVersion(ver) {
  if (ver === '2.0') {
    return 'token-version=v2';
  }
  if (ver === '1.0' || ver === 1) {
    return 'token-version=v1';
  }
  return 'token-version=uncounted';
}

/**
 * T13 (S1-S9) fail-safe, value-free diagnostic for the real-tenant case where
 * the verified ID token lacks the delegated `oid` claim. It emits ONLY the
 * sorted claim NAMES the payload carried, truncated to a bounded count, so
 * the next real login can be classified by which claims the tenant exposed
 * without ever logging a claim value, the token, or any credential. It is
 * called from the missing-identity path only and never runs when `oid` is
 * present; the identity validation rule itself stays unchanged.
 */
function logMissingIdentityClaimNames(payload) {
  const names = isPlainObject(payload) ? Object.keys(payload).sort() : ['<unreadable>'];
  const shown = names.slice(0, MAX_DIAGNOSTIC_CLAIM_NAMES);
  const suffix = names.length > shown.length ? ` (+${names.length - shown.length} more)` : '';
  const version = classifyTokenVersion(isPlainObject(payload) ? payload.ver : undefined);
  console.error(
    `[entra-login] id-token diagnostic (oid claim missing; claim names only, values excluded): ${shown.join(', ')}${suffix}; ${version}`
  );
}

/**
 * Validates the delegated identity contract on the verified ID token payload
 * and projects only safe, allow-listed identity fields. No claim value is
 * returned verbatim beyond these projection keys.
 */
function buildVerifiedIdentity(payload, normalized) {
  if (!isPlainObject(payload)) {
    throw isError('The upstream ID token payload is not readable', ERROR_CODES.ID_TOKEN_INVALID);
  }
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
    throw isError(
      'The upstream ID token does not carry a valid expiration claim',
      ERROR_CODES.ID_TOKEN_INVALID
    );
  }
  const tokenTenantId = typeof payload.tid === 'string' ? payload.tid.toLowerCase() : '';
  if (tokenTenantId !== normalized.tenantId) {
    throw isError(
      'The upstream ID token was issued for a different tenant',
      ERROR_CODES.ID_TOKEN_INVALID
    );
  }
  if (!isNonEmptyString(payload.oid)) {
    logMissingIdentityClaimNames(payload);
    throw isError(
      'The upstream ID token must carry a delegated user identity',
      ERROR_CODES.ID_TOKEN_INVALID
    );
  }

  return {
    subject: payload.sub,
    objectId: payload.oid,
    tenantId: normalized.tenantId,
    username: payload.preferred_username || payload.upn || payload.email || '',
    name: typeof payload.name === 'string' ? payload.name : undefined,
    // Group/role claims (when the application exposes them) keep the future
    // wiring compatible with the separate mutation-authorization predicate.
    groups: Array.isArray(payload.groups) ? payload.groups : [],
    roles: Array.isArray(payload.roles) ? payload.roles : [],
    issuedAt: Number.isFinite(payload.iat) ? payload.iat : undefined,
    authTime: Number.isFinite(payload.auth_time) ? payload.auth_time : undefined,
  };
}

/**
 * Creates one concurrent-capable upstream Entra login coordinator. Every
 * instance owns its own transaction map, so instances never share state and
 * one deployment can hold one coordinator per transport context.
 */
function createEntraLogin(config) {
  const normalized = validateLoginConfig(config);
  const jwksClient = normalized.jwksClient || createJwksClient(normalized.jwksUri);
  /** @type {Map<string, {nonce: string, codeVerifier: string, expiresAt: number}>} */
  const transactions = new Map();

  function createJwksClient(jwksUri) {
    return new jwksRsa.JwksClient({
      jwksUri,
      cache: true,
      cacheMaxAge: 10 * 60 * 1000,
      rateLimit: true,
      jwksRequestsPerMinute: 30,
    });
  }

  async function resolveSigningKey(header) {
    if (!isPlainObject(header) || !isNonEmptyString(header.kid)) {
      throw isError(
        'The upstream ID token does not identify a tenant signing key',
        ERROR_CODES.ID_TOKEN_UNTRUSTED
      );
    }
    try {
      const key = await jwksClient.getSigningKey(header.kid);
      const publicKey = key && (key.getPublicKey ? key.getPublicKey() : key.publicKey);
      if (!isNonEmptyString(publicKey)) {
        throw isError(
          'The tenant signing key could not be resolved',
          ERROR_CODES.ID_TOKEN_UNTRUSTED
        );
      }
      return publicKey;
    } catch (error) {
      if (error instanceof EntraLoginError) {
        throw error;
      }
      throw isError(
        'The tenant signing key is unavailable for this token',
        ERROR_CODES.ID_TOKEN_UNTRUSTED
      );
    }
  }

  function purgeExpiredTransactions(now) {
    for (const [state, transaction] of transactions) {
      if (transaction.expiresAt <= now) {
        transactions.delete(state);
      }
    }
  }

  /**
   * Starts one upstream sign-in transaction. Takes no options on purpose:
   * both the tenant and the redirect destination come from the validated
   * configuration, so no caller input can turn this into an open redirect.
   */
  function beginLogin() {
    if (arguments.length > 0) {
      throw parameterError('beginLogin accepts no options; use the configured trusted values');
    }

    const now = Date.now();
    purgeExpiredTransactions(now);
    if (transactions.size >= normalized.maxTransactions) {
      throw isError(
        'Too many concurrent sign-in transactions; try again shortly',
        ERROR_CODES.CAPACITY
      );
    }

    const state = crypto.randomBytes(32).toString('base64url');
    const nonce = crypto.randomBytes(32).toString('base64url');
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

    const expiresAt = now + normalized.transactionTtlMs;
    transactions.set(state, { nonce, codeVerifier, expiresAt });

    const authorizationUrl = new URL(normalized.authorizeEndpoint);
    authorizationUrl.searchParams.append('client_id', normalized.clientId);
    authorizationUrl.searchParams.append('response_type', 'code');
    authorizationUrl.searchParams.append('redirect_uri', normalized.redirectUri);
    authorizationUrl.searchParams.append('response_mode', 'query');
    authorizationUrl.searchParams.append('scope', buildScopeParam(normalized.scopes));
    authorizationUrl.searchParams.append('state', state);
    authorizationUrl.searchParams.append('nonce', nonce);
    authorizationUrl.searchParams.append('code_challenge', codeChallenge);
    authorizationUrl.searchParams.append('code_challenge_method', 'S256');

    return { authorizationUrl: authorizationUrl.toString(), state, expiresAt };
  }

  /**
   * Redeems the consumed transaction's code at the pinned tenant token
   * endpoint through the shared safe HTTPS conventions: form POST, timeout,
   * and secret-redacting contextual errors.
   */
  function redeemAuthorizationCode(code, codeVerifier) {
    const operation = 'Entra upstream authorization code redemption';
    const endpoint = normalized.tokenEndpoint;

    const postData = querystring.stringify({
      grant_type: 'authorization_code',
      client_id: normalized.clientId,
      client_secret: normalized.clientSecret,
      code,
      redirect_uri: normalized.redirectUri,
      code_verifier: codeVerifier,
    });

    const requestOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const secrets = [normalized.clientSecret, code, codeVerifier];

    return new Promise((resolve, reject) => {
      const fail = (error) => {
        reject(
          createContextualError(operation, endpoint, error, {
            fallbackCode: ERROR_CODES.REDEEM_FAILED,
            secrets,
          })
        );
      };

      let req;
      try {
        req = https.request(endpoint, requestOptions, (res) => {
          let responseData = '';
          let responseBytes = 0;
          let responseRejected = false;
          res.on('data', (chunk) => {
            // Bound the buffered body conservatively before parsing so an
            // oversized or hostile response is rejected, never accumulated.
            responseBytes += chunk.length;
            if (responseBytes > REDEEM_MAX_RESPONSE_BYTES) {
              if (!responseRejected) {
                responseRejected = true;
                fail(new Error('The token response exceeded the maximum allowed size'));
                if (typeof req.destroy === 'function') {
                  req.destroy();
                }
              }
              return;
            }
            responseData += chunk;
          });
          // A socket or stream failure mid-response rejects the redemption
          // instead of leaving the caller hanging.
          res.on('error', fail);
          res.on('end', () => {
            if (responseRejected) {
              return;
            }
            try {
              const responseBody = JSON.parse(responseData || '{}');
              if (res.statusCode >= 200 && res.statusCode < 300) {
                if (!isNonEmptyString(responseBody.id_token)) {
                  fail(new Error('The token response did not include an ID token'));
                  return;
                }
                // The refresh token (when Microsoft issues one) is dropped
                // here and never stored, cached, or returned. The upstream
                // access token is captured server-side only: the wired MCP
                // on-behalf-of exchange resolves it through
                // completeLoginWithUpstream, never toward a browser or client.
                const upstreamAccessToken = isNonEmptyString(responseBody.access_token)
                  ? responseBody.access_token
                  : null;
                const upstreamExpiresIn =
                  Number.isFinite(Number(responseBody.expires_in)) &&
                  Number(responseBody.expires_in) > 0
                    ? Number(responseBody.expires_in)
                    : null;
                // T19: the upstream refresh credential (when Microsoft issues
                // one) stays server-side only, passing into
                // completeLoginWithUpstream for the provider's renewal seam.
                // Strict shape validation: a missing one means no refresh
                // grant exists (the caller never pretends otherwise), and a
                // malformed or oversized one is dropped, never propagated.
                let upstreamRefreshToken;
                if (
                  isNonEmptyString(
                    typeof responseBody.refresh_token === 'string' ? responseBody.refresh_token : ''
                  ) &&
                  responseBody.refresh_token.length <= MAX_TOKEN_LENGTH &&
                  !/\s/.test(responseBody.refresh_token)
                ) {
                  upstreamRefreshToken = responseBody.refresh_token;
                }
                resolve({
                  idToken: responseBody.id_token,
                  upstreamAccessToken,
                  upstreamExpiresIn,
                  upstreamRefreshToken,
                });
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

      req.setTimeout(REDEEM_TIMEOUT_MS, () => {
        req.destroy(new Error(`Request timed out after ${REDEEM_TIMEOUT_MS / 1000} seconds`));
      });
      req.on('error', fail);
      req.write(postData);
      req.end();
    });
  }

  /**
   * Redeems the consumed code and verifies the returned ID token before
   * projecting the identity. Resolves with the verified identity plus the
   * server-side upstream access-token association (when the token endpoint
   * supplied a usable one) or undefined when it did not.
   */
  async function redeemAndVerify(code, transaction) {
    const redemption = await redeemAuthorizationCode(code, transaction.codeVerifier);
    const idToken = redemption.idToken;
    const payload = await new Promise((resolve, reject) => {
      jwt.verify(
        idToken,
        async (header, verifyCallback) => {
          try {
            verifyCallback(null, await resolveSigningKey(header));
          } catch (verificationError) {
            verifyCallback(verificationError);
          }
        },
        {
          algorithms: ['RS256'],
          audience: normalized.clientId,
          issuer: normalized.issuer,
          clockTolerance: normalized.clockTolerance,
        },
        (verifyError, verified) => {
          if (verifyError) {
            reject(mapJwtError(verifyError));
            return;
          }
          resolve(verified);
        }
      );
    });

    const identity = buildVerifiedIdentity(payload, normalized);
    if (!timingSafeEqualString(payload.nonce, transaction.nonce)) {
      throw isError(
        'The upstream ID token nonce does not match this sign-in transaction',
        ERROR_CODES.NONCE_MISMATCH
      );
    }
    validateAuthorizedParty(payload, normalized);

    const upstream =
      redemption.upstreamAccessToken && redemption.upstreamExpiresIn
        ? {
            accessToken: redemption.upstreamAccessToken,
            expiresAt: Math.floor(Date.now() / 1000) + redemption.upstreamExpiresIn,
            ...(redemption.upstreamRefreshToken !== undefined
              ? { refreshToken: redemption.upstreamRefreshToken }
              : {}),
          }
        : undefined;

    return { identity, upstream };
  }

  /**
   * Completes one transaction from prevalidated OAuth callback data only:
   * the one-time state, the returned code, or a provider error code. All
   * other context (nonce, tenant, redirect, identity) comes exclusively from
   * the stored transaction and the freshly verified ID token.
   *
   * Parameter, state, expiry, replay, and provider-error classification throw
   * synchronously; code redemption and ID-token verification resolve through
   * the returned promise.
   */
  function validateCompletionCallback(callback) {
    if (!isPlainObject(callback)) {
      throw parameterError('A callback object with the one-time state is required');
    }
    const unknownKeys = Object.keys(callback).filter(
      (key) => !ALLOWED_COMPLETION_KEYS.includes(key)
    );
    if (unknownKeys.length > 0) {
      throw parameterError(
        `unexpected callback fields; return context binds to the transaction only: ${unknownKeys.join(', ')}`
      );
    }

    const { state } = callback;
    if (!isNonEmptyString(state) || typeof state !== 'string' || state.length > MAX_STATE_LENGTH) {
      throw parameterError('state must be the non-empty one-time state issued by beginLogin');
    }

    const now = Date.now();
    const transaction = transactions.get(state);
    if (!transaction) {
      throw isError(
        'No active sign-in transaction exists for this state',
        ERROR_CODES.UNKNOWN_STATE
      );
    }
    if (transaction.expiresAt <= now) {
      transactions.delete(state);
      throw isError(
        'The sign-in transaction has expired; start a new sign-in',
        ERROR_CODES.EXPIRED
      );
    }

    const { error } = callback;
    if (error !== undefined) {
      transactions.delete(state);
      if (callback.code !== undefined || !isNonEmptyString(error)) {
        throw parameterError('error must be the provider error code alone');
      }
      throw isError(
        `The upstream sign-in ended with provider error: ${error}`,
        ERROR_CODES.ACCESS_DENIED
      );
    }

    const { code } = callback;
    if (
      !isNonEmptyString(code) ||
      typeof code !== 'string' ||
      code.length > MAX_CODE_LENGTH ||
      /\s/.test(code)
    ) {
      throw parameterError('code must be the single non-empty, whitespace-free authorization code');
    }

    // Consume before redemption: one state can never redeem twice, and a
    // failed or replayed completion forces a fresh transaction.
    transactions.delete(state);

    return { state, transaction, code };
  }

  function completeLogin(callback) {
    const { transaction, code } = validateCompletionCallback(callback);
    return redeemAndVerify(code, transaction).then((result) => ({
      identity: result.identity,
      // Explicit contract: the upstream Microsoft sign-in is complete, but
      // this plain completion carries no client authentication by itself.
      mcpOauthFlowWired: false,
    }));
  }

  /**
   * Wiring-only variant of completeLogin for the standards-based MCP OAuth
   * browser flow: resolves the verified identity plus the server-side
   * upstream Entra access-token association that the separate MCP
   * authorization flow needs to run the on-behalf-of exchange. The upstream
   * access token travels only server to server (into
   * completeAuthorizationAfterEntraSignIn); it is never returned to a
   * browser, an MCP client, or a log, and it is never a stored credential:
   * when it expires, the flow must be repeated. Fails closed when the token
   * endpoint supplied no usable access token.
   */
  async function completeLoginWithUpstream(callback) {
    const { transaction, code } = validateCompletionCallback(callback);
    const result = await redeemAndVerify(code, transaction);
    if (!result.upstream || !isNonEmptyString(result.upstream.accessToken)) {
      throw isError(
        'The upstream token response carried no usable access token for the on-behalf-of exchange',
        ERROR_CODES.UPSTREAM_MISSING
      );
    }
    return result;
  }

  return { beginLogin, completeLogin, completeLoginWithUpstream };
}

module.exports = {
  createEntraLogin,
  EntraLoginError,
  ERROR_CODES,
};
