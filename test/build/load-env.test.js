/**
 * External .env loading tests (runtime/load-env.js).
 *
 * Contract from design: external `.env` resolution for source and executable
 * locations; MCP-client environment variables override `.env` values; `.env`
 * is never packaged. Production code does not exist yet (RED).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('runtime/load-env', () => {
  let tempDir;
  let moduleUnderTest;

  function writeEnv(relativePath, content) {
    const fullPath = path.join(tempDir, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
    return fullPath;
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm365-load-env-'));
    moduleUnderTest = require('../../runtime/load-env');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('resolveEnvPath', () => {
    it('resolves the .env beside the executable when the executable is packaged', () => {
      const envPath = writeEnv('.env', 'PACKAGED_KEY=value\n');
      const resolved = moduleUnderTest.resolveEnvPath({
        execPath: path.join(tempDir, 'outlook-mcp.exe'),
        sourceDir: 'C:/Work/git/outlook-mcp/runtime',
      });

      expect(resolved).toBe(envPath);
    });

    it('falls back to the .env beside the source when the executable has none', () => {
      const envPath = writeEnv('runtime/.env', 'SOURCE_KEY=value\n');
      const resolved = moduleUnderTest.resolveEnvPath({
        execPath: 'C:/Program Files/nodejs/node.exe',
        sourceDir: path.join(tempDir, 'runtime'),
      });

      expect(resolved).toBe(envPath);
    });

    it('returns null when no .env exists beside executable or source', () => {
      expect(
        moduleUnderTest.resolveEnvPath({
          execPath: 'C:/Program Files/nodejs/node.exe',
          sourceDir: path.join(tempDir, 'empty'),
        })
      ).toBeNull();
    });
  });

  describe('loadEnv', () => {
    it('loads keys from the .env beside the executable into an empty environment', () => {
      const envPath = writeEnv('.env', 'PACKAGED_KEY=packaged-value\n');
      const env = {};
      const result = moduleUnderTest.loadEnv({
        env,
        envPath,
      });

      expect(result).toEqual({ path: envPath, loaded: 1 });
      expect(env.PACKAGED_KEY).toBe('packaged-value');
    });

    it('lets existing environment variables (MCP client) override the .env file', () => {
      const envPath = writeEnv('.env', 'OUTLOOK_CLIENT_ID=file-value\n');
      const env = { OUTLOOK_CLIENT_ID: 'client-value' };
      const result = moduleUnderTest.loadEnv({ env, envPath });

      expect(result).toEqual({ path: envPath, loaded: 0 });
      expect(env.OUTLOOK_CLIENT_ID).toBe('client-value');
    });

    it('loads multiple keys and returns the loaded count', () => {
      const envPath = writeEnv('.env', 'A=1\nB=2\nC=3\n');
      const result = moduleUnderTest.loadEnv({ env: {}, envPath });

      expect(result.loaded).toBe(3);
      expect(result.path).toBe(envPath);
    });

    it('is a no-op when no .env file exists', () => {
      expect(
        moduleUnderTest.loadEnv({ env: {}, envPath: path.join(tempDir, 'missing.env') })
      ).toBeNull();
    });
  });
});
