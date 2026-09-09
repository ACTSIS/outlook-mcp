const { configureSystemCa } = require('../../runtime/system-ca');

describe('runtime/system-ca', () => {
  it('merges bundled and system certificates without duplicates', () => {
    const getCACertificates = jest.fn((type) => {
      if (type === 'default') return ['bundled-root', 'shared-root'];
      if (type === 'system') return ['shared-root', 'windows-root'];
      return [];
    });
    const setDefaultCACertificates = jest.fn();

    expect(configureSystemCa({ getCACertificates, setDefaultCACertificates })).toBe(true);

    expect(getCACertificates).toHaveBeenNthCalledWith(1, 'default');
    expect(getCACertificates).toHaveBeenNthCalledWith(2, 'system');
    expect(setDefaultCACertificates).toHaveBeenCalledWith([
      'bundled-root',
      'shared-root',
      'windows-root',
    ]);
  });

  it('does nothing when the runtime lacks the certificate APIs', () => {
    expect(configureSystemCa({})).toBe(false);
  });

  it('does nothing when certificate APIs fail or return no PEM values', () => {
    const setDefaultCACertificates = jest.fn();
    const failingTls = {
      getCACertificates: jest.fn((type) => {
        if (type === 'default') return ['bundled-root'];
        throw new Error('unsupported');
      }),
      setDefaultCACertificates,
    };

    expect(configureSystemCa(failingTls)).toBe(false);
    expect(setDefaultCACertificates).not.toHaveBeenCalled();
  });

  it('keeps TLS setup best-effort when setting the CA list fails', () => {
    const tlsModule = {
      getCACertificates: jest.fn(() => ['root']),
      setDefaultCACertificates: jest.fn(() => {
        throw new Error('unsupported');
      }),
    };

    expect(configureSystemCa(tlsModule)).toBe(false);
  });
});
