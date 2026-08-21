const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadRuntimeEnv } = require('../../runtime/load-runtime-env');
const { VaultError } = require('../../runtime/vault-client');

describe('runtime/load-runtime-env', () => {
  const customHeaderValue = 'fake-header-value';

  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm365-runtime-env-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function writeEnv(content) {
    const envPath = path.join(tempDir, '.env');
    fs.writeFileSync(envPath, content, 'utf8');
    return envPath;
  }

  it('keeps Vault disabled and falls back cleanly when VAULT_ADDR is absent', async () => {
    const env = {};
    const result = await loadRuntimeEnv({ env, envPath: path.join(tempDir, 'missing.env') });

    expect(result.vault).toEqual({ enabled: false, loaded: 0 });
    expect(env).toEqual({});
  });

  it('keeps the custom header value out of bootstrap summaries and KV mappings', async () => {
    const env = {
      VAULT_ADDR: 'https://vault.example.test',
      VAULT_CUSTOM_HEADER_NAME: 'X-ACCESS-TOKEN',
      VAULT_CUSTOM_HEADER_VALUE: customHeaderValue,
    };
    const loadVault = jest.fn().mockResolvedValue({
      source: 'token',
      values: {
        VAULT_CUSTOM_HEADER_VALUE: 'value-from-kv-must-be-ignored',
      },
    });

    const result = await loadRuntimeEnv({ env, loadVaultEnvironment: loadVault });

    expect(env.VAULT_CUSTOM_HEADER_VALUE).toBe(customHeaderValue);
    expect(JSON.stringify(result)).not.toContain(customHeaderValue);
    expect(JSON.stringify(result)).not.toContain('value-from-kv-must-be-ignored');
  });

  it('loads the adjacent .env when Vault is not configured', async () => {
    const env = {};
    const envPath = writeEnv(
      'MS_CLIENT_ID=file-client-id\nMS_CLIENT_SECRET=opaque-client-secret\nMS_TENANT_ID=file-tenant-id\n'
    );

    await loadRuntimeEnv({ env, envPath });

    expect(env).toEqual({
      MS_CLIENT_ID: 'file-client-id',
      MS_CLIENT_SECRET: 'opaque-client-secret',
      MS_TENANT_ID: 'file-tenant-id',
    });
  });

  it('enforces process/MCP values over Vault, and Vault over adjacent .env values', async () => {
    const env = {
      VAULT_ADDR: 'https://vault.example.test',
      MS_CLIENT_ID: 'process-client-id',
      MS_AUTHORITY_HOST: 'https://process.example.test',
    };
    const envPath = writeEnv(
      [
        'MS_CLIENT_ID=file-client-id',
        'MS_CLIENT_SECRET=file-client-secret',
        'MS_TENANT_ID=file-tenant-id',
        'MS_AUTHORITY_HOST=https://file.example.test',
      ].join('\n')
    );
    const loadVault = jest.fn().mockResolvedValue({
      source: 'oidc',
      values: {
        MS_CLIENT_ID: 'vault-client-id',
        MS_CLIENT_SECRET: 'vault-client-secret',
        MS_TENANT_ID: 'vault-tenant-id',
        MS_AUTHORITY_HOST: 'https://vault.example.test',
        UNRELATED_FIELD: 'ignored',
      },
    });

    await loadRuntimeEnv({ env, envPath, loadVaultEnvironment: loadVault });

    expect(env.MS_CLIENT_ID).toBe('process-client-id');
    expect(env.MS_CLIENT_SECRET).toBe('vault-client-secret');
    expect(env.MS_TENANT_ID).toBe('vault-tenant-id');
    expect(env.MS_AUTHORITY_HOST).toBe('https://process.example.test');
    expect(env.UNRELATED_FIELD).toBeUndefined();
    expect(loadVault).toHaveBeenCalledTimes(1);
  });

  it('enforces process precedence across OUTLOOK/MS aliases when Vault is disabled', async () => {
    const env = { MS_CLIENT_ID: 'process-client-id' };
    const envPath = writeEnv('OUTLOOK_CLIENT_ID=file-client-id\n');

    await loadRuntimeEnv({ env, envPath });

    expect(env.MS_CLIENT_ID).toBe('process-client-id');
    expect(env.OUTLOOK_CLIENT_ID).toBeUndefined();
  });

  it('lets Vault replace file values across an OAuth alias group', async () => {
    const env = { VAULT_ADDR: 'https://vault.example.test' };
    const envPath = writeEnv('OUTLOOK_CLIENT_ID=file-client-id\n');
    const loadVault = jest.fn().mockResolvedValue({ values: { MS_CLIENT_ID: 'vault-client-id' } });

    await loadRuntimeEnv({ env, envPath, loadVaultEnvironment: loadVault });

    expect(env.OUTLOOK_CLIENT_ID).toBeUndefined();
    expect(env.MS_CLIENT_ID).toBe('vault-client-id');
  });

  it('fails with an actionable error when configured Vault is unreachable or unauthorized', async () => {
    const env = { VAULT_ADDR: 'https://vault.example.test' };
    const loadVault = jest
      .fn()
      .mockRejectedValue(
        new VaultError(
          'Unable to reach Vault. Check VAULT_ADDR and intranet/VPN connectivity.',
          'VAULT_NETWORK_ERROR'
        )
      );

    await expect(loadRuntimeEnv({ env, loadVaultEnvironment: loadVault })).rejects.toMatchObject({
      code: 'VAULT_NETWORK_ERROR',
    });
    await expect(loadRuntimeEnv({ env, loadVaultEnvironment: loadVault })).rejects.toThrow(
      'intranet/VPN'
    );
  });
});
