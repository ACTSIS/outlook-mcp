/**
 * Send email functionality
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

/**
 * Send email handler
 * @param {object} args - Tool arguments
 * @returns {object} - MCP response
 */
async function handleSendEmail(args) {
  const {
    to,
    from,
    cc,
    bcc,
    subject,
    body,
    importance = 'normal',
    saveToSentItems = true,
    isHtml,
    replyToId,
  } = args;

  // Validate required parameters
  if (!replyToId && !to) {
    return {
      content: [
        {
          type: 'text',
          text: 'Recipient (to) is required.',
        },
      ],
    };
  }

  if (!replyToId && !subject) {
    return {
      content: [
        {
          type: 'text',
          text: 'Subject is required.',
        },
      ],
    };
  }

  if (!body) {
    return {
      content: [
        {
          type: 'text',
          text: 'Body content is required.',
        },
      ],
    };
  }

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
          text: `Invalid from address: '${from}'. Provide the UPN or email address of a shared mailbox (e.g. sac.soporte@actsis.com) with Send As or Full Access delegation granted to you in Exchange.`,
        },
      ],
    };
  }
  const messagePrefix = fromArgument ? sharedMailboxPrefix(fromArgument) : 'me/';

  try {
    // Determine content type: explicit isHtml param takes precedence, otherwise auto-detect
    const contentType =
      isHtml === true
        ? 'html'
        : isHtml === false
          ? 'text'
          : body.includes('<html') || body.includes('<HTML')
            ? 'html'
            : 'text';

    if (replyToId) {
      const composed = await composeReply(args);
      const accessToken = await ensureAuthenticated();
      if (hasManagedSignature(composed)) {
        await deliverNativeReply(
          accessToken,
          replyToId,
          composed,
          true,
          callGraphAPI,
          fromArgument || undefined
        );
      } else {
        await callGraphAPI(
          accessToken,
          'POST',
          `${messagePrefix}messages/${encodeURIComponent(replyToId)}/reply`,
          {
            message: {
              body: {
                contentType,
                content: body,
              },
            },
          }
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Reply sent successfully to the original message!\n\nMessage Length: ${body.length} characters`,
          },
        ],
      };
    }

    // Format recipients
    const toRecipients = to
      ? to.split(',').map((email) => {
          email = email.trim();
          return {
            emailAddress: {
              address: email,
            },
          };
        })
      : [];

    const ccRecipients = cc
      ? cc.split(',').map((email) => {
          email = email.trim();
          return {
            emailAddress: {
              address: email,
            },
          };
        })
      : [];

    const bccRecipients = bcc
      ? bcc.split(',').map((email) => {
          email = email.trim();
          return {
            emailAddress: {
              address: email,
            },
          };
        })
      : [];

    // Prepare email object
    const message = await composeNewMessage(args, {
      subject,
      body: {
        contentType: contentType,
        content: body,
      },
      toRecipients,
      ccRecipients: ccRecipients.length > 0 ? ccRecipients : undefined,
      bccRecipients: bccRecipients.length > 0 ? bccRecipients : undefined,
      importance,
    });
    const emailObject = {
      message,
      saveToSentItems,
    };

    // Make API call to send email
    const accessToken = await ensureAuthenticated();
    await callGraphAPI(accessToken, 'POST', `${messagePrefix}sendMail`, emailObject);

    return {
      content: [
        {
          type: 'text',
          text: `Email sent successfully!\n\nSubject: ${subject}\nRecipients: ${toRecipients.length}${ccRecipients.length > 0 ? ` + ${ccRecipients.length} CC` : ''}${bccRecipients.length > 0 ? ` + ${bccRecipients.length} BCC` : ''}\nMessage Length: ${body.length} characters`,
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

    // Shared-mailbox 403 (issue #28): the caller lacks the Exchange delegation
    // on the target mailbox. Surface it clearly and never fall back to /me.
    if (fromArgument && error.message && error.message.includes('status 403')) {
      return {
        content: [
          {
            type: 'text',
            text: `Send to shared mailbox '${fromArgument}' was denied by Microsoft Graph (HTTP 403; error code: MAILBOX_ACCESS_DENIED). You are missing the Send As or Full Access Exchange delegation on that mailbox; the mailbox owner or an admin must grant it to you. No fallback to your own mailbox was performed.`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: `Error sending email: ${error.message}`,
        },
      ],
    };
  }
}

module.exports = handleSendEmail;
