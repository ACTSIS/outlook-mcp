; NSIS installer for outlook-mcp (64-bit Windows only).
; Build: makensis -DVERSION=X.Y.Z installer.nsi

!include "x64.nsh"
!include "WinMessages.nsh"
!include "StrFunc.nsh"
!include "LogicLib.nsh"

Name "outlook-mcp"
OutFile "outlook-mcp-setup.exe"
InstallDir "$PROGRAMFILES64\outlook-mcp"
RequestExecutionLevel admin
SetCompressor lzma
SetRegView 64

; Version is supplied on the makensis command line via -DVERSION=...
!ifndef VERSION
  !define VERSION "0.0.0"
!endif

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_OK "outlook-mcp requires 64-bit Windows."
    Abort
  ${EndIf}
FunctionEnd

Section "Install"
  SetRegView 64
  SetOutPath $INSTDIR

  ; Install the staged SEA binary under the mandatory probe name.
  File /oname=outlook-mcp.exe "outlook-mcp-win-x64.exe"

  ; Write the uninstaller and registry entry first so the uninstaller exists.
  WriteUninstaller "$INSTDIR\uninstall.exe"

  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\outlook-mcp" \
    "DisplayName" "outlook-mcp"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\outlook-mcp" \
    "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\outlook-mcp" \
    "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\outlook-mcp" \
    "Publisher" "ACTSIS"

  ; Append $INSTDIR to the machine PATH, guarded against duplicates.
  ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path"
  ${StrContains} $1 "$INSTDIR" $0
  ${If} $1 == ""
    StrCpy $2 "$0;$INSTDIR"
    WriteRegExpandStr HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" \
      "Path" $2
    SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
  ${EndIf}
SectionEnd

Section "Uninstall"
  SetRegView 64

  ; Remove the installation directory from the machine PATH.
  ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path"
  ${StrRep} $1 "$0" ";$INSTDIR" ""
  WriteRegExpandStr HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" \
    "Path" $1
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000

  ; Delete installed files.
  Delete "$INSTDIR\outlook-mcp.exe"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"

  ; Remove the uninstall registry entry.
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\outlook-mcp"
SectionEnd
