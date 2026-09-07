/**
 * Structural checks for the Linux packaging surface (build/linux/).
 *
 * The packaging scripts themselves are validated with `bash -n` and the smoke
 * harness; this Jest suite only verifies the files exist, are syntactically
 * parseable, and carry the placeholders/shape mandated by the design.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const LINUX_DIR = path.join(ROOT, 'build/linux');

function read(relativePath) {
  return fs.readFileSync(path.join(LINUX_DIR, relativePath), 'utf8');
}

function bashCheck(scriptPath) {
  const result = spawnSync('bash', ['-n', path.join(LINUX_DIR, scriptPath)], {
    encoding: 'utf8',
  });
  return { ok: result.status === 0, stderr: result.stderr };
}

describe('build/linux packaging structure', () => {
  it('has a sha256-pinned toolchain lock for nfpm', () => {
    const lock = read('toolchain.lock.yaml');
    expect(lock).toMatch(/nfpm:/);
    expect(lock).toMatch(/version:\s*\S+/);
    expect(lock).toMatch(/url:\s*https:\/\/github\.com\/goreleaser\/nfpm\/releases\/download\/v/);
    expect(lock).toMatch(/sha256:\s*[a-f0-9]{64}/);
  });

  it('has maintainer scripts that are no-ops', () => {
    for (const script of ['scripts/postinst', 'scripts/postrm']) {
      const content = read(script);
      expect(content).toMatch(/^#!\/bin\/sh\n/);
      expect(content).toMatch(/exit 0/);
    }
  });

  it('has an nfpm template with the required placeholders', () => {
    const tmpl = read('nfpm.yaml.tmpl');
    expect(tmpl).toMatch(/name:\s*outlook-mcp/);
    expect(tmpl).toMatch(/arch:\s*amd64/);
    expect(tmpl).toMatch(/version:\s*'@VERSION@'/);
    expect(tmpl).toMatch(/dst:\s*\/usr\/bin\/outlook-mcp/);
    expect(tmpl).toMatch(/mode:\s*0755/);
    expect(tmpl).toMatch(/postinstall:/);
    expect(tmpl).toMatch(/postremove:/);
  });

  it('has bash scripts that pass `bash -n`', () => {
    for (const script of ['fetch-tools.sh', 'package-deb.sh', 'tests/container-smoke.sh']) {
      const { ok, stderr } = bashCheck(script);
      expect(ok).toBe(true);
      if (stderr) expect(stderr).toBe('');
    }
  });
});
