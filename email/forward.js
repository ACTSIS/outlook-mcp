/**
 * Forward draft email functionality (issue #15)
 */
const { callGraphAPI } = require('../utils/graph-api');
const { ensureAuthenticated } = require('../auth');
const { composeReply, hasManagedSignature } = require('./graph-message-flow');
const { buildFileAttachments } = require('./attachment-builder');

/**
 * Forward draft handler
 * Creates a forwarded-message draft via Microsoft Graph:
 * POST /me/messages/{id}/createForward
 *
 * The draft quotes the original message thread (embedded images and signature
 * stay intact) and always starts with empty recipients so nothing leaks from
 * the original message.
 * @param {object} args - Tool arguments
 * @returns {object} - MCP response
 */
async function handleForwardDraft(args) {
  const {
    emailId,
    body = '',
    subject,
    importance = 'normal',
    isHtml,
    attachments,
    signatureName,
    includeSignature,
  } = args || {};

  try {
    if (!emailId) {
      return {
        content: [
          {
            type: 'text',
            text: 'emailId is required: pass the ID of the message to forward.',
          },
        ],
      };
    }

    // Build Graph fileAttachment objects from local paths BEFORE any Graph call
    // so a bad path fails without creating a draft (issue #14 behavior).
    const fileAttachments = attachments ? await buildFileAttachments(attachments) : null;

    const composed = await composeReply({
      body,
      isHtml,
      signatureName,
      includeSignature,
    });

    const accessToken = await ensureAuthenticated();
    const createEndpoint = `me/messages/${encodeURIComponent(emailId)}/createForward`;
    const forwardDraft = await callGraphAPI(accessToken, 'POST', createEndpoint);
    if (!forwardDraft || !forwardDraft.id) {
      throw new Error('Microsoft Graph createForward did not return a draft ID');
    }

    const draftId = forwardDraft.id;
    const endpoint = `me/messages/${encodeURIComponent(draftId)}`;
    const signed = hasManagedSignature(composed);
    let updatedDraft = forwardDraft;

    if (signed) {
      const quotedBody = forwardDraft.body?.content || '';
      const signedPatch = {
        body: {
          contentType: composed.contentType,
          content: `${composed.body}${quotedBody}`,
        },
      };
      if (subject) {
        signedPatch.subject = subject;
      }
      updatedDraft = await callGraphAPI(accessToken, 'PATCH', endpoint, signedPatch);
    } else if ((body && body.trim() !== '') || subject) {
      const patch = {};
      if (body && body.trim() !== '') {
        patch.body = {
          contentType: composed.contentType,
          content: body,
        };
      }
      if (subject) {
        patch.subject = subject;
      }
      updatedDraft = await callGraphAPI(accessToken, 'PATCH', endpoint, patch);
    }

    // Issue #15: guarantee NO recipient inheritance from the original message.
    const recipientsPatch = { toRecipients: [], ccRecipients: [], bccRecipients: [] };
    if (importance && importance !== 'normal') {
      recipientsPatch.importance = importance;
    }
    const finalDraft = await callGraphAPI(accessToken, 'PATCH', endpoint, recipientsPatch);

    // Post managed-signature CID images and caller-supplied file attachments to
    // the forward draft (issue #14 parity with deliverNativeReply).
    const postedAttachments = [...composed.attachments, ...(fileAttachments || [])];
    for (const attachment of postedAttachments) {
      await callGraphAPI(accessToken, 'POST', `${endpoint}/attachments`, attachment);
    }

    return {
      content: [
        {
          type: 'text',
          text: `Forward draft created successfully!\n\nDraft ID: ${finalDraft.id || updatedDraft.id || draftId}\nSubject: ${finalDraft.subject || updatedDraft.subject || forwardDraft.subject || '(no subject)'}\nRecipients: none (set them before sending)${postedAttachments.length > 0 ? `\nAttachments: ${postedAttachments.map((a) => a.name).join(', ')}` : ''}`,
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
      return {
        content: [
          {
            type: 'text',
            text: 'Forward draft creation was denied by Microsoft Graph (403). The token likely lacks Mail.ReadWrite scope. Re-authenticate with force=true to refresh consent, then try again.',
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: `Error creating forward draft: ${error.message}`,
        },
      ],
    };
  }
}

module.exports = handleForwardDraft;
