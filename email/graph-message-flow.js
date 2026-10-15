const { composeEmail } = require('../signature/composer');

/**
 * Whether a value looks like an email address (shared mailbox UPN/email).
 * Used to validate the optional `from` argument of send/draft tools before
 * any authentication or Graph call is made (issue #28).
 * @param {string} value - Candidate mailbox address
 * @returns {boolean} True when the value is email-like
 */
function isEmailLikeAddress(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/**
 * Builds the Graph path prefix of a shared mailbox, encoding the address.
 * @param {string} mailbox - Shared mailbox UPN/email address
 * @returns {string} Encoded `users/{mailbox}/` path prefix
 */
function sharedMailboxPrefix(mailbox) {
  return `users/${encodeURIComponent(mailbox)}/`;
}

async function composeNewMessage(args, message) {
  const composed = await composeEmail(args);
  return {
    ...message,
    body: { contentType: composed.contentType, content: composed.body },
    ...(composed.attachments.length > 0 ? { attachments: composed.attachments } : {}),
  };
}

async function composeReply(args) {
  return composeEmail(args);
}

function hasManagedSignature(composed) {
  return composed.hasSignature === true;
}

/**
 * Creates a native reply draft (and optionally sends it) against a message.
 * @param {string} accessToken - Graph access token
 * @param {string} replyToId - Original message ID
 * @param {object} composed - Composed body/attachments from composeEmail
 * @param {boolean} send - Whether to send the reply after composing
 * @param {Function} callGraphAPI - Graph transport function
 * @param {string} [sharedMailbox] - Optional shared mailbox UPN/email; when
 *   provided, every reply endpoint targets users/{mailbox}/messages instead
 *   of the /me message collection (issue #28).
 * @returns {Promise<object>} Object with the raw replyDraft and the updatedDraft
 */
async function deliverNativeReply(
  accessToken,
  replyToId,
  composed,
  send,
  callGraphAPI,
  sharedMailbox
) {
  const prefix = sharedMailbox ? sharedMailboxPrefix(sharedMailbox) : 'me/';
  const replyDraft = await callGraphAPI(
    accessToken,
    'POST',
    `${prefix}messages/${encodeURIComponent(replyToId)}/createReply`
  );
  if (!replyDraft || !replyDraft.id) {
    throw new Error('Microsoft Graph createReply did not return a draft ID');
  }

  const draftId = replyDraft.id;
  const endpoint = `${prefix}messages/${encodeURIComponent(draftId)}`;
  const quotedBody = replyDraft.body?.content || '';
  let updatedDraft;
  try {
    updatedDraft = await callGraphAPI(accessToken, 'PATCH', endpoint, {
      body: {
        contentType: composed.contentType,
        content: `${composed.body}${quotedBody}`,
      },
    });
  } catch (error) {
    throw new Error(`Reply draft ${draftId} failed during body update: ${error.message}`);
  }

  for (const [index, attachment] of composed.attachments.entries()) {
    try {
      await callGraphAPI(accessToken, 'POST', `${endpoint}/attachments`, attachment);
    } catch (error) {
      throw new Error(
        `Reply draft ${draftId} failed during attachment ${index + 1}: ${error.message}`
      );
    }
  }

  if (send) {
    try {
      await callGraphAPI(accessToken, 'POST', `${endpoint}/send`);
    } catch (error) {
      throw new Error(`Reply draft ${draftId} failed during send: ${error.message}`);
    }
  }
  return { replyDraft, updatedDraft: updatedDraft || {} };
}

module.exports = {
  composeNewMessage,
  composeReply,
  hasManagedSignature,
  deliverNativeReply,
  isEmailLikeAddress,
  sharedMailboxPrefix,
};
