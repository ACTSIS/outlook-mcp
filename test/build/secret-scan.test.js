/**
 * Secret scan tests (build/secret-scan.js).
 *
 * Threat contract from the design: allowlisted `dist/**` scanning and
 * fail-closed rejection of `OUTLOOK_CLIENT_SECRET` / credential patterns
 * before publication. The scanner never reads or embeds real credentials -
 * tests use obvious sentinel values only.
 * Production code does not exist yet (RED).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('build/secret-scan', () => {
  let tempDir;
  let scan;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm365-scan-'));
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

  describe('credential detection', () => {
    it('flags an embedded OUTLOOK_CLIENT_SECRET value', () => {
      expect(scan.isCredentialLine('OUTLOOK_CLIENT_SECRET=my-sentinel-value')).toBe(true);
    });

    it('flags an embedded MS_CLIENT_SECRET value', () => {
      expect(scan.isCredentialLine('MS_CLIENT_SECRET=sentinel')).toBe(true);
    });

    it('does not flag runtime environment references (no embedded value)', () => {
      expect(scan.isCredentialLine('const secret = process.env.OUTLOOK_CLIENT_SECRET;')).toBe(
        false
      );
      expect(scan.isCredentialLine('client_secret: this.config.clientSecret,')).toBe(false);
      expect(scan.isCredentialLine('clientSecret: authConfig.clientSecret,')).toBe(false);
      expect(scan.isCredentialLine('clientSecret: config.AUTH_CONFIG.clientSecret,')).toBe(false);
    });

    it('flags embedded generic client-secret assignments', () => {
      expect(scan.isCredentialLine('client_secret = "sentinel-value-123"')).toBe(true);
      expect(scan.isCredentialLine('"clientSecret": "sentinel-value-123"')).toBe(true);
    });

    it('flags private key material markers', () => {
      expect(scan.isCredentialLine('-----BEGIN PRIVATE KEY-----')).toBe(true);
      expect(scan.isCredentialLine('-----BEGIN RSA PRIVATE KEY-----')).toBe(true);
    });

    it('does not flag benign configuration lines', () => {
      expect(scan.isCredentialLine('const serverName = "m365-mcp";')).toBe(false);
      expect(scan.isCredentialLine('clientId = process.env.OUTLOOK_CLIENT_ID;')).toBe(false);
      expect(scan.isCredentialLine('OUTLOOK_CLIENT_SECRET_LENGTH = 32;')).toBe(false);
    });
  });

  describe('allowlisted dist scanning', () => {
    it('scans every artifact file under dist/ and reports findings with locations', () => {
      writeDist(
        'win-x64/outlook-mcp-win-x64.exe',
        'junk bytes\nOUTLOOK_CLIENT_SECRET=sentinel\nmore\n'
      );
      writeDist('linux-x64/outlook-mcp-linux-x64', 'clean artifact bytes\n');

      const findings = scan.scanDirectory(path.join(tempDir, 'dist'));

      expect(findings).toHaveLength(1);
      expect(findings[0].file).toContain('outlook-mcp-win-x64.exe');
      expect(findings[0].line).toBe(2);
    });

    it('reports no findings for clean artifacts', () => {
      writeDist('win-x64/outlook-mcp-win-x64.exe', 'binary artifact with no secrets\n');
      writeDist('linux-x64/outlook-mcp-linux-x64', 'also clean\n');

      expect(scan.scanDirectory(path.join(tempDir, 'dist'))).toEqual([]);
    });

    it('ignores files outside dist/ even when they contain sentinel values', () => {
      writeDist('win-x64/outlook-mcp-win-x64.exe', 'clean\n');
      const outside = path.join(tempDir, 'node_modules', 'lib.js');
      fs.mkdirSync(path.dirname(outside), { recursive: true });
      fs.writeFileSync(outside, 'OUTLOOK_CLIENT_SECRET=sentinel\n', 'utf8');

      expect(scan.scanDirectory(path.join(tempDir, 'dist'))).toEqual([]);
    });

    it('fails closed when the dist directory does not exist', () => {
      expect(() => scan.scanDirectory(path.join(tempDir, 'missing-dist'))).toThrow();
    });
  });

  describe('publication gate', () => {
    it('blocks publication when any finding exists', () => {
      writeDist('win-x64/outlook-mcp-win-x64.exe', 'OUTLOOK_CLIENT_SECRET=sentinel\n');
      const findings = scan.scanDirectory(path.join(tempDir, 'dist'));

      expect(scan.canPublish(findings)).toBe(false);
      expect(scan.report(findings)).toContain('blocked');
      expect(scan.report(findings)).toContain('outlook-mcp-win-x64.exe');
    });

    it('allows publication only for a clean artifact set', () => {
      writeDist('linux-x64/outlook-mcp-linux-x64', 'clean bytes\n');
      const findings = scan.scanDirectory(path.join(tempDir, 'dist'));

      expect(findings).toEqual([]);
      expect(scan.canPublish(findings)).toBe(true);
    });
  });
});
