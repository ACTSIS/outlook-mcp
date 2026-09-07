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

  test('has an intranet installation section for ACTSIS ProGet', () => {
    expect(readme).toMatch(/###\s+Intranet installation\s*\(ACTSIS ProGet\)/);
  });

  test('documents where ProGet assets and the manifest live', () => {
    expect(readme).toContain('https://artifacts.actsis.com');
    expect(readme).toContain('endpoints/outlook-mcp/content/releases/');
    expect(readme).toContain('releases/<version>/');
    expect(readme).toContain('releases/latest-stable.json');
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
