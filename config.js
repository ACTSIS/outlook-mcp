/**
 * Configuration for Outlook MCP Server
 */
const path = require('path');
const os = require('os');

// Ensure we have a home directory path even if process.env.HOME is undefined
const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir() || '/tmp';
const DEFAULT_AUTH_SCOPES = Object.freeze([
  'offline_access',
  'User.Read',
  'Mail.Read',
  'Mail.ReadWrite',
  'Mail.Send',
  'Calendars.Read',
  'Calendars.ReadWrite',
  'Contacts.Read',
  'Files.Read',
  'Files.ReadWrite',
]);

function getAuthorityHost() {
  return (process.env.MS_AUTHORITY_HOST || 'https://login.microsoftonline.com').replace(/\/+$/, '');
}

function getConfiguredScopes() {
  return process.env.MS_SCOPES
    ? process.env.MS_SCOPES.split(/\s+/).filter(Boolean)
    : [...DEFAULT_AUTH_SCOPES];
}

const AUTH_CONFIG = {
  clientId: process.env.OUTLOOK_CLIENT_ID || process.env.MS_CLIENT_ID || '',
  clientSecret: process.env.OUTLOOK_CLIENT_SECRET || process.env.MS_CLIENT_SECRET || '',
  redirectUri: process.env.MS_REDIRECT_URI || 'http://localhost:3333/auth/callback',
  scopes: getConfiguredScopes(),
  tenantId: process.env.MS_TENANT_ID || 'common',
  authorityHost: getAuthorityHost(),
  tokenEndpoint:
    process.env.MS_TOKEN_ENDPOINT ||
    `${getAuthorityHost()}/${process.env.MS_TENANT_ID || 'common'}/oauth2/v2.0/token`,
  authEndpoint:
    process.env.MS_AUTH_ENDPOINT ||
    `${getAuthorityHost()}/${process.env.MS_TENANT_ID || 'common'}/oauth2/v2.0/authorize`,
  tokenStorePath: path.join(homeDir, '.outlook-mcp-tokens.json'),
  authServerUrl: 'http://localhost:3333',
};

/**
 * Refresh the mutable authentication settings after Vault setup changes the
 * allowlisted runtime environment in the current MCP process.
 * @returns {object} The shared authentication configuration object
 */
function refreshAuthConfig() {
  const authorityHost = getAuthorityHost();
  const tenantId = process.env.MS_TENANT_ID || 'common';

  Object.assign(AUTH_CONFIG, {
    clientId: process.env.OUTLOOK_CLIENT_ID || process.env.MS_CLIENT_ID || '',
    clientSecret: process.env.OUTLOOK_CLIENT_SECRET || process.env.MS_CLIENT_SECRET || '',
    redirectUri: process.env.MS_REDIRECT_URI || 'http://localhost:3333/auth/callback',
    scopes: getConfiguredScopes(),
    tenantId,
    authorityHost,
    tokenEndpoint:
      process.env.MS_TOKEN_ENDPOINT || `${authorityHost}/${tenantId}/oauth2/v2.0/token`,
    authEndpoint:
      process.env.MS_AUTH_ENDPOINT || `${authorityHost}/${tenantId}/oauth2/v2.0/authorize`,
  });

  return AUTH_CONFIG;
}

module.exports = {
  // Server information
  SERVER_NAME: 'm365-assistant',
  SERVER_VERSION: '2.0.0',

  // Test mode setting
  USE_TEST_MODE: process.env.USE_TEST_MODE === 'true',

  // Authentication configuration
  AUTH_CONFIG,
  refreshAuthConfig,

  // Microsoft Graph API
  GRAPH_API_ENDPOINT: 'https://graph.microsoft.com/v1.0/',

  // Calendar constants
  CALENDAR_SELECT_FIELDS: 'id,subject,start,end,location,bodyPreview,isAllDay,recurrence,attendees',

  // Email constants
  EMAIL_SELECT_FIELDS:
    'id,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,hasAttachments,importance,isRead',
  EMAIL_DETAIL_FIELDS:
    'id,subject,from,toRecipients,ccRecipients,bccRecipients,receivedDateTime,bodyPreview,body,hasAttachments,importance,isRead,internetMessageHeaders',

  // Pagination
  DEFAULT_PAGE_SIZE: 25,
  MAX_RESULT_COUNT: 50,

  // Timezone
  DEFAULT_TIMEZONE: 'Central European Standard Time',

  // OneDrive constants
  ONEDRIVE_SELECT_FIELDS: 'id,name,size,lastModifiedDateTime,webUrl,folder,file,parentReference',
  ONEDRIVE_UPLOAD_THRESHOLD: 4 * 1024 * 1024, // 4MB - files larger than this need chunked upload

  // Attachment constants
  ATTACHMENT_SIZE_WARNING_THRESHOLD: 10 * 1024 * 1024, // 10MB - warn when downloading larger attachments

  // Power Automate / Flow constants
  FLOW_API_ENDPOINT: 'https://api.flow.microsoft.com',
  FLOW_SCOPE: 'https://service.flow.microsoft.com/.default',
};
