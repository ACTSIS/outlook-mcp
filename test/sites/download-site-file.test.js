const handleDownloadSiteFile = require('../../sites/download-site-file');
const { callGraphAPI, callGraphAPIDownload } = require('../../utils/graph-api');
const { ensureAuthenticated } = require('../../auth');

jest.mock('../../utils/graph-api');
jest.mock('../../auth');

describe('handleDownloadSiteFile', () => {
  const mockAccessToken = 'dummy_access_token';
  const mockFile = {
    id: 'item-1',
    name: 'disponibilidad.xlsx',
    size: 20480,
  };

  beforeEach(() => {
    callGraphAPI.mockClear();
    callGraphAPIDownload.mockClear();
    callGraphAPIDownload.mockResolvedValue('https://download.example/pre-authenticated');
    ensureAuthenticated.mockClear();
    ensureAuthenticated.mockResolvedValue(mockAccessToken);
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    console.error.mockRestore();
  });

  describe('validation', () => {
    test('requires either itemId or path before authenticating', async () => {
      const result = await handleDownloadSiteFile({ siteId: 'site-1' });

      expect(result.content[0].text).toContain('Either itemId or path is required');
      expect(ensureAuthenticated).not.toHaveBeenCalled();
      expect(callGraphAPI).not.toHaveBeenCalled();
    });

    test('requires a siteId before authenticating', async () => {
      const result = await handleDownloadSiteFile({ path: '/disponibilidad.xlsx' });

      expect(result.content[0].text).toContain('siteId is required');
      expect(ensureAuthenticated).not.toHaveBeenCalled();
      expect(callGraphAPI).not.toHaveBeenCalled();
    });
  });

  describe('successful retrieval', () => {
    test('resolves the download URL by item ID via the /content redirect', async () => {
      callGraphAPI.mockClear();
      callGraphAPI.mockResolvedValue(mockFile);

      const result = await handleDownloadSiteFile({ siteId: 'site-1', itemId: 'item-1' });

      expect(callGraphAPI).toHaveBeenCalledWith(
        mockAccessToken,
        'GET',
        'sites/site-1/drive/items/item-1',
        null,
        expect.objectContaining({
          $select: 'id,name,size,folder',
        })
      );
      expect(callGraphAPIDownload).toHaveBeenCalledWith(
        mockAccessToken,
        'sites/site-1/drive/items/item-1/content'
      );
      expect(result.content[0].text).toContain('disponibilidad.xlsx');
      expect(result.content[0].text).toContain('https://download.example/pre-authenticated');
    });

    test('resolves the download URL by url-encoded path and appends :/content', async () => {
      await handleDownloadSiteFile({
        siteId: 'site 1',
        path: '/Reportes 2026/disponibilidad.xlsx',
      });

      expect(callGraphAPI).toHaveBeenCalledWith(
        mockAccessToken,
        'GET',
        'sites/site%201/drive/root:/Reportes%202026/disponibilidad.xlsx',
        null,
        expect.anything()
      );
      expect(callGraphAPIDownload).toHaveBeenCalledWith(
        mockAccessToken,
        'sites/site%201/drive/root:/Reportes%202026/disponibilidad.xlsx:/content'
      );
    });
  });

  describe('folder and error handling', () => {
    test('refuses a folder without issuing a /content request', async () => {
      callGraphAPI.mockResolvedValue({ id: 'item-2', name: 'reportes', folder: { childCount: 4 } });

      const result = await handleDownloadSiteFile({ siteId: 'site-1', itemId: 'item-2' });

      expect(callGraphAPIDownload).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain('is a folder');
      expect(result.content[0].text).not.toContain('https://download.example');
    });

    test('surfaces the redirect error for items without a download URL', async () => {
      callGraphAPI.mockResolvedValue(mockFile);
      callGraphAPIDownload.mockRejectedValue(
        new Error('Download request failed with status 404: not found')
      );

      const result = await handleDownloadSiteFile({ siteId: 'site-1', itemId: 'item-1' });

      expect(result.content[0].text).toBe(
        'Error getting site file download URL: Download request failed with status 404: not found'
      );
    });

    test('requires authentication before resolving', async () => {
      ensureAuthenticated.mockRejectedValue(new Error('Authentication required'));

      const result = await handleDownloadSiteFile({ siteId: 'site-1', itemId: 'item-1' });

      expect(result.content[0].text).toContain("use the 'authenticate' tool first");
    });

    test('maps a Graph 403 to a site access denial without a fallback', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      callGraphAPI.mockRejectedValue(new Error('Microsoft Graph API error: status 403: Forbidden'));

      const result = await handleDownloadSiteFile({ siteId: 'site-1', path: '/secret.xlsx' });

      expect(result.content[0].text).toContain('403');
      expect(result.content[0].text).toContain('site-1');
    });

    test('returns a generic error for other Graph failures', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      callGraphAPI.mockRejectedValue(new Error('Microsoft Graph API error: status 500: Internal'));

      const result = await handleDownloadSiteFile({ siteId: 'site-1', itemId: 'item-1' });

      expect(result.content[0].text).toContain('Error getting site file download URL');
    });
  });
});
