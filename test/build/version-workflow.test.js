const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const WORKFLOW_PATH = path.join(__dirname, '..', '..', '.github', 'workflows', 'version.yml');
const CI_WORKFLOW_PATH = path.join(__dirname, '..', '..', '.github', 'workflows', 'ci.yml');

function loadWorkflow() {
  return YAML.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
}

describe('semantic version workflow', () => {
  let doc;

  beforeAll(() => {
    doc = loadWorkflow();
  });

  it('offers only major, minor, and patch dispatch choices', () => {
    expect(doc.on.workflow_dispatch.inputs.bump).toEqual({
      description: 'Select the semantic version increment.',
      type: 'choice',
      required: true,
      options: ['patch', 'minor', 'major'],
    });
  });

  it('can dispatch only from main and serializes version creation', () => {
    expect(doc.concurrency).toEqual({
      group: 'semantic-release-main',
      'cancel-in-progress': false,
    });
    const steps = doc.jobs.version.steps;
    expect(steps[0].if).toBe("github.ref != 'refs/heads/main'");
    expect(steps[0].run).toMatch(/exit 1/);
  });

  it('dispatches CI for the current main commit and requires it to pass before versioning', () => {
    const step = doc.jobs.version.steps.find((item) => item.name === 'Require successful main CI');
    const ci = YAML.parse(fs.readFileSync(CI_WORKFLOW_PATH, 'utf8'));

    expect(ci.on).toHaveProperty('workflow_dispatch');
    expect(step.run).toMatch(/gh workflow run ci\.yml --ref main/);
    expect(step.run).toMatch(/gh run list/);
    expect(step.run).toMatch(/gh workflow run ci\.yml --ref main/);
    expect(step.run).toMatch(/--commit "\$SHA"/);
    expect(step.run).toMatch(/--event workflow_dispatch/);
    expect(step.run).toMatch(/gh run watch .*--exit-status/);
    expect(step.run).toMatch(/git ls-remote origin refs\/heads\/main/);
    expect(step.run).toMatch(/BEFORE_RUN_ID/);
    expect(step.env.GH_TOKEN).toBe('${{ github.token }}');
    expect(doc.jobs.version.steps.indexOf(step)).toBeLessThan(
      doc.jobs.version.steps.findIndex((item) => item.name === 'Bump semantic version')
    );
  });

  it('bumps package metadata, pushes the version commit and tag, then calls the release workflow', () => {
    const job = doc.jobs.version;
    const script = job.steps.map((step) => step.run || '').join('\n');
    expect(job.permissions).toEqual({ contents: 'write', actions: 'write' });
    expect(job.outputs.tag).toBe('${{ steps.version.outputs.tag }}');
    expect(script).toMatch(/npm version .*--no-git-tag-version/);
    expect(script).toMatch(/git push origin HEAD:main/);
    expect(script).toMatch(/git push origin "refs\/tags\/\$TAG"/);
    expect(doc.jobs.release.uses).toBe('./.github/workflows/release.yml');
    expect(doc.jobs.release.needs).toEqual(['version']);
    expect(doc.jobs.release.with.tag).toBe('${{ needs.version.outputs.tag }}');
    // GitHub-only publication (S14): the caller passes no secrets and the
    // callee declares none.
    expect(doc.jobs.release.secrets).toBeUndefined();
  });

  it('uses the built-in GitHub token and never requests a personal token', () => {
    expect(doc.permissions).toEqual({ contents: 'write', actions: 'write' });
    // T28 (S15/S16): the reusable caller job adds packages: write so the
    // release pipeline's publish-container job can push to GHCR — a called
    // workflow can never exceed its caller. The workflow default and the
    // version-bump job stay without it.
    expect(doc.jobs.release.permissions).toEqual({
      contents: 'write',
      actions: 'write',
      packages: 'write',
    });
    expect(doc.jobs.version.permissions).toEqual({ contents: 'write', actions: 'write' });
    expect(fs.readFileSync(WORKFLOW_PATH, 'utf8')).not.toMatch(/secrets\.[A-Z0-9_]*TOKEN/);
    expect(fs.readFileSync(WORKFLOW_PATH, 'utf8')).not.toMatch(/NETBIRD_SETUP_KEY|PROGET_API_KEY/i);
  });

  it('does not grant packages write at the workflow default or to the version job (T28)', () => {
    expect(doc.permissions.packages).toBeUndefined();
    expect(doc.jobs.version.permissions.packages).toBeUndefined();
    expect(doc.jobs.release.secrets).toBeUndefined();
  });
});
