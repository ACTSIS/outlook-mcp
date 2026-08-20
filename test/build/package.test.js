/**
 * Packaging tool tests (build/package.js).
 *
 * Threat-matrix contracts from the design:
 * - Documentation-like paths: only allowlisted executable inputs are bundled;
 *   a `README.sh` fixture must never enter output.
 * - Git repository selection: the repository root is resolved explicitly for
 *   relative, absolute, and `git -C`-style invocations; a wrong cwd fails
 *   closed.
 * Production code does not exist yet (RED).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('build/package', () => {
  let tempDir;
  let pkg;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm365-pkg-'));
    pkg = require('../../build/package');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    jest.resetModules();
  });

  describe('target selection', () => {
    it('resolves a single explicit target', () => {
      expect(pkg.resolveTargets('win-x64')).toEqual(['win-x64']);
      expect(pkg.resolveTargets('linux-x64')).toEqual(['linux-x64']);
    });

    it('resolves the all target to both platforms', () => {
      expect(pkg.resolveTargets('all')).toEqual(['win-x64', 'linux-x64']);
    });

    it('rejects unknown targets (fails closed)', () => {
      expect(pkg.resolveTargets('mac-arm64')).toBeNull();
      expect(pkg.resolveTargets(undefined)).toBeNull();
    });
  });

  describe('artifact naming', () => {
    it('names the combined Windows artifact with an .exe suffix', () => {
      expect(pkg.artifactNames('win-x64').combined).toEqual(['outlook-mcp-win-x64.exe']);
    });

    it('names the combined Linux artifact without a suffix', () => {
      expect(pkg.artifactNames('linux-x64').combined).toEqual(['outlook-mcp-linux-x64']);
    });

    it('provides per-mode fallback artifacts for each target', () => {
      expect(pkg.artifactNames('win-x64').fallback).toEqual([
        'outlook-mcp-win-x64-mcp.exe',
        'outlook-mcp-win-x64-auth.exe',
      ]);
      expect(pkg.artifactNames('linux-x64').fallback).toEqual([
        'outlook-mcp-linux-x64-mcp',
        'outlook-mcp-linux-x64-auth',
      ]);
    });
  });

  describe('allowlisted executable inputs (threat: documentation-like paths)', () => {
    it('never treats a documentation-like README.sh as an executable input', () => {
      expect(pkg.isAllowlistedEntry('README.sh')).toBe(false);
      expect(pkg.isAllowlistedEntry('docs/README.sh')).toBe(false);
    });

    it('accepts only the allowlisted entry files', () => {
      expect(pkg.isAllowlistedEntry('bin/m365-mcp.js')).toBe(true);
      expect(pkg.isAllowlistedEntry('index.js')).toBe(true);
      expect(pkg.isAllowlistedEntry('outlook-auth-server.js')).toBe(true);
    });

    it('rejects path traversal escapes and non-allowlisted executables', () => {
      expect(pkg.isAllowlistedEntry('../README.sh')).toBe(false);
      expect(pkg.isAllowlistedEntry('dist/../../secret')).toBe(false);
      expect(pkg.isAllowlistedEntry('node_modules/x/bin.js')).toBe(false);
    });

    it('resolves only allowlisted entry files that exist in the repository', () => {
      fs.mkdirSync(path.join(tempDir, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'bin', 'm365-mcp.js'), '// dispatcher\n');
      fs.writeFileSync(path.join(tempDir, 'index.js'), '// entry\n');
      fs.writeFileSync(path.join(tempDir, 'README.sh'), '#!/bin/sh\necho doc\n');

      expect(pkg.resolveEntryFiles(tempDir)).toEqual([
        path.join(tempDir, 'bin', 'm365-mcp.js'),
        path.join(tempDir, 'index.js'),
      ]);
    });

    it('filters outputs so documentation files never enter the dist allowlist', () => {
      const outputs = pkg.filterOutputEntries([
        'outlook-mcp-win-x64.exe',
        'README.sh',
        'readme.txt',
        'outlook-mcp-win-x64-auth.exe',
      ]);

      expect(outputs).toEqual(['outlook-mcp-win-x64.exe', 'outlook-mcp-win-x64-auth.exe']);
    });
  });

  describe('repository root resolution (threat: git repository selection)', () => {
    const repoRoot = process.cwd(); // jest runs from the repository root

    it('resolves an absolute repository path', () => {
      expect(pkg.resolveRepositoryRoot(repoRoot)).toBe(repoRoot);
    });

    it('resolves a relative path when the cwd is the repository', () => {
      expect(pkg.resolveRepositoryRoot('.')).toBe(repoRoot);
    });

    it('resolves a git -C style directory inside the repository', () => {
      expect(pkg.resolveRepositoryRoot(path.join(repoRoot, 'runtime'))).toBe(repoRoot);
    });

    it('fails closed when the directory is outside any repository', () => {
      const outside = path.join(tempDir, 'nowhere');
      fs.mkdirSync(outside, { recursive: true });
      expect(pkg.resolveRepositoryRoot(outside)).toBeNull();
    });
  });

  describe('CLI arguments', () => {
    it('parses --target win-x64', () => {
      expect(pkg.parseArgs(['--target', 'win-x64'])).toEqual({ target: 'win-x64' });
    });

    it('parses --target all', () => {
      expect(pkg.parseArgs(['--target', 'all'])).toEqual({ target: 'all' });
    });

    it('rejects a missing --target value', () => {
      expect(pkg.parseArgs(['--target'])).toBeNull();
    });

    it('rejects unknown flags', () => {
      expect(pkg.parseArgs(['--bogus', 'x'])).toBeNull();
    });
  });

  describe('atomic output staging', () => {
    it('stages into a temp directory and commits into dist/<target>/ only on success', () => {
      const outDir = path.join(tempDir, 'dist', 'win-x64');
      const staged = [];

      const result = pkg.commitOutput({
        target: 'win-x64',
        stagedDir: path.join(tempDir, '.staged'),
        distRoot: path.join(tempDir, 'dist'),
        artifactFiles: ['outlook-mcp-win-x64.exe'],
        copyFile: (src, dest) => {
          staged.push(dest);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, 'artifact-bytes');
        },
      });

      expect(result).toBe(true);
      expect(staged).toHaveLength(1);
      expect(fs.existsSync(path.join(outDir, 'outlook-mcp-win-x64.exe'))).toBe(true);
    });

    it('leaves dist/<target>/ untouched when an artifact copy fails', () => {
      const outDir = path.join(tempDir, 'dist', 'linux-x64');

      const result = pkg.commitOutput({
        target: 'linux-x64',
        stagedDir: path.join(tempDir, '.staged'),
        distRoot: path.join(tempDir, 'dist'),
        artifactFiles: ['outlook-mcp-linux-x64'],
        copyFile: () => {
          throw new Error('copy failed');
        },
      });

      expect(result).toBe(false);
      expect(fs.existsSync(outDir)).toBe(false);
    });
  });

  describe('main orchestration', () => {
    it('returns zero when every requested target completes', () => {
      const calls = [];
      const code = pkg.main(
        ['--target', 'all'],
        {
          repoRoot: tempDir,
          buildTarget: async (target, opts) => {
            calls.push(target);
            fs.mkdirSync(opts.stagedDir, { recursive: true });
            fs.writeFileSync(
              path.join(opts.stagedDir, pkg.artifactNames(target).combined[0]),
              'artifact-bytes'
            );
            await opts.stageArtifacts();
            return opts.commitArtifacts();
          },
          log: () => {},
        },
        { argv: [] }
      );

      return expect(Promise.resolve(code)).resolves.toBe(0);
    });

    it('returns non-zero and reports failure when a target is incomplete', () => {
      const calls = [];
      const logs = [];
      const code = pkg.main(
        ['--target', 'win-x64'],
        {
          repoRoot: tempDir,
          buildTarget: async (target, _opts) => {
            calls.push(target);
            return false;
          },
          log: (text) => logs.push(text),
        },
        { argv: [] }
      );

      return expect(Promise.resolve(code)).resolves.toBe(1);
    });
  });

  describe('executable writability before SEA injection (threat: read-only Node binary)', () => {
    it('makes a read-only copied executable writable for postject injection', () => {
      const file = path.join(tempDir, 'node-copy');
      fs.writeFileSync(file, 'binary-bytes');
      fs.chmodSync(file, 0o555); // read-only, as Linuxbrew Node binaries are

      pkg.ensureWritable(file);

      const mode = fs.statSync(file).mode & 0o777;
      expect(mode & 0o200).toBe(0o200); // owner write bit restored
      const fd = fs.openSync(file, 'r+'); // must not throw EACCES/EPERM
      fs.closeSync(fd);
    });

    it('restores standard executable permissions (0755) on POSIX', () => {
      if (process.platform === 'win32') return; // Windows has no exec bits
      const file = path.join(tempDir, 'node-copy');
      fs.writeFileSync(file, 'binary-bytes');
      fs.chmodSync(file, 0o444); // read-only, no execute bits

      pkg.ensureWritable(file);

      expect(fs.statSync(file).mode & 0o777).toBe(0o755);
    });
  });

  describe('SEA fuse-bearing Node binary resolution (threat: fuse-less Node build)', () => {
    const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

    it('detects the SEA fuse sentinel inside a binary file', () => {
      const withFuse = path.join(tempDir, 'node-with-fuse');
      fs.writeFileSync(withFuse, `#!/bin/node\n${FUSE}\ntrailing-bytes`);
      const withoutFuse = path.join(tempDir, 'node-without-fuse');
      fs.writeFileSync(withoutFuse, '#!/bin/node\nno sentinel here');

      expect(pkg.hasSeaFuse(withFuse)).toBe(true);
      expect(pkg.hasSeaFuse(withoutFuse)).toBe(false);
    });

    it('returns false for a missing or unreadable binary', () => {
      expect(pkg.hasSeaFuse(path.join(tempDir, 'does-not-exist'))).toBe(false);
    });

    it('resolves the first existing fuse-bearing candidate in order', () => {
      const fuseLess = path.join(tempDir, 'node-fuseless');
      fs.writeFileSync(fuseLess, 'no fuse');
      const withFuse = path.join(tempDir, 'node-fuse');
      fs.writeFileSync(withFuse, FUSE);

      expect(pkg.resolveSeaNodeBinary([path.join(tempDir, 'missing'), fuseLess, withFuse])).toBe(
        withFuse
      );
    });

    it('returns null when no candidate has the fuse (fails closed)', () => {
      const fuseLess = path.join(tempDir, 'node-fuseless');
      fs.writeFileSync(fuseLess, 'no fuse');

      expect(pkg.resolveSeaNodeBinary([fuseLess, path.join(tempDir, 'missing')])).toBeNull();
    });
  });

  describe('direct invocation (node build/package.js)', () => {
    const { spawnSync } = require('child_process');

    it('exits 2 for an unsupported target argument', () => {
      const result = spawnSync(
        process.execPath,
        [path.join(__dirname, '../../build/package.js'), '--target', 'bogus'],
        { encoding: 'utf8' }
      );

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('Usage');
    });

    it('exits non-zero for a target that requires a different native runner', () => {
      const result = spawnSync(
        process.execPath,
        [path.join(__dirname, '../../build/package.js'), '--target', 'linux-x64'],
        { encoding: 'utf8' }
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('native runner');
    });
  });
});
