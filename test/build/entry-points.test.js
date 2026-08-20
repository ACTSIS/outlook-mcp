/**
 * Entry-point export and direct-run behavior tests.
 *
 * Task 1.5: `index.js` and `outlook-auth-server.js` must export start
 * functions while retaining `require.main` direct-run behavior. These tests
 * run real child Node processes because both entry points have process
 * side effects (stdio MCP server, HTTP callback server).
 *
 * Approval tests (current behavior): requiring the modules without running
 * them does not start servers; direct execution still starts them.
 * RED tests (new behavior): startMCP / startAuthServer exports and
 * dispatcher wiring to them.
 */
const { spawn, spawnSync } = require('child_process');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');

const MCP_START_MARKER = 'MCP SERVER';
const MCP_CONNECTED_MARKER = 'connected and listening';
const AUTH_START_MARKER = 'Starting M365 MCP Authentication Server';

function runNodeSync(script) {
  return spawnSync(process.execPath, ['-e', script], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 15000,
  });
}

function runSpawnUntilMarker(args, marker) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: REPO_ROOT });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        reject(new Error(`Timed out waiting for marker: ${marker}`));
      }
    }, 15000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (!settled && (stdout + stderr).includes(marker)) {
        settled = true;
        clearTimeout(timer);
        child.kill('SIGTERM');
        resolve({ stdout, stderr });
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (!settled && (stdout + stderr).includes(marker)) {
        settled = true;
        clearTimeout(timer);
        child.kill('SIGTERM');
        resolve({ stdout, stderr });
      }
    });
    child.on('exit', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr });
      }
    });
  });
}

describe('entry points', () => {
  it('index.js exports startMCP as a function', () => {
    const result = runNodeSync(
      "const m = require('./index.js'); console.log(typeof m.startMCP); process.exit(0);"
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('function');
  });

  it('outlook-auth-server.js exports startAuthServer as a function', () => {
    const result = runNodeSync(
      "const m = require('./outlook-auth-server.js'); console.log(typeof m.startAuthServer); process.exit(0);"
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('function');
  });

  it('requiring outlook-auth-server.js without running does not start the server', () => {
    const result = runNodeSync(
      "require('./outlook-auth-server.js'); console.log('loaded'); process.exit(0);"
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('loaded');
    expect(result.stdout).not.toContain(AUTH_START_MARKER);
  });

  it('node outlook-auth-server.js still starts the callback server directly', async () => {
    const { stdout } = await runSpawnUntilMarker(['outlook-auth-server.js'], AUTH_START_MARKER);

    expect(stdout).toContain(AUTH_START_MARKER);
  });

  it('dispatcher mcp mode starts the real MCP server', async () => {
    const { stderr } = await runSpawnUntilMarker(['bin/m365-mcp.js', 'mcp'], MCP_START_MARKER);

    expect(stderr).toContain(MCP_START_MARKER);
  });

  it('dispatcher auth mode starts the real auth callback server', async () => {
    const { stdout } = await runSpawnUntilMarker(['bin/m365-mcp.js', 'auth'], AUTH_START_MARKER);

    expect(stdout).toContain(AUTH_START_MARKER);
  });

  it('dispatcher exits 2 with usage for an unknown mode', () => {
    const result = spawnSync(process.execPath, ['bin/m365-mcp.js', 'bogus'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 15000,
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Usage');
    expect(result.stderr).toContain('mcp');
    expect(result.stderr).toContain('auth');
  });

  it('debug-env.js still starts the MCP server after loading the entry point', async () => {
    const { stderr } = await runSpawnUntilMarker(['debug-env.js'], MCP_CONNECTED_MARKER);

    expect(stderr).toContain(MCP_CONNECTED_MARKER);
  });
});
