/**
 * T21 (S4, S11, S12) — downloadable Docker image artifact in the release
 * pipeline.
 *
 * Threat/behavior contract from the delegated task:
 * - A dedicated `docker-image` job builds the committed Dockerfile at the
 *   EXACT release ref on linux/amd64 and tags it `outlook-mcp-http:<version>`
 *   plus `outlook-mcp-http:local` (the tag the Compose files reference).
 * - The distribution stays GitHub-only: never pushed to a registry, no
 *   `packages:write`, no new secrets, and the artifact name `docker-image`
 *   must NOT match the `artifact-*` and `installer-*` wildcards that the
 *   provenance and publisher jobs download, so the publisher payload stays
 *   byte-identical.
 * - The archive is produced with `docker image save` (a loadable image
 *   archive, never `docker export`), gzipped as
 *   `outlook-mcp-docker-image.tar.gz` with a SHA-256 sidecar.
 * - The release job waits for the image, verifies the sidecar checksum, and
 *   attaches the archive and checksum to the GitHub Release next to the two
 *   original binaries. The provenance `SHA256SUMS` payload keeps listing
 *   exactly the four product assets.
 * - Untrusted tags flow into scripts only through env vars (never `${{ }}`
 *   expression interpolation inside `run:`), scripts are fail-closed, and the
 *   temp directory is the runner's own temp, not a real runtime path.
 * - README documents the load commands for linux/amd64 and the fact that the
 *   artifact appears only after a tagged Release run (never dispatched here).
 */
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const WORKFLOW_PATH = path.join(__dirname, '..', '..', '.github', 'workflows', 'release.yml');
const README_PATH = path.join(__dirname, '..', '..', 'README.md');

function loadWorkflow() {
  return YAML.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
}

/** Join a job's run scripts into one string for contract assertions. */
function stepsScript(doc, jobName) {
  return doc.jobs[jobName].steps.map((step) => step.run || '').join('\n');
}

describe('docker-image release workflow (T21)', () => {
  let doc;
  let raw;

  beforeAll(() => {
    raw = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    doc = loadWorkflow();
  });

  describe('dedicated docker-image job', () => {
    it('exists as a separate job gated behind build, validation, and the secret scan', () => {
      expect(doc.jobs['docker-image']).toBeDefined();
      expect(doc.jobs['docker-image'].needs).toEqual(['build', 'validate', 'scan']);
      expect(doc.jobs['docker-image']['runs-on']).toBe('ubuntu-latest');
    });

    it('holds contents read only and never requests package write permissions', () => {
      const permissions = doc.jobs['docker-image'].permissions;
      expect(permissions).toEqual({ contents: 'read' });
      expect(raw).not.toMatch(/packages:\s*write/);
    });

    it('checks out the exact release ref, matching every other job', () => {
      const checkout = doc.jobs['docker-image'].steps.find(
        (step) => step.uses === 'actions/checkout@v4'
      );
      expect(checkout).toBeDefined();
      expect(checkout.with.ref).toBe('${{ inputs.tag || github.ref }}');
    });

    it('validates the tag against the package version with the existing release pattern', () => {
      const script = stepsScript(doc, 'docker-image');
      expect(script).toMatch(/RELEASE_TAG/);
      expect(script).toMatch(/package\.json.*version/);
    });

    it('supplies the untrusted tag through env or an already-validated variable, never expression interpolation inside run scripts', () => {
      const imageSteps = doc.jobs['docker-image'].steps.map((step) => step.run || '');
      for (const script of imageSteps) {
        if (!script) continue;
        expect(script).not.toMatch(/\$\{\{\s*(github\.|inputs\.|secrets\.)/);
        expect(script).toMatch(/set -euo pipefail/);
      }
      expect(
        doc.jobs['docker-image'].steps.every((step) => (step.run ? step.shell === 'bash' : true))
      ).toBe(true);
    });

    it('builds the committed Dockerfile at linux/amd64 with the version tag and the local tag the Compose files use', () => {
      const script = stepsScript(doc, 'docker-image');
      expect(script).toMatch(/docker build/);
      expect(script).toMatch(/--platform linux\/amd64/);
      expect(script).toMatch(/outlook-mcp-http:\$\{RELEASE_TAG#v\}/);
      expect(script).toMatch(/outlook-mcp-http:local/);
    });

    it('saves both tags with docker image save (never docker export) into one gzipped archive with a SHA-256 sidecar', () => {
      const script = stepsScript(doc, 'docker-image');
      expect(script).toMatch(/docker (image )?save/);
      expect(raw).not.toMatch(/docker\s+export/);
      expect(script).toMatch(/outlook-mcp-http:\$\{RELEASE_TAG#v\}/);
      expect(script).toMatch(/outlook-mcp-http:local/);
      expect(script).toMatch(/outlook-mcp-docker-image\.tar\.gz/);
      expect(script).toMatch(/gzip/);
      expect(script).toMatch(/sha256sum .*outlook-mcp-docker-image\.tar\.gz\.sha256/);
    });

    it('uses the runner-controlled temp directory, not a real runtime image path', () => {
      const script = stepsScript(doc, 'docker-image');
      expect(script).toMatch(/RUNNER_TEMP/);
      expect(script).not.toMatch(/\/app\/data\/oauth|bridge_oauth|outlook-mcp-tokens/);
    });

    it('uploads exactly the archive and its sidecar under the unique name docker-image with error and zero compression', () => {
      const upload = doc.jobs['docker-image'].steps.find(
        (step) => step.uses && step.uses.startsWith('actions/upload-artifact@')
      );
      expect(upload).toBeDefined();
      expect(upload.uses).toBe('actions/upload-artifact@v4');
      expect(upload.with.name).toBe('docker-image');
      const paths = upload.with.path
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      expect(paths).toHaveLength(2);
      expect(paths.filter((line) => /outlook-mcp-docker-image\.tar\.gz$/.test(line))).toHaveLength(
        1
      );
      expect(paths.filter((line) => /\.sha256/.test(line))).toHaveLength(1);
      expect(upload.with['if-no-files-found']).toBe('error');
      expect(upload.with['compression-level']).toBe(0);
    });

    it('never pushes the image to any registry', () => {
      expect(raw).not.toMatch(/docker push|ghcr|docker\.io/i);
    });

    it('embeds no secrets in the docker-image job', () => {
      const jobYaml = stepsScript(doc, 'docker-image');
      expect(jobYaml).not.toMatch(/secrets\./);
    });
  });

  describe('release attaches the image bundle (preserved gates intact)', () => {
    it('waits for the docker-image job in addition to the original gates', () => {
      const needs = doc.jobs.release.needs;
      expect(needs).toEqual(expect.arrayContaining(['build', 'validate', 'scan', 'docker-image']));
    });

    it('downloads the exact docker-image bundle and verifies its sidecar checksum before publishing', () => {
      const download = doc.jobs.release.steps.find(
        (step) =>
          step.uses &&
          step.uses.startsWith('actions/download-artifact@v4') &&
          step.with &&
          step.with.name === 'docker-image'
      );
      expect(download).toBeDefined();
      const script = stepsScript(doc, 'release');
      expect(script).toMatch(/sha256sum -c outlook-mcp-docker-image\.tar\.gz\.sha256/);
    });

    it('attaches the archive and sidecar to the release next to the two original binaries', () => {
      const script = stepsScript(doc, 'release');
      expect(script).toMatch(/outlook-mcp-win-x64\.exe/);
      expect(script).toMatch(/outlook-mcp-linux-x64/);
      expect(script).toMatch(/outlook-mcp-docker-image\.tar\.gz\.sha256/);
      expect(script).toMatch(/outlook-mcp-docker-image\.tar\.gz/);
      expect(script).toContain('$RELEASE_TAG');
    });

    it('keeps the release job permissions and secret policy unchanged', () => {
      expect(doc.jobs.release.permissions).toEqual({ contents: 'write' });
      expect(raw).not.toMatch(/OUTLOOK_CLIENT_SECRET|MS_CLIENT_SECRET/);
      expect(raw).not.toMatch(/\bsecrets\./);
    });
  });

  describe('provenance and publisher payloads stay the four product assets (image isolated)', () => {
    it('keeps the wildcard downloads exactly artifact-* and installer-*, which cannot absorb docker-image', () => {
      const jobs = ['provenance', 'publish-artifacts'];
      const patterns = [];
      for (const name of jobs) {
        for (const step of doc.jobs[name].steps) {
          if (
            step.uses &&
            step.uses.startsWith('actions/download-artifact@v4') &&
            step.with &&
            step.with.pattern
          ) {
            patterns.push(step.with.pattern);
          }
        }
      }
      expect(patterns).not.toHaveLength(0);
      for (const pattern of patterns) {
        expect(pattern).toMatch(/^(artifact-\*|installer-\*)$/);
      }
      expect('docker-image').toEqual(expect.not.stringMatching(/^artifact-|^installer-/));
    });

    it('keeps the provenance SHA256SUMS exactly the four product assets without the image', () => {
      const script = stepsScript(doc, 'provenance');
      expect(script).toMatch(
        /sha256sum outlook-mcp-win-x64\.exe outlook-mcp-linux-x64 outlook-mcp-setup\.exe "outlook-mcp_\$\{VERSION\}_amd64\.deb" > SHA256SUMS/
      );
      expect(script).not.toMatch(/docker-image/);
    });

    it('keeps the GitHub-only publisher free of registry secrets and free of the Docker bundle', () => {
      const script = stepsScript(doc, 'publish-artifacts');
      expect(script).toMatch(/outlook-mcp-setup\.exe,outlook-mcp_\$\{VERSION\}_amd64\.deb/);
      expect(script).not.toMatch(/docker-image|outlook-mcp-docker-image/);
      expect(raw).not.toMatch(/proget|netbird/i);
    });

    it('never requests registry package permissions', () => {
      expect(raw).not.toMatch(/packages:\s*write/);
      expect(raw).not.toMatch(/docker push|ghcr|docker\.io/i);
    });
  });

  describe('cleanup', () => {
    it('deletes the docker-image artifact alongside the existing names after consuming jobs finish', () => {
      expect(doc.jobs.cleanup.needs).toEqual(expect.arrayContaining(['docker-image', 'release']));
      const script = stepsScript(doc, 'cleanup');
      expect(script).toMatch(/docker-image/);
    });
  });
});

describe('README Docker image artifact documentation (T21)', () => {
  let readme;

  beforeAll(() => {
    readme = fs.readFileSync(README_PATH, 'utf8');
  });

  test('names the archive and sidecar and documents the linux/amd64 platform', () => {
    expect(readme).toMatch(/outlook-mcp-docker-image\.tar\.gz/);
    expect(readme).toMatch(/\.sha256/);
    expect(readme).toMatch(/linux\/amd64/);
  });

  test('documents loading the archive and using the local tag without rebuilding or pulling', () => {
    expect(readme).toMatch(/gzip -dc outlook-mcp-docker-image\.tar\.gz \| docker load/);
    expect(readme).toMatch(/--no-build/);
    expect(readme).toMatch(/--pull never/);
  });

  test('documents checksum verification from the download directory and the tagged-release-only availability', () => {
    expect(readme).toMatch(/download directory/i);
    expect(readme).toMatch(/tagged [Rr]elease run/);
    // This repository change is not dispatched by this task; no run happened.
    expect(readme).not.toMatch(/GHCR|ghcr\.io|docker hub/i);
  });

  test('states that the image contains no runtime configuration and the volume keeps persistence', () => {
    expect(readme).toMatch(/no (runtime configuration|credentials, tokens, or )/i);
  });
});
