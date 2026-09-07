/**
 * ProGet latest-stable.json manifest generator tests (build/proget-manifest.js).
 *
 * Contracts from the design:
 * - Deterministic output for fixed inputs with stable key order.
 * - URLs under outlook-mcp/<version>/ and checksums from SHA256SUMS.
 * - Fail-closed validation: v-prefixed versions, missing checksums, malformed
 *   checksum lines, and missing input fields all throw clearly.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MODULE_PATH = require.resolve('../../build/proget-manifest');

describe('build/proget-manifest', () => {
  let manifest;

  beforeEach(() => {
    jest.resetModules();
    manifest = require(MODULE_PATH);
  });

  function makeInput(overrides = {}) {
    return {
      version: '2.3.2',
      date: '2025-06-01T00:00:00Z',
      notesUrl: 'https://github.com/ACTSIS/outlook-mcp/releases/tag/v2.3.2',
      sha256sumsContent:
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  outlook-mcp-setup.exe\n' +
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  outlook-mcp_2.3.2_amd64.deb\n' +
        'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc  outlook-mcp-win-x64.exe\n' +
        'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd  outlook-mcp-linux-x64\n',
      assets: [
        'outlook-mcp-setup.exe',
        'outlook-mcp_2.3.2_amd64.deb',
        'outlook-mcp-win-x64.exe',
        'outlook-mcp-linux-x64',
      ],
      proget: {
        baseUrl: 'https://artifacts.actsis.com',
        assetDirectory: 'actsis-ai-policy',
        targetPrefix: 'outlook-mcp',
      },
      ...overrides,
    };
  }

  describe('buildManifest', () => {
    it('produces deterministic output for fixed inputs', () => {
      const input = makeInput();
      const first = manifest.buildManifest(input);
      const second = manifest.buildManifest(input);
      expect(second).toBe(first);
    });

    it('returns the expected manifest shape and stable key order', () => {
      const output = manifest.buildManifest(makeInput());
      const parsed = JSON.parse(output);

      expect(parsed).toEqual({
        version: '2.3.2',
        date: '2025-06-01T00:00:00Z',
        notesUrl: 'https://github.com/ACTSIS/outlook-mcp/releases/tag/v2.3.2',
        assets: expect.any(Array),
      });
      expect(Object.keys(parsed)).toEqual(['version', 'date', 'notesUrl', 'assets']);
      expect(output).toMatch(/}\n$/);
    });

    it('builds per-asset URLs under outlook-mcp/<version>/', () => {
      const output = manifest.buildManifest(makeInput({ version: '2.4.0' }));
      const { assets } = JSON.parse(output);

      expect(assets).toHaveLength(4);
      expect(assets[0]).toEqual({
        name: 'outlook-mcp-setup.exe',
        url: 'https://artifacts.actsis.com/endpoints/actsis-ai-policy/content/outlook-mcp/2.4.0/outlook-mcp-setup.exe',
        sha256: 'a'.repeat(64),
      });
    });

    it('resolves checksums from the SHA256SUMS two-space format', () => {
      const output = manifest.buildManifest(makeInput());
      const { assets } = JSON.parse(output);

      expect(assets.map((a) => a.sha256)).toEqual(['a', 'b', 'c', 'd'].map((c) => c.repeat(64)));
    });

    it('throws when the version includes a v prefix', () => {
      expect(() => manifest.buildManifest(makeInput({ version: 'v2.3.2' }))).toThrow(/v prefix/);
    });

    it('throws when an asset is missing from SHA256SUMS', () => {
      const input = makeInput({ assets: ['outlook-mcp-setup.exe', 'missing.exe'] });
      expect(() => manifest.buildManifest(input)).toThrow(/missing checksum.*missing\.exe/);
    });

    it('throws when a checksum line is malformed', () => {
      const input = makeInput({
        sha256sumsContent: 'not-a-hash  outlook-mcp-setup.exe\n',
      });
      expect(() => manifest.buildManifest(input)).toThrow(/malformed/);
    });

    it('throws when required input fields are missing', () => {
      expect(() => manifest.buildManifest(makeInput({ version: undefined }))).toThrow(/version/);
      expect(() => manifest.buildManifest(makeInput({ date: undefined }))).toThrow(/date/);
      expect(() => manifest.buildManifest(makeInput({ notesUrl: undefined }))).toThrow(/notesUrl/);
      expect(() => manifest.buildManifest(makeInput({ sha256sumsContent: undefined }))).toThrow(
        /sha256sumsContent/
      );
      expect(() => manifest.buildManifest(makeInput({ assets: undefined }))).toThrow(/assets/);
      expect(() => manifest.buildManifest(makeInput({ proget: undefined }))).toThrow(/proget/);
    });
  });

  describe('parseSha256sums', () => {
    it('parses valid two-space checksum lines and ignores blank lines', () => {
      const map = manifest.parseSha256sums(
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  file-a\n\n' +
          'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  file-b\n'
      );

      expect(Array.from(map.entries())).toEqual([
        ['file-a', 'a'.repeat(64)],
        ['file-b', 'b'.repeat(64)],
      ]);
    });

    it('throws on a malformed checksum line', () => {
      expect(() => manifest.parseSha256sums('short  file\n')).toThrow(/malformed/);
      expect(() => manifest.parseSha256sums('gg  file\n')).toThrow(/malformed/);
    });
  });

  describe('assetUrl', () => {
    it('composes the ProGet asset URL for a versioned file', () => {
      expect(
        manifest.assetUrl(
          { baseUrl: 'https://a.com', assetDirectory: 'ad', targetPrefix: 'tp' },
          '1.0.0',
          'f.exe'
        )
      ).toBe('https://a.com/endpoints/ad/content/tp/1.0.0/f.exe');
    });
  });

  describe('CLI round-trip', () => {
    let tempDir;
    let sha256sumsPath;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm365-manifest-'));
      sha256sumsPath = path.join(tempDir, 'SHA256SUMS');
      fs.writeFileSync(
        sha256sumsPath,
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  outlook-mcp-win-x64.exe\n' +
          'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  outlook-mcp-linux-x64\n'
      );
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('prints the same JSON as buildManifest for matching CLI args', () => {
      const result = spawnSync(
        process.execPath,
        [
          MODULE_PATH,
          '--version',
          '2.3.2',
          '--date',
          '2025-06-01T00:00:00Z',
          '--assets',
          'outlook-mcp-win-x64.exe,outlook-mcp-linux-x64',
        ],
        {
          encoding: 'utf8',
          input: fs.readFileSync(sha256sumsPath),
          env: {
            ...process.env,
            PROGET_BASE_URL: 'https://artifacts.actsis.com',
            PROGET_ASSET_DIRECTORY: 'actsis-ai-policy',
            PROGET_TARGET_PREFIX: 'outlook-mcp',
          },
        }
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      const expected = manifest.buildManifest({
        version: '2.3.2',
        date: '2025-06-01T00:00:00Z',
        notesUrl: 'https://github.com/ACTSIS/outlook-mcp/releases/tag/v2.3.2',
        sha256sumsContent: fs.readFileSync(sha256sumsPath, 'utf8'),
        assets: ['outlook-mcp-win-x64.exe', 'outlook-mcp-linux-x64'],
        proget: {
          baseUrl: 'https://artifacts.actsis.com',
          assetDirectory: 'actsis-ai-policy',
          targetPrefix: 'outlook-mcp',
        },
      });
      expect(result.stdout).toBe(expected);
    });
  });
});
