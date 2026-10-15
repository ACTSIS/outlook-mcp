const handleUploadLarge = require('../../onedrive/upload-large');
const { callGraphAPI } = require('../../utils/graph-api');
const { ensureAuthenticated } = require('../../auth');

jest.mock('../../utils/graph-api');
jest.mock('../../auth');
jest.mock('https');

const https = require('https');

function mockChunkResponses(sessionUploadUrl, chunks) {
  https.request.mockImplementation((url, options, callback) => {
    const { EventEmitter } = require('events');
    const request = new EventEmitter();
    request.write = jest.fn();
    request.end = jest.fn();
    request.destroy = jest.fn();
    request.setTimeout = jest.fn();

    // Every https.request inside handleUploadLarge is a chunk PUT whose URL is
    // the session upload URL (session creation goes through the mocked
    // callGraphAPI). Emit a deterministic chunk response.
    const chunkIndex = chunks.findIndex((c) => c.uploadUrl === url);
    process.nextTick(() => {
      const res = new EventEmitter();
      res.statusCode = 201;
      res.headers = {};
      callback(res);
      const body =
        chunkIndex + 1 < chunks.length
          ? '{}'
          : JSON.stringify({ id: 'item-1', name: 'big.bin', size: 6, webUrl: 'u' });
      res.emit('data', Buffer.from(body));
      res.emit('end');
    });

    return request;
  });
}

describe('handleUploadLarge', () => {
  const mockAccessToken = 'dummy_access_token';
  const sessionUploadUrl = 'https://graph.example/uploadSession1';

  beforeEach(() => {
    callGraphAPI.mockClear();
    ensureAuthenticated.mockClear();
    https.request.mockClear();
    callGraphAPI.mockResolvedValue({ uploadUrl: sessionUploadUrl });
    ensureAuthenticated.mockResolvedValue(mockAccessToken);
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    console.error.mockRestore();
  });

  test('still creates an upload session and PUTs raw chunks with Content-Range (preserved behavior)', async () => {
    mockChunkResponses(sessionUploadUrl, [{ uploadUrl: sessionUploadUrl }]);

    const result = await handleUploadLarge({ path: '/Prueba/big.txt', content: 'hello' });

    expect(callGraphAPI).toHaveBeenCalledWith(
      mockAccessToken,
      'POST',
      'me/drive/root:/Prueba/big.txt:/createUploadSession',
      {
        item: {
          '@microsoft.graph.conflictBehavior': 'rename',
        },
      }
    );
    const chunkCall = https.request.mock.calls.find((c) => c[0] === sessionUploadUrl);
    expect(chunkCall[1].headers['Content-Range']).toBe('bytes 0-4/5');
    expect(https.request.mock.results[0].value.write).toHaveBeenCalledWith(Buffer.from('hello'));
    expect(result.content[0].text).toContain('Successfully uploaded');
  });

  test('decodes the base64 flag before chunking so binary payloads stay intact', async () => {
    mockChunkResponses(sessionUploadUrl, [{ uploadUrl: sessionUploadUrl }]);

    const bytes = Buffer.from([0x50, 0x4b, 0x00, 0xff]);

    await handleUploadLarge({
      path: '/Prueba/big.bin',
      content: bytes.toString('base64'),
      base64: true,
    });

    const chunkCall = https.request.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0] === sessionUploadUrl
    );
    const write = https.request.mock.results[0].value.write;
    expect(write).toHaveBeenCalledTimes(1);
    const written = write.mock.calls[0][0];
    expect(Buffer.isBuffer(written)).toBe(true);
    expect(Array.from(written)).toEqual(Array.from(bytes));
    expect(chunkCall[1].headers['Content-Range']).toBe('bytes 0-3/4');
  });
});
