/**
 * Runtime environment bootstrap for source and packaged executable modes.
 *
 * The bootstrap first loads the adjacent `.env`, then optionally reads the
 * allowlisted runtime keys from Vault. Process/MCP values remain authoritative.
 */

const { loadEnv } = require('./load-env');
const {
  VAULT_ENV_KEYS,
  getVaultConfig,
  loadVaultEnvironment,
  setupVaultEnvironment,
} = require('./vault-client');

const BOOTSTRAP_MARKER = 'M365_MCP_RUNTIME_BOOTSTRAP_COMPLETE';
const runtimeStates = new WeakMap();
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

function getRuntimeState(env) {
  let state = runtimeStates.get(env);
  if (!state) {
    state = {
      processKeys: new Set(Object.keys(env)),
      loadedFromFile: new Set(),
      vaultKeys: new Set(),
    };
    runtimeStates.set(env, state);
  }
  return state;
}

function discoverNewProcessKeys(env, state) {
  for (const key of Object.keys(env)) {
    if (!state.loadedFromFile.has(key) && !state.vaultKeys.has(key)) {
      state.processKeys.add(key);
    }
  }
}

function removePreviousVaultValues(env, state) {
  for (const key of state.vaultKeys) {
    if (!state.processKeys.has(key)) delete env[key];
  }
  state.vaultKeys.clear();
}

function applyVaultValues(env, values, processKeys, loadedFromFile, options = {}) {
  const vaultKeys = options.vaultKeys;
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
        if (vaultKeys) vaultKeys.add(key);
        loaded += 1;
      }
    }
  }

  for (const key of VAULT_ENV_KEYS) {
    if (ALIAS_GROUPS.some((group) => group.includes(key))) continue;
    if (!hasOwn(values, key) || processKeys.has(key)) continue;
    env[key] = values[key];
    if (vaultKeys) vaultKeys.add(key);
    loaded += 1;
  }

  return loaded;
}

/**
 * Load `.env`, authenticate to Vault when configured, and populate process.env.
 * @param {object} [options] - Overridable dependencies for tests
 * @param {object} [options.env=process.env] - Environment target
 * @param {Function} [options.loadVaultEnvironment] - Vault loader override
 * @param {Function} [options.setupVaultEnvironment] - Explicit Vault setup override
 * @param {Function} [options.getVaultConfig] - Vault config override
 * @param {object} [options.vaultDeps] - Vault dependency overrides
 * @param {boolean} [options.force] - Bypass the inherited bootstrap marker
 * @param {boolean} [options.vaultSetup] - Use the explicit OIDC setup path
 * @returns {Promise<object>} Bootstrap result without secret values
 */
async function loadRuntimeEnv(options = {}) {
  const env = options.env || process.env;
  const usesProcessEnv = env === process.env;
  const marker = options.bootstrapMarker || BOOTSTRAP_MARKER;
  const state = getRuntimeState(env);
  discoverNewProcessKeys(env, state);

  // A dispatcher-launched auth child inherits the already-resolved runtime
  // environment from its MCP parent. Avoid opening a second Vault browser flow.
  if (!options.force && usesProcessEnv && env[marker] === '1') {
    return {
      envFile: null,
      loadedFromFile: 0,
      vault: { enabled: true, skipped: true, loaded: 0 },
    };
  }

  const processKeys = state.processKeys;
  const loadedFromFile = state.loadedFromFile;
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
    const readVault = options.vaultSetup
      ? options.setupVaultEnvironment || setupVaultEnvironment
      : options.loadVaultEnvironment || loadVaultEnvironment;
    const result = await readVault(vaultConfig, options.vaultDeps || {});
    const values = result && result.values ? result.values : result || {};
    if (options.vaultSetup && !(result && result.setupRequired)) {
      removePreviousVaultValues(env, state);
    }
    const loaded = applyVaultValues(env, values, processKeys, loadedFromFile, {
      vaultKeys: state.vaultKeys,
    });
    vaultResult = {
      enabled: true,
      loaded,
      source: result && result.source ? result.source : undefined,
      ...(result && result.setupRequired ? { setupRequired: true } : {}),
      ...(result && result.message ? { message: result.message } : {}),
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
