const { validateSignature } = require('./sanitizer');
const { signatureStore } = require('./index');

function contentTypeFor(body, isHtml) {
  if (isHtml === true) return 'html';
  if (isHtml === false) return 'text';
  return typeof body === 'string' && body.toLowerCase().includes('<html') ? 'html' : 'text';
}

function escapeText(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replace(/\r?\n/g, '<br />');
}

async function composeEmail(args, store = signatureStore) {
  const body = args.body ?? '';
  const contentType = contentTypeFor(body, args.isHtml);
  if (args.includeSignature === false) return { body, contentType, attachments: [] };

  const signature = args.signatureName
    ? await store.get(args.signatureName)
    : await store.getDefault();
  if (args.signatureName && !signature)
    throw new Error(`Signature not found: ${args.signatureName}`);
  if (!signature) return { body, contentType, attachments: [] };

  const safe = validateSignature(signature);
  const messageBody = contentType === 'html' ? body : escapeText(body);
  return {
    body: `${messageBody}<div data-outlook-mcp-signature="${safe.name}">${safe.html}</div>`,
    contentType: 'html',
    attachments: safe.images.map((image) => ({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: image.fileName,
      contentType: image.contentType,
      contentId: image.contentId,
      isInline: true,
      contentBytes: image.contentBytes,
    })),
  };
}

module.exports = { composeEmail, contentTypeFor };
