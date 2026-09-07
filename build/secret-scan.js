/**
 * Secret scan for packaged artifacts.
 *
 * Scans allowlisted `dist/**` outputs for `OUTLOOK_CLIENT_SECRET` and other
 * credential patterns before publication, failing closed on any finding.
 * This module never reads or embeds real credentials - it only scans bytes
 * that are already on disk for suspicious patterns.
 */

const fs = require('fs');
const path = require('path');

// Embedded-value credential patterns. Environment *references* such as
// `process.env.OUTLOOK_CLIENT_SECRET` and property reads like
// `client_secret: this.config.clientSecret` are legitimate runtime contract
// code and must NOT be flagged; only an actual embedded value (assignment
// with a literal) blocks publication. The negative lookahead keeps
// OUTLOOK_CLIENT_SECRET_LENGTH (a benign constant) from false-positive.
const SECRET_ASSIGNMENT_PATTERN =
  /(?:OUTLOOK|MS)_CLIENT_SECRET(?![\w])\s*[:=]\s*(?:"[^"]+"|'[^']+'|[^\s,;]+)/;
const GENERIC_SECRET_PATTERN = /client[-_ ]?secret["']?\s*[:=]\s*["'][^"']+["']/i;
const PRIVATE_KEY_PATTERN = /BEGIN (?:RSA )?PRIVATE KEY/;

/**
 * True when a single line embeds a credential value (not merely references a
 * runtime environment variable or configuration property).
 * @param {string} line - One line of artifact content
 * @returns {boolean}
 */
function isCredentialLine(line) {
  return (
    SECRET_ASSIGNMENT_PATTERN.test(line) ||
    GENERIC_SECRET_PATTERN.test(line) ||
    PRIVATE_KEY_PATTERN.test(line)
  );
}

/**
 * Scan every file under a directory for credential lines.
 * @param {string} dir - Allowlisted directory (for example dist/)
 * @returns {Array<{ file: string, line: number }>} Findings with locations
 */
function scanDirectory(dir) {
  if (!fs.existsSync(dir)) {
    throw new Error(`Secret scan directory does not exist: ${dir}`);
  }

  const findings = [];
  const stack = [dir];

  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      const content = fs.readFileSync(fullPath, 'utf8');
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (isCredentialLine(lines[i])) {
          findings.push({ file: fullPath, line: i + 1 });
        }
      }
    }
  }

  return findings;
}

/**
 * Publication gate: only a clean artifact set may proceed.
 * @param {Array<{ file: string, line: number }>} findings - Scan findings
 * @returns {boolean}
 */
function canPublish(findings) {
  return findings.length === 0;
}

/**
 * Human-readable scan report.
 * @param {Array<{ file: string, line: number }>} findings - Scan findings
 * @returns {string}
 */
function report(findings) {
  if (findings.length === 0) {
    return 'Secret scan passed: no credential patterns found in dist/ artifacts.';
  }
  const lines = findings.map(
    (finding) => `- ${finding.file}:${finding.line} matched a credential pattern`
  );
  return `Secret scan blocked publication: ${findings.length} credential pattern(s) found.\n${lines.join(
    '\n'
  )}`;
}

module.exports = { isCredentialLine, scanDirectory, canPublish, report };
