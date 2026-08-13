const { composeEmail } = require('../signature/composer');

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

async function deliverNativeReply(accessToken, replyToId, composed, send, callGraphAPI) {
  const replyDraft = await callGraphAPI(
    accessToken,
    'POST',
    `me/messages/${encodeURIComponent(replyToId)}/createReply`
  );
  if (!replyDraft || !replyDraft.id) {
    throw new Error('Microsoft Graph createReply did not return a draft ID');
  }

  const draftId = replyDraft.id;
  const endpoint = `me/messages/${encodeURIComponent(draftId)}`;
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

module.exports = { composeNewMessage, composeReply, hasManagedSignature, deliverNativeReply };
