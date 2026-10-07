/**
 * Draft attachment payload builder (issue #14).
 * Converts local file paths into Microsoft Graph fileAttachment objects ready
 * to embed in a message payload (`attachments` on POST /me/messages) or to
 * POST to `me/messages/{id}/attachments` for reply drafts.
 */
const fs = require('fs').promises;
const config = require('../config');

/**
 * MIME types for common attachment extensions; anything unknown falls back to
 * application/octet-stream so Graph still accepts the file.
 */
const MIME_BY_EXTENSION = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  zip: 'application/zip',
};

/**
 * Build Graph fileAttachment objects from local file paths.
 * @param {string[]} paths - One or more local file paths (relative or absolute)
 * @returns {Promise<Array<object>>} - Graph fileAttachment objects
 */
async function buildFileAttachments(paths) {
  if (!Array.isArray(paths)) {
    throw new Error('attachments must be an array of file paths');
  }
  if (paths.length === 0) {
    throw new Error('attachments must include at least one attachment path');
  }

  const maxSize = config.MAX_DRAFT_ATTACHMENT_BYTES || 10 * 1024 * 1024;
  const attachments = [];

  for (const filePath of paths) {
    if (typeof filePath !== 'string' || filePath.trim() === '') {
      throw new Error('Each attachment must be a non-empty file path string.');
    }

    let bytes;
    try {
      bytes = await fs.readFile(filePath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`Attachment file not found: ${filePath}`);
      }
      throw new Error(`Attachment file could not be read (${filePath}): ${error.message}`);
    }

    if (bytes.length > maxSize) {
      throw new Error(
        `Attachment ${filePath} (${bytes.length} bytes) exceeds the ${maxSize}-byte limit.`
      );
    }

    const extension = filePath.includes('.') ? filePath.split('.').pop().toLowerCase() : '';
    attachments.push({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: filePath.split('/').pop().split('\\').pop(),
      contentType: MIME_BY_EXTENSION[extension] || 'application/octet-stream',
      contentBytes: bytes.toString('base64'),
    });
  }

  return attachments;
}

module.exports = { buildFileAttachments, MIME_BY_EXTENSION };
