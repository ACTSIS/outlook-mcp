#!/usr/bin/env node
/**
 * M365 MCP dispatcher - routes a single executable to the MCP stdio server
 * or the authentication callback server.
 *
 * Usage:
 *   m365-mcp          start the MCP server (default)
 *   m365-mcp mcp      start the MCP server
 *   m365-mcp auth     start the authentication callback server (port 3333)
 *
 * Unsupported arguments print usage to stderr and exit 2.
 */

const path = require('path');

const MODES = ['mcp', 'auth'];

/**
 * Resolve the requested mode from the CLI arguments.
 * @param {string[]} args - Process arguments after the executable/script (e.g. process.argv.slice(2))
 * @returns {string|null} 'mcp', 'auth', or null when the arguments are unsupported
 */
function resolveMode(args) {
  if (args.length > 1) return null;
  const [mode] = args;
  if (mode === undefined || mode === 'mcp') return 'mcp';
  if (mode === 'auth') return 'auth';
  return null;
}

/**
 * Run the dispatcher for the given arguments.
 * @param {string[]} args - Process arguments after the executable/script
 * @param {object} deps - Dependencies (overridable for tests)
 * @param {Function} deps.loadEnv - Loads external environment configuration
 * @param {Function} deps.startMCP - Starts the MCP server entry point
 * @param {Function} deps.startAuth - Starts the auth callback server entry point
 * @param {Function} deps.setAuthLauncher - Points auth-server-manager at this executable
 * @param {Function} deps.isPackagedExecutable - True when running as a standalone binary
 * @param {string} deps.execPath - Path of the running executable
 * @param {object} deps.stderr - Stream receiving usage output
 * @returns {number} Process exit code
 */
function run(args, deps = {}) {
  const stderr = deps.stderr || process.stderr;

  const mode = resolveMode(args);

  if (mode === 'mcp') {
    const loadEnv = deps.loadEnv || require('../runtime/load-env').loadEnv;
    const startMCP = deps.startMCP || require('../index').startMCP;
    const setAuthLauncher =
      deps.setAuthLauncher || require('../auth/auth-server-manager').setLauncher;
    const execPath = deps.execPath || process.execPath;
    const isPackagedExecutable = deps.isPackagedExecutable || isStandaloneExecutable;

    loadEnv();
    // Packaged executables relaunch themselves in `auth` mode for the callback
    // server; source runs keep the current `node outlook-auth-server.js`.
    if (isPackagedExecutable(execPath)) {
      setAuthLauncher({ command: execPath, args: ['auth'] });
    }
    startMCP();
    return 0;
  }

  if (mode === 'auth') {
    const loadEnv = deps.loadEnv || require('../runtime/load-env').loadEnv;
    const startAuth = deps.startAuth || require('../outlook-auth-server').startAuthServer;

    loadEnv();
    startAuth();
    return 0;
  }

  stderr.write(`Usage: m365-mcp [${MODES.join('|')}]\n`);
  stderr.write(`  ${MODES[0]}      start the MCP server (default)\n`);
  stderr.write(`  ${MODES[1]}     start the authentication callback server (port 3333)\n`);
  return 2;
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
  const code = run(process.argv.slice(2));
  if (code !== 0) process.exit(code);
}

module.exports = { run, resolveMode, MODES, shouldDispatch };
