/**
 * GitHub Releases latest-stable.json manifest generator.
 *
 * Builds a deterministic, unit-testable manifest for the repository's GitHub
 * Releases channel. The pure function is the test surface and takes the
 * target repository (for example `ACTSIS/outlook-mcp`) instead of any
 * artifact-server configuration; the CLI entry reads the SHA256SUMS file
 * from stdin and prints JSON to stdout.
 */

/**
 * Parse the SHA256SUMS "<hash>  <filename>" format into a filename-to-hash map.
 * @param {string} content - SHA256SUMS file contents
 * @returns {Map<string, string>} Map from asset name to lowercase hex SHA-256
 * @throws {Error} When a non-empty line does not match the expected format
 */
function parseSha256sums(content) {
  const map = new Map();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const match = /^([a-f0-9]{64}) {2}(\S.*)$/.exec(line);
    if (!match) {
      throw new Error(`[release-manifest] malformed SHA256SUMS line: ${line}`);
    }
    map.set(match[2], match[1]);
  }
  return map;
}

/**
 * Compose the GitHub Releases download URL for a versioned asset.
 * @param {string} repository - Target repository as "owner/repo"
 * @param {string} version - Version without the v prefix
 * @param {string} name - Asset file name
 * @returns {string} Resolvable asset URL
 */
function assetUrl(repository, version, name) {
  return `https://github.com/${repository}/releases/download/v${version}/${name}`;
}

/**
 * Validate an owner/repo repository identifier.
 * @param {string} repository - Candidate repository
 * @throws {Error} When the repository is missing or malformed
 */
function validateRepository(repository) {
  if (typeof repository !== 'string' || !repository) {
    throw new Error('[release-manifest] repository is required');
  }
  const segments = repository.split('/');
  const validRepositorySegment = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  if (
    segments.length !== 2 ||
    !segments.every((segment) => validRepositorySegment.test(segment)) ||
    segments.some((segment) => segment === '.' || segment === '..')
  ) {
    throw new Error(`[release-manifest] malformed repository: ${repository}`);
  }
}

/**
 * Validate a version string without the v prefix.
 * @param {string} version - Candidate version
 * @throws {Error} When the version is missing, v-prefixed, or malformed
 */
function validateVersion(version) {
  if (typeof version !== 'string' || !version) {
    throw new Error('[release-manifest] version is required');
  }
  if (version.startsWith('v')) {
    throw new Error('[release-manifest] version must not include the v prefix');
  }
  if (!/^[0-9]+\.[0-9]+\.[0-9]+[-+A-Za-z0-9.]*$/.test(version)) {
    throw new Error(`[release-manifest] malformed version: ${version}`);
  }
}

/**
 * Reject asset names that could escape the release download path.
 * @param {string} name - Asset file name
 * @throws {Error} When the name is traversal-sensitive or empty
 */
function validateAssetName(name) {
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error(`[release-manifest] unsafe asset name: ${name}`);
  }
}

/**
 * Validate that all required manifest inputs are present and well formed.
 * @param {object} input
 * @throws {Error} For any missing or malformed required field
 */
function validateInput(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('[release-manifest] input is required');
  }
  validateVersion(input.version);
  if (typeof input.date !== 'string' || !input.date) {
    throw new Error('[release-manifest] date is required');
  }
  if (typeof input.notesUrl !== 'string' || !input.notesUrl) {
    throw new Error('[release-manifest] notesUrl is required');
  }
  if (typeof input.sha256sumsContent !== 'string' || !input.sha256sumsContent) {
    throw new Error('[release-manifest] sha256sumsContent is required');
  }
  if (!Array.isArray(input.assets) || input.assets.length === 0) {
    throw new Error('[release-manifest] assets array is required');
  }
  validateRepository(input.repository);
}

/**
 * Build the latest-stable.json manifest content.
 * @param {object} input
 * @param {string} input.version - e.g. "2.3.2" (no "v" prefix)
 * @param {string} input.date - ISO 8601 date string
 * @param {string} input.notesUrl - GitHub Release URL for this version
 * @param {string} input.repository - Target repository as "owner/repo"
 * @param {string} input.sha256sumsContent - SHA256SUMS file contents
 * @param {string[]} input.assets - Ordered asset file names to include
 * @returns {string} JSON manifest (stable key order, 2-space indent, trailing newline)
 */
function buildManifest(input) {
  validateInput(input);

  const checksums = parseSha256sums(input.sha256sumsContent);
  const assets = [];
  for (const name of input.assets) {
    validateAssetName(name);
    const sha256 = checksums.get(name);
    if (!sha256) {
      throw new Error(`[release-manifest] missing checksum for asset: ${name}`);
    }
    assets.push({
      name,
      url: assetUrl(input.repository, input.version, name),
      sha256,
    });
  }

  return (
    JSON.stringify(
      {
        version: input.version,
        date: input.date,
        notesUrl: input.notesUrl,
        assets,
      },
      null,
      2
    ) + '\n'
  );
}

/**
 * Parse CLI arguments for the manifest operation.
 * @param {string[]} args - Arguments after the script name
 * @returns {{ version: string, date: string, assets: string, repository?: string }|null}
 */
function parseArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === '--version') {
      result.version = value;
    } else if (flag === '--date') {
      result.date = value;
    } else if (flag === '--assets') {
      result.assets = value;
    } else if (flag === '--repository') {
      result.repository = value;
    } else {
      throw new Error(`[release-manifest] unknown argument: ${flag}`);
    }
    i += 1;
  }
  if (!result.version || !result.date || !result.assets) return null;
  return result;
}

/**
 * Read stdin to completion.
 * @returns {Promise<string>}
 */
function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', (err) => reject(err));
  });
}

/**
 * CLI entry. Prints the manifest to stdout and returns a process exit code.
 * @param {string[]} args - CLI arguments
 * @param {object} env - Environment variables
 * @returns {Promise<number>}
 */
async function main(args = process.argv.slice(2), env = process.env) {
  let options;
  try {
    options = parseArgs(args);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }

  if (!options) {
    console.error(
      'Usage: node build/release-manifest.js --version <ver> --date <iso> --assets <list> --repository <owner/repo>'
    );
    return 2;
  }

  const repository = options.repository || env.GITHUB_REPOSITORY;
  if (!repository) {
    console.error(
      '[release-manifest] a target repository is required: pass --repository owner/repo or set GITHUB_REPOSITORY'
    );
    return 1;
  }

  let sha256sumsContent;
  try {
    sha256sumsContent = await readStdin();
  } catch (err) {
    console.error(`[release-manifest] failed to read SHA256SUMS: ${err.message}`);
    return 1;
  }

  try {
    const output = buildManifest({
      version: options.version,
      date: options.date,
      notesUrl: `https://github.com/${repository}/releases/tag/v${options.version}`,
      repository,
      sha256sumsContent,
      assets: options.assets.split(','),
    });
    process.stdout.write(output);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(
        `[release-manifest] failed: ${err instanceof Error ? err.message : String(err)}`
      );
      process.exitCode = 1;
    });
}

module.exports = {
  buildManifest,
  parseSha256sums,
  assetUrl,
  parseArgs,
  main,
};
