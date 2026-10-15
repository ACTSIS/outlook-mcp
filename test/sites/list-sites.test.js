const handleListSites = require('../../sites/list-sites');
const { callGraphAPI } = require('../../utils/graph-api');
const { ensureAuthenticated } = require('../../auth');
const config = require('../../config');

jest.mock('../../utils/graph-api');
jest.mock('../../auth');

describe('handleListSites', () => {
  const mockAccessToken = 'dummy_access_token';
  const mockSites = [
    {
      id: 'site-1',
      name: 'sac-disponibilidad',
      displayName: 'SAC Disponibilidad',
      webUrl: 'https://contoso.sharepoint.com/sites/sac',
    },
    {
      id: 'site-2',
      name: 'equipos',
      displayName: 'Equipos Internos',
      webUrl: 'https://contoso.sharepoint.com/sites/equipos',
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

  describe('successful retrieval', () => {
    it('searches sites by name with the site select fields', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      callGraphAPI.mockResolvedValue({ value: mockSites });

      const result = await handleListSites({ query: 'disponibilidad' });

      expect(ensureAuthenticated).toHaveBeenCalledTimes(1);
      expect(callGraphAPI).toHaveBeenCalledWith(
        mockAccessToken,
        'GET',
        'sites',
        null,
        expect.objectContaining({
          $select: config.SITE_SELECT_FIELDS,
          search: 'disponibilidad',
        })
      );
      expect(result.content[0].text).toContain('SAC Disponibilidad');
      expect(result.content[0].text).toContain('ID: site-1');
      expect(result.content[0].text).toContain('https://contoso.sharepoint.com/sites/sac');
    });

    test('caps the requested count at 50', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      callGraphAPI.mockResolvedValue({ value: [] });

      await handleListSites({ query: 'x', count: 100 });

      expect(callGraphAPI).toHaveBeenCalledWith(
        mockAccessToken,
        'GET',
        'sites',
        null,
        expect.objectContaining({ $top: 50 })
      );
    });

    it('lists accessible sites when the query is omitted', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      callGraphAPI.mockResolvedValue({ value: mockSites });

      const result = await handleListSites({});

      expect(callGraphAPI).toHaveBeenCalledWith(
        mockAccessToken,
        'GET',
        'sites',
        null,
        expect.not.objectContaining({ search: expect.anything() })
      );
      expect(result.content[0].text).toContain('Equipos Internos');
    });

    it('reports an empty result without inventing sites', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      callGraphAPI.mockResolvedValue({ value: [] });

      const result = await handleListSites({ query: 'missing-site' });

      expect(result.content[0].text).toContain('missing-site');
      expect(result.content[0].text).toMatch(/[Nn]o sites/);
    });
  });

  describe('error handling', () => {
    it('requires authentication before listing', async () => {
      ensureAuthenticated.mockRejectedValue(new Error('Authentication required'));

      const result = await handleListSites({ query: 'x' });

      expect(result.content[0].text).toContain("use the 'authenticate' tool first");
    });

    it('maps a Graph 403 to a site access denial without a fallback', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      callGraphAPI.mockRejectedValue(new Error('Microsoft Graph API error: status 403: Forbidden'));

      const result = await handleListSites({ query: 'secret' });

      expect(result.content[0].text).toContain('403');
      expect(result.content[0].text).not.toContain('sites/secret');
    });

    it('returns a generic error for other Graph failures', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      callGraphAPI.mockRejectedValue(new Error('Microsoft Graph API error: status 500: Internal'));

      const result = await handleListSites({ query: 'x' });

      expect(result.content[0].text).toContain('Error listing sites');
    });
  });
});
