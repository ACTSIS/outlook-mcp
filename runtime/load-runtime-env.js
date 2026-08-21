/**
 * Runtime environment bootstrap for source and packaged executable modes.
 *
 * The bootstrap first loads the adjacent `.env`, then optionally reads the
 * allowlisted runtime keys from Vault. Process/MCP values remain authoritative.
 */

const { loadEnv } = require('./load-env');
const { VAULT_ENV_KEYS, getVaultConfig, loadVaultEnvironment } = require('./vault-client');

const BOOTSTRAP_MARKER = 'M365_MCP_RUNTIME_BOOTSTRAP_COMPLETE';
const ALIAS_GROUPS = [
  ['OUTLOOK_CLIENT_ID', 'MS_CLIENT_ID'],
  ['OUTLOOK_CLIENT_SECRET', 'MS_CLIENT_SECRET'],
];

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function removeFileValues(env, loadedFromFile, keys) {
  for (const key of keys) {
    if (loadedFromFile.has(key)) {
      delete env[key];
      loadedFromFile.delete(key);
    }
  }
}

function applyVaultValues(env, values, processKeys, loadedFromFile) {
  let loaded = 0;

  for (const group of ALIAS_GROUPS) {
    const groupProcessKey = group.some((key) => processKeys.has(key));
    const groupVaultKeys = group.filter((key) => hasOwn(values, key));

    if (groupProcessKey) {
      // A process value wins over both aliases, including a process value that
      // is intentionally empty. Remove only file values from the same group.
      removeFileValues(env, loadedFromFile, group);
      continue;
    }

    if (groupVaultKeys.length > 0) {
      // Vault has precedence over file values for the whole alias group so a
      // Vault MS_* value cannot lose to a stale OUTLOOK_* file value.
      removeFileValues(env, loadedFromFile, group);
      for (const key of groupVaultKeys) {
        env[key] = values[key];
        loaded += 1;
      }
    }
  }

  for (const key of VAULT_ENV_KEYS) {
    if (ALIAS_GROUPS.some((group) => group.includes(key))) continue;
    if (!hasOwn(values, key) || processKeys.has(key)) continue;
    env[key] = values[key];
    loaded += 1;
  }

  return loaded;
}

/**
 * Load `.env`, authenticate to Vault when configured, and populate process.env.
 * @param {object} [options] - Overridable dependencies for tests
 * @param {object} [options.env=process.env] - Environment target
 * @param {Function} [options.loadVaultEnvironment] - Vault loader override
 * @param {Function} [options.getVaultConfig] - Vault config override
 * @param {object} [options.vaultDeps] - Vault dependency overrides
 * @returns {Promise<object>} Bootstrap result without secret values
 */
async function loadRuntimeEnv(options = {}) {
  const env = options.env || process.env;
  const usesProcessEnv = env === process.env;
  const marker = options.bootstrapMarker || BOOTSTRAP_MARKER;

  // A dispatcher-launched auth child inherits the already-resolved runtime
  // environment from its MCP parent. Avoid opening a second Vault browser flow.
  if (!options.force && usesProcessEnv && env[marker] === '1') {
    return {
      envFile: null,
      loadedFromFile: 0,
      vault: { enabled: true, skipped: true, loaded: 0 },
    };
  }

  const processKeys = new Set(Object.keys(env));
  const loadedFromFile = new Set();
  const envFile = loadEnv({
    env,
    envPath: options.envPath,
    execPath: options.execPath,
    sourceDir: options.sourceDir,
    loadedKeys: loadedFromFile,
  });

  // Enforce process-over-file precedence across the OUTLOOK_*/MS_* aliases
  // even when Vault mode is disabled.
  applyVaultValues(env, {}, processKeys, loadedFromFile);

  const resolveConfig = options.getVaultConfig || getVaultConfig;
  const vaultConfig = resolveConfig(env);
  let vaultResult = { enabled: false, loaded: 0 };

  if (vaultConfig.enabled && !options.skipVault) {
    const readVault = options.loadVaultEnvironment || loadVaultEnvironment;
    const result = await readVault(vaultConfig, options.vaultDeps || {});
    const values = result && result.values ? result.values : result || {};
    const loaded = applyVaultValues(env, values, processKeys, loadedFromFile);
    vaultResult = {
      enabled: true,
      loaded,
      source: result && result.source ? result.source : undefined,
      ...(result && result.cache ? { cache: result.cache } : {}),
    };
  }

  if (usesProcessEnv && !options.skipMarker) env[marker] = '1';

  return {
    envFile,
    loadedFromFile: loadedFromFile.size,
    vault: vaultResult,
  };
}

module.exports = { BOOTSTRAP_MARKER, loadRuntimeEnv, applyVaultValues };
