/**
 * Entra inbound access-token validation for the future intranet MCP HTTP transport.
 *
 * Bounded unit (task T2, S1-S3): cryptographically verifies a delegated-access
 * access token issued by the configured tenant, then validates issuer, intended
 * MCP audience, expiration, tenant, and delegated user identity/scopes.
 * Fails closed for invalid tokens and invalid configuration.
 *
 * Not wired here by design: this module exposes no HTTP endpoints and performs
 * no Graph on-behalf-of exchange. Verified delegated identity is the only gate
 * the server applies before dispatch (S3): there is no separate mutation
 * group/role policy — authorization beyond authentication is owned by the
 * Entra enterprise-application assignment and Microsoft 365 delegated
 * permissions.
 *
 * Errors and logs never contain the presented token or key material.
 */
const jwt = require('jsonwebtoken');
const jwksRsa = require('jwks-rsa');

const ENTRA_GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALLOWED_CONFIG_KEYS = [
  'tenantId',
  'audience',
  'issuer',
  'jwksUri',
  'jwksClient',
  'requiredScopes',
  'clockTolerance',
];

const ERROR_CODES = {
  CONFIG: 'entra-config-invalid',
  INVALID: 'entra-token-invalid',
  EXPIRED: 'entra-token-expired',
  UNTRUSTED: 'entra-token-untrusted',
  DELEGATED_REQUIRED: 'entra-token-delegated-required',
  INSUFFICIENT_SCOPE: 'entra-token-insufficient-scope',
};

class EntraAuthError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EntraAuthError';
    this.code = code;
  }
}

function configError(message) {
  return new EntraAuthError(ERROR_CODES.CONFIG, message);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isJwksClientLike(value) {
  return value !== null && typeof value === 'object' && typeof value.getSigningKey === 'function';
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validates and normalizes verifier configuration. Unknown keys, missing
 * tenant/audience binding, or a bad injected client all fail closed.
 */
function validateVerifierConfig(config) {
  if (!isPlainObject(config)) {
    throw configError('tenantId and audience are required to create the Entra verifier');
  }

  const unknownKeys = Object.keys(config).filter((key) => !ALLOWED_CONFIG_KEYS.includes(key));
  if (unknownKeys.length > 0) {
    throw configError(`unexpected verifier options: ${unknownKeys.join(', ')}`);
  }

  if (!isNonEmptyString(config.tenantId) || !ENTRA_GUID_PATTERN.test(config.tenantId)) {
    throw configError('tenantId must be a non-empty Entra directory (tenant) GUID');
  }

  if (!isNonEmptyString(config.audience)) {
    throw configError('audience must be a non-empty string identifying this MCP deployment');
  }

  if (config.jwksUri !== undefined && !isNonEmptyString(config.jwksUri)) {
    throw configError('jwksUri must be a non-empty string');
  }

  if (config.jwksClient !== undefined && !isJwksClientLike(config.jwksClient)) {
    throw configError('jwksClient, when provided, must be a JWKS client with getSigningKey');
  }

  if (config.issuer !== undefined && !isNonEmptyString(config.issuer)) {
    throw configError('issuer must be a non-empty string');
  }

  if (config.requiredScopes !== undefined) {
    if (
      !Array.isArray(config.requiredScopes) ||
      config.requiredScopes.some((scope) => !isNonEmptyString(scope))
    ) {
      throw configError('requiredScopes must be an array of non-empty strings');
    }
  }

  if (config.clockTolerance !== undefined) {
    if (!Number.isFinite(config.clockTolerance) || config.clockTolerance < 0) {
      throw configError('clockTolerance must be a finite non-negative number of seconds');
    }
  }

  const tenantId = config.tenantId.toLowerCase();
  return {
    tenantId,
    audience: config.audience,
    issuer: config.issuer || `https://login.microsoftonline.com/${tenantId}/v2.0`,
    jwksUri: config.jwksUri || `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`,
    jwksClient: config.jwksClient,
    requiredScopes: (config.requiredScopes || []).map((scope) => scope),
    clockTolerance: config.clockTolerance === undefined ? 60 : config.clockTolerance,
  };
}

/**
 * Builds a JWKS client for the tenant discovery endpoint. Kept internal so
 * tests inject a local mocked client instead of touching the network.
 */
function createTenantJwksClient(jwksUri) {
  return new jwksRsa.JwksClient({
    jwksUri,
    cache: true,
    cacheMaxAge: 10 * 60 * 1000,
    rateLimit: true,
    jwksRequestsPerMinute: 30,
  });
}

/**
 * Maps jsonwebtoken failures to coarse, secret-free error codes. The original
 * library messages (which may quote expected validation targets) are never
 * surfaced outward.
 */
function mapJwtError(error) {
  if (error instanceof EntraAuthError) {
    return error;
  }
  if (error && error.name === 'TokenExpiredError') {
    return new EntraAuthError(ERROR_CODES.EXPIRED, 'The access token has expired');
  }
  if (error instanceof jwt.JsonWebTokenError) {
    if (/invalid signature|unable to match|secret or public key/i.test(error.message)) {
      return new EntraAuthError(
        ERROR_CODES.UNTRUSTED,
        'The access token signature is not trusted for this tenant'
      );
    }
    return new EntraAuthError(
      ERROR_CODES.INVALID,
      'The access token failed issuer, audience, or format validation'
    );
  }
  return new EntraAuthError(ERROR_CODES.INVALID, 'The access token could not be validated');
}

/**
 * Validates the delegated identity contract on the verified payload and
 * returns a minimal, secret-free identity projection.
 */
function buildDelegatedIdentity(payload, normalized) {
  if (!isPlainObject(payload)) {
    throw new EntraAuthError(ERROR_CODES.INVALID, 'The access token payload is not readable');
  }

  // jsonwebtoken only validates exp when present; an Entra delegated token
  // must carry a finite numeric expiry, otherwise it cannot be trusted to age out.
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
    throw new EntraAuthError(
      ERROR_CODES.INVALID,
      'The access token does not carry a valid expiration claim'
    );
  }

  const tokenTenantId = typeof payload.tid === 'string' ? payload.tid.toLowerCase() : '';
  if (tokenTenantId !== normalized.tenantId) {
    throw new EntraAuthError(
      ERROR_CODES.INVALID,
      'The access token was issued for a different tenant'
    );
  }

  if (!isNonEmptyString(payload.oid)) {
    throw new EntraAuthError(
      ERROR_CODES.DELEGATED_REQUIRED,
      'The access token must carry a delegated user identity and user scopes'
    );
  }

  const scopes = isNonEmptyString(payload.scp)
    ? payload.scp.split(/\s+/).filter((scope) => scope.length > 0)
    : [];
  if (scopes.length === 0) {
    throw new EntraAuthError(
      ERROR_CODES.DELEGATED_REQUIRED,
      'The access token must carry user scopes delegated to this MCP deployment'
    );
  }
  const missingScopes = normalized.requiredScopes.filter(
    (requiredScope) => !scopes.includes(requiredScope)
  );
  if (missingScopes.length > 0) {
    throw new EntraAuthError(
      ERROR_CODES.INSUFFICIENT_SCOPE,
      'The access token is missing one or more required scopes'
    );
  }

  return {
    subject: payload.sub,
    objectId: payload.oid,
    tenantId: normalized.tenantId,
    username: payload.preferred_username || payload.upn || payload.email || '',
    scopes,
    groups: Array.isArray(payload.groups) ? payload.groups : [],
    roles: Array.isArray(payload.roles) ? payload.roles : [],
    issuedAt: payload.iat,
    authTime: payload.auth_time,
  };
}

/**
 * Creates an Entra inbound access-token verifier for one tenant and audience.
 * Signature keys always resolve through the tenant JWKS (injected client in
 * tests, cached discovery client in production); nothing trusts embedded keys.
 */
function createEntraTokenVerifier(config) {
  const normalized = validateVerifierConfig(config);
  const jwksClient = normalized.jwksClient || createTenantJwksClient(normalized.jwksUri);
  const signingAlgorithms = ['RS256'];

  async function resolveSigningKey(header) {
    if (!isPlainObject(header) || !isNonEmptyString(header.kid)) {
      throw new EntraAuthError(
        ERROR_CODES.UNTRUSTED,
        'The access token does not identify a tenant signing key'
      );
    }
    try {
      const key = await jwksClient.getSigningKey(header.kid);
      const publicKey = key && (key.getPublicKey ? key.getPublicKey() : key.publicKey);
      if (!isNonEmptyString(publicKey)) {
        throw new EntraAuthError(
          ERROR_CODES.UNTRUSTED,
          'The tenant signing key could not be resolved'
        );
      }
      return publicKey;
    } catch (error) {
      if (error instanceof EntraAuthError) {
        throw error;
      }
      throw new EntraAuthError(
        ERROR_CODES.UNTRUSTED,
        'The tenant signing key is unavailable for this token'
      );
    }
  }

  /**
   * Verifies one access token. Resolves with the delegated identity or rejects
   * with an EntraAuthError. The token itself never appears in any error.
   */
  async function verifyAccessToken(token) {
    if (!isNonEmptyString(token)) {
      throw new EntraAuthError(ERROR_CODES.INVALID, 'An access token is required');
    }

    const payload = await new Promise((resolve, reject) => {
      jwt.verify(
        token,
        async (header, callback) => {
          try {
            callback(null, await resolveSigningKey(header));
          } catch (error) {
            callback(error);
          }
        },
        {
          algorithms: signingAlgorithms,
          audience: normalized.audience,
          issuer: normalized.issuer,
          clockTolerance: normalized.clockTolerance,
        },
        (error, verified) => {
          if (error) {
            reject(mapJwtError(error));
            return;
          }
          resolve(verified);
        }
      );
    });

    return buildDelegatedIdentity(payload, normalized);
  }

  return { verifyAccessToken };
}

module.exports = {
  createEntraTokenVerifier,
  EntraAuthError,
  ERROR_CODES,
};
