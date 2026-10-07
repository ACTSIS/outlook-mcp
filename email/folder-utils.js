/**
 * Email folder utilities
 */
const { callGraphAPI } = require('../utils/graph-api');

/**
 * Fetch a folder listing with nextLink pagination, following every page before
 * returning the combined value array. Guards against runaway loops with a page
 * cap well above any realistic mailbox (issue #16, bug A).
 * @param {string} accessToken - Access token
 * @param {string} path - Graph endpoint to fetch
 * @param {object} params - Query params for the first request
 * @returns {Promise<Array>} - Combined folder value array across pages
 */
const MAX_PAGING_ROUNDS = 50;
async function fetchAllPages(accessToken, path, params = {}) {
  const items = [];
  let currentUrl = path;
  let currentParams = params;
  for (let round = 0; round < MAX_PAGING_ROUNDS; round++) {
    const response = await callGraphAPI(accessToken, 'GET', currentUrl, null, currentParams);
    if (response && Array.isArray(response.value)) {
      items.push(...response.value);
    }
    const nextLink = response && response['@odata.nextLink'];
    if (!nextLink) {
      break;
    }
    currentUrl = nextLink;
    currentParams = {}; // nextLink already encodes the query
  }
  return items;
}

/**
 * Well-known folder names and their endpoints
 */
const WELL_KNOWN_FOLDERS = {
  inbox: 'me/mailFolders/inbox/messages',
  drafts: 'me/mailFolders/drafts/messages',
  sent: 'me/mailFolders/sentItems/messages',
  deleted: 'me/mailFolders/deletedItems/messages',
  junk: 'me/mailFolders/junkemail/messages',
  archive: 'me/mailFolders/archive/messages',
};

/**
 * Resolve a folder name to its endpoint path. Resolution is strict: an unknown
 * folder (or a failed lookup) throws a clear "Folder not found" error instead
 * of silently falling back to the inbox, which used to return unrelated search
 * results with no visible failure (issue #16, bug B).
 * @param {string} accessToken - Access token
 * @param {string} folderName - Folder name or Parent/Child path
 * @returns {Promise<string>} - Resolved endpoint path
 */
async function resolveFolderPath(accessToken, folderName) {
  // Default to inbox if no folder specified
  if (!folderName) {
    return WELL_KNOWN_FOLDERS['inbox'];
  }

  // Check if it's a well-known folder (case-insensitive)
  const lowerFolderName = folderName.toLowerCase();
  if (WELL_KNOWN_FOLDERS[lowerFolderName]) {
    console.error(`Using well-known folder path for "${folderName}"`);
    return WELL_KNOWN_FOLDERS[lowerFolderName];
  }

  let folderId;
  try {
    folderId = await getFolderIdByName(accessToken, folderName);
  } catch (error) {
    throw new Error(`Folder not found: '${folderName}' (lookup failed: ${error.message})`);
  }

  if (!folderId) {
    throw new Error(
      `Folder not found: '${folderName}'. Verify the folder exists; use 'list-folders' for valid names. Subfolders require the full path (e.g. 'Parent/Child').`
    );
  }

  const path = `me/mailFolders/${folderId}/messages`;
  console.error(`Resolved folder "${folderName}" to path: ${path}`);
  return path;
}

/**
 * Resolve a single folder segment within a parent folder
 * @param {string} accessToken - Access token
 * @param {string|null} parentId - Parent folder ID, or null for top-level
 * @param {string} segment - Folder segment name to resolve
 * @returns {Promise<string|null>} - Folder ID or null if not found
 */
async function resolveSegmentInParent(accessToken, parentId, segment) {
  const base = parentId ? `me/mailFolders/${parentId}/childFolders` : 'me/mailFolders';

  // First try with exact match filter. Paginate: large tenants can exceed the
  // default page size (issue #16, bug A).
  const escapedSegment = segment.replace(/'/g, "''");
  const response = await fetchAllPages(accessToken, base, {
    $filter: `displayName eq '${escapedSegment}'`,
  });

  if (response && response.length > 0) {
    return response[0].id;
  }

  // If exact match fails, try to get all folders under the parent and do a
  // case-insensitive comparison. Paginate fully before scanning (issue #16).
  const allFolders = await fetchAllPages(accessToken, base);

  if (allFolders) {
    const lowerSegment = segment.toLowerCase();
    const matchingFolder = allFolders.find(
      (folder) => folder.displayName.toLowerCase() === lowerSegment
    );

    if (matchingFolder) {
      return matchingFolder.id;
    }
  }

  return null;
}

/**
 * Get the ID of a mail folder by its name or path
 * @param {string} accessToken - Access token
 * @param {string} folderName - Name or path (e.g. "Tramite/REQ-104951") of the folder to find
 * @returns {Promise<string|null>} - Folder ID or null if not found
 */
async function getFolderIdByName(accessToken, folderName) {
  const segments = folderName
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length === 0) {
    return null;
  }

  try {
    let currentId = null;
    for (const segment of segments) {
      currentId = await resolveSegmentInParent(accessToken, currentId, segment);
      if (currentId === null) {
        return null;
      }
    }
    return currentId;
  } catch (error) {
    console.error(`Error finding folder "${folderName}": ${error.message}`);
    return null;
  }
}

/**
 * Get all mail folders
 * @param {string} accessToken - Access token
 * @returns {Promise<Array>} - Array of folder objects
 */
async function getAllFolders(accessToken) {
  try {
    // Get top-level folders
    const response = await callGraphAPI(accessToken, 'GET', 'me/mailFolders', null, {
      $top: 100,
      $select: 'id,displayName,parentFolderId,childFolderCount,totalItemCount,unreadItemCount',
    });

    if (!response.value) {
      return [];
    }

    // Get child folders for folders with children
    const foldersWithChildren = response.value.filter((f) => f.childFolderCount > 0);

    const childFolderPromises = foldersWithChildren.map(async (folder) => {
      try {
        const childResponse = await callGraphAPI(
          accessToken,
          'GET',
          `me/mailFolders/${folder.id}/childFolders`,
          null,
          {
            $select:
              'id,displayName,parentFolderId,childFolderCount,totalItemCount,unreadItemCount',
          }
        );

        return childResponse.value || [];
      } catch (error) {
        console.error(`Error getting child folders for "${folder.displayName}": ${error.message}`);
        return [];
      }
    });

    const childFolders = await Promise.all(childFolderPromises);

    // Combine top-level folders and all child folders
    return [...response.value, ...childFolders.flat()];
  } catch (error) {
    console.error(`Error getting all folders: ${error.message}`);
    return [];
  }
}

module.exports = {
  WELL_KNOWN_FOLDERS,
  resolveFolderPath,
  resolveSegmentInParent,
  getFolderIdByName,
  getAllFolders,
};
