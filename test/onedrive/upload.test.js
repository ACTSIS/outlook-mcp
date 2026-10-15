const handleUpload = require('../../onedrive/upload');
const { callGraphAPI } = require('../../utils/graph-api');
const { ensureAuthenticated } = require('../../auth');

jest.mock('../../utils/graph-api');
jest.mock('../../auth');

describe('handleUpload', () => {
  const mockAccessToken = 'dummy_access_token';
  const endpoint = 'me/drive/root:/Prueba/file.txt:/content';
  const uploadedItem = {
    id: 'item-1',
    name: 'file.txt',
    size: 42,
    webUrl: 'https://example-sharepoint/file.txt',
  };

  beforeEach(() => {
    callGraphAPI.mockClear();
    ensureAuthenticated.mockClear();
    callGraphAPI.mockResolvedValue(uploadedItem);
    ensureAuthenticated.mockResolvedValue(mockAccessToken);
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    console.error.mockRestore();
  });

  describe('validation (preserved behavior)', () => {
    test('still requires a path', async () => {
      const result = await handleUpload({ content: 'hello' });
      expect(callGraphAPI).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain('Path is required');
    });

    test('still requires content', async () => {
      const result = await handleUpload({ path: '/Prueba/file.txt' });
      expect(callGraphAPI).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain('Content is required');
    });
  });

  describe('raw content delivery (issue #41)', () => {
    test('sends text content verbatim with text/plain Content-Type, without JSON wrapping', async () => {
      const content = '<html>"quoted" &\nnewline</html>';

      const result = await handleUpload({ path: '/Prueba/file.txt', content });

      expect(ensureAuthenticated).toHaveBeenCalledTimes(1);
      expect(callGraphAPI).toHaveBeenCalledWith(
        mockAccessToken,
        'PUT',
        endpoint,
        null,
        { '@microsoft.graph.conflictBehavior': 'rename' },
        { rawBody: content, contentType: 'text/plain' }
      );
      expect(result.content[0].text).toContain('Successfully uploaded');
    });

    test('still sends conflictBehavior to the Graph endpoint', async () => {
      await handleUpload({
        path: '/Prueba/file.txt',
        content: 'hello',
        conflictBehavior: 'replace',
      });

      expect(callGraphAPI).toHaveBeenCalledWith(
        mockAccessToken,
        'PUT',
        endpoint,
        null,
        { '@microsoft.graph.conflictBehavior': 'replace' },
        expect.anything()
      );
    });

    test('still reports the too-large error for files over the simple-upload threshold', async () => {
      const big = Buffer.alloc(4 * 1024 * 1024 + 1).toString('utf8');

      const result = await handleUpload({ path: '/Prueba/big.txt', content: big });

      expect(callGraphAPI).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain('Use onedrive-upload-large');
    });
  });

  describe('base64 binary delivery (issue #41)', () => {
    test('decodes base64 content to a Buffer sent as application/octet-stream', async () => {
      // Header bytes of a fictitious binary file (not valid UTF-8)
      const bytes = Buffer.from([0x50, 0x4b, 0x00, 0xff]);
      const encoded = bytes.toString('base64');
      const path = '/Prueba/file.bin';
      const endpointBin = 'me/drive/root:/Prueba/file.bin:/content';

      await handleUpload({ path, content: encoded, base64: true });

      expect(callGraphAPI).toHaveBeenCalledWith(
        mockAccessToken,
        'PUT',
        endpointBin,
        null,
        { '@microsoft.graph.conflictBehavior': 'rename' },
        { rawBody: expect.any(Buffer), contentType: 'application/octet-stream' }
      );
      const rawBody = callGraphAPI.mock.calls[0][5].rawBody;
      expect(Array.from(rawBody)).toEqual([0x50, 0x4b, 0x00, 0xff]);
    });

    test('routes on decoded byte size, so a large base64 text payload still uses simple upload', async () => {
      // ~4.5MB of base64 characters decodes to ~3.3MB of bytes (< threshold)
      const encoded = 'a'.repeat(4 * 1024 * 1024 + 'x'.length);

      const result = await handleUpload({
        path: '/Prueba/file.bin',
        content: encoded,
        base64: true,
      });

      expect(callGraphAPI).toHaveBeenCalled();
      expect(result.content[0].text).toContain('Successfully uploaded');
    });

    test('still rejects decoded content over the simple-upload threshold', async () => {
      // base64 encodes 3 bytes as 4 chars: use ceil((threshold+1)/3)*4 chars so
      // the decoded payload exceeds 4MB
      const encoded = 'a'.repeat(Math.ceil((4 * 1024 * 1024 + 1) / 3) * 4);

      const result = await handleUpload({
        path: '/Prueba/file.bin',
        content: encoded,
        base64: true,
      });

      expect(callGraphAPI).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain('Use onedrive-upload-large');
    });
  });

  describe('error handling (preserved behavior)', () => {
    test('maps authentication failures to the authenticate message', async () => {
      ensureAuthenticated.mockRejectedValue(new Error('Authentication required'));

      const result = await handleUpload({ path: '/Prueba/file.txt', content: 'hello' });

      expect(result.content[0].text).toContain(
        "Authentication required. Please use the 'authenticate' tool first."
      );
    });

    test('reports Graph errors with the upload message', async () => {
      callGraphAPI.mockRejectedValue(new Error('API call failed with status 403: denied'));

      const result = await handleUpload({ path: '/Prueba/file.txt', content: 'hello' });

      expect(result.content[0].text).toBe(
        'Error uploading file: API call failed with status 403: denied'
      );
    });

    test('reports an upload without response as failed', async () => {
      callGraphAPI.mockResolvedValue({});

      const result = await handleUpload({ path: '/Prueba/file.txt', content: 'hello' });

      expect(result.content[0].text).toContain('Upload failed - no response from server.');
    });
  });
});
