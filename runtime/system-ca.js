/**
 * Add the current operating-system certificate store to Node's default CA set.
 *
 * Node's bundled public roots remain in the set. Older Node versions or
 * runtimes without the certificate APIs are left unchanged.
 */
const tls = require('tls');

function getCertificates(tlsModule, type) {
  try {
    const certificates = tlsModule.getCACertificates(type);
    if (!Array.isArray(certificates)) return null;
    return certificates.filter((certificate) => typeof certificate === 'string' && certificate);
  } catch {
    return null;
  }
}

/**
 * Configure Node HTTPS to trust both bundled public roots and system roots.
 * Certificate verification remains enabled because this only changes the CA
 * set; it does not set rejectUnauthorized or disable TLS verification.
 *
 * @param {object} [tlsModule=tls] - Injectable TLS API for tests
 * @returns {boolean} Whether the default CA set was updated
 */
function configureSystemCa(tlsModule = tls) {
  if (
    !tlsModule ||
    typeof tlsModule.getCACertificates !== 'function' ||
    typeof tlsModule.setDefaultCACertificates !== 'function'
  ) {
    return false;
  }

  const defaultCertificates = getCertificates(tlsModule, 'default');
  const systemCertificates = getCertificates(tlsModule, 'system');
  if (!defaultCertificates || !systemCertificates) return false;

  const certificates = [...defaultCertificates, ...systemCertificates];
  const uniqueCertificates = [...new Set(certificates)];

  if (uniqueCertificates.length === 0) return false;

  try {
    tlsModule.setDefaultCACertificates(uniqueCertificates);
    return true;
  } catch {
    return false;
  }
}

module.exports = { configureSystemCa };
