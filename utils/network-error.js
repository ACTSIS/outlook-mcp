const DEFAULT_PORTS = Object.freeze({
  'http:': '80',
  'https:': '443',
});

const TLS_CERTIFICATE_ERROR_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

function isNonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Return only the safe, non-query portion of an HTTP(S) endpoint.
 * @param {string|URL} endpoint - Endpoint to format
 * @returns {string} Scheme, host, optional non-default port, and pathname
 */
function formatSafeEndpoint(endpoint) {
  let parsed;

  try {
    parsed = endpoint instanceof URL ? endpoint : new URL(String(endpoint));
  } catch {
    return '[invalid endpoint]';
  }

  const port =
    parsed.port && parsed.port !== DEFAULT_PORTS[parsed.protocol] ? `:${parsed.port}` : '';
  return `${parsed.protocol}//${parsed.hostname}${port}${parsed.pathname || '/'}`;
}

function normalizeErrorCode(error, fallbackCode) {
  const rawCode = error && typeof error.code === 'string' ? error.code.trim() : '';
  if (!rawCode) return fallbackCode;
  return rawCode.replace(/[^a-z0-9_.-]/gi, '_').slice(0, 80);
}

function getErrorStatus(error) {
  if (error && Number.isFinite(error.status)) return error.status;
  if (error && Number.isFinite(error.statusCode)) return error.statusCode;
  return undefined;
}

function getErrorMessage(error, fallbackMessage = 'The request failed.') {
  if (error && typeof error.message === 'string' && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return fallbackMessage;
}

function sanitizeErrorMessage(error, secrets = [], fallbackMessage) {
  let message = getErrorMessage(error, fallbackMessage);
  const values = [...new Set(secrets.filter(isNonEmpty))].sort(
    (left, right) => right.length - left.length
  );

  for (const secret of values) message = message.split(secret).join('[REDACTED]');

  return message.replace(/https?:\/\/[^\s<>"']+/gi, (url) => formatSafeEndpoint(url));
}

function isCertificateError(error, code, message) {
  if (TLS_CERTIFICATE_ERROR_CODES.has(String(code).toUpperCase())) return true;
  return /self-signed certificate|certificate in certificate chain|unable to verify|certificate has expired|certificate.*altname|altname.*certificate/i.test(
    message
  );
}

/**
 * Wrap a request error with the operation and safe endpoint that caused it.
 * The original error code and HTTP status are retained when available.
 * @param {string} operation - Human-readable operation name
 * @param {string|URL} endpoint - Target endpoint
 * @param {Error|string} error - Original error
 * @param {object} [options] - Redaction and fallback options
 * @returns {Error} Contextualized safe error
 */
function createContextualError(operation, endpoint, error, options = {}) {
  const fallbackCode = options.fallbackCode || 'NETWORK_REQUEST_FAILED';
  const code = normalizeErrorCode(error, fallbackCode);
  const status = getErrorStatus(error);
  const safeMessage = sanitizeErrorMessage(error, options.secrets || [], options.fallbackMessage);
  const safeTarget = formatSafeEndpoint(endpoint);
  const certificateHint = isCertificateError(error, code, safeMessage)
    ? '. Check network TLS trust/proxy configuration.'
    : '';
  const wrapped = new Error(
    `${operation} failed while connecting to ${safeTarget}: ${safeMessage} (${code})${certificateHint}`
  );

  wrapped.code = code;
  if (status !== undefined) wrapped.status = status;
  if (error && typeof error.isPermanentEntraAuthFailure === 'boolean') {
    wrapped.isPermanentEntraAuthFailure = error.isPermanentEntraAuthFailure;
  }
  wrapped.contextualOperation = operation;
  wrapped.contextualTarget = safeTarget;
  return wrapped;
}

function isContextualError(error, operation) {
  return Boolean(error && error.contextualOperation === operation);
}

module.exports = {
  createContextualError,
  formatSafeEndpoint,
  isContextualError,
  sanitizeErrorMessage,
};
