/**
 * T28 (S12, S14-S16) — GHCR container publication contract.
 *
 * The user's screenshot confirmed the repository Packages page is empty
 * while Releases only carry the tar.gz archive, and the user chose
 * «Pública — docker pull sin login». Contracts this unit implements:
 * - The already-built docker-image job gains OCI provenance labels at the
 *   ORIGINAL build (source/version/revision) BEFORE the archive exists,
 *   with the revision label taken from `git rev-parse HEAD` of the exact
 *   release checkout — never from GITHUB_SHA, which in a reusable workflow
 *   can point at the caller's pre-bump commit.
 * - A new `publish-container` job loads the EXACT tested docker-image
 *   artifact (sidecar checksum verified before any load or login; the image
 *   is never rebuilt in the registry job), verifies the HTTP command and
 *   source/version labels, logs in ONLY to ghcr.io with the built-in token
 *   through --password-stdin from an isolated umask-077 DOCKER_CONFIG under
 *   RUNNER_TEMP, and pushes version+latest tags on the canonical
 *   ghcr.io/<lowercase GITHUB_REPOSITORY> image.
 * - `packages: write` is granted to exactly the publish-container job and
 *   the reusable caller job in version.yml (a called workflow can never
 *   exceed the caller); no workflow default, no version-bump job, and no
 *   CI/PR job carries it.
 * - The version tag is never allowed to silently replace a different
 *   published image: after login the existing manifest is inspected and an
 *   identical config digest is an idempotent skip, a different digest or an
 *   unknown schema fails, and ONLY a proven manifest-not-found publishes;
 *   auth, denial, and network errors are never classified as absent.
 * - `latest` is pushed only when RELEASE_TAG equals the trusted
 *   `gh api repos/$GITHUB_REPOSITORY/releases/latest --jq .tag_name`;
 *   older versions publish their version tag but never advance latest, and
 *   the concurrency group is global per repository with cancel disabled.
 * - Publication is honest about visibility: GitHub starts first packages
 *   private even for public repositories; the job summary says visibility
 *   is NOT proven and points a package owner at Package settings instead
 *   of claiming anonymous pulls work. No REST visibility mutation exists.
 *
 * The simulation suite runs the job's real run scripts under an isolated
 * scratch directory with FAKE docker/gh executables only: no registry, no
 * real Docker daemon, and a synthetic token are ever touched.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('node:child_process');
const YAML = require('yaml');

const RELEASE_WORKFLOW_PATH = path.join(
  __dirname,
  '..',
  '..',
  '.github',
  'workflows',
  'release.yml'
);
const VERSION_WORKFLOW_PATH = path.join(
  __dirname,
  '..',
  '..',
  '.github',
  'workflows',
  'version.yml'
);
const CI_WORKFLOW_PATH = path.join(__dirname, '..', '..', '.github', 'workflows', 'ci.yml');

function loadWorkflow(workflowPath) {
  return YAML.parse(fs.readFileSync(workflowPath, 'utf8'));
}

function stepsScript(doc, jobName) {
  return doc.jobs[jobName].steps.map((step) => step.run || '').join('\n');
}

describe('release.yml publish-container job (T28)', () => {
  let doc;
  let raw;

  beforeAll(() => {
    raw = fs.readFileSync(RELEASE_WORKFLOW_PATH, 'utf8');
    doc = loadWorkflow(RELEASE_WORKFLOW_PATH);
  });

  it('runs after the complete publication chain: release, installers publisher, provenance, and docker-image gates', () => {
    const job = doc.jobs['publish-container'];
    expect(job).toBeDefined();
    expect(job.needs).toEqual(['release', 'publish-artifacts', 'docker-image']);
  });

  it('declares exactly contents read plus packages write', () => {
    expect(doc.jobs['publish-container'].permissions).toEqual({
      contents: 'read',
      packages: 'write',
    });
  });

  it('is the only release-workflow job with packages write; contents write stays with release and publish-artifacts', () => {
    const jobsWithPackages = Object.entries(doc.jobs)
      .filter(([, job]) => job.permissions && job.permissions.packages)
      .map(([name]) => name);
    expect(jobsWithPackages).toEqual(['publish-container']);
    for (const [name, job] of Object.entries(doc.jobs)) {
      const expected = name === 'release' || name === 'publish-artifacts' ? 'write' : 'read';
      expect(job.permissions.contents).toBe(expected);
    }
    expect(raw).not.toMatch(/^permissions:/m);
  });

  it('keeps CI and PR jobs free of packages write (only job-level maps override defaults)', () => {
    const ci = loadWorkflow(CI_WORKFLOW_PATH);
    for (const job of Object.values(ci.jobs)) {
      expect(job.permissions && job.permissions.packages).toBeUndefined();
    }
    expect(Object.keys(ci.on)).not.toContain('workflow_call');
  });

  it('serializes per repository, not per ref, with cancel-in-progress false', () => {
    const concurrency = doc.jobs['publish-container'].concurrency;
    expect(concurrency.group).toBe('publish-container-${{ github.repository }}');
    expect(concurrency['cancel-in-progress']).toBe(false);
  });

  it('downloads the exact docker-image artifact first and never rebuilds the image', () => {
    const steps = doc.jobs['publish-container'].steps;
    const download = steps.find(
      (step) => step.uses === 'actions/download-artifact@v4' && step.with.name === 'docker-image'
    );
    expect(download).toBeDefined();
    const script = stepsScript(doc, 'publish-container');
    expect(script).not.toMatch(/docker build|buildx|docker import|docker commit/);
  });

  it('verifies the sidecar checksum before loading or logging in, then loads the gzipped archive', () => {
    const steps = doc.jobs['publish-container'].steps;
    const checksumIndex = steps.findIndex((step) => (step.run || '').includes('sha256sum -c'));
    const loadIndex = steps.findIndex((step) => (step.run || '').includes('docker load'));
    const loginIndex = steps.findIndex((step) => (step.run || '').includes('docker login'));
    expect(checksumIndex).toBeGreaterThanOrEqual(0);
    expect(loadIndex).toBeGreaterThan(checksumIndex);
    expect(loginIndex).toBeGreaterThan(loadIndex);
    const loadScript = steps[loadIndex].run;
    expect(loadScript).toMatch(/gzip|tar\.gz/);
  });

  it('verifies the loaded image ships the HTTP command and the source and version labels before any login', () => {
    const steps = doc.jobs['publish-container'].steps;
    const verifyIndex = steps.findIndex((step) => (step.run || '').includes('Config.Cmd'));
    const loginIndex = steps.findIndex((step) => (step.run || '').includes('docker login'));
    expect(verifyIndex).toBeGreaterThanOrEqual(0);
    expect(verifyIndex).toBeLessThan(loginIndex);
    const verifyScript = steps[verifyIndex].run;
    expect(verifyScript).toContain('["node","bin/m365-mcp.js","http"]');
    expect(verifyScript).toContain('org.opencontainers.image.source');
    expect(verifyScript).toContain('org.opencontainers.image.version');
    expect(verifyScript).toContain('GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}');
    expect(verifyScript).toMatch(/std-io|stdio|HTTP, not stdio/i);
  });

  it('logs in only to ghcr.io with the built-in token through stdin from an isolated umask-077 DOCKER_CONFIG', () => {
    const job = doc.jobs['publish-container'];
    expect(job.env.DOCKER_CONFIG).toBe('${{ runner.temp }}/.docker-config');
    expect(job.env.GH_TOKEN).toBe('${{ github.token }}');
    const login = job.steps.find((step) => (step.run || '').includes('docker login'));
    expect(login.run).toContain('umask 077');
    expect(login.run).toContain('docker login ghcr.io --username "$GITHUB_ACTOR" --password-stdin');
    expect(login.run).toMatch(/printf '%s' "\$GH_TOKEN" \| docker login/);
    expect(login.run).not.toMatch(/docker login[^\n]*GH_TOKEN/);
    expect(login.run).not.toMatch(/--password=/);
    expect(login.run).not.toMatch(/secrets\./);
  });

  it('targets only the canonical lowercase-repository GHCR image for version and latest tags', () => {
    const script = stepsScript(doc, 'publish-container');
    expect(script).toContain(
      "ghcr.io/$(printf '%s' \"$GITHUB_REPOSITORY\" | tr '[:upper:]' '[:lower:]')"
    );
    expect(script).toContain('docker push "${IMAGE}:${VERSION}"');
    expect(script).toContain('docker push "${IMAGE}:latest"');
    expect(script).not.toMatch(/docker\.io|quay\.io|gcr\.io|ecr\.|amazonaws/);
  });

  it('guards the version tag: identical digests are idempotent, different digests and unknown schemas fail', () => {
    const steps = doc.jobs['publish-container'].steps;
    const guard = steps.find((step) => (step.run || '').includes('docker manifest inspect'));
    expect(guard).toBeDefined();
    const script = guard.run;
    expect(script).toMatch(/\{\{\.Id\}\}/);
    expect(script).toContain('config.digest');
    expect(script).toContain('already published as');
    expect(script).toMatch(/!= ?"\$LOCAL_ID"/);
    expect(script).toMatch(/unknown schema/i);
  });

  it('classifies only a proven manifest-not-found as a new version, never an auth or denial error', () => {
    const guard = doc.jobs['publish-container'].steps.find((step) =>
      (step.run || '').includes('docker manifest inspect')
    );
    const script = guard.run;
    expect(script).toMatch(/manifest unknown|not found/i);
    expect(script).toMatch(/auth, denial, and network errors/i);
    expect(script).toContain('exit 1');
  });

  it('pushes the version tag first and only from the guard outcome marker', () => {
    const steps = doc.jobs['publish-container'].steps;
    const guardIndex = steps.findIndex((step) =>
      (step.run || '').includes('docker manifest inspect')
    );
    const versionPushIndex = steps.findIndex((step) =>
      (step.run || '').includes('docker push "${IMAGE}:${VERSION}"')
    );
    const latestPushIndex = steps.findIndex((step) =>
      (step.run || '').includes('docker push "${IMAGE}:latest"')
    );
    expect(guardIndex).toBeLessThan(versionPushIndex);
    expect(versionPushIndex).toBeLessThan(latestPushIndex);
    expect(steps[versionPushIndex].run).toContain(
      '[ -f "${RUNNER_TEMP}/publish-version-required" ]'
    );
  });

  it('advances latest only when the pushed tag is the trusted GitHub latest release', () => {
    const steps = doc.jobs['publish-container'].steps;
    const latest = steps.find((step) => (step.run || '').includes('docker push "${IMAGE}:latest"'));
    expect(latest.run).toContain(
      'gh api "repos/${GITHUB_REPOSITORY}/releases/latest" --jq .tag_name'
    );
    const guardIndex = latest.run.indexOf('$CURRENT_LATEST');
    const pushIndex = latest.run.indexOf('docker push');
    expect(guardIndex).toBeGreaterThan(0);
    expect(pushIndex).toBeGreaterThan(guardIndex);
    expect(latest.run).toMatch(/!= ?"\$RELEASE_TAG"/);
  });

  it('records an honest visibility summary instead of claiming anonymous pulls', () => {
    const steps = doc.jobs['publish-container'].steps;
    const summary = steps.find((step) => (step.run || '').includes('GITHUB_STEP_SUMMARY'));
    expect(summary).toBeDefined();
    const script = summary.run;
    expect(script).toMatch(/NOT proven/i);
    expect(script).toMatch(/Package settings/i);
    expect(script).not.toMatch(
      /anonymous pull (succeeds|works|is guaranteed)|guarantees anonymous/i
    );
    expect(script).toContain('docker pull');
  });

  it('keeps cleanup waiting for publish-container so the archive is deleted only after consumption', () => {
    expect(doc.jobs.cleanup.needs).toEqual(
      expect.arrayContaining(['release', 'publish-artifacts', 'docker-image', 'publish-container'])
    );
  });
});

describe('docker-image build provenance labels (T28)', () => {
  let doc;

  beforeAll(() => {
    doc = loadWorkflow(RELEASE_WORKFLOW_PATH);
  });

  it('adds OCI source, version, and revision labels at the original build, before the archive save', () => {
    const steps = doc.jobs['docker-image'].steps;
    const buildIndex = steps.findIndex((step) => (step.run || '').includes('docker build'));
    const saveIndex = steps.findIndex((step) => (step.run || '').includes('docker image save'));
    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(saveIndex).toBeGreaterThan(buildIndex);
    const build = steps[buildIndex].run;
    expect(build).toContain('--label "org.opencontainers.image.source=${SOURCE}"');
    expect(build).toContain('--label "org.opencontainers.image.version=${RELEASE_TAG#v}"');
    expect(build).toContain('--label "org.opencontainers.image.revision=${REVISION}"');
  });

  it('derives the revision label from git rev-parse HEAD of the release checkout, never from GITHUB_SHA', () => {
    const build = doc.jobs['docker-image'].steps.find((step) =>
      (step.run || '').includes('docker build')
    );
    expect(build.run).toMatch(/git rev-parse HEAD/);
    const script = stepsScript(doc, 'docker-image');
    expect(script).not.toMatch(/GITHUB_SHA/);
    expect(build.run).toContain('SOURCE="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}"');
  });
});

describe('version.yml caller propagation (T28)', () => {
  let versionDoc;

  beforeAll(() => {
    versionDoc = loadWorkflow(VERSION_WORKFLOW_PATH);
  });

  it('grants packages write to the reusable caller job only, because a callee cannot exceed the caller', () => {
    expect(versionDoc.jobs.release.permissions).toEqual({
      contents: 'write',
      actions: 'write',
      packages: 'write',
    });
  });

  it('keeps the workflow default and the version job without packages write', () => {
    expect(versionDoc.permissions).toEqual({ contents: 'write', actions: 'write' });
    expect(versionDoc.jobs.version.permissions).toEqual({ contents: 'write', actions: 'write' });
  });
});

describe('publish-container shell simulation (fake docker/gh only, isolated scratch)', () => {
  let doc;

  const LOCAL_ID = `sha256:${'f'.repeat(64)}`;
  const REMOTE_OTHER_ID = `sha256:${'0'.repeat(64)}`;
  // Identity sentinels: the preflight proves the shell resolves `docker` and
  // `gh` to THESE dispatcher scripts, never to a real container or gh CLI.
  const FAKE_DOCKER_SENTINEL = '# GHCR-SIM-FAKE-DOCKER — never a real container client';
  const FAKE_GH_SENTINEL = '# GHCR-SIM-FAKE-GH — never a real gh client';

  function baseEnv(scratch, overrides) {
    return {
      RELEASE_TAG: 'v2.4.5',
      GITHUB_REPOSITORY: 'ACTSIS/OUTLOOK-MCP',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_ACTOR: 'octocat',
      GH_TOKEN: 'synthetic-ghcr-token-not-a-real-value',
      RUNNER_TEMP: path.join(scratch, 'runner-temp'),
      DOCKER_CONFIG: path.join(scratch, 'runner-temp', '.docker-config'),
      GITHUB_STEP_SUMMARY: path.join(scratch, 'step-summary.md'),
      FAKE_MANIFEST_MODE: 'missing',
      FAKE_LOCAL_ID: LOCAL_ID,
      FAKE_LATEST_TAG: 'v2.4.5',
      ...overrides,
    };
  }

  function prepareScratch(scratch) {
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.mkdirSync(path.join(scratch, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(scratch, 'docker-image-bundle'), { recursive: true });
    fs.mkdirSync(path.join(scratch, 'runner-temp'), { recursive: true });
    const archive = path.join(scratch, 'docker-image-bundle', 'outlook-mcp-docker-image.tar.gz');
    fs.writeFileSync(archive, 'synthetic archive bytes\n');
    const digest = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    fs.writeFileSync(
      path.join(scratch, 'docker-image-bundle', 'outlook-mcp-docker-image.tar.gz.sha256'),
      `${digest}  outlook-mcp-docker-image.tar.gz\n`
    );
    const docker = [
      '#!/usr/bin/env bash',
      FAKE_DOCKER_SENTINEL,
      'printf \'docker %s\\n\' "$*" >> "$FAKE_STATE_FILE"',
      'if [ "$1" = "logout" ]; then exit 0; fi',
      'if [ "$1" = "login" ]; then cat > /dev/null; [ -n "$GH_TOKEN" ] || exit 1; exit 0; fi',
      'if [ "$1" = "load" ]; then exit 0; fi',
      'if [ "$1" = "tag" ]; then exit 0; fi',
      'if [ "$1" = "push" ]; then',
      '  if [ -n "$FAKE_PUSH_FAIL" ]; then echo "denied: $FAKE_PUSH_FAIL" >&2; exit 1; fi',
      '  exit 0; fi',
      'if [ "$1" = "manifest" ]; then',
      '  case "$FAKE_MANIFEST_MODE" in',
      '    missing) echo "error: manifest unknown: manifest unknown" >&2; exit 1 ;;',
      '    denied) echo "denied: requested access to the resource is denied" >&2; exit 1 ;;',
      '    unauthorized) echo "unauthorized: authentication required" >&2; exit 1 ;;',
      '    same) printf \'{"mediaType":"application/vnd.docker.distribution.manifest.v2+json","config":{"digest":"%s"}}\\n\' "$FAKE_LOCAL_ID"; exit 0 ;;',
      `    different) printf '{"mediaType":"application/vnd.docker.distribution.manifest.v2+json","config":{"digest":"%s"}}\\n' "${REMOTE_OTHER_ID}"; exit 0 ;;`,
      '    unknown) echo \'{"mediaType":"application/vnd.docker.distribution.manifest.list.v2+json","manifests":[]}\'; exit 0 ;;',
      '    *) echo "fake docker: bad FAKE_MANIFEST_MODE" >&2; exit 1 ;;',
      '  esac',
      'fi',
      'if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then',
      '  FORMAT=""',
      '  for a in "$@"; do',
      '    case "$a" in',
      '      *\'{{json .Config.Cmd}}\'*) FORMAT="cmd" ;;',
      '      *\'{{.Id}}\'*) FORMAT="id" ;;',
      '      *\'org.opencontainers.image.source"\'*) FORMAT="source" ;;',
      '      *\'org.opencontainers.image.version"\'*) FORMAT="version" ;;',
      '    esac',
      '  done',
      '  case "$FORMAT" in',
      '    cmd) if [ "$FAKE_IMAGE_CMD" = "stdio" ]; then echo \'["node","bin/m365-mcp.js"]\'; else echo \'["node","bin/m365-mcp.js","http"]\'; fi; exit 0 ;;',
      '    id) echo "$FAKE_LOCAL_ID"; exit 0 ;;',
      '    source) echo "${FAKE_SOURCE_LABEL:-${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}}"; exit 0 ;;',
      '    version) echo "${FAKE_VERSION_LABEL:-${RELEASE_TAG#v}}"; exit 0 ;;',
      '  esac',
      '  exit 0',
      'fi',
      'echo "fake docker: unexpected command: $*" >&2',
      'exit 1',
    ].join('\n');
    fs.writeFileSync(path.join(scratch, 'bin', 'docker'), docker, { mode: 0o755 });
    const gh = [
      '#!/usr/bin/env bash',
      FAKE_GH_SENTINEL,
      'printf \'gh %s\\n\' "$*" >> "$FAKE_STATE_FILE"',
      'if [ "$1" = "api" ]; then',
      '  if [ -n "$FAKE_GH_FAIL" ]; then echo "gh: failing as scripted" >&2; exit 1; fi',
      '  echo "$FAKE_LATEST_TAG"; exit 0;',
      'fi',
      'echo "fake gh: unexpected command: $*" >&2',
      'exit 1',
    ].join('\n');
    fs.writeFileSync(path.join(scratch, 'bin', 'gh'), gh, { mode: 0o755 });
  }

  /**
   * Builds the environment for one simulated step. The fake bin directory is
   * prepended with `path.delimiter` (Windows `;`, POSIX `:`) so the fake
   * dispatchers win PATH resolution on every platform; an explicit
   * `{ prependFakes: false }` opts out for the fail-closed resolution test.
   */
  function stepEnv(scratch, base, stateFile, { prependFakes = true } = {}) {
    return {
      ...process.env,
      ...base,
      FAKE_STATE_FILE: stateFile,
      FAKE_DOCKER_SENTINEL,
      FAKE_GH_SENTINEL,
      PATH: prependFakes
        ? `${path.join(scratch, 'bin')}${path.delimiter}${process.env.PATH}`
        : process.env.PATH,
    };
  }

  /**
   * Fail-closed resolution sanity (T28 correction): before ANY simulated job
   * block, the harness proves with bash builtins ONLY (command -v and read;
   * the clients are never executed) that `docker` and `gh` resolve to the
   * isolated fake dispatcher scripts inside the scratch bin directory. Any
   * other resolution — a real /usr/bin/docker or /usr/bin/gh on Linux, a
   * real docker.exe on Windows, or a missing fake — aborts the simulation
   * with an error before a single job step executes, so no accidental real
   * command is ever run.
   */
  function assertSimulatedClientsResolveToFakes(scratch, env) {
    const resolution = spawnSync(
      'bash',
      [
        '-c',
        [
          'command -v docker >/dev/null 2>&1 || exit 20',
          'command -v gh >/dev/null 2>&1 || exit 21',
          'DP="$(command -v docker)"; GP="$(command -v gh)"',
          'exec 3< "$DP"; read -r D1 <&3; read -r D2 <&3',
          'exec 4< "$GP"; read -r G1 <&4; read -r G2 <&4',
          '[ "$D1" = "#!/usr/bin/env bash" ] || exit 30',
          '[ "$G1" = "#!/usr/bin/env bash" ] || exit 30',
          '[ "$D2" = "$FAKE_DOCKER_SENTINEL" ] || exit 31',
          '[ "$G2" = "$FAKE_GH_SENTINEL" ] || exit 32',
          'exit 0',
        ].join('\n'),
      ],
      {
        cwd: scratch,
        encoding: 'utf8',
        env,
      }
    );
    if (resolution.error || resolution.status !== 0) {
      throw new Error(
        `ghcr simulation preflight FAILED (exit ${resolution.status}): the shell does not resolve docker/gh to the isolated fake dispatchers in ${path.join(
          scratch,
          'bin'
        )}; a real container or gh client would be selected. Aborting before any simulated job block so no real command is ever executed.`
      );
    }
  }

  /** Runs the publish-container run blocks under the fake clients. */
  function runSteps(scratch, env, { prepare, prependFakes } = {}) {
    const stateFile = path.join(scratch, 'registry-state.log');
    if (prepare) {
      prepareScratch(scratch);
      fs.writeFileSync(path.join(scratch, 'runner-temp', '.keep'), '');
    }
    if (!fs.existsSync(stateFile)) {
      fs.writeFileSync(stateFile, '');
    }
    const stepEnvironment = stepEnv(scratch, env, stateFile, { prependFakes });
    assertSimulatedClientsResolveToFakes(scratch, stepEnvironment);
    const job = doc.jobs['publish-container'];
    let failedAt = null;
    let failedOutput = '';
    for (const step of job.steps) {
      if (step.uses) continue; // download-artifact is satisfied by the fixture bundle
      const result = spawnSync('bash', ['-c', step.run], {
        cwd: scratch,
        encoding: 'utf8',
        env: stepEnv(scratch, env, stateFile, { prependFakes }),
      });
      if (result.status !== 0) {
        failedAt = step.name;
        failedOutput = `${result.stdout || ''}${result.stderr || ''}`;
        break;
      }
    }
    const state = fs.readFileSync(stateFile, 'utf8').split('\n').filter(Boolean);
    return {
      failedAt,
      failedOutput,
      state,
      pushes: state.filter((line) => line.startsWith('docker push')),
      logins: state.filter((line) => line.startsWith('docker login')),
      ghCalls: state.filter((line) => line.startsWith('gh ')),
    };
  }

  function runPublishContainer(scratch, env) {
    return runSteps(scratch, env, { prepare: true });
  }

  const pushVersion = 'docker push ghcr.io/actsis/outlook-mcp:2.4.5';
  const pushLatest = 'docker push ghcr.io/actsis/outlook-mcp:latest';

  beforeAll(() => {
    doc = loadWorkflow(RELEASE_WORKFLOW_PATH);
  });

  it('publishes version and latest for the canonical lowercase image with a stdin-only login', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ghcr-sim-'));
    try {
      const result = runPublishContainer(scratch, baseEnv(scratch));
      expect(result.failedAt).toBeNull();
      expect(result.logins).toEqual(
        expect.arrayContaining(['docker login ghcr.io --username octocat --password-stdin'])
      );
      expect(result.logins).toHaveLength(1);
      expect(result.pushes).toEqual([pushVersion, pushLatest]);
      expect(result.state.join('\n')).not.toContain('synthetic-ghcr-token');
      expect(result.state.some((line) => line.includes('docker manifest inspect'))).toBe(true);
      expect(result.state.some((line) => line.startsWith('docker logout'))).toBe(true);
      expect(
        result.state.some(
          (line) => line === 'docker tag outlook-mcp-http:2.4.5 ghcr.io/actsis/outlook-mcp:latest'
        )
      ).toBe(true);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('is idempotent when the registry manifest is exactly this image: no version push, latest still advances', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ghcr-sim-'));
    try {
      const result = runPublishContainer(scratch, baseEnv(scratch, { FAKE_MANIFEST_MODE: 'same' }));
      expect(result.failedAt).toBeNull();
      expect(result.pushes).toEqual([pushLatest]);
      const inspectMessage = result.state.find((line) => line.startsWith('echo'));
      expect(result.state.filter((line) => line.startsWith('docker push'))).toHaveLength(1);
      void inspectMessage;
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('fails closed when the existing version tag belongs to a different image, without pushing', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ghcr-sim-'));
    try {
      const result = runPublishContainer(
        scratch,
        baseEnv(scratch, { FAKE_MANIFEST_MODE: 'different' })
      );
      expect(result.failedAt).toBe(
        doc.jobs['publish-container'].steps.find((step) =>
          (step.run || '').includes('docker manifest inspect')
        ).name
      );
      expect(result.failedOutput).toMatch(/already published|immutable|different/i);
      expect(result.pushes).toEqual([]);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('fails closed on an unknown manifest schema instead of replacing the tag', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ghcr-sim-'));
    try {
      const result = runPublishContainer(
        scratch,
        baseEnv(scratch, { FAKE_MANIFEST_MODE: 'unknown' })
      );
      expect(result.failedAt).toBe(
        doc.jobs['publish-container'].steps.find((step) =>
          (step.run || '').includes('docker manifest inspect')
        ).name
      );
      expect(result.failedOutput).toMatch(/unknown schema/i);
      expect(result.pushes).toEqual([]);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('never classifies a denied or unauthorized manifest lookup as an absent version', () => {
    for (const mode of ['denied', 'unauthorized']) {
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ghcr-sim-'));
      try {
        const result = runPublishContainer(scratch, baseEnv(scratch, { FAKE_MANIFEST_MODE: mode }));
        expect(result.failedAt).toBe(
          doc.jobs['publish-container'].steps.find((step) =>
            (step.run || '').includes('docker manifest inspect')
          ).name
        );
        expect(result.failedOutput).toMatch(new RegExp(mode));
        expect(result.pushes).toEqual([]);
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    }
  });

  it('publishes the version tag of an old release without advancing the guarded latest', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ghcr-sim-'));
    try {
      const result = runPublishContainer(scratch, baseEnv(scratch, { FAKE_LATEST_TAG: 'v9.9.9' }));
      expect(result.failedAt).toBeNull();
      expect(result.pushes).toEqual([pushVersion]);
      const summary = fs.readFileSync(path.join(scratch, 'step-summary.md'), 'utf8');
      expect(summary).toMatch(/NOT proven/i);
      expect(summary).toMatch(/Package settings/i);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('refuses a stdio image and never logs in when the HTTP command is missing', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ghcr-sim-'));
    try {
      const result = runPublishContainer(scratch, baseEnv(scratch, { FAKE_IMAGE_CMD: 'stdio' }));
      expect(result.failedAt).toBe(
        doc.jobs['publish-container'].steps.find((step) => (step.run || '').includes('Config.Cmd'))
          .name
      );
      expect(result.failedOutput).toMatch(/http|stdio/i);
      expect(result.logins).toEqual([]);
      expect(result.pushes).toEqual([]);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('refuses a foreign source label without logging in or pushing', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ghcr-sim-'));
    try {
      const result = runPublishContainer(
        scratch,
        baseEnv(scratch, { FAKE_SOURCE_LABEL: 'https://github.com/other-project/repo' })
      );
      expect(result.failedAt).toBe(
        doc.jobs['publish-container'].steps.find((step) => (step.run || '').includes('Config.Cmd'))
          .name
      );
      expect(result.pushes).toEqual([]);
      expect(result.logins).toEqual([]);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('stops before any login or push when the archive checksum does not match its sidecar', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ghcr-sim-'));
    try {
      prepareScratch(scratch);
      fs.writeFileSync(
        path.join(scratch, 'docker-image-bundle', 'outlook-mcp-docker-image.tar.gz.sha256'),
        `${'a'.repeat(64)}  outlook-mcp-docker-image.tar.gz\n`
      );
      const second = runPublishContainerNoPrepare(scratch, baseEnv(scratch));
      expect(second.failedAt).toBe(
        doc.jobs['publish-container'].steps.find((step) =>
          (step.run || '').includes('sha256sum -c')
        ).name
      );
      expect(second.logins).toEqual([]);
      expect(second.pushes).toEqual([]);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  function runPublishContainerNoPrepare(scratch, env) {
    return runSteps(scratch, env, { prepare: false });
  }

  /**
   * T28 correction guarantee, verified as behavior: when the shell does not
   * resolve the fake dispatchers (for example a Linux runner would pick
   * /usr/bin/docker first), the simulation aborts before executing anything,
   * the synthetic state log stays empty, and no real client is ever invoked.
   */
  it('aborts fail-closed, without invoking any real container or gh client, when the fakes are not what the shell resolves', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ghcr-sim-'));
    try {
      prepareScratch(scratch);
      const stateFile = path.join(scratch, 'registry-state.log');
      fs.writeFileSync(stateFile, '');
      // Resolve from the REAL system PATH only: no scratch bin dir is
      // prepended, so this machine's real docker/gh would be selected.
      const env = stepEnv(scratch, baseEnv(scratch), stateFile, { prependFakes: false });
      expect(() => assertSimulatedClientsResolveToFakes(scratch, env)).toThrow(
        /preflight FAILED|fake dispatchers/
      );
      // Nothing was executed: the synthetic state log records no client
      // invocation and the job never produced a summary.
      expect(fs.readFileSync(stateFile, 'utf8')).toBe('');
      expect(fs.existsSync(path.join(scratch, 'step-summary.md'))).toBe(false);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('fails closed when a registry push is denied instead of reporting success', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ghcr-sim-'));
    try {
      const result = runPublishContainer(scratch, baseEnv(scratch, { FAKE_PUSH_FAIL: 'denied' }));
      expect(result.failedAt).toBe(
        doc.jobs['publish-container'].steps.find((step) =>
          (step.run || '').includes('docker push "${IMAGE}:${VERSION}"')
        ).name
      );
      expect(result.failedOutput).toMatch(/denied/i);
      // The denied version push was attempted exactly once and latest was
      // never reached.
      expect(result.pushes).toEqual([pushVersion]);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('fails closed on a latest-release lookup failure without publishing latest', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ghcr-sim-'));
    try {
      const result = runPublishContainer(scratch, baseEnv(scratch, { FAKE_GH_FAIL: '1' }));
      expect(result.failedAt).toBe(
        doc.jobs['publish-container'].steps.find((step) =>
          (step.run || '').includes('releases/latest')
        ).name
      );
      expect(result.pushes).toEqual([pushVersion]);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});
