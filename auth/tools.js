/**
 * Authentication-related tools for the Outlook MCP server
 */
const config = require('../config');
const tokenManager = require('./token-manager');
const authServerManager = require('./auth-server-manager');

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

  const serverStatus = await authServerManager.startAuthServer();

  if (!serverStatus.running) {
    return {
      content: [
        {
          type: 'text',
          text: `Authentication server could not be started. ${serverStatus.message}`,
        },
      ],
    };
  }

  // For real authentication, generate an auth URL and instruct the user to visit it
  const authUrl = `${config.AUTH_CONFIG.authServerUrl}/auth?client_id=${config.AUTH_CONFIG.clientId}`;

  return {
    content: [
      {
        type: 'text',
        text: `${serverStatus.message}\n\nAuthentication required. Please visit the following URL to authenticate with Microsoft: ${authUrl}\n\nAfter authentication, tell me when you are done and I can stop the authentication server.`,
      },
    ],
  };
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

  const serverStatus = await authServerManager.startAuthServer();

  if (!serverStatus.running) {
    return {
      content: [
        {
          type: 'text',
          text: `Authentication server could not be started. ${serverStatus.message}`,
        },
      ],
    };
  }

  // For real authentication, generate an auth URL and instruct the user to visit it
  const authUrl = `${config.AUTH_CONFIG.authServerUrl}/auth/flow`;

  return {
    content: [
      {
        type: 'text',
        text: `${serverStatus.message}\n\nFlow authentication required. Please visit the following URL to authenticate with Power Automate: ${authUrl}\n\nAfter authentication, tell me when you are done and I can stop the authentication server.`,
      },
    ],
  };
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
    description: 'Stop the temporary Outlook authentication callback server started by authenticate',
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
  handleCheckAuthStatus,
  handleStopAuthServer,
};
