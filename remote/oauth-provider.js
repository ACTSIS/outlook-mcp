/**
 * Standards-based MCP OAuth authorization-server provider foundation for
 * external clients (task T6, S1-S3, S5), built on the installed MCP SDK
 * (`@modelcontextprotocol/sdk` 1.30.0 `OAuthServerProvider`,
 * `mcpAuthRouter` handlers, and `createOAuthMetadata`).
 *
 * Bounded unit: for registered (or SDK-registered) confidential and public
 * MCP clients, this module runs the standards authorization-code flow with
 * locally enforced S256 PKCE and
 *   - single-use, cryptographically random authorization codes and access
 *     tokens with strict expiry, scope, client, redirect, resource, and
 *     user bindings,
 *   - exact registered redirect binding (RFC 8252 loopback port relaxation
 *     is provided by the SDK handler; scheme/host/path/query stay exact),
 *   - RFC 8707 resource binding end to end, and
 *   - a narrow, unwired completion interface that associates a previously
 *     validated upstream Entra access token and delegated identity with the
 *     provider-issued authorization code for later on-behalf-of (OBO) use.
 *
 * Safety rules enforced here:
 *   - Unknown clients are denied; registration is pre-registration by
 *     default, with optional SDK-generated dynamic registration that is
 *     validated and capped. Redirects never leave the registered set, so no
 *     arbitrary open redirect exists at any stage.
 *   - All sensitive credentials (client secrets, codes, tokens, upstream
 *     Entra tokens) live only in bounded per-process in-memory maps owned
 *     by one provider instance. Nothing is ever logged, and no error
 *     message quotes a token, code, verifier, or secret.
 *   - No refresh tokens exist: the refresh grant is rejected and the
 *     corrected advertised metadata claims only the authorization-code
 *     grant. Revocation is not implemented and not advertised.
 *   - The MCP access token is never forwarded downstream, and the upstream
 *     Entra token is never returned to the browser or MCP client; it is
 *     resolvable only server-side through `resolveUpstreamEntraToken` for
 *     the (unwired) OBO exchange step.
 *   - The previously validated upstream Entra access token and identity
 *     (for example from `remote/entra-auth.js`) are accepted exactly as
 *     given; this module performs no upstream token verification of its
 *     own and never enqueues network work.
 *
 * Deliberately bounded limitations (all reported, none hidden):
 *   - Single process only: clustering would share nothing and is explicitly
 *     unsupported. All state evaporates on restart.
 *   - The SDK's `authorize` handler relaxes the port for loopback redirect
 *     URIs (RFC 8252); everything else is exact-match.
 *   - Dynamic client registration trusts the registering caller to provide
 *     usable redirect URIs (standard RFC 7591/9727 behavior) with the
 *     redirect, grant, and auth-method validation and capacity bound of
 *     this deployment; it is disabled by default and only exists when the
 *     deployment explicitly enables it (and wires the route, which nothing
 *     here does).
 *   - Access tokens are bearer tokens reused until expiry (standard) while
 *     authorization codes are strictly single use.
 *
 * Not wired here by design: this module exposes no HTTP server and touches
 * no existing routing; the returned `router` is the unwired SDK-composed
 * route table for a later integration task, the Entra sign-in page is not
 * part of this unit, and no real-client or tenant proof is claimed.
 */
const crypto = require('crypto');
const express = require('express');

const {
  createOAuthMetadata,
  mcpAuthMetadataRouter,
} = require('@modelcontextprotocol/sdk/server/auth/router.js');
const {
  authorizationHandler,
} = require('@modelcontextprotocol/sdk/server/auth/handlers/authorize.js');
const { tokenHandler } = require('@modelcontextprotocol/sdk/server/auth/handlers/token.js');
const {
  clientRegistrationHandler,
} = require('@modelcontextprotocol/sdk/server/auth/handlers/register.js');
const {
  InvalidGrantError,
  InvalidScopeError,
  InvalidClientMetadataError,
  InvalidTokenError,
  ServerError,
} = require('@modelcontextprotocol/sdk/server/auth/errors.js');

const DEFAULT_TOKEN_TTL_SECONDS = 3600;
const DEFAULT_CODE_TTL_SECONDS = 600;
const DEFAULT_PENDING_TTL_SECONDS = 600;
const DEFAULT_MAX_PENDING = 200;
const DEFAULT_MAX_CODES = 200;
const DEFAULT_MAX_TOKENS = 1000;
const DEFAULT_MAX_REGISTERED_CLIENTS = 200;
/** T18: bounded sliding refresh-family TTL. The default is 90 days. */
const DEFAULT_REFRESH_TTL_SECONDS = 90 * 24 * 60 * 60;
/** T19: the bounded TTL cap tightens from ten years to one year. */
const MAX_REFRESH_TTL_SECONDS = 365 * 24 * 60 * 60;
/** Renew the upstream credential when it expires within this window. */
const UPSTREAM_REFRESH_WINDOW_SECONDS = 300;
/** Snapshot format marker; a snapshot from another version fails closed. */
const SNAPSHOT_VERSION = 1;
/** Type-prefixed SHA-256 map keys keep opaque MCP tokens out of snapshots. */
const ACCESS_TOKEN_KEY_PREFIX = 'at:';
const REFRESH_TOKEN_KEY_PREFIX = 'rt:';
const MAX_REFRESH_TOKENS_CAP_MULTIPLIER = 4;
const UPSTREAM_REAUTH_REQUIRED = 'PERMANENT_UPSTREAM_REAUTH_REQUIRED';
const MAX_REDIRECT_URIS_PER_CLIENT = 10;
const MAX_CLIENT_ID_LENGTH = 128;
const MAX_CLIENT_SECRET_LENGTH = 256;
const MAX_TOKEN_LENGTH = 4096;
const MAX_STATE_LENGTH = 512;
const MAX_USERNAME_LENGTH = 320;
const MAX_REDIRECT_URI_LENGTH = 2048;
const ACCESS_TOKEN_BYTES = 32;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const ERROR_CODES = {
  CONFIG: 'mcp-oauth-config-invalid',
  INVALID_PARAMETERS: 'mcp-oauth-invalid-parameters',
  UNKNOWN_REFERENCE: 'mcp-oauth-unknown-reference',
  EXPIRED: 'mcp-oauth-expired',
  CAPACITY: 'mcp-oauth-capacity',
  PERSISTED_STATE: 'mcp-oauth-persisted-state-invalid',
  UPSTREAM_TRANSIENT: 'mcp-oauth-upstream-refresh-transient',
};

const SUPPORTED_CLIENT_GRANTS = ['authorization_code', 'refresh_token'];

const ALLOWED_OPTIONS = [
  'issuerUrl',
  'baseUrl',
  'resourceServerUrl',
  'signInUrl',
  'supportedScopes',
  'clients',
  'allowDynamicRegistration',
  'clientSecretExpirySeconds',
  'accessTokenTtlSeconds',
  'refreshTokenTtlSeconds',
  'authorizationCodeTtlSeconds',
  'pendingAuthorizationTtlSeconds',
  'maxPendingAuthorizations',
  'maxAuthorizationCodes',
  'maxAccessTokens',
  'maxRegisteredClients',
  'persistentStore',
  'refreshUpstreamEntraToken',
  'rateLimit',
];

const ALLOWED_ASSOCIATION_KEYS = ['authorizationRef', 'entra', 'upstream'];

/** Strict keys of the optional upstream credential association field. */
const ALLOWED_ASSOCIATION_UPSTREAM_KEYS = ['refreshToken'];

/**
 * Validates the optional `upstream: { refreshToken }` association field
 * (T19 seam): strict keys, bounded whitespace-free credential, no
 * plaintext MCP token handling involved.
 */
function validateAssociationUpstream(upstream) {
  if (upstream === undefined) {
    return null;
  }
  if (!isPlainObject(upstream)) {
    throw parameterError('the upstream association must be an object');
  }
  const unknownFields = Object.keys(upstream).filter(
    (key) => !ALLOWED_ASSOCIATION_UPSTREAM_KEYS.includes(key)
  );
  if (unknownFields.length > 0) {
    throw parameterError(`unexpected upstream association fields: ${unknownFields.join(', ')}`);
  }
  const refreshToken = upstream.refreshToken;
  if (refreshToken === undefined) {
    return null;
  }
  if (
    !isNonEmptyString(typeof refreshToken === 'string' ? refreshToken : '') ||
    refreshToken.length > MAX_TOKEN_LENGTH ||
    /\s/.test(refreshToken)
  ) {
    throw parameterError('upstream.refreshToken must be a bounded, whitespace-free credential');
  }
  return refreshToken;
}

const ALLOWED_ENTRA_KEYS = [
  'accessToken',
  'expiresAt',
  'objectId',
  'tenantId',
  'username',
  'groups',
  'roles',
];
const MAX_IDENTITY_CLAIMS = 100;
const MAX_IDENTITY_CLAIM_VALUE_LENGTH = 320;

class MCPOAuthProviderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MCPOAuthProviderError';
    this.code = code;
  }
}

function isError(message, code) {
  return new MCPOAuthProviderError(code, message);
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

function randomToken() {
  return crypto.randomBytes(ACCESS_TOKEN_BYTES).toString('base64url');
}

/**
 * Validates a server-configured endpoint as a strict URL: parseable, a
 * hostname, no embedded credentials, and no query or hash. HTTPS is
 * required except for loopback hosts (the SDK grant this same testing
 * exemption to issuer URLs).
 */
function validateEndpointUrl(rawUrl, label) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch {
    throw configError(`${label} must be a valid URL`);
  }
  const isLoopback = LOOPBACK_HOSTS.has(parsed.hostname);
  if (
    (parsed.protocol !== 'https:' && !(isLoopback && parsed.protocol === 'http:')) ||
    !parsed.hostname
  ) {
    throw configError(`${label} must be an HTTPS URL`);
  }
  if (parsed.username || parsed.password) {
    throw configError(`${label} must be a URL without embedded credentials`);
  }
  if (parsed.search || parsed.hash) {
    throw configError(`${label} must be a URL without query or hash`);
  }
  return parsed;
}

/**
 * Validates one registered redirect URI. Same strictness as the endpoint
 * helper; loopback HTTP is allowed for native clients per RFC 8252 and the
 * registered URI is later matched exactly by the SDK handlers.
 */
function validateRedirectUri(rawUri, label) {
  const parsed = validateEndpointUrl(rawUri, label);
  if (parsed.href.length > MAX_REDIRECT_URI_LENGTH) {
    throw configError(`${label} must be at most ${MAX_REDIRECT_URI_LENGTH} characters`);
  }
  return parsed.href;
}

function requirePositiveInteger(value, label, maximum) {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw configError(`${label} must be a positive integer`);
  }
  if (maximum !== undefined && value > maximum) {
    throw configError(`${label} must be at most ${maximum}`);
  }
  return value;
}

function validateSupportedScopes(supportedScopes) {
  if (
    !Array.isArray(supportedScopes) ||
    supportedScopes.length === 0 ||
    supportedScopes.some(
      (scope) => !isNonEmptyString(typeof scope === 'string' ? scope.trim() : scope)
    )
  ) {
    throw configError('supportedScopes must be a non-empty array of non-empty scope strings');
  }
  return [...new Set(supportedScopes.map((scope) => scope.trim()))];
}

/**
 * Validates one dynamic-registration or persisted grant_types array: it
 * must include the authorization_code grant and may only add the
 * refresh_token grant (the two grants the token endpoint implements).
 * Absent or empty input falls back to the authorization-code grant, which
 * preserves the previous non-refresh behavior for registrations without a
 * grant_types array. Returns the canonical SUPPORTED_CLIENT_GRANTS order,
 * or undefined when the array is invalid; call sites throw their own
 * error shapes.
 * @param {unknown} grants
 * @returns {string[] | undefined}
 */
function normalizeClientGrantTypes(grants) {
  const list = Array.isArray(grants) ? grants : [];
  if (list.length === 0) {
    return ['authorization_code'];
  }
  if (
    list.some((grant) => !SUPPORTED_CLIENT_GRANTS.includes(grant)) ||
    !list.includes('authorization_code') ||
    new Set(list).size !== list.length
  ) {
    return undefined;
  }
  return [...list].sort(
    (a, b) => SUPPORTED_CLIENT_GRANTS.indexOf(a) - SUPPORTED_CLIENT_GRANTS.indexOf(b)
  );
}

function validateRegisteredClients(clients) {
  if (clients === undefined) {
    return [];
  }
  if (!Array.isArray(clients)) {
    throw configError('clients must be an array of registered client objects');
  }
  const seen = new Set();
  return clients.map((client) => {
    if (!isPlainObject(client)) {
      throw configError('each registered client must be an object');
    }
    if (!isNonEmptyString(client.clientId) || client.clientId.trim() !== client.clientId) {
      throw configError('clientId must be a non-empty, unpadded, trimmed string');
    }
    if (/\s/.test(client.clientId) || client.clientId.length > MAX_CLIENT_ID_LENGTH) {
      throw configError(
        `clientId must be whitespace-free and at most ${MAX_CLIENT_ID_LENGTH} characters`
      );
    }
    if (seen.has(client.clientId)) {
      throw configError('clientId must be unique across registered clients');
    }
    seen.add(client.clientId);
    if (
      client.clientSecret !== undefined &&
      (!isNonEmptyString(client.clientSecret) ||
        client.clientSecret.length > MAX_CLIENT_SECRET_LENGTH)
    ) {
      throw configError('clientSecret must be a non-empty bounded string when provided');
    }
    if (
      !Array.isArray(client.redirectUris) ||
      client.redirectUris.length === 0 ||
      client.redirectUris.length > MAX_REDIRECT_URIS_PER_CLIENT
    ) {
      throw configError(
        `redirectUris must be a non-empty array of at most ${MAX_REDIRECT_URIS_PER_CLIENT} URIs`
      );
    }
    const redirectUris = client.redirectUris.map((uri) =>
      validateRedirectUri(uri, `redirect URI for client ${client.clientId}`)
    );
    if (new Set(redirectUris).size !== redirectUris.length) {
      throw configError('redirectUris must be unique for each registered client');
    }
    // T18: by default every registered client may refresh. A registration
    // may explicitly restrict its grants to the authorization code grant,
    // in which case no refresh token is ever issued for it.
    let grants = client.grants;
    if (grants === undefined) {
      grants = SUPPORTED_CLIENT_GRANTS;
    }
    if (
      !Array.isArray(grants) ||
      grants.length === 0 ||
      grants.some((grant) => !SUPPORTED_CLIENT_GRANTS.includes(grant)) ||
      !grants.includes('authorization_code')
    ) {
      throw configError(
        `client grants, when set, must include 'authorization_code' and may only add 'refresh_token'`
      );
    }
    return {
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      redirectUris,
      grants,
    };
  });
}

function validateOptions(options) {
  if (!isPlainObject(options)) {
    throw configError('a configuration object is required');
  }
  const unknownKeys = Object.keys(options).filter((key) => !ALLOWED_OPTIONS.includes(key));
  if (unknownKeys.length > 0) {
    throw configError(`unexpected MCP OAuth provider options: ${unknownKeys.join(', ')}`);
  }

  const issuerUrl = validateEndpointUrl(options.issuerUrl, 'issuerUrl');
  const signInUrl = validateEndpointUrl(options.signInUrl, 'signInUrl');
  const baseUrl =
    options.baseUrl === undefined ? undefined : validateEndpointUrl(options.baseUrl, 'baseUrl');
  const resourceServerUrl =
    options.resourceServerUrl === undefined
      ? undefined
      : validateEndpointUrl(options.resourceServerUrl, 'resourceServerUrl');

  const supportedScopes = validateSupportedScopes(options.supportedScopes);
  const clients = validateRegisteredClients(options.clients);

  let allowDynamicRegistration = options.allowDynamicRegistration;
  if (allowDynamicRegistration === undefined) {
    allowDynamicRegistration = false;
  }
  if (typeof allowDynamicRegistration !== 'boolean') {
    throw configError('allowDynamicRegistration must be a boolean');
  }

  const persistentStore = options.persistentStore;
  if (persistentStore !== undefined) {
    if (
      !isPlainObject(persistentStore) ||
      typeof persistentStore.load !== 'function' ||
      typeof persistentStore.commit !== 'function' ||
      typeof persistentStore.close !== 'function'
    ) {
      throw configError(
        'persistentStore must expose the bridge-store load, commit, and close methods'
      );
    }
  }

  if (typeof options.refreshUpstreamEntraToken !== 'undefined') {
    if (typeof options.refreshUpstreamEntraToken !== 'function') {
      throw configError(
        'refreshUpstreamEntraToken must be an async ({upstream, identity}) callback'
      );
    }
  }

  let rateLimit = options.rateLimit;
  if (rateLimit === undefined) {
    rateLimit = true;
  }
  if (typeof rateLimit !== 'boolean') {
    throw configError('rateLimit must be a boolean');
  }

  let clientSecretExpirySeconds = requirePositiveInteger(options.clientSecretExpirySeconds);
  if (clientSecretExpirySeconds === undefined) {
    // Matches the SDK registration handler default (30 days). Zero would
    // mean a never-expiring dynamic secret, which is not a safe default.
    clientSecretExpirySeconds = 30 * 24 * 60 * 60;
  }

  return {
    issuerUrl,
    signInUrl,
    baseUrl,
    resourceServerUrl,
    supportedScopes,
    clients,
    allowDynamicRegistration,
    clientSecretExpirySeconds,
    accessTokenTtlSeconds: requirePositiveInteger(
      options.accessTokenTtlSeconds,
      'accessTokenTtlSeconds',
      86400
    ),
    refreshTokenTtlSeconds: requirePositiveInteger(
      options.refreshTokenTtlSeconds,
      'refreshTokenTtlSeconds',
      MAX_REFRESH_TTL_SECONDS
    ),
    authorizationCodeTtlSeconds: requirePositiveInteger(
      options.authorizationCodeTtlSeconds,
      'authorizationCodeTtlSeconds',
      3600
    ),
    pendingAuthorizationTtlSeconds: requirePositiveInteger(
      options.pendingAuthorizationTtlSeconds,
      'pendingAuthorizationTtlSeconds',
      3600
    ),
    maxPendingAuthorizations: requirePositiveInteger(
      options.maxPendingAuthorizations,
      'maxPendingAuthorizations'
    ),
    maxAuthorizationCodes: requirePositiveInteger(
      options.maxAuthorizationCodes,
      'maxAuthorizationCodes'
    ),
    maxAccessTokens: requirePositiveInteger(options.maxAccessTokens, 'maxAccessTokens'),
    maxRegisteredClients:
      requirePositiveInteger(options.maxRegisteredClients, 'maxRegisteredClients') ??
      DEFAULT_MAX_REGISTERED_CLIENTS,
    persistentStore,
    refreshUpstreamEntraToken: options.refreshUpstreamEntraToken,
    rateLimit,
  };
}

/**
 * Creates the registered clients store consumed by the SDK handlers and
 * middleware. Dynamic registration, when enabled, stores the SDK-generated
 * credentials verbatim after validating the client metadata against this
 * deployment's safety rules; it is never enabled by default.
 */
function createClientsStore(
  normalized,
  seeds = { dynamicClients: [], persistDynamicClient: null }
) {
  /** @type {Map<string, object>} */
  const clients = new Map();
  for (const client of normalized.clients) {
    clients.set(client.clientId, {
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: client.clientSecret ? 'client_secret_post' : 'none',
      grant_types: client.grants,
    });
  }

  let dynamicCount = seeds.dynamicClients.length;
  for (const restored of seeds.dynamicClients) {
    clients.set(restored.client_id, { ...restored });
  }

  const store = {
    getClient(clientId) {
      if (!isNonEmptyString(clientId)) {
        return undefined;
      }
      const client = clients.get(clientId);
      return client ? { ...client } : undefined;
    },
  };

  if (normalized.allowDynamicRegistration) {
    store.registerClient = (clientInfo) => {
      if (!isPlainObject(clientInfo)) {
        throw new InvalidClientMetadataError('Invalid client registration');
      }
      if (!isNonEmptyString(clientInfo.client_id)) {
        throw new InvalidClientMetadataError('The client_id must be generated by the SDK');
      }
      const redirectUris = clientInfo.redirect_uris;
      if (
        !Array.isArray(redirectUris) ||
        redirectUris.length === 0 ||
        redirectUris.length > MAX_REDIRECT_URIS_PER_CLIENT ||
        redirectUris.some((uri) => !isNonEmptyString(typeof uri === 'string' ? uri : ''))
      ) {
        throw new InvalidClientMetadataError(
          `redirect_uris must be a non-empty array of at most ${MAX_REDIRECT_URIS_PER_CLIENT} URIs`
        );
      }
      let validatedRedirectUris;
      try {
        validatedRedirectUris = redirectUris.map((uri) =>
          validateRedirectUri(uri, `redirect URI for client ${clientInfo.client_id}`)
        );
      } catch {
        throw new InvalidClientMetadataError(
          'Every redirect_uri must be an HTTPS URL (loopback HTTP is allowed) without query, hash, or credentials'
        );
      }
      if (new Set(validatedRedirectUris).size !== validatedRedirectUris.length) {
        throw new InvalidClientMetadataError('redirect_uris must be unique');
      }
      const registeredGrants = normalizeClientGrantTypes(clientInfo.grant_types);
      if (!registeredGrants) {
        throw new InvalidClientMetadataError(
          `grants, when set, must include 'authorization_code' and may only add 'refresh_token'`
        );
      }
      if (
        Array.isArray(clientInfo.response_types) &&
        (clientInfo.response_types.length !== 1 || clientInfo.response_types[0] !== 'code')
      ) {
        throw new InvalidClientMetadataError('Only the code response type is supported');
      }
      if (
        clientInfo.token_endpoint_auth_method !== undefined &&
        !['none', 'client_secret_post'].includes(clientInfo.token_endpoint_auth_method)
      ) {
        throw new InvalidClientMetadataError(
          'Only client_secret_post or none authentication is supported'
        );
      }
      if (clients.has(clientInfo.client_id) || dynamicCount >= normalized.maxRegisteredClients) {
        throw new InvalidClientMetadataError(
          'The maximum number of registered clients has been reached'
        );
      }
      const stored = {
        ...clientInfo,
        redirect_uris: validatedRedirectUris,
        grant_types: registeredGrants,
        token_endpoint_auth_method: clientInfo.token_endpoint_auth_method || 'client_secret_post',
      };
      // T18: persist the validated registration BEFORE it exists in memory,
      // so a failed snapshot write never publishes a client to /register
      // or /token callers.
      if (seeds.persistDynamicClient) {
        const persisted = {
          client_id: clientInfo.client_id,
          ...(clientInfo.client_secret ? { client_secret: clientInfo.client_secret } : {}),
          ...(Number.isFinite(clientInfo.client_secret_expires_at)
            ? { client_secret_expires_at: clientInfo.client_secret_expires_at }
            : {}),
          redirect_uris: validatedRedirectUris,
          grant_types: registeredGrants,
          token_endpoint_auth_method: stored.token_endpoint_auth_method,
        };
        seeds.persistDynamicClient(persisted);
      }
      clients.set(clientInfo.client_id, stored);
      dynamicCount += 1;
      return { ...stored };
    };
  }

  return store;
}

/** Persisted snapshot limits and key shapes (T18). Keys are SHA-256 hex. */
const MAX_SNAPSHOT_FAMILY_ID_LENGTH = 128;
const MAX_SNAPSHOT_SCOPES = 64;
const MAX_SNAPSHOT_SCOPE_LENGTH = 256;
const MAX_SNAPSHOT_TIME_VALUE = 4e12;
const DANGEROUS_SNAPSHOT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const PERSISTED_SNAPSHOT_TOP_KEYS = new Set([
  'snapshotVersion',
  'families',
  'accessTokens',
  'refreshTokens',
  'usedRefreshTokens',
  'dynamicClients',
]);
const PERSISTED_FAMILY_KEYS = new Set([
  'userId',
  'tenantId',
  'username',
  'groups',
  'roles',
  'clientId',
  'scopes',
  'resource',
  'upstream',
  'familyExpiresAt',
  'createdAt',
  'revoked',
]);
const PERSISTED_TOKEN_RECORD_KEYS = new Set(['familyId', 'expiresAt', 'scopes']);
const PERSISTED_UPSTREAM_KEYS = new Set(['accessToken', 'expiresAt', 'refreshToken']);
const PERSISTED_DYNAMIC_CLIENT_KEYS = new Set([
  'client_id',
  'client_secret',
  'client_secret_expires_at',
  'redirect_uris',
  'grant_types',
  'token_endpoint_auth_method',
]);
const ACCESS_TOKEN_SNAPSHOT_KEY_PATTERN = /^at:[0-9a-f]{64}$/;
const REFRESH_TOKEN_SNAPSHOT_KEY_PATTERN = /^rt:[0-9a-f]{64}$/;
const FAMILY_ID_SNAPSHOT_PATTERN = /^[A-Za-z0-9_-]{10,128}$/;

/** Prefix + SHA-256 hex digest: never stores or leaks the opaque token. */
function hashOpaqueToken(value, prefix) {
  return `${prefix}${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function persistedStateError(message) {
  return isError(message, ERROR_CODES.PERSISTED_STATE);
}

function validateSnapshotTime(value, label) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > MAX_SNAPSHOT_TIME_VALUE
  ) {
    throw persistedStateError(`${label} out of bounds in the persisted snapshot`);
  }
}

function validateSnapshotSecretString(value, label) {
  if (!isNonEmptyString(value) || value.length > MAX_TOKEN_LENGTH || /\s/.test(value)) {
    throw persistedStateError(`${label} out of bounds in the persisted snapshot`);
  }
}

function validateSnapshotScopeList(list, label) {
  if (
    !Array.isArray(list) ||
    list.length === 0 ||
    list.length > MAX_SNAPSHOT_SCOPES ||
    list.some(
      (scope) =>
        !isNonEmptyString(typeof scope === 'string' ? scope : '') ||
        scope.length > MAX_SNAPSHOT_SCOPE_LENGTH
    )
  ) {
    throw persistedStateError(`${label} out of bounds in the persisted snapshot`);
  }
}

function validateSnapshotClaimList(list, label) {
  if (
    !Array.isArray(list) ||
    list.length > MAX_IDENTITY_CLAIMS ||
    list.some(
      (claim) =>
        !isNonEmptyString(typeof claim === 'string' ? claim : '') ||
        claim.trim() !== claim ||
        claim.length > MAX_IDENTITY_CLAIM_VALUE_LENGTH
    )
  ) {
    throw persistedStateError(`${label} out of bounds in the persisted snapshot`);
  }
}

function assertSafeSnapshotKeys(obj, label) {
  for (const key of Object.keys(obj)) {
    if (DANGEROUS_SNAPSHOT_KEYS.has(key)) {
      throw persistedStateError(
        `the persisted snapshot carries a prototype-pollution key in ${label}`
      );
    }
  }
}

/** Validates and normalizes one persisted family record, failing closed. */
function validatePersistedFamily(familyId, entry) {
  if (!isPlainObject(entry)) {
    throw persistedStateError('a persisted family record is not a plain object');
  }
  const unknownFields = Object.keys(entry).filter((key) => !PERSISTED_FAMILY_KEYS.has(key));
  if (unknownFields.length > 0) {
    throw persistedStateError(`unexpected persisted family fields: ${unknownFields.join(', ')}`);
  }
  if (typeof entry.revoked !== 'boolean') {
    throw persistedStateError('a persisted family record lacks a valid revoked flag');
  }
  if (!isNonEmptyString(entry.userId) || entry.userId.length > MAX_USERNAME_LENGTH) {
    throw persistedStateError('a persisted family record carries an invalid user identity');
  }
  if (!isNonEmptyString(entry.tenantId) || entry.tenantId.length > MAX_CLIENT_ID_LENGTH) {
    throw persistedStateError('a persisted family record carries an invalid tenant');
  }
  if (
    entry.username !== undefined &&
    entry.username !== null &&
    (!isNonEmptyString(typeof entry.username === 'string' ? entry.username : '') ||
      entry.username.length > MAX_USERNAME_LENGTH)
  ) {
    throw persistedStateError('a persisted family record carries an invalid username');
  }
  if (entry.groups !== undefined) {
    validateSnapshotClaimList(entry.groups, 'groups claim list');
  }
  if (entry.roles !== undefined) {
    validateSnapshotClaimList(entry.roles, 'roles claim list');
  }
  if (!isNonEmptyString(entry.clientId) || entry.clientId.length > MAX_CLIENT_ID_LENGTH) {
    throw persistedStateError('a persisted family record carries an invalid client');
  }
  validateSnapshotScopeList(entry.scopes, 'family scopes');
  let resource = null;
  if (entry.resource !== undefined && entry.resource !== null) {
    let parsedResource = null;
    try {
      parsedResource = new URL(entry.resource);
    } catch {
      parsedResource = null;
    }
    if (
      !isNonEmptyString(typeof entry.resource === 'string' ? entry.resource : '') ||
      entry.resource.length > MAX_REDIRECT_URI_LENGTH ||
      !parsedResource ||
      !['http:', 'https:'].includes(parsedResource.protocol)
    ) {
      throw persistedStateError('a persisted family record carries an invalid resource');
    }
    resource = entry.resource;
  }
  let upstream = null;
  if (entry.upstream !== undefined && entry.upstream !== null) {
    if (!isPlainObject(entry.upstream)) {
      throw persistedStateError('a persisted family record carries an invalid upstream object');
    }
    const unknownUpstream = Object.keys(entry.upstream).filter(
      (key) => !PERSISTED_UPSTREAM_KEYS.has(key)
    );
    if (unknownUpstream.length > 0) {
      throw persistedStateError(
        `unexpected persisted upstream fields: ${unknownUpstream.join(', ')}`
      );
    }
    validateSnapshotSecretString(entry.upstream.accessToken, 'upstream accessToken');
    validateSnapshotTime(entry.upstream.expiresAt, 'upstream expiry');
    if (entry.upstream.refreshToken !== undefined) {
      validateSnapshotSecretString(entry.upstream.refreshToken, 'upstream refreshToken');
    }
    upstream = {
      accessToken: entry.upstream.accessToken,
      expiresAt: entry.upstream.expiresAt,
      ...(entry.upstream.refreshToken !== undefined
        ? { refreshToken: entry.upstream.refreshToken }
        : {}),
    };
  }
  if (!entry.revoked && !upstream) {
    throw persistedStateError('a live persisted family record carries no upstream credential');
  }
  validateSnapshotTime(entry.familyExpiresAt, 'family expiry');
  validateSnapshotTime(entry.createdAt, 'family creation');
  return {
    familyId,
    userId: entry.userId,
    tenantId: entry.tenantId,
    username: entry.username || null,
    groups: [...(entry.groups || [])],
    roles: [...(entry.roles || [])],
    clientId: entry.clientId,
    scopes: [...entry.scopes],
    resource,
    upstream,
    familyExpiresAt: entry.familyExpiresAt,
    createdAt: entry.createdAt,
    revoked: entry.revoked,
  };
}

function validatePersistedTokenRecord(entry, families, label, { requireLiveFamily = true } = {}) {
  if (!isPlainObject(entry)) {
    throw persistedStateError(`a persisted ${label} record is not a plain object`);
  }
  const unknownFields = Object.keys(entry).filter((key) => !PERSISTED_TOKEN_RECORD_KEYS.has(key));
  if (unknownFields.length > 0) {
    throw persistedStateError(`unexpected persisted ${label} fields: ${unknownFields.join(', ')}`);
  }
  if (
    !isNonEmptyString(typeof entry.familyId === 'string' ? entry.familyId : '') ||
    entry.familyId.length > MAX_SNAPSHOT_FAMILY_ID_LENGTH
  ) {
    throw persistedStateError(`a persisted ${label} record carries an invalid family reference`);
  }
  validateSnapshotTime(entry.expiresAt, `${label} expiry`);
  let scopes;
  if (entry.scopes !== undefined) {
    validateSnapshotScopeList(entry.scopes, `${label} record scopes`);
    scopes = [...entry.scopes];
  }
  if (requireLiveFamily) {
    const family = families.get(entry.familyId);
    if (!family) {
      throw persistedStateError(`a persisted ${label} references an unknown family`);
    }
    if (family.revoked) {
      throw persistedStateError(`a persisted ${label} references a revoked family`);
    }
    if (scopes && !scopes.every((scope) => family.scopes.includes(scope))) {
      throw persistedStateError(`a persisted ${label} record carries scopes outside its family`);
    }
  }
  return {
    familyId: entry.familyId,
    expiresAt: entry.expiresAt,
    ...(scopes ? { scopes } : {}),
  };
}

function validatePersistedDynamicClient(entry) {
  if (!isPlainObject(entry)) {
    throw persistedStateError('a persisted dynamic client is not a plain object');
  }
  const unknownFields = Object.keys(entry).filter((key) => !PERSISTED_DYNAMIC_CLIENT_KEYS.has(key));
  if (unknownFields.length > 0) {
    throw persistedStateError(
      `unexpected persisted dynamic client fields: ${unknownFields.join(', ')}`
    );
  }
  if (
    !isNonEmptyString(entry.client_id) ||
    entry.client_id.length > MAX_CLIENT_ID_LENGTH ||
    /\s/.test(entry.client_id) ||
    DANGEROUS_SNAPSHOT_KEYS.has(entry.client_id)
  ) {
    throw persistedStateError('a persisted dynamic client carries an invalid identifier');
  }
  if (
    entry.client_secret !== undefined &&
    (!isNonEmptyString(entry.client_secret) ||
      entry.client_secret.length > MAX_CLIENT_SECRET_LENGTH)
  ) {
    throw persistedStateError('a persisted dynamic client carries an invalid secret');
  }
  if (
    !Array.isArray(entry.redirect_uris) ||
    entry.redirect_uris.length === 0 ||
    entry.redirect_uris.length > MAX_REDIRECT_URIS_PER_CLIENT ||
    entry.redirect_uris.some((uri) => {
      try {
        validateRedirectUri(uri, 'persisted dynamic client redirect URI');
      } catch {
        return true;
      }
      return false;
    })
  ) {
    throw persistedStateError('a persisted dynamic client carries invalid redirect URIs');
  }
  const persistedGrants = normalizeClientGrantTypes(entry.grant_types);
  if (
    !Array.isArray(entry.grant_types) ||
    JSON.stringify(persistedGrants) !== JSON.stringify(entry.grant_types)
  ) {
    throw persistedStateError(
      'a persisted dynamic client carries grants other than authorization_code, optionally with refresh_token, in canonical order'
    );
  }
  if (
    entry.token_endpoint_auth_method !== undefined &&
    !['none', 'client_secret_post'].includes(entry.token_endpoint_auth_method)
  ) {
    throw persistedStateError('a persisted dynamic client carries an invalid auth method');
  }
  if (entry.client_secret_expires_at !== undefined) {
    validateSnapshotTime(entry.client_secret_expires_at, 'dynamic client secret expiry');
  }
  return { ...entry, grant_types: persistedGrants };
}

/**
 * Validates a whole persisted snapshot, failing closed on any damage:
 * unknown fields, wrong versions, prototype-pollution keys, unsafe
 * expiries, oversized maps, or inconsistent references. Returns the
 * in-memory state maps for a fresh provider instance.
 */
function validatePersistedSnapshot(raw, maxAccessTokens, maxRegisteredClients) {
  if (!isPlainObject(raw)) {
    throw persistedStateError('the persisted snapshot is not a plain object');
  }
  if (raw.snapshotVersion !== SNAPSHOT_VERSION) {
    throw persistedStateError('the persisted snapshot version is not supported');
  }
  const unknownTop = Object.keys(raw).filter((key) => !PERSISTED_SNAPSHOT_TOP_KEYS.has(key));
  if (unknownTop.length > 0) {
    throw persistedStateError(`unexpected persisted snapshot fields: ${unknownTop.join(', ')}`);
  }

  const mapFrom = (obj, label, keyPattern, maxEntries, validateEntry) => {
    const out = new Map();
    if (obj === undefined) {
      return out;
    }
    if (!isPlainObject(obj)) {
      throw persistedStateError(`the persisted ${label} map is invalid`);
    }
    assertSafeSnapshotKeys(obj, label);
    const keys = Object.keys(obj);
    if (keys.length > maxEntries) {
      throw persistedStateError(`the persisted ${label} map exceeds its configured cap`);
    }
    for (const key of keys) {
      if (!keyPattern.test(key)) {
        throw persistedStateError(
          `the persisted ${label} map carries a key outside its expected shape`
        );
      }
      validateEntry(key, obj[key], out);
    }
    return out;
  };

  const families = mapFrom(
    raw.families,
    'family',
    FAMILY_ID_SNAPSHOT_PATTERN,
    maxAccessTokens,
    (key, entry, out) => {
      out.set(key, validatePersistedFamily(key, entry));
    }
  );
  const accessTokens = mapFrom(
    raw.accessTokens,
    'access token',
    ACCESS_TOKEN_SNAPSHOT_KEY_PATTERN,
    maxAccessTokens,
    (key, entry, out) => {
      out.set(key, validatePersistedTokenRecord(entry, families, 'access token'));
    }
  );
  const refreshTokens = mapFrom(
    raw.refreshTokens,
    'refresh token',
    REFRESH_TOKEN_SNAPSHOT_KEY_PATTERN,
    maxAccessTokens,
    (key, entry, out) => {
      out.set(key, validatePersistedTokenRecord(entry, families, 'refresh token'));
    }
  );
  const usedRefreshTokens = mapFrom(
    raw.usedRefreshTokens,
    'used refresh token',
    REFRESH_TOKEN_SNAPSHOT_KEY_PATTERN,
    maxAccessTokens * MAX_REFRESH_TOKENS_CAP_MULTIPLIER,
    (key, entry, out) => {
      // Tombstones may outlive a pruned family; an expired-family replay
      // fails closed as unknown without mutation either way.
      out.set(
        key,
        validatePersistedTokenRecord(entry, families, 'used refresh token', {
          requireLiveFamily: false,
        })
      );
    }
  );

  let dynamicClients = [];
  if (raw.dynamicClients !== undefined) {
    if (!Array.isArray(raw.dynamicClients) || raw.dynamicClients.length > maxRegisteredClients) {
      throw persistedStateError('the persisted dynamic client list is invalid or too large');
    }
    const seen = new Set();
    dynamicClients = raw.dynamicClients.map((entry) => {
      const client = validatePersistedDynamicClient(entry);
      if (seen.has(client.client_id)) {
        throw persistedStateError('a persisted dynamic client identifier is not unique');
      }
      seen.add(client.client_id);
      return client;
    });
  }

  return { families, accessTokens, refreshTokens, usedRefreshTokens, dynamicClients };
}

/** Converts one in-memory family record into its snapshot shape. */
function familyRecordToSnapshot(record) {
  return {
    userId: record.userId,
    tenantId: record.tenantId,
    username: record.username || null,
    groups: [...(record.groups || [])],
    roles: [...(record.roles || [])],
    clientId: record.clientId,
    scopes: [...(record.scopes || [])],
    resource: record.resource || null,
    upstream: record.revoked
      ? null
      : {
          accessToken: record.upstream.accessToken,
          expiresAt: record.upstream.expiresAt,
          ...(record.upstream.refreshToken !== undefined
            ? { refreshToken: record.upstream.refreshToken }
            : {}),
        },
    familyExpiresAt: record.familyExpiresAt,
    createdAt: record.createdAt,
    revoked: Boolean(record.revoked),
  };
}

/**
 * Builds the whole logical snapshot from one (possibly staged) set of
 * state maps, pruning expired entries: dead access/refresh tokens and
 * tombstones drop out, and a family is pruned only after its expiry once
 * no live access grant or tombstone references it, so a consumed token
 * can never be reintroduced from a snapshot.
 */
function buildPersistedSnapshot(state, caps) {
  const now = Date.now();
  const activeAccess = [...state.accessTokens].filter(([, record]) => record.expiresAt > now);
  const referencedFamilies = new Set(activeAccess.map(([, record]) => record.familyId));
  const liveTombstoneFamilies = new Set(
    [...state.usedRefreshTokens]
      .filter(([, record]) => record.expiresAt > now)
      .map(([, record]) => record.familyId)
  );
  const familiesOut = {};
  const survivingFamilies = new Set();
  for (const [familyId, record] of state.families) {
    if (
      record.familyExpiresAt <= now &&
      !referencedFamilies.has(familyId) &&
      !liveTombstoneFamilies.has(familyId)
    ) {
      continue;
    }
    survivingFamilies.add(familyId);
    familiesOut[familyId] = familyRecordToSnapshot(record);
  }
  if (Object.keys(familiesOut).length > caps.maxFamilies) {
    throw persistedStateError('the staged snapshot exceeds its family cap');
  }
  const accessOut = {};
  for (const [hashKey, record] of activeAccess) {
    accessOut[hashKey] = {
      familyId: record.familyId,
      expiresAt: record.expiresAt,
      ...(record.scopes ? { scopes: record.scopes } : {}),
    };
  }
  const refreshOut = {};
  for (const [hashKey, record] of state.refreshTokens) {
    if (record.expiresAt > now && survivingFamilies.has(record.familyId)) {
      refreshOut[hashKey] = { familyId: record.familyId, expiresAt: record.expiresAt };
    }
  }
  const tombstonesOut = {};
  for (const [hashKey, record] of state.usedRefreshTokens) {
    if (record.expiresAt > now) {
      tombstonesOut[hashKey] = { familyId: record.familyId, expiresAt: record.expiresAt };
    }
  }
  if (Object.keys(tombstonesOut).length > caps.maxTombstones) {
    throw persistedStateError('the staged snapshot exceeds its tombstone cap');
  }
  const dynamicClients = [...state.dynamicClients.values()];
  if (dynamicClients.length > caps.maxDynamicClients) {
    throw persistedStateError('the staged snapshot exceeds its dynamic client cap');
  }
  return {
    snapshotVersion: SNAPSHOT_VERSION,
    families: familiesOut,
    accessTokens: accessOut,
    refreshTokens: refreshOut,
    usedRefreshTokens: tombstonesOut,
    dynamicClients,
  };
}

/**
 * Creates one bound MCP authorization-server provider plus its unwired
 * SDK-composed router and metadata. Every instance owns its state maps
 * exclusively; two instances never share clients, codes, tokens, or the
 * upstream Entra associations.
 */
function createMCPOAuthProvider(rawOptions) {
  const normalized = validateOptions(rawOptions);

  const accessTokenTtlSeconds = normalized.accessTokenTtlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS;
  const authorizationCodeTtlSeconds =
    normalized.authorizationCodeTtlSeconds ?? DEFAULT_CODE_TTL_SECONDS;
  const pendingAuthorizationTtlSeconds =
    normalized.pendingAuthorizationTtlSeconds ?? DEFAULT_PENDING_TTL_SECONDS;
  const maxPendingAuthorizations = normalized.maxPendingAuthorizations ?? DEFAULT_MAX_PENDING;
  const maxAuthorizationCodes = normalized.maxAuthorizationCodes ?? DEFAULT_MAX_CODES;
  const maxAccessTokens = normalized.maxAccessTokens ?? DEFAULT_MAX_TOKENS;
  const refreshTokenTtlSeconds = normalized.refreshTokenTtlSeconds ?? DEFAULT_REFRESH_TTL_SECONDS;
  const refreshUpstreamCallback = normalized.refreshUpstreamEntraToken;

  // T18: load once, exactly as the bridge-store contract describes. Any
  // damaged state fails closed here, before any listener state exists.
  const persistentStore = normalized.persistentStore;
  let restored = {
    families: new Map(),
    accessTokens: new Map(),
    refreshTokens: new Map(),
    usedRefreshTokens: new Map(),
    dynamicClients: [],
  };
  if (persistentStore) {
    const loaded = persistentStore.load();
    if (loaded.exists) {
      restored = validatePersistedSnapshot(
        loaded.snapshot,
        maxAccessTokens,
        normalized.maxRegisteredClients
      );
      if (restored.dynamicClients.length > 0 && !normalized.allowDynamicRegistration) {
        throw configError(
          'the persisted snapshot contains dynamic client registrations, which this configuration does not enable (allowDynamicRegistration)'
        );
      }
    }
  }

  const supportedScopeSet = new Set(normalized.supportedScopes);
  const clientsStore = createClientsStore(normalized, {
    dynamicClients: restored.dynamicClients,
    persistDynamicClient: persistentStore
      ? (persisted) =>
          persist((state) => {
            state.dynamicClients.set(persisted.client_id, persisted);
          })
      : null,
  });

  /** @type {Map<string, object>} Pending browser authorizations by reference. */
  const pendingAuthorizations = new Map();
  /** @type {Map<string, object>} Single-use authorization codes. */
  const authorizationCodes = new Map();
  /** @type {Map<string, object>} Bearer access tokens for verification. */
  let accessTokens = restored.accessTokens;
  /**
   * T18 durable refresh-family state: hash-keyed token records plus one
   * record per rotating family. Persisted as one whole encrypted snapshot
   * when a store is configured; plain in-memory state otherwise.
   */
  let families = restored.families;
  let refreshTokens = restored.refreshTokens;
  let usedRefreshTokens = restored.usedRefreshTokens;
  let dynamicClientInfos = new Map(restored.dynamicClients.map((c) => [c.client_id, c]));

  const snapshotCaps = {
    maxFamilies: maxAccessTokens,
    maxAccessTokens,
    maxTombstones: maxAccessTokens * MAX_REFRESH_TOKENS_CAP_MULTIPLIER,
    maxDynamicClients: normalized.maxRegisteredClients,
  };

  function purgeExpired(map, now) {
    for (const [key, record] of map) {
      if (record.expiresAt <= now) {
        map.delete(key);
      }
    }
  }

  /**
   * One staged whole-snapshot transaction: the mutation runs against
   * copies of the state maps, the whole snapshot is committed to the
   * persistent store BEFORE any of it is published, and a failed commit
   * leaves both the on-disk state and the published memory untouched.
   * Mutations must replace records (clone-on-write), never edit one in
   * place, because staged maps may share record objects with the live
   * maps while the commit is in flight.
   */
  function persist(mutate) {
    if (!persistentStore) {
      mutate({
        families,
        accessTokens,
        refreshTokens,
        usedRefreshTokens,
        dynamicClients: dynamicClientInfos,
      });
      return;
    }
    const staged = {
      families: new Map(families),
      accessTokens: new Map(accessTokens),
      refreshTokens: new Map(refreshTokens),
      usedRefreshTokens: new Map(usedRefreshTokens),
      dynamicClients: new Map(dynamicClientInfos),
    };
    mutate(staged);
    persistentStore.commit(buildPersistedSnapshot(staged, snapshotCaps));
    families = staged.families;
    accessTokens = staged.accessTokens;
    refreshTokens = staged.refreshTokens;
    usedRefreshTokens = staged.usedRefreshTokens;
    dynamicClientInfos = staged.dynamicClients;
  }

  /**
   * Marks one family revoked: every access and refresh token it issued is
   * dropped and its upstream credential is scrubbed. Unrelated grants are
   * untouched by construction.
   */
  function revokeFamily(state, familyId) {
    const family = state.families.get(familyId);
    if (!family || family.revoked) {
      return;
    }
    for (const [hashKey, record] of state.accessTokens) {
      if (record.familyId === familyId) {
        state.accessTokens.delete(hashKey);
      }
    }
    for (const [hashKey, record] of state.refreshTokens) {
      if (record.familyId === familyId) {
        state.refreshTokens.delete(hashKey);
      }
    }
    state.families.set(familyId, { ...family, revoked: true, upstream: null });
  }

  function resolveAccessFamily(token) {
    if (!isNonEmptyString(typeof token === 'string' ? token : '')) {
      return undefined;
    }
    const now = Date.now();
    purgeExpired(accessTokens, now);
    const record = accessTokens.get(hashOpaqueToken(token, ACCESS_TOKEN_KEY_PREFIX));
    if (!record) {
      return undefined;
    }
    if (record.expiresAt <= now) {
      accessTokens.delete(hashOpaqueToken(token, ACCESS_TOKEN_KEY_PREFIX));
      return undefined;
    }
    const family = families.get(record.familyId);
    if (!family || family.revoked) {
      return undefined;
    }
    return { record, family };
  }

  function upstreamAssociation(family) {
    return {
      accessToken: family.upstream.accessToken,
      expiresAt: family.upstream.expiresAt,
      objectId: family.userId,
      tenantId: family.tenantId,
      username: family.username || undefined,
      groups: [...(family.groups || [])],
      roles: [...(family.roles || [])],
    };
  }

  function scopeValidationError(requestedScopes) {
    const unsupported = requestedScopes.filter((scope) => !supportedScopeSet.has(scope));
    if (unsupported.length > 0) {
      return new InvalidScopeError(
        'The requested scope is not supported by this authorization server'
      );
    }
    return null;
  }

  const provider = {
    clientsStore,

    // The SDK token handler performs the local S256 PKCE validation itself;
    // no upstream verifier is trusted.
    skipLocalPkceValidation: false,

    /**
     * Begins the authorization flow by storing a bounded pending
     * authorization and redirecting the browser to the configured trusted
     * sign-in URL carrying only the opaque single-use reference. No
     * credential, code, or upstream token ever appears in this redirect,
     * and the destination comes exclusively from validated configuration,
     * so no caller input can create a redirect.
     */
    async authorize(client, params, res) {
      if (!isPlainObject(client) || !isNonEmptyString(client.client_id)) {
        throw new ServerError('The authorization request could not be bound to a client');
      }
      if (
        !isPlainObject(params) ||
        !isNonEmptyString(params.redirectUri) ||
        !isNonEmptyString(params.codeChallenge)
      ) {
        throw new InvalidGrantError('The authorization request is incomplete');
      }
      const requestedScopes = Array.isArray(params.scopes)
        ? params.scopes.filter((scope) => isNonEmptyString(scope))
        : [];
      const invalidScope = scopeValidationError(requestedScopes);
      if (invalidScope) {
        throw invalidScope;
      }

      const now = Date.now();
      purgeExpired(pendingAuthorizations, now);
      if (pendingAuthorizations.size >= maxPendingAuthorizations) {
        throw new ServerError('Too many pending authorization attempts; try again shortly');
      }

      const ref = randomToken();
      pendingAuthorizations.set(ref, {
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        scopes: requestedScopes,
        resource: params.resource || null,
        state: isNonEmptyString(params.state) ? params.state : null,
        expiresAt: now + pendingAuthorizationTtlSeconds * 1000,
      });

      const signInRedirect = new URL(normalized.signInUrl.href);
      signInRedirect.searchParams.set('mcp_authorization', ref);
      res.redirect(302, signInRedirect.href);
    },

    challengeForAuthorizationCode(client, authorizationCode) {
      if (
        !isPlainObject(client) ||
        !isNonEmptyString(client.client_id) ||
        !isNonEmptyString(typeof authorizationCode === 'string' ? authorizationCode : '')
      ) {
        throw new InvalidGrantError('The authorization code is invalid or has expired');
      }
      const now = Date.now();
      purgeExpired(authorizationCodes, now);
      const record = authorizationCodes.get(authorizationCode);
      if (!record) {
        throw new InvalidGrantError('The authorization code is invalid or has expired');
      }
      if (record.clientId !== client.client_id) {
        authorizationCodes.delete(authorizationCode);
        throw new InvalidGrantError('The authorization code was not issued to this client');
      }
      return record.codeChallenge;
    },

    exchangeAuthorizationCode(client, authorizationCode, _codeVerifier, redirectUri, resource) {
      if (!isPlainObject(client) || !isNonEmptyString(client.client_id)) {
        throw new InvalidGrantError('The authorization code is invalid or has expired');
      }
      const now = Date.now();
      purgeExpired(authorizationCodes, now);
      const record = authorizationCodes.get(authorizationCode);
      if (!record) {
        throw new InvalidGrantError('The authorization code is invalid or has expired');
      }
      if (record.expiresAt <= now) {
        authorizationCodes.delete(authorizationCode);
        throw new InvalidGrantError('The authorization code is invalid or has expired');
      }
      if (record.clientId !== client.client_id) {
        authorizationCodes.delete(authorizationCode);
        throw new InvalidGrantError('The authorization code was not issued to this client');
      }
      if (redirectUri !== record.redirectUri) {
        authorizationCodes.delete(authorizationCode);
        throw new InvalidGrantError('The redirect_uri does not match the authorization request');
      }
      if (record.resource) {
        if (!resource || record.resource.href !== resource.href) {
          authorizationCodes.delete(authorizationCode);
          throw new InvalidGrantError(
            'The resource indicator does not match the authorization request'
          );
        }
      } else if (resource) {
        authorizationCodes.delete(authorizationCode);
        throw new InvalidGrantError(
          'The resource indicator does not match the authorization request'
        );
      }

      purgeExpired(accessTokens, now);
      if (accessTokens.size >= maxAccessTokens) {
        throw new ServerError('The token endpoint is temporarily overloaded; try again shortly');
      }

      // T18: every exchange binds one rotating refresh family to the
      // consented client, user, resource, scopes, and validated upstream
      // credential. A client whose registration restricts its grants to
      // the authorization-code grant never receives a refresh token.
      const storeClient = clientsStore.getClient(record.clientId);
      const refreshAllowed =
        !storeClient ||
        !Array.isArray(storeClient.grant_types) ||
        storeClient.grant_types.includes('refresh_token');
      const familyId = randomToken();
      const accessToken = randomToken();
      const refreshToken = refreshAllowed ? randomToken() : null;
      const expiresAtMs = now + accessTokenTtlSeconds * 1000;
      const familyExpiresAt = now + refreshTokenTtlSeconds * 1000;
      const family = {
        familyId,
        userId: record.userId,
        tenantId: record.tenantId,
        username: record.username || null,
        groups: [...(record.groups || [])],
        roles: [...(record.roles || [])],
        clientId: record.clientId,
        scopes: [...record.scopes],
        resource: record.resource ? record.resource.href : null,
        upstream: {
          accessToken: record.upstream.accessToken,
          expiresAt: record.upstream.expiresAt,
          ...(record.upstreamRefreshToken !== undefined && record.upstreamRefreshToken !== null
            ? { refreshToken: record.upstreamRefreshToken }
            : {}),
        },
        createdAt: now,
        familyExpiresAt,
        revoked: false,
      };

      // The whole state change commits to the persistent store BEFORE it is
      // published, and the code is consumed only once that succeeded: a
      // failed snapshot write leaves the code retryable and returns no
      // token material at all.
      persist((state) => {
        state.families.set(familyId, family);
        state.accessTokens.set(hashOpaqueToken(accessToken, ACCESS_TOKEN_KEY_PREFIX), {
          familyId,
          expiresAt: expiresAtMs,
        });
        if (refreshToken) {
          state.refreshTokens.set(hashOpaqueToken(refreshToken, REFRESH_TOKEN_KEY_PREFIX), {
            familyId,
            expiresAt: familyExpiresAt,
          });
        }
      });
      // Single use: the code never survives one exchange attempt.
      authorizationCodes.delete(authorizationCode);

      return {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: accessTokenTtlSeconds,
        scope: record.scopes.join(' '),
        ...(refreshToken ? { refresh_token: refreshToken } : {}),
      };
    },

    /**
     * T18 rotating refresh-token grant. Strict bindings before any state
     * change: unknown tokens, cross-client presentations, wrong-resource
     * requests, and unsupported or expanding scopes fail with the standard
     * error and never mutate stored state (no cross-client revoke DoS).
     * One-time rotation: the consumed token is tombstoned for the family's
     * remaining TTL window, and a correctly-bound replay of it revokes
     * exactly that family (all of its access and refresh tokens) while
     * unrelated grants keep working. Upstream freshness is enforced with
     * the injected renewal callback when one exists: no upstream sign-in,
     * no MCP token.
     */
    async exchangeRefreshToken(client, refreshToken, requestedScopes, resource) {
      if (!isPlainObject(client) || !isNonEmptyString(client.client_id)) {
        throw new InvalidGrantError('The refresh grant could not be bound to a client');
      }
      if (
        !isNonEmptyString(typeof refreshToken === 'string' ? refreshToken : '') ||
        refreshToken.length > MAX_TOKEN_LENGTH
      ) {
        throw new InvalidGrantError('The refresh token is invalid or has expired');
      }
      const now = Date.now();
      const hash = hashOpaqueToken(refreshToken, REFRESH_TOKEN_KEY_PREFIX);

      // Replay detection first: a consumed token can never mint again.
      const tombstone = usedRefreshTokens.get(hash);
      if (tombstone) {
        const replayedFamily = families.get(tombstone.familyId);
        if (tombstone.expiresAt > now) {
          if (replayedFamily && !replayedFamily.revoked) {
            // Correctly-bound consumed-token reuse revokes exactly this
            // family (all access + refresh tokens) and nothing else, and
            // the revocation commits before the client-visible error.
            persist((state) => revokeFamily(state, tombstone.familyId));
          }
          throw new InvalidGrantError(
            'The refresh token was already used; the authorization it belongs to has been revoked'
          );
        }
        // A tombstone past its own expiry is pruning-eligible: its family
        // has run out its remaining TTL window, so the replay is simply
        // unknown and must not revoke a family that happens to have slid
        // further. The token itself can never mint again either way.
      }

      const tokenRecord = refreshTokens.get(hash);
      if (!tokenRecord) {
        throw new InvalidGrantError('The refresh token is invalid or has expired');
      }
      const family = families.get(tokenRecord.familyId);
      if (
        !family ||
        family.revoked ||
        tokenRecord.expiresAt <= now ||
        family.familyExpiresAt <= now
      ) {
        throw new InvalidGrantError('The refresh token is invalid or has expired');
      }
      // Strict client binding: an unrelated authenticated client can never
      // delete, tombstone, or revoke another client's grant.
      if (family.clientId !== client.client_id) {
        throw new InvalidGrantError('The refresh token was not issued to this client');
      }

      const requested = (Array.isArray(requestedScopes) ? requestedScopes : []).filter((scope) =>
        isNonEmptyString(scope)
      );
      const invalidScope = scopeValidationError(requested);
      if (invalidScope) {
        throw invalidScope;
      }
      let rotationScopes = [...family.scopes];
      if (requested.length > 0) {
        if (!requested.every((scope) => family.scopes.includes(scope))) {
          throw new InvalidScopeError(
            'The refresh request may only narrow the originally granted scope'
          );
        }
        rotationScopes = [...new Set(requested)];
      }
      if (family.resource ? !resource || resource.href !== family.resource : Boolean(resource)) {
        throw new InvalidGrantError(
          'The resource indicator does not match the authorization request'
        );
      }

      // Upstream freshness: the MCP refresh grant renews the delegated
      // upstream credential through the injected callback near expiry.
      // A permanent callback failure or a missing callback with a stale
      // upstream fails closed without minting any MCP token, and a
      // transient failure leaves all stored state untouched.
      try {
        const freshFamily = await ensureFamilyUpstreamFresh(family.familyId);
        if (!freshFamily) {
          throw new InvalidGrantError(
            'The upstream Microsoft credential has expired; repeat the sign-in to receive new tokens'
          );
        }
      } catch (error) {
        if (error && error.code === UPSTREAM_REAUTH_REQUIRED) {
          throw new InvalidGrantError(
            'The Microsoft sign-in must be repeated before new MCP tokens are issued'
          );
        }
        throw error;
      }

      purgeExpired(accessTokens, Date.now());
      if (accessTokens.size >= maxAccessTokens) {
        throw new ServerError('The token endpoint is temporarily overloaded; try again shortly');
      }

      const rotatedAt = Date.now();
      const rotatedAccessToken = randomToken();
      const rotatedRefreshToken = randomToken();
      const rotatedAccessExpiry = rotatedAt + accessTokenTtlSeconds * 1000;
      const familyExpiresAt = rotatedAt + refreshTokenTtlSeconds * 1000;

      // One whole-snapshot transaction: the old token becomes a tombstone
      // with the family's sliding TTL, the fresh tokens are staged, and the
      // family window slides forward - before anything is published. T19:
      // the upstream renewal can take an await, and concurrent presentations
      // of the same credential race in that window; the staged state is
      // re-checked here so exactly one rotation can ever publish, and a
      // concurrent replay presentation applies the replay rule.
      let rotationRaceOutcome = null;
      persist((state) => {
        const current = state.families.get(family.familyId);
        if (
          !current ||
          current.revoked ||
          Date.now() >= familyExpiresAt ||
          current.familyExpiresAt <= Date.now()
        ) {
          rotationRaceOutcome = 'stale';
          return;
        }
        const liveRecord = state.refreshTokens.get(hash);
        if (!liveRecord || liveRecord.familyId !== family.familyId) {
          // The presented token was consumed by a concurrent presentation of
          // the same credential during the awaited renewal: the replay rule
          // applies and revokes exactly this family before the error.
          rotationRaceOutcome = 'consumed';
          revokeFamily(state, family.familyId);
          return;
        }
        state.refreshTokens.delete(hash);
        state.usedRefreshTokens.set(hash, {
          familyId: family.familyId,
          expiresAt: rotatedAt + refreshTokenTtlSeconds * 1000,
        });
        state.refreshTokens.set(hashOpaqueToken(rotatedRefreshToken, REFRESH_TOKEN_KEY_PREFIX), {
          familyId: family.familyId,
          expiresAt: familyExpiresAt,
        });
        state.accessTokens.set(hashOpaqueToken(rotatedAccessToken, ACCESS_TOKEN_KEY_PREFIX), {
          familyId: family.familyId,
          expiresAt: rotatedAccessExpiry,
          ...(rotationScopes.length !== family.scopes.length ||
          rotationScopes.some((scope, index) => family.scopes[index] !== scope)
            ? { scopes: rotationScopes }
            : {}),
        });
        if (current && !current.revoked) {
          state.families.set(family.familyId, { ...current, familyExpiresAt });
        }
      });
      if (rotationRaceOutcome === 'consumed') {
        throw new InvalidGrantError(
          'The refresh token was already used; the authorization it belongs to has been revoked'
        );
      }
      if (rotationRaceOutcome !== null) {
        throw new InvalidGrantError('The refresh token is invalid or has expired');
      }

      return {
        access_token: rotatedAccessToken,
        token_type: 'Bearer',
        expires_in: accessTokenTtlSeconds,
        scope: rotationScopes.join(' '),
        refresh_token: rotatedRefreshToken,
      };
    },

    verifyAccessToken(token) {
      const lookup = resolveAccessFamily(token);
      if (!lookup) {
        throw new InvalidTokenError('The access token is invalid or has expired');
      }
      const { record, family } = lookup;
      return {
        token,
        clientId: family.clientId,
        scopes: [...(record.scopes || family.scopes)],
        expiresAt: Math.floor(record.expiresAt / 1000),
        resource: family.resource ? new URL(family.resource) : undefined,
        extra: {
          userId: family.userId,
          tenantId: family.tenantId,
          ...(family.username ? { username: family.username } : {}),
          ...(family.groups && family.groups.length > 0 ? { groups: [...family.groups] } : {}),
          ...(family.roles && family.roles.length > 0 ? { roles: [...family.roles] } : {}),
        },
      };
    },
  };

  /**
   * Explicit narrow interface for the (unwired) integration: completes one
   * previously validated pending authorization after the Entra sign-in by
   * associating the already-validated upstream access token and delegated
   * identity with the freshly issued single-use code, and returning the
   * browser redirect (code and state only) to the wiring layer.
   *
   * The association input is trusted to be previously validated (e.g. by
   * `remote/entra-auth.js`); only shape and bounds are checked here. On
   * any success the pending reference is consumed and cannot complete
   * twice. The optional `upstream: { refreshToken }` field preserves an
   * upstream Entra refresh credential for the T19 renewal seam; it stays
   * server-side only and inside the encrypted snapshot when persisted.
   */
  function completeAuthorizationAfterEntraSignIn(request) {
    if (!isPlainObject(request)) {
      throw parameterError('A completion request object is required');
    }
    const unknownKeys = Object.keys(request).filter(
      (key) => !ALLOWED_ASSOCIATION_KEYS.includes(key)
    );
    if (unknownKeys.length > 0) {
      throw parameterError(
        `unexpected completion fields; use authorizationRef, entra, and upstream only: ${unknownKeys.join(
          ', '
        )}`
      );
    }
    const upstreamRefreshToken = validateAssociationUpstream(request.upstream);
    const entra = request.entra;
    if (!isPlainObject(entra)) {
      throw parameterError('The entra association object is required');
    }
    const unknownEntraKeys = Object.keys(entra).filter((key) => !ALLOWED_ENTRA_KEYS.includes(key));
    if (unknownEntraKeys.length > 0) {
      throw parameterError(`unexpected Entra association fields: ${unknownEntraKeys.join(', ')}`);
    }
    const ref = request.authorizationRef;
    if (!isNonEmptyString(typeof ref === 'string' ? ref : '') || ref.length > MAX_STATE_LENGTH) {
      throw parameterError('authorizationRef must be the non-empty reference issued by authorize');
    }
    if (!isNonEmptyString(typeof entra.accessToken === 'string' ? entra.accessToken : '')) {
      throw parameterError(
        'entra.accessToken must be the non-empty, previously validated Entra access token'
      );
    }
    if (entra.accessToken.length > MAX_TOKEN_LENGTH || /\s/.test(entra.accessToken)) {
      throw parameterError('entra.accessToken must be a bounded, whitespace-free token');
    }
    if (
      !Number.isFinite(entra.expiresAt) ||
      entra.expiresAt < 0 ||
      entra.expiresAt > Number.MAX_SAFE_INTEGER / 2
    ) {
      throw parameterError('entra.expiresAt must be a finite non-negative epoch-seconds number');
    }
    if (!isNonEmptyString(typeof entra.objectId === 'string' ? entra.objectId : '')) {
      throw parameterError('entra.objectId must identify the delegated user');
    }
    if (
      entra.objectId.length > MAX_CLIENT_ID_LENGTH ||
      entra.tenantId.length > MAX_CLIENT_ID_LENGTH ||
      entra.tenantId.length > MAX_CLIENT_ID_LENGTH
    ) {
      throw parameterError('Entra identity fields must stay bounded');
    }
    if (!isNonEmptyString(typeof entra.tenantId === 'string' ? entra.tenantId : '')) {
      throw parameterError('entra.tenantId must identify the trusted directory');
    }
    if (
      entra.username !== undefined &&
      (!isNonEmptyString(typeof entra.username === 'string' ? entra.username : '') ||
        entra.username.length > MAX_USERNAME_LENGTH)
    ) {
      throw parameterError('entra.username must stay bounded when provided');
    }
    const validatedClaimLists = {};
    for (const listKey of ['groups', 'roles']) {
      if (entra[listKey] === undefined) {
        continue;
      }
      const list = entra[listKey];
      if (
        !Array.isArray(list) ||
        list.length > MAX_IDENTITY_CLAIMS ||
        list.some(
          (claim) =>
            !isNonEmptyString(typeof claim === 'string' ? claim : '') ||
            claim.trim() !== claim ||
            claim.length > MAX_IDENTITY_CLAIM_VALUE_LENGTH
        )
      ) {
        throw parameterError(
          `entra.${listKey} must be an array of at most ${MAX_IDENTITY_CLAIMS} non-empty, bounded claim identifiers`
        );
      }
      validatedClaimLists[listKey] = [...list];
    }

    const now = Date.now();
    purgeExpired(pendingAuthorizations, now);
    const pending = pendingAuthorizations.get(ref);
    if (!pending) {
      throw isError(
        'No active MCP authorization reference exists; start a new authorization',
        ERROR_CODES.UNKNOWN_REFERENCE
      );
    }
    if (pending.expiresAt <= now) {
      pendingAuthorizations.delete(ref);
      throw isError(
        'The MCP authorization reference has expired; start a new authorization',
        ERROR_CODES.EXPIRED
      );
    }

    purgeExpired(authorizationCodes, now);
    if (authorizationCodes.size >= maxAuthorizationCodes) {
      throw isError(
        'Too many pending authorization codes; try again shortly',
        ERROR_CODES.CAPACITY
      );
    }

    // Consume the pending reference before issuing anything: exactly one
    // completion can ever succeed per authorization.
    pendingAuthorizations.delete(ref);

    const code = randomToken();
    const expiresAt = now + authorizationCodeTtlSeconds * 1000;
    authorizationCodes.set(code, {
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      scopes: pending.scopes,
      resource: pending.resource,
      userId: entra.objectId,
      tenantId: entra.tenantId,
      username: entra.username || null,
      groups: validatedClaimLists.groups || [],
      roles: validatedClaimLists.roles || [],
      upstream: {
        accessToken: entra.accessToken,
        expiresAt: entra.expiresAt,
      },
      upstreamRefreshToken: upstreamRefreshToken || null,
      expiresAt,
    });

    const redirectTo = new URL(pending.redirectUri);
    redirectTo.searchParams.set('code', code);
    if (pending.state) {
      redirectTo.searchParams.set('state', pending.state);
    }
    return { redirectTo: redirectTo.href };
  }

  /**
   * Server-side only resolver for the later OBO wiring: associates one
   * issued MCP access token with its validated upstream Entra token. The
   * caller never learns anything when the MCP token is unknown, expired,
   * or its family was revoked, and no code path here sends the MCP token
   * or the upstream token to any other endpoint.
   */
  function resolveUpstreamEntraToken(token) {
    const lookup = resolveAccessFamily(token);
    if (!lookup) {
      return undefined;
    }
    const { family } = lookup;
    // The association is an unrefreshable binding, not a stored credential:
    // once the upstream Entra token has aged out, /mcp must fail closed so
    // the user repeats the sign-in flow instead of silently keeping access.
    if (
      !Number.isFinite(family.upstream.expiresAt) ||
      family.upstream.expiresAt <= Math.floor(Date.now() / 1000)
    ) {
      return undefined;
    }
    return upstreamAssociation(family);
  }

  /**
   * Validates the shape of one upstream-refresh callback result. The
   * callback already verifies the renewed upstream token against this
   * deployment; this provider only enforces the credential shape and
   * keeps the stored identity immutable by never reading identity fields
   * from the result.
   */
  /**
   * Validates the shape of one upstream-refresh callback result. The
   * callback already verifies the renewed upstream token against this
   * deployment; this provider only enforces the credential shape and
   * keeps the stored identity immutable by never reading identity fields
   * from the result.
   *
   * T19: the result may carry a rotated `refreshToken` credential — the
   * strict bounded, whitespace-free shape only. A result without one
   * leaves the previously stored refresh credential in place.
   */
  function validateRefreshedUpstream(result) {
    if (!isPlainObject(result)) {
      throw isError(
        'The upstream renewal callback returned an unusable result',
        ERROR_CODES.UPSTREAM_TRANSIENT
      );
    }
    if (
      !isNonEmptyString(typeof result.accessToken === 'string' ? result.accessToken : '') ||
      result.accessToken.length > MAX_TOKEN_LENGTH ||
      /\s/.test(result.accessToken)
    ) {
      throw isError(
        'The upstream renewal callback returned an unusable access token',
        ERROR_CODES.UPSTREAM_TRANSIENT
      );
    }
    if (
      !Number.isFinite(result.expiresAt) ||
      result.expiresAt < 0 ||
      result.expiresAt > Number.MAX_SAFE_INTEGER / 2
    ) {
      throw isError(
        'The upstream renewal callback returned an unusable expiry',
        ERROR_CODES.UPSTREAM_TRANSIENT
      );
    }
    let refreshToken;
    if (result.refreshToken !== undefined) {
      if (
        !isNonEmptyString(typeof result.refreshToken === 'string' ? result.refreshToken : '') ||
        result.refreshToken.length > MAX_TOKEN_LENGTH ||
        /\s/.test(result.refreshToken)
      ) {
        throw isError(
          'The upstream renewal callback returned an unusable refresh credential',
          ERROR_CODES.UPSTREAM_TRANSIENT
        );
      }
      refreshToken = result.refreshToken;
    }
    return {
      accessToken: result.accessToken,
      expiresAt: result.expiresAt,
      ...(refreshToken !== undefined ? { refreshToken } : {}),
    };
  }

  /**
   * One upstream credential is fresh when its expiry sits more than the
   * renewal window ahead of now; anything closer (or beyond) must renew.
   */
  function isFamilyUpstreamFresh(family, nowSec) {
    return (
      Number.isFinite(family.upstream.expiresAt) &&
      family.upstream.expiresAt - nowSec > UPSTREAM_REFRESH_WINDOW_SECONDS
    );
  }

  /**
   * Per-family singleflight upstream freshness. Returns the current
   * family record when the upstream credential is fresh (or freshly
   * renewed), null when it is stale and cannot be renewed (missing
   * callback, a permanent outcome, or the family is gone) - callers must
   * then fail closed and mint nothing. Callback rejections propagate and
   * every concurrent follower shares the leader's outcome exactly: the
   * renewed credential on success, the same error on a transient failure,
   * and the persisted family revocation on the permanent sentinel - so no
   * follower can ever surface a stale expired-token success after the
   * inflight completes.
   */
  const upstreamRefreshInFlight = new Map();

  async function ensureFamilyUpstreamFresh(familyId) {
    const family = families.get(familyId);
    if (!family || family.revoked) {
      return null;
    }
    const nowSec = Math.floor(Date.now() / 1000);
    if (isFamilyUpstreamFresh(family, nowSec)) {
      return family;
    }
    if (typeof refreshUpstreamCallback !== 'function') {
      return null;
    }
    const existing = upstreamRefreshInFlight.get(familyId);
    if (existing) {
      const outcome = await existing;
      return familyOutcomeToResult(outcome, familyId);
    }
    let settle;
    const inFlight = new Promise((resolve) => {
      settle = resolve;
    });
    upstreamRefreshInFlight.set(familyId, inFlight);
    let outcome;
    try {
      try {
        const result = validateRefreshedUpstream(
          await refreshUpstreamCallback({
            upstream: {
              accessToken: family.upstream.accessToken,
              expiresAt: family.upstream.expiresAt,
              ...(family.upstream.refreshToken !== undefined
                ? { refreshToken: family.upstream.refreshToken }
                : {}),
            },
            identity: {
              objectId: family.userId,
              tenantId: family.tenantId,
              ...(family.username ? { username: family.username } : {}),
              groups: [...(family.groups || [])],
              roles: [...(family.roles || [])],
            },
          })
        );
        // Commit before anything is observable. A rotated refresh
        // credential replaces the stored one; a result without one keeps
        // the previous credential (never drops the granted capability).
        persist((state) => {
          const current = state.families.get(familyId);
          if (current && !current.revoked && current.familyExpiresAt > Date.now()) {
            state.families.set(familyId, {
              ...current,
              upstream: {
                accessToken: result.accessToken,
                expiresAt: result.expiresAt,
                ...(result.refreshToken !== undefined
                  ? { refreshToken: result.refreshToken }
                  : current.upstream.refreshToken !== undefined
                    ? { refreshToken: current.upstream.refreshToken }
                    : {}),
              },
            });
          }
        });
        outcome = true;
      } catch (error) {
        if (error && error.code === UPSTREAM_REAUTH_REQUIRED) {
          // Permanent: the family is invalidated (its persisted record too)
          // before any caller observes the failure, so neither the leader
          // nor a follower can resurrect it or mint from it again.
          persist((state) => revokeFamily(state, familyId));
          outcome = false;
        } else {
          outcome = error;
        }
      }
      settle(outcome);
    } finally {
      upstreamRefreshInFlight.delete(familyId);
    }
    return familyOutcomeToResult(outcome, familyId);
  }

  /**
   * Maps one settled singleflight outcome onto the fail-closed result: a
   * shared error rethrows, the permanent outcome yields null (the family
   * is now revoked), and only a verifiably fresh family yields itself.
   */
  function familyOutcomeToResult(outcome, familyId) {
    if (outcome instanceof Error) {
      throw outcome;
    }
    if (outcome !== true) {
      return null;
    }
    return families.get(familyId) || null;
  }

  /**
   * T19 seam (not yet wired anywhere): resolves the validated upstream
   * association for one MCP access token and renews the upstream
   * credential through the injected callback when it is stale or near
   * expiry, once per family under a singleflight, committing the renewal
   * to the persistent store before it is observable. Fail-closed:
   * undefined for an unusable token, no callback, or a permanent re-auth
   * result; a distinguished error for transient callback failures.
   */
  async function ensureUpstreamEntraToken(token) {
    const lookup = resolveAccessFamily(token);
    if (!lookup) {
      return undefined;
    }
    try {
      const fresh = await ensureFamilyUpstreamFresh(lookup.family.familyId);
      if (!fresh || !fresh.upstream) {
        return undefined;
      }
      return upstreamAssociation(fresh);
    } catch (error) {
      if (error && error.code === UPSTREAM_REAUTH_REQUIRED) {
        return undefined;
      }
      if (error instanceof MCPOAuthProviderError) {
        throw error;
      }
      throw isError(
        'The upstream Microsoft renewal failed transiently; try again',
        ERROR_CODES.UPSTREAM_TRANSIENT
      );
    }
  }

  /**
   * Closes the injected persistent store (idempotent). The bridge-store
   * contract makes later operations fail closed.
   */
  function close() {
    if (persistentStore) {
      persistentStore.close();
    }
  }

  /**
   * Read-only, secret-free descriptor for one pending MCP authorization,
   * consumed by the wired consent page: it shows the client, the exact
   * registered redirect, and the requested permissions. No code challenge,
   * state, or token material is ever included; unknown or expired
   * references resolve to undefined.
   */
  function getPendingAuthorizationDescriptor(ref) {
    if (!isNonEmptyString(typeof ref === 'string' ? ref : '') || ref.length > MAX_STATE_LENGTH) {
      return undefined;
    }
    const now = Date.now();
    purgeExpired(pendingAuthorizations, now);
    const pending = pendingAuthorizations.get(ref);
    if (!pending) {
      return undefined;
    }
    return {
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      scopes: [...pending.scopes],
      expiresAt: pending.expiresAt,
    };
  }

  const rateLimitOptions = normalized.rateLimit ? {} : { rateLimit: false };

  // SDK metadata with one deliberate correction: createOAuthMetadata
  // hardcodes grant_types_supported, and this server implements exactly the
  // authorization-code grant plus T18's rotating refresh-token grant, so
  // the claim names exactly what exists. Revocation stays unimplemented
  // and unadvertised. Everything else stays the SDK's standard values.
  const metadata = {
    ...createOAuthMetadata({
      provider,
      issuerUrl: normalized.issuerUrl,
      baseUrl: normalized.baseUrl || undefined,
      scopesSupported: normalized.supportedScopes,
    }),
    grant_types_supported: ['authorization_code', 'refresh_token'],
  };

  const resourceServerUrl =
    normalized.resourceServerUrl || normalized.baseUrl || normalized.issuerUrl;

  // Unwired route table composed exclusively from the SDK's handlers:
  // authorize, token, protected-resource/authorization-server metadata, and
  // (only when explicitly enabled) registration. No revocation endpoint
  // exists because revocation is not implemented.
  const router = express.Router();
  router.use('/authorize', authorizationHandler({ provider, ...rateLimitOptions }));
  router.use('/token', tokenHandler({ provider, ...rateLimitOptions }));
  router.use(
    mcpAuthMetadataRouter({
      oauthMetadata: metadata,
      resourceServerUrl,
      scopesSupported: normalized.supportedScopes,
    })
  );
  if (normalized.allowDynamicRegistration) {
    router.use(
      '/register',
      clientRegistrationHandler({
        clientsStore,
        clientSecretExpirySeconds: normalized.clientSecretExpirySeconds,
        ...rateLimitOptions,
      })
    );
  }

  return {
    provider,
    clientsStore,
    router,
    metadata,
    completeAuthorizationAfterEntraSignIn,
    getPendingAuthorizationDescriptor,
    resolveUpstreamEntraToken,
    ensureUpstreamEntraToken,
    close,
  };
}

module.exports = {
  createMCPOAuthProvider,
  MCPOAuthProviderError,
  ERROR_CODES,
  UPSTREAM_REAUTH_REQUIRED,
};
