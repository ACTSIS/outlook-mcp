/**
 * Typed Microsoft Entra OAuth error classification shared by active token
 * acquisition and refresh boundaries.
 */

const PERMANENT_OAUTH_ERROR_CODES = new Set([
  'invalid_grant',
  'invalid_client',
  'unauthorized_client',
  'invalid_request',
  'invalid_scope',
  'unsupported_grant_type',
]);
const NON_PERMANENT_OAUTH_ERROR_CODES = new Set([
  'access_denied',
  'temporarily_unavailable',
  'server_error',
]);
const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429]);

function normalizeErrorCode(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : null;
}

function getOAuthErrorCode(payload) {
  if (typeof payload === 'string') return normalizeErrorCode(payload);
  if (!payload || typeof payload !== 'object') return null;

  for (const candidate of [
    payload.error,
    payload.error_code,
    payload.errorCode,
    payload.oauthError,
    payload.code,
  ]) {
    const normalized = normalizeErrorCode(candidate);
    if (normalized) return normalized;
  }

  return null;
}

function getErrorDescription(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const description = payload.error_description || payload.errorDescription || payload.message;
  return typeof description === 'string' ? description : '';
}

function hasAadstsCode(value) {
  return typeof value === 'string' && /\baadsts\d+\b/i.test(value);
}

/**
 * Return true only for a typed token-endpoint rejection that means the
 * configured Entra grant or client is permanently unusable.
 *
 * HTTP status alone is deliberately insufficient: Vault and Graph API
 * authorization errors, transient gateway responses, and transport failures
 * must never invalidate the Vault identity cache.
 *
 * @param {object|string} error - Error or token endpoint response
 * @param {number} [status] - HTTP status when the response is separate
 * @returns {boolean}
 */
function isPermanentEntraOAuthFailure(error, status) {
  const responseStatus = Number.isInteger(status) ? status : error && error.status;
  if (responseStatus >= 500 || TRANSIENT_HTTP_STATUSES.has(responseStatus)) return false;

  const code = getOAuthErrorCode(error);
  const description = getErrorDescription(error);
  // Authorization endpoint denials may carry an AADSTS description even
  // though the user, rather than the configured client, ended the flow.
  if (
    (code && NON_PERMANENT_OAUTH_ERROR_CODES.has(code)) ||
    code === 'aadsts65004' ||
    /\baadsts65004\b/i.test(description)
  ) {
    return false;
  }

  if (error && error.isPermanentEntraAuthFailure === true) {
    return responseStatus === undefined || (responseStatus >= 400 && responseStatus < 500);
  }

  if (code && (PERMANENT_OAUTH_ERROR_CODES.has(code) || /^aadsts\d+$/.test(code))) {
    return responseStatus === undefined || (responseStatus >= 400 && responseStatus < 500);
  }

  if (responseStatus < 400 || responseStatus >= 500) return false;

  return hasAadstsCode(description);
}

class EntraOAuthError extends Error {
  /**
   * @param {string} message - Safe provider error description
   * @param {object} details - Stable error metadata
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'EntraOAuthError';
    if (details.code) this.code = details.code;
    if (details.status !== undefined) this.status = details.status;
    this.isPermanentEntraAuthFailure = details.permanent === true;
  }
}

/**
 * Build a typed error from a token-endpoint response without retaining the
 * response body or logging any credential-bearing fields.
 *
 * @param {object} responseBody - Parsed Microsoft response
 * @param {number} status - HTTP status
 * @param {string} context - Operation label for fallback messages
 * @returns {EntraOAuthError}
 */
function createEntraOAuthError(responseBody, status, context) {
  const code = getOAuthErrorCode(responseBody);
  const description = getErrorDescription(responseBody)
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 500);
  const message = description || `${context} failed with status ${status}`;
  const permanent = isPermanentEntraOAuthFailure(responseBody, status);

  return new EntraOAuthError(message, {
    code: code || 'ENTRA_OAUTH_ERROR',
    status,
    permanent,
  });
}

module.exports = {
  EntraOAuthError,
  PERMANENT_OAUTH_ERROR_CODES,
  createEntraOAuthError,
  getOAuthErrorCode,
  isPermanentEntraOAuthFailure,
};
