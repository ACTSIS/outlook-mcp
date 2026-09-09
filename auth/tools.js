/**
 * Authentication-related tools for the Outlook MCP server
 */
const config = require('../config');
const tokenManager = require('./token-manager');
const authServerManager = require('./auth-server-manager');

function buildAuthenticationResponse(authUrl, provider, serverStatus) {
  const serverMessage = serverStatus.running
    ? 'The authentication callback server is ready.'
    : `The authentication callback server could not be confirmed: ${serverStatus.message}`;

  return {
    content: [
      { type: 'text', text: authUrl },
      {
        type: 'text',
        text: [
          'The browser was not opened automatically.',
          'Copy and open the URL shown above in your browser.',
          serverMessage,
          `Complete ${provider} sign-in, then tell me when you are done.`,
        ].join('\n'),
      },
    ],
  };
}

function isNonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasOAuthCredentials() {
  return Boolean(
    config.AUTH_CONFIG &&
    isNonEmpty(config.AUTH_CONFIG.clientId) &&
    isNonEmpty(config.AUTH_CONFIG.clientSecret)
  );
}

function getVaultDisabledMessage() {
  return [
    'Microsoft OAuth credentials are not configured and Vault is disabled.',
    'Set MS_CLIENT_ID and MS_CLIENT_SECRET (or the OUTLOOK_* equivalents) in the MCP environment,',
    'or configure VAULT_ADDR, then try authentication again.',
  ].join(' ');
}

function getVaultCredentialsMissingMessage() {
  return [
    'Vault setup completed, but the required Microsoft OAuth credentials were not found in the',
    'allowlisted Vault values. Configure the Vault secret or provide the credentials through the',
    'MCP environment, then try authentication again.',
  ].join(' ');
}

/**
 * About tool handler
 * @returns {object} - MCP response
 */
async function handleAbout() {
  return {
    content: [
      {
        type: 'text',
        text: `M365 Assistant MCP Server v${config.SERVER_VERSION}\n\nProvides access to Microsoft 365 services through Microsoft Graph API:\n- Outlook (email, calendar, folders, rules)\n- OneDrive (files, folders, sharing)\n- Power Automate (flows, environments, runs)\n\nModular architecture for improved maintainability.`,
      },
    ],
  };
}

/**
 * Authentication tool handler
 * @param {object} args - Tool arguments
 * @returns {object} - MCP response
 */
async function handleAuthenticate(_args) {
  // For test mode, create a test token
  if (config.USE_TEST_MODE) {
    // Create a test token with a 1-hour expiry
    tokenManager.createTestTokens();

    return {
      content: [
        {
          type: 'text',
          text: 'Successfully authenticated with Microsoft Graph API (test mode)',
        },
      ],
    };
  }

  const configurationError = await ensureOAuthConfiguration();
  if (configurationError) {
    return { content: [{ type: 'text', text: configurationError }] };
  }

  const serverStatus = await authServerManager.startAuthServer();
  const authUrl = `${config.AUTH_CONFIG.authServerUrl}/auth?client_id=${config.AUTH_CONFIG.clientId}`;

  return buildAuthenticationResponse(authUrl, 'Microsoft', serverStatus);
}

/**
 * Stop the callback server when the authentication flow is complete.
 * @returns {Promise<object>} - MCP response
 */
async function handleStopAuthServer() {
  const stopStatus = await authServerManager.stopAuthServer();

  return {
    content: [{ type: 'text', text: stopStatus.message }],
  };
}

/**
 * Power Automate Flow authentication tool handler
 * @param {object} _args - Tool arguments
 * @returns {object} - MCP response
 */
async function handleAuthenticateFlow(_args) {
  // For test mode, create a test token
  if (config.USE_TEST_MODE) {
    tokenManager.createTestTokens();

    return {
      content: [
        {
          type: 'text',
          text: 'Successfully authenticated with Power Automate (test mode)',
        },
      ],
    };
  }

  const configurationError = await ensureOAuthConfiguration();
  if (configurationError) {
    return { content: [{ type: 'text', text: configurationError }] };
  }

  const serverStatus = await authServerManager.startAuthServer();
  const authUrl = `${config.AUTH_CONFIG.authServerUrl}/auth/flow`;

  return buildAuthenticationResponse(authUrl, 'Power Automate', serverStatus);
}

function getSafeVaultSetupError(error) {
  const rawCode = error && typeof error.code === 'string' ? error.code : 'VAULT_SETUP_FAILED';
  const code = rawCode.replace(/[^a-z0-9_]/gi, '_').slice(0, 80);
  return `Vault setup did not complete (${code}). Call setup-vault again after checking Vault connectivity and configuration.`;
}

async function runExplicitVaultSetup() {
  const { loadRuntimeEnv } = require('../runtime/load-runtime-env');
  const result = await loadRuntimeEnv({ force: true, vaultSetup: true });
  const vault = result && result.vault ? result.vault : {};

  if (vault.enabled && !vault.setupRequired) {
    const { refreshRuntimeConfiguration } = require('./index');
    if (typeof refreshRuntimeConfiguration === 'function') refreshRuntimeConfiguration();
  }

  return vault;
}

/**
 * Prepare credentials before either Microsoft authentication flow starts.
 * Missing credentials may be supplied by an explicit Vault setup, but a
 * callback server must never start with an empty client_id URL.
 * @returns {Promise<string|null>} Safe error text, or null when configured
 */
async function ensureOAuthConfiguration() {
  if (hasOAuthCredentials()) return null;

  let vaultConfig;
  try {
    const { getVaultConfig } = require('../runtime/vault-client');
    vaultConfig = getVaultConfig();
  } catch (error) {
    return getSafeVaultSetupError(error);
  }

  if (!vaultConfig.enabled) return getVaultDisabledMessage();

  try {
    const vault = await runExplicitVaultSetup();
    if (!vault.enabled) return getVaultDisabledMessage();
    if (vault.setupRequired) {
      return 'Vault setup is still required. Call setup-vault again after checking the Vault configuration.';
    }
  } catch (error) {
    return getSafeVaultSetupError(error);
  }

  return hasOAuthCredentials() ? null : getVaultCredentialsMissingMessage();
}

/**
 * Explicitly perform the one-time Vault OIDC setup for the current MCP
 * process. This intentionally bypasses the inherited bootstrap marker.
 * @returns {Promise<object>} Safe MCP response without tokens or KV values
 */
async function handleSetupVault() {
  try {
    const vault = await runExplicitVaultSetup();

    if (!vault.enabled) {
      return {
        content: [
          {
            type: 'text',
            text: 'Vault is disabled. Set VAULT_ADDR in the MCP environment, then call setup-vault again.',
          },
        ],
      };
    }

    if (vault.setupRequired) {
      return {
        content: [
          {
            type: 'text',
            text: 'Vault setup is still required. Call setup-vault again after checking the Vault configuration.',
          },
        ],
      };
    }

    const cacheWarning = vault.cache && vault.cache.saved === false;
    const text = cacheWarning
      ? 'Vault setup completed for this process, but the Vault identity cache could not be saved. Another setup may be required after restart. No secrets were returned.'
      : `Vault setup completed and the current process was refreshed (${vault.loaded || 0} runtime values loaded). No secrets were returned.`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: getSafeVaultSetupError(error) }] };
  }
}

/**
 * Check authentication status tool handler
 * @returns {object} - MCP response
 */
async function handleCheckAuthStatus() {
  console.error('[CHECK-AUTH-STATUS] Starting authentication status check');

  // Lazy loading avoids the auth/index.js -> auth/tools.js circular import
  // while still using the singleton TokenStorage instance at call time.
  const { tokenStorage } = require('./index');
  const accessToken = await tokenStorage.getValidAccessToken();

  console.error(`[CHECK-AUTH-STATUS] Valid access token: ${accessToken ? 'YES' : 'NO'}`);

  if (!accessToken) {
    return {
      content: [{ type: 'text', text: 'Not authenticated' }],
    };
  }

  return {
    content: [{ type: 'text', text: 'Authenticated and ready' }],
  };
}

// Tool definitions
const authTools = [
  {
    name: 'about',
    description: 'Returns information about this M365 Assistant server',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: handleAbout,
  },
  {
    name: 'authenticate',
    description: 'Authenticate with Microsoft Graph API to access Outlook data',
    inputSchema: {
      type: 'object',
      properties: {
        force: {
          type: 'boolean',
          description: 'Force re-authentication even if already authenticated',
        },
      },
      required: [],
    },
    handler: handleAuthenticate,
  },
  {
    name: 'setup-vault',
    description:
      'Run the one-time Vault OIDC setup, cache the Vault identity, and refresh this MCP process. Use this after a permanent Microsoft Entra authentication failure; normal startup never opens the Vault browser.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: handleSetupVault,
  },
  {
    name: 'check-auth-status',
    description: 'Check the current authentication status with Microsoft Graph API',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: handleCheckAuthStatus,
  },
  {
    name: 'authenticate-flow',
    description: 'Authenticate with Power Automate to access flows and environments',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: handleAuthenticateFlow,
  },
  {
    name: 'stop-auth-server',
    description:
      'Stop the temporary Outlook authentication callback server started by authenticate',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: handleStopAuthServer,
  },
];

module.exports = {
  authTools,
  handleAbout,
  handleAuthenticate,
  handleAuthenticateFlow,
  handleSetupVault,
  handleCheckAuthStatus,
  handleStopAuthServer,
};
