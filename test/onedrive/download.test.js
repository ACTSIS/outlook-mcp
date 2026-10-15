const handleDownload = require('../../onedrive/download');
const { callGraphAPI, callGraphAPIDownload } = require('../../utils/graph-api');
const { ensureAuthenticated } = require('../../auth');

jest.mock('../../utils/graph-api');
jest.mock('../../auth');

describe('handleDownload', () => {
  const mockAccessToken = 'dummy_access_token';
  const mockItem = {
    id: 'item-1',
    name: 'Document.docx',
    size: 9412,
  };

  beforeEach(() => {
    callGraphAPI.mockClear();
    callGraphAPIDownload.mockClear();
    callGraphAPI.mockResolvedValue(mockItem);
    callGraphAPIDownload.mockResolvedValue('https://example-sharepoint/pre-authenticated-url');
    ensureAuthenticated.mockReset();
    ensureAuthenticated.mockResolvedValue(mockAccessToken);
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    console.error.mockRestore();
  });

  describe('validation (preserved behavior)', () => {
    test('still requires either itemId or path', async () => {
      const result = await handleDownload({});
      expect(callGraphAPI).not.toHaveBeenCalled();
      expect(callGraphAPIDownload).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain('Either itemId or path is required');
    });
  });

  describe('download URL via /content 302 redirect (issue #41)', () => {
    test('obtains the pre-authenticated URL from the /content redirect instead of downloadUrl', async () => {
      const result = await handleDownload({ path: '/Documentos/Document.docx' });

      expect(ensureAuthenticated).toHaveBeenCalledTimes(1);
      expect(callGraphAPI).toHaveBeenCalledWith(
        mockAccessToken,
        'GET',
        'me/drive/root:/Documentos/Document.docx',
        null,
        expect.objectContaining({ $select: expect.stringContaining('size') })
      );
      expect(callGraphAPIDownload).toHaveBeenCalledWith(
        mockAccessToken,
        'me/drive/root:/Documentos/Document.docx:/content'
      );
      expect(result.content[0].text).toContain('Download URL for "Document.docx"');
      expect(result.content[0].text).toContain('https://example-sharepoint/pre-authenticated-url');
    });

    test('encodes drive path segments without double-encoding the colon syntax', async () => {
      await handleDownload({ path: '/Mis Archivos/Reporte 2026.html' });

      expect(callGraphAPI).toHaveBeenCalledWith(
        mockAccessToken,
        'GET',
        'me/drive/root:/Mis%20Archivos/Reporte%202026.html',
        null,
        expect.anything()
      );
      expect(callGraphAPIDownload).toHaveBeenCalledWith(
        mockAccessToken,
        'me/drive/root:/Mis%20Archivos/Reporte%202026.html:/content'
      );
    });

    test('uses the item content endpoint for itemId downloads', async () => {
      const result = await handleDownload({ itemId: 'item-1' });

      expect(callGraphAPI).toHaveBeenCalledWith(
        mockAccessToken,
        'GET',
        'me/drive/items/item-1',
        null,
        expect.anything()
      );
      expect(callGraphAPIDownload).toHaveBeenCalledWith(
        mockAccessToken,
        'me/drive/items/item-1/content'
      );
      expect(result.content[0].text).toContain('Download URL for "Document.docx"');
    });
  });

  describe('preserved behaviors', () => {
    test('still reports folders as not directly downloadable', async () => {
      callGraphAPI.mockResolvedValue({
        id: 'folder-1',
        name: 'Carpeta',
        folder: { childCount: 2 },
      });

      const result = await handleDownload({ path: '/Carpeta' });

      expect(callGraphAPIDownload).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain('is a folder and cannot be downloaded directly');
    });

    test('maps authentication failures to the authenticate message', async () => {
      ensureAuthenticated.mockRejectedValue(new Error('Authentication required'));

      const result = await handleDownload({ path: '/Documentos/Document.docx' });

      expect(result.content[0].text).toContain(
        "Authentication required. Please use the 'authenticate' tool first."
      );
    });

    test('reports download errors with the original message', async () => {
      callGraphAPIDownload.mockRejectedValue(
        new Error('Download request failed with status 404: not found')
      );

      const result = await handleDownload({ path: '/Documentos/Document.docx' });

      expect(result.content[0].text).toBe(
        'Error getting download URL: Download request failed with status 404: not found'
      );
    });

    test('still reports items without metadata as not found', async () => {
      callGraphAPI.mockResolvedValue(null);

      const result = await handleDownload({ path: '/nope.txt' });

      expect(result.content[0].text).toBe('File not found.');
    });
  });
});
