/**
 * Remote MCP Streamable HTTP transport for an intranet deployment with
 * delegated per-user Entra identity (task T2, S1-S3).
 *
 * One authenticated HTTP listener that:
 *   - verifies the inbound Microsoft Entra access token (issuer, audience for
 *     this MCP deployment, tenant, expiry, delegated user identity, and the
 *     required delegated scope) before any MCP dispatch (`remote/entra-auth.js`);
 *   - exchanges that verified token per request through the on-behalf-of flow
 *     into request-scoped Graph and Flow token stores (`remote/obo-token-store.js`),
 *     routed into the existing handlers via `auth/index.js`
 *     `runWithTokenStorage(...)`. There is no local credential fallback: a
 *     request without a verified bearer token never reaches an MCP tool, and
 *     the singletons used by stdio are never consulted inside the ALS scope;
 *   - restricts data-modifying tools to identities carrying the configured
 *     Entra group or role. The non-mutating set is a conservative explicit
 *     allowlist; every other tool is denied by default. Local
 *     authentication/Vault/server-lifecycle tools are excluded from the
 *     remote tool list and from tool invocation (they bypass request-scoped
 *     isolation);
 *   - serves the OAuth protected-resource discovery document and rejects
 *     unauthenticated requests with RFC 9728 `WWW-Authenticate` metadata;
 *   - when the standards MCP OAuth flow is configured (task T6, S5), the
 *     service is itself the first advertised authorization server: external
 *     MCP clients start a standards authorization-code flow at `/authorize`,
 *     the browser gets a service-owned consent page (`remote/login-page.js`)
 *     naming the client, its exact registered redirect and the requested
 *     permissions behind one-time CSRF protection, and only an explicit
 *     consent starts the upstream Microsoft sign-in (`remote/entra-login.js`)
 *     before the authorization code is returned to the exact registered
 *     client redirect. Client-supplied tokens at /mcp are accepted either as
 *     raw delegated Entra tokens (verified by `remote/entra-auth.js`) or as
 *     MCP access tokens issued by `remote/oauth-provider.js`, whose
 *     server-side upstream association feeds the per-request OBO exchange;
 *     the upstream Entra token itself is never exposed to any client and is
 *     always re-verified against this API (signature, issuer, audience,
 *     tenant, expiry, delegated scp scopes, and the same user as the ID
 *     token) before any MCP authorization binds or an on-behalf-of exchange
 *     runs. The upstream Entra authorization request uses the explicitly
 *     configured resource-qualified custom API scopes
 *     (`api://<app-id>/<scope>` / `https://<host>/<scope>`, never guessed),
 *     while token verification requires the short scope names issued tokens
 *     carry in `scp`.
 *   - refuses to start when test mode is enabled, when configuration is
 *     missing, when the listener would be exposed without TLS outside the
 *     loopback addresses, and when a wildcard bind (0.0.0.0 or ::) has no
 *     explicit canonical external base URL to advertise in discovery. Intranet
 *     deployments terminate TLS at a reverse proxy and keep this listener
 *     loopback-bound. One explicitly opted-in local development exception
 *     (MCP_HTTP_ALLOW_LOCAL_HTTP=true, task T9) additionally accepts a plain
 *     loopback Entra callback (http://localhost:<port>/login/callback, per
 *     Microsoft's loopback-only plain HTTP redirect rule) and a plaintext
 *     wildcard container listener published strictly on the host loopback;
 *     it never accepts plain HTTP for intranet or public addresses. A second
 *     explicitly opted-in mode (MCP_HTTP_REVERSE_PROXY_HTTP=true) accepts the
 *     plaintext HTTP upstream listener for an operator-managed HTTPS reverse
 *     proxy, typically on another server, but only with a canonical https://
 *     external base URL; forwarded Host/proto headers stay untrusted, every
 *     other plaintext guard is untouched, and protecting the plaintext
 *     upstream hop is the operator's explicitly accepted responsibility.
 *
 * Every HTTP request gets its own MCP protocol server and stateless transport
 * and runs entirely inside one `AsyncLocalStorage` token-store scope, so
 * concurrent requests can never share an identity, cache, or credential.
 *
 * Errors and logs never contain the presented token, client secret, or the
 * delegated identity of a user.
 */
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { isIPv6 } = require('node:net');
const crypto = require('node:crypto');
const querystring = require('querystring');
const express = require('express');
const {
  StreamableHTTPServerTransport,
} = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { createMCPServer } = require('../index');
const { runWithTokenStorage, authTools } = require('../auth');
const { createEntraTokenVerifier } = require('./entra-auth');
const { createRequestOboTokenStore } = require('./obo-token-store');
const { createMCPOAuthProvider, UPSTREAM_REAUTH_REQUIRED } = require('./oauth-provider');
const { createEntraLogin, EntraLoginError } = require('./entra-login');
const { createEntraTokenRefresher } = require('./entra-refresh');
const { REAUTH_REQUIRED: REFRESH_REAUTH_REQUIRED } = require('./entra-refresh');
const { createBridgeStore } = require('./bridge-store');
const {
  SECURITY_HEADERS,
  securityHeaders,
  renderConsentLoginPage,
  renderLoginErrorPage,
} = require('./login-page');

const MCP_PATH = '/mcp';
const DISCOVERY_PATH = '/.well-known/oauth-protected-resource';
const AUTHORIZATION_SERVER_METADATA_PATH = '/.well-known/oauth-authorization-server';
const AUTHORIZE_PATH = '/authorize';
const TOKEN_PATH = '/token';
const REGISTER_PATH = '/register';
const LOGIN_PAGE_PATH = '/login';
const CONSENT_PATH = '/login/consent';
const CALLBACK_PATH = '/login/callback';
const MAX_REQUEST_BODY_BYTES = 5 * 1024 * 1024;
const MAX_FORM_BODY_BYTES = 16 * 1024;
const MAX_CONSENT_CSRF_ENTRIES = 2000;
const MAX_STATE_REF_BINDINGS = 2000;
const CONSENT_CSRF_TTL_MS = 10 * 60 * 1000;
const CONFIG_ERROR_CODE = 'MCP_HTTP_CONFIG_INVALID';

const ENTRA_GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', 'localhost.localdomain', '::1']);

/**
 * Local authentication/Vault/server-lifecycle tools. They rely on the local
 * token file and (in test mode) the legacy token-manager bypass, so the remote
 * tool list and the remote tool-call path must never include them. Derived
 * from the authoritative auth tool array so it cannot drift.
 */
const LOCAL_EXCLUDED_TOOL_NAMES = Object.freeze(authTools.map((tool) => tool.name));

const LOCAL_EXCLUDED_TOOL_NAME_SET = new Set(LOCAL_EXCLUDED_TOOL_NAMES);

/**
 * The remote tool filter: every local auth/Vault/server-lifecycle tool is
 * removed from both tools/list and tools/call for HTTP connections.
 */
function remoteToolFilter(toolName) {
  return !LOCAL_EXCLUDED_TOOL_NAME_SET.has(toolName);
}

/**
 * Express error middleware for the standards OAuth endpoints: unexpected
 * failures answer with one opaque JSON error; the SDK handlers already cover
 * their own standard error shapes. The four-parameter signature (with the
 * intentionally unused last argument) is an Express error-middleware
 * requirement.
 */
// eslint-disable-next-line no-unused-vars -- Express error-middleware signature
function oauthErrorMiddleware(error, request, response, next) {
  console.error('[mcp-http] oauth endpoint failed: internal-error');
  if (!response.headersSent) {
    response.writeHead(500, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    });
    response.end(JSON.stringify({ error: 'server_error' }));
  } else {
    response.destroy();
  }
}

/**
 * Value-free OAuth endpoint diagnostics (T14): logs only the method, path,
 * response status and, for the token endpoint, the standard OAuth `error`
 * code. No body, code, token, or client identifier is ever logged.
 */
function oauthRequestLogger(req, res, next) {
  if (req.method === 'GET' && req.path === AUTHORIZE_PATH) {
    res.on('finish', () => console.error(`[mcp-http] OAuth GET /authorize -> ${res.statusCode}`));
  } else if (req.method === 'POST' && req.path === TOKEN_PATH) {
    let oauthErrorCode = null;
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      if (body && typeof body === 'object' && typeof body.error === 'string') {
        oauthErrorCode = body.error;
      }
      return originalJson(body);
    };
    res.on('finish', () =>
      console.error(
        `[mcp-http] OAuth POST /token -> ${res.statusCode}${oauthErrorCode ? ` error=${oauthErrorCode}` : ''}`
      )
    );
  }
  next();
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function configError(message) {
  const error = new Error(message);
  error.code = CONFIG_ERROR_CODE;
  return error;
}

/** Remote-mode environment variable names, for safe, secret-free validation messages. */
const REQUIRED_ENV_KEYS = ['ENTRA_TENANT_ID', 'ENTRA_CLIENT_ID', 'ENTRA_CLIENT_SECRET'];

/** T12 (S1-S8): the short scope name default when no scope override is set. */
const DEFAULT_REQUIRED_SHORT_SCOPE = 'mcp.access';

/**
 * Provider option keys that may be passed through from the `oauth`
 * configuration into the standards-based MCP OAuth provider (T6). The exact
 * browser callback address is configured separately and is not a provider
 * option.
 */
const OAUTH_PROVIDER_OPTION_KEYS = [
  'clients',
  'supportedScopes',
  'allowDynamicRegistration',
  'accessTokenTtlSeconds',
  'authorizationCodeTtlSeconds',
  'pendingAuthorizationTtlSeconds',
  'maxPendingAuthorizations',
  'maxAuthorizationCodes',
  'maxAccessTokens',
  'maxRegisteredClients',
  // T19 seam options: the bounded refresh-family TTL plus the two injection
  // seams the persistent bridge is wired through (an injectable store and an
  // injectable upstream renewal callback; without them the CLI runtime
  // derives both itself from the bridge configuration).
  'refreshTokenTtlSeconds',
  'persistentStore',
  'refreshUpstreamEntraToken',
];
const OAUTH_ALLOWED_CONFIG_KEYS = [
  'loginRedirectUri',
  'upstreamScopes',
  ...OAUTH_PROVIDER_OPTION_KEYS,
  // T19 bridge storage: an explicit durable store directory and an optional
  // separate, already-mounted key file. Never provider options: the runtime
  // creates the one bridge store itself, bound to the canonical deployment.
  'storeDirectory',
  'keyFile',
];

/**
 * Entra authorization requests for a custom API must name the scope with its
 * resource qualifier (api://<app-id>/<scope> or https://<host>/<scope>);
 * issued access tokens, in contrast, carry only the short scope name in scp.
 */
const RESOURCE_QUALIFIED_SCOPE_PATTERN = /^(?:api:\/\/|https:\/\/)[^\s]+$/i;

function isResourceQualifiedScope(scope) {
  return typeof scope === 'string' && RESOURCE_QUALIFIED_SCOPE_PATTERN.test(scope);
}

function isShortScopeName(scope) {
  return typeof scope === 'string' && scope.length > 0 && !/^(?:api:\/\/|https:\/\/)/i.test(scope);
}

/**
 * T12 (S1-S8): extracts the short scp scope name a resource-qualified Entra
 * authorization-request scope issues (everything after the first slash that
 * separates the api:// or https:// resource authority from the scope name),
 * or null when the entry carries no scope part at all.
 */
function resourceQualifiedShortScope(scope) {
  if (typeof scope !== 'string') {
    return null;
  }
  const withoutScheme = scope.replace(/^(?:api|https):\/\//i, '');
  const scopeSeparator = withoutScheme.indexOf('/');
  if (scopeSeparator === -1) {
    return null;
  }
  const shortScope = withoutScheme.slice(scopeSeparator + 1);
  return shortScope.length > 0 ? shortScope : null;
}

function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

/**
 * Precisely classifies unspecified ("wildcard") bind hosts: the IPv4
 * unspecified address (0.0.0.0) and any IPv6 form of the unspecified address
 * (for example :: and ::0, including the full 0:0:0:0:0:0:0:0 form and
 * IPv4-mapped ::0.0.0.0). A listener bound to such an address cannot derive a
 * usable client-reachable discovery URL from the bind alone.
 */
function isUnspecifiedBindHost(host) {
  if (host === '0.0.0.0') {
    return true;
  }
  if (!isIPv6(host)) {
    return false;
  }
  const groups = expandIPv6Groups(host);
  return groups !== null && groups.every((group) => group === 0);
}

/**
 * Expands an IPv6 address into its eight 16-bit numeric groups, resolving
 * the "::" compression and embedded dotted-quad IPv4 forms. Returns null for
 * malformed input (treated as non-wildcard; Node's isIPv6 already filtered
 * the truly invalid forms).
 */
function expandIPv6Groups(host) {
  const halves = host.split('::');
  if (halves.length > 2) {
    return null;
  }
  const decodeGroups = (text) =>
    (text ? text.split(':') : []).flatMap((group) => {
      if (!group.includes('.')) {
        return [parseInt(group, 16)];
      }
      // Embedded IPv4: each dotted quad expands into two 16-bit groups.
      const octets = group.split('.').map((part) => Number(part));
      if (
        octets.length === 4 &&
        octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
      ) {
        return [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]];
      }
      return [null];
    });
  const left = decodeGroups(halves[0]);
  const right = halves.length === 2 ? decodeGroups(halves[1]) : [];
  if (left.some((group) => group === null) || right.some((group) => group === null)) {
    return null;
  }
  const compressedZeros = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (compressedZeros < 0) {
    return null;
  }
  const groups = [...left, ...new Array(compressedZeros).fill(0), ...right];
  return groups.length === 8 && groups.every((group) => Number.isInteger(group)) ? groups : null;
}

/**
 * Normalizes one pre-registered external MCP client entry from environment
 * configuration into the provider options shape. Fails closed on a malformed
 * entry so a bad registration can never silently disable client validation.
 */
function normalizeOauthClientConfig(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw configError(
      'Every MCP_HTTP_OAUTH_CLIENTS entry must be an object with clientId and redirectUris.'
    );
  }
  if (
    !isNonEmptyString(entry.clientId) ||
    /\s/.test(entry.clientId) ||
    entry.clientId.length > 128
  ) {
    throw configError(
      'Every MCP_HTTP_OAUTH_CLIENTS entry needs a non-empty, whitespace-free clientId of at most 128 characters.'
    );
  }
  if (
    entry.clientSecret !== undefined &&
    (!isNonEmptyString(entry.clientSecret) || entry.clientSecret.length > 256)
  ) {
    throw configError(
      'A MCP_HTTP_OAUTH_CLIENTS clientSecret, when present, must be a non-empty string of at most 256 characters.'
    );
  }
  if (
    !Array.isArray(entry.redirectUris) ||
    entry.redirectUris.length === 0 ||
    entry.redirectUris.some((uri) => !isNonEmptyString(typeof uri === 'string' ? uri : ''))
  ) {
    throw configError(
      'Every MCP_HTTP_OAUTH_CLIENTS entry needs a non-empty redirectUris array of registered callback URLs.'
    );
  }
  const client = { clientId: entry.clientId, redirectUris: entry.redirectUris.map(String) };
  if (entry.clientSecret !== undefined) {
    client.clientSecret = entry.clientSecret;
  }
  return client;
}

function validateTenantId(rawTenant) {
  const tenantId = rawTenant.trim().toLowerCase();
  if (!ENTRA_GUID_PATTERN.test(tenantId)) {
    throw configError(
      'ENTRA_TENANT_ID must be the specific Microsoft Entra directory (tenant) GUID, never "common" or a domain name.'
    );
  }
  return tenantId;
}

function validateRawTlsCertificate(rawCert, env) {
  try {
    return fs.readFileSync(rawCert, 'utf8');
  } catch {
    throw configError(
      `MCP_HTTP_TLS_CERT must point to a readable PEM certificate (could not read ${env}).`
    );
  }
}

/**
 * Resolves and validates all remote MCP HTTP configuration from an
 * environment-style object. Fails closed before any listener is created:
 * missing keys are named, test mode is refused, and a non-loopback binding
 * without TLS is rejected as insecure.
 */
function resolveRemoteMcpConfig(env) {
  if (!env || typeof env !== 'object') {
    throw configError('A remote configuration environment object is required');
  }

  if (env.USE_TEST_MODE === 'true') {
    throw configError(
      'Test mode must stay local: the remote MCP HTTP server refuses to start when USE_TEST_MODE=true.'
    );
  }

  // T9 (S4-S6): the plaintext local development allowance is an explicit,
  // value-exact opt-in. Any other value (a typo, "false", "True") must fail
  // closed instead of silently disabling the default HTTPS-only guards.
  const rawAllowLocalHttp = isNonEmptyString(env.MCP_HTTP_ALLOW_LOCAL_HTTP)
    ? env.MCP_HTTP_ALLOW_LOCAL_HTTP.trim()
    : undefined;
  if (rawAllowLocalHttp !== undefined && rawAllowLocalHttp !== 'true') {
    throw configError(
      'MCP_HTTP_ALLOW_LOCAL_HTTP must be exactly "true" when set: it opts into plaintext loopback HTTP (local development only, published on the host loopback) and is never for intranet or public deployments.'
    );
  }
  const allowLocalHttp = rawAllowLocalHttp === 'true';

  // The reverse-proxy HTTP transport opt-in is value-exact like the local
  // development allowance: any other value (a typo, "true ", "True", or a
  // string boolean) fails closed instead of silently enabling plaintext
  // listening. The programmatic constructor enforces the same policy with a
  // strict boolean field.
  const rawReverseProxyHttp = isNonEmptyString(env.MCP_HTTP_REVERSE_PROXY_HTTP)
    ? env.MCP_HTTP_REVERSE_PROXY_HTTP.trim()
    : undefined;
  if (rawReverseProxyHttp !== undefined && rawReverseProxyHttp !== 'true') {
    throw configError(
      'MCP_HTTP_REVERSE_PROXY_HTTP must be exactly "true" when set: it opts into a plaintext HTTP upstream listener behind an operator-managed HTTPS reverse proxy and is never for direct public exposure.'
    );
  }
  const reverseProxyHttp = rawReverseProxyHttp === 'true';

  const missing = REQUIRED_ENV_KEYS.filter((key) => !isNonEmptyString(env[key]));
  if (missing.length > 0) {
    throw configError(`Missing required remote MCP HTTP configuration: ${missing.join(', ')}.`);
  }

  // T16 (S5,S10): the explicit authentication-mode selector. "entra" runs the
  // direct Entra authorization-server mode (preferred): clients sign in
  // directly with the tenant Entra issuer and keep their own refresh
  // credentials client-side. "bridge" runs the legacy standards-based
  // service-OAuth sign-in flow (it stays functional but incomplete: it never
  // renews upstream credentials). Without the selector, the previous behavior
  // is preserved: bridge exactly when the login redirect is configured, direct
  // Entra otherwise. Any other value fails closed so a typo can never silently
  // change the authentication mode.
  let selectorAuthMode = null;
  if (env.MCP_HTTP_AUTH_MODE !== undefined) {
    const rawAuthMode = isNonEmptyString(env.MCP_HTTP_AUTH_MODE)
      ? env.MCP_HTTP_AUTH_MODE.trim()
      : undefined;
    if (rawAuthMode !== 'entra' && rawAuthMode !== 'bridge') {
      throw configError(
        'MCP_HTTP_AUTH_MODE must be exactly "entra" (direct Entra authorization server, preferred) or "bridge" (legacy standards OAuth sign-in flow); any other value is refused so a typo can never silently change the authentication mode.'
      );
    }
    selectorAuthMode = rawAuthMode;
  }
  const loginRedirectConfigured = isNonEmptyString(env.MCP_HTTP_LOGIN_REDIRECT_URI);
  const authMode = selectorAuthMode || (loginRedirectConfigured ? 'bridge' : 'entra');

  const portRaw =
    env.MCP_HTTP_PORT === undefined || env.MCP_HTTP_PORT === '' ? '3000' : env.MCP_HTTP_PORT;
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw configError('MCP_HTTP_PORT must be an integer between 0 and 65535.');
  }

  const host = (isNonEmptyString(env.MCP_HTTP_HOST) ? env.MCP_HTTP_HOST : '127.0.0.1').trim();
  const unbracketedHost = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (!isNonEmptyString(unbracketedHost) || /[\s/@]/.test(unbracketedHost)) {
    throw configError('MCP_HTTP_HOST must be a bare hostname or IP address.');
  }

  const tenantId = validateTenantId(env.ENTRA_TENANT_ID);

  const clientId = env.ENTRA_CLIENT_ID.trim();
  if (!isNonEmptyString(clientId)) {
    throw configError(
      'ENTRA_CLIENT_ID must be the non-empty application (client) ID of the confidential MCP client.'
    );
  }

  // T12 (S1-S8): minimal-setup defaults. With the Entra v2.0 endpoint the
  // access token's `aud` is the API application's client ID GUID, so that is
  // the audience default; MCP_HTTP_AUDIENCE remains an explicit override for
  // deployments whose tokens carry a different (for example v1-style app ID
  // URI) audience, and keeps its existing non-empty validation.
  let audience;
  if (isNonEmptyString(env.MCP_HTTP_AUDIENCE)) {
    audience = env.MCP_HTTP_AUDIENCE.trim();
    if (!isNonEmptyString(audience)) {
      throw configError('MCP_HTTP_AUDIENCE must be a non-empty audience for this MCP deployment.');
    }
  } else {
    audience = clientId;
  }

  // T12 (S1-S8): MCP_HTTP_UPSTREAM_SCOPES is parsed and validated whenever it
  // is configured (exactly as before, resource-qualified scopes only); its
  // short scope parts feed the required-scope derivation below, and when the
  // standards sign-in flow is configured without it, the upstream scopes
  // derive from the same client id that owns the exposed API scope.
  let configuredUpstreamScopes = null;
  if (isNonEmptyString(env.MCP_HTTP_UPSTREAM_SCOPES)) {
    configuredUpstreamScopes = env.MCP_HTTP_UPSTREAM_SCOPES.trim()
      .split(/[\s,]+/)
      .filter(Boolean);
    if (
      configuredUpstreamScopes.length === 0 ||
      configuredUpstreamScopes.some((scope) => !isResourceQualifiedScope(scope))
    ) {
      throw configError(
        'MCP_HTTP_UPSTREAM_SCOPES must carry at least one resource-qualified scope of the form api://<app-id>/<scope> or https://<host>/<scope>; short scope names are never accepted here because Entra requires API-qualified requested scopes for custom APIs.'
      );
    }
  }

  const upstreamShortScopes = configuredUpstreamScopes
    ? [...new Set(configuredUpstreamScopes.map(resourceQualifiedShortScope).filter(Boolean))]
    : null;

  // T12 (S1-S8): the required short scp scope names stay exactly as
  // validated when MCP_HTTP_REQUIRED_SCOPES is configured (API-qualified
  // values are still refused); without that override they derive from the
  // explicitly configured upstream scope's short part, and default to
  // mcp.access only when no scope override exists at all.
  let requiredScopes;
  if (isNonEmptyString(env.MCP_HTTP_REQUIRED_SCOPES)) {
    requiredScopes = env.MCP_HTTP_REQUIRED_SCOPES.trim()
      .split(/[\s,]+/)
      .filter(Boolean);
    if (requiredScopes.length === 0) {
      throw configError(
        'MCP_HTTP_REQUIRED_SCOPES must carry at least one non-empty delegated scope for this MCP deployment.'
      );
    }
    if (requiredScopes.some((scope) => !isShortScopeName(scope))) {
      throw configError(
        'MCP_HTTP_REQUIRED_SCOPES must contain short scope names exactly as they appear in the access token scp claim. Entra v2 tokens carry the API client GUID in aud and short scope names in scp; resource-qualified authorization-request scopes (api://<app-id>/<scope> or https://<host>/<scope>) belong in MCP_HTTP_UPSTREAM_SCOPES for the standards sign-in flow.'
      );
    }
  } else if (upstreamShortScopes && upstreamShortScopes.length > 0) {
    requiredScopes = upstreamShortScopes;
  } else if (upstreamShortScopes) {
    throw configError(
      'MCP_HTTP_UPSTREAM_SCOPES entries carry no short scope name after the resource authority (api://<app-id>/<scope> or https://<host>/<scope>); set MCP_HTTP_REQUIRED_SCOPES to the short scp scope name(s) the issued tokens must carry.'
    );
  } else {
    requiredScopes = [DEFAULT_REQUIRED_SHORT_SCOPE];
  }

  // T16 (S5,S10): the fully resource-qualified Entra request scopes that
  // direct-mode discovery advertises (scopes_supported and the WWW-Authenticate
  // scope attribute). Reuses the T12 derivation: the explicitly configured
  // upstream scopes when present, otherwise api://<client id>/<required short
  // scope>. Token verification keeps validating the short scp names instead —
  // the qualified form is only what Entra authorization requests must carry.
  const entraRequestScopes =
    configuredUpstreamScopes || requiredScopes.map((scope) => `api://${clientId}/${scope}`);

  const allowedOrigins = (env.MCP_HTTP_ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  for (const origin of allowedOrigins) {
    try {
      // Value itself never logged; only the key name is echoed on failure.
      const parsed = new URL(origin);
      if (parsed.protocol !== 'https:' && !isLoopbackHost(parsed.hostname)) {
        throw new Error('non-loopback origin must be https');
      }
    } catch {
      throw configError(
        'MCP_HTTP_ALLOWED_ORIGINS entries must be absolute https:// origins (except loopback origins).'
      );
    }
  }

  let externalBaseUrl = null;
  if (isNonEmptyString(env.MCP_HTTP_EXTERNAL_BASE_URL)) {
    const baseUrl = env.MCP_HTTP_EXTERNAL_BASE_URL.trim();
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== 'https:' && !isLoopbackHost(parsed.hostname)) {
        throw new Error('external base URL must be https');
      }
      externalBaseUrl = parsed.origin;
    } catch {
      throw configError(
        'MCP_HTTP_EXTERNAL_BASE_URL must be an absolute https:// URL of the publicly reachable endpoint.'
      );
    }
  }

  // A reverse-proxy transport explicitly requires the canonical HTTPS base
  // URL even when the bind itself would be a loopback address: without TLS on
  // this listener, discovery can only ever advertise the exact HTTPS address
  // the external reverse proxy serves, never a plaintext or derived URL.
  if (reverseProxyHttp && (!externalBaseUrl || new URL(externalBaseUrl).protocol !== 'https:')) {
    throw configError(
      'MCP_HTTP_REVERSE_PROXY_HTTP=true requires the canonical MCP_HTTP_EXTERNAL_BASE_URL to be an absolute https:// URL of the address the external reverse proxy serves; plaintext discovery URLs are never accepted in this mode.'
    );
  }

  // TLS is configured through optional PEM certificate/key file paths. Even on
  // this loopback listener, misconfigured paths must fail startup, not listen.
  let tls = null;
  if (isNonEmptyString(env.MCP_HTTP_TLS_CERT) || isNonEmptyString(env.MCP_HTTP_TLS_KEY)) {
    if (!isNonEmptyString(env.MCP_HTTP_TLS_CERT) || !isNonEmptyString(env.MCP_HTTP_TLS_KEY)) {
      throw configError('MCP_HTTP_TLS_CERT and MCP_HTTP_TLS_KEY must be provided together.');
    }
    tls = {
      cert: validateRawTlsCertificate(env.MCP_HTTP_TLS_CERT, 'MCP_HTTP_TLS_CERT'),
      key: validateRawTlsCertificate(env.MCP_HTTP_TLS_KEY, 'MCP_HTTP_TLS_KEY'),
    };
  }

  if (
    !tls &&
    !isLoopbackHost(unbracketedHost) &&
    // T9 (S4-S6): only the explicitly opted-in local development mode may
    // run a plaintext wildcard container listener, whose exposure depends
    // entirely on Docker publishing the port to the host loopback (the local
    // Compose config pins 127.0.0.1); container-network traffic stays
    // unencrypted and is visible to other local Docker workloads.
    !(allowLocalHttp && isUnspecifiedBindHost(unbracketedHost)) &&
    // The explicitly opted-in reverse-proxy transport: the operator's HTTPS
    // reverse proxy terminates client TLS on its own server and forwards to
    // this plaintext upstream; its protection is the operator's
    // responsibility, and the canonical HTTPS base URL remains mandatory.
    !reverseProxyHttp
  ) {
    throw configError(
      "Insecure listener refused: bind MCP_HTTP_HOST to a loopback address (behind an HTTPS reverse proxy) or configure MCP_HTTP_TLS_CERT and MCP_HTTP_TLS_KEY. The only plaintext exceptions are the explicitly opted-in local development mode (MCP_HTTP_ALLOW_LOCAL_HTTP=true) for a container published strictly on the host loopback and the explicitly opted-in reverse-proxy transport (MCP_HTTP_REVERSE_PROXY_HTTP=true) with a canonical https:// MCP_HTTP_EXTERNAL_BASE_URL, whose plaintext HTTP upstream protection is the operator's responsibility."
    );
  }

  // Fail closed on wildcard binds: 0.0.0.0/:: cannot yield a usable
  // client-reachable discovery URL from the bind alone, and the untrusted
  // request Host header is never reflected. Require an explicit canonical
  // base URL before any listener accepts connections.
  if (isUnspecifiedBindHost(unbracketedHost) && !externalBaseUrl) {
    throw configError(
      'Discovery fail-closed: a wildcard bind host (for example 0.0.0.0 or ::) cannot produce a usable discovery URL; set MCP_HTTP_EXTERNAL_BASE_URL to the absolute https:// URL that MCP clients use to reach this deployment.'
    );
  }

  // Standards-based MCP OAuth (task T6, S5) is enabled exactly in bridge mode:
  // by the auto-selection (the browser callback URL for the upstream Entra
  // sign-in is configured) or by the explicit MCP_HTTP_AUTH_MODE=bridge
  // selector, which requires the same complete configuration here. In direct
  // Entra mode (explicit or auto-fallback) the legacy bridge-only settings
  // (login redirect, pre-registered clients, supported scopes, dynamic
  // registration) are ignored entirely, while the ordinary shared
  // audience/tenant/scope validation above stays enforced.
  let oauth = null;
  if (authMode === 'bridge') {
    if (!loginRedirectConfigured) {
      throw configError(
        'MCP_HTTP_AUTH_MODE=bridge requires the complete legacy bridge configuration: set the exact MCP_HTTP_LOGIN_REDIRECT_URI browser callback URL (or remove MCP_HTTP_AUTH_MODE so bridge is selected automatically only when the login redirect is configured).'
      );
    }
    const loginRedirectRaw = env.MCP_HTTP_LOGIN_REDIRECT_URI.trim();
    let loginRedirect;
    try {
      loginRedirect = new URL(loginRedirectRaw);
    } catch {
      throw configError(
        'MCP_HTTP_LOGIN_REDIRECT_URI must be the exact absolute HTTPS callback URL of this service for the upstream Microsoft sign-in.'
      );
    }
    if (
      (loginRedirect.protocol !== 'https:' &&
        !(
          allowLocalHttp &&
          loginRedirect.protocol === 'http:' &&
          isLoopbackHost(loginRedirect.hostname.replace(/^\[|\]$/g, '').toLowerCase())
        )) ||
      !loginRedirect.hostname ||
      loginRedirect.username ||
      loginRedirect.password ||
      loginRedirect.search ||
      loginRedirect.hash
    ) {
      throw configError(
        'MCP_HTTP_LOGIN_REDIRECT_URI must be an exact HTTPS URL without credentials, query, or fragment (an exact loopback http:// URL is accepted only in the explicitly opted-in local development mode, MCP_HTTP_ALLOW_LOCAL_HTTP=true).'
      );
    }

    let oauthClients = [];
    if (isNonEmptyString(env.MCP_HTTP_OAUTH_CLIENTS)) {
      let parsedClients;
      try {
        parsedClients = JSON.parse(env.MCP_HTTP_OAUTH_CLIENTS);
      } catch {
        throw configError(
          'MCP_HTTP_OAUTH_CLIENTS must be a JSON array of registered MCP client objects.'
        );
      }
      if (!Array.isArray(parsedClients)) {
        throw configError(
          'MCP_HTTP_OAUTH_CLIENTS must be a JSON array of registered MCP client objects.'
        );
      }
      oauthClients = parsedClients.map(normalizeOauthClientConfig);
    }

    const oauthSupportedScopes = isNonEmptyString(env.MCP_HTTP_OAUTH_SUPPORTED_SCOPES)
      ? env.MCP_HTTP_OAUTH_SUPPORTED_SCOPES.trim()
          .split(/[\s,]+/)
          .filter(Boolean)
      : ['mcp'];
    if (oauthSupportedScopes.length === 0) {
      throw configError(
        'MCP_HTTP_OAUTH_SUPPORTED_SCOPES must carry at least one non-empty MCP scope for external clients.'
      );
    }
    // T12 (S1-S8): the upstream authorization request keeps requiring
    // resource-qualified custom API scopes. When MCP_HTTP_UPSTREAM_SCOPES is
    // configured, its validated entries are used exactly as before. When it
    // is omitted, the upstream scopes derive from the same client id that
    // both the audience default and the exposed API scope owner are: each
    // required short scope becomes api://<client-id>/<scope> (by default
    // mcp.access). This is the only supported derivation — if the app's
    // Application ID URI differs from api://<client id>, the administrator
    // must set MCP_HTTP_UPSTREAM_SCOPES explicitly; no other URI shape is
    // ever guessed.
    const upstreamScopes = [...entraRequestScopes];
    const allowDynamicRegistration = env.MCP_HTTP_OAUTH_ALLOW_DYNAMIC_REGISTRATION === 'true';
    if (oauthClients.length === 0 && !allowDynamicRegistration) {
      throw configError(
        'Standards MCP OAuth requires either registered external MCP clients in MCP_HTTP_OAUTH_CLIENTS or an explicit MCP_HTTP_OAUTH_ALLOW_DYNAMIC_REGISTRATION=true.'
      );
    }
    oauth = {
      loginRedirectUri: loginRedirect.href,
      upstreamScopes,
      clients: oauthClients,
      supportedScopes: oauthSupportedScopes,
      allowDynamicRegistration,
      // T19 (S10,S11): the optional explicit durable store directory and
      // optional separate key file for the bridge credential store. The CLI
      // runtime defaults the directory to the platform state path when this
      // environment leaves both empty; both are bridge-only settings.
    };
    const rawStoreDirectory = isNonEmptyString(env.MCP_HTTP_BRIDGE_STORE_DIR)
      ? env.MCP_HTTP_BRIDGE_STORE_DIR.trim()
      : undefined;
    if (rawStoreDirectory !== undefined) {
      if (rawStoreDirectory.length === 0 || rawStoreDirectory.length > 512) {
        throw configError(
          'MCP_HTTP_BRIDGE_STORE_DIR must be a non-empty directory path of at most 512 characters.'
        );
      }
      oauth.storeDirectory = rawStoreDirectory;
    }
    const rawKeyFile = isNonEmptyString(env.MCP_HTTP_BRIDGE_KEY_FILE)
      ? env.MCP_HTTP_BRIDGE_KEY_FILE.trim()
      : undefined;
    if (rawKeyFile !== undefined) {
      if (rawKeyFile.length === 0 || rawKeyFile.length > 512) {
        throw configError(
          'MCP_HTTP_BRIDGE_KEY_FILE must be a non-empty file path of at most 512 characters.'
        );
      }
      oauth.keyFile = rawKeyFile;
    }
  }

  return {
    port,
    host,
    loopback: isLoopbackHost(unbracketedHost),
    /** T9 (S4-S6): explicit local development plaintext HTTP opt-in. */
    allowLocalHttp,
    /** Explicit reverse-proxy HTTP transport opt-in; requires the canonical HTTPS base URL. */
    reverseProxyHttp,
    tenantId,
    audience,
    requiredScopes,
    clientId: env.ENTRA_CLIENT_ID.trim(),
    clientSecret: env.ENTRA_CLIENT_SECRET,
    allowedOrigins,
    externalBaseUrl,
    /** T16 (S5,S10): resolved authentication mode: 'entra' (direct) or 'bridge'. */
    authMode,
    /** T16 (S5,S10): the fully resource-qualified Entra request scopes for direct mode. */
    entraRequestScopes: [...entraRequestScopes],
    oauth,
    tls,
  };
}

/**
 * Builds the per-request on-behalf-of token store factory. The verified
 * inbound token travels only through this factory into the OBO exchange
 * endpoint; it is never attached to Graph or Flow service requests.
 */
function createDefaultOboStoreFactory(config) {
  return (requestContext) =>
    createRequestOboTokenStore({
      token: requestContext.token,
      tenantId: config.tenantId,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    });
}

const RFC7230_TOKEN68_PATTERN = /^[A-Za-z0-9\-._~+/]+=*$/;

/**
 * Extracts exactly one bearer token from the Authorization header. Strict:
 * one scheme word, exactly one token, no trailing parts, and the token itself
 * must be a valid RFC 7230 token68 credential. Anything else is absent.
 */
function extractBearerToken(rawAuthorization) {
  if (!isNonEmptyString(rawAuthorization)) {
    return null;
  }
  const parts = rawAuthorization.split(/\s+/);
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    return null;
  }
  const token = parts[1];
  if (!RFC7230_TOKEN68_PATTERN.test(token)) {
    return null;
  }
  return token;
}

/**
 * Creates the remote MCP HTTP server. Returns a start/stop handle around one
 * Node.js HTTP(S) listener. No identity, token, or OBO state lives on the
 * listener itself; each request re-validates and re-routes from scratch.
 */
function createRemoteMcpHttpServer(config) {
  if (!config || typeof config !== 'object') {
    throw configError('A validated remote MCP HTTP configuration is required');
  }
  const {
    port,
    host,
    tenantId,
    audience,
    requiredScopes,
    clientId,
    clientSecret,
    tls = null,
    allowedOrigins = [],
    externalBaseUrl = null,
    jwksClient = null,
    entraVerifier = null,
    issuer = null,
    createOboTokenStore = null,
    oauth = null,
    entraLogin = null,
    // T9 (S4-S6): explicit local development plaintext HTTP opt-in.
    allowLocalHttp = false,
    // Explicit reverse-proxy HTTP transport opt-in: a strict boolean field,
    // and the canonical HTTPS external base URL is mandatory exactly as the
    // environment resolver enforces it. A string value never enables it.
    reverseProxyHttp = false,
    // T16 (S5,S10): explicit authentication mode plus the fully
    // resource-qualified Entra request scopes for direct-mode discovery.
    authMode = undefined,
    entraRequestScopes = undefined,
  } = config;

  if (
    !isNonEmptyString(tenantId) ||
    !isNonEmptyString(audience) ||
    !Array.isArray(requiredScopes) ||
    requiredScopes.length === 0
  ) {
    throw configError(
      'The remote MCP HTTP configuration is incomplete (tenant, audience, scopes).'
    );
  }
  if (requiredScopes.some((scope) => !isShortScopeName(scope))) {
    throw configError(
      'The required delegated scopes for this MCP deployment must be short scope names exactly as they appear in the access token scp claim; API-qualified scope URIs (api://<app-id>/<scope> or https://<host>/<scope>) belong in the upstream Entra sign-in scope configuration (oauth.upstreamScopes).'
    );
  }
  if (!isNonEmptyString(clientId) || !isNonEmptyString(clientSecret)) {
    throw configError('Entra confidential client credentials are required.');
  }
  if (
    !tls &&
    !isLoopbackHost(host) &&
    // T9 (S4-S6): only the explicitly opted-in local development mode may
    // run this plaintext wildcard container listener; its exposure depends
    // on Docker publishing the port to the host loopback, and it fails
    // closed unless discovery still has a usable canonical base URL.
    !(allowLocalHttp && isUnspecifiedBindHost(host)) &&
    // Same policy as the environment resolver: the opted-in reverse-proxy
    // transport is the only other plaintext exception, and it always
    // requires the canonical HTTPS external base URL below.
    !reverseProxyHttp
  ) {
    throw configError(
      'Insecure listener refused: non-loopback bindings require TLS configuration (the only plaintext exceptions are the explicitly opted-in local development mode for a container published strictly on the host loopback and the explicitly opted-in reverse-proxy transport with a canonical https:// externalBaseUrl).'
    );
  }
  if (reverseProxyHttp !== undefined && typeof reverseProxyHttp !== 'boolean') {
    throw configError(
      'reverseProxyHttp must be the exact boolean true to opt into the plaintext reverse-proxy HTTP upstream transport; a string never enables it.'
    );
  }
  if (reverseProxyHttp) {
    let proxyBaseUrl = null;
    try {
      proxyBaseUrl = new URL(externalBaseUrl);
    } catch {
      proxyBaseUrl = null;
    }
    if (
      !proxyBaseUrl ||
      proxyBaseUrl.protocol !== 'https:' ||
      `${proxyBaseUrl.pathname}${proxyBaseUrl.search}${proxyBaseUrl.hash}` !== '/'
    ) {
      throw configError(
        'reverseProxyHttp requires a canonical absolute https:// externalBaseUrl (origin only, no path, query, or fragment) of the address the external reverse proxy serves; the plaintext upstream must never advertise a plaintext, derived, or forwarded discovery URL.'
      );
    }
  }
  if (oauth !== null && oauth !== undefined) {
    if (typeof oauth !== 'object' || Array.isArray(oauth)) {
      throw configError('The oauth configuration must be an object when provided');
    }
    const unknownOauthKeys = Object.keys(oauth).filter(
      (key) => !OAUTH_ALLOWED_CONFIG_KEYS.includes(key)
    );
    if (unknownOauthKeys.length > 0) {
      throw configError(`unexpected oauth configuration options: ${unknownOauthKeys.join(', ')}`);
    }
    const loginRedirectUri = oauth.loginRedirectUri;
    let parsedLoginRedirect = null;
    try {
      parsedLoginRedirect = new URL(loginRedirectUri);
    } catch {
      throw configError(
        'oauth.loginRedirectUri must be the exact HTTPS Entra sign-in callback URL registered for this service'
      );
    }
    if (
      (parsedLoginRedirect.protocol !== 'https:' &&
        !(
          allowLocalHttp &&
          parsedLoginRedirect.protocol === 'http:' &&
          isLoopbackHost(parsedLoginRedirect.hostname.replace(/^\[|\]$/g, '').toLowerCase())
        )) ||
      parsedLoginRedirect.username ||
      parsedLoginRedirect.password ||
      parsedLoginRedirect.search ||
      parsedLoginRedirect.hash
    ) {
      throw configError(
        'oauth.loginRedirectUri must be an exact HTTPS URL without credentials, query, or fragment (an exact loopback http:// URL is accepted only in the explicitly opted-in local development mode)'
      );
    }
    const oauthClients = oauth.clients;
    if (
      oauthClients !== undefined &&
      (!Array.isArray(oauthClients) ||
        oauthClients.some(
          (clientEntry) =>
            !clientEntry ||
            typeof clientEntry !== 'object' ||
            Array.isArray(clientEntry) ||
            !isNonEmptyString(clientEntry.clientId) ||
            !Array.isArray(clientEntry.redirectUris) ||
            clientEntry.redirectUris.length === 0 ||
            clientEntry.redirectUris.some(
              (uri) => !isNonEmptyString(typeof uri === 'string' ? uri : '')
            )
        ))
    ) {
      throw configError(
        'oauth.clients must carry the pre-registered external MCP client entries (clientId and redirectUris)'
      );
    }
    // The upstream authorization request must use resource-qualified custom
    // API scopes; never silently derived from the audience or client id.
    if (
      !Array.isArray(oauth.upstreamScopes) ||
      oauth.upstreamScopes.length === 0 ||
      oauth.upstreamScopes.some(
        (scope) => !isResourceQualifiedScope(typeof scope === 'string' ? scope : '')
      )
    ) {
      throw configError(
        'oauth.upstreamScopes must list the resource-qualified delegated scope(s) (api://<app-id>/<scope> or https://<host>/<scope>) Microsoft Entra requires for custom API authorization requests; short scope names of the issued tokens stay in the required-scope configuration and no app ID URI is guessed.'
      );
    }
    if (
      oauth.supportedScopes !== undefined &&
      (!Array.isArray(oauth.supportedScopes) ||
        oauth.supportedScopes.length === 0 ||
        oauth.supportedScopes.some(
          (scope) => !isNonEmptyString(typeof scope === 'string' ? scope : '')
        ))
    ) {
      throw configError(
        'oauth.supportedScopes must be a non-empty array of non-empty scope strings'
      );
    }
    if (
      oauth.allowDynamicRegistration !== undefined &&
      typeof oauth.allowDynamicRegistration !== 'boolean'
    ) {
      throw configError('oauth.allowDynamicRegistration must be a boolean');
    }
    // T19 (S5,S10,S11): runtime bridge storage and renewal seams, validated
    // fail-closed here so a misconfigured deployment never silently runs an
    // in-memory bridge it believes is persistent.
    if (oauth.storeDirectory !== undefined) {
      if (
        !isNonEmptyString(typeof oauth.storeDirectory === 'string' ? oauth.storeDirectory : '') ||
        oauth.storeDirectory.length > 512
      ) {
        throw configError(
          'oauth.storeDirectory must be a non-empty directory path of at most 512 characters'
        );
      }
    }
    if (oauth.keyFile !== undefined) {
      if (
        !isNonEmptyString(typeof oauth.keyFile === 'string' ? oauth.keyFile : '') ||
        oauth.keyFile.length > 512
      ) {
        throw configError('oauth.keyFile must be a non-empty file path of at most 512 characters');
      }
      if (oauth.storeDirectory === undefined && oauth.persistentStore === undefined) {
        throw configError(
          'oauth.keyFile only applies to the runtime bridge store; set oauth.storeDirectory (or supply oauth.persistentStore) alongside it'
        );
      }
    }
    if (oauth.persistentStore !== undefined) {
      if (oauth.storeDirectory !== undefined || oauth.keyFile !== undefined) {
        throw configError(
          'oauth.persistentStore is the injected store seam; never combine it with oauth.storeDirectory or oauth.keyFile'
        );
      }
      if (
        !oauth.persistentStore ||
        Array.isArray(oauth.persistentStore) ||
        typeof oauth.persistentStore.load !== 'function' ||
        typeof oauth.persistentStore.commit !== 'function' ||
        typeof oauth.persistentStore.close !== 'function'
      ) {
        throw configError(
          'oauth.persistentStore must expose the bridge-store load, commit, and close methods'
        );
      }
    }
    if (oauth.refreshTokenTtlSeconds !== undefined) {
      if (!Number.isInteger(oauth.refreshTokenTtlSeconds) || oauth.refreshTokenTtlSeconds <= 0) {
        throw configError('oauth.refreshTokenTtlSeconds must be a positive integer');
      }
    }
    if (
      oauth.refreshUpstreamEntraToken !== undefined &&
      typeof oauth.refreshUpstreamEntraToken !== 'function'
    ) {
      throw configError(
        'oauth.refreshUpstreamEntraToken must be an async ({upstream, identity}) callback'
      );
    }
    if (
      (Array.isArray(oauthClients) ? oauthClients.length : 0) === 0 &&
      oauth.allowDynamicRegistration !== true
    ) {
      throw configError(
        'Standards MCP OAuth needs at least one pre-registered external MCP client (oauth.clients) or explicitly enabled dynamic client registration'
      );
    }
  }

  // T16 (S5,S10): resolved authentication mode. Without an explicit selector
  // the previous behavior applies: bridge when the standards OAuth
  // configuration is present, direct Entra otherwise.
  let resolvedAuthMode;
  if (authMode === undefined || authMode === null) {
    resolvedAuthMode = oauth ? 'bridge' : 'entra';
  } else if (authMode === 'bridge') {
    if (!oauth) {
      throw configError(
        'authMode "bridge" requires the complete bridge OAuth (oauth object) configuration.'
      );
    }
    resolvedAuthMode = 'bridge';
  } else if (authMode === 'entra') {
    if (oauth) {
      throw configError(
        'authMode "entra" must not carry the bridge OAuth (oauth object) configuration; remove oauth to run the direct Entra mode.'
      );
    }
    resolvedAuthMode = 'entra';
  } else {
    throw configError('authMode must be exactly "entra" or "bridge" when provided.');
  }
  /**
   * T16 (S5,S10): the fully resource-qualified Entra request scopes
   * advertised in direct-mode discovery (scopes_supported and the
   * WWW-Authenticate scope attribute). Defaults to the T12 derivation
   * api://<client id>/<required short scope>; an explicit override must stay
   * resource-qualified. Internal token verification keeps requiring the short
   * scp names, and the RFC 8707 resource of this MCP deployment is never
   * fabricated or stripped to mask an interoperability question.
   */
  const directEntraRequestScopes =
    entraRequestScopes === undefined
      ? requiredScopes.map((scope) => `api://${clientId}/${scope}`)
      : entraRequestScopes;
  if (
    !Array.isArray(directEntraRequestScopes) ||
    directEntraRequestScopes.length === 0 ||
    directEntraRequestScopes.some(
      (scope) => !isResourceQualifiedScope(typeof scope === 'string' ? scope : '')
    )
  ) {
    throw configError(
      'entraRequestScopes must list the fully resource-qualified Entra request scope(s) (api://<app-id>/<scope> or https://<host>/<scope>) advertised to direct MCP clients.'
    );
  }
  if (entraLogin !== null && entraLogin !== undefined) {
    if (typeof entraLogin !== 'object' || Array.isArray(entraLogin)) {
      throw configError('The entraLogin configuration must be an object when provided');
    }
    const unknownLoginKeys = Object.keys(entraLogin).filter(
      (key) =>
        ![
          'authorityHost',
          'issuer',
          'jwksClient',
          'transactionTtlMs',
          'maxTransactions',
          'clockTolerance',
        ].includes(key)
    );
    if (unknownLoginKeys.length > 0) {
      throw configError(
        `unexpected entraLogin configuration options: ${unknownLoginKeys.join(', ')}`
      );
    }
  }

  const verifier =
    entraVerifier ||
    createEntraTokenVerifier({
      tenantId,
      audience,
      requiredScopes,
      ...(issuer ? { issuer } : {}),
      ...(jwksClient ? { jwksClient } : {}),
    });

  const oboStoreFactory = createOboTokenStore || createDefaultOboStoreFactory(config);
  const allowedOriginSet = new Set(allowedOrigins);

  /**
   * The tenant Entra issuer advertised in discovery: the configured
   * authority host when the standards flow supplies one, otherwise the
   * standard Microsoft authority. Derived from trusted configuration only.
   */
  const entraDiscoveryIssuerUrl =
    entraLogin && typeof entraLogin === 'object' && isNonEmptyString(entraLogin.authorityHost)
      ? `${String(entraLogin.authorityHost).replace(/\/+$/, '')}/${tenantId}/v2.0`
      : `https://login.microsoftonline.com/${tenantId}/v2.0`;

  /**
   * T11 (S8): the single server-trusted Entra authorization origin in the
   * same source of truth `createEntraLogin` pins its authorize endpoint
   * to (configured authority host, else the standard Microsoft authority).
   * It is the ONLY non-self CSP form-action target the consent page and its
   * redirect ever carry, and only when the standards sign-in flow is
   * configured at all. Chromium re-checks the initiating document's
   * form-action across a form navigation's redirect, so a real browser
   * blocked the consent POST redirect to Microsoft while the policy carried
   * only 'self'; extending the allowlist to exactly this one configured
   * origin is the minimal fix that keeps unregistered origins (including
   * registered client redirects and any request-controlled destination)
   * blocked. Null when unresolvable, in which case 'self' stays the intact,
   * restrictive default (a truly unparseable authority fails startup in
   * createEntraLogin anyway).
   */
  const upstreamFormActionOrigin = (() => {
    const rawAuthorityHost =
      entraLogin && typeof entraLogin === 'object' && isNonEmptyString(entraLogin.authorityHost)
        ? String(entraLogin.authorityHost)
        : process.env.MS_AUTHORITY_HOST || 'https://login.microsoftonline.com';
    try {
      return new URL(String(rawAuthorityHost).replace(/\/+$/, '')).origin;
    } catch {
      return null;
    }
  })();
  /** Strictly consent-scoped form-action allowlist (self plus the trusted Entra authority). */
  const consentFormActionOrigins =
    oauth && upstreamFormActionOrigin ? Object.freeze([upstreamFormActionOrigin]) : null;

  /**
   * The eager upstream Entra sign-in coordinator: created before any
   * listener exists so a misconfiguration fails startup completely. Its
   * pinned endpoints (authorize/redirect/token/JWKS) come exclusively from
   * validated configuration; caller input can never influence tenant,
   * redirect, or scope.
   */
  const entraLoginInstance = oauth
    ? createEntraLogin({
        tenantId,
        clientId,
        clientSecret,
        redirectUri: oauth.loginRedirectUri,
        // The upstream Entra authorization request uses the resource-qualified
        // custom API scopes (separate from the short scp requirements the
        // issued tokens carry and verification requires).
        scopes: [...oauth.upstreamScopes],
        // T9 (S4-S6): allow the plaintext loopback callback only under the
        // explicit local development opt-in; Entra itself accepts plain HTTP
        // redirect URIs only for loopback addresses.
        ...(allowLocalHttp ? { allowLoopbackHttpRedirect: true } : {}),
        ...(entraLogin && typeof entraLogin === 'object'
          ? {
              ...(entraLogin.authorityHost !== undefined
                ? { authorityHost: entraLogin.authorityHost }
                : {}),
              ...(entraLogin.issuer !== undefined ? { issuer: entraLogin.issuer } : {}),
              ...(entraLogin.jwksClient !== undefined ? { jwksClient: entraLogin.jwksClient } : {}),
              ...(entraLogin.transactionTtlMs !== undefined
                ? { transactionTtlMs: entraLogin.transactionTtlMs }
                : {}),
              ...(entraLogin.maxTransactions !== undefined
                ? { maxTransactions: entraLogin.maxTransactions }
                : {}),
              ...(entraLogin.clockTolerance !== undefined
                ? { clockTolerance: entraLogin.clockTolerance }
                : {}),
            }
          : {}),
      })
    : null;

  /** Provider options forwarded verbatim from the validated oauth config. */
  const oauthProviderOptions = oauth
    ? Object.fromEntries(
        OAUTH_PROVIDER_OPTION_KEYS.filter((key) => oauth[key] !== undefined).map((key) => [
          key,
          oauth[key],
        ])
      )
    : null;

  /**
   * The OAuth stack (standards MCP authorization server plus browser
   * sign-in/consent state) is built once, after the listener is bound, so
   * the issuer and discovery URLs use the real bound port. A build failure
   * closes the listener again before start() resolves (see start()).
   */
  let oauthStack = null;
  /** The one store instance this bridge mode owns; direct mode stays null. */
  let activeBridgePersistentStore = null;

  /**
   * T19 (S5,S10,S11): the non-secret deployment binding of one bridge
   * credential store: the canonical service URL plus the tenant and client
   * identifiers. It contains no app secret, and a store moved to a different
   * deployment binding fails closed like a wrong key.
   */
  function bridgeDeploymentId(canonicalBaseUrl) {
    let origin;
    try {
      origin = new URL(canonicalBaseUrl).origin;
    } catch {
      throw configError(
        'The bridge store deployment binding needs a canonical, resolvable service base URL'
      );
    }
    return `${origin}|${tenantId}|${clientId}`;
  }

  function buildBridgeStore() {
    if (oauth.persistentStore) {
      activeBridgePersistentStore = oauth.persistentStore;
      return oauth.persistentStore;
    }
    if (!oauth.storeDirectory) {
      // Programmatic-fixture contract: no explicit store means the
      // in-memory provider state. The CLI runtime derives its durable
      // default before this point; it never runs in-memory by accident.
      return null;
    }
    activeBridgePersistentStore = createBridgeStore({
      directory: oauth.storeDirectory,
      ...(oauth.keyFile ? { keyFile: oauth.keyFile } : {}),
      deploymentId: bridgeDeploymentId(resolveExternalBaseUrl()),
    });
    return activeBridgePersistentStore;
  }

  /**
   * T19 (S5,S10,S11): the default upstream renewal the persistent bridge
   * relies on. The confidential client secret stays server-side; the
   * tenant-pinned refresh grant renews the upstream credential, and the
   * renewed access token is verified with the SAME existing Entra verifier
   * before it is bound to the family, with the immutable oid/tid identity
   * enforced. Only actual user-consent reauth conditions (surfaced by the
   * refresher as entra-refresh-reauth-required) permanently invalidate a
   * family; transient network, 5xx, and service-configuration failures
   * leave every grant untouched and answer 503.
   */
  function wireDefaultUpstreamRenewal() {
    const upstreamRefresher = createEntraTokenRefresher({
      tenantId,
      clientId,
      clientSecret,
      scopes: [...oauth.upstreamScopes],
      ...(entraLogin && typeof entraLogin === 'object' && entraLogin.authorityHost
        ? { authorityHost: entraLogin.authorityHost }
        : {}),
    });
    return async ({ upstream, identity }) => {
      if (!upstream || !isNonEmptyString(upstream.refreshToken)) {
        // The bridge has no upstream refresh credential (Microsoft never
        // granted offline_access): the user must repeat the Microsoft
        // sign-in; nothing may pretend a renewal happened.
        const error = new Error(
          'No upstream refresh credential exists for this family; repeat the Microsoft sign-in'
        );
        error.code = UPSTREAM_REAUTH_REQUIRED;
        throw error;
      }
      let renewed;
      try {
        renewed = await upstreamRefresher.refresh({ refreshToken: upstream.refreshToken });
      } catch (error) {
        if (error && error.code === REFRESH_REAUTH_REQUIRED) {
          const mapped = new Error(
            'The Microsoft sign-in must be repeated before this family can renew'
          );
          mapped.code = UPSTREAM_REAUTH_REQUIRED;
          throw mapped;
        }
        // Service and transient failures leave every stored grant untouched.
        throw error;
      }
      let verified = null;
      try {
        verified = await verifier.verifyAccessToken(renewed.accessToken);
      } catch (verificationError) {
        if (verificationError && verificationError.code === 'entra-token-untrusted') {
          // Signature-key/verification infrastructure trouble is transient:
          // retry shortly instead of forcing a fresh login.
          throw verificationError;
        }
        verified = null;
      }
      if (
        !verified ||
        verified.objectId !== identity.objectId ||
        verified.tenantId !== identity.tenantId
      ) {
        // The renewed credential does not carry this deployment's audience,
        // tenant, expiry, delegated scopes, or immutable delegated identity:
        // it is never bound; the family's grant is invalid going forward.
        const error = new Error(
          'The renewed upstream credential does not validate for this deployment and user'
        );
        error.code = UPSTREAM_REAUTH_REQUIRED;
        throw error;
      }
      return {
        accessToken: renewed.accessToken,
        expiresAt: renewed.expiresAt,
        ...(renewed.refreshToken !== undefined ? { refreshToken: renewed.refreshToken } : {}),
      };
    };
  }

  function buildOAuthStack() {
    if (!oauth) {
      // Direct Entra mode creates no store (S10): the MCP deployment holds
      // no user credentials and the client keeps its own refresh token.
      return;
    }
    const oauthBase = resolveExternalBaseUrl();
    const bridgeStore = buildBridgeStore();
    const bundle = createMCPOAuthProvider({
      issuerUrl: oauthBase,
      signInUrl: `${oauthBase}/login`,
      resourceServerUrl: oauthBase,
      ...oauthProviderOptions,
      ...(bridgeStore ? { persistentStore: bridgeStore } : {}),
      ...(typeof oauth.refreshUpstreamEntraToken === 'function'
        ? { refreshUpstreamEntraToken: oauth.refreshUpstreamEntraToken }
        : { refreshUpstreamEntraToken: wireDefaultUpstreamRenewal() }),
    });
    // RFC 8414 issuer must not carry a trailing slash: URL objects normalize
    // an origin-only URL to '/' in href, so the advertised issuer string is
    // the exact validated base URL from configuration and the bound port.
    const metadata = { ...bundle.metadata, issuer: oauthBase };
    const app = express();
    app.set('env', 'production');
    app.disable('x-powered-by');
    app.use(oauthRequestLogger);
    app.use(bundle.router);
    app.use(oauthErrorMiddleware);
    oauthStack = {
      bundle,
      metadata,
      app,
      base: oauthBase,
      /** Single-use CSRF values per pending authorization reference. */
      consentCsrf: new Map(),
      /** state (from beginLogin) to pending MCP authorization reference. */
      stateRefBindings: new Map(),
      dynamicRegistration: oauth.allowDynamicRegistration === true,
    };
    // Same-origin browser submissions of the consent form arrive with the
    // service's own canonical origin; the canonical base URL is trusted
    // configuration, so this admission is itself fail-closed.
    allowedOriginSet.add(new URL(oauthBase).origin);
    // Safe, non-secret startup information only: the store path and whether
    // the key is external. No keys, tokens, or credentials are ever logged.
    if (bridgeStore) {
      console.error(
        `[mcp-http] bridge credential store active at ${oauth.storeDirectory || '(injected persistent store)'}${
          oauth.keyFile ? '; key file: external' : ''
        }`
      );
    }
  }

  /**
   * Resolves the externally reachable base URL for discovery documents from
   * trusted configuration only: a configured canonical base URL wins, and the
   * fallback is the validated listener host and port. The untrusted request
   * Host header is never reflected into any URL (header/proxy pinning, host
   * spoofing, and DNS rebinding cannot rotate discovery or challenge targets).
   */
  function resolveExternalBaseUrl() {
    if (externalBaseUrl) {
      return externalBaseUrl;
    }
    const scheme = tls ? 'https' : 'http';
    const hostLabel = host.includes(':') ? `[${host.replace(/^\[|\]$/g, '')}]` : host;
    return `${scheme}://${hostLabel}:${boundPort || port}`;
  }

  function respondJson(res, statusCode, payload, extraHeaders = {}) {
    res.writeHead(statusCode, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...extraHeaders,
    });
    res.end(JSON.stringify(payload));
  }

  function respondUnauthorized(res, tokenWasPresent) {
    const challenge = [
      'Bearer',
      ...(tokenWasPresent ? ['error="invalid_token"'] : []),
      `resource_metadata="${resolveExternalBaseUrl()}${DISCOVERY_PATH}"`,
      // T16 (S5,S10): direct mode names the fully resource-qualified request
      // scopes so standards MCP clients derive exactly what Entra needs; the
      // legacy bridge challenge stays unchanged for existing clients.
      ...(resolvedAuthMode === 'entra' ? [`scope="${directEntraRequestScopes.join(' ')}"`] : []),
    ].join(' ');
    respondJson(
      res,
      401,
      {
        error: tokenWasPresent ? 'invalid_token' : 'unauthorized',
        message:
          'A valid delegated Microsoft Entra access token is required for this MCP endpoint.',
      },
      { 'www-authenticate': challenge }
    );
  }

  function randomOpaqueValue() {
    return crypto.randomBytes(32).toString('base64url');
  }

  function timingSafeStringEqual(left, right) {
    if (!isNonEmptyString(left) || !isNonEmptyString(right) || left.length !== right.length) {
      return false;
    }
    return crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right));
  }

  /**
   * Renders an HTML page with the strict headers; the optional strictly
   * validated form-action allowlist applies only to the consent page (T11,
   * T14) and stays the default ("self"-equivalent) for every error page. T14
   * (S8): the self target is the explicit canonical origin instead of the
   * CSP keyword, because some user-reported Chromium configurations blocked
   * a same-origin form POST while the policy carried the "self" keyword;
   * an explicit origin carries the exact same access set.
   */
  function consentPageHeaders(consentFormOrigins) {
    return securityHeaders({
      formActionOrigins: consentFormOrigins,
      selfOrigin: new URL(resolveExternalBaseUrl()).origin,
    });
  }

  /**
   * The consent form-action allowlist for one pending authorization: the
   * configured Entra authority plus the registered client's own redirect
   * origin. Chromium re-checks the initiating consent document's form-action
   * against every hop of the form navigation, including the final redirect
   * from /login/callback back to the registered MCP client callback, so the
   * client's registered origin must be named or the authorization code never
   * reaches the client.
   */
  function consentFormActionOriginsFor(descriptor) {
    const base = consentFormActionOrigins || [];
    let clientOrigin = null;
    try {
      clientOrigin = new URL(descriptor.redirectUri).origin;
    } catch {
      clientOrigin = null;
    }
    return clientOrigin ? [clientOrigin, ...base] : base;
  }

  function respondHtml(res, statusCode, html, consentFormOrigins = null) {
    res.writeHead(statusCode, {
      'content-type': 'text/html; charset=utf-8',
      ...(consentFormOrigins ? consentPageHeaders(consentFormOrigins) : SECURITY_HEADERS),
    });
    res.end(html);
  }

  /**
   * A redirect inside the consent navigation carries the same exact
   * form-action allowlist as its initiating consent page (the policy a
   * real browser re-checks across the redirect hop); every other redirect
   * keeps the `'self'`-only default.
   */
  function respondRedirect(res, location, consentFormOrigins = null) {
    res.writeHead(302, {
      location,
      ...(consentFormOrigins ? consentPageHeaders(consentFormOrigins) : SECURITY_HEADERS),
    });
    res.end();
  }

  function renderBoundedErrorPage(res, title, message, statusCode = 400) {
    respondHtml(res, statusCode, renderLoginErrorPage({ title, message }));
  }

  /**
   * Reads one bounded urlencoded form body (the consent POST). Oversized or
   * unreadable bodies resolve to undefined and are refused.
   */
  function readFormBody(req) {
    return new Promise((resolve) => {
      const chunks = [];
      let total = 0;
      let aborted = false;
      req.on('data', (chunk) => {
        if (aborted) {
          return;
        }
        total += chunk.length;
        if (total > MAX_FORM_BODY_BYTES) {
          aborted = true;
          resolve(undefined);
          req.resume();
          return;
        }
        chunks.push(chunk);
      });
      req.on('error', () => {
        if (!aborted) {
          aborted = true;
          resolve(undefined);
        }
      });
      req.on('end', () => {
        if (aborted) {
          return;
        }
        try {
          resolve(querystring.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          resolve(undefined);
        }
      });
    });
  }

  /**
   * Issues one fresh single-use CSRF value for a pending authorization.
   * Every fresh sign-in page render replaces its token, so a later retry
   * after a provider error can consent again with a new value.
   */
  function issueConsentCsrf(ref) {
    const now = Date.now();
    for (const [key, entry] of oauthStack.consentCsrf) {
      if (entry.expiresAt <= now) {
        oauthStack.consentCsrf.delete(key);
      }
    }
    if (
      oauthStack.consentCsrf.size >= MAX_CONSENT_CSRF_ENTRIES &&
      !oauthStack.consentCsrf.has(ref)
    ) {
      throw new Error('consent-capacity');
    }
    const entry = { value: randomOpaqueValue(), expiresAt: now + CONSENT_CSRF_TTL_MS };
    oauthStack.consentCsrf.set(ref, entry);
    return entry.value;
  }

  /** Serves the service-owned consent page for one pending authorization. */
  function handleLoginPage(req, res) {
    const ref = new URL(req.url, 'http://localhost').searchParams.get('mcp_authorization');
    const descriptor = oauthStack.bundle.getPendingAuthorizationDescriptor(ref);
    logDecision('login-page', req);
    if (!descriptor) {
      if (isNonEmptyString(typeof ref === 'string' ? ref : '')) {
        oauthStack.consentCsrf.delete(ref);
      }
      renderBoundedErrorPage(
        res,
        'Sign-in link expired',
        'This MCP sign-in link is unknown, already used, or has expired. Return to your MCP client so it can begin a new connection request.'
      );
      return;
    }
    let csrfValue;
    try {
      csrfValue = issueConsentCsrf(ref);
    } catch {
      renderBoundedErrorPage(
        res,
        'Too many sign-ins',
        'The service is handling too many concurrent sign-ins; try again shortly.',
        503
      );
      return;
    }
    respondHtml(
      res,
      200,
      renderConsentLoginPage({
        ref,
        csrfToken: csrfValue,
        clientId: descriptor.clientId,
        redirectUri: descriptor.redirectUri,
        scopes: descriptor.scopes,
      }),
      // T11 (S8): exactly this page's form navigation may follow its redirect
      // to the configured Entra authority and finally to the registered client
      // callback; every error page and every other response keeps form-action
      // 'self' (see consentFormActionOrigins).
      consentFormActionOriginsFor(descriptor)
    );
  }

  /** Validates explicit consent (CSRF) and starts one upstream Entra sign-in. */
  async function handleConsent(req, res) {
    const form = await readFormBody(req);
    if (form === undefined) {
      respondJson(res, 400, { error: 'invalid-request-body' });
      return;
    }
    const ref = typeof form.mcp_authorization === 'string' ? form.mcp_authorization : '';
    logDecision('consent', req);
    const descriptor = oauthStack.bundle.getPendingAuthorizationDescriptor(ref);
    if (!descriptor) {
      oauthStack.consentCsrf.delete(ref);
      renderBoundedErrorPage(
        res,
        'Sign-in link expired',
        'This MCP sign-in link is unknown, already used, or has expired. Return to your MCP client so it can begin a new connection request.'
      );
      return;
    }
    const csrfEntry = oauthStack.consentCsrf.get(ref);
    const presentedCsrf = typeof form.csrf_token === 'string' ? form.csrf_token : '';
    if (!csrfEntry || !timingSafeStringEqual(presentedCsrf, csrfEntry.value)) {
      respondJson(res, 403, {
        error: 'csrf-failed',
        message:
          'This consent submission carries no valid one-time CSRF token. Open the sign-in page again from your MCP client and submit the form once.',
      });
      return;
    }
    // The exact validated submission consumes its CSRF token: replays and
    // double submissions always fail closed.
    oauthStack.consentCsrf.delete(ref);

    let begin;
    try {
      begin = entraLoginInstance.beginLogin();
    } catch (error) {
      logDecision(
        error instanceof EntraLoginError ? 'consent-capacity' : 'consent-begin-failed',
        req
      );
      renderBoundedErrorPage(
        res,
        'Too many sign-ins',
        'The service is handling too many concurrent Microsoft sign-ins; try again shortly.',
        503
      );
      return;
    }
    // Binds the fresh one-time Entra state to the pending MCP authorization.
    const now = Date.now();
    for (const [boundState, bound] of oauthStack.stateRefBindings) {
      if (bound.expiresAt <= now) {
        oauthStack.stateRefBindings.delete(boundState);
      }
    }
    if (
      oauthStack.stateRefBindings.size >= MAX_STATE_REF_BINDINGS &&
      !oauthStack.stateRefBindings.has(begin.state)
    ) {
      renderBoundedErrorPage(
        res,
        'Too many sign-ins',
        'The service is handling too many concurrent Microsoft sign-ins; try again shortly.',
        503
      );
      return;
    }
    oauthStack.stateRefBindings.set(begin.state, { ref, expiresAt: begin.expiresAt });
    // Same exact allowlist as the initiating consent page: the policy a real
    // browser re-checks on this redirect hop (T11, S8).
    respondRedirect(res, begin.authorizationUrl, consentFormActionOriginsFor(descriptor));
  }

  /**
   * Completes the upstream Entra sign-in and, when valid, hands the browser
   * back to the exact registered client redirect with only the MCP
   * authorization code and the client's own state. Failures answer with one
   * bounded, generic error page; no provider token, secret, or identity
   * detail ever reaches the browser or logs.
   */
  async function handleCallback(req, res) {
    const query = new URL(req.url, 'http://localhost').searchParams;
    const state = query.get('state');
    const code = query.get('code') === null ? undefined : query.get('code');
    const providerError = query.get('error') === null ? undefined : query.get('error');
    logDecision('login-callback', req);
    const binding = isNonEmptyString(typeof state === 'string' ? state : '')
      ? oauthStack.stateRefBindings.get(state)
      : undefined;
    if (binding) {
      // One binding can never complete twice, whatever the outcome.
      oauthStack.stateRefBindings.delete(state);
    }
    if (!binding) {
      logDecision('login-callback-state-unknown', req);
      renderBoundedErrorPage(
        res,
        'Sign-in could not be linked',
        'This Microsoft sign-in result could not be matched to a pending MCP connection request. Return to your MCP client and start again.'
      );
      return;
    }
    try {
      const loginResult = await entraLoginInstance.completeLoginWithUpstream({
        state,
        ...(code !== undefined ? { code } : {}),
        ...(providerError !== undefined ? { error: providerError } : {}),
      });
      // Fail closed before any binding (T8 correction): the upstream access
      // token itself must verify for this MCP deployment — signature via the
      // tenant JWKS, issuer, configured API audience, tenant, expiry, and the
      // delegated scp scopes — and it must belong to the same user as the
      // verified ID token. An unverified token is never bound to an MCP
      // authorization and never reaches the on-behalf-of exchange.
      let upstreamVerified = null;
      try {
        upstreamVerified = await verifier.verifyAccessToken(loginResult.upstream.accessToken);
      } catch {
        upstreamVerified = null;
      }
      if (!upstreamVerified || upstreamVerified.objectId !== loginResult.identity.objectId) {
        logDecision('login-callback-unverified-upstream-token', req);
        renderBoundedErrorPage(
          res,
          'Microsoft sign-in could not be completed',
          'The Microsoft token response did not validate for this MCP deployment, so no MCP authorization was granted; the connection request stays open for one retry from the sign-in page, or start again from your MCP client.'
        );
        return;
      }
      const completion = oauthStack.bundle.completeAuthorizationAfterEntraSignIn({
        authorizationRef: binding.ref,
        entra: {
          accessToken: loginResult.upstream.accessToken,
          expiresAt: loginResult.upstream.expiresAt,
          objectId: loginResult.identity.objectId,
          tenantId: loginResult.identity.tenantId,
          ...(loginResult.identity.username ? { username: loginResult.identity.username } : {}),
          groups: Array.isArray(loginResult.identity.groups) ? loginResult.identity.groups : [],
          roles: Array.isArray(loginResult.identity.roles) ? loginResult.identity.roles : [],
        },
        // T19: the server-held upstream refresh credential from the initial
        // sign-in (offline_access). This wiring-only pass-through keeps it
        // inside the server process; it never travels to a browser or client.
        ...(loginResult.upstream.refreshToken !== undefined
          ? { upstream: { refreshToken: loginResult.upstream.refreshToken } }
          : {}),
      });
      logDecision('login-callback-completed', req);
      respondRedirect(res, completion.redirectTo);
    } catch (error) {
      logDecision('login-callback-failed', req);
      // Coarse, secret-free classification only.
      const safeOutcomeCode =
        error && typeof error.code === 'string' ? error.code : 'internal-error';
      console.error(
        `[mcp-http] login callback outcome: ${safeOutcomeCode} ${error && error.name} :: ${error && error.message}`
      );
      renderBoundedErrorPage(
        res,
        'Microsoft sign-in could not be completed',
        'The Microsoft sign-in did not complete or was rejected. No MCP authorization was granted; the connection request stays open for one retry from the sign-in page, or start again from your MCP client.'
      );
    }
  }

  function logDecision(decision, req) {
    // Log the path only, never a query string: a credentialed-looking query
    // must not end up in logs.
    const pathOnly = String(req.url || '-').split('?')[0];
    console.error(`[mcp-http] ${req.method || '-'} ${pathOnly}: ${decision}`);
  }

  function protectedResourceMetadata(res) {
    // T16 (S5,S10): direct Entra mode exposes only the tenant Entra issuer and
    // the fully resource-qualified request scopes. The resource field stays
    // this MCP deployment's canonical base URL (never an api:// URI: standards
    // clients bind their RFC 8707 resource indicator to it and check its
    // origin, and a fake api:// resource would break that binding, not help
    // Entra).
    if (resolvedAuthMode === 'entra') {
      respondJson(res, 200, {
        resource: resolveExternalBaseUrl(),
        authorization_servers: [entraDiscoveryIssuerUrl],
        scopes_supported: [...directEntraRequestScopes],
        bearer_methods_supported: ['header'],
      });
      return;
    }
    // With the standards MCP OAuth flow (bridge mode) enabled, this service is
    // itself the first advertised authorization server (S1/S5); the configured
    // tenant Entra issuer stays advertised second for deployments that also
    // hand out raw delegated tokens. Metadata stays unchanged for existing
    // clients.
    const scopesSupported = [
      ...new Set([...requiredScopes, ...(oauthStack && oauth ? oauth.supportedScopes || [] : [])]),
    ];
    respondJson(res, 200, {
      resource: resolveExternalBaseUrl(),
      authorization_servers: oauthStack
        ? [oauthStack.base, entraDiscoveryIssuerUrl]
        : [entraDiscoveryIssuerUrl],
      scopes_supported: scopesSupported,
      bearer_methods_supported: ['header'],
    });
  }

  /** Reads and parses one JSON request body, or rejects as undefined. */
  function readJsonBody(req) {
    return new Promise((resolve) => {
      const chunks = [];
      let total = 0;
      let aborted = false;
      req.on('data', (chunk) => {
        if (aborted) {
          return;
        }
        total += chunk.length;
        if (total > MAX_REQUEST_BODY_BYTES) {
          aborted = true;
          resolve({ tooLarge: true });
          req.resume();
          return;
        }
        chunks.push(chunk);
      });
      req.on('error', () => {
        if (!aborted) {
          aborted = true;
          resolve(undefined);
        }
      });
      req.on('end', () => {
        if (aborted) {
          return;
        }
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(parsed === null ? undefined : parsed);
        } catch {
          resolve(undefined);
        }
      });
    });
  }

  /**
   * Dispatches one authenticated request through a fresh stateless transport
   * and MCP protocol server. Runs inside the per-request OBO token store
   * scope so handlers resolve Graph/Flow credentials for exactly this user.
   */
  async function dispatchToTransport(req, res, parsedBody) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const mcpServer = createMCPServer({ toolFilter: remoteToolFilter });

    let closed = false;
    const cleanup = () => {
      if (closed) {
        return;
      }
      closed = true;
      transport.close().catch(() => {});
      if (typeof mcpServer.close === 'function') {
        try {
          mcpServer.close();
        } catch {
          // Protocol server teardown must never crash the request path.
        }
      }
    };
    res.on('close', cleanup);

    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } finally {
      if (res.writableEnded) {
        cleanup();
      }
    }
  }

  async function handleRequest(req, res) {
    try {
      const pathname = new URL(req.url || '/', 'http://localhost').pathname;

      const oauthRouted =
        oauthStack !== null &&
        (pathname === AUTHORIZE_PATH ||
          pathname === TOKEN_PATH ||
          (oauthStack.dynamicRegistration && pathname === REGISTER_PATH));
      if (oauthRouted) {
        // The standard MCP authorization/token endpoints own their own CORS
        // and error semantics (the SDK token endpoint, for instance, is
        // deliberately reachable from web clients and answers with standard
        // OAuth error shapes).
        oauthStack.app(req, res);
        return;
      }

      if (oauthStack !== null && pathname === AUTHORIZATION_SERVER_METADATA_PATH) {
        if (req.method !== 'GET') {
          respondJson(res, 405, { error: 'method-not-allowed' }, { allow: 'GET' });
          return;
        }
        respondJson(res, 200, oauthStack.metadata);
        return;
      }

      // Contain browser Origin first: an unexpected origin is refused before
      // any body or credential processing.
      const origin = req.headers.origin;
      if (isNonEmptyString(origin) && !allowedOriginSet.has(origin)) {
        logDecision('origin-denied', req);
        respondJson(res, 403, { error: 'origin-denied' });
        return;
      }

      if (pathname === DISCOVERY_PATH || pathname === `${DISCOVERY_PATH}/`) {
        if (req.method !== 'GET') {
          respondJson(res, 405, { error: 'method-not-allowed' }, { allow: 'GET' });
          return;
        }
        protectedResourceMetadata(res);
        return;
      }

      if (oauthStack !== null && pathname === LOGIN_PAGE_PATH) {
        if (req.method !== 'GET') {
          respondJson(res, 405, { error: 'method-not-allowed' }, { allow: 'GET' });
          return;
        }
        handleLoginPage(req, res);
        return;
      }
      if (oauthStack !== null && pathname === CONSENT_PATH) {
        if (req.method !== 'POST') {
          respondJson(res, 405, { error: 'method-not-allowed' }, { allow: 'POST' });
          return;
        }
        await handleConsent(req, res);
        return;
      }
      if (oauthStack !== null && pathname === CALLBACK_PATH) {
        if (req.method !== 'GET') {
          respondJson(res, 405, { error: 'method-not-allowed' }, { allow: 'GET' });
          return;
        }
        await handleCallback(req, res);
        return;
      }

      if (pathname !== MCP_PATH) {
        logDecision('path-not-found', req);
        respondJson(res, 404, { error: 'not-found' });
        return;
      }

      // Stateless mode serves no SSE stream and no server session: only POST
      // is a meaningful request here.
      if (req.method !== 'POST') {
        respondJson(res, 405, { error: 'method-not-allowed' }, { allow: 'POST' });
        return;
      }

      const token = extractBearerToken(req.headers.authorization);
      if (!token) {
        logDecision('unauthorized-missing-bearer', req);
        respondUnauthorized(res, false);
        return;
      }

      // Dual bearer authentication (task T6): a token issued by this
      // service's MCP OAuth flow first (MCP-scoped, bound to one consented
      // client), then the raw delegated Entra access token. Unrecognized
      // tokens always fall through and fail.
      let identity = null;
      let oboToken = token;
      if (oauthStack !== null) {
        let oauthIdentity = null;
        try {
          oauthIdentity = oauthStack.bundle.provider.verifyAccessToken(token);
        } catch {
          oauthIdentity = null;
        }
        if (oauthIdentity) {
          // /mcp runs only while the server-side upstream Entra association
          // is (or can be made) valid: the MCP token itself is never sent
          // downstream. T19: a stale or near-expiry upstream credential is
          // renewed through the bridge's upstream refresh seam; a transient
          // renewal failure answers 503 (retryable, no forced sign-in, no
          // unauthorized fallback token), anything unusable answers 401.
          let upstream = null;
          try {
            upstream = await oauthStack.bundle.ensureUpstreamEntraToken(token);
          } catch (error) {
            if (error && error.code === 'mcp-oauth-upstream-refresh-transient') {
              logDecision('upstream-renewal-unavailable', req);
              respondJson(res, 503, {
                error: 'temporarily_unavailable',
                message:
                  'The upstream Microsoft credential renewal is temporarily unavailable; retry shortly.',
              });
              return;
            }
            throw error;
          }
          if (!upstream) {
            logDecision('unauthorized-upstream-expired', req);
            respondUnauthorized(res, true);
            return;
          }
          identity = {
            objectId: upstream.objectId,
            tenantId: upstream.tenantId,
            ...(upstream.username ? { username: upstream.username } : {}),
            groups: Array.isArray(upstream.groups) ? upstream.groups : [],
            roles: Array.isArray(upstream.roles) ? upstream.roles : [],
          };
          oboToken = upstream.accessToken;
        }
      }
      if (!identity) {
        try {
          identity = await verifier.verifyAccessToken(token);
        } catch {
          logDecision('unauthorized-invalid-token', req);
          respondUnauthorized(res, true);
          return;
        }
      }

      // The stateless transport has no server-side session to delete and no
      // standalone SSE stream; non-POST requests were already refused.

      let parsedBody = null;
      if (req.method === 'POST') {
        const read = await readJsonBody(req);
        if (read === undefined) {
          respondJson(res, 400, { error: 'invalid-request-body' });
          return;
        }
        if (read.tooLarge) {
          respondJson(res, 413, { error: 'request-body-too-large' });
          return;
        }
        parsedBody = read;
      }

      const oboStore = oboStoreFactory({
        token: oboToken,
        tenantId,
        clientId,
        clientSecret,
      });
      await runWithTokenStorage(oboStore, () => dispatchToTransport(req, res, parsedBody));
      logDecision('dispatched', req);
    } catch (error) {
      // Never log the inbound token, secret, or identity details; log only a
      // coarse code and the safe message of our own error shapes.
      const safeCode = error && typeof error.code === 'string' ? error.code : 'internal-error';
      console.error(`[mcp-http] request failed: ${safeCode}`);
      if (!res.headersSent) {
        respondJson(res, 500, { error: 'internal-error' });
      } else {
        res.destroy();
      }
    }
  }

  // Bound to the actual port once listening so URL derivation stays exact
  // for ephemeral (port 0) listeners.
  let boundPort = 0;
  const server = tls
    ? https.createServer({ cert: tls.cert, key: tls.key }, handleRequest)
    : http.createServer(handleRequest);

  async function start() {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    boundPort = server.address().port;
    try {
      // The OAuth issuer/discovery URLs need the real bound port (ephemeral
      // port), so the stack is built after binding; any build failure closes
      // the listener again before start() resolves, leaving nothing open.
      buildOAuthStack();
    } catch (error) {
      await stop();
      throw error;
    }
    return { port: boundPort, host, tls: Boolean(tls) };
  }

  async function stop() {
    // Idempotent: close the bridge credential store (the provider's own
    // close() calls the same store, and bridge-store close is idempotent).
    if (activeBridgePersistentStore && typeof activeBridgePersistentStore.close === 'function') {
      try {
        activeBridgePersistentStore.close();
      } catch {
        // Shutdown must never crash on an already-failed store.
      }
    }
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    await new Promise((resolve) => {
      server.close(() => resolve());
    });
  }

  return { start, stop, isTls: () => Boolean(tls) };
}

/**
 * CLI entry point for the `http` mode: resolves configuration from the
 * (optionally injectable) environment, starts listening, and resolves once the
 * listener is accepting connections (the open server keeps the process
 * alive). Rejects (for the dispatcher to surface safely) on any
 * misconfiguration, before a listener exists.
 *
 * T19 (S10,S11): in bridge mode the durable bridge credential store is a
 * runtime requirement — an explicit MCP_HTTP_BRIDGE_STORE_DIR wins, and
 * without one the platform state directory (~/.outlook-mcp/remote-oauth) is
 * used. Direct Entra mode creates no store.
 */
async function startRemoteMCPHttpServer(env = process.env) {
  const config = resolveRemoteMcpConfig(env);
  if (config.authMode === 'bridge' && config.oauth) {
    if (!config.oauth.storeDirectory && !config.oauth.persistentStore) {
      config.oauth = {
        ...config.oauth,
        storeDirectory: path.join(os.homedir(), '.outlook-mcp', 'remote-oauth'),
      };
    }
  }
  const instance = createRemoteMcpHttpServer(config);
  const { port, host, tls } = await instance.start();
  console.error(
    `[mcp-http] listening on ${tls ? 'https' : 'http'}://${host}:${port}; waiting for MCP HTTP clients`
  );
  return { port, host, tls, instance };
}

module.exports = {
  LOCAL_EXCLUDED_TOOL_NAMES,
  remoteToolFilter,
  resolveRemoteMcpConfig,
  createRemoteMcpHttpServer,
  startRemoteMCPHttpServer,
};
