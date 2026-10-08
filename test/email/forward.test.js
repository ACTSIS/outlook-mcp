const fs = require('fs');
const os = require('os');
const path = require('path');

const handleForwardDraft = require('../../email/forward');
const { callGraphAPI } = require('../../utils/graph-api');
const { ensureAuthenticated } = require('../../auth');
const { composeEmail } = require('../../signature/composer');

jest.mock('../../utils/graph-api');
jest.mock('../../auth');
jest.mock('../../signature/composer');

describe('handleForwardDraft', () => {
  const accessToken = 'dummy_access_token';
  let tmpDir;

  beforeEach(() => {
    callGraphAPI.mockReset();
    ensureAuthenticated.mockReset();
    ensureAuthenticated.mockResolvedValue(accessToken);
    callGraphAPI.mockResolvedValue({ id: 'forward-draft-1', subject: 'FW: Original' });
    composeEmail.mockImplementation(({ body = '', isHtml }) =>
      Promise.resolve({
        body,
        contentType:
          isHtml === true
            ? 'html'
            : isHtml === false
              ? 'text'
              : body.toLowerCase().includes('<html')
                ? 'html'
                : 'text',
        attachments: [],
      })
    );
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forward-draft-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('rejects a forward request without emailId before authenticating', async () => {
    const result = await handleForwardDraft({});

    expect(result.content[0].text).toContain('emailId is required');
    expect(ensureAuthenticated).not.toHaveBeenCalled();
    expect(callGraphAPI).not.toHaveBeenCalled();
  });

  test('reports authentication failure before creating a forward draft', async () => {
    ensureAuthenticated.mockRejectedValue(new Error('Authentication required'));

    const result = await handleForwardDraft({ emailId: 'original-id', body: 'Look' });

    expect(result.content[0].text).toBe(
      "Authentication required. Please use the 'authenticate' tool first."
    );
    expect(callGraphAPI).not.toHaveBeenCalled();
  });

  test('surfaces composition failures without authenticating or calling Graph', async () => {
    composeEmail.mockRejectedValue(new Error('Signature store is corrupt or invalid'));

    const result = await handleForwardDraft({ emailId: 'original-id', body: 'Look' });

    expect(result.content[0].text).toContain('Signature store is corrupt or invalid');
    expect(ensureAuthenticated).not.toHaveBeenCalled();
    expect(callGraphAPI).not.toHaveBeenCalled();
  });

  test('creates a signed forward draft with composed text above the quoted thread', async () => {
    const composedAttachment = { contentId: 'logo', isInline: true, contentBytes: 'aA==' };
    composeEmail.mockResolvedValue({
      body: '<p>My note</p><p>Signed</p>',
      contentType: 'html',
      attachments: [composedAttachment],
      hasSignature: true,
    });
    callGraphAPI
      .mockResolvedValueOnce({
        id: 'forward-draft-1',
        subject: 'FW: Original',
        body: { content: '<div>Quoted thread</div>' },
      })
      .mockResolvedValueOnce({ id: 'forward-draft-1', subject: 'FW: Original' })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const result = await handleForwardDraft({
      emailId: 'original-id',
      body: 'My note',
      includeSignature: true,
    });

    expect(callGraphAPI.mock.calls).toEqual([
      [accessToken, 'POST', 'me/messages/original-id/createForward'],
      [
        accessToken,
        'PATCH',
        'me/messages/forward-draft-1',
        {
          body: {
            contentType: 'html',
            content: '<p>My note</p><p>Signed</p><div>Quoted thread</div>',
          },
        },
      ],
      [
        accessToken,
        'PATCH',
        'me/messages/forward-draft-1',
        { toRecipients: [], ccRecipients: [], bccRecipients: [] },
      ],
      [accessToken, 'POST', 'me/messages/forward-draft-1/attachments', composedAttachment],
    ]);
    expect(result.content[0].text).toContain('Forward draft created successfully!');
    expect(result.content[0].text).toContain('Draft ID: forward-draft-1');
    expect(result.content[0].text).toContain('Subject: FW: Original');
    expect(result.content[0].text).toContain('Recipients: none (set them before sending)');
  });

  test('clears inherited recipients on an unsigned forward draft', async () => {
    callGraphAPI
      .mockResolvedValueOnce({
        id: 'forward-draft-1',
        subject: 'FW: Original',
        body: { content: '<div>Quoted</div>' },
      })
      .mockResolvedValueOnce({ id: 'forward-draft-1', subject: 'FW: Original' })
      .mockResolvedValueOnce({});

    await handleForwardDraft({ emailId: 'original-id', body: 'Check this thread' });

    expect(callGraphAPI.mock.calls.map((call) => call[2])).toEqual([
      'me/messages/original-id/createForward',
      'me/messages/forward-draft-1',
      'me/messages/forward-draft-1',
    ]);
    expect(callGraphAPI.mock.calls[1][3]).toEqual({
      body: { contentType: 'text', content: 'Check this thread<div>Quoted</div>' },
    });
    // Issue #15: recipients must never be inherited from the original message.
    expect(callGraphAPI.mock.calls[2][3]).toEqual({
      toRecipients: [],
      ccRecipients: [],
      bccRecipients: [],
    });
  });

  test('applies a subject override alongside a managed signature', async () => {
    composeEmail.mockResolvedValue({
      body: '<p>Signed note</p>',
      contentType: 'html',
      attachments: [],
      hasSignature: true,
    });
    callGraphAPI
      .mockResolvedValueOnce({
        id: 'forward-draft-1',
        subject: 'FW: Original',
        body: { content: '<div>Quoted</div>' },
      })
      .mockResolvedValueOnce({ id: 'forward-draft-1', subject: 'For your review' })
      .mockResolvedValueOnce({});

    const result = await handleForwardDraft({
      emailId: 'original-id',
      body: 'My note',
      subject: 'For your review',
      includeSignature: true,
    });

    expect(callGraphAPI.mock.calls[1][3]).toEqual({
      body: { contentType: 'html', content: '<p>Signed note</p><div>Quoted</div>' },
      subject: 'For your review',
    });
    expect(result.content[0].text).toContain('Subject: For your review');
  });

  test('skips the body patch when no caller text or subject override is supplied', async () => {
    callGraphAPI
      .mockResolvedValueOnce({ id: 'forward-draft-1', subject: 'FW: Original' })
      .mockResolvedValueOnce({});

    await handleForwardDraft({ emailId: 'original-id' });

    expect(callGraphAPI.mock.calls).toEqual([
      [accessToken, 'POST', 'me/messages/original-id/createForward'],
      [
        accessToken,
        'PATCH',
        'me/messages/forward-draft-1',
        { toRecipients: [], ccRecipients: [], bccRecipients: [] },
      ],
    ]);
  });

  test('applies a subject override without replacing the quoted body', async () => {
    callGraphAPI
      .mockResolvedValueOnce({
        id: 'forward-draft-1',
        subject: 'FW: Original',
        body: { content: '<div>Quoted</div>' },
      })
      .mockResolvedValueOnce({ id: 'forward-draft-1', subject: 'Custom subject' })
      .mockResolvedValueOnce({});

    const result = await handleForwardDraft({ emailId: 'original-id', subject: 'Custom subject' });

    expect(callGraphAPI.mock.calls[1]).toEqual([
      accessToken,
      'PATCH',
      'me/messages/forward-draft-1',
      { subject: 'Custom subject' },
    ]);
    expect(callGraphAPI.mock.calls[2][3]).toEqual({
      toRecipients: [],
      ccRecipients: [],
      bccRecipients: [],
    });
    expect(result.content[0].text).toContain('Subject: Custom subject');
  });

  test('passes the requested importance in the recipients patch', async () => {
    callGraphAPI
      .mockResolvedValueOnce({ id: 'forward-draft-1', subject: 'FW: Original' })
      .mockResolvedValueOnce({});

    await handleForwardDraft({ emailId: 'original-id', importance: 'high' });

    expect(callGraphAPI.mock.calls[1][3]).toEqual({
      toRecipients: [],
      ccRecipients: [],
      bccRecipients: [],
      importance: 'high',
    });
  });

  test('posts caller-supplied file attachments to the forward draft', async () => {
    const pdfPath = path.join(tmpDir, 'evidence.pdf');
    fs.writeFileSync(pdfPath, Buffer.from('%PDF-1.4 forwarded evidence'));
    callGraphAPI
      .mockResolvedValueOnce({ id: 'forward-draft-1', subject: 'FW: Original' })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const result = await handleForwardDraft({ emailId: 'original-id', attachments: [pdfPath] });

    expect(callGraphAPI.mock.calls[2]).toEqual([
      accessToken,
      'POST',
      'me/messages/forward-draft-1/attachments',
      {
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: 'evidence.pdf',
        contentType: 'application/pdf',
        contentBytes: Buffer.from('%PDF-1.4 forwarded evidence').toString('base64'),
      },
    ]);
    expect(result.content[0].text).toContain('Attachments: evidence.pdf');
  });

  test('fails on a missing attachment before any Graph call', async () => {
    const missing = path.join(tmpDir, 'ghost.pdf');

    const result = await handleForwardDraft({ emailId: 'original-id', attachments: [missing] });

    expect(result.content[0].text).toContain(`Attachment file not found: ${missing}`);
    expect(callGraphAPI).not.toHaveBeenCalled();
  });

  test('rejects a createForward response without a draft ID before patching', async () => {
    callGraphAPI.mockResolvedValueOnce({ subject: 'FW: Original' });

    const result = await handleForwardDraft({ emailId: 'original-id' });

    expect(callGraphAPI).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain('Error creating forward draft:');
    expect(result.content[0].text).toContain('did not return a draft ID');
  });

  test('url-encodes the source message ID in the createForward endpoint', async () => {
    callGraphAPI
      .mockResolvedValueOnce({ id: 'forward draft/id', subject: 'FW: Original' })
      .mockResolvedValueOnce({});

    await handleForwardDraft({ emailId: 'original/message id' });

    expect(callGraphAPI.mock.calls[0]).toEqual([
      accessToken,
      'POST',
      'me/messages/original%2Fmessage%20id/createForward',
    ]);
  });

  test('returns the Mail.ReadWrite guidance for a 403 response', async () => {
    callGraphAPI.mockRejectedValue(new Error('API request failed with status 403: Forbidden'));

    const result = await handleForwardDraft({ emailId: 'original-id' });

    expect(result.content[0].text).toContain('denied by Microsoft Graph (403).');
    expect(result.content[0].text).toContain('Mail.ReadWrite');
  });

  test('returns a generic forward error for other Graph failures', async () => {
    callGraphAPI.mockRejectedValue(new Error('Network unavailable'));

    const result = await handleForwardDraft({ emailId: 'original-id' });

    expect(result.content[0].text).toBe('Error creating forward draft: Network unavailable');
  });
});
