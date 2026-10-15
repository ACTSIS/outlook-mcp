const handleListSiteFiles = require('../../sites/list-site-files');
const { callGraphAPI } = require('../../utils/graph-api');
const { ensureAuthenticated } = require('../../auth');
const config = require('../../config');

jest.mock('../../utils/graph-api');
jest.mock('../../auth');

describe('handleListSiteFiles', () => {
  const mockAccessToken = 'dummy_access_token';
  const mockItems = [
    {
      id: 'item-1',
      name: 'disponibilidad.xlsx',
      size: 20480,
      lastModifiedDateTime: '2026-10-10T08:00:00Z',
      webUrl: 'https://contoso.sharepoint.com/sites/sac/x.xlsx',
    },
    {
      id: 'item-2',
      name: 'reportes',
      folder: { childCount: 4 },
      lastModifiedDateTime: '2026-10-09T07:30:00Z',
      webUrl: 'https://contoso.sharepoint.com/sites/sac/reportes',
    },
  ];

  beforeEach(() => {
    callGraphAPI.mockClear();
    ensureAuthenticated.mockClear();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    console.error.mockRestore();
  });

  describe('validation', () => {
    test('requires a siteId before authenticating', async () => {
      const result = await handleListSiteFiles({});

      expect(result.content[0].text).toContain('siteId is required');
      expect(ensureAuthenticated).not.toHaveBeenCalled();
      expect(callGraphAPI).not.toHaveBeenCalled();
    });
  });

  describe('successful retrieval', () => {
    test('lists the default document library root', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      callGraphAPI.mockResolvedValue({ value: mockItems });

      const result = await handleListSiteFiles({ siteId: 'site-1' });

      expect(callGraphAPI).toHaveBeenCalledWith(
        mockAccessToken,
        'GET',
        'sites/site-1/drive/root/children',
        null,
        expect.objectContaining({
          $select: config.ONEDRIVE_SELECT_FIELDS,
          $orderby: 'name',
          $top: 25,
        })
      );
      expect(result.content[0].text).toContain('disponibilidad.xlsx');
      expect(result.content[0].text).toContain('[FOLDER] reportes');
    });

    test('lists a specific path segment with url-encoded site and path', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      callGraphAPI.mockResolvedValue({ value: mockItems });

      await handleListSiteFiles({ siteId: 'site 1', path: '/Reportes 2026/', count: 10 });

      expect(callGraphAPI).toHaveBeenCalledWith(
        mockAccessToken,
        'GET',
        'sites/site%201/drive/root:/Reportes%202026:/children',
        null,
        expect.objectContaining({ $top: 10 })
      );
    });

    test('keeps path separators when a multi-segment path is requested', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      callGraphAPI.mockResolvedValue({ value: mockItems });

      await handleListSiteFiles({ siteId: 'site-1', path: '/Reportes 2026/SAC/' });

      expect(callGraphAPI).toHaveBeenCalledWith(
        mockAccessToken,
        'GET',
        'sites/site-1/drive/root:/Reportes%202026/SAC:/children',
        null,
        expect.anything()
      );
    });

    test('caps the requested count at 50', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      callGraphAPI.mockResolvedValue({ value: [] });

      await handleListSiteFiles({ siteId: 'site-1', count: 999 });

      expect(callGraphAPI).toHaveBeenCalledWith(
        mockAccessToken,
        'GET',
        'sites/site-1/drive/root/children',
        null,
        expect.objectContaining({ $top: 50 })
      );
    });

    test('reports an empty folder without fabricating entries', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      callGraphAPI.mockResolvedValue({ value: [] });

      const result = await handleListSiteFiles({ siteId: 'site-1' });

      expect(result.content[0].text).toContain('No files found');
    });
  });

  describe('error handling', () => {
    test('requires authentication before listing', async () => {
      ensureAuthenticated.mockRejectedValue(new Error('Authentication required'));

      const result = await handleListSiteFiles({ siteId: 'site-1' });

      expect(result.content[0].text).toContain("use the 'authenticate' tool first");
    });

    test('maps a Graph 403 to a site access denial without a fallback', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      callGraphAPI.mockRejectedValue(new Error('Microsoft Graph API error: status 403: Forbidden'));

      const result = await handleListSiteFiles({ siteId: 'site-1' });

      expect(result.content[0].text).toContain('403');
      expect(result.content[0].text).toContain('site-1');
    });

    test('returns a generic error for other Graph failures', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      callGraphAPI.mockRejectedValue(new Error('Microsoft Graph API error: status 500: Internal'));

      const result = await handleListSiteFiles({ siteId: 'site-1' });

      expect(result.content[0].text).toContain('Error listing site files');
    });
  });
});
