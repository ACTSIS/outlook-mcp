const { spawn } = require('child_process');
const path = require('path');
const { emailTools } = require('../email');

const REPO_ROOT = path.join(__dirname, '..');

function sendRequest(child, message) {
  return new Promise((resolve, reject) => {
    let buffer = '';

    const cleanup = () => {
      child.stdout.off('data', onData);
      child.off('error', onError);
      child.off('close', onClose);
      clearTimeout(timer);
    };
    const onData = (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;

        let response;
        try {
          response = JSON.parse(line);
        } catch (error) {
          cleanup();
          reject(error);
          return;
        }

        cleanup();
        resolve(response);
        return;
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = (code, signal) => {
      cleanup();
      reject(new Error(`MCP child closed before responding (code ${code}, signal ${signal})`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for MCP response'));
    }, 10000);

    child.stdout.on('data', onData);
    child.once('error', onError);
    child.once('close', onClose);
    child.stdin.write(`${JSON.stringify(message)}\n`);
  });
}

describe('MCP handshake', () => {
  let child;

  afterEach(async () => {
    if (!child) return;

    const processToStop = child;
    child = null;
    if (processToStop.exitCode !== null) return;

    await new Promise((resolve) => {
      processToStop.once('close', resolve);
      // The server intentionally ignores SIGTERM, so force-close this test child.
      processToStop.kill('SIGKILL');
    });
  });

  it('handles initialize and tools/list through the real SDK server', async () => {
    child = spawn(process.execPath, ['index.js'], {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const initializeResponse = await sendRequest(child, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'index-test', version: '1.0.0' },
      },
    });

    expect(initializeResponse).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        capabilities: { tools: {} },
      },
    });
    expect(initializeResponse.result.protocolVersion).toBe('2025-11-25');

    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`
    );

    const toolsResponse = await sendRequest(child, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    });

    expect(toolsResponse).toMatchObject({ jsonrpc: '2.0', id: 2 });
    const listedTool = toolsResponse.result.tools.find((tool) => tool.name === 'list-emails');
    const declaredTool = emailTools.find((tool) => tool.name === 'list-emails');
    expect(listedTool).toEqual({
      name: declaredTool.name,
      description: declaredTool.description,
      inputSchema: declaredTool.inputSchema,
    });
  });
});
