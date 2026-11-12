/**
 * Release workflow tests (.github/workflows/release.yml).
 *
 * Threat contract from the design:
 * - Push state: tag pushes release directly; the version workflow can call
 *   this pipeline only with a selected semantic version tag.
 * - Failed builds never invoke release creation: the publish job must
 *   depend on every required job (build, validation, secret scan) and must
 *   not bypass failure (no `if: always()`), so no incomplete release is
 *   ever presented as successful.
 * - Secret-free pipeline: the workflow must never receive or embed
 *   OUTLOOK_CLIENT_SECRET or any secrets reference; credentials remain
 *   runtime supplied.
 * Production workflow does not exist yet (RED).
 */
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const WORKFLOW_PATH = path.join(__dirname, '..', '..', '.github', 'workflows', 'release.yml');

function loadWorkflow() {
  return YAML.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
}

/** Join a job's step scripts into one string for contract assertions. */
function stepsScript(doc, jobName) {
  return doc.jobs[jobName].steps.map((step) => step.run || '').join('\n');
}

describe('release workflow', () => {
  let doc;
  let raw;

  beforeAll(() => {
    raw = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    doc = loadWorkflow();
  });

  describe('trigger (threat: pushed-tag state)', () => {
    it('only tags trigger a release; branch pushes do not', () => {
      expect(doc.on.push.tags).toBeDefined();
      expect(doc.on.push.branches).toBeUndefined();
      expect(doc.on.pull_request).toBeUndefined();
    });

    it('distinguishes tag refs from plain refs with an explicit tag pattern', () => {
      const tags = doc.on.push.tags;
      expect(Array.isArray(tags)).toBe(true);
      expect(tags.length).toBeGreaterThan(0);
      for (const pattern of tags) {
        expect(String(pattern)).toMatch(/^v/);
      }
    });

    it('never releases on a branch push or non-tag event', () => {
      expect(Object.keys(doc.on)).toEqual(['push', 'workflow_call']);
      expect(doc.on.push).not.toHaveProperty('branches');
      expect(doc.on.push).not.toHaveProperty('branches-ignore');
    });

    it('supports tag pushes and reusable workflow calls, but no direct manual release', () => {
      expect(doc.on.workflow_dispatch).toBeUndefined();
      expect(doc.on.workflow_call.inputs.tag).toEqual({
        description: 'Semantic version tag to release',
        required: true,
        type: 'string',
      });
    });

    it('binds release creation to the pushed tag ref itself', () => {
      const releaseSteps = stepsScript(doc, 'release');
      expect(releaseSteps).toMatch(/RELEASE_TAG/);
      expect(releaseSteps).not.toMatch(/GITHUB_HEAD_REF/);
      expect(releaseSteps).not.toMatch(/GITHUB_BASE_REF/);
    });
  });

  describe('build matrix', () => {
    it('builds the win-x64 and linux-x64 targets on their native runners', () => {
      const matrix = doc.jobs.build.strategy.matrix;
      expect(matrix.target).toEqual(['win-x64', 'linux-x64']);
    });

    it('maps each target to its native OS runner', () => {
      const include = doc.jobs.build.strategy.matrix.include;
      const osByTarget = Object.fromEntries(include.map((row) => [row.target, row.os]));
      expect(osByTarget['win-x64']).toContain('windows');
      expect(osByTarget['linux-x64']).toContain('ubuntu');
    });
  });

  describe('ordered gates before publication', () => {
    it('runs mode validation after the build completes', () => {
      expect(doc.jobs.validate).toBeDefined();
      expect(doc.jobs.validate.needs).toEqual(['build']);
    });

    it('runs the secret scan only after validated artifacts exist', () => {
      expect(doc.jobs.scan).toBeDefined();
      expect(doc.jobs.scan.needs).toContain('build');
      expect(doc.jobs.scan.needs).toContain('validate');
    });

    it('validates both mcp and auth modes of the packaged artifact', () => {
      const steps = stepsScript(doc, 'validate');
      expect(steps).toMatch(/mcp/);
      expect(steps).toMatch(/auth/);
    });

    it('restores Linux execute permission after download and before mode validation', () => {
      const steps = doc.jobs.validate.steps;
      const downloadIndex = steps.findIndex((step) => step.name === 'Download packaged artifact');
      const restoreIndex = steps.findIndex(
        (step) => step.name === 'Restore Linux executable permission'
      );
      const mcpIndex = steps.findIndex((step) => step.name === 'Validate mcp mode boots');
      const authIndex = steps.findIndex(
        (step) => step.name === 'Validate auth mode serves the callback endpoint'
      );
      const restoreStep = steps[restoreIndex];

      expect(restoreStep.if).toBe("matrix.target == 'linux-x64'");
      expect(restoreStep.run).toMatch(/chmod \+x/);
      expect(restoreStep.run).toContain('${{ matrix.artifact }}');
      expect(restoreIndex).toBeGreaterThan(downloadIndex);
      expect(restoreIndex).toBeLessThan(mcpIndex);
      expect(restoreIndex).toBeLessThan(authIndex);
    });

    it('runs the secret scan over the packaged artifacts (fail closed)', () => {
      const steps = stepsScript(doc, 'scan');
      expect(steps).toMatch(/secret-scan|secret_scan|secret scan/i);
      expect(steps).toMatch(/dist/i);
    });
  });

  describe('release publication (threat: failed builds never release)', () => {
    it('publishes only after every required job succeeds', () => {
      expect(doc.jobs.release).toBeDefined();
      const needs = doc.jobs.release.needs;
      expect(needs).toContain('build');
      expect(needs).toContain('validate');
      expect(needs).toContain('scan');
    });

    it('never bypasses a failed dependency with always()', () => {
      const releaseSteps = stepsScript(doc, 'release');
      expect(releaseSteps).not.toMatch(/if:\s*always\(\)/);
      expect(doc.jobs.release.if || '').not.toMatch(/always\(\)/);
    });

    it('uploads the documented combined artifact names for both targets', () => {
      const releaseSteps = stepsScript(doc, 'release');
      expect(releaseSteps).toMatch(/outlook-mcp-win-x64\.exe/);
      expect(releaseSteps).toMatch(/outlook-mcp-linux-x64/);
    });
  });

  describe('reusable release source', () => {
    it('checks out and publishes the requested tag when called by the version workflow', () => {
      const checkoutRefs = Object.values(doc.jobs)
        .flatMap((job) => job.steps || [])
        .filter((step) => step.uses === 'actions/checkout@v4')
        .map((step) => step.with?.ref);
      expect(checkoutRefs.length).toBeGreaterThan(0);
      expect(checkoutRefs.every((ref) => ref === '${{ inputs.tag || github.ref }}')).toBe(true);
      expect(doc.jobs.release.steps.at(-1).run).toContain('$RELEASE_TAG');
    });
  });

  describe('secret policy (GitHub-only publication)', () => {
    it('declares no custom secrets and receives none from callers', () => {
      expect(doc.on.workflow_call.secrets).toBeUndefined();
      expect(raw).not.toMatch(/NETBIRD_SETUP_KEY|PROGET_API_KEY/i);
    });

    it('contains no secrets references at all; OAuth client secrets stay forbidden', () => {
      expect(raw).not.toMatch(/OUTLOOK_CLIENT_SECRET/);
      expect(raw).not.toMatch(/MS_CLIENT_SECRET/);
      expect(raw).not.toMatch(/\bsecrets\./);
    });

    it('uses only the built-in github token wherever GH_TOKEN is set', () => {
      const tokens = Object.values(doc.jobs)
        .flatMap((job) => (job.steps || []).map((step) => step.env || {}))
        .filter((env) => env.GH_TOKEN)
        .map((env) => env.GH_TOKEN);
      expect(tokens.length).toBeGreaterThan(0);
      for (const token of tokens) {
        expect(token).toBe('${{ github.token }}');
      }
    });

    it('grants contents write only to the release and publish-artifacts jobs', () => {
      for (const [name, job] of Object.entries(doc.jobs)) {
        if (name === 'release' || name === 'publish-artifacts') {
          expect(job.permissions.contents).toBe('write');
        } else {
          expect(job.permissions.contents).toBe('read');
        }
      }
    });
  });

  describe('github release distribution jobs', () => {
    it('installer jobs depend on build', () => {
      expect(doc.jobs['installer-windows'].needs).toEqual(['build']);
      expect(doc.jobs['installer-linux'].needs).toEqual(['build']);
    });

    it('smoke depends on both installer jobs', () => {
      expect(doc.jobs.smoke.needs).toEqual(['installer-windows', 'installer-linux']);
    });

    it('provenance depends on smoke', () => {
      expect(doc.jobs.provenance.needs).toEqual(['smoke']);
    });

    it('publish-artifacts depends on release, both installers, and provenance', () => {
      const needs = doc.jobs['publish-artifacts'].needs;
      expect(needs).toEqual(
        expect.arrayContaining(['release', 'installer-windows', 'installer-linux', 'provenance'])
      );
      expect(needs).toHaveLength(4);
    });

    it('publish-artifacts is the repository-agnostic GitHub-only publisher', () => {
      expect(doc.jobs['publish-artifacts']['if']).toBeUndefined();
      const script = stepsScript(doc, 'publish-artifacts');
      expect(script.toLowerCase()).not.toMatch(/proget|netbird|curl/);
    });

    it('publish-artifacts serializes same-version publications with a ref-keyed concurrency group', () => {
      expect(doc.jobs['publish-artifacts'].concurrency.group).toMatch(
        /\$\{\{\s*github\.ref\s*\}\}/
      );
      expect(doc.jobs['publish-artifacts'].concurrency['cancel-in-progress']).toBe(false);
    });

    it('publish-artifacts builds the manifest with build/release-manifest.js for the four product assets', () => {
      const paSteps = doc.jobs['publish-artifacts'].steps;
      const manifestStep = paSteps.find(
        (step) => step.run && step.run.includes('build/release-manifest.js')
      );
      expect(manifestStep).toBeDefined();
      const manifestRun = manifestStep.run;
      expect(manifestRun).toMatch(/outlook-mcp-setup\.exe/);
      expect(manifestRun).toMatch(/outlook-mcp_\$\{VERSION\}_amd64\.deb/);
      expect(manifestRun).toMatch(/outlook-mcp-win-x64\.exe/);
      expect(manifestRun).toMatch(/outlook-mcp-linux-x64/);
    });

    it('cleanup runs after every job and never gates outcomes', () => {
      expect(doc.jobs.cleanup.needs).toEqual(
        expect.arrayContaining([
          'release',
          'installer-windows',
          'installer-linux',
          'smoke',
          'provenance',
          'publish-artifacts',
        ])
      );
      expect(doc.jobs.cleanup.if).toMatch(/always\(\)/);
    });

    it('installer jobs verify tag version drift before packaging', () => {
      const windowsScript = stepsScript(doc, 'installer-windows');
      const linuxScript = stepsScript(doc, 'installer-linux');
      expect(windowsScript).toMatch(/package\.json.*version/);
      expect(linuxScript).toMatch(/package\.json.*version/);
      expect(windowsScript).toMatch(/RELEASE_TAG/);
      expect(linuxScript).toMatch(/RELEASE_TAG/);
    });

    // T21 (S12): the release job is intentionally extended — it also waits
    // for and downloads the downloadable Docker image bundle and attaches the
    // archive plus its checksum. The permissions, trigger, concurrency, and
    // timeout boundaries stay untouched.
    it('keeps the intentionally extended release job block', () => {
      expect(doc.jobs.release.needs).toEqual(['build', 'validate', 'scan', 'docker-image']);
      expect(doc.jobs.release.permissions).toEqual({ contents: 'write' });
      expect(doc.jobs.release['timeout-minutes']).toBe(15);
      expect(doc.jobs.release.concurrency).toEqual({
        group: 'release-${{ github.ref }}',
        'cancel-in-progress': false,
      });
      const stepNames = doc.jobs.release.steps.map((step) => step.name);
      expect(stepNames).toEqual([
        'Checkout repository',
        'Download packaged artifacts',
        'Download Docker image bundle',
        'Verify complete artifact set before publishing',
        'Verify Docker image bundle checksum',
        'Create release',
      ]);
    });
  });
});
