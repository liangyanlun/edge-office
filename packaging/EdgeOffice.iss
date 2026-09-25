#define MyAppName "微知 Edge Office"
#define MyAppVersion "0.1.2"
#define MyAppPublisher "liangyanlun"
#define MyAppExeName "EdgeOffice.exe"

[Setup]
AppId={{976A724D-BF2C-4401-8F67-933E2CE1F7B0}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\dist-installer
OutputBaseFilename=EdgeOffice-Setup-v0.1.2
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\{#MyAppExeName}

[Files]
Source: "..\dist\EdgeOffice\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\artifacts\models\README.md"; DestDir: "{localappdata}\EdgeOffice\artifacts\models"; Flags: onlyifdoesntexist ignoreversion

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加选项："

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "启动 {#MyAppName}"; Flags: nowait postinstall skipifsilent

[Code]
procedure InitializeWizard;
begin
  ForceDirectories(ExpandConstant('{localappdata}\EdgeOffice\artifacts\data'));
  ForceDirectories(ExpandConstant('{localappdata}\EdgeOffice\artifacts\indexes'));
  ForceDirectories(ExpandConstant('{localappdata}\EdgeOffice\artifacts\models'));
end;
