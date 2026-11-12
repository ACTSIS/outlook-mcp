/**
 * GitHub Releases latest-stable.json manifest generator tests
 * (build/release-manifest.js).
 *
 * Contracts from the S14 migration:
 * - Deterministic output for fixed inputs with the unchanged public schema
 *   { version, date, notesUrl, assets: [{ name, url, sha256 }] }.
 * - GitHub Releases URLs derived from an explicitly supplied repository; no
 *   artifact-server configuration exists anymore.
 * - Fail-closed validation: v-prefixed or malformed versions, missing
 *   checksums, malformed checksum lines, missing or malformed repositories,
 *   traversal-sensitive asset names, and missing input fields all throw
 *   clearly without writing any state.
 * - CLI behavior: the manifest JSON prints to stdout (empty stderr) with
 *   exit 0, missing arguments print usage with exit 2, unknown arguments
 *   exit 2, and a missing target repository exits 1 with guidance instead
 *   of guessing a remote.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MODULE_PATH = require.resolve('../../build/release-manifest');

describe('build/release-manifest', () => {
  let manifest;

  beforeEach(() => {
    jest.resetModules();
    manifest = require(MODULE_PATH);
  });

  function makeInput(overrides = {}) {
    return {
      version: '2.3.2',
      date: '<DATE_TIME>',
      notesUrl: 'https://github.com/ACTSIS/outlook-mcp/releases/tag/v2.3.2',
      repository: 'ACTSIS/outlook-mcp',
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
        date: '<DATE_TIME>',
        notesUrl: 'https://github.com/ACTSIS/outlook-mcp/releases/tag/v2.3.2',
        assets: expect.any(Array),
      });
      expect(Object.keys(parsed)).toEqual(['version', 'date', 'notesUrl', 'assets']);
      expect(output).toMatch(/}\n$/);
    });

    it('builds per-asset URLs under the repository releases/download path', () => {
      const output = manifest.buildManifest(makeInput({ version: '2.4.0' }));
      const { assets } = JSON.parse(output);

      expect(assets).toHaveLength(4);
      expect(assets[0]).toEqual({
        name: 'outlook-mcp-setup.exe',
        url: 'https://github.com/ACTSIS/outlook-mcp/releases/download/v2.4.0/outlook-mcp-setup.exe',
        sha256: 'a'.repeat(64),
      });
    });

    it('maps every asset entry to its GitHub Releases download URL', () => {
      const { assets } = JSON.parse(manifest.buildManifest(makeInput({ version: '2.4.4' })));

      expect(assets.map((a) => a.url)).toEqual(
        [
          'outlook-mcp-setup.exe',
          'outlook-mcp_2.3.2_amd64.deb',
          'outlook-mcp-win-x64.exe',
          'outlook-mcp-linux-x64',
        ].map((name) => `https://github.com/ACTSIS/outlook-mcp/releases/download/v2.4.4/${name}`)
      );
    });

    it('resolves checksums from the SHA256SUMS two-space format', () => {
      const output = manifest.buildManifest(makeInput());
      const { assets } = JSON.parse(output);

      expect(assets.map((a) => a.sha256)).toEqual(['a', 'b', 'c', 'd'].map((c) => c.repeat(64)));
    });

    it('throws when the version includes a v prefix', () => {
      expect(() => manifest.buildManifest(makeInput({ version: 'v2.3.2' }))).toThrow(/v prefix/);
    });

    it('throws when the version is malformed', () => {
      expect(() => manifest.buildManifest(makeInput({ version: '2.3' }))).toThrow(/malformed/);
      expect(() => manifest.buildManifest(makeInput({ version: '2.3.x' }))).toThrow(/malformed/);
      expect(() => manifest.buildManifest(makeInput({ version: '2 3.2.0' }))).toThrow(/malformed/);
    });

    it('throws on traversal-sensitive asset names', () => {
      for (const name of ['../evil.sh', 'sub/dir.exe', 'back\\slash.exe', '']) {
        expect(() => manifest.buildManifest(makeInput({ assets: [name] }))).toThrow(
          /unsafe asset name/
        );
      }
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
      expect(() => manifest.buildManifest(makeInput({ repository: undefined }))).toThrow(
        /repository/
      );
    });

    it('throws when the repository is malformed', () => {
      for (const repository of ['no-slash', 'a//b', 'a/b/c', 'owner/..', 'a b/owner', 'owner/']) {
        expect(() => manifest.buildManifest(makeInput({ repository }))).toThrow(
          /malformed repository/
        );
      }
    });

    it('accepts no artifact-server configuration anymore', () => {
      const input = makeInput();
      delete input.repository;
      input.proget = {
        baseUrl: 'https://artifacts.actsis.com',
        assetDirectory: 'ad',
        targetPrefix: 'tp',
      };
      expect(() => manifest.buildManifest(input)).toThrow(/repository/);
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
    it('composes the GitHub Releases download URL from the repository', () => {
      expect(manifest.assetUrl('ACTSIS/outlook-mcp', '1.0.0', 'f.exe')).toBe(
        'https://github.com/ACTSIS/outlook-mcp/releases/download/v1.0.0/f.exe'
      );
    });
  });

  describe('parseArgs', () => {
    it('recognizes the repository flag', () => {
      expect(
        manifest.parseArgs([
          '--version',
          '2.3.2',
          '--date',
          '<DATE_TIME>',
          '--assets',
          'a.exe,b.bin',
          '--repository',
          'ACTSIS/outlook-mcp',
        ])
      ).toEqual({
        version: '2.3.2',
        date: '<DATE_TIME>',
        assets: 'a.exe,b.bin',
        repository: 'ACTSIS/outlook-mcp',
      });
    });

    it('throws on unknown arguments', () => {
      expect(() => manifest.parseArgs(['--unknown', 'x'])).toThrow(/unknown argument/);
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
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  outlook-mcp-setup.exe\n' +
          'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  outlook-mcp-linux-x64\n'
      );
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('prints the same JSON as buildManifest when GITHUB_REPOSITORY is set', () => {
      const result = spawnSync(
        process.execPath,
        [
          MODULE_PATH,
          '--version',
          '2.3.2',
          '--date',
          '<DATE_TIME>',
          '--assets',
          'outlook-mcp-setup.exe,outlook-mcp-linux-x64',
        ],
        {
          encoding: 'utf8',
          input: fs.readFileSync(sha256sumsPath),
          env: { ...process.env, GITHUB_REPOSITORY: 'ACTSIS/outlook-mcp' },
        }
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      const expected = manifest.buildManifest({
        version: '2.3.2',
        date: '<DATE_TIME>',
        notesUrl: 'https://github.com/ACTSIS/outlook-mcp/releases/tag/v2.3.2',
        repository: 'ACTSIS/outlook-mcp',
        sha256sumsContent: fs.readFileSync(sha256sumsPath, 'utf8'),
        assets: ['outlook-mcp-setup.exe', 'outlook-mcp-linux-x64'],
      });
      expect(result.stdout).toBe(expected);
    });

    it('accepts an explicit --repository when no environment variable is set', () => {
      const result = spawnSync(
        process.execPath,
        [
          MODULE_PATH,
          '--version',
          '2.3.2',
          '--date',
          '<DATE_TIME>',
          '--assets',
          'outlook-mcp-setup.exe,outlook-mcp-linux-x64',
          '--repository',
          'ACTSIS/outlook-mcp',
        ],
        {
          encoding: 'utf8',
          input: fs.readFileSync(sha256sumsPath),
          env: { ...process.env, GITHUB_REPOSITORY: '' },
        }
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout).assets[0].url).toBe(
        'https://github.com/ACTSIS/outlook-mcp/releases/download/v2.3.2/outlook-mcp-setup.exe'
      );
    });

    it('fails closed with exit 1 when no repository is supplied', () => {
      const result = spawnSync(
        process.execPath,
        [MODULE_PATH, '--version', '2.3.2', '--date', '<DATE_TIME>', '--assets', 'a.exe'],
        {
          encoding: 'utf8',
          input: 'unused\n',
          env: { ...process.env, GITHUB_REPOSITORY: '' },
        }
      );

      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/--repository|GITHUB_REPOSITORY/);
    });

    it('prints usage with exit 2 when required arguments are missing', () => {
      const result = spawnSync(process.execPath, [MODULE_PATH], {
        encoding: 'utf8',
        env: { ...process.env },
      });

      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/Usage:/);
      expect(result.stderr).toMatch(/--repository/);
    });

    it('exits 2 on an unknown argument', () => {
      const result = spawnSync(process.execPath, [MODULE_PATH, '--nope', 'x'], {
        encoding: 'utf8',
        env: { ...process.env },
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/unknown argument/);
    });
  });
});
