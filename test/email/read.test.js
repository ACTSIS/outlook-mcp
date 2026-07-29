const handleReadEmail = require('../../email/read');
const { callGraphAPI } = require('../../utils/graph-api');
const { ensureAuthenticated } = require('../../auth');

jest.mock('../../utils/graph-api');
jest.mock('../../auth');

describe('handleReadEmail attachments', () => {
  const mockAccessToken = 'dummy_access_token';
  const emailId = 'email-with-attachments';

  const baseEmail = {
    id: emailId,
    subject: 'Email with attachments',
    from: {
      emailAddress: {
        name: 'Sender Name',
        address: 'sender@example.com',
      },
    },
    toRecipients: [
      {
        emailAddress: {
          name: 'Recipient Name',
          address: 'recipient@example.com',
        },
      },
    ],
    ccRecipients: [],
    bccRecipients: [],
    receivedDateTime: '2024-01-15T10:30:00Z',
    bodyPreview: 'Preview text',
    body: {
      contentType: 'text',
      content: 'Body text',
    },
    hasAttachments: true,
    importance: 'normal',
    isRead: true,
    internetMessageHeaders: [],
  };

  const attachments = {
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
        name: 'image.png',
        contentType: 'image/png',
        size: 7890,
        isInline: true,
      },
    ],
  };

  beforeEach(() => {
    callGraphAPI.mockReset();
    ensureAuthenticated.mockReset();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    console.error.mockRestore();
  });

  test('should fetch and display attachment metadata when hasAttachments=true', async () => {
    ensureAuthenticated.mockResolvedValue(mockAccessToken);
    callGraphAPI.mockResolvedValueOnce(baseEmail).mockResolvedValueOnce(attachments);

    const result = await handleReadEmail({ id: emailId });

    expect(callGraphAPI).toHaveBeenCalledTimes(2);
    expect(callGraphAPI).toHaveBeenNthCalledWith(
      2,
      mockAccessToken,
      'GET',
      `me/messages/${encodeURIComponent(emailId)}/attachments`,
      null,
      expect.objectContaining({
        $select: 'id,name,contentType,size,isInline',
      })
    );
    expect(result.content[0].text).toContain('Has Attachments: Yes');
    expect(result.content[0].text).toContain('Attachments:');
    expect(result.content[0].text).toContain('report.pdf');
    expect(result.content[0].text).toContain('image.png');
    expect(result.content[0].text).toContain('application/pdf');
    expect(result.content[0].text).toContain('1234567');
    expect(result.content[0].text).toContain('att-1');
  });

  test('should flag inline attachments in attachment section', async () => {
    ensureAuthenticated.mockResolvedValue(mockAccessToken);
    callGraphAPI.mockResolvedValueOnce(baseEmail).mockResolvedValueOnce(attachments);

    const result = await handleReadEmail({ id: emailId });

    expect(result.content[0].text).toContain('[INLINE]');
  });

  test('should not fetch attachments when hasAttachments=false', async () => {
    ensureAuthenticated.mockResolvedValue(mockAccessToken);
    callGraphAPI.mockResolvedValueOnce({ ...baseEmail, hasAttachments: false });

    const result = await handleReadEmail({ id: emailId });

    expect(callGraphAPI).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain('Has Attachments: No');
    expect(result.content[0].text).not.toContain('\n\nAttachments:');
  });

  test('should return email body and warning when attachment fetch fails', async () => {
    ensureAuthenticated.mockResolvedValue(mockAccessToken);
    callGraphAPI
      .mockResolvedValueOnce(baseEmail)
      .mockRejectedValueOnce(new Error('Graph API Error'));

    const result = await handleReadEmail({ id: emailId });

    expect(result.content[0].text).toContain('Body text');
    expect(result.content[0].text).toContain('Could not retrieve attachment metadata');
  });

  test('should return authentication error when not authenticated', async () => {
    ensureAuthenticated.mockRejectedValue(new Error('Authentication required'));

    const result = await handleReadEmail({ id: emailId });

    expect(callGraphAPI).not.toHaveBeenCalled();
    expect(result.content[0].text).toBe(
      "Authentication required. Please use the 'authenticate' tool first."
    );
  });
});
