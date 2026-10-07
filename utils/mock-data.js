/**
 * Mock data functions for test mode
 */

/**
 * Applies a Graph $filter to a mock message list.
 *
 * KNOWN LIMITATION: only the predicate shapes this codebase emits are honored —
 * `receivedDateTime ge <literal>`, `receivedDateTime le <literal>`,
 * `hasAttachments eq true`, and `isRead eq false`, joined by " and ".
 * Any other $filter content (functions, other properties, quoting styles)
 * is ignored and the full list is returned.
 *
 * @param {Array<object>} list - Mock messages
 * @param {object} queryParams - Query parameters possibly containing $filter
 * @returns {Array<object>} Filtered messages
 */
function filterMockMessages(list, queryParams) {
  const filter = queryParams && queryParams.$filter;
  if (!filter) {
    return list;
  }

  const geMatch = filter.match(/receivedDateTime\s+ge\s+(\S+)/);
  const leMatch = filter.match(/receivedDateTime\s+le\s+(\S+)/);
  const after = geMatch ? new Date(geMatch[1]) : null;
  const before = leMatch ? new Date(leMatch[1]) : null;

  return list.filter((msg) => {
    const msgDate = new Date(msg.receivedDateTime);

    if (after && msgDate < after) {
      return false;
    }
    if (before && msgDate > before) {
      return false;
    }
    if (filter.includes('hasAttachments eq true') && !msg.hasAttachments) {
      return false;
    }
    if (filter.includes('isRead eq false') && msg.isRead) {
      return false;
    }
    return true;
  });
}

/**
 * Simulates Microsoft Graph API responses for testing
 * @param {string} method - HTTP method
 * @param {string} path - API path
 * @param {object} data - Request data
 * @param {object} queryParams - Query parameters
 * @returns {object} - Simulated API response
 */
function simulateGraphAPIResponse(method, path, data, _queryParams) {
  console.error(`Simulating response for: ${method} ${path}`);

  if (method === 'GET') {
    if (path.includes('messages') && !path.includes('sendMail')) {
      // Attachment endpoints
      if (path.includes('/attachments')) {
        if (path.match(/\/messages\/[^/]+\/attachments\/[^/]+$/)) {
          // Single attachment response
          return {
            id: 'att-1',
            name: 'weekly-report.pdf',
            contentType: 'application/pdf',
            size: 1258291,
            isInline: false,
            contentBytes:
              'JVBERi0xLjQKJcOkw7zDtsO8CjIgMCBvYmoKPDwKL0xlbmd0aCAzIDAgUgovRmlsdGVyIC9GbGF0ZURlY29kZQo+PgpzdHJlYW0KeJzLSMwtykvMTbVSUEjNS85PycxLt1Uy1DNQUkjNzCtJTSxJzsjPS7VVqkwtVrKqVsoECVumVtpaxVZlFqfmlQDZQJZlXklqMVBnpVJ+ZklqUbFSbS0AkKEZGA==',
          };
        }

        // List attachments response
        return {
          value: [
            {
              id: 'att-1',
              name: 'weekly-report.pdf',
              contentType: 'application/pdf',
              size: 1258291,
              isInline: false,
              contentBytes:
                'JVBERi0xLjQKJcOkw7zDtsO8CjIgMCBvYmoKPDwKL0xlbmd0aCAzIDAgUgovRmlsdGVyIC9GbGF0ZURlY29kZQo+PgpzdHJlYW0KeJzLSMwtykvMTbVSUEjNS85PycxLt1Uy1DNQUkjNzCtJTSxJzsjPS7VVqkwtVrKqVsoECVumVtpaxVZlFqfmlQDZQJZlXklqMVBnpVJ+ZklqUbFSbS0AkKEZGA==',
            },
            {
              id: 'att-2',
              name: 'logo.png',
              contentType: 'image/png',
              size: 5120,
              isInline: true,
              contentBytes:
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
            },
          ],
        };
      }

      // Simulate a successful email list/search response
      if (path.includes('/messages/')) {
        // Single email response
        return {
          id: 'simulated-email-id',
          subject: 'Simulated Email Subject',
          from: {
            emailAddress: {
              name: 'Simulated Sender',
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
          receivedDateTime: new Date().toISOString(),
          bodyPreview: 'This is a simulated email preview...',
          body: {
            contentType: 'text',
            content:
              "This is the full content of the simulated email. Since we can't connect to the real Microsoft Graph API, we're returning this placeholder content instead.",
          },
          hasAttachments: false,
          importance: 'normal',
          isRead: false,
          internetMessageHeaders: [],
        };
      } else {
        // Email list response, honoring $filter (date and boolean predicates)
        const messages = [
          {
            id: 'simulated-email-1',
            subject: 'Important Meeting Tomorrow',
            from: {
              emailAddress: {
                name: 'John Doe',
                address: 'john@example.com',
              },
            },
            toRecipients: [
              {
                emailAddress: {
                  name: 'You',
                  address: 'you@example.com',
                },
              },
            ],
            ccRecipients: [],
            receivedDateTime: new Date().toISOString(),
            bodyPreview: "Let's discuss the project status...",
            hasAttachments: false,
            importance: 'high',
            isRead: false,
          },
          {
            id: 'simulated-email-2',
            subject: 'Weekly Report',
            from: {
              emailAddress: {
                name: 'Jane Smith',
                address: 'jane@example.com',
              },
            },
            toRecipients: [
              {
                emailAddress: {
                  name: 'You',
                  address: 'you@example.com',
                },
              },
            ],
            ccRecipients: [],
            receivedDateTime: new Date(Date.now() - 86400000).toISOString(), // Yesterday
            bodyPreview: 'Please find attached the weekly report...',
            hasAttachments: true,
            importance: 'normal',
            isRead: true,
          },
          {
            id: 'simulated-email-3',
            subject: 'Question about the project',
            from: {
              emailAddress: {
                name: 'Bob Johnson',
                address: 'bob@example.com',
              },
            },
            toRecipients: [
              {
                emailAddress: {
                  name: 'You',
                  address: 'you@example.com',
                },
              },
            ],
            ccRecipients: [],
            receivedDateTime: new Date(Date.now() - 172800000).toISOString(), // 2 days ago
            bodyPreview: 'I had a question about the timeline...',
            hasAttachments: false,
            importance: 'normal',
            isRead: false,
          },
        ];

        return { value: filterMockMessages(messages, _queryParams) };
      }
    } else if (path.includes('mailFolders')) {
      // Child folder lookup support for path-style folder references
      const CHILD_FOLDERS = {
        inbox: [{ id: 'inbox-child', displayName: 'InboxChild' }],
      };

      if (path.includes('childFolders')) {
        const parentId = path.split('/').find((segment, index, parts) => {
          return parts[index - 1] === 'mailFolders' && parts[index + 1] === 'childFolders';
        });
        return { value: CHILD_FOLDERS[parentId] || [] };
      }

      // Simulate a mail folders response
      return {
        value: [
          { id: 'inbox', displayName: 'Inbox' },
          { id: 'drafts', displayName: 'Drafts' },
          { id: 'sentItems', displayName: 'Sent Items' },
          { id: 'deleteditems', displayName: 'Deleted Items' },
          { id: 'tramite', displayName: 'Tramite' },
        ],
      };
    }
  } else if (method === 'POST') {
    if (path.endsWith('/createReply')) {
      return {
        id: 'simulated-reply-draft-id',
        subject: 'RE: Simulated Email Subject',
      };
    }

    if (path.endsWith('/reply') || path.includes('sendMail')) {
      // Simulate a successful email send or native reply
      return {};
    }
  } else if (method === 'PATCH' && path.includes('/messages/')) {
    return {
      id: path.split('/').at(-1),
      subject: 'RE: Simulated Email Subject',
      body: data && data.body,
    };
  }

  // If we get here, we don't have a simulation for this endpoint
  console.error(`No simulation available for: ${method} ${path}`);
  return {};
}

module.exports = {
  simulateGraphAPIResponse,
};
