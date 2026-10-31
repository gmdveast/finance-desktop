#ifndef AppVersion
  #define AppVersion "1.3.2"
#endif
#ifndef AppArch
  #define AppArch "x64"
#endif
#ifndef StageDir
  #error StageDir must point to the prepared application directory
#endif
#ifndef OutputDir
  #error OutputDir must point to the installer output directory
#endif

[Setup]
AppId={{4C5EEA1B-8A44-4C7B-980A-8B2D9D5E0001}
AppName=Finance
AppVersion={#AppVersion}
AppPublisher=Finance
DefaultDirName={localappdata}\Programs\Finance
DefaultGroupName=Finance
UninstallDisplayName=Finance
SetupIconFile={#StageDir}\finance.ico
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
DisableProgramGroupPage=yes
DisableDirPage=yes
OutputDir={#OutputDir}
OutputBaseFilename=Finance-Setup-{#AppVersion}-{#AppArch}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
RestartApplications=no
Uninstallable=yes

[Tasks]
Name: "desktopicon"; Description: "Создать ярлык на рабочем столе"; GroupDescription: "Дополнительные ярлыки:"
Name: "autostart"; Description: "Запускать Finance при входе в Windows"; GroupDescription: "Дополнительные ярлыки:"; Flags: unchecked

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}\versions\{#AppVersion}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#StageDir}\scripts\finance-start.vbs"; DestDir: "{app}\scripts"; Flags: ignoreversion
Source: "{#StageDir}\scripts\finance-stop.vbs"; DestDir: "{app}\scripts"; Flags: ignoreversion
Source: "{#StageDir}\scripts\finance-rollback.vbs"; DestDir: "{app}\scripts"; Flags: ignoreversion
Source: "{#StageDir}\finance.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Finance"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\scripts\finance-start.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\versions\{#AppVersion}\finance.ico"; IconIndex: 0
Name: "{autodesktop}\Finance"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\scripts\finance-start.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\finance.ico"; IconIndex: 0; Tasks: desktopicon; Check: DesktopShortcutMissing
Name: "{userstartup}\Finance"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\scripts\finance-start.vbs"""; WorkingDir: "{app}"; Tasks: autostart

[Run]
Filename: "{sys}\wscript.exe"; Parameters: """{app}\scripts\finance-start.vbs"""; WorkingDir: "{app}"; Flags: postinstall skipifsilent

[Code]
var
  DesktopIconTaskDefaultApplied: Boolean;

function DesktopShortcutMissing: Boolean;
begin
  Result := not FileExists(ExpandConstant('{autodesktop}\Finance.lnk'));
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if (CurPageID = wpSelectTasks) and not DesktopIconTaskDefaultApplied then
  begin
    DesktopIconTaskDefaultApplied := True;
    { desktopicon is the first task and is checked on every setup run. }
    WizardForm.TasksList.Checked[0] := True;
  end;
end;

function IsSafeVersion(const Value: String): Boolean;
var
  Index: Integer;
  Character: Char;
begin
  Result := (Length(Value) > 0) and (Length(Value) <= 80);
  if not Result then exit;
  for Index := 1 to Length(Value) do
  begin
    Character := Value[Index];
    if not (((Character >= 'a') and (Character <= 'z')) or
      ((Character >= 'A') and (Character <= 'Z')) or
      ((Character >= '0') and (Character <= '9')) or
      (Character = '.') or (Character = '-')) then
    begin
      Result := False;
      exit;
    end;
  end;
  Character := Value[1];
  Result := ((Character >= 'a') and (Character <= 'z')) or
    ((Character >= 'A') and (Character <= 'Z')) or
    ((Character >= '0') and (Character <= '9'));
end;

function FinanceBaseDirectory: String;
begin
  { InitializeSetup runs before the application-directory constant is ready.
    The destination is fixed by DefaultDirName and DisableDirPage. }
  Result := ExpandConstant('{localappdata}\Programs\Finance');
end;

function InstalledVersionDirectory(const Version: String): String;
var
  BaseDirectory: String;
begin
  BaseDirectory := FinanceBaseDirectory;
  if (Version = '') or (Version = 'legacy') then
    Result := BaseDirectory
  else if IsSafeVersion(Version) then
    Result := BaseDirectory + '\versions\' + Version
  else
    Result := '';
end;

function IsFinanceInstalled(const Directory: String): Boolean;
begin
  Result := (Directory <> '') and
    FileExists(Directory + '\server.js') and
    FileExists(Directory + '\runtime\node.exe') and
    FileExists(Directory + '\scripts\desktop-launcher.mjs');
end;

function StopActiveFinance(): Boolean;
var
  ActiveVersion, ActiveDirectory, PreviousVersion: String;
  ResultCode: Integer;
  Params: String;
begin
  ActiveVersion := '';
  PreviousVersion := '';
  RegQueryStringValue(HKCU, 'Software\FinanceDesktop', 'CurrentVersion', ActiveVersion);
  RegQueryStringValue(HKCU, 'Software\FinanceDesktop', 'PreviousVersion', PreviousVersion);
  ActiveDirectory := InstalledVersionDirectory(ActiveVersion);
  if not IsFinanceInstalled(ActiveDirectory) then
    ActiveDirectory := InstalledVersionDirectory(PreviousVersion);
  if not IsFinanceInstalled(ActiveDirectory) then
  begin
    Result := True;
    exit;
  end;
  Params := '"' + ActiveDirectory + '\scripts\desktop-launcher.mjs" stop';
  if not Exec(ActiveDirectory + '\runtime\node.exe', Params, ActiveDirectory, SW_HIDE, ewWaitUntilTerminated, ResultCode) then
  begin
    MsgBox('Не удалось запустить штатную остановку Finance. Закройте приложение и повторите установку.', mbError, MB_OK);
    Result := False;
    exit;
  end;
  if ResultCode <> 0 then
  begin
    MsgBox('Finance не подтвердил штатную остановку. Установка отменена; повторите её после завершения текущих операций.', mbError, MB_OK);
    Result := False;
    exit;
  end;
  Result := True;
end;

function InitializeSetup(): Boolean;
var
  CurrentVersion: String;
begin
  CurrentVersion := '';
  RegQueryStringValue(HKCU, 'Software\FinanceDesktop', 'CurrentVersion', CurrentVersion);
  if (CurrentVersion = '{#AppVersion}') and IsFinanceInstalled(InstalledVersionDirectory(CurrentVersion)) then
  begin
    MsgBox('Эта версия Finance уже установлена. Данные и приложение не изменены.', mbInformation, MB_OK);
    Result := False;
    exit;
  end;
  Result := StopActiveFinance();
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  PreviousVersion: String;
begin
  if CurStep = ssPostInstall then
  begin
    { Remove Start Menu links created by older releases; Finance remains the only app link. }
    DeleteFile(ExpandConstant('{group}\Выйти из Finance.lnk'));
    DeleteFile(ExpandConstant('{group}\Откатить версию Finance.lnk'));
    PreviousVersion := '';
    if not RegQueryStringValue(HKCU, 'Software\FinanceDesktop', 'CurrentVersion', PreviousVersion) then
    begin
      if IsFinanceInstalled(ExpandConstant('{app}')) then PreviousVersion := 'legacy';
    end;
    if not RegWriteStringValue(HKCU, 'Software\FinanceDesktop', 'PreviousVersion', PreviousVersion) then
      RaiseException('Не удалось сохранить предыдущую версию Finance. Новая версия не активирована.');
    if not RegWriteStringValue(HKCU, 'Software\FinanceDesktop', 'CurrentVersion', '{#AppVersion}') then
      RaiseException('Не удалось активировать новую версию Finance. Предыдущая версия остаётся доступна.');
  end;
end;

function InitializeUninstall(): Boolean;
begin
  Result := StopActiveFinance();
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
  begin
    RegDeleteValue(HKCU, 'Software\FinanceDesktop', 'CurrentVersion');
    RegDeleteValue(HKCU, 'Software\FinanceDesktop', 'PreviousVersion');
    RegDeleteKeyIfEmpty(HKCU, 'Software\FinanceDesktop');
  end;
end;
