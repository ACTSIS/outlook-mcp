const { sitesTools } = require('../../sites');
const handleListSitesDirect = require('../../sites/list-sites');
const handleListSiteFilesDirect = require('../../sites/list-site-files');
const handleDownloadSiteFileDirect = require('../../sites/download-site-file');

describe('sites tool definitions', () => {
  it('exports exactly the three approved read-only SharePoint tools in order', () => {
    expect(sitesTools.map((tool) => tool.name)).toEqual([
      'list-sites',
      'list-site-files',
      'download-site-file',
    ]);
  });

  it('exposes required fields per tool', () => {
    const listSites = sitesTools.find((tool) => tool.name === 'list-sites');
    const listSiteFiles = sitesTools.find((tool) => tool.name === 'list-site-files');
    const downloadSiteFile = sitesTools.find((tool) => tool.name === 'download-site-file');

    expect(listSites.inputSchema.required).toEqual([]);

    expect(listSiteFiles.inputSchema.required).toEqual(['siteId']);
    expect(listSiteFiles.inputSchema.properties).toHaveProperty('path');
    expect(listSiteFiles.inputSchema.properties).toHaveProperty('count');

    expect(downloadSiteFile.inputSchema.required).toEqual(['siteId']);
    expect(downloadSiteFile.inputSchema.properties).toHaveProperty('itemId');
    expect(downloadSiteFile.inputSchema.properties).toHaveProperty('path');
  });

  it('binds each definition to its handler module', () => {
    const byName = (name) => sitesTools.find((tool) => tool.name === name);

    expect(byName('list-sites').handler).toBe(handleListSitesDirect);
    expect(byName('list-site-files').handler).toBe(handleListSiteFilesDirect);
    expect(byName('download-site-file').handler).toBe(handleDownloadSiteFileDirect);
  });

  it('requests no write or app-only capability in descriptions or schemas', () => {
    const serialized = JSON.stringify(sitesTools);
    expect(serialized).not.toMatch(/application[- ]only|client.?credentials|delegated write/i);
  });
});
