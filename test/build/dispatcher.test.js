/**
 * Dispatcher routing tests (bin/m365-mcp.js).
 *
 * Contract from design: no argument or `mcp` starts the MCP server; `auth`
 * starts the port-3333 callback server; unsupported arguments print usage and
 * exit 2. Runtime environment bootstrap is awaited before either entry point
 * is loaded.
 */
describe('bin/m365-mcp dispatcher', () => {
  const { run, resolveMode, shouldDispatch } = require('../../bin/m365-mcp');

  function captureStderr() {
    const chunks = [];
    return { stderr: { write: (text) => chunks.push(text) }, text: () => chunks.join('') };
  }

  describe('resolveMode', () => {
    it('routes no argument to the MCP mode (default)', () => {
      expect(resolveMode([])).toBe('mcp');
    });

    it('routes the explicit mcp argument to the MCP mode', () => {
      expect(resolveMode(['mcp'])).toBe('mcp');
    });

    it('routes the auth argument to the auth mode', () => {
      expect(resolveMode(['auth'])).toBe('auth');
    });

    it('rejects unsupported arguments', () => {
      expect(resolveMode(['bogus'])).toBeNull();
      expect(resolveMode(['--help'])).toBeNull();
      expect(resolveMode(['mcp', 'auth'])).toBeNull();
    });
  });

  describe('shouldDispatch (SEA-safe direct-run gate)', () => {
    it('dispatches inside a SEA executable without evaluating require.main', () => {
      expect(
        shouldDispatch({
          isSea: () => true,
          isMainModule: () => {
            throw new Error('require.main must not be evaluated in a SEA executable');
          },
        })
      ).toBe(true);
    });

    it('dispatches on a source direct run (require.main === module)', () => {
      expect(shouldDispatch({ isSea: () => false, isMainModule: () => true })).toBe(true);
    });

    it('does not dispatch when the module is required by another module', () => {
      expect(shouldDispatch({ isSea: () => false, isMainModule: () => false })).toBe(false);
    });
  });

  describe('run', () => {
    it('starts the MCP entry point for the default and mcp modes', async () => {
      const startMCP = jest.fn(() => 0);
      const startAuth = jest.fn(() => 0);
      const setAuthLauncher = jest.fn();

      await expect(
        run([], { startMCP, startAuth, setAuthLauncher, loadRuntimeEnv: jest.fn() })
      ).resolves.toBe(0);
      await expect(
        run(['mcp'], { startMCP, startAuth, setAuthLauncher, loadRuntimeEnv: jest.fn() })
      ).resolves.toBe(0);
      expect(startMCP).toHaveBeenCalledTimes(2);
      expect(startAuth).not.toHaveBeenCalled();
    });

    it('starts the auth entry point for the auth mode', async () => {
      const startMCP = jest.fn(() => 0);
      const startAuth = jest.fn(() => 0);

      await expect(run(['auth'], { startMCP, startAuth, loadRuntimeEnv: jest.fn() })).resolves.toBe(
        0
      );
      expect(startAuth).toHaveBeenCalledTimes(1);
      expect(startMCP).not.toHaveBeenCalled();
    });

    it('awaits runtime environment configuration before either mode starts', async () => {
      const loadEnv = jest.fn();

      await run(['mcp'], {
        loadEnv,
        setAuthLauncher: jest.fn(),
        startMCP: () => 0,
        startAuth: () => 0,
      });
      await run(['auth'], { loadEnv, startMCP: () => 0, startAuth: () => 0 });

      expect(loadEnv).toHaveBeenCalledTimes(2);
    });

    it('does not load an entry point until async runtime bootstrap completes', async () => {
      const events = [];
      const loadRuntimeEnv = jest.fn(
        () =>
          new Promise((resolve) =>
            setImmediate(() => {
              events.push('bootstrap');
              resolve();
            })
          )
      );

      await run(['mcp'], {
        loadRuntimeEnv,
        setAuthLauncher: jest.fn(),
        startMCP: () => events.push('mcp'),
      });

      expect(events).toEqual(['bootstrap', 'mcp']);
    });

    it('points the auth-server manager at the same executable in packaged mcp mode', async () => {
      const setAuthLauncher = jest.fn();
      const execPath = 'C:/tools/outlook-mcp.exe';

      await run(['mcp'], {
        execPath,
        isPackagedExecutable: () => true,
        setAuthLauncher,
        loadRuntimeEnv: jest.fn(),
        startMCP: () => 0,
        startAuth: () => 0,
      });

      expect(setAuthLauncher).toHaveBeenCalledWith({ command: execPath, args: ['auth'] });
    });

    it('points source runs at the dispatcher auth mode as well', async () => {
      const setAuthLauncher = jest.fn();

      await run(['mcp'], {
        execPath: 'C:/Program Files/nodejs/node.exe',
        isPackagedExecutable: () => false,
        setAuthLauncher,
        loadRuntimeEnv: jest.fn(),
        startMCP: () => 0,
        startAuth: () => 0,
      });

      expect(setAuthLauncher).toHaveBeenCalledWith({
        command: process.execPath,
        args: [expect.stringMatching(/m365-mcp\.js$/), 'auth'],
      });
    });

    it('prints usage to stderr and exits 2 for an unsupported argument', async () => {
      const out = captureStderr();
      const startMCP = jest.fn();
      const startAuth = jest.fn();

      await expect(run(['bogus'], { ...out, startMCP, startAuth })).resolves.toBe(2);
      expect(out.text()).toContain('Usage');
      expect(out.text()).toContain('mcp');
      expect(out.text()).toContain('auth');
      expect(startMCP).not.toHaveBeenCalled();
      expect(startAuth).not.toHaveBeenCalled();
    });
  });
});
