const { composeEmail } = require('../../signature/composer');
const { emailTools } = require('../../email');
const { hasManagedSignature } = require('../../email/graph-message-flow');

const logo = {
  contentId: 'brand-logo',
  fileName: 'logo.png',
  contentType: 'image/png',
  contentBytes: 'aGVsbG8=',
};
const signatures = {
  default: { name: 'default', html: '<p>Default</p>', images: [] },
  work: { name: 'work', html: '<p>Work<img src="cid:brand-logo" /></p>', images: [logo] },
};
const store = {
  get: jest.fn((name) => Promise.resolve(signatures[name] || null)),
  getDefault: jest.fn(() => Promise.resolve(signatures.default)),
};

beforeEach(() => jest.clearAllMocks());

test('resolves opt-out, named override, and default in precedence order', async () => {
  const optedOut = await composeEmail(
    { body: 'Plain', signatureName: 'work', includeSignature: false },
    store
  );
  const named = await composeEmail(
    { body: '<p>Body</p>', isHtml: true, signatureName: 'work' },
    store
  );
  const fallback = await composeEmail({ body: 'Body' }, store);

  expect(optedOut).toEqual({
    body: 'Plain',
    contentType: 'text',
    attachments: [],
    hasSignature: false,
  });
  expect(named.hasSignature).toBe(true);
  expect(named.body).toContain('<p>Work<img src="cid:brand-logo" /></p>');
  expect(named.attachments).toEqual([
    {
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: 'logo.png',
      contentType: 'image/png',
      contentId: 'brand-logo',
      isInline: true,
      contentBytes: 'aGVsbG8=',
    },
  ]);
  expect(fallback.body).toContain('<p>Default</p>');
  expect(store.getDefault).toHaveBeenCalledTimes(1);
});

test('uses explicit composition metadata instead of caller-controlled marker text', () => {
  expect(
    hasManagedSignature({
      body: 'Unsigned data-outlook-mcp-signature= collision',
      hasSignature: false,
    })
  ).toBe(false);
});

test('escapes text, appends the signature once, and sanitizes stored HTML again', async () => {
  store.get.mockResolvedValueOnce({
    name: 'unsafe',
    html: '<p onclick="bad()">Safe<script>bad()</script></p>',
    images: [],
  });

  const result = await composeEmail(
    { body: '<hello>\nworld & all', signatureName: 'unsafe' },
    store
  );

  expect(result.contentType).toBe('html');
  expect(result.body).toContain('&lt;hello&gt;<br />world &amp; all');
  expect(result.body.match(/data-outlook-mcp-signature/g)).toHaveLength(1);
  expect(result.body).toContain('<p>Safe</p>');
  expect(result.body).not.toContain('onclick');
  expect(result.body).not.toContain('script');
});

test('rejects an unknown override instead of falling back', async () => {
  await expect(composeEmail({ body: 'Body', signatureName: 'missing' }, store)).rejects.toThrow(
    'Signature not found: missing'
  );
  expect(store.getDefault).not.toHaveBeenCalled();
});

test.each(['send-email', 'draft-email'])('%s exposes signature selection inputs', (name) => {
  const properties = emailTools.find((tool) => tool.name === name).inputSchema.properties;
  expect(properties.signatureName.type).toBe('string');
  expect(properties.includeSignature.type).toBe('boolean');
});
