/**
 * Draft email functionality
 */
const { callGraphAPI } = require('../utils/graph-api');
const { ensureAuthenticated } = require('../auth');
const {
  composeNewMessage,
  composeReply,
  hasManagedSignature,
  deliverNativeReply,
  isEmailLikeAddress,
  sharedMailboxPrefix,
} = require('./graph-message-flow');
const { buildFileAttachments } = require('./attachment-builder');

/**
 * Draft email handler
 * Creates a draft in Outlook using Microsoft Graph:
 * POST /me/messages (or POST /users/{from}/messages for a shared mailbox)
 * @param {object} args - Tool arguments
 * @returns {object} - MCP response
 */
async function handleDraftEmail(args) {
  const {
    to,
    from,
    cc,
    bcc,
    subject = '',
    body = '',
    importance = 'normal',
    isHtml,
    replyToId,
    attachments,
  } = args || {};

  // Optional shared mailbox (issue #28): validate before authenticating so a
  // malformed address can never reach Microsoft Graph. Only an omitted `from`
  // (undefined/null) means "use my own mailbox"; any provided value, including
  // an empty string, must be a valid email-like address.
  const fromProvided = from !== undefined && from !== null;
  const fromArgument = !fromProvided ? '' : typeof from === 'string' ? from.trim() : String(from);
  if (fromProvided && !isEmailLikeAddress(fromArgument)) {
    return {
      content: [
        {
          type: 'text',
          text: `Invalid from address: '${from}'. Provide the UPN or email address of a shared mailbox (e.g. sac.soporte@actsis.com) with Full Access or Send As delegation granted to you in Exchange.`,
        },
      ],
    };
  }
  const messagePrefix = fromArgument ? sharedMailboxPrefix(fromArgument) : 'me/';

  try {
    // Build Graph fileAttachment objects from local paths BEFORE any Graph call
    // so a bad path fails without creating a draft (issue #14).
    const fileAttachments = attachments ? await buildFileAttachments(attachments) : null;
    // Format recipients only when provided
    const toRecipients = to
      ? to
          .split(',')
          .map((email) => ({
            emailAddress: { address: email.trim() },
          }))
          .filter((r) => r.emailAddress.address)
      : [];

    const ccRecipients = cc
      ? cc
          .split(',')
          .map((email) => ({
            emailAddress: { address: email.trim() },
          }))
          .filter((r) => r.emailAddress.address)
      : [];

    const bccRecipients = bcc
      ? bcc
          .split(',')
          .map((email) => ({
            emailAddress: { address: email.trim() },
          }))
          .filter((r) => r.emailAddress.address)
      : [];

    // Explicit isHtml takes precedence; preserve legacy auto-detection when omitted
    const contentType =
      isHtml === true
        ? 'html'
        : isHtml === false
          ? 'text'
          : typeof body === 'string' && body.toLowerCase().includes('<html')
            ? 'html'
            : 'text';

    if (replyToId) {
      const composed = await composeReply(args);
      const accessToken = await ensureAuthenticated();
      if (hasManagedSignature(composed)) {
        const { replyDraft, updatedDraft } = await deliverNativeReply(
          accessToken,
          replyToId,
          composed,
          false,
          callGraphAPI,
          fromArgument || undefined
        );
        // Post user-supplied attachments to the reply draft (issue #14)
        const nativeReplyDraftId = updatedDraft.id || replyDraft.id;
        for (const attachment of fileAttachments || []) {
          await callGraphAPI(
            accessToken,
            'POST',
            `${messagePrefix}messages/${encodeURIComponent(nativeReplyDraftId)}/attachments`,
            attachment
          );
        }
        return {
          content: [
            {
              type: 'text',
              text: `Reply draft created successfully!\n\nDraft ID: ${updatedDraft.id || replyDraft.id}\nSubject: ${updatedDraft.subject || replyDraft.subject || '(no subject)'}\nRecipients: inherited from original message${fileAttachments ? `\nAttachments: ${fileAttachments.map((a) => a.name).join(', ')}` : ''}`,
            },
          ],
        };
      }
      const replyDraft = await callGraphAPI(
        accessToken,
        'POST',
        `${messagePrefix}messages/${encodeURIComponent(replyToId)}/createReply`
      );
      if (!replyDraft || !replyDraft.id) {
        throw new Error('Microsoft Graph createReply did not return a draft ID');
      }
      const updatedDraft = await callGraphAPI(
        accessToken,
        'PATCH',
        `${messagePrefix}messages/${encodeURIComponent(replyDraft.id)}`,
        {
          body: {
            contentType,
            content: body,
          },
        }
      );

      // Post user-supplied attachments to the reply draft (issue #14)
      const replyDraftId = updatedDraft.id || replyDraft.id;
      for (const attachment of fileAttachments || []) {
        await callGraphAPI(
          accessToken,
          'POST',
          `${messagePrefix}messages/${encodeURIComponent(replyDraftId)}/attachments`,
          attachment
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Reply draft created successfully!\n\nDraft ID: ${updatedDraft.id || replyDraft.id}\nSubject: ${updatedDraft.subject || replyDraft.subject || '(no subject)'}\nRecipients: inherited from original message${fileAttachments ? `\nAttachments: ${fileAttachments.map((a) => a.name).join(', ')}` : ''}`,
          },
        ],
      };
    }

    // Create message payload for draft creation
    const messageObject = await composeNewMessage(args, {
      subject,
      body: {
        contentType,
        content: body,
      },
      toRecipients: toRecipients.length > 0 ? toRecipients : undefined,
      ccRecipients: ccRecipients.length > 0 ? ccRecipients : undefined,
      bccRecipients: bccRecipients.length > 0 ? bccRecipients : undefined,
      importance,
      ...(fileAttachments ? { attachments: fileAttachments } : {}),
    });

    // Create draft message
    const accessToken = await ensureAuthenticated();
    const draft = await callGraphAPI(
      accessToken,
      'POST',
      `${messagePrefix}messages`,
      messageObject
    );

    return {
      content: [
        {
          type: 'text',
          text: `Draft created successfully!\n\nDraft ID: ${draft.id}\nSubject: ${draft.subject || '(no subject)'}\nRecipients: ${toRecipients.length}${ccRecipients.length > 0 ? ` + ${ccRecipients.length} CC` : ''}${bccRecipients.length > 0 ? ` + ${bccRecipients.length} BCC` : ''}${fileAttachments ? `\nAttachments: ${fileAttachments.map((a) => a.name).join(', ')}` : ''}`,
        },
      ],
    };
  } catch (error) {
    if (error.message === 'Authentication required') {
      return {
        content: [
          {
            type: 'text',
            text: "Authentication required. Please use the 'authenticate' tool first.",
          },
        ],
      };
    }

    if (error.message && error.message.includes('status 403')) {
      // Shared-mailbox 403 (issue #28): the caller lacks the Exchange
      // delegation on the target mailbox. Surface it clearly, without the
      // generic Mail.ReadWrite consent guidance and without a /me fallback.
      if (fromArgument) {
        return {
          content: [
            {
              type: 'text',
              text: `Draft creation in shared mailbox '${fromArgument}' was denied by Microsoft Graph (HTTP 403; error code: MAILBOX_ACCESS_DENIED). You are missing the Full Access or Send As Exchange delegation on that mailbox; the mailbox owner or an admin must grant it to you. No fallback to your own mailbox was performed.`,
            },
          ],
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: 'Draft creation was denied by Microsoft Graph (403). The token likely lacks Mail.ReadWrite scope. Re-authenticate with force=true to refresh consent, then try again.',
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: `Error creating draft email: ${error.message}`,
        },
      ],
    };
  }
}

module.exports = handleDraftEmail;
