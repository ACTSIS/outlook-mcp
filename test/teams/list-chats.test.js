const handleListChats = require('../../teams/list-chats');
const { callGraphAPI, callGraphAPIPaginated } = require('../../utils/graph-api');
const { ensureAuthenticated } = require('../../auth');
const config = require('../../config');

jest.mock('../../utils/graph-api');
jest.mock('../../auth');

describe('handleListChats', () => {
  const mockAccessToken = 'dummy_access_token';
  const mockChats = [
    {
      id: 'chat-1',
      topic: 'Project Alpha',
      lastMessagePreview: 'Last message body',
      lastUpdatedDateTime: '2024-03-15T10:30:00Z',
    },
    {
      id: 'chat-2',
      topic: 'One-on-one',
      lastMessagePreview: 'Hello there',
      lastUpdatedDateTime: '2024-03-14T09:00:00Z',
    },
  ];

  beforeEach(() => {
    callGraphAPI.mockClear();
    callGraphAPIPaginated.mockClear();
    ensureAuthenticated.mockClear();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    console.error.mockRestore();
  });

  describe('successful retrieval', () => {
    test('should list chats with the default count', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      callGraphAPIPaginated.mockResolvedValue({ value: mockChats });

      const result = await handleListChats({});

      expect(ensureAuthenticated).toHaveBeenCalledTimes(1);
      expect(callGraphAPIPaginated).toHaveBeenCalledWith(
        mockAccessToken,
        'GET',
        'me/chats',
        expect.objectContaining({
          $top: config.MAX_RESULT_COUNT,
          $select: config.CHAT_SELECT_FIELDS,
        }),
        config.CHATS_SWEEP_LIMIT
      );
      expect(result.content[0].text).toContain('Found 2 chats');
      expect(result.content[0].text).toContain('Project Alpha');
      expect(result.content[0].text).toContain('ID: chat-1');
    });

    test('should respect a custom count parameter', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      // The sweep always pages up to CHATS_SWEEP_LIMIT; the custom count only
      // bounds the rendered result.
      callGraphAPIPaginated.mockResolvedValue({ value: [mockChats[0], mockChats[1]] });

      const result = await handleListChats({ count: 1 });

      expect(callGraphAPIPaginated).toHaveBeenCalledWith(
        mockAccessToken,
        'GET',
        'me/chats',
        expect.objectContaining({ $top: 1 }),
        config.CHATS_SWEEP_LIMIT
      );
      expect(result.content[0].text).toContain('Found 1 chats');
    });

    test('should expose the pagination cursor when more pages exist', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      callGraphAPIPaginated.mockResolvedValue({
        value: [mockChats[0]],
        nextLink: 'https://graph.microsoft.com/v1.0/me/chats?$skip=1',
      });

      const result = await handleListChats({ count: 1 });

      expect(result.content[0].text).toContain(
        'nextLink: https://graph.microsoft.com/v1.0/me/chats?$skip=1'
      );
    });

    test('should follow a nextLink passthrough instead of building a query', async () => {
      const nextLink = 'https://graph.microsoft.com/v1.0/me/chats?$skip=1';
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      callGraphAPI.mockResolvedValue({ value: mockChats });

      const result = await handleListChats({ nextLink });

      expect(callGraphAPI).toHaveBeenCalledWith(mockAccessToken, 'GET', nextLink, null, {});
      expect(callGraphAPIPaginated).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain('Found 2 chats');
    });

    test('should surface an unnamed topic for chats without one', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      callGraphAPIPaginated.mockResolvedValue({
        value: [
          {
            id: 'chat-3',
            lastMessagePreview: 'Hi',
            lastUpdatedDateTime: '2024-03-13T08:00:00Z',
          },
        ],
      });

      const result = await handleListChats({});

      expect(result.content[0].text).toContain('(unnamed chat)');
    });
  });

  describe('empty results', () => {
    test('should state that no chats were found', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      callGraphAPIPaginated.mockResolvedValue({ value: [] });

      const result = await handleListChats({});

      expect(result.content[0].text).toBe('No chats found.');
    });
  });

  describe('error handling', () => {
    test('should handle authentication error without calling the API', async () => {
      ensureAuthenticated.mockRejectedValue(new Error('Authentication required'));

      const result = await handleListChats({});

      expect(result.content[0].text).toBe(
        "Authentication required. Please use the 'authenticate' tool first."
      );
      expect(callGraphAPIPaginated).not.toHaveBeenCalled();
    });

    test('should propagate Graph API errors', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      callGraphAPIPaginated.mockRejectedValue(new Error('Graph API Error'));

      const result = await handleListChats({});

      expect(result.content[0].text).toBe('Error listing chats: Graph API Error');
    });

    test('should surface UNAUTHORIZED when Graph rejects the token', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      callGraphAPIPaginated.mockRejectedValue(new Error('UNAUTHORIZED'));

      const result = await handleListChats({});

      expect(result.content[0].text).toBe('Error listing chats: UNAUTHORIZED');
    });
  });

  describe('activity ordering (issue #35)', () => {
    test('sweeps unsorted pages and renders newest-first', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      // Graph pages accumulate unsorted (issue #35): the older chat can arrive
      // before the fresher one within the swept value array.
      callGraphAPIPaginated.mockResolvedValue({
        value: [
          { id: 'chat-old', topic: 'Old chat', lastUpdatedDateTime: '2024-01-01T00:00:00Z' },
          { id: 'chat-new', topic: 'Fresh chat', lastUpdatedDateTime: '2025-01-05T00:00:00Z' },
        ],
      });

      const result = await handleListChats({ count: 2 });

      const text = result.content[0].text;
      expect(text.indexOf('1. Fresh chat')).toBeGreaterThan(-1);
      expect(text.indexOf('Old chat')).toBeGreaterThan(text.indexOf('Fresh chat'));
    });
  });

  describe('stale lastUpdatedDateTime ordering', () => {
    // Graph keeps lastUpdatedDateTime stale for oneOnOne chats: a chat with
    // messages received today can still report a months-old timestamp.
    const staleChat = {
      id: 'stale-one-on-one',
      topic: 'Blas chat',
      chatType: 'oneOnOne',
      lastUpdatedDateTime: '2026-04-17T18:49:08Z',
    };
    const freshMeeting = {
      id: 'fresh-meeting',
      topic: 'Meeting chat',
      chatType: 'meeting',
      lastUpdatedDateTime: '2026-10-14T16:41:49Z',
    };

    function sweepWith(chats) {
      callGraphAPIPaginated.mockImplementation(async (token, method, path) => {
        if (path === 'me/chats') {
          // Clone so handler mutations (lastActivityDateTime probing) on one
          // test's chat objects cannot leak into the next test.
          return { value: chats.map((chat) => ({ ...chat })) };
        }
        return { value: [] };
      });
    }

    // Graph does not guarantee message ordering without an explicit $orderby
    // (its implicit order follows lastModifiedDateTime), so the probe's
    // "$top: 1 without order" used to hand back an old message and bury a
    // recently active oneOnOne chat beyond the rendered slice. The probe must
    // ask Graph for newest first and skip system event entries.
    test('probe asks Graph for newest-first and skips system events', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      sweepWith([staleChat]);
      callGraphAPI.mockImplementation(async (token, method, path) => {
        if (path.startsWith('me/chats/stale-one-on-one/messages')) {
          // Newest first, as $orderby desc guarantees: the first entry is a
          // system event, the real latest message follows.
          return {
            value: [
              {
                id: 'evt',
                createdDateTime: '2026-10-16T00:00:00Z',
                body: { content: '<systemEventMessage/>' },
              },
              {
                id: 'm1',
                createdDateTime: '2026-10-15T16:53:16Z',
                body: { content: '<p>real</p>' },
              },
            ],
          };
        }
        return { value: [] };
      });

      const result = await handleListChats({ count: 1 });

      // The probe request itself must carry the explicit order.
      expect(callGraphAPI).toHaveBeenCalledWith(
        mockAccessToken,
        'GET',
        expect.stringContaining('me/chats/stale-one-on-one/messages'),
        expect.objectContaining({ $orderby: 'createdDateTime desc' })
      );
      // The system event must not be taken as the chat's latest activity.
      expect(result.content[0].text).toContain(new Date('2026-10-15T16:53:16Z').toLocaleString());
    });

    test('states how many swept chats were truncated from the render', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      // Full sweep of 173 chats, rendered count capped at 50: the caller must
      // never read "Found 50 chats" as a complete listing.
      const many = Array.from({ length: 173 }, (_, i) => ({
        id: `chat-${i}`,
        topic: `Chat ${i}`,
        lastUpdatedDateTime: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`,
      }));
      callGraphAPIPaginated.mockResolvedValue({
        value: many,
        '@odata.count': 173,
      });

      const result = await handleListChats({ count: 50 });

      expect(result.content[0].text).toContain('Found 50 of 173 chats');
    });

    test('ranks a oneOnOne chat by its latest real message, not stale metadata', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      sweepWith([staleChat, freshMeeting]);
      callGraphAPI.mockImplementation(async (token, method, path) => {
        if (path.startsWith('me/chats/stale-one-on-one/messages')) {
          return { value: [{ id: 'm1', createdDateTime: '2026-10-15T16:53:16Z' }] };
        }
        return { value: [] };
      });

      const result = await handleListChats({ count: 2 });

      const text = result.content[0].text;
      expect(text.indexOf('1. Blas chat')).toBeGreaterThan(-1);
      expect(text.indexOf('Meeting chat')).toBeGreaterThan(text.indexOf('Blas chat'));
    });

    test('does not probe meeting chats, whose metadata is reliable', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      sweepWith([freshMeeting]);

      const result = await handleListChats({ count: 1 });

      expect(callGraphAPI).not.toHaveBeenCalledWith(
        mockAccessToken,
        'GET',
        'me/chats/fresh-meeting/messages',
        expect.anything(),
        expect.anything()
      );
      expect(result.content[0].text).toContain('Found 1 chats');
    });

    test('falls back to the chat metadata when the probe fails', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      sweepWith([staleChat]);
      callGraphAPI.mockRejectedValue(new Error('probe failed'));

      const result = await handleListChats({ count: 1 });

      expect(result.content[0].text).toContain('Blas chat');
      expect(result.content[0].text).toContain('ID: stale-one-on-one');
    });

    test('falls back to the chat metadata when the probe returns no message', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      sweepWith([staleChat]);
      callGraphAPI.mockResolvedValue({ value: [] });

      const result = await handleListChats({ count: 1 });

      const text = result.content[0].text;
      expect(text).toContain('Blas chat');
      // The empty probe leaves no probed activity time, so the rendered
      // "Last updated" must come from the swept metadata.
      expect(text).toContain(new Date(staleChat.lastUpdatedDateTime).toLocaleString());
    });

    test('renders the probed activity time as the shown Last updated', async () => {
      ensureAuthenticated.mockResolvedValue(mockAccessToken);
      sweepWith([staleChat]);
      callGraphAPI.mockImplementation(async (token, method, path) => {
        if (path.startsWith('me/chats/stale-one-on-one/messages')) {
          return { value: [{ id: 'm1', createdDateTime: '2026-10-15T16:53:16Z' }] };
        }
        return { value: [] };
      });

      const result = await handleListChats({ count: 1 });

      const text = result.content[0].text;
      // Graph reported April, but the probed message arrived in October: the
      // rendered date must be the probed one, not the stale metadata.
      expect(text).toContain(new Date('2026-10-15T16:53:16Z').toLocaleString());
      expect(text).not.toContain(new Date(staleChat.lastUpdatedDateTime).toLocaleString());
    });
  });
});
