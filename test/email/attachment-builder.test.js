/**
 * Tests for the draft attachment payload builder (issue #14).
 * buildFileAttachments converts local file paths into Microsoft Graph
 * fileAttachment objects ready to embed in a message payload or POST to
 * me/messages/{id}/attachments.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildFileAttachments } = require('../../email/attachment-builder');

describe('buildFileAttachments', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-att-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFile(name, bytes) {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, bytes);
    return p;
  }

  test('builds a fileAttachment from a PNG file with base64 content', async () => {
    const bytes = Buffer.from('89PNG\r\nfake-png-bytes');
    const p = writeFile('image.png', bytes);

    const result = await buildFileAttachments([p]);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: 'image.png',
      contentType: 'image/png',
      contentBytes: bytes.toString('base64'),
    });
  });

  test('maps common extensions to MIME types', async () => {
    const cases = [
      ['doc.pdf', 'application/pdf'],
      ['sheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      ['doc.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ['photo.jpg', 'image/jpeg'],
      ['notes.txt', 'text/plain'],
      ['archive.zip', 'application/zip'],
    ];
    const paths = cases.map(([name]) => writeFile(name, Buffer.from('x')));
    const result = await buildFileAttachments(paths);
    expect(result.map((a) => a.contentType)).toEqual(cases.map(([, mime]) => mime));
  });

  test('unknown extension falls back to octet-stream', async () => {
    const p = writeFile('data.weirdext', Buffer.from('x'));
    const result = await buildFileAttachments([p]);
    expect(result[0].contentType).toBe('application/octet-stream');
  });

  test('rejects a missing file with a clear error naming the path', async () => {
    const missing = path.join(tmpDir, 'does-not-exist.pdf');
    await expect(buildFileAttachments([missing])).rejects.toThrow(
      `Attachment file not found: ${missing}`
    );
  });

  test('rejects an empty attachments list', async () => {
    await expect(buildFileAttachments([])).rejects.toThrow(/at least one attachment path/i);
  });

  test('rejects non-array attachments argument', async () => {
    await expect(buildFileAttachments('invoice.pdf')).rejects.toThrow(/attachments must be/i);
  });

  test('rejects a file over the configured size guard', async () => {
    const big = Buffer.alloc(11 * 1024 * 1024, 7); // > 10 MB guard
    const p = writeFile('big.bin', big);
    const limit = require('../../config').MAX_DRAFT_ATTACHMENT_BYTES;
    await expect(buildFileAttachments([p])).rejects.toThrow(/exceeds the .* limit/i);
    expect(limit).toBeGreaterThan(0);
  });

  test('passes through an explicit name for a path outside the temp dir shape', async () => {
    const p = writeFile('report.pdf', Buffer.from('%PDF-1.4'));
    const result = await buildFileAttachments([p]);
    expect(result[0].name).toBe('report.pdf');
    expect(result[0].contentBytes).toBe(Buffer.from('%PDF-1.4').toString('base64'));
  });
});
