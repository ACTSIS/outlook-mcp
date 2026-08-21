/**
 * Per-user cache for short-lived Vault client tokens.
 *
 * This module deliberately stores no Microsoft credentials or KV values. The
 * cache is keyed by Vault connection/authentication identity and only contains
 * the Vault token plus safe lease metadata.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const CACHE_VERSION = 1;
const CACHE_DIRECTORY = 'm365-mcp';
const CACHE_FILENAME = 'vault-token.json';
const CACHE_ENTRY_KEYS = new Set(['token', 'expireTime', 'ttl', 'renewable', 'savedAt']);

class VaultTokenCacheError extends Error {
  constructor(message, code = 'VAULT_TOKEN_CACHE_ERROR') {
    super(message);
    this.name = 'VaultTokenCacheError';
    this.code = code;
  }
}

function isNonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getPathModule(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function getHomeDirectory(env, options, platform) {
  return (
    options.homeDir ||
    (env && (env.USERPROFILE || env.HOME)) ||
    os.homedir() ||
    (platform === 'win32' ? 'C:\\' : '/')
  );
}

function resolveCachePath(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const pathModule = getPathModule(platform);
  const override = isNonEmpty(options.filePath) ? options.filePath : env.VAULT_TOKEN_CACHE_PATH;

  if (isNonEmpty(override)) return pathModule.resolve(override.trim());

  const homeDirectory = getHomeDirectory(env, options, platform);
  if (platform === 'win32') {
    const baseDirectory = env.LOCALAPPDATA || env.APPDATA || homeDirectory;
    return pathModule.join(baseDirectory, CACHE_DIRECTORY, CACHE_FILENAME);
  }

  const configDirectory = env.XDG_CONFIG_HOME || pathModule.join(homeDirectory, '.config');
  return pathModule.join(configDirectory, CACHE_DIRECTORY, CACHE_FILENAME);
}

function getVaultTokenCachePath(options = {}) {
  return resolveCachePath(options);
}

function normalizeAddress(address) {
  if (!isNonEmpty(address)) return '';

  try {
    const parsed = new URL(address.trim());
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return address.trim().replace(/\/+$/, '');
  }
}

function getVaultTokenCacheKey(config) {
  return JSON.stringify([
    normalizeAddress(config && config.address),
    isNonEmpty(config && config.namespace) ? config.namespace.trim() : '',
    isNonEmpty(config && config.authMount) ? config.authMount.trim() : '',
    isNonEmpty(config && config.role) ? config.role.trim() : '',
  ]);
}

function isValidDateString(value) {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function normalizeExpireTime(value) {
  if (value === null || value === undefined || value === '') return null;
  return isValidDateString(value) ? value : null;
}

function normalizeTtl(value) {
  if (value === null || value === undefined || value === '') return null;
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function normalizeSavedAt(value, fallback) {
  if (isValidDateString(value)) return value;
  return fallback;
}

function normalizeCacheEntry(entry) {
  if (!isPlainObject(entry) || !isNonEmpty(entry.token)) return null;
  if (Object.keys(entry).some((key) => !CACHE_ENTRY_KEYS.has(key))) return null;
  if (typeof entry.renewable !== 'boolean') return null;
  if (!isValidDateString(entry.savedAt)) return null;

  const expireTime = normalizeExpireTime(entry.expireTime);
  const ttl = normalizeTtl(entry.ttl);
  if (entry.expireTime !== undefined && entry.expireTime !== null && expireTime === null) {
    return null;
  }
  if (entry.ttl !== undefined && entry.ttl !== null && ttl === null) return null;

  return {
    token: entry.token,
    expireTime,
    ttl,
    renewable: entry.renewable,
    savedAt: entry.savedAt,
  };
}

function createCacheDocument() {
  return { version: CACHE_VERSION, entries: {} };
}

function parseCacheDocument(raw) {
  let document;
  try {
    document = JSON.parse(raw);
  } catch {
    return null;
  }

  if (
    !isPlainObject(document) ||
    document.version !== CACHE_VERSION ||
    !isPlainObject(document.entries) ||
    Object.keys(document).some((key) => !['version', 'entries'].includes(key)) ||
    Object.entries(document.entries).some(
      ([key, entry]) => !isValidCacheKey(key) || !normalizeCacheEntry(entry)
    )
  ) {
    return null;
  }

  return document;
}

function isValidCacheKey(key) {
  try {
    const parts = JSON.parse(key);
    return (
      Array.isArray(parts) && parts.length === 4 && parts.every((part) => typeof part === 'string')
    );
  } catch {
    return false;
  }
}

function unlinkBestEffort(filePath, fsModule) {
  try {
    fsModule.unlinkSync(filePath);
  } catch {
    // Missing or inaccessible cache files are handled as cache misses.
  }
}

function readDocument(filePath, fsModule) {
  let raw;
  try {
    raw = fsModule.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  const document = parseCacheDocument(raw);
  if (!document) {
    unlinkBestEffort(filePath, fsModule);
    return null;
  }
  return document;
}

function makeTempPath(filePath, options) {
  const suffix =
    options.tempSuffix || `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${filePath}.${suffix}.tmp`;
}

function applyRestrictiveMode(filePath, fsModule) {
  try {
    fsModule.chmodSync(filePath, 0o600);
  } catch {
    // Windows ACLs are managed by the account owning the profile. chmod is a
    // best-effort restriction there and is required on POSIX systems.
  }
}

function writeDocumentAtomically(filePath, document, options = {}) {
  const fsModule = options.fs || fs;
  const pathModule = getPathModule(options.platform || process.platform);
  const parentDirectory = pathModule.dirname(filePath);
  const tempPath = makeTempPath(filePath, options);
  const payload = `${JSON.stringify(document, null, 2)}\n`;

  try {
    fsModule.mkdirSync(parentDirectory, { recursive: true, mode: 0o700 });
    try {
      fsModule.chmodSync(parentDirectory, 0o700);
    } catch {
      // Best effort on Windows; POSIX file mode remains enforced below.
    }
    fsModule.writeFileSync(tempPath, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    applyRestrictiveMode(tempPath, fsModule);
    fsModule.renameSync(tempPath, filePath);
    applyRestrictiveMode(filePath, fsModule);
  } catch {
    unlinkBestEffort(tempPath, fsModule);
    throw new VaultTokenCacheError(
      'Unable to persist the local Vault token cache.',
      'VAULT_TOKEN_CACHE_WRITE_FAILED'
    );
  }
}

function getFileOptions(config, options = {}) {
  const filePath =
    options.filePath !== undefined ? options.filePath : config && config.tokenCachePath;
  return {
    ...options,
    filePath,
  };
}

/**
 * Read the cache entry for one Vault identity. Invalid or unreadable cache
 * content is deleted on a best-effort basis and treated as a cache miss.
 * @param {object} config - Normalized Vault configuration
 * @param {object} [options] - Injectable filesystem/path settings
 * @returns {object|null} Cached token and safe lease metadata
 */
function readVaultTokenCache(config, options = {}) {
  const fsModule = options.fs || fs;
  const filePath = resolveCachePath(getFileOptions(config, options));
  const document = readDocument(filePath, fsModule);
  if (!document) return null;

  const key = getVaultTokenCacheKey(config);
  const entry = document.entries[key];
  if (entry === undefined) return null;

  const normalized = normalizeCacheEntry(entry);
  if (normalized) return normalized;

  delete document.entries[key];
  if (Object.keys(document.entries).length === 0) {
    unlinkBestEffort(filePath, fsModule);
  } else {
    try {
      writeDocumentAtomically(filePath, document, options);
    } catch {
      // The malformed entry is already ignored; a later startup can retry.
    }
  }
  return null;
}

/**
 * Save one Vault token and safe lease metadata atomically.
 * @param {object} config - Normalized Vault configuration
 * @param {string} token - Short-lived Vault client token
 * @param {object} [metadata] - expireTime, ttl, and renewable metadata
 * @param {object} [options] - Injectable filesystem/path/time settings
 * @returns {{saved: boolean}} Safe save result without token content
 */
function writeVaultTokenCache(config, token, metadata = {}, options = {}) {
  if (!isNonEmpty(token)) {
    throw new VaultTokenCacheError(
      'A Vault client token is required for cache persistence.',
      'VAULT_TOKEN_CACHE_INVALID'
    );
  }

  const fsModule = options.fs || fs;
  const filePath = resolveCachePath(getFileOptions(config, options));
  const existing = readDocument(filePath, fsModule);
  const document = existing || createCacheDocument();
  const now = options.now ? new Date(options.now) : new Date();
  const savedAt = normalizeSavedAt(metadata.savedAt, now.toISOString());
  const renewable = metadata.renewable === true;

  document.entries[getVaultTokenCacheKey(config)] = {
    token,
    expireTime: normalizeExpireTime(metadata.expireTime),
    ttl: normalizeTtl(metadata.ttl),
    renewable,
    savedAt,
  };

  writeDocumentAtomically(filePath, document, options);
  return { saved: true };
}

/**
 * Delete one Vault identity from the cache. If the cache cannot be parsed,
 * remove the complete file because it cannot be safely reused.
 * @param {object} config - Normalized Vault configuration
 * @param {object} [options] - Injectable filesystem/path settings
 * @returns {{deleted: boolean}} Safe deletion result
 */
function deleteVaultTokenCache(config, options = {}) {
  const fsModule = options.fs || fs;
  const filePath = resolveCachePath(getFileOptions(config, options));
  let exists = true;

  try {
    fsModule.accessSync(filePath);
  } catch {
    exists = false;
  }
  if (!exists) return { deleted: false };

  const document = readDocument(filePath, fsModule);
  if (!document) {
    unlinkBestEffort(filePath, fsModule);
    return { deleted: true };
  }

  const key = getVaultTokenCacheKey(config);
  if (!Object.prototype.hasOwnProperty.call(document.entries, key)) {
    return { deleted: false };
  }

  delete document.entries[key];
  if (Object.keys(document.entries).length === 0) {
    unlinkBestEffort(filePath, fsModule);
    return { deleted: true };
  }

  try {
    writeDocumentAtomically(filePath, document, options);
  } catch {
    // Failing closed is safer than leaving a revoked token available.
    unlinkBestEffort(filePath, fsModule);
  }
  return { deleted: true };
}

module.exports = {
  CACHE_VERSION,
  CACHE_DIRECTORY,
  CACHE_FILENAME,
  VaultTokenCacheError,
  getVaultTokenCachePath,
  getVaultTokenCacheKey,
  readVaultTokenCache,
  writeVaultTokenCache,
  deleteVaultTokenCache,
};
