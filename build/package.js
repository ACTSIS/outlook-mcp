/**
 * Cross-platform packaging for the M365 MCP server.
 *
 * Strategy (from design): bundle the CommonJS graph with `@vercel/ncc` into a
 * single script, build a Node 22 SEA blob, copy the target platform's Node 22
 * executable, apply Windows VERSIONINFO metadata, and inject the blob with
 * `postject`.
 *
 * Contract:
 *   npm run package -- --target win-x64|linux-x64|all
 * writes `dist/<target>/` atomically; incomplete targets return non-zero.
 *
 * This module never reads, writes, or embeds credentials. It only bundles
 * allowlisted entry files and never packages `.env` content.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ALLOWED_TARGETS = ['win-x64', 'linux-x64'];

// Only these repository files may be bundled into an artifact. Documentation
// files (for example README.sh) are never executable inputs.
const ALLOWED_ENTRIES = ['bin/m365-mcp.js', 'index.js', 'outlook-auth-server.js'];

const TARGET_DEFS = {
  'win-x64': { exeSuffix: '.exe' },
  'linux-x64': { exeSuffix: '' },
};

const WINDOWS_VERSION_COMPONENT_MAX = 65535;

/**
 * Resolve the requested targets from the CLI value.
 * @param {string|undefined} target - 'win-x64', 'linux-x64', or 'all'
 * @returns {string[]|null} Target list, or null when the value is unsupported
 */
function resolveTargets(target) {
  if (target === 'all') return [...ALLOWED_TARGETS];
  if (ALLOWED_TARGETS.includes(target)) return [target];
  return null;
}

/**
 * Artifact names for a target, following the design contract.
 * @param {string} target - 'win-x64' or 'linux-x64'
 * @returns {{ combined: string[], fallback: string[] }}
 */
function artifactNames(target) {
  const suffix = TARGET_DEFS[target].exeSuffix;
  const combined = [`outlook-mcp-${target}${suffix}`];
  const fallback = [`outlook-mcp-${target}-mcp${suffix}`, `outlook-mcp-${target}-auth${suffix}`];
  return { combined, fallback };
}

/**
 * Normalize a package version into the four numeric components accepted by
 * Windows VERSIONINFO resources.
 * @param {unknown} packageVersion - The version from package.json
 * @returns {string} Numeric Windows version such as `2.2.3.0`
 * @throws {Error} When the version cannot be represented safely
 */
function normalizeWindowsVersion(packageVersion) {
  const match =
    typeof packageVersion === 'string' &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(packageVersion);
  if (!match) {
    throw new Error(
      '[package] package.json version must use numeric major.minor.patch form for Windows metadata'
    );
  }

  const components = match.slice(1).map(Number);
  if (
    components.some(
      (component) => !Number.isSafeInteger(component) || component > WINDOWS_VERSION_COMPONENT_MAX
    )
  ) {
    throw new Error(
      '[package] package.json version cannot be represented as a Windows file version; each component must be between 0 and 65535'
    );
  }

  return `${components.join('.')}.0`;
}

/**
 * Read the package version used to identify generated artifacts.
 * @param {string} repoRoot - Absolute repository root
 * @returns {string} The package.json version
 */
function readPackageVersion(repoRoot) {
  const packagePath = path.join(repoRoot, 'package.json');
  let packageJson;
  try {
    packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  } catch {
    throw new Error('[package] unable to read package.json version for Windows metadata');
  }

  if (!packageJson || typeof packageJson.version !== 'string') {
    throw new Error('[package] package.json must contain a version for Windows metadata');
  }
  return packageJson.version;
}

/**
 * Build the Windows resource metadata for a generated executable.
 * @param {string} packageVersion - The version from package.json
 * @param {string} artifactName - The generated executable basename
 * @returns {object} rcedit options
 */
function buildWindowsMetadata(packageVersion, artifactName) {
  const windowsVersion = normalizeWindowsVersion(packageVersion);
  return {
    'file-version': windowsVersion,
    'product-version': windowsVersion,
    'version-string': {
      CompanyName: 'ACTSIS',
      FileDescription: 'M365 Assistant MCP Server',
      InternalName: artifactName,
      OriginalFilename: artifactName,
      ProductName: 'M365 Assistant MCP Server',
      FileVersion: windowsVersion,
      ProductVersion: windowsVersion,
    },
  };
}

/**
 * Apply Windows VERSIONINFO resources through the Electron-maintained rcedit
 * package. The import remains lazy so non-Windows targets never load it.
 * @param {string} exePath - Executable to update
 * @param {object} metadata - rcedit options
 * @param {Function|undefined} rceditImpl - Injectable editor for tests
 * @returns {Promise<void>}
 */
async function applyWindowsMetadata(exePath, metadata, rceditImpl) {
  const editResources = rceditImpl || (await import('rcedit')).rcedit;
  await editResources(exePath, metadata);
}

/**
 * True when a repository-relative path is an allowlisted executable entry.
 * Documentation-like files (README.sh and friends) are always rejected.
 * @param {string} relativePath - Forward-slash repository-relative path
 * @returns {boolean}
 */
function isAllowlistedEntry(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/');
  if (normalized.includes('../')) return false;
  return ALLOWED_ENTRIES.includes(normalized);
}

/**
 * Allowlisted entry files that actually exist in the repository.
 * @param {string} repoRoot - Absolute repository root
 * @returns {string[]} Existing allowlisted entry paths
 */
function resolveEntryFiles(repoRoot) {
  return ALLOWED_ENTRIES.filter((entry) => fs.existsSync(path.join(repoRoot, entry))).map((entry) =>
    path.join(repoRoot, entry)
  );
}

/**
 * Remove documentation-like files from a dist output listing so only
 * executable artifacts remain.
 * @param {string[]} entries - File names found in a dist directory
 * @returns {string[]} Entries that are not documentation-like
 */
function filterOutputEntries(entries) {
  const documentationLike = /\.(md|txt|sh|bat|ps1|html?)$/i;
  return entries.filter((entry) => !documentationLike.test(entry));
}

/**
 * Resolve the repository root for the given directory. Walks up the tree
 * looking for a `.git` marker, supporting relative, absolute, and
 * `git -C <dir>`-style invocations. Fails closed (null) outside a repository.
 * @param {string} dir - Starting directory
 * @returns {string|null} Absolute repository root, or null when not found
 */
function resolveRepositoryRoot(dir) {
  const start = path.resolve(dir);
  let current = start;
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Parse CLI arguments for the package operation.
 * @param {string[]} args - Arguments after the script name
 * @returns {{ target: string }|null} Parsed options, or null when invalid
 */
function parseArgs(args) {
  if (args.length !== 2) return null;
  const [flag, value] = args;
  if (flag !== '--target' || !value) return null;
  return { target: value };
}

/**
 * Default build implementation: ncc bundle + Node 22 SEA blob + postject.
 * Runs on the native platform for its matching target; cross-target builds
 * fail closed with a clear message (integration phase runs native matrices).
 * @param {string} target - 'win-x64' or 'linux-x64'
 * @param {object} context - Build paths, callbacks, and optional test dependencies
 * @returns {Promise<boolean>} True when artifacts were staged and committed
 */
async function buildTarget(target, context) {
  const { repoRoot, stagedDir, log, stageArtifacts, commitArtifacts } = context;
  log(`[package] building ${target}`);

  const platform = context.platform || process.platform;
  const platformMatch = target === 'win-x64' ? platform === 'win32' : platform === 'linux';
  if (!platformMatch) {
    log(`[package] ${target} requires its native runner; aborting`);
    return false;
  }

  const ncc = context.ncc || require('@vercel/ncc');
  const execFileSync = context.execFileSync || require('child_process').execFileSync;

  const entries = resolveEntryFiles(repoRoot);
  if (entries.length === 0) {
    log('[package] no allowlisted entry files found; aborting');
    return false;
  }

  const bundleName = 'index.bundle.js';
  const blobName = 'sea.blob';
  const seaConfig = path.join(stagedDir, 'sea-config.json');
  const nodeBin =
    context.nodeBin ||
    resolveSeaNodeBinary([process.execPath, process.env.M365_SEA_NODE_BIN].filter(Boolean)) ||
    null;
  if (!nodeBin) {
    log(
      '[package] no fuse-bearing Node executable found; set M365_SEA_NODE_BIN to a Node 22+ binary that contains the SEA fuse sentinel'
    );
    return false;
  }
  const combinedName = `outlook-mcp-${target}${TARGET_DEFS[target].exeSuffix}`;

  fs.mkdirSync(stagedDir, { recursive: true });

  // 1. Bundle the entry graph with ncc into one script (SEA-safe output).
  const { code } = await ncc(entries[0], { minify: false, sourceMap: false });
  fs.writeFileSync(path.join(stagedDir, bundleName), code);

  // 2. Build the SEA configuration and generate the injected blob.
  fs.writeFileSync(
    seaConfig,
    JSON.stringify({ main: bundleName, output: blobName, disableExperimentalSEAWarning: true })
  );
  execFileSync(nodeBin, ['--experimental-sea-config', seaConfig], {
    cwd: stagedDir,
    stdio: 'inherit',
  });

  // 3. Copy the platform Node executable and make the copy writable.
  const outPath = path.join(stagedDir, combinedName);
  const copyFile = context.copyFileSync || fs.copyFileSync;
  const makeWritable = context.ensureWritable || ensureWritable;
  copyFile(nodeBin, outPath);
  makeWritable(outPath);

  // 4. Replace Node's inherited VERSIONINFO before postject changes the PE.
  if (target === 'win-x64') {
    try {
      const metadata = buildWindowsMetadata(readPackageVersion(repoRoot), path.basename(outPath));
      const applyMetadata =
        context.applyWindowsMetadata ||
        ((file, options) => applyWindowsMetadata(file, options, context.rcedit));
      await applyMetadata(outPath, metadata);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown resource-editing error';
      log(`[package] Windows metadata update failed; target was not published: ${message}`);
      return false;
    }
  }

  // 5. Inject the blob after the copied executable has its final metadata.
  const postject = context.postject || require('postject');
  await postject.inject(outPath, 'NODE_SEA_BLOB', fs.readFileSync(path.join(stagedDir, blobName)), {
    machoSegmentName: 'NODE_SEA',
    sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  });

  // 6. Stage and commit; never expose an incomplete target.
  await stageArtifacts();
  return commitArtifacts();
}

/**
 * Make a copied executable writable so postject can inject the SEA blob.
 * `fs.copyFileSync` preserves the source Node binary's mode bits; Linuxbrew
 * and distro Node binaries are read-only (0555), which makes postject fail
 * with EACCES. Restore the owner write bit (and standard 0755 on POSIX).
 * @param {string} file - Absolute path to the copied executable
 */
function ensureWritable(file) {
  if (process.platform === 'win32') {
    // Windows maps POSIX mode bits to the read-only attribute; any write bit
    // clears it so postject can open the copy read-write.
    fs.chmodSync(file, 0o666);
    return;
  }
  fs.chmodSync(file, 0o755);
}

const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

/**
 * True when a binary file contains the Node SEA fuse sentinel, meaning
 * postject can inject a blob into it. Some Node distributions (for example
 * Linuxbrew builds) ship without the fuse; those binaries cannot host a SEA
 * blob and must be rejected.
 * @param {string} file - Absolute path to a candidate Node executable
 * @returns {boolean}
 */
function hasSeaFuse(file) {
  try {
    const bytes = fs.readFileSync(file);
    return bytes.includes(Buffer.from(SEA_FUSE, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Resolve the first existing, fuse-bearing Node executable from a candidate
 * list. Fails closed (null) when no candidate can host a SEA blob.
 * @param {string[]} candidates - Absolute paths to candidate Node executables
 * @returns {string|null}
 */
function resolveSeaNodeBinary(candidates) {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && hasSeaFuse(candidate)) return candidate;
  }
  return null;
}

/**
 * Orchestrate the package operation end to end.
 * @param {string[]} args - CLI arguments (defaults to process.argv.slice(2))
 * @param {object} deps - Overridable dependencies (for tests)
 * @param {Function} deps.buildTarget - Per-target build implementation
 * @param {Function} deps.log - Log sink
 * @param {string} deps.repoRoot - Repository root (defaults to cwd resolution)
 * @returns {Promise<number>} 0 when every target completed, non-zero otherwise
 */
async function main(args = process.argv.slice(2), deps = {}) {
  const log = deps.log || ((text) => console.error(text));
  const options = parseArgs(args);
  if (!options) {
    log('Usage: node build/package.js --target win-x64|linux-x64|all');
    return 2;
  }

  const repoRoot = deps.repoRoot || resolveRepositoryRoot(process.cwd());
  if (!repoRoot) {
    log('[package] not inside a git repository; aborting');
    return 1;
  }

  const targets = resolveTargets(options.target);
  if (!targets) {
    log(`[package] unsupported target "${options.target}"`);
    log('Usage: node build/package.js --target win-x64|linux-x64|all');
    return 2;
  }

  let complete = true;
  for (const target of targets) {
    const stagedDir = fs.mkdtempSync(path.join(os.tmpdir(), `m365-pkg-${target}-`));
    const artifactFiles = artifactNames(target).combined;
    const context = {
      repoRoot,
      stagedDir,
      log,
      stageArtifacts: async () => {
        for (const file of artifactFiles) {
          if (!fs.existsSync(path.join(stagedDir, file))) return false;
        }
        return true;
      },
      commitArtifacts: () =>
        commitOutput({
          target,
          stagedDir,
          distRoot: path.join(repoRoot, 'dist'),
          artifactFiles,
        }),
    };
    const doBuild = deps.buildTarget || buildTarget;
    const ok = await doBuild(target, context);
    if (!ok) complete = false;
    fs.rmSync(stagedDir, { recursive: true, force: true });
  }

  if (!complete) {
    log('[package] one or more targets failed; no incomplete output is claimed');
    return 1;
  }
  return 0;
}

/**
 * Commit staged artifact files into `dist/<target>/`. The directory is only
 * created when every copy succeeds, keeping the output atomic: an incomplete
 * target never appears as usable.
 * @param {object} options
 * @param {string} options.target - 'win-x64' or 'linux-x64'
 * @param {string} options.stagedDir - Directory holding staged artifacts
 * @param {string} options.distRoot - Directory holding per-target outputs
 * @param {string[]} options.artifactFiles - File names to commit
 * @param {Function} options.copyFile - Copy implementation (overridable)
 * @returns {boolean} True when the full artifact set was committed
 */
function commitOutput({ target, stagedDir, distRoot, artifactFiles, copyFile }) {
  const outDir = path.join(distRoot, target);
  const doCopy = copyFile || fs.copyFileSync;
  const outDirExisted = fs.existsSync(outDir);
  const committed = [];

  try {
    for (const file of artifactFiles) {
      const dest = path.join(outDir, file);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      doCopy(path.join(stagedDir, file), dest);
      committed.push(dest);
    }
    return true;
  } catch {
    // Remove any partially committed files; when this commit created the
    // output directory, remove it too so an incomplete target never appears.
    for (const file of committed) {
      try {
        fs.unlinkSync(file);
      } catch {
        // Best effort: the file may not exist.
      }
    }
    if (!outDirExisted) {
      try {
        fs.rmdirSync(outDir);
      } catch {
        // Best effort: the directory may not be empty or may not exist.
      }
    }
    return false;
  }
}

// Retain direct-run behavior: orchestrate the package operation when invoked
// as a script (for example `node build/package.js --target win-x64`).
if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(`[package] failed: ${err.message}`);
      process.exitCode = 1;
    });
}

module.exports = {
  resolveTargets,
  artifactNames,
  isAllowlistedEntry,
  resolveEntryFiles,
  filterOutputEntries,
  resolveRepositoryRoot,
  parseArgs,
  commitOutput,
  ensureWritable,
  hasSeaFuse,
  resolveSeaNodeBinary,
  normalizeWindowsVersion,
  readPackageVersion,
  buildWindowsMetadata,
  applyWindowsMetadata,
  main,
  buildTarget,
};
