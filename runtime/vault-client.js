/**
 * Minimal HashiCorp Vault HTTP client used by the runtime bootstrap.
 *
 * This module intentionally uses only Node built-ins. Vault tokens remain in
 * memory for the duration of a read and are never logged or persisted.
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const childProcess = require('child_process');

const DEFAULTS = Object.freeze({
  authMount: 'oidc',
  role: 'outlook-mcp-developer',
  oidcPort: 8250,
  kvMount: 'kv',
  secretPath: 'outlook-mcp/actsis',
  requestTimeoutMs: 10000,
  callbackTimeoutMs: 5 * 60 * 1000,
});

const VAULT_ENV_KEYS = Object.freeze([
  'MS_CLIENT_ID',
  'MS_CLIENT_SECRET',
  'MS_TENANT_ID',
  'OUTLOOK_CLIENT_ID',
  'OUTLOOK_CLIENT_SECRET',
  'MS_AUTHORITY_HOST',
  'MS_SCOPES',
  'MS_REDIRECT_URI',
  'MS_TOKEN_ENDPOINT',
]);

const MAX_RESPONSE_BYTES = 1024 * 1024;
const HTTP_HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const RESERVED_CUSTOM_HEADER_NAMES = new Set([
  'host',
  'content-length',
  'connection',
  'authorization',
  'x-vault-token',
  'x-vault-namespace',
]);

class VaultError extends Error {
  /**
   * @param {string} message - Safe, user-actionable message
   * @param {string} code - Stable error code
   * @param {number|undefined} status - HTTP status when available
   */
  constructor(message, code = 'VAULT_ERROR', status) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

function isNonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseBoolean(value) {
  return typeof value === 'string' && value.trim().toLowerCase() === 'true';
}

function normalizeAddress(value) {
  let parsed;

  try {
    parsed = new URL(value);
  } catch {
    throw new VaultError('VAULT_ADDR must be a valid HTTP or HTTPS URL.', 'VAULT_CONFIG_INVALID');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new VaultError('VAULT_ADDR must use HTTP or HTTPS.', 'VAULT_CONFIG_INVALID');
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash || !parsed.hostname) {
    throw new VaultError(
      'VAULT_ADDR must contain only the Vault server URL, without credentials or query parameters.',
      'VAULT_CONFIG_INVALID'
    );
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString().replace(/\/$/, '');
}

function normalizeVaultPath(value, name, fallback) {
  const candidate = value === undefined || value === '' ? fallback : String(value).trim();
  const normalized = candidate.replace(/^\/+|\/+$/g, '');
  const segments = normalized.split('/');

  if (
    !normalized ||
    segments.some(
      (segment) => !segment || segment === '.' || segment === '..' || segment.includes('\0')
    )
  ) {
    throw new VaultError(`${name} must be a non-empty Vault path.`, 'VAULT_CONFIG_INVALID');
  }

  return normalized;
}

function parsePort(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new VaultError(
      'VAULT_OIDC_PORT must be a TCP port from 1 to 65535.',
      'VAULT_CONFIG_INVALID'
    );
  }
  return parsed;
}

function normalizeCustomHeader(env) {
  const rawName = env.VAULT_CUSTOM_HEADER_NAME;
  const rawValue = env.VAULT_CUSTOM_HEADER_VALUE;
  const hasName = isNonEmpty(rawName);
  const hasValue = isNonEmpty(rawValue);

  if (hasName !== hasValue) {
    throw new VaultError(
      'VAULT_CUSTOM_HEADER_NAME and VAULT_CUSTOM_HEADER_VALUE must be set together.',
      'VAULT_CONFIG_INVALID'
    );
  }

  if (!hasName) return { name: null, value: null };

  const name = rawName.trim();
  if (!HTTP_HEADER_TOKEN.test(name)) {
    throw new VaultError(
      'VAULT_CUSTOM_HEADER_NAME must be a valid HTTP header token.',
      'VAULT_CONFIG_INVALID'
    );
  }

  if (RESERVED_CUSTOM_HEADER_NAMES.has(name.toLowerCase())) {
    throw new VaultError(
      'VAULT_CUSTOM_HEADER_NAME is reserved and cannot be used for Vault requests.',
      'VAULT_CONFIG_INVALID'
    );
  }

  if (/\r|\n/.test(rawValue)) {
    throw new VaultError(
      'VAULT_CUSTOM_HEADER_VALUE must not contain CR or LF characters.',
      'VAULT_CONFIG_INVALID'
    );
  }

  return { name, value: rawValue };
}

/**
 * Resolve Vault settings from environment variables.
 * @param {object} [env=process.env] - Environment source
 * @returns {object} Normalized Vault configuration
 */
function getVaultConfig(env = process.env) {
  const customHeader = normalizeCustomHeader(env);
  const address = isNonEmpty(env.VAULT_ADDR) ? normalizeAddress(env.VAULT_ADDR.trim()) : null;
  const baseConfig = {
    enabled: Boolean(address),
    address,
    authMount: DEFAULTS.authMount,
    role: DEFAULTS.role,
    oidcPort: DEFAULTS.oidcPort,
    kvMount: DEFAULTS.kvMount,
    secretPath: DEFAULTS.secretPath,
    namespace: isNonEmpty(env.VAULT_NAMESPACE) ? env.VAULT_NAMESPACE.trim() : null,
    token: address && isNonEmpty(env.VAULT_TOKEN) ? env.VAULT_TOKEN : null,
    customHeaderName: customHeader.name,
    customHeaderValue: customHeader.value,
    skipBrowser: parseBoolean(env.VAULT_SKIP_BROWSER),
    requestTimeoutMs: DEFAULTS.requestTimeoutMs,
    callbackTimeoutMs: DEFAULTS.callbackTimeoutMs,
  };

  if (!address) return baseConfig;

  return {
    ...baseConfig,
    authMount: normalizeVaultPath(env.VAULT_AUTH_MOUNT, 'VAULT_AUTH_MOUNT', DEFAULTS.authMount),
    role: normalizeVaultPath(env.VAULT_ROLE, 'VAULT_ROLE', DEFAULTS.role),
    oidcPort: parsePort(env.VAULT_OIDC_PORT || DEFAULTS.oidcPort),
    kvMount: normalizeVaultPath(env.VAULT_KV_MOUNT, 'VAULT_KV_MOUNT', DEFAULTS.kvMount),
    secretPath: normalizeVaultPath(env.VAULT_SECRET_PATH, 'VAULT_SECRET_PATH', DEFAULTS.secretPath),
  };
}

function encodeVaultPathSegments(segments) {
  return segments
    .flatMap((segment) => String(segment).split('/'))
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function buildVaultUrl(config, segments) {
  const parsed = new URL(config.address);
  const basePath = parsed.pathname.replace(/\/+$/, '');
  parsed.pathname = `${basePath}/v1/${encodeVaultPathSegments(segments)}`;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function buildHeaders(config, extra = {}) {
  const headers = {};
  const setHeader = (name, value) => {
    const lowerName = name.toLowerCase();
    for (const existingName of Object.keys(headers)) {
      if (existingName.toLowerCase() === lowerName) delete headers[existingName];
    }
    Object.defineProperty(headers, name, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  };

  setHeader('Accept', 'application/json');
  if (
    isNonEmpty(config.customHeaderName) &&
    isNonEmpty(config.customHeaderValue) &&
    !RESERVED_CUSTOM_HEADER_NAMES.has(config.customHeaderName.toLowerCase())
  ) {
    setHeader(config.customHeaderName, config.customHeaderValue);
  }
  for (const [name, value] of Object.entries(extra)) setHeader(name, value);
  if (config.namespace) setHeader('X-Vault-Namespace', config.namespace);
  return headers;
}

function getSafeErrorMessage(error, config) {
  const message =
    error && typeof error.message === 'string' ? error.message : 'Unknown Vault error.';
  const secret = config && config.customHeaderValue;
  return isNonEmpty(secret) ? message.split(secret).join('[REDACTED]') : message;
}

function networkError() {
  return new VaultError(
    'Unable to reach Vault. Check VAULT_ADDR and intranet/VPN connectivity.',
    'VAULT_NETWORK_ERROR'
  );
}

function requestTimeoutError() {
  return new VaultError(
    'Vault request timed out. Check VAULT_ADDR and intranet/VPN connectivity.',
    'VAULT_TIMEOUT'
  );
}

/**
 * Execute a JSON request against Vault without exposing response bodies in
 * errors. The default TLS behavior is preserved; certificate verification is
 * never disabled.
 * @param {object} options - Request options
 * @param {string} options.url - Absolute Vault URL
 * @param {string} options.method - HTTP method
 * @param {object} [options.headers] - HTTP headers
 * @param {string} [options.body] - JSON request body
 * @param {object} [deps] - Injectable transports and timeout settings
 * @returns {Promise<object>} Parsed JSON response
 */
function requestJson(options, deps = {}) {
  let target;

  try {
    target = new URL(options.url);
  } catch {
    return Promise.reject(new VaultError('Vault request URL is invalid.', 'VAULT_CONFIG_INVALID'));
  }

  if (!['http:', 'https:'].includes(target.protocol)) {
    return Promise.reject(
      new VaultError('Vault request URL must use HTTP or HTTPS.', 'VAULT_CONFIG_INVALID')
    );
  }

  const transport = target.protocol === 'https:' ? deps.https || https : deps.http || http;
  const body = options.body || '';
  const timeoutMs = deps.requestTimeoutMs || options.timeoutMs || DEFAULTS.requestTimeoutMs;

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout = null;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (error) reject(error);
      else resolve(value);
    };

    let request;
    try {
      request = transport.request(
        target,
        {
          method: options.method,
          headers: options.headers || {},
        },
        (response) => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            if (typeof response.resume === 'function') response.resume();
            finish(
              new VaultError(
                `Vault request failed with HTTP status ${response.statusCode}.`,
                response.statusCode === 401 || response.statusCode === 403
                  ? 'VAULT_UNAUTHORIZED'
                  : 'VAULT_HTTP_ERROR',
                response.statusCode
              )
            );
            return;
          }

          let responseBody = '';
          if (typeof response.setEncoding === 'function') response.setEncoding('utf8');

          response.on('data', (chunk) => {
            responseBody += chunk;
            if (Buffer.byteLength(responseBody, 'utf8') > MAX_RESPONSE_BYTES) {
              if (typeof request.destroy === 'function') request.destroy();
              finish(new VaultError('Vault response was too large.', 'VAULT_RESPONSE_INVALID'));
            }
          });

          response.on('end', () => {
            if (!responseBody) {
              finish(new VaultError('Vault returned an empty response.', 'VAULT_RESPONSE_INVALID'));
              return;
            }

            try {
              finish(null, JSON.parse(responseBody));
            } catch {
              finish(new VaultError('Vault returned invalid JSON.', 'VAULT_RESPONSE_INVALID'));
            }
          });

          if (typeof response.on === 'function') {
            response.on('error', () => finish(networkError()));
          }
        }
      );
    } catch {
      finish(networkError());
      return;
    }

    if (settled) return;

    timeout = setTimeout(() => {
      if (typeof request.destroy === 'function') request.destroy();
      finish(requestTimeoutError());
    }, timeoutMs);
    if (typeof timeout.unref === 'function') timeout.unref();

    if (typeof request.on === 'function') request.on('error', () => finish(networkError()));

    try {
      if (body) request.write(body);
      request.end();
    } catch {
      finish(networkError());
    }
  });
}

function requestVaultJson(options, deps = {}) {
  const request = deps.requestJson || requestJson;
  return request(options, deps);
}

function buildRedirectUri(config) {
  return `http://localhost:${config.oidcPort}/oidc/callback`;
}

function createNonce(deps = {}) {
  const cryptoModule = deps.crypto || crypto;
  return (deps.randomBytes || cryptoModule.randomBytes)(32).toString('hex');
}

/**
 * Ask Vault for the provider authorization URL.
 * @param {object} config - Normalized Vault configuration
 * @param {string} clientNonce - Client nonce tied to the callback exchange
 * @param {object} [deps] - Injectable request implementation
 * @returns {Promise<{authUrl: string, state: string, nonce: string, clientNonce: string}>}
 */
async function requestAuthUrl(config, clientNonce, deps = {}) {
  if (!isNonEmpty(clientNonce)) {
    throw new VaultError('Vault OIDC client nonce is missing.', 'VAULT_OIDC_INVALID');
  }

  let response;
  try {
    response = await requestVaultJson(
      {
        method: 'POST',
        url: buildVaultUrl(config, ['auth', config.authMount, 'oidc', 'auth_url']),
        headers: buildHeaders(config, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(
            JSON.stringify({
              role: config.role,
              redirect_uri: buildRedirectUri(config),
              client_nonce: clientNonce,
            })
          ),
        }),
        body: JSON.stringify({
          role: config.role,
          redirect_uri: buildRedirectUri(config),
          client_nonce: clientNonce,
        }),
      },
      deps
    );
  } catch (error) {
    throw new VaultError(
      `Vault OIDC authorization request failed: ${getSafeErrorMessage(error, config)}`,
      error.code || 'VAULT_OIDC_AUTH_URL_FAILED',
      error.status
    );
  }

  const authUrl = response && response.data && response.data.auth_url;
  let parsedUrl;
  try {
    parsedUrl = new URL(authUrl);
  } catch {
    throw new VaultError('Vault returned an invalid OIDC authorization URL.', 'VAULT_OIDC_INVALID');
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new VaultError('Vault returned an invalid OIDC authorization URL.', 'VAULT_OIDC_INVALID');
  }

  const state = parsedUrl.searchParams.get('state');
  const nonce = parsedUrl.searchParams.get('nonce');
  if (!isNonEmpty(state) || !isNonEmpty(nonce)) {
    throw new VaultError(
      'Vault OIDC authorization URL did not include state and nonce.',
      'VAULT_OIDC_INVALID'
    );
  }

  return { authUrl: parsedUrl.toString(), state, nonce, clientNonce };
}

function valuesMatch(expected, actual, cryptoModule = crypto) {
  if (!isNonEmpty(expected) || !isNonEmpty(actual)) return false;
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return (
    expectedBuffer.length === actualBuffer.length &&
    cryptoModule.timingSafeEqual(expectedBuffer, actualBuffer)
  );
}

function validateCallback(query, authRequest, cryptoModule = crypto) {
  if (!isNonEmpty(query.state) || !isNonEmpty(query.code)) return false;
  if (!valuesMatch(authRequest.state, query.state, cryptoModule)) return false;

  return query.nonce === undefined || query.nonce === null
    ? true
    : valuesMatch(authRequest.nonce, query.nonce, cryptoModule);
}

/**
 * Exchange the validated provider callback with Vault.
 * @param {object} config - Normalized Vault configuration
 * @param {object} callback - state, nonce, code, and clientNonce values
 * @param {object} [deps] - Injectable request implementation
 * @returns {Promise<string>} Short-lived Vault client token
 */
async function exchangeOidcCallback(config, callback, deps = {}) {
  if (!isNonEmpty(callback.state) || !isNonEmpty(callback.nonce) || !isNonEmpty(callback.code)) {
    throw new VaultError(
      'Vault OIDC callback requires state, nonce, and code.',
      'VAULT_OIDC_CALLBACK_INVALID'
    );
  }

  const callbackUrl = new URL(
    buildVaultUrl(config, ['auth', config.authMount, 'oidc', 'callback'])
  );
  callbackUrl.searchParams.set('state', callback.state);
  callbackUrl.searchParams.set('nonce', callback.nonce);
  callbackUrl.searchParams.set('code', callback.code);
  if (isNonEmpty(callback.clientNonce)) {
    callbackUrl.searchParams.set('client_nonce', callback.clientNonce);
  }

  let response;
  try {
    response = await requestVaultJson(
      {
        method: 'GET',
        url: callbackUrl.toString(),
        headers: buildHeaders(config),
      },
      deps
    );
  } catch (error) {
    throw new VaultError(
      `Vault OIDC token exchange failed: ${getSafeErrorMessage(error, config)}`,
      error.code || 'VAULT_OIDC_EXCHANGE_FAILED',
      error.status
    );
  }

  const token = response && response.auth && response.auth.client_token;
  if (!isNonEmpty(token)) {
    throw new VaultError(
      'Vault OIDC token exchange returned no client token.',
      'VAULT_OIDC_INVALID'
    );
  }

  return token;
}

function sendCallbackResponse(response, statusCode, text) {
  response.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(text);
}

/**
 * Start a loopback-only callback listener for a single OIDC exchange.
 * @param {object} config - Normalized Vault configuration
 * @param {object} authRequest - Values returned by requestAuthUrl
 * @param {object} [deps] - Injectable server, request, and crypto functions
 * @returns {{server: object, ready: Promise<object>, result: Promise<string>, close: Function}}
 */
function listenForOidcCallback(config, authRequest, deps = {}) {
  const createServer = deps.createServer || http.createServer;
  const cryptoModule = deps.crypto || crypto;
  let server;
  let settled = false;
  let timeout;
  let resolveResult;
  let rejectResult;

  const result = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const complete = (error, token) => {
    if (settled) return;
    settled = true;
    if (timeout) clearTimeout(timeout);
    if (server && server.listening) {
      server.close();
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    }
    if (error) rejectResult(error);
    else resolveResult(token);
  };

  const handler = (request, response) => {
    if (request.method !== 'GET') {
      sendCallbackResponse(response, 405, 'Vault authentication callback requires GET.');
      return;
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(request.url, 'http://localhost');
    } catch {
      sendCallbackResponse(response, 400, 'Invalid Vault authentication callback.');
      complete(new VaultError('Invalid Vault OIDC callback URL.', 'VAULT_OIDC_CALLBACK_INVALID'));
      return;
    }

    if (parsedUrl.pathname !== '/oidc/callback') {
      sendCallbackResponse(response, 404, 'Not Found');
      return;
    }

    const query = {
      state: parsedUrl.searchParams.get('state'),
      nonce: parsedUrl.searchParams.get('nonce'),
      code: parsedUrl.searchParams.get('code'),
    };

    if (!validateCallback(query, authRequest, cryptoModule)) {
      sendCallbackResponse(response, 400, 'Invalid or incomplete Vault authentication callback.');
      complete(
        new VaultError(
          'Vault OIDC callback state, nonce, or code was invalid.',
          'VAULT_OIDC_CALLBACK_INVALID'
        )
      );
      return;
    }

    exchangeOidcCallback(
      config,
      {
        ...query,
        nonce: authRequest.nonce,
        clientNonce: authRequest.clientNonce,
      },
      deps
    )
      .then((token) => {
        sendCallbackResponse(
          response,
          200,
          'Vault authentication completed. You can close this window.'
        );
        complete(null, token);
      })
      .catch(() => {
        sendCallbackResponse(
          response,
          502,
          'Vault authentication failed. Close this window and retry.'
        );
        complete(
          new VaultError(
            'Vault OIDC token exchange failed. Retry authentication.',
            'VAULT_OIDC_EXCHANGE_FAILED'
          )
        );
      });
  };

  try {
    server = createServer(handler);
  } catch {
    const error = new VaultError(
      'Unable to start the local Vault callback listener.',
      'VAULT_CALLBACK_ERROR'
    );
    return {
      server: null,
      ready: Promise.reject(error),
      result: Promise.reject(error),
      close: () => {},
    };
  }

  const ready = new Promise((resolve, reject) => {
    const onError = () => {
      const error = new VaultError(
        'Unable to start the local Vault callback listener. Check VAULT_OIDC_PORT.',
        'VAULT_CALLBACK_ERROR'
      );
      complete(error);
      reject(error);
    };

    server.once('error', onError);
    try {
      server.listen(config.oidcPort, '127.0.0.1', () => {
        server.removeListener('error', onError);
        timeout = setTimeout(() => {
          complete(
            new VaultError(
              'Vault OIDC callback timed out. Complete sign-in or retry authentication.',
              'VAULT_CALLBACK_TIMEOUT'
            )
          );
        }, config.callbackTimeoutMs || DEFAULTS.callbackTimeoutMs);
        if (typeof timeout.unref === 'function') timeout.unref();
        resolve(server.address());
      });
    } catch {
      onError();
    }
  });

  return {
    server,
    ready,
    result,
    close: () =>
      complete(new VaultError('Vault OIDC authentication was cancelled.', 'VAULT_CANCELLED')),
  };
}

/**
 * Launch the provider browser when possible, without using a shell.
 * @param {string} authUrl - Provider URL
 * @param {object} [deps] - Injectable platform and child-process module
 * @returns {boolean} True when a browser launch was requested
 */
function openBrowser(authUrl, deps = {}) {
  const platform = deps.platform || process.platform;
  const processModule = deps.childProcess || childProcess;
  let command;
  let args;
  const spawnOptions = { detached: true, stdio: 'ignore' };

  if (platform === 'win32') {
    command = 'rundll32.exe';
    args = ['url.dll,FileProtocolHandler', authUrl];
    spawnOptions.windowsHide = true;
  } else if (platform === 'darwin') {
    command = 'open';
    args = [authUrl];
  } else {
    command = 'xdg-open';
    args = [authUrl];
  }

  try {
    const child = processModule.spawn(command, args, spawnOptions);
    if (child && typeof child.unref === 'function') child.unref();
    return true;
  } catch {
    return false;
  }
}

function writeManualAuthUrl(authUrl, stream = process.stderr) {
  if (stream && typeof stream.write === 'function') {
    stream.write(`${authUrl.replace(/[\r\n]/g, '')}\n`);
  }
}

/**
 * Perform the complete browser OIDC flow and return a temporary Vault token.
 * @param {object} config - Normalized Vault configuration
 * @param {object} [deps] - Injectable HTTP, browser, and listener functions
 * @returns {Promise<string>} Temporary Vault client token
 */
async function authenticateWithOidc(config, deps = {}) {
  const clientNonce = createNonce(deps);
  const authRequest = await requestAuthUrl(config, clientNonce, deps);
  const listen = deps.listenForOidcCallback || listenForOidcCallback;
  const callback = listen(config, authRequest, deps);

  try {
    await callback.ready;

    let browserOpened = false;
    if (!config.skipBrowser) {
      try {
        const launch = deps.openBrowser || openBrowser;
        browserOpened = await launch(authRequest.authUrl, deps);
      } catch {
        browserOpened = false;
      }
    }

    if (!browserOpened) writeManualAuthUrl(authRequest.authUrl, deps.stderr || process.stderr);
    return await callback.result;
  } catch (error) {
    if (callback && callback.result && typeof callback.result.catch === 'function') {
      callback.result.catch(() => {});
    }
    if (callback && typeof callback.close === 'function') callback.close();
    throw error;
  }
}

/**
 * Read a KV v2 secret at the configured path.
 * @param {object} config - Normalized Vault configuration
 * @param {string} token - Temporary or explicit Vault token
 * @param {object} [deps] - Injectable request implementation
 * @returns {Promise<object>} Raw KV data fields
 */
async function readKvV2(config, token, deps = {}) {
  if (!isNonEmpty(token)) {
    throw new VaultError('Vault KV access requires a Vault token.', 'VAULT_TOKEN_MISSING');
  }

  let response;
  try {
    response = await requestVaultJson(
      {
        method: 'GET',
        url: buildVaultUrl(config, [config.kvMount, 'data', config.secretPath]),
        headers: buildHeaders(config, { 'X-Vault-Token': token }),
      },
      deps
    );
  } catch (error) {
    throw new VaultError(
      `Vault KV read failed: ${getSafeErrorMessage(error, config)}`,
      error.code || 'VAULT_KV_READ_FAILED',
      error.status
    );
  }

  const fields = response && response.data && response.data.data;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new VaultError(
      'Vault KV response did not contain data fields.',
      'VAULT_RESPONSE_INVALID'
    );
  }

  return fields;
}

/**
 * Keep only string-valued runtime keys from a KV v2 response.
 * @param {object} fields - Raw KV data fields
 * @returns {object} Allowlisted environment values
 */
function mapVaultEnvironment(fields) {
  const values = {};
  for (const key of VAULT_ENV_KEYS) {
    if (Object.prototype.hasOwnProperty.call(fields, key) && typeof fields[key] === 'string') {
      values[key] = fields[key];
    }
  }
  return values;
}

/**
 * Authenticate with Vault and read the allowlisted runtime environment.
 * @param {object} config - Normalized Vault configuration
 * @param {object} [deps] - Injectable functions
 * @returns {Promise<{values: object, source: string}>}
 */
async function loadVaultEnvironment(config, deps = {}) {
  let token = config.token;
  let source = 'token';

  try {
    if (!token) {
      source = 'oidc';
      token = await (deps.authenticateWithOidc || authenticateWithOidc)(config, deps);
    }

    const fields = await readKvV2(config, token, deps);
    return { values: mapVaultEnvironment(fields), source };
  } finally {
    token = null;
  }
}

module.exports = {
  DEFAULTS,
  VAULT_ENV_KEYS,
  VaultError,
  getVaultConfig,
  buildRedirectUri,
  buildVaultUrl,
  requestJson,
  requestAuthUrl,
  exchangeOidcCallback,
  listenForOidcCallback,
  authenticateWithOidc,
  openBrowser,
  readKvV2,
  mapVaultEnvironment,
  loadVaultEnvironment,
};
