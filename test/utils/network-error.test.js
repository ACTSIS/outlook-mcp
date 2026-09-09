const {
  createContextualError,
  formatSafeEndpoint,
  sanitizeErrorMessage,
} = require('../../utils/network-error');

describe('utils/network-error', () => {
  it('formats an endpoint without query, hash, credentials, or default port', () => {
    expect(
      formatSafeEndpoint(
        'https://user:password@login.example.test:443/tenant/token?client_secret=secret#fragment'
      )
    ).toBe('https://login.example.test/tenant/token');
    expect(formatSafeEndpoint('https://vault.example.test:8443/v1/kv?token=secret')).toBe(
      'https://vault.example.test:8443/v1/kv'
    );
  });

  it('contextualizes certificate errors while redacting secrets and preserving metadata', () => {
    const original = Object.assign(
      new Error(
        'self-signed certificate in certificate chain at https://login.example.test/token?code=auth-code'
      ),
      { code: 'SELF_SIGNED_CERT_IN_CHAIN', status: 502 }
    );

    const contextual = createContextualError(
      'Microsoft Graph token exchange',
      'https://login.example.test/common/oauth2/v2.0/token?client_secret=client-secret#fragment',
      original,
      { secrets: ['client-secret', 'auth-code'] }
    );

    expect(contextual).toMatchObject({
      code: 'SELF_SIGNED_CERT_IN_CHAIN',
      status: 502,
      contextualOperation: 'Microsoft Graph token exchange',
      contextualTarget: 'https://login.example.test/common/oauth2/v2.0/token',
    });
    expect(contextual.message).toContain(
      'Microsoft Graph token exchange failed while connecting to https://login.example.test/common/oauth2/v2.0/token'
    );
    expect(contextual.message).toContain('self-signed certificate in certificate chain');
    expect(contextual.message).toContain('Check network TLS trust/proxy configuration.');
    expect(contextual.message).not.toContain('client-secret');
    expect(contextual.message).not.toContain('auth-code');
    expect(contextual.message).not.toContain('?');
    expect(contextual.message).not.toContain('#fragment');
  });

  it('redacts values and strips URL queries from raw messages', () => {
    const safe = sanitizeErrorMessage(
      new Error('request https://vault.example.test:8443/v1/kv?token=secret failed'),
      ['secret']
    );

    expect(safe).toBe('request https://vault.example.test:8443/v1/kv failed');
  });

  it('does not suggest TLS trust changes for unrelated network errors', () => {
    const contextual = createContextualError(
      'Vault token lookup',
      'https://vault.example.test/v1/auth/token/lookup-self',
      Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' })
    );

    expect(contextual.message).not.toContain('TLS trust/proxy configuration');
  });
});
