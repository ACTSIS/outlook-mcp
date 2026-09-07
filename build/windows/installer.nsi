; NSIS installer for outlook-mcp (64-bit Windows only).
; Build: makensis -DVERSION=X.Y.Z installer.nsi
;
; Uses only core NSIS instructions (no StrFunc/TextFunc headers) so the
; script compiles deterministically on any stock NSIS 3.

!include "x64.nsh"
!include "WinMessages.nsh"
!include "LogicLib.nsh"

Name "outlook-mcp"
OutFile "outlook-mcp-setup.exe"
InstallDir "$PROGRAMFILES64\outlook-mcp"
RequestExecutionLevel admin
SetCompressor lzma

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
  ReadRegStr $6 HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path"
  StrCpy $5 "$INSTDIR"
  Call PathContains
  ${If} $7 == "0"
    StrCpy $8 "$6;$INSTDIR"
    WriteRegExpandStr HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" \
      "Path" $8
    SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
  ${EndIf}
SectionEnd

    Section "Uninstall"
      SetRegView 64

      ; Remove the installation directory from the machine PATH. The
      ; installer always appends ";$INSTDIR" at the end, so removing that
      ; suffix (or the exact-match case) covers every entry we ever wrote.
      ReadRegStr $6 HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path"
      StrCpy $5 "$INSTDIR"
      Call PathRemoveDir
      WriteRegExpandStr HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" \
        "Path" $6
      SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000

      ; Delete installed files.
  Delete "$INSTDIR\outlook-mcp.exe"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"

  ; Remove the uninstall registry entry.
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\outlook-mcp"
SectionEnd

; $5 = needle, $6 = haystack -> $7 = "1" when the haystack contains the
; needle (case-insensitive), "0" otherwise. Clobbers $0-$2.
Function PathContains
  Push $0
  Push $1
  Push $2
  StrLen $0 $5
  StrCpy $2 0
  StrCpy $7 "0"
path_contains_loop:
  StrCpy $1 $6 $0 $2
  StrCmp $1 "" path_contains_done
  StrCmp $1 $5 path_contains_found
  IntOp $2 $2 + 1
  Goto path_contains_loop
path_contains_found:
  StrCpy $7 "1"
path_contains_done:
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; $5 = directory, $6 = PATH. Removes an exact-match PATH or a trailing
; ";$5" suffix; leaves $6 otherwise unchanged. The installer always
; appends at the end, so these two cases cover every entry it wrote.
; Clobbers $R0-$R4.
Function PathRemoveDir
  Push $R0
  Push $R1
  Push $R2
  Push $R4
  StrCmpS $6 $5 0 +2
  StrCpy $6 ""
  StrCpy $R0 ";$5"
  StrLen $R1 $R0
  StrLen $R2 $6
  IntOp $R3 $R2 - $R1
  IntCmp $R3 0 path_remove_end path_remove_end +1
  StrCpy $R4 $6 $R1 $R3
  StrCmpS $R4 $R0 path_remove_end +1
  StrCpy $6 $6 $R3
path_remove_end:
  Pop $R4
  Pop $R2
  Pop $R1
  Pop $R0
FunctionEnd
