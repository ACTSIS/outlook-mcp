const config = require('../../config');

describe('config constants', () => {
  test('ATTACHMENT_SIZE_WARNING_THRESHOLD should equal 10MB', () => {
    expect(config.ATTACHMENT_SIZE_WARNING_THRESHOLD).toBe(10 * 1024 * 1024);
  });

  test('uses MS_* credentials when OUTLOOK_* credentials are absent', () => {
    const originalOutlookClientId = process.env.OUTLOOK_CLIENT_ID;
    const originalOutlookClientSecret = process.env.OUTLOOK_CLIENT_SECRET;
    const originalMsClientId = process.env.MS_CLIENT_ID;
    const originalMsClientSecret = process.env.MS_CLIENT_SECRET;

    try {
      delete process.env.OUTLOOK_CLIENT_ID;
      delete process.env.OUTLOOK_CLIENT_SECRET;
      process.env.MS_CLIENT_ID = 'ms-client-id';
      process.env.MS_CLIENT_SECRET = 'ms-client-secret';

      jest.resetModules();
      jest.isolateModules(() => {
        const isolatedConfig = require('../../config');
        expect(isolatedConfig.AUTH_CONFIG.clientId).toBe('ms-client-id');
        expect(isolatedConfig.AUTH_CONFIG.clientSecret).toBe('ms-client-secret');
      });
    } finally {
      if (originalOutlookClientId === undefined) delete process.env.OUTLOOK_CLIENT_ID;
      else process.env.OUTLOOK_CLIENT_ID = originalOutlookClientId;
      if (originalOutlookClientSecret === undefined) delete process.env.OUTLOOK_CLIENT_SECRET;
      else process.env.OUTLOOK_CLIENT_SECRET = originalOutlookClientSecret;
      if (originalMsClientId === undefined) delete process.env.MS_CLIENT_ID;
      else process.env.MS_CLIENT_ID = originalMsClientId;
      if (originalMsClientSecret === undefined) delete process.env.MS_CLIENT_SECRET;
      else process.env.MS_CLIENT_SECRET = originalMsClientSecret;
    }
  });
});
