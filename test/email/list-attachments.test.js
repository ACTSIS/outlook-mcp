const handleListAttachments = require('../../email/list-attachments');
const { callGraphAPI } = require('../../utils/graph-api');
const { ensureAuthenticated } = require('../../auth');

jest.mock('../../utils/graph-api');
jest.mock('../../auth');

describe('handleListAttachments', () => {
  const mockAccessToken = 'dummy_access_token';
  const emailId = 'email-123';

  beforeEach(() => {
    callGraphAPI.mockReset();
    ensureAuthenticated.mockReset();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    console.error.mockRestore();
  });

  test('should call attachments endpoint with correct $select', async () => {
    ensureAuthenticated.mockResolvedValue(mockAccessToken);
    callGraphAPI.mockResolvedValue({
      value: [
        {
          id: 'att-1',
          name: 'report.pdf',
          contentType: 'application/pdf',
          size: 1234567,
          isInline: false,
        },
      ],
    });

    const result = await handleListAttachments({ emailId });

    expect(callGraphAPI).toHaveBeenCalledWith(
      mockAccessToken,
      'GET',
      `me/messages/${encodeURIComponent(emailId)}/attachments`,
      null,
      expect.objectContaining({
        $select: 'id,name,contentType,size,isInline',
      })
    );
    expect(result.content[0].text).toContain('report.pdf');
    expect(result.content[0].text).toContain('application/pdf');
    expect(result.content[0].text).toContain('1234567');
    expect(result.content[0].text).toContain('att-1');
  });

  test('should flag inline attachments separately', async () => {
    ensureAuthenticated.mockResolvedValue(mockAccessToken);
    callGraphAPI.mockResolvedValue({
      value: [
        {
          id: 'att-1',
          name: 'report.pdf',
          contentType: 'application/pdf',
          size: 1234567,
          isInline: false,
        },
        {
          id: 'att-2',
          name: 'logo.png',
          contentType: 'image/png',
          size: 7890,
          isInline: true,
        },
      ],
    });

    const result = await handleListAttachments({ emailId });

    expect(result.content[0].text).toContain('[INLINE]');
    expect(result.content[0].text).toContain('logo.png');
  });

  test('should return no attachments message when value is empty', async () => {
    ensureAuthenticated.mockResolvedValue(mockAccessToken);
    callGraphAPI.mockResolvedValue({ value: [] });

    const result = await handleListAttachments({ emailId });

    expect(result.content[0].text).toContain('No attachments');
  });

  test('should return error when emailId is missing', async () => {
    const result = await handleListAttachments({});

    expect(result.content[0].text).toBe('Email ID is required.');
    expect(callGraphAPI).not.toHaveBeenCalled();
  });

  test('should handle authentication error', async () => {
    ensureAuthenticated.mockRejectedValue(new Error('Authentication required'));

    const result = await handleListAttachments({ emailId });

    expect(result.content[0].text).toBe(
      "Authentication required. Please use the 'authenticate' tool first."
    );
  });

  test('should handle Graph API error', async () => {
    ensureAuthenticated.mockResolvedValue(mockAccessToken);
    callGraphAPI.mockRejectedValue(new Error('Graph API Error'));

    const result = await handleListAttachments({ emailId });

    expect(result.content[0].text).toBe('Error listing attachments: Graph API Error');
  });
});
