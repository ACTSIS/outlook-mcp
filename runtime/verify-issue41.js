/**
 * Live end-to-end verification for issue #41 (onedrive-content-raw).
 * Uploads a text file with JSON-escapable characters and a small binary
 * payload, then verifies the stored sizes byte-for-byte against the sources
 * using the fixed upload (raw bodies) and the new redirect-based download.
 */
const crypto = require('crypto');
const https = require('https');
const handleUpload = require('../onedrive/upload');
const handleDownload = require('../onedrive/download');

async function fetchStored(bytes) {
  return new Promise((resolve, reject) => {
    const req = https.request(bytes.downloadUrl, { method: 'GET' }, (res) => {
      if (res.statusCode >= 300) {
        reject(new Error(`Storage fetch failed with status ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  const results = [];
  try {
    // --- Text file with JSON-escapable characters ---
    const lines = [];
    for (let i = 0; i < 20; i++) {
      lines.push(`const s${i} = "quote ${i} and \\ backslash ${i}";`);
    }
    const textContent = `<html>\n${lines.join('\n')}\n</html>\n`;
    const textBytes = Buffer.from(textContent, 'utf8');

    const upText = await handleUpload({
      path: '/Prueba/issue41-text-check.html',
      content: textContent,
      conflictBehavior: 'fail',
    });
    console.error('TEXT upload:', upText.content[0].text.replace(/\n/g, ' | '));

    const dlText = await handleDownload({ path: '/Prueba/issue41-text-check.html' });
    console.error('TEXT download:', dlText.content[0].text.replace(/\n/g, ' | '));
    const textMatch = dlText.content[0].text.match(/https:\/\/\S+/);
    if (!textMatch) {
      results.push('TEXT FAILED: no download URL returned');
    } else {
      const stored = await fetchStored({ downloadUrl: textMatch[0] });
      const same = stored.equals(textBytes);
      results.push(
        `TEXT: source ${textBytes.length} B, stored ${stored.length} B, byte-identical=${same}`
      );
    }

    // --- Binary payload via base64 flag ---
    const binary = crypto.randomBytes(1024); // random binary (invalid UTF-8)
    const upBin = await handleUpload({
      path: '/Prueba/issue41-bin-check.bin',
      content: binary.toString('base64'),
      base64: true,
      conflictBehavior: 'fail',
    });
    console.error('BIN upload:', upBin.content[0].text.replace(/\n/g, ' | '));

    const dlBin = await handleDownload({ path: '/Prueba/issue41-bin-check.bin' });
    const binMatch = dlBin.content[0].text.match(/https:\/\/\S+/);
    if (!binMatch) {
      results.push('BIN FAILED: no download URL returned: ' + dlBin.content[0].text.slice(0, 120));
    } else {
      const storedBin = await fetchStored({ downloadUrl: binMatch[0] });
      const sameBin = storedBin.equals(binary);
      results.push(
        `BIN: source ${binary.length} B, stored ${storedBin.length} B, byte-identical=${sameBin}`
      );
    }
  } catch (error) {
    results.push('ERROR: ' + error.message);
  } finally {
    for (const line of results) console.log(line);
    const failed = results.some(
      (r) => r.includes('FAILED') || r.startsWith('ERROR') || /=[Ff]alse/.test(r)
    );
    // Exit outright: keep-alive sockets from the SharePoint fetch would keep
    // this process alive after the verification verdict is printed.
    process.exit(failed ? 1 : 0);
  }
})();
