/**
 * Tests for recursive, paginated folder enumeration (issue #16, bug A).
 * getAllFoldersHierarchy must return folders at every nesting level, follow
 * @odata.nextLink pages, and attribute parents for the tree formatter.
 */
const handleListFolders = require('../../folder/list');
const { ensureAuthenticated } = require('../../auth');
const { callGraphAPI } = require('../../utils/graph-api');

jest.mock('../../utils/graph-api');
jest.mock('../../auth');

function folder(id, displayName, parentFolderId, childFolderCount) {
  return {
    id,
    displayName,
    parentFolderId,
    childFolderCount,
    totalItemCount: 0,
    unreadItemCount: 0,
  };
}

describe('getAllFoldersHierarchy via handleListFolders (recursive + paginated)', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    ensureAuthenticated.mockResolvedValue('token');
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    console.error.mockRestore();
  });

  test('should enumerate second-level folders (existing behavior)', async () => {
    callGraphAPI.mockImplementation(async (_t, _m, path, _d, params) => {
      if (path === 'me/mailFolders' && !params.$filter) {
        return { value: [folder('root-1', 'Trámite', null, 1)] };
      }
      return { value: [folder('child-1', 'REQ-104951', 'root-1', 0)] };
    });

    const result = await handleListFolders({ includeChildren: true });
    const text = result.content[0].text;
    expect(text).toContain('Trámite');
    expect(text).toContain('REQ-104951');
  });

  test('should enumerate third-level folders beyond one nesting level (issue #16 bug A)', async () => {
    callGraphAPI.mockImplementation(async (_t, _m, path, _d, params) => {
      if (path === 'me/mailFolders' && !params.$filter) {
        return { value: [folder('a', 'A', null, 1)] };
      }
      if (path === 'me/mailFolders/a/childFolders') {
        return { value: [folder('b', 'B', 'a', 1)] };
      }
      if (path === 'me/mailFolders/b/childFolders') {
        return { value: [folder('c', 'C', 'b', 0)] };
      }
      return { value: [] };
    });

    const result = await handleListFolders({ includeChildren: true });
    const text = result.content[0].text;
    expect(text).toContain('A');
    expect(text).toContain('B');
    expect(text).toContain('C'); // previously missing: only one level descended
    expect(text).toMatch(/B\n\s+C/); // C indented under B (third level rendered)
  });

  test('should follow @odata.nextLink pages when a folder level exceeds one page', async () => {
    const page = (prefix, from, to) => ({
      value: Array.from({ length: to - from }, (_, i) =>
        folder(`f${from + i}`, `Folder${from + i}`, 'root', 0)
      ),
    });
    const pageUrl = (n) => `https://graph.microsoft.com/v1.0/me/mailFolders?page=${n}`;

    callGraphAPI.mockImplementation(async (_t, _m, path) => {
      if (path === 'me/mailFolders') {
        return {
          value: [folder('root', 'Root', null, 1)],
          '@odata.nextLink': pageUrl(2),
        };
      }
      if (path === 'me/mailFolders/root/childFolders') {
        return { value: page('p1', 0, 3).value, '@odata.nextLink': pageUrl(3) };
      }
      if (path === pageUrl(3)) {
        return { value: page('p2', 3, 5).value }; // last page, no nextLink
      }
      return { value: [] };
    });

    const result = await handleListFolders({ includeChildren: true });
    const text = result.content[0].text;
    expect(text).toContain('Folder0');
    expect(text).toContain('Folder4'); // lives on page 2 of the child sweep
    expect(text).toContain('Folder Hierarchy');
  });

  test('should attribute parent display names for nested children', async () => {
    callGraphAPI.mockImplementation(async (_t, _m, path) => {
      if (path === 'me/mailFolders') {
        return { value: [folder('a', 'A', null, 1)] };
      }
      if (path === 'me/mailFolders/a/childFolders') {
        return { value: [folder('b', 'B', 'a', 1)] };
      }
      if (path === 'me/mailFolders/b/childFolders') {
        return { value: [folder('c', 'C', 'b', 0)] };
      }
      return { value: [] };
    });

    const result = await handleListFolders({ includeChildren: true });
    const text = result.content[0].text;
    expect(text).toMatch(/B\n\s+C/); // indent shows C nested under B
  });

  test('should not loop forever on a folder graph cycle', async () => {
    // Malicious/defensive mock: pretend b's children include b itself.
    let calls = 0;
    callGraphAPI.mockImplementation(async (_t, _m, path) => {
      if (path === 'me/mailFolders') {
        return { value: [folder('a', 'A', null, 1)] };
      }
      if (calls++ < 50) {
        return { value: [folder('b', 'B', 'a', 1)] };
      }
      return { value: [] };
    });

    const result = await handleListFolders({ includeChildren: true });
    expect(result.content[0].text).toContain('Folder Hierarchy');
    // A cycle like A->B->B' must terminate in a bounded number of calls, not
    // hang (the first 3 calls here are top-level + 2 child fetches for a and
    // its reported child; a fourth descent would mean revisiting b).
    expect(callGraphAPI.mock.calls.length).toBeLessThanOrEqual(10);
  });

  test('flat listing (includeChildren false) also contains nested folders', async () => {
    callGraphAPI.mockImplementation(async (_t, _m, path) => {
      if (path === 'me/mailFolders') {
        return { value: [folder('a', 'A', null, 1)] };
      }
      if (path === 'me/mailFolders/a/childFolders') {
        return { value: [folder('b', 'B', 'a', 1)] };
      }
      if (path === 'me/mailFolders/b/childFolders') {
        return { value: [folder('c', 'C', 'b', 0)] };
      }
      return { value: [] };
    });

    const result = await handleListFolders({});
    const text = result.content[0].text;
    expect(text).toContain('A');
    expect(text).toContain('B (in A)');
    expect(text).toContain('C'); // deep folder present in flat list too
  });
});
