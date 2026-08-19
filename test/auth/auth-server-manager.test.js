const { EventEmitter } = require('events');

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));
jest.mock('http', () => ({
  get: jest.fn(),
}));

const { spawn } = require('child_process');
const http = require('http');
const manager = require('../../auth/auth-server-manager');

function configureHttpResponses(...responses) {
  http.get.mockImplementation((_url, callback) => {
    const response = responses.shift();
    const request = new EventEmitter();
    request.setTimeout = jest.fn();
    request.destroy = jest.fn();

    if (response.type === 'error') {
      process.nextTick(() => request.emit('error', new Error('not running')));
    } else {
      process.nextTick(() => {
        callback({ statusCode: response.statusCode, resume: jest.fn() });
      });
    }

    return request;
  });
}

describe('auth-server-manager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    configureHttpResponses({ type: 'success', statusCode: 200 });
  });

  it('reuses an already-running callback server', async () => {
    const result = await manager.startAuthServer();

    expect(result).toEqual({
      started: false,
      running: true,
      message: 'Authentication server is already running.',
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('starts the callback server and waits until it is reachable', async () => {
    const child = new EventEmitter();
    child.pid = 4321;
    child.unref = jest.fn();
    spawn.mockReturnValue(child);
    configureHttpResponses({ type: 'error' }, { type: 'success', statusCode: 200 });

    const result = await manager.startAuthServer();

    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining([expect.stringMatching(/outlook-auth-server\.js$/)]),
      expect.objectContaining({ detached: false, stdio: ['ignore', 'ignore', 'ignore'] })
    );
    expect(child.unref).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      started: true,
      running: true,
      pid: 4321,
      message: 'Authentication server started.',
    });
  });

  it('stops only a callback server owned by this process', async () => {
    const child = new EventEmitter();
    child.pid = 4322;
    child.unref = jest.fn();
    child.kill = jest.fn();
    spawn.mockReturnValue(child);
    configureHttpResponses({ type: 'error' }, { type: 'success', statusCode: 200 });

    await manager.startAuthServer();
    const result = await manager.stopAuthServer();

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(result).toEqual({
      stopped: true,
      message: 'Authentication server stopped (pid 4322).',
    });
  });
});
