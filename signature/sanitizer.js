const sanitizeHtml = require('sanitize-html');
const ID = /^[A-Za-z0-9._-]{1,64}$/;
const MIME = new Set(['image/png', 'image/jpeg', 'image/gif']);
const LIMITS = { html: 100 * 1024, images: 10, image: 1024 * 1024, total: 2 * 1024 * 1024 };
const TAGS = 'p br div span strong b em i u a img table tbody tr td'.split(' ');
// prettier-ignore
const STYLES = { color: [/^#[0-9a-f]{3,8}$/i, /^[a-z]+$/i], 'font-family': [/^[\w ,'-]+$/], 'font-size': [/^\d+(?:px|pt|em|rem|%)$/], 'text-align': [/^(?:left|right|center|justify)$/] };
function fail(message) {
  throw new Error(`Invalid signature: ${message}`);
}
function decodeBase64(value) {
  const base64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  if (typeof value !== 'string' || !base64.test(value))
    fail('image contentBytes must be valid base64');
  return Buffer.from(value, 'base64');
}
function validateSignature(candidate) {
  if (!candidate || !ID.test(candidate.name || ''))
    fail('name must use 1-64 safe ASCII characters');
  if (typeof candidate.html !== 'string' || Buffer.byteLength(candidate.html) > LIMITS.html) {
    fail('HTML exceeds 100 KiB');
  }
  const images = candidate.images ?? [];
  if (!Array.isArray(images) || images.length > LIMITS.images) fail('too many images');
  const byId = new Map();
  let total = 0;
  const normalizedImages = images.map((image) => {
    if (!ID.test(image?.contentId || '') || byId.has(image.contentId))
      fail('duplicate or invalid content ID');
    if (!MIME.has(image.contentType)) fail('unsupported image MIME type');
    if (typeof image.fileName !== 'string' || !/^[^/\\]{1,128}$/.test(image.fileName))
      fail('invalid image filename');
    const bytes = decodeBase64(image.contentBytes);
    if (bytes.length > LIMITS.image) fail('image exceeds 1 MiB');
    total += bytes.length;
    byId.set(image.contentId, image);
    return { ...image };
  });
  if (total > LIMITS.total) fail('images exceed 2 MiB');
  const referenced = new Set();
  const html = sanitizeHtml(candidate.html, {
    allowedTags: TAGS,
    allowedAttributes: { a: ['href'], img: ['src', 'alt', 'width', 'height'], '*': ['style'] },
    allowedSchemes: ['mailto', 'tel', 'cid'],
    allowedSchemesByTag: { img: ['cid'], a: ['mailto', 'tel'] },
    allowedSchemesAppliedToAttributes: ['href', 'src'],
    allowProtocolRelative: false,
    allowedStyles: { '*': STYLES },
    transformTags: {
      img: (tagName, attributes) => {
        const match = /^cid:([A-Za-z0-9._-]{1,64})$/.exec(attributes.src || '');
        if (!match) fail('image src must be a managed cid');
        referenced.add(match[1]);
        return { tagName, attribs: attributes };
      },
    },
  });
  if (referenced.size !== byId.size || [...referenced].some((id) => !byId.has(id))) {
    fail('CID references and managed images must match one-to-one');
  }
  return { name: candidate.name, html, images: normalizedImages };
}
module.exports = { LIMITS, validateSignature };
