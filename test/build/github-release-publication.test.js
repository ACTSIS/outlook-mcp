/**
 * GitHub-only publication contract (S14) — .github/workflows/release.yml
 * and its version.yml caller.
 *
 * The user directed («no, no uses proget, usa el mismo de github») that ALL
 * active distribution go through the same existing GitHub Releases that
 * already publish the binaries and the Docker bundle. Contracts:
 * - The generic publish-artifacts job id stays; its name becomes the
 *   installer asset publisher and it needs exactly release, both
 *   installers, and provenance (provenance itself follows the smoke gate).
 * - contents: write is granted to exactly the release and publish-artifacts
 *   jobs; every other job stays contents: read. No repository guard, custom
 *   registry permission, or publication secret ever returns.
 * - The publisher authenticates only with the built-in github.token,
 *   targets the release explicitly through the trusted GITHUB_REPOSITORY
 *   context (no wrong upstream default), reads the target release version,
 *   verifies every required asset and the provenance checksums, uploads
 *   ONLY the five new assets with no --clobber (the release job's binaries
 *   and Docker bundle are never re-uploaded), and uploads latest-stable.json
 *   built by build/release-manifest.js from SHA256SUMS.
 * - The reusable release workflow declares no secrets; version.yml passes
 *   none.
 */
const fs = require('fs');
const path = require('path');
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

function loadWorkflow(workflowPath) {
  return YAML.parse(fs.readFileSync(workflowPath, 'utf8'));
}

/** Join a job's step scripts into one string for contract assertions. */
function stepsScript(doc, jobName) {
  return doc.jobs[jobName].steps.map((step) => step.run || '').join('\n');
}

/** Collect the run scripts of every gh release upload invocation. */
function uploadScripts(doc, jobName) {
  return doc.jobs[jobName].steps
    .map((step) => step.run || '')
    .filter((script) => script.includes('gh release upload'));
}

describe('GitHub-only publish-artifacts publisher', () => {
  let doc;
  let raw;

  beforeAll(() => {
    raw = fs.readFileSync(RELEASE_WORKFLOW_PATH, 'utf8');
    doc = loadWorkflow(RELEASE_WORKFLOW_PATH);
  });

  it('keeps the generic job id with its installer asset publisher name', () => {
    expect(doc.jobs['publish-artifacts'].name).toBe('Publish installer assets to GitHub Release');
  });

  it('requires exactly the release, both installers, and provenance jobs', () => {
    expect(doc.jobs['publish-artifacts'].needs).toEqual([
      'release',
      'installer-windows',
      'installer-linux',
      'provenance',
    ]);
  });

  it('runs in every repository with no repository or secret guard', () => {
    expect(doc.jobs['publish-artifacts']['if']).toBeUndefined();
    const script = stepsScript(doc, 'publish-artifacts');
    expect(script.toLowerCase()).not.toMatch(/proget|netbird/);
    expect(script).not.toMatch(/\bsecrets\./);
  });

  it('contains no ProGet, NetBird, or tunnel wiring anywhere in the workflow', () => {
    expect(raw).not.toMatch(/proget|netbird/i);
  });

  it('declares no reusable-workflow secrets beyond the tag input', () => {
    expect(Object.keys(doc.on)).toEqual(['push', 'workflow_call']);
    expect(doc.on.workflow_call.secrets).toBeUndefined();
  });

  it('is the only job besides release holding contents write', () => {
    for (const [name, job] of Object.entries(doc.jobs)) {
      const expected = name === 'release' || name === 'publish-artifacts' ? 'write' : 'read';
      expect(job.permissions.contents).toBe(expected);
    }
  });

  it('serializes same-version publications with a ref-keyed concurrency group', () => {
    const concurrency = doc.jobs['publish-artifacts'].concurrency;
    expect(concurrency.group).toMatch(/\$\{\{\s*github\.ref\s*\}\}/);
    expect(concurrency['cancel-in-progress']).toBe(false);
  });

  it('authenticates only with the built-in github token', () => {
    expect(doc.jobs['publish-artifacts'].env.GH_TOKEN).toBe('${{ github.token }}');
    for (const env of doc.jobs['publish-artifacts'].steps.map((step) => step.env || {})) {
      if (env.GH_TOKEN) {
        expect(env.GH_TOKEN).toBe('${{ github.token }}');
      }
    }
  });

  it('reads the target release version before uploading any asset', () => {
    const steps = doc.jobs['publish-artifacts'].steps;
    const viewIndex = steps.findIndex((step) => (step.run || '').includes('gh release view'));
    const uploadIndex = steps.findIndex((step) => (step.run || '').includes('gh release upload'));
    expect(viewIndex).toBeGreaterThanOrEqual(0);
    expect(uploadIndex).toBeGreaterThan(viewIndex);
    const viewScript = steps[viewIndex].run;
    expect(viewScript).toMatch(/RELEASE_TAG/);
    expect(viewScript).toMatch(/tagName/);
  });

  it('verifies every required asset and the provenance checksums before uploading', () => {
    const steps = doc.jobs['publish-artifacts'].steps;
    const verify = steps.find((step) => step.name === 'Verify required assets and checksums');
    expect(verify).toBeDefined();
    const script = verify.run;
    for (const file of [
      'dist/outlook-mcp-setup.exe',
      'dist/outlook-mcp_${VERSION}_amd64.deb',
      'dist/outlook-mcp-win-x64.exe',
      'dist/outlook-mcp-linux-x64',
      'dist/provenance/SHA256SUMS',
      'dist/provenance/outlook-mcp-${VERSION}-sbom.spdx.json',
    ]) {
      expect(script).toContain(file);
    }
    expect(script).toMatch(/sha256sum -c/);
  });

  it('uploads exactly the installer, provenance, and manifest assets to the release', () => {
    const script = uploadScripts(doc, 'publish-artifacts').join('\n');
    for (const asset of [
      'dist/outlook-mcp-setup.exe',
      '"dist/outlook-mcp_${VERSION}_amd64.deb"',
      'dist/provenance/SHA256SUMS',
      '"dist/provenance/outlook-mcp-${VERSION}-sbom.spdx.json"',
      'latest-stable.json',
    ]) {
      expect(script).toContain(asset);
    }
  });

  it('never re-uploads the binaries or Docker bundle already attached by the release job', () => {
    const uploadSteps = doc.jobs['publish-artifacts'].steps.filter((step) =>
      (step.run || '').includes('gh release upload')
    );
    expect(uploadSteps.length).toBeGreaterThan(0);
    for (const step of uploadSteps) {
      if (step.run.includes('release-manifest.js')) {
        // The manifest step uploads only latest-stable.json; its asset list
        // is the four-asset manifest contract, not an additional upload.
        const uploadLines = step.run
          .split('\n')
          .filter((line) => line.startsWith('gh release upload'));
        expect(uploadLines).toHaveLength(1);
        expect(uploadLines[0]).toBe(
          'gh release upload "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" latest-stable.json'
        );
        continue;
      }
      expect(step.run).not.toMatch(/outlook-mcp-win-x64\.exe|outlook-mcp-linux-x64|docker-image/);
    }
  });

  it('never overwrites an existing release asset', () => {
    expect(stepsScript(doc, 'publish-artifacts')).not.toMatch(/--clobber/);
  });

  it('targets the release explicitly through the trusted repository context', () => {
    const script = stepsScript(doc, 'publish-artifacts');
    const ghCommandCount = (script.match(/gh release (view|upload)/g) || []).length;
    expect(ghCommandCount).toBeGreaterThanOrEqual(3);
    expect((script.match(/--repo "\$GITHUB_REPOSITORY"/g) || []).length).toBe(ghCommandCount);
  });

  it('generates latest-stable.json with build/release-manifest.js and uploads it', () => {
    const script = stepsScript(doc, 'publish-artifacts');
    expect(script).toMatch(/node build\/release-manifest\.js/);
    expect(script).toMatch(/--repository "\$GITHUB_REPOSITORY"/);
    expect(script).toMatch(/< dist\/provenance\/SHA256SUMS/);
  });
});

describe('version.yml caller consistency', () => {
  let releaseDoc;
  let releaseRaw;
  let versionDoc;
  let versionRaw;

  beforeAll(() => {
    releaseDoc = loadWorkflow(RELEASE_WORKFLOW_PATH);
    releaseRaw = fs.readFileSync(RELEASE_WORKFLOW_PATH, 'utf8');
    versionDoc = loadWorkflow(VERSION_WORKFLOW_PATH);
    versionRaw = fs.readFileSync(VERSION_WORKFLOW_PATH, 'utf8');
  });

  it('declares no secrets in the reusable release workflow', () => {
    expect(releaseDoc.on.workflow_call.secrets).toBeUndefined();
    expect(releaseRaw).not.toMatch(/NETBIRD_SETUP_KEY|PROGET_API_KEY/i);
  });

  it('passes no secrets when calling the release pipeline', () => {
    expect(versionDoc.jobs.release.secrets).toBeUndefined();
    expect(versionRaw).not.toMatch(/NETBIRD_SETUP_KEY|PROGET_API_KEY/i);
  });

  it('still calls the release workflow with the selected version tag only', () => {
    expect(versionDoc.jobs.release.uses).toBe('./.github/workflows/release.yml');
    expect(versionDoc.jobs.release.needs).toEqual(['version']);
    expect(versionDoc.jobs.release.with.tag).toBe('${{ needs.version.outputs.tag }}');
  });

  it('keeps the github.token-only credential policy in both workflows', () => {
    expect(versionRaw).not.toMatch(/secrets\.[A-Z0-9_]*TOKEN/);
    expect(releaseRaw).not.toMatch(/secrets\.[A-Z0-9_]*TOKEN/);
  });
});
