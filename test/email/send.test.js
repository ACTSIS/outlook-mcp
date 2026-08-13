const handleSendEmail = require('../../email/send');
const { emailTools } = require('../../email');
const { callGraphAPI } = require('../../utils/graph-api');
const { ensureAuthenticated } = require('../../auth');
const { composeEmail } = require('../../signature/composer');

jest.mock('../../utils/graph-api');
jest.mock('../../auth');
jest.mock('../../signature/composer');

describe('handleSendEmail', () => {
  const accessToken = 'dummy_access_token';

  beforeEach(() => {
    callGraphAPI.mockReset();
    ensureAuthenticated.mockReset();
    ensureAuthenticated.mockResolvedValue(accessToken);
    callGraphAPI.mockResolvedValue({});
    composeEmail.mockImplementation(({ body, isHtml }) =>
      Promise.resolve({ body, contentType: isHtml ? 'html' : 'text', attachments: [] })
    );
  });

  test('preserves the new-email route and payload', async () => {
    const result = await handleSendEmail({
      to: ' first@example.com,second@example.com ',
      cc: 'cc@example.com',
      bcc: 'bcc@example.com',
      subject: 'New message',
      body: '<p>HTML fragment</p>',
      isHtml: true,
      importance: 'high',
      saveToSentItems: false,
    });

    expect(callGraphAPI).toHaveBeenCalledWith(accessToken, 'POST', 'me/sendMail', {
      message: {
        subject: 'New message',
        body: { contentType: 'html', content: '<p>HTML fragment</p>' },
        toRecipients: [
          { emailAddress: { address: 'first@example.com' } },
          { emailAddress: { address: 'second@example.com' } },
        ],
        ccRecipients: [{ emailAddress: { address: 'cc@example.com' } }],
        bccRecipients: [{ emailAddress: { address: 'bcc@example.com' } }],
        importance: 'high',
      },
      saveToSentItems: false,
    });
    expect(result.content[0].text).toContain('Email sent successfully!');
  });

  test('adds a composed signature and inline CID attachments to a new email', async () => {
    const attachment = { contentId: 'logo', isInline: true, contentBytes: 'aA==' };
    composeEmail.mockResolvedValue({
      body: '<p>Body</p><p>Signed</p>',
      contentType: 'html',
      attachments: [attachment],
    });

    await handleSendEmail({
      to: 'to@example.com',
      subject: 'Signed',
      body: 'Body',
      signatureName: 'work',
    });

    expect(composeEmail).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'Body', signatureName: 'work' })
    );
    expect(callGraphAPI.mock.calls[0][3].message).toEqual(
      expect.objectContaining({
        body: { contentType: 'html', content: '<p>Body</p><p>Signed</p>' },
        attachments: [attachment],
      })
    );
  });

  test('does not authenticate or call Graph when signature composition fails', async () => {
    composeEmail.mockRejectedValue(new Error('Signature not found: missing'));

    const result = await handleSendEmail({
      to: 'to@example.com',
      subject: 'Subject',
      body: 'Body',
      signatureName: 'missing',
    });

    expect(result.content[0].text).toBe('Error sending email: Signature not found: missing');
    expect(ensureAuthenticated).not.toHaveBeenCalled();
    expect(callGraphAPI).not.toHaveBeenCalled();
  });

  test('sends a signed native reply only after patching its quoted body and CID attachments', async () => {
    const attachment = { contentId: 'logo', isInline: true, contentBytes: 'aA==' };
    composeEmail.mockResolvedValue({
      body: '<p>Reply</p><p>Signed</p>',
      contentType: 'html',
      attachments: [attachment],
      hasSignature: true,
    });
    callGraphAPI
      .mockResolvedValueOnce({
        id: 'reply draft/id',
        body: { contentType: 'html', content: '<blockquote>Original</blockquote>' },
      })
      .mockResolvedValue({});

    const result = await handleSendEmail({ replyToId: 'original/id', body: 'Reply' });

    expect(callGraphAPI.mock.calls).toEqual([
      [accessToken, 'POST', 'me/messages/original%2Fid/createReply'],
      [
        accessToken,
        'PATCH',
        'me/messages/reply%20draft%2Fid',
        {
          body: {
            contentType: 'html',
            content: '<p>Reply</p><p>Signed</p><blockquote>Original</blockquote>',
          },
        },
      ],
      [accessToken, 'POST', 'me/messages/reply%20draft%2Fid/attachments', attachment],
      [accessToken, 'POST', 'me/messages/reply%20draft%2Fid/send'],
    ]);
    expect(result.content[0].text).toContain('Reply sent successfully');
  });

  test('keeps a recoverable signed reply draft when an attachment fails', async () => {
    composeEmail.mockResolvedValue({
      body: '<p>Signed reply</p>',
      contentType: 'html',
      attachments: [{ contentId: 'first' }, { contentId: 'second' }],
      hasSignature: true,
    });
    callGraphAPI
      .mockResolvedValueOnce({ id: 'recoverable-draft', body: { content: '<p>Quoted</p>' } })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('Attachment rejected'));

    const result = await handleSendEmail({ replyToId: 'original-id', body: 'Reply' });

    expect(result.content[0].text).toContain('attachment 2');
    expect(result.content[0].text).toContain('recoverable-draft');
    expect(callGraphAPI.mock.calls.at(-1)[2]).toContain('/attachments');
    expect(callGraphAPI.mock.calls.some((call) => call[2].endsWith('/send'))).toBe(false);
  });

  test.each([
    {
      stage: 'body update',
      responses: [
        { id: 'recoverable-draft', body: { content: '<p>Quoted</p>' } },
        new Error('Patch rejected'),
      ],
      expectedCalls: 2,
    },
    {
      stage: 'send',
      responses: [
        { id: 'recoverable-draft', body: { content: '<p>Quoted</p>' } },
        {},
        new Error('Send rejected'),
      ],
      expectedCalls: 3,
    },
  ])('reports the recoverable draft when signed reply $stage fails', async (scenario) => {
    composeEmail.mockResolvedValue({
      body: '<p>Signed reply</p>',
      contentType: 'html',
      attachments: [],
      hasSignature: true,
    });
    scenario.responses.forEach((response) => {
      if (response instanceof Error) callGraphAPI.mockRejectedValueOnce(response);
      else callGraphAPI.mockResolvedValueOnce(response);
    });

    const result = await handleSendEmail({ replyToId: 'original-id', body: 'Reply' });

    expect(result.content[0].text).toContain(scenario.stage);
    expect(result.content[0].text).toContain('recoverable-draft');
    expect(callGraphAPI.mock.calls).toHaveLength(scenario.expectedCalls);
  });

  test.each([
    [{ subject: 'Subject', body: 'Body' }, 'Recipient (to) is required.'],
    [{ to: 'to@example.com', body: 'Body' }, 'Subject is required.'],
    [{ to: 'to@example.com', subject: 'Subject' }, 'Body content is required.'],
  ])('keeps conditional validation for a new email', async (args, expected) => {
    const result = await handleSendEmail(args);

    expect(result.content[0].text).toBe(expected);
    expect(ensureAuthenticated).not.toHaveBeenCalled();
    expect(callGraphAPI).not.toHaveBeenCalled();
  });

  test('issue #4: sends a native reply without new-message metadata', async () => {
    const result = await handleSendEmail({
      replyToId: 'original/message id',
      body: '<p>Native reply</p>',
      isHtml: true,
      to: 'ignored@example.com',
      cc: 'ignored-cc@example.com',
      bcc: 'ignored-bcc@example.com',
      subject: 'Ignored subject',
      importance: 'high',
      saveToSentItems: false,
    });

    expect(callGraphAPI).toHaveBeenCalledWith(
      accessToken,
      'POST',
      'me/messages/original%2Fmessage%20id/reply',
      {
        message: {
          body: { contentType: 'html', content: '<p>Native reply</p>' },
        },
      }
    );
    expect(callGraphAPI).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain('Reply sent successfully');
    expect(result.content[0].text).toContain('original message');
  });

  test('issue #4: sends a plain-text native reply without comment', async () => {
    await handleSendEmail({
      replyToId: 'original-id',
      body: '<html>literal text</html>',
      isHtml: false,
    });

    const payload = callGraphAPI.mock.calls[0][3];
    expect(payload).toEqual({
      message: {
        body: { contentType: 'text', content: '<html>literal text</html>' },
      },
    });
    expect(payload).not.toHaveProperty('comment');
    expect(payload.message).not.toHaveProperty('subject');
    expect(payload.message).not.toHaveProperty('toRecipients');
    expect(payload).not.toHaveProperty('saveToSentItems');
  });

  test('issue #4: preserves HTML auto-detection for a native reply', async () => {
    await handleSendEmail({ replyToId: 'original-id', body: '<HTML>Reply</HTML>' });

    expect(callGraphAPI.mock.calls[0][3].message.body.contentType).toBe('html');
  });

  test('issue #4: requires only a body for a native reply', async () => {
    const missingBody = await handleSendEmail({ replyToId: 'original-id' });

    expect(missingBody.content[0].text).toBe('Body content is required.');
    expect(ensureAuthenticated).not.toHaveBeenCalled();
    expect(callGraphAPI).not.toHaveBeenCalled();

    await handleSendEmail({ replyToId: 'original-id', body: 'Reply' });
    expect(ensureAuthenticated).toHaveBeenCalledTimes(1);
    expect(callGraphAPI).toHaveBeenCalledTimes(1);
  });

  test('returns authentication guidance in reply mode', async () => {
    ensureAuthenticated.mockRejectedValue(new Error('Authentication required'));

    const result = await handleSendEmail({ replyToId: 'original-id', body: 'Reply' });

    expect(result.content[0].text).toBe(
      "Authentication required. Please use the 'authenticate' tool first."
    );
    expect(callGraphAPI).not.toHaveBeenCalled();
  });

  test('returns Graph errors in reply mode', async () => {
    callGraphAPI.mockRejectedValue(new Error('Network unavailable'));

    const result = await handleSendEmail({ replyToId: 'original-id', body: 'Reply' });

    expect(result.content[0].text).toBe('Error sending email: Network unavailable');
  });
});

describe('send-email tool schema', () => {
  test('issue #4: accepts replyToId and requires only body globally', () => {
    const sendTool = emailTools.find(({ name }) => name === 'send-email');

    expect(sendTool.inputSchema.required).toEqual(['body']);
    expect(sendTool.inputSchema.properties.replyToId).toEqual({
      type: 'string',
      description:
        'ID of the existing message to reply to. When provided, recipients and subject are inherited from the original message.',
    });
    expect(sendTool.inputSchema.properties.to.description).toContain(
      'Required when creating a new email'
    );
    expect(sendTool.inputSchema.properties.subject.description).toContain(
      'Required when creating a new email'
    );
  });
});
