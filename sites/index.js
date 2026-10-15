/**
 * SharePoint sites module for Outlook MCP server (issue #18, delegated access)
 */
const handleListSites = require('./list-sites');
const handleListSiteFiles = require('./list-site-files');
const handleDownloadSiteFile = require('./download-site-file');

// Sites tool definitions
const sitesTools = [
  {
    name: 'list-sites',
    description:
      'Lists SharePoint team sites accessible to the signed-in user (delegated access). Optionally searches sites by name. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Search text matched against site names (e.g. "disponibilidad"). Omit to list accessible sites.',
        },
        count: {
          type: 'number',
          description: 'Number of sites to retrieve (default: 25, max: 50)',
        },
      },
      required: [],
    },
    handler: handleListSites,
  },
  {
    name: 'list-site-files',
    description:
      "Lists files and folders in a SharePoint site's default document library (delegated access). Read-only.",
    inputSchema: {
      type: 'object',
      properties: {
        siteId: {
          type: 'string',
          description: "ID of the SharePoint site (from 'list-sites')",
        },
        path: {
          type: 'string',
          description:
            "Path within the site's default document library (e.g. '/Documents'). Defaults to the library root.",
        },
        count: {
          type: 'number',
          description: 'Number of items to retrieve (default: 25, max: 50)',
        },
      },
      required: ['siteId'],
    },
    handler: handleListSiteFiles,
  },
  {
    name: 'download-site-file',
    description:
      'Returns a pre-authenticated download URL for a file in a SharePoint site document library (delegated access). Read-only: it does not transfer or store file contents.',
    inputSchema: {
      type: 'object',
      properties: {
        siteId: {
          type: 'string',
          description: "ID of the SharePoint site (from 'list-sites')",
        },
        itemId: {
          type: 'string',
          description:
            "ID of the file item (from 'list-site-files'). Either itemId or path is required.",
        },
        path: {
          type: 'string',
          description:
            "Path of the file within the site's default document library (e.g. '/Reports/availability.xlsx'). Either itemId or path is required.",
        },
      },
      required: ['siteId'],
    },
    handler: handleDownloadSiteFile,
  },
];

module.exports = { sitesTools };
