const {
  deliverNativeReply,
  isEmailLikeAddress,
  sharedMailboxPrefix,
} = require('../../email/graph-message-flow');

describe('isEmailLikeAddress', () => {
  test.each([
    ['sac.soporte@actsis.com', true],
    [' user@tenant.onmicrosoft.com ', true],
    ['sac.soporte@', false],
    ['@actsis.com', false],
    ['not-an-email', false],
    ['has space@actsis.com', false],
    [null, false],
    [undefined, false],
    ['', false],
  ])('validates %j as %j', (value, expected) => {
    expect(isEmailLikeAddress(value)).toBe(expected);
  });
});

describe('sharedMailboxPrefix', () => {
  test('encodes the mailbox into a users path segment', () => {
    expect(sharedMailboxPrefix('sac.soporte@actsis.com')).toBe('users/sac.soporte%40actsis.com/');
  });
});

describe('deliverNativeReply', () => {
  const accessToken = 'token';
  const callGraphAPI = jest.fn();

  beforeEach(() => {
    callGraphAPI.mockReset();
    callGraphAPI
      .mockResolvedValueOnce({ id: 'draft-id', body: { content: '<blockquote>Q</blockquote>' } })
      .mockResolvedValue({});
  });

  const composed = { body: '<p>Reply</p>', contentType: 'html', attachments: [] };

  test('keeps the /me endpoints when no shared mailbox is given', async () => {
    await deliverNativeReply(accessToken, 'orig-id', composed, false, callGraphAPI);

    expect(callGraphAPI.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ['POST', 'me/messages/orig-id/createReply'],
      ['PATCH', 'me/messages/draft-id'],
    ]);
  });

  test('posts composed CID attachments and targets users/{from}/messages endpoints', async () => {
    const withAttachment = { ...composed, attachments: [{ contentId: 'logo' }] };
    await deliverNativeReply(
      accessToken,
      'orig-id',
      withAttachment,
      false,
      callGraphAPI,
      'sac.soporte@actsis.com'
    );

    expect(callGraphAPI.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ['POST', 'users/sac.soporte%40actsis.com/messages/orig-id/createReply'],
      ['PATCH', 'users/sac.soporte%40actsis.com/messages/draft-id'],
      ['POST', 'users/sac.soporte%40actsis.com/messages/draft-id/attachments'],
    ]);
  });

  test('sends the shared-mailbox reply draft through the same mailbox', async () => {
    await deliverNativeReply(
      accessToken,
      'orig-id',
      composed,
      true,
      callGraphAPI,
      'sac.soporte@actsis.com'
    );

    expect(callGraphAPI.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ['POST', 'users/sac.soporte%40actsis.com/messages/orig-id/createReply'],
      ['PATCH', 'users/sac.soporte%40actsis.com/messages/draft-id'],
      ['POST', 'users/sac.soporte%40actsis.com/messages/draft-id/send'],
    ]);
  });

  test('keeps the /me endpoints when no shared mailbox is given', async () => {
    await deliverNativeReply(accessToken, 'orig-id', composed, true, callGraphAPI);

    expect(callGraphAPI.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ['POST', 'me/messages/orig-id/createReply'],
      ['PATCH', 'me/messages/draft-id'],
      ['POST', 'me/messages/draft-id/send'],
    ]);
  });

  test('preserves the draft-id error context in shared-mailbox mode', async () => {
    callGraphAPI
      .mockReset()
      .mockResolvedValueOnce({ id: 'draft-id', body: { content: '' } })
      .mockRejectedValueOnce(new Error('Patch rejected'));

    await expect(
      deliverNativeReply(
        accessToken,
        'orig-id',
        composed,
        false,
        callGraphAPI,
        'sac.soporte@actsis.com'
      )
    ).rejects.toThrow(/draft-id.*Patch rejected/);
  });
});
