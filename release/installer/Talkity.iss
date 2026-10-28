; ---------------------------------------------------------------------------
;  Talkity - Windows installer (Inno Setup 6)
;
;  Build:   release\installer\build_installer.bat
;  Output:  release\output\TalkitySetup.exe
;
;  Design notes
;  ------------
;  * Per-machine install into Program Files; the app itself needs no admin
;    rights and keeps all user data in %APPDATA%\Talkity.
;  * The uninstaller never touches %APPDATA%\Talkity, so settings, history and
;    logs survive an uninstall or reinstall.
;  * Upgrades reuse the previous install directory and the previous shortcut
;    choices (same AppId), so an upgrade replaces files in place.
;  * The app is closed before files are replaced and, for a silent upgrade of a
;    running instance, relaunched in the background afterwards.
;  * "Launch at startup" is owned by the app (HKCU\...\Run\Talkity). The
;    installer removes that entry on uninstall and restores it after an upgrade
;    so the user's saved preference is not lost.
; ---------------------------------------------------------------------------

#define AppName        "Talkity"
#define AppVersion     "1.1.0"
#define AppVersionFull "1.1.0.0"
#define AppPublisher   "Talkity"
#define AppExe         "Talkity.exe"
#define AppUrl         "https://github.com/projectomega2777/talkity"
#define AppId          "{{B1E4A7C2-9D63-4F58-8A2E-5C7D1B9F0E43}"

[Setup]
AppId={#AppId}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppUrl}
AppSupportURL={#AppUrl}/issues
AppUpdatesURL={#AppUrl}/releases
AppComments=AI voice dictation for Windows
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
DisableDirPage=auto
PrivilegesRequired=admin
PrivilegesRequiredOverridesAllowed=commandline
OutputDir=..\output
OutputBaseFilename=TalkitySetup
SetupIconFile=talkity.ico
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName} {#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x86 x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=6.1sp1
AllowNoIcons=yes
UsePreviousAppDir=yes
UsePreviousTasks=yes
UsePreviousGroup=yes
CloseApplications=no
RestartApplications=no
VersionInfoVersion={#AppVersionFull}
VersionInfoCompany={#AppPublisher}
VersionInfoDescription={#AppName} Setup
VersionInfoProductName={#AppName}
VersionInfoCopyright=Copyright (C) 2026 Talkity

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
; Only the application binary ships. Build artifacts, sources, node_modules,
; logs and settings are deliberately excluded.
Source: "..\..\{#AppExe}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{group}\{cm:UninstallProgram,{#AppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent
Filename: "{app}\{#AppExe}"; Parameters: "--background"; Flags: nowait runhidden; Check: RelaunchAfterSilentUpgrade

[Code]
const
  RunKey = 'Software\Microsoft\Windows\CurrentVersion\Run';
  RunValue = 'Talkity';

var
  WasRunning: Boolean;

{ --- Runtime prerequisite ------------------------------------------------- }

function DotNet4Installed: Boolean;
var
  release, install: Cardinal;
begin
  { .NET Framework 4.5 and later publish a Release DWORD; 4.0 publishes Install. }
  if RegQueryDWordValue(HKLM, 'SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full', 'Release', release) then
    Result := release >= 378389
  else if RegQueryDWordValue(HKLM, 'SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Client', 'Release', release) then
    Result := release >= 378389
  else if RegQueryDWordValue(HKLM, 'SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Client', 'Install', install) then
    Result := install = 1
  else
    Result := False;
end;

{ --- Running-instance handling ------------------------------------------- }

function TalkityProcessExists: Boolean;
var
  ResultCode: Integer;
  dump: String;
  lines: TStringList;
begin
  Result := False;
  dump := ExpandConstant('{tmp}\talkity-tasklist.txt');
  if Exec(ExpandConstant('{cmd}'),
          '/C tasklist /FI "IMAGENAME eq {#AppExe}" /NH > "' + dump + '"',
          '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
  begin
    if FileExists(dump) then
    begin
      lines := TStringList.Create;
      try
        lines.LoadFromFile(dump);
        Result := Pos(Lowercase('{#AppExe}'), Lowercase(lines.Text)) > 0;
      finally
        lines.Free;
      end;
      DeleteFile(dump);
    end;
  end;
end;

procedure CloseTalkity;
var
  ResultCode: Integer;
begin
  { Ask politely first; the app exits on WM_CLOSE. Fall back to terminate. }
  if Exec(ExpandConstant('{sys}\taskkill.exe'), '/IM {#AppExe}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    Sleep(1200);
  if TalkityProcessExists then
    Exec(ExpandConstant('{sys}\taskkill.exe'), '/IM {#AppExe} /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

{ --- Startup entry ------------------------------------------------------- }

function SettingsFile: String;
begin
  Result := ExpandConstant('{userappdata}\{#AppName}\settings.json');
end;

function SettingsRequestStartup: Boolean;
var
  raw, tail: String;
  key, comma: Integer;
  lines: TStringList;
begin
  Result := False;
  if not FileExists(SettingsFile) then
    Exit;

  lines := TStringList.Create;
  try
    lines.LoadFromFile(SettingsFile);
    raw := lines.Text;
  finally
    lines.Free;
  end;

  key := Pos('"launchAtStartup"', raw);
  if key = 0 then
    Exit;

  tail := Copy(raw, key + Length('"launchAtStartup"'), Length(raw));
  comma := Pos(',', tail);
  if comma > 0 then
    tail := Copy(tail, 1, comma);
  Result := Pos('true', Lowercase(tail)) > 0;
end;

procedure RestoreStartupEntry;
begin
  { The previous version's uninstaller removes the Run entry during an upgrade;
     put it back when the user's saved settings still ask for it. }
  if SettingsRequestStartup then
    RegWriteStringValue(HKCU, RunKey, RunValue,
      '"' + ExpandConstant('{app}\{#AppExe}') + '" --background');
end;

procedure RemoveStartupEntry;
var
  current: String;
begin
  if not RegQueryStringValue(HKCU, RunKey, RunValue, current) then
    Exit;
  { Only remove an entry that actually points at the copy being uninstalled. }
  if Pos(Lowercase(ExpandConstant('{app}\{#AppExe}')), Lowercase(current)) > 0 then
    RegDeleteValue(HKCU, RunKey, RunValue);
end;

{ --- Setup events -------------------------------------------------------- }

function InitializeSetup: Boolean;
begin
  Result := DotNet4Installed;
  if not Result then
  begin
    MsgBox('Talkity requires Microsoft .NET Framework 4.0 or later.' + #13#10 + #13#10 +
           'Windows 10 and Windows 11 include it by default. On older versions of ' +
           'Windows, install it from https://dotnet.microsoft.com/download/dotnet-framework ' +
           'and run this installer again.', mbError, MB_OK);
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  WasRunning := TalkityProcessExists;
  if WasRunning then
    CloseTalkity;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    RestoreStartupEntry;
end;

function RelaunchAfterSilentUpgrade: Boolean;
begin
  Result := WizardSilent and WasRunning;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
  begin
    if TalkityProcessExists then
      CloseTalkity;
    RemoveStartupEntry;
  end;
end;
