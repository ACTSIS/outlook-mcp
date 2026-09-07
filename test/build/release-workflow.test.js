/**
 * Release workflow tests (.github/workflows/release.yml).
 *
 * Threat contract from the design:
 * - Push state: only an explicit pushed tag releases; branch pushes, and
 *   tag-vs-ref cases, are distinguished (tag-only trigger, no branch
 *   trigger).
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
      expect(Object.keys(doc.on)).toEqual(['push']);
      expect(doc.on.push).not.toHaveProperty('branches');
      expect(doc.on.push).not.toHaveProperty('branches-ignore');
    });

    it('offers no manual dispatch bypass of the tag gate', () => {
      expect(doc.on.workflow_dispatch).toBeUndefined();
      expect(doc.on.schedule).toBeUndefined();
    });

    it('binds release creation to the pushed tag ref itself', () => {
      const releaseSteps = stepsScript(doc, 'release');
      expect(releaseSteps).toMatch(/GITHUB_REF_NAME/);
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

  describe('secret-free pipeline', () => {
    it('never references or receives OAuth client secrets', () => {
      expect(raw).not.toMatch(/OUTLOOK_CLIENT_SECRET/);
      expect(raw).not.toMatch(/MS_CLIENT_SECRET/);
      expect(raw).not.toMatch(/\bsecrets\./);
    });

    it('declares contents write only on the release job', () => {
      for (const [name, job] of Object.entries(doc.jobs)) {
        if (name === 'release') {
          expect(job.permissions.contents).toBe('write');
        } else {
          expect(job.permissions.contents).toBe('read');
        }
      }
    });
  });
});
