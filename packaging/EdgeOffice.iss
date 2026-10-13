#define MyAppName "微知 Edge Office"
#define MyAppVersion "0.2.0-preview.6"
#define MyAppPublisher "liangyanlun"
#define MyAppExeName "EdgeOffice.exe"
#ifndef MyAppDistDir
  #define MyAppDistDir "..\dist\EdgeOffice"
#endif

[Setup]
AppId={{976A724D-BF2C-4401-8F67-933E2CE1F7B0}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\{#MyAppName}
DisableDirPage=no
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\dist-installer
OutputBaseFilename=EdgeOffice-Setup-v0.2.0-preview.6
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\{#MyAppExeName}

[Files]
Source: "{#MyAppDistDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\artifacts\models\README.md"; DestDir: "{code:GetModelsDirectory}"; Flags: onlyifdoesntexist ignoreversion

[Dirs]
Name: "{localappdata}\EdgeOffice\artifacts\data"
Name: "{localappdata}\EdgeOffice\artifacts\indexes"
Name: "{code:GetModelsDirectory}"

[Registry]
Root: HKCU; Subkey: "Software\EdgeOffice"; ValueType: string; ValueName: "ModelsDirectory"; ValueData: "{code:GetModelsDirectory}"

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加选项："

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "启动 {#MyAppName}"; Flags: nowait postinstall skipifsilent

[Code]
var
  ModelsDirectoryPage: TInputDirWizardPage;

function GetModelsDirectory(Param: String): String;
begin
  Result := ModelsDirectoryPage.Values[0];
end;

procedure InitializeWizard;
var
  ExistingModelsDirectory: String;
begin
  ModelsDirectoryPage := CreateInputDirPage(wpSelectDir,
    '选择模型下载位置', '软件和模型可以保存在不同的磁盘。',
    '请选择模型保存文件夹。首次运行时下载的模型将保存在这里，也可在应用中为每个模型选择位置。', False, '');
  ModelsDirectoryPage.Add('模型保存位置：');
  ExistingModelsDirectory := ExpandConstant('{localappdata}\EdgeOffice\artifacts\models');
  RegQueryStringValue(HKCU, 'Software\EdgeOffice', 'ModelsDirectory', ExistingModelsDirectory);
  ModelsDirectoryPage.Values[0] := ExistingModelsDirectory;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Location: String;
begin
  Result := True;
  if CurPageID = ModelsDirectoryPage.ID then
  begin
    Location := Trim(ModelsDirectoryPage.Values[0]);
    if (Length(Location) < 3) or
       ((Copy(Location, 2, 2) <> ':\') and (Copy(Location, 1, 2) <> '\\')) then
    begin
      MsgBox('请选择完整的模型保存路径，例如 D:\EdgeOfficeModels。', mbError, MB_OK);
      Result := False;
    end;
  end;
end;
