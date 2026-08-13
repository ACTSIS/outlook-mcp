const { validateSignature } = require('../../signature/sanitizer');

const png = Buffer.from('png').toString('base64');
const valid = (overrides = {}) => ({
  name: 'work',
  html: '<p style="color: red">Regards <img src="cid:logo"></p>',
  images: [
    { contentId: 'logo', fileName: 'logo.png', contentType: 'image/png', contentBytes: png },
  ],
  ...overrides,
});

describe('signature validation', () => {
  it('keeps allowed formatting while removing executable markup and handlers', () => {
    const result = validateSignature(
      valid({
        html: '<p onclick="bad()"><strong>Hi</strong><script>bad()</script></p>',
        images: [],
      })
    );
    expect(result.html).toBe('<p><strong>Hi</strong></p>');
  });

  test.each(['https://example.com/logo.png', 'data:image/png;base64,eA=='])(
    'rejects external image source %s',
    (src) => expect(() => validateSignature(valid({ html: `<img src="${src}">` }))).toThrow(/cid/i)
  );

  test.each([
    ['invalid name', { name: 'bad name' }],
    ['unsupported MIME', { images: [{ ...valid().images[0], contentType: 'image/svg+xml' }] }],
    ['invalid base64', { images: [{ ...valid().images[0], contentBytes: '***' }] }],
    ['unbound CID', { html: '<img src="cid:missing">' }],
    ['unused image', { html: '<p>No logo</p>' }],
    ['duplicate image', { images: [valid().images[0], valid().images[0]] }],
  ])('rejects %s', (_label, overrides) => {
    expect(() => validateSignature(valid(overrides))).toThrow();
  });

  it('enforces configured count and size limits', () => {
    expect(() =>
      validateSignature(valid({ html: 'x'.repeat(100 * 1024 + 1), images: [] }))
    ).toThrow(/HTML/i);
    const oversized = {
      ...valid().images[0],
      contentBytes: Buffer.alloc(1024 * 1024 + 1).toString('base64'),
    };
    expect(() => validateSignature(valid({ images: [oversized] }))).toThrow(/image/i);
  });
});
