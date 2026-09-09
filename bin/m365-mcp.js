#!/usr/bin/env node
/**
 * M365 MCP dispatcher - routes a single executable to the MCP stdio server
 * or the authentication callback server.
 *
 * Usage:
 *   m365-mcp          start the MCP server (default)
 *   m365-mcp mcp      start the MCP server
 *   m365-mcp auth     start the authentication callback server (port 3333)
 *   m365-mcp vault-setup  explicitly complete the Vault setup flow
 *
 * Unsupported arguments print usage to stderr and exit 2.
 */

const path = require('path');

const MODES = ['mcp', 'auth', 'vault-setup'];

/**
 * Resolve the requested mode from the CLI arguments.
 * @param {string[]} args - Process arguments after the executable/script (e.g. process.argv.slice(2))
 * @returns {string|null} A supported mode, or null when the arguments are unsupported
 */
function resolveMode(args) {
  if (args.length > 1) return null;
  const [mode] = args;
  if (mode === undefined || mode === 'mcp') return 'mcp';
  if (mode === 'auth') return 'auth';
  if (mode === 'vault-setup') return 'vault-setup';
  return null;
}

function safeVaultErrorCode(error) {
  const rawCode = error && typeof error.code === 'string' ? error.code : 'VAULT_SETUP_FAILED';
  return rawCode.replace(/[^a-z0-9_]/gi, '_').slice(0, 80);
}

async function runVaultSetup(loadRuntimeEnv, stderr) {
  let result;

  try {
    result = await loadRuntimeEnv({ force: true, vaultSetup: true });
  } catch (error) {
    const code = safeVaultErrorCode(error);
    const exitCode = code === 'VAULT_CONFIG_INVALID' ? 2 : 1;
    stderr.write(
      `Vault setup ${exitCode === 2 ? 'is misconfigured' : 'failed'} (${code}). Check the Vault configuration and connectivity, then retry.\n`
    );
    return exitCode;
  }

  const vault = result && result.vault ? result.vault : {};
  if (!vault.enabled) {
    stderr.write(
      'Vault setup is disabled. Set VAULT_ADDR in the external environment, then retry.\n'
    );
    return 2;
  }

  if (vault.setupRequired) {
    stderr.write(
      'Vault setup did not complete. Check the Vault configuration and retry the explicit setup command.\n'
    );
    return 1;
  }

  if (vault.cache && vault.cache.saved === false) {
    stderr.write(
      'Vault setup loaded the runtime values, but the Vault identity cache could not be saved. Fix local cache permissions and retry.\n'
    );
    return 1;
  }

  const loaded = Number.isInteger(vault.loaded) && vault.loaded >= 0 ? vault.loaded : 0;
  stderr.write(`Vault setup completed. Loaded ${loaded} allowlisted runtime values.\n`);
  return 0;
}

/**
 * Run the dispatcher for the given arguments.
 * @param {string[]} args - Process arguments after the executable/script
 * @param {object} deps - Dependencies (overridable for tests)
 * @param {Function} deps.loadRuntimeEnv - Loads external environment configuration
 * @param {Function} deps.loadEnv - Backward-compatible test dependency alias
 * @param {Function} deps.startMCP - Starts the MCP server entry point
 * @param {Function} deps.startAuth - Starts the auth callback server entry point
 * @param {Function} deps.setAuthLauncher - Points auth-server-manager at this executable
 * @param {Function} deps.isPackagedExecutable - True when running as a standalone binary
 * @param {string} deps.execPath - Path of the running executable
 * @param {object} deps.stderr - Stream receiving usage output
 * @returns {Promise<number>} Process exit code
 */
async function run(args, deps = {}) {
  const stderr = deps.stderr || process.stderr;

  const mode = resolveMode(args);

  if (!mode) {
    stderr.write(`Usage: m365-mcp [${MODES.join('|')}]\n`);
    stderr.write(`  ${MODES[0]}      start the MCP server (default)\n`);
    stderr.write(`  ${MODES[1]}     start the authentication callback server (port 3333)\n`);
    stderr.write(`  ${MODES[2]}  perform explicit Vault setup\n`);
    return 2;
  }

  const loadRuntimeEnv =
    deps.loadRuntimeEnv || deps.loadEnv || require('../runtime/load-runtime-env').loadRuntimeEnv;

  if (mode === 'vault-setup') {
    return runVaultSetup(loadRuntimeEnv, stderr);
  }

  await loadRuntimeEnv();

  if (mode === 'mcp') {
    const startMCP = deps.startMCP || require('../index').startMCP;
    const setAuthLauncher =
      deps.setAuthLauncher || require('../auth/auth-server-manager').setLauncher;
    const execPath = deps.execPath || process.execPath;
    const isPackagedExecutable = deps.isPackagedExecutable || isStandaloneExecutable;

    // Both packaged and source runs relaunch through this dispatcher so the
    // auth child receives the same runtime bootstrap and environment.
    const launcher = isPackagedExecutable(execPath)
      ? { command: execPath, args: ['auth'] }
      : { command: process.execPath, args: [path.join(__dirname, 'm365-mcp.js'), 'auth'] };
    setAuthLauncher(launcher);
    await startMCP();
    return 0;
  }

  if (mode === 'auth') {
    const startAuth = deps.startAuth || require('../outlook-auth-server').startAuthServer;

    await startAuth();
    return 0;
  }
}

/**
 * True when the running executable is a standalone binary rather than a Node
 * runtime (SEA executables and ncc bundles embed the script).
 * @param {string} execPath - Path of the running executable
 * @returns {boolean}
 */
function isStandaloneExecutable(execPath) {
  const basename = path.basename(execPath).toLowerCase();
  return !basename.includes('node') && !basename.includes('node.exe');
}

/**
 * SEA-safe direct-run gate.
 *
 * Source runs dispatch when `require.main === module`. Inside a SEA
 * executable that check is dangerous: ncc rewrites it to a `require.cache[...]`
 * read and `require.cache` is undefined under SEA, so the comparison itself
 * throws before any dispatch can happen. Detect SEA first and short-circuit:
 * a packaged executable is always the entry, so it always dispatches.
 * @param {object} probes - Overridable probes (for tests)
 * @param {Function} probes.isSea - True when running inside a SEA executable
 * @param {Function} probes.isMainModule - `require.main === module`
 * @returns {boolean}
 */
function shouldDispatch(probes = {}) {
  const isSea = probes.isSea || (() => process.execPath.includes('outlook-mcp'));
  if (isSea()) return true;
  const isMainModule = probes.isMainModule || (() => require.main === module);
  return isMainModule();
}

// Retain direct-run behavior: dispatch when invoked as a script or binary.
// The SEA probe is checked first so bundled executables never evaluate the
// require.main comparison (see shouldDispatch).
if (shouldDispatch()) {
  run(process.argv.slice(2))
    .then((code) => {
      if (code !== 0) process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`Startup failed: ${error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = { run, resolveMode, MODES, shouldDispatch };
