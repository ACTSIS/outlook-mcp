/**
 * Authentication module for Outlook MCP server
 */
const tokenManager = require('./token-manager');
const TokenStorage = require('./token-storage');
const { authTools } = require('./tools');

// Singleton TokenStorage instance for automatic token refresh
const tokenStorage = new TokenStorage();

/**
 * Refresh the live authentication configuration after explicit Vault setup.
 * The singleton is created before MCP tools run, so replacing process.env
 * alone would otherwise leave stale credentials and endpoints in memory.
 * @returns {object} Refreshed TokenStorage configuration
 */
function refreshRuntimeConfiguration() {
  return tokenStorage.refreshRuntimeConfiguration();
}

/**
 * Ensures the user is authenticated and returns an access token.
 * Automatically refreshes expired tokens using the refresh_token grant.
 * @param {boolean} forceNew - Whether to force a new authentication
 * @returns {Promise<string>} - Access token
 * @throws {Error} - If authentication fails
 */
async function ensureAuthenticated(forceNew = false) {
  if (forceNew) {
    throw new Error('Authentication required');
  }

  // Use TokenStorage which handles automatic refresh
  const accessToken = await tokenStorage.getValidAccessToken();
  if (!accessToken) {
    throw new Error('Authentication required');
  }

  return accessToken;
}

module.exports = {
  tokenManager,
  tokenStorage,
  authTools,
  ensureAuthenticated,
  refreshRuntimeConfiguration,
};
