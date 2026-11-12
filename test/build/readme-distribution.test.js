const fs = require('fs');
const path = require('path');

const README_PATH = path.join(__dirname, '..', '..', 'README.md');

describe('README distribution documentation', () => {
  let readme;

  beforeAll(() => {
    readme = fs.readFileSync(README_PATH, 'utf8');
  });

  test('corrects the Linux baseline to glibc >= 2.39 / Ubuntu 24.04+', () => {
    expect(readme).toMatch(/glibc\s*[≥>]\s*2\.39/);
    expect(readme).toMatch(/Ubuntu\s+24\.04\s*\+/);
    expect(readme).not.toMatch(/glibc\s*2\.28\s*\+/);
  });

  test('documents the GitHub Releases installation channel without any artifact server', () => {
    expect(readme).toMatch(/###\s+Installation from GitHub Releases/);
    expect(readme).not.toMatch(/proget|artifacts\.actsis\.com|netbird/i);
    expect(readme).toContain(
      'https://github.com/ACTSIS/outlook-mcp/releases/download/v<version>/<file>'
    );
    expect(readme).toContain(
      'https://github.com/ACTSIS/outlook-mcp/releases/latest/download/latest-stable.json'
    );
  });

  test('documents the versioned assets, checksums, SBOM, and release notes', () => {
    expect(readme).toContain('SHA256SUMS');
    expect(readme).toMatch(/sbom\.spdx\.json/i);
    expect(readme).toContain('/releases/tag/v<version>');
  });

  test('documents Windows NSIS installer steps', () => {
    expect(readme).toContain('outlook-mcp-setup.exe');
    expect(readme).toMatch(/Program\s+Files.*outlook-mcp/);
    expect(readme).toMatch(/PATH/i);
  });

  test('documents Linux .deb installer steps', () => {
    expect(readme).toContain('outlook-mcp_<version>_amd64.deb');
    expect(readme).toContain('/usr/bin/outlook-mcp');
    expect(readme).toMatch(/dpkg\s+-i/);
    expect(readme).toMatch(/apt\s+install/);
  });

  test('documents credential configuration for installed binaries', () => {
    expect(readme).toMatch(/MCP-client\s*`env`\s*block/);
    expect(readme).toMatch(/Vault/i);
    expect(readme).toMatch(/not\s+user-writable/i);
  });

  test('warns that the installed executable must not be renamed', () => {
    expect(readme).toMatch(/do\s+not\s+rename/i);
    expect(readme).toContain('outlook-mcp.exe');
  });
});
