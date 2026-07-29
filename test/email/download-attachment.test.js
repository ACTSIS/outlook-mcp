const handleDownloadAttachment = require('../../email/download-attachment');
const { callGraphAPI } = require('../../utils/graph-api');
const { ensureAuthenticated } = require('../../auth');

jest.mock('../../utils/graph-api');
jest.mock('../../auth');

describe('handleDownloadAttachment', () => {
  const mockAccessToken = 'dummy_access_token';
  const emailId = 'email-123';
  const attachmentId = 'att-1';

  beforeEach(() => {
    callGraphAPI.mockReset();
    ensureAuthenticated.mockReset();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    console.error.mockRestore();
  });

  test('should call single attachment endpoint without $select (contentBytes is on derived type)', async () => {
    ensureAuthenticated.mockResolvedValue(mockAccessToken);
    callGraphAPI.mockResolvedValue({
      id: attachmentId,
      name: 'report.pdf',
      contentType: 'application/pdf',
      size: 1234567,
      contentBytes: 'YmFzZTY0LWNvbnRlbnQ=',
    });

    const result = await handleDownloadAttachment({ emailId, attachmentId });

    expect(callGraphAPI).toHaveBeenCalledWith(
      mockAccessToken,
      'GET',
      `me/messages/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(attachmentId)}`,
      null
    );
    expect(result.content[0].text).toContain('report.pdf');
    expect(result.content[0].text).toContain('application/pdf');
    expect(result.content[0].text).toContain('1234567');
    expect(result.content[0].text).toContain('YmFzZTY0LWNvbnRlbnQ=');
  });

  test('should include size warning for attachments above threshold', async () => {
    ensureAuthenticated.mockResolvedValue(mockAccessToken);
    callGraphAPI.mockResolvedValue({
      id: attachmentId,
      name: 'large-file.zip',
      contentType: 'application/zip',
      size: 15 * 1024 * 1024,
      contentBytes: 'bGFyZ2UtYmFzZTY0LWNvbnRlbnQ=',
    });

    const result = await handleDownloadAttachment({ emailId, attachmentId });

    expect(result.content[0].text).toContain('exceeds the 10 MB threshold');
    expect(result.content[0].text).toContain('bGFyZ2UtYmFzZTY0LWNvbnRlbnQ=');
  });

  test('should not include size warning for attachments below threshold', async () => {
    ensureAuthenticated.mockResolvedValue(mockAccessToken);
    callGraphAPI.mockResolvedValue({
      id: attachmentId,
      name: 'small-file.txt',
      contentType: 'text/plain',
      size: 500 * 1024,
      contentBytes: Buffer.from('hello world').toString('base64'),
    });

    const result = await handleDownloadAttachment({ emailId, attachmentId });

    expect(result.content[0].text).not.toContain('exceeds the');
    expect(result.content[0].text).toContain('hello world');
  });

  test('should decode text-like content types by default', async () => {
    ensureAuthenticated.mockResolvedValue(mockAccessToken);
    callGraphAPI.mockResolvedValue({
      id: attachmentId,
      name: 'data.json',
      contentType: 'application/json',
      size: 100,
      contentBytes: Buffer.from('{"key":"value"}').toString('base64'),
    });

    const result = await handleDownloadAttachment({ emailId, attachmentId });

    expect(result.content[0].text).toContain('{"key":"value"}');
    expect(result.content[0].text).not.toContain('Content (base64):');
  });

  test('should keep base64 when decodeAsText is false', async () => {
    ensureAuthenticated.mockResolvedValue(mockAccessToken);
    const base64Content = Buffer.from('plain text').toString('base64');
    callGraphAPI.mockResolvedValue({
      id: attachmentId,
      name: 'data.txt',
      contentType: 'text/plain',
      size: 100,
      contentBytes: base64Content,
    });

    const result = await handleDownloadAttachment({ emailId, attachmentId, decodeAsText: false });

    expect(result.content[0].text).toContain(base64Content);
    expect(result.content[0].text).toContain('Content (base64):');
  });

  test('should return error when emailId is missing', async () => {
    const result = await handleDownloadAttachment({ attachmentId });

    expect(result.content[0].text).toBe('Email ID is required.');
    expect(callGraphAPI).not.toHaveBeenCalled();
  });

  test('should return error when attachmentId is missing', async () => {
    const result = await handleDownloadAttachment({ emailId });

    expect(result.content[0].text).toBe('Attachment ID is required.');
    expect(callGraphAPI).not.toHaveBeenCalled();
  });

  test('should handle authentication error', async () => {
    ensureAuthenticated.mockRejectedValue(new Error('Authentication required'));

    const result = await handleDownloadAttachment({ emailId, attachmentId });

    expect(result.content[0].text).toBe(
      "Authentication required. Please use the 'authenticate' tool first."
    );
  });

  test('should handle Graph API error', async () => {
    ensureAuthenticated.mockResolvedValue(mockAccessToken);
    callGraphAPI.mockRejectedValue(new Error('Attachment not found'));

    const result = await handleDownloadAttachment({ emailId, attachmentId });

    expect(result.content[0].text).toBe('Error downloading attachment: Attachment not found');
  });
});
