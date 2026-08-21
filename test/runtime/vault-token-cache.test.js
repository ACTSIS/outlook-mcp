const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  deleteVaultTokenCache,
  getVaultTokenCacheKey,
  getVaultTokenCachePath,
  readVaultTokenCache,
  writeVaultTokenCache,
} = require('../../runtime/vault-token-cache');

function createConfig(tokenCachePath, overrides = {}) {
  return {
    address: 'https://vault.example.test/',
    namespace: 'engineering',
    authMount: 'oidc',
    role: 'outlook-mcp-developer',
    tokenCachePath,
    ...overrides,
  };
}

describe('runtime/vault-token-cache', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm365-vault-cache-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('resolves platform defaults and the administrator/test override', () => {
    expect(
      getVaultTokenCachePath({
        platform: 'win32',
        env: { LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local' },
        homeDir: 'C:\\Users\\alice',
      })
    ).toBe('C:\\Users\\alice\\AppData\\Local\\m365-mcp\\vault-token.json');
    expect(
      getVaultTokenCachePath({
        platform: 'win32',
        env: { APPDATA: 'C:\\Users\\alice\\AppData\\Roaming' },
        homeDir: 'C:\\Users\\alice',
      })
    ).toBe('C:\\Users\\alice\\AppData\\Roaming\\m365-mcp\\vault-token.json');
    expect(
      getVaultTokenCachePath({ platform: 'win32', env: {}, homeDir: 'C:\\Users\\alice' })
    ).toBe('C:\\Users\\alice\\m365-mcp\\vault-token.json');
    expect(
      getVaultTokenCachePath({
        platform: 'linux',
        env: { XDG_CONFIG_HOME: '/home/alice/.config-custom' },
        homeDir: '/home/alice',
      })
    ).toBe('/home/alice/.config-custom/m365-mcp/vault-token.json');
    expect(getVaultTokenCachePath({ platform: 'linux', env: {}, homeDir: '/home/alice' })).toBe(
      '/home/alice/.config/m365-mcp/vault-token.json'
    );
    const overridePath = '/tmp/m365-vault-cache-override.json';
    expect(
      getVaultTokenCachePath({
        platform: 'linux',
        env: { VAULT_TOKEN_CACHE_PATH: overridePath },
        homeDir: '/home/alice',
      })
    ).toBe(overridePath);
  });

  it('writes an atomic versioned cache with only Vault token metadata', () => {
    const filePath = path.join(tempDir, 'nested', 'vault-token.json');
    const config = createConfig(filePath);

    expect(
      writeVaultTokenCache(
        config,
        'fake-vault-token',
        {
          expireTime: '2030-01-01T00:00:00Z',
          ttl: 3600,
          renewable: true,
          policies: ['default'],
          MS_CLIENT_SECRET: 'fake-client-secret',
        },
        { now: '2026-08-21T00:00:00Z', tempSuffix: 'test' }
      )
    ).toEqual({ saved: true });

    const raw = fs.readFileSync(filePath, 'utf8');
    const document = JSON.parse(raw);
    const entry = document.entries[getVaultTokenCacheKey(config)];

    expect(document.version).toBe(1);
    expect(Object.keys(entry).sort()).toEqual(
      ['expireTime', 'renewable', 'savedAt', 'token', 'ttl'].sort()
    );
    expect(entry).toEqual({
      token: 'fake-vault-token',
      expireTime: '2030-01-01T00:00:00Z',
      ttl: 3600,
      renewable: true,
      savedAt: '2026-08-21T00:00:00.000Z',
    });
    expect(raw).not.toContain('fake-client-secret');
    expect(raw).not.toContain('MS_CLIENT_SECRET');
    expect(fs.readdirSync(path.dirname(filePath))).toEqual(['vault-token.json']);

    if (process.platform !== 'win32') {
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    }
    expect(readVaultTokenCache(config)).toEqual(entry);
  });

  it('ignores and deletes malformed entries without exposing their content', () => {
    const filePath = path.join(tempDir, 'vault-token.json');
    const config = createConfig(filePath);
    const key = getVaultTokenCacheKey(config);
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        entries: {
          [key]: { token: 'fake-vault-token', renewable: 'yes', savedAt: 'not-a-date' },
        },
      }),
      'utf8'
    );

    expect(readVaultTokenCache(config)).toBeNull();
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('deletes only the matching Vault identity entry', () => {
    const filePath = path.join(tempDir, 'vault-token.json');
    const config = createConfig(filePath);
    const otherConfig = createConfig(filePath, { role: 'other-role' });

    writeVaultTokenCache(config, 'fake-vault-token', { renewable: false });
    writeVaultTokenCache(otherConfig, 'other-fake-token', { renewable: false });

    expect(deleteVaultTokenCache(config)).toEqual({ deleted: true });
    expect(readVaultTokenCache(config)).toBeNull();
    expect(readVaultTokenCache(otherConfig)).toMatchObject({ token: 'other-fake-token' });
  });
});
