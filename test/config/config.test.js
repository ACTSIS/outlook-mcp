const config = require('../../config');

describe('config constants', () => {
  test('ATTACHMENT_SIZE_WARNING_THRESHOLD should equal 10MB', () => {
    expect(config.ATTACHMENT_SIZE_WARNING_THRESHOLD).toBe(10 * 1024 * 1024);
  });
});
