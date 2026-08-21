/**
 * External `.env` resolution for source and packaged-executable locations.
 *
 * Packaged executables must keep the environment-variable/`.env` contract
 * with the `.env` file beside the executable. Source runs keep the `.env`
 * beside the source tree. This module never packages `.env` content and never
 * embeds secrets - it only reads an external file at runtime.
 */

const fs = require('fs');
const path = require('path');

const ENV_FILENAME = '.env';

/**
 * Resolve the external `.env` path for the running process.
 * @param {object} options - Overridable process locations (for tests)
 * @param {string} options.execPath - Path of the running executable
 * @param {string} options.sourceDir - Directory of this module's source tree
 * @returns {string|null} Absolute `.env` path, or null when no `.env` exists
 */
function resolveEnvPath(options = {}) {
  const execPath = options.execPath || process.execPath;
  const sourceDir = options.sourceDir || __dirname;

  const candidates = [
    // Packaged executable: `.env` beside the executable
    path.join(path.dirname(execPath), ENV_FILENAME),
    // Source run: `.env` beside the module source tree
    path.join(sourceDir, ENV_FILENAME),
    // Source dispatcher: `.env` at the repository root beside the source tree
    path.join(sourceDir, '..', ENV_FILENAME),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Load the external `.env` file into the given environment.
 *
 * Existing environment variables (for example those set by an MCP client)
 * always win over values from the file, preserving current precedence.
 * @param {object} options - Overrides (for tests)
 * @param {object} options.env - Target environment object
 * @param {string} options.envPath - Absolute path to the `.env` file
 * @param {Set<string>} options.loadedKeys - Receives keys loaded from the file
 * @returns {object|null} { path, loaded } or null when no file exists
 */
function loadEnv(options = {}) {
  const env = options.env || process.env;
  const envPath = options.envPath || resolveEnvPath();
  const loadedKeys = options.loadedKeys;

  if (!envPath || !fs.existsSync(envPath)) return null;

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  let loaded = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eqIndex = line.indexOf('=');
    if (eqIndex <= 0) continue;

    const key = line.slice(0, eqIndex).trim();
    const value = line.slice(eqIndex + 1).trim();

    if (key && env[key] === undefined) {
      env[key] = value;
      if (loadedKeys) loadedKeys.add(key);
      loaded += 1;
    }
  }

  return { path: envPath, loaded };
}

module.exports = { loadEnv, resolveEnvPath };
