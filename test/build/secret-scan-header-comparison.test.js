/**
 * Header-comparison exception for the private-key detector (build/secret-scan.js).
 *
 * Observed real-world cause: bundled dependency code performs a bare-header
 * format comparison such as `pkcs8.indexOf('-----BEGIN PRIVATE KEY-----')`.
 * That exact quoted bare marker is not key material and must be suppressed,
 * while every other occurrence (plain bare header, truncated PEM, full PEM,
 * literal assignment, concatenated argument, or a real key/secret elsewhere
 * on the same line) stays fail-closed.
 * Tests use synthetic sentinel values only; no real credentials.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const SAFE_PKCS8_COMPARISON = "pkcs8.indexOf('-----BEGIN PRIVATE KEY-----') !== 0";
const SAFE_RSA_COMPARISON = "key.indexOf('-----BEGIN RSA PRIVATE KEY-----') === 0";
const DOUBLE_QUOTED_COMPARISON = 'pkcs8.indexOf("-----BEGIN PRIVATE KEY-----") !== 0';

describe('build/secret-scan bare-header format comparison', () => {
  let tempDir;
  let scan;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm365-scan-cmp-'));
    scan = require('../../build/secret-scan');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    jest.resetModules();
  });

  function writeDist(fileName, content) {
    const fullPath = path.join(tempDir, 'dist', fileName);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
    return fullPath;
  }

  describe('single-line detection', () => {
    it('suppresses only the exact quoted bare marker used as an indexOf comparison argument', () => {
      expect(scan.isCredentialLine(SAFE_PKCS8_COMPARISON)).toBe(false);
      expect(scan.isCredentialLine(SAFE_RSA_COMPARISON)).toBe(false);
      expect(scan.isCredentialLine(DOUBLE_QUOTED_COMPARISON)).toBe(false);
    });

    it('still flags plain bare headers', () => {
      expect(scan.isCredentialLine('-----BEGIN PRIVATE KEY-----')).toBe(true);
      expect(scan.isCredentialLine('-----BEGIN RSA PRIVATE KEY-----')).toBe(true);
    });

    it('still flags a truncated PEM header', () => {
      expect(scan.isCredentialLine('-----BEGIN PRIVATE KEY-----\nAAAA')).toBe(true);
    });

    it('still flags a full PEM body and the RSA variant', () => {
      expect(
        scan.isCredentialLine(
          '-----BEGIN PRIVATE KEY-----\nsentinelBASE64BODY\n-----END PRIVATE KEY-----'
        )
      ).toBe(true);
      expect(
        scan.isCredentialLine(
          '-----BEGIN RSA PRIVATE KEY-----\nsentinelBASE64BODY\n-----END PRIVATE KEY-----'
        )
      ).toBe(true);
    });

    it('still flags an ordinary literal assignment of the bare header', () => {
      expect(scan.isCredentialLine("const marker = '-----BEGIN PRIVATE KEY-----';")).toBe(true);
    });

    it('still flags a concatenated argument, not the exact quoted marker', () => {
      expect(scan.isCredentialLine("pkcs8.indexOf('-----BEGIN ' + 'PRIVATE KEY')")).toBe(true);
    });

    it('still flags mismatched quotes around the argument', () => {
      expect(scan.isCredentialLine('pkcs8.indexOf("-----BEGIN PRIVATE KEY-----\') !== 0')).toBe(
        true
      );
    });

    it('still flags a real private key marker elsewhere on the same line as a safe comparison', () => {
      const line = `${SAFE_PKCS8_COMPARISON}; log('-----BEGIN PRIVATE KEY-----')`;
      expect(scan.isCredentialLine(line)).toBe(true);
    });

    it('still flags secret assignments on the same line as a safe comparison', () => {
      expect(
        scan.isCredentialLine(
          `${SAFE_PKCS8_COMPARISON}; OUTLOOK_CLIENT_SECRET: 'sentinel-secret-NOT-REAL',`
        )
      ).toBe(true);
      expect(
        scan.isCredentialLine(`${SAFE_PKCS8_COMPARISON}; clientSecret: 'sentinel-secret-NOT-REAL',`)
      ).toBe(true);
    });
  });

  describe('public scanDirectory end-to-end', () => {
    it('accepts a fixture with only the safe comparison and keeps canPublish/report unchanged', () => {
      writeDist('bundle.js', `${SAFE_PKCS8_COMPARISON}\nconst banner = 'm365-mcp';\n`);

      const findings = scan.scanDirectory(path.join(tempDir, 'dist'));
      expect(findings).toEqual([]);
      expect(scan.canPublish(findings)).toBe(true);
      expect(scan.report(findings)).toBe(
        'Secret scan passed: no credential patterns found in dist/ artifacts.'
      );
    });

    it('rejects a bundle with a safe comparison plus a real key and a literal client secret', () => {
      writeDist(
        'bundle.js',
        [
          `${SAFE_PKCS8_COMPARISON}`,
          '-----BEGIN PRIVATE KEY-----',
          'sentinelBASE64KEYBODY',
          '-----END PRIVATE KEY-----',
          "OUTLOOK_CLIENT_SECRET: 'sentinel-client-secret-NOT-REAL'",
        ].join('\n')
      );

      const findings = scan.scanDirectory(path.join(tempDir, 'dist'));
      expect(findings).toHaveLength(2);
      expect(findings[0]).toEqual({ file: expect.stringContaining('bundle.js'), line: 2 });
      expect(findings[1].line).toBe(5);
      expect(scan.canPublish(findings)).toBe(false);
      expect(scan.report(findings)).toContain('blocked');
      expect(scan.report(findings)).toContain('bundle.js:2');
    });
  });
});
