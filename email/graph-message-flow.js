const { composeEmail } = require('../signature/composer');

async function composeNewMessage(args, message) {
  const composed = await composeEmail(args);
  return {
    ...message,
    body: { contentType: composed.contentType, content: composed.body },
    ...(composed.attachments.length > 0 ? { attachments: composed.attachments } : {}),
  };
}

module.exports = { composeNewMessage };
