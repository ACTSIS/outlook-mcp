const handleDraftEmail = require('../../email/draft');
const { emailTools } = require('../../email');
const { callGraphAPI } = require('../../utils/graph-api');
const { ensureAuthenticated } = require('../../auth');
const { composeEmail } = require('../../signature/composer');

jest.mock('../../utils/graph-api');
jest.mock('../../auth');
jest.mock('../../signature/composer');

describe('handleDraftEmail', () => {
  const accessToken = 'dummy_access_token';

  beforeEach(() => {
    callGraphAPI.mockReset();
    ensureAuthenticated.mockReset();
    ensureAuthenticated.mockResolvedValue(accessToken);
    callGraphAPI.mockResolvedValue({ id: 'draft-123', subject: 'Test subject' });
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
  });

  function createdMessage() {
    return callGraphAPI.mock.calls[0][3];
  }

  test('creates an HTML draft from a fragment when isHtml is true', async () => {
    await handleDraftEmail({ body: '<p>HTML fragment</p>', isHtml: true });

    expect(createdMessage().body).toEqual({
      contentType: 'html',
      content: '<p>HTML fragment</p>',
    });
  });

  test('creates a signed new draft with inline CID attachments', async () => {
    const attachment = { contentId: 'logo', isInline: true, contentBytes: 'aA==' };
    composeEmail.mockResolvedValue({
      body: '<p>Body</p><p>Signed</p>',
      contentType: 'html',
      attachments: [attachment],
    });

    await handleDraftEmail({ body: 'Body', includeSignature: true });

    expect(createdMessage().body).toEqual({
      contentType: 'html',
      content: '<p>Body</p><p>Signed</p>',
    });
    expect(createdMessage().attachments).toEqual([attachment]);
  });

  test('does not authenticate or call Graph when draft composition fails', async () => {
    composeEmail.mockRejectedValue(new Error('Signature store is corrupt or invalid'));

    const result = await handleDraftEmail({ body: 'Body' });

    expect(result.content[0].text).toContain('Signature store is corrupt or invalid');
    expect(ensureAuthenticated).not.toHaveBeenCalled();
    expect(callGraphAPI).not.toHaveBeenCalled();
  });

  test('creates a signed native reply draft with preserved quote and CID attachment', async () => {
    const attachment = { contentId: 'logo', isInline: true, contentBytes: 'aA==' };
    composeEmail.mockResolvedValue({
      body: '<p>Reply</p><p>Signed</p>',
      contentType: 'html',
      attachments: [attachment],
      hasSignature: true,
    });
    callGraphAPI
      .mockResolvedValueOnce({
        id: 'reply-draft',
        subject: 'RE: Original',
        body: { content: '<blockquote>Original</blockquote>' },
      })
      .mockResolvedValueOnce({ id: 'reply-draft', subject: 'RE: Original' })
      .mockResolvedValueOnce({});

    const result = await handleDraftEmail({ replyToId: 'original-id', body: 'Reply' });

    expect(callGraphAPI.mock.calls).toEqual([
      [accessToken, 'POST', 'me/messages/original-id/createReply'],
      [
        accessToken,
        'PATCH',
        'me/messages/reply-draft',
        {
          body: {
            contentType: 'html',
            content: '<p>Reply</p><p>Signed</p><blockquote>Original</blockquote>',
          },
        },
      ],
      [accessToken, 'POST', 'me/messages/reply-draft/attachments', attachment],
    ]);
    expect(result.content[0].text).toContain('Draft ID: reply-draft');
    expect(callGraphAPI.mock.calls.some((call) => call[2].endsWith('/send'))).toBe(false);
  });

  test('reports the recoverable reply draft when CID attachment creation fails', async () => {
    composeEmail.mockResolvedValue({
      body: '<p>Signed reply</p>',
      contentType: 'html',
      attachments: [{ contentId: 'logo' }],
      hasSignature: true,
    });
    callGraphAPI
      .mockResolvedValueOnce({ id: 'recoverable-draft', body: { content: '<p>Quoted</p>' } })
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('Attachment rejected'));

    const result = await handleDraftEmail({ replyToId: 'original-id', body: 'Reply' });

    expect(result.content[0].text).toContain('attachment 1');
    expect(result.content[0].text).toContain('recoverable-draft');
    expect(callGraphAPI.mock.calls).toHaveLength(3);
  });

  test('forces plain text when isHtml is false even with an html tag', async () => {
    await handleDraftEmail({ body: '<html><p>Markup</p></html>', isHtml: false });

    expect(createdMessage().body.contentType).toBe('text');
  });

  test('auto-detects an html tag case-insensitively when isHtml is omitted', async () => {
    await handleDraftEmail({ body: '<HtMl><p>Markup</p></hTmL>' });

    expect(createdMessage().body.contentType).toBe('html');
  });

  test('keeps an HTML fragment as text when isHtml is omitted', async () => {
    await handleDraftEmail({ body: '<p>HTML fragment</p>' });

    expect(createdMessage().body.contentType).toBe('text');
  });

  test('builds recipients and preserves draft defaults', async () => {
    await handleDraftEmail({
      to: ' first@example.com, ,second@example.com ',
      cc: 'cc@example.com',
      bcc: 'bcc@example.com',
    });

    expect(ensureAuthenticated).toHaveBeenCalledTimes(1);
    expect(callGraphAPI).toHaveBeenCalledWith(accessToken, 'POST', 'me/messages', {
      subject: '',
      body: { contentType: 'text', content: '' },
      toRecipients: [
        { emailAddress: { address: 'first@example.com' } },
        { emailAddress: { address: 'second@example.com' } },
      ],
      ccRecipients: [{ emailAddress: { address: 'cc@example.com' } }],
      bccRecipients: [{ emailAddress: { address: 'bcc@example.com' } }],
      importance: 'normal',
    });
  });

  test('omits empty recipient collections from the Graph payload', async () => {
    await handleDraftEmail({ to: ' ', cc: '', bcc: '' });

    expect(createdMessage()).toEqual({
      subject: '',
      body: { contentType: 'text', content: '' },
      toRecipients: undefined,
      ccRecipients: undefined,
      bccRecipients: undefined,
      importance: 'normal',
    });
  });

  test('returns the created draft details', async () => {
    const result = await handleDraftEmail({
      to: 'one@example.com,two@example.com',
      cc: 'cc@example.com',
      bcc: 'bcc@example.com',
      subject: 'Test subject',
      importance: 'high',
    });

    expect(result.content[0].text).toBe(
      'Draft created successfully!\n\nDraft ID: draft-123\nSubject: Test subject\nRecipients: 2 + 1 CC + 1 BCC'
    );
    expect(createdMessage().importance).toBe('high');
  });

  test('uses the no-subject label when Graph omits the draft subject', async () => {
    callGraphAPI.mockResolvedValue({ id: 'draft-123' });

    const result = await handleDraftEmail({});

    expect(result.content[0].text).toContain('Subject: (no subject)');
  });

  test('returns the authentication-required guidance', async () => {
    ensureAuthenticated.mockRejectedValue(new Error('Authentication required'));

    const result = await handleDraftEmail({});

    expect(result.content[0].text).toBe(
      "Authentication required. Please use the 'authenticate' tool first."
    );
    expect(callGraphAPI).not.toHaveBeenCalled();
  });

  test('returns the Mail.ReadWrite guidance for a 403 response', async () => {
    callGraphAPI.mockRejectedValue(new Error('API request failed with status 403: Forbidden'));

    const result = await handleDraftEmail({});

    expect(result.content[0].text).toContain('Draft creation was denied by Microsoft Graph (403).');
    expect(result.content[0].text).toContain('Mail.ReadWrite');
  });

  test('returns a generic draft error for other failures', async () => {
    callGraphAPI.mockRejectedValue(new Error('Network unavailable'));

    const result = await handleDraftEmail({});

    expect(result.content[0].text).toBe('Error creating draft email: Network unavailable');
  });

  test('issue #4: creates a native reply draft, then updates only its HTML body', async () => {
    callGraphAPI
      .mockResolvedValueOnce({ id: 'reply draft/id' })
      .mockResolvedValueOnce({ id: 'reply draft/id', subject: 'RE: Original subject' });

    const result = await handleDraftEmail({
      replyToId: 'original/message id',
      body: '<p>Native reply</p>',
      isHtml: true,
      to: 'ignored@example.com',
      cc: 'ignored-cc@example.com',
      bcc: 'ignored-bcc@example.com',
      subject: 'Ignored subject',
      importance: 'high',
    });

    expect(callGraphAPI.mock.calls).toEqual([
      [accessToken, 'POST', 'me/messages/original%2Fmessage%20id/createReply'],
      [
        accessToken,
        'PATCH',
        'me/messages/reply%20draft%2Fid',
        {
          body: { contentType: 'html', content: '<p>Native reply</p>' },
        },
      ],
    ]);
    expect(result.content[0].text).toContain('Reply draft created successfully!');
    expect(result.content[0].text).toContain('Draft ID: reply draft/id');
    expect(result.content[0].text).toContain('Subject: RE: Original subject');
    expect(result.content[0].text).toContain('Recipients: inherited from original message');
  });

  test('issue #4: creates a plain-text reply draft without comment or message payloads', async () => {
    callGraphAPI
      .mockResolvedValueOnce({ id: 'reply-id' })
      .mockResolvedValueOnce({ id: 'reply-id' });

    await handleDraftEmail({
      replyToId: 'original-id',
      body: '<html>literal text</html>',
      isHtml: false,
    });

    expect(callGraphAPI).toHaveBeenNthCalledWith(
      1,
      accessToken,
      'POST',
      'me/messages/original-id/createReply'
    );
    expect(callGraphAPI).toHaveBeenNthCalledWith(2, accessToken, 'PATCH', 'me/messages/reply-id', {
      body: { contentType: 'text', content: '<html>literal text</html>' },
    });
    expect(callGraphAPI.mock.calls[0]).toHaveLength(3);
  });

  test('issue #4: rejects a createReply response without a draft ID before PATCH', async () => {
    callGraphAPI.mockResolvedValueOnce({ subject: 'RE: Original subject' });

    const result = await handleDraftEmail({ replyToId: 'original-id', body: 'Reply' });

    expect(callGraphAPI).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain('Error creating draft email:');
    expect(result.content[0].text).toContain('did not return a draft ID');
  });

  test('issue #4: falls back to the createReply details when PATCH omits them', async () => {
    callGraphAPI
      .mockResolvedValueOnce({ id: 'reply-id', subject: 'RE: Original subject' })
      .mockResolvedValueOnce({});

    const result = await handleDraftEmail({ replyToId: 'original-id', body: 'Reply' });

    expect(result.content[0].text).toContain('Draft ID: reply-id');
    expect(result.content[0].text).toContain('Subject: RE: Original subject');
  });

  test('issue #4: reports authentication failure before creating a reply draft', async () => {
    ensureAuthenticated.mockRejectedValue(new Error('Authentication required'));

    const result = await handleDraftEmail({ replyToId: 'original-id', body: 'Reply' });

    expect(result.content[0].text).toBe(
      "Authentication required. Please use the 'authenticate' tool first."
    );
    expect(callGraphAPI).not.toHaveBeenCalled();
  });

  test('issue #4: reports Graph failures while creating a reply draft', async () => {
    callGraphAPI.mockRejectedValue(new Error('Network unavailable'));

    const result = await handleDraftEmail({ replyToId: 'original-id', body: 'Reply' });

    expect(result.content[0].text).toBe('Error creating draft email: Network unavailable');
  });
});

describe('draft-email tool schema', () => {
  test('declares the optional isHtml boolean with fallback behavior', () => {
    const draftTool = emailTools.find(({ name }) => name === 'draft-email');

    expect(draftTool.inputSchema.required).toEqual([]);
    expect(draftTool.inputSchema.properties.isHtml).toEqual({
      type: 'boolean',
      description:
        'Set to true to create as HTML, false for plain text. If not specified, auto-detects based on <html> tag presence.',
    });
  });

  test('issue #4: exposes replyToId without requiring new-message fields', () => {
    const draftTool = emailTools.find(({ name }) => name === 'draft-email');

    expect(draftTool.inputSchema.required).toEqual([]);
    expect(draftTool.inputSchema.properties.replyToId).toEqual({
      type: 'string',
      description:
        'ID of the existing message to reply to. When provided, recipients and subject are inherited from the original message.',
    });
  });
});
