const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const config = require('../config');

const AUTH_SERVER_PATH = path.join(__dirname, '..', 'outlook-auth-server.js');
const AUTH_SERVER_URL = config.AUTH_CONFIG.authServerUrl;

let authServerProcess = null;

// Launcher override for packaged executables. When set, the callback server is
// launched through this command/args pair (e.g. the dispatcher `auth` mode);
// the source npm path keeps launching `node outlook-auth-server.js`.
let launcher = null;

/**
 * Select how the callback server process is launched.
 * @param {{command: string, args: string[]}|null} value - Dispatcher launcher,
 *   or null/undefined to restore the source `node outlook-auth-server.js` default.
 */
function setLauncher(value) {
  launcher = value || null;
}

function checkAuthServer() {
  return new Promise((resolve) => {
    const req = http.get(AUTH_SERVER_URL, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });

    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForAuthServer(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await checkAuthServer()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return false;
}

async function startAuthServer() {
  if (await checkAuthServer()) {
    return {
      started: false,
      running: true,
      message: 'Authentication server is already running.',
    };
  }

  const command = launcher ? launcher.command : process.execPath;
  const args = launcher ? launcher.args : [AUTH_SERVER_PATH];

  authServerProcess = spawn(command, args, {
    cwd: path.dirname(AUTH_SERVER_PATH),
    env: process.env,
    detached: false,
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  authServerProcess.on('exit', () => {
    authServerProcess = null;
  });
  authServerProcess.on('error', () => {
    authServerProcess = null;
  });

  authServerProcess.unref();

  if (!(await waitForAuthServer())) {
    const failedProcess = authServerProcess;
    const pid = failedProcess && failedProcess.pid;
    if (failedProcess) failedProcess.kill('SIGTERM');
    authServerProcess = null;
    return {
      started: false,
      running: false,
      message: `Authentication server did not become ready${pid ? ` (pid ${pid})` : ''}.`,
    };
  }

  const pid = authServerProcess && authServerProcess.pid;

  return {
    started: true,
    running: true,
    ...(pid ? { pid } : {}),
    message: 'Authentication server started.',
  };
}

async function stopAuthServer() {
  if (authServerProcess) {
    const pid = authServerProcess.pid;
    authServerProcess.kill('SIGTERM');
    authServerProcess = null;
    return { stopped: true, message: `Authentication server stopped (pid ${pid}).` };
  }

  if (await checkAuthServer()) {
    return {
      stopped: false,
      message:
        'Authentication server is running, but it was not started by this MCP process. Stop it manually.',
    };
  }

  return { stopped: false, message: 'Authentication server is not running.' };
}

module.exports = {
  startAuthServer,
  stopAuthServer,
  checkAuthServer,
  setLauncher,
};
