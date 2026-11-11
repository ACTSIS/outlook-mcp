/**
 * Authentication module for Outlook MCP server
 */
const { AsyncLocalStorage } = require('node:async_hooks');
const TokenStorage = require('./token-storage');
const { authTools } = require('./tools');

// Local stdio keeps its singleton; remote calls must supply an isolated store.
const requestStorage = new AsyncLocalStorage();

/**
 * The legacy synchronous token cache reads and writes the local token file.
 * It has no request isolation, so request-scoped code is refused access here;
 * direct requires of './token-manager' (e.g. auth/tools.js) remain a bypass.
 */
function refuseScopedTokenManagerAccess() {
  throw new TypeError('Legacy token manager is not request-scoped; use the request token store');
}
const tokenManager = new Proxy(require('./token-manager'), {
  get(target, property, receiver) {
    if (requestStorage.getStore()) refuseScopedTokenManagerAccess();
    return Reflect.get(target, property, receiver);
  },
  set(target, property, value, receiver) {
    if (requestStorage.getStore()) refuseScopedTokenManagerAccess();
    return Reflect.set(target, property, value, receiver);
  },
  has(target, property) {
    if (requestStorage.getStore()) refuseScopedTokenManagerAccess();
    return Reflect.has(target, property);
  },
});
const localTokenStorage = new TokenStorage();
const tokenStorage = new Proxy(localTokenStorage, {
  get(target, property, receiver) {
    const scoped = requestStorage.getStore();
    if (!scoped) return Reflect.get(target, property, receiver);
    const value = Reflect.get(scoped, property);
    return typeof value === 'function' ? value.bind(scoped) : value;
  },
  set(target, property, value, receiver) {
    const scoped = requestStorage.getStore();
    return scoped
      ? Reflect.set(scoped, property, value)
      : Reflect.set(target, property, value, receiver);
  },
  has(target, property) {
    const scoped = requestStorage.getStore();
    return scoped ? Reflect.has(scoped, property) : Reflect.has(target, property);
  },
  ownKeys(target) {
    const scoped = requestStorage.getStore();
    return scoped ? Reflect.ownKeys(scoped) : Reflect.ownKeys(target);
  },
  getOwnPropertyDescriptor(target, property) {
    const scoped = requestStorage.getStore();
    return scoped
      ? Reflect.getOwnPropertyDescriptor(scoped, property)
      : Reflect.getOwnPropertyDescriptor(target, property);
  },
  getPrototypeOf(target) {
    const scoped = requestStorage.getStore();
    return scoped ? Object.getPrototypeOf(scoped) : Reflect.getPrototypeOf(target);
  },
  deleteProperty(target, property) {
    if (requestStorage.getStore()) {
      throw new TypeError('Request token stores cannot be removed through tokenStorage');
    }
    return Reflect.deleteProperty(target, property);
  },
  defineProperty(target, property, descriptor) {
    if (requestStorage.getStore()) {
      throw new TypeError('Request token stores cannot be redefined through tokenStorage');
    }
    return Reflect.defineProperty(target, property, descriptor);
  },
  setPrototypeOf(target, prototype) {
    if (requestStorage.getStore()) {
      throw new TypeError('Request token stores cannot be re-parented through tokenStorage');
    }
    return Reflect.setPrototypeOf(target, prototype);
  },
});

function runWithTokenStorage(storage, callback) {
  if (typeof storage !== 'object' || storage === null) {
    throw new TypeError('A request token store object is required');
  }
  if (typeof callback !== 'function') {
    throw new TypeError('A request token store callback is required');
  }
  return requestStorage.run(storage, callback);
}

/**
 * Refresh the live authentication configuration after explicit Vault setup.
 * The singleton is created before MCP tools run, so replacing process.env
 * alone would otherwise leave stale credentials and endpoints in memory.
 * @returns {object} Refreshed TokenStorage configuration
 */
function refreshRuntimeConfiguration() {
  return tokenStorage.refreshRuntimeConfiguration();
}

/**
 * Ensures the user is authenticated and returns an access token.
 * Automatically refreshes expired tokens using the refresh_token grant.
 * @param {boolean} forceNew - Whether to force a new authentication
 * @returns {Promise<string>} - Access token
 * @throws {Error} - If authentication fails
 */
async function ensureAuthenticated(forceNew = false) {
  if (forceNew) {
    throw new Error('Authentication required');
  }

  // Use TokenStorage which handles automatic refresh
  const accessToken = await tokenStorage.getValidAccessToken();
  if (!accessToken) {
    throw new Error('Authentication required');
  }

  return accessToken;
}

module.exports = {
  tokenManager,
  tokenStorage,
  authTools,
  ensureAuthenticated,
  refreshRuntimeConfiguration,
  runWithTokenStorage,
};
