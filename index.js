#!/usr/bin/env node
/**
 * M365 Assistant MCP Server - Main entry point
 *
 * A Model Context Protocol server that provides access to
 * Microsoft 365 services (Outlook, OneDrive, Power Automate)
 * through the Microsoft Graph API and Flow API.
 */
// Load environment variables from the repository's .env file. MCP clients may
// launch this process with a different working directory.
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const config = require('./config');

// Import module tools
const { authTools } = require('./auth');
const { calendarTools } = require('./calendar');
const { emailTools } = require('./email');
const { folderTools } = require('./folder');
const { rulesTools } = require('./rules');
const { onedriveTools } = require('./onedrive');
const { powerAutomateTools } = require('./power-automate');
const { signatureTools } = require('./signature');

// Log startup information
console.error(`STARTING ${config.SERVER_NAME.toUpperCase()} MCP SERVER`);
console.error(`Test mode is ${config.USE_TEST_MODE ? 'enabled' : 'disabled'}`);

// Combine all tools
const TOOLS = [
  ...authTools,
  ...calendarTools,
  ...emailTools,
  ...folderTools,
  ...rulesTools,
  ...onedriveTools,
  ...powerAutomateTools,
  ...signatureTools,
];

// Create server with tools capabilities
const server = new Server(
  { name: config.SERVER_NAME, version: config.SERVER_VERSION },
  {
    capabilities: {
      tools: {},
    },
  }
);

// The SDK registers initialize automatically. Register application handlers with
// the supported request schemas so they are dispatched by the SDK protocol.
server.setRequestHandler(ListToolsRequestSchema, async () => {
  console.error('TOOLS LIST REQUEST');
  console.error(`TOOLS COUNT: ${TOOLS.length}`);
  console.error(`TOOLS NAMES: ${TOOLS.map((t) => t.name).join(', ')}`);

  return {
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params || {};

  console.error(`TOOL CALL: ${name}`);

  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool || !tool.handler) {
    throw new Error(`Tool not found: ${name}`);
  }

  return tool.handler(args);
});

// Make the script executable
process.on('SIGTERM', () => {
  console.error('SIGTERM received but staying alive');
});

/**
 * Start the MCP stdio server.
 * Exported so the dispatcher (bin/m365-mcp.js) and direct runs share one path.
 * @returns {Promise<void>}
 */
function startMCP() {
  const transport = new StdioServerTransport();
  return server
    .connect(transport)
    .then(() => console.error(`${config.SERVER_NAME} connected and listening`))
    .catch((error) => {
      console.error(`Connection error: ${error.message}`);
      process.exit(1);
    });
}

// Start the server only when this file is the entry point (direct run or npm
// script). When required by the dispatcher, the dispatcher calls startMCP().
if (require.main === module) {
  startMCP();
}

module.exports = { startMCP };
