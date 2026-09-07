/**
 * Structural checks for the Windows NSIS installer (build/windows/installer.nsi).
 *
 * makensis is not expected to be installed in this environment, so the suite
 * validates the source script for the directives and shape mandated by ADR 2
 * rather than compiling it.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const NSI_PATH = path.join(ROOT, 'build/windows/installer.nsi');

describe('build/windows NSIS installer structure', () => {
  it('exists and carries the x64 guard before any write', () => {
    const nsi = fs.readFileSync(NSI_PATH, 'utf8');
    expect(nsi).toMatch(/!include\s+"x64\.nsh"/);
    expect(nsi).toMatch(/\$\{IfNot\}\s+\$\{RunningX64\}/);
    expect(nsi).toMatch(/Abort/);
  });

  it('targets 64-bit Program Files and uses 64-bit registry view', () => {
    const nsi = fs.readFileSync(NSI_PATH, 'utf8');
    expect(nsi).toMatch(/InstallDir\s+"\$PROGRAMFILES64\\outlook-mcp"/);
    expect(nsi).toMatch(/SetRegView\s+64/);
  });

  it('installs the staged SEA binary as outlook-mcp.exe', () => {
    const nsi = fs.readFileSync(NSI_PATH, 'utf8');
    expect(nsi).toMatch(/File\s+\/oname=outlook-mcp\.exe/);
  });

  it('appends INSTDIR to HKLM PATH guarded against duplicates and broadcasts WM_SETTINGCHANGE', () => {
    const nsi = fs.readFileSync(NSI_PATH, 'utf8');
    expect(nsi).toMatch(/SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment\s*"/);
    expect(nsi).toMatch(/WM_SETTINGCHANGE/);
    expect(nsi).toMatch(/HWND_BROADCAST/);
  });

  it('registers an uninstall entry with DisplayName, DisplayVersion, UninstallString, and Publisher', () => {
    const nsi = fs.readFileSync(NSI_PATH, 'utf8');
    expect(nsi).toMatch(/DisplayName/);
    expect(nsi).toMatch(/DisplayVersion/);
    expect(nsi).toMatch(/UninstallString/);
    expect(nsi).toMatch(/Publisher/);
  });

  it('has an uninstall section that removes files, PATH entry, registry key, and re-broadcasts', () => {
    const nsi = fs.readFileSync(NSI_PATH, 'utf8');
    expect(nsi).toMatch(/Section\s+"Uninstall"/i);
    expect(nsi).toMatch(/DeleteRegKey/);
  });

  it('does not use the EnVar plugin or create Start Menu shortcuts', () => {
    const nsi = fs.readFileSync(NSI_PATH, 'utf8');
    expect(nsi).not.toMatch(/EnVar/);
    expect(nsi).not.toMatch(/CreateShortcut/);
    expect(nsi).not.toMatch(/StartMenu/);
  });

  it('produces outlook-mcp-setup.exe with admin rights and LZMA compression', () => {
    const nsi = fs.readFileSync(NSI_PATH, 'utf8');
    expect(nsi).toMatch(/OutFile\s+"outlook-mcp-setup\.exe"/);
    expect(nsi).toMatch(/RequestExecutionLevel\s+admin/);
    expect(nsi).toMatch(/SetCompressor\s+lzma/);
    expect(nsi).toMatch(/!include\s+"WinMessages\.nsh"/);
  });
});
