[CmdletBinding()]
param(
    [switch]$SkipInstaller
)

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Python = Join-Path $ProjectRoot ".venv\Scripts\python.exe"
$DataSeparator = [IO.Path]::PathSeparator
$PublicData = "--add-data=" + (Join-Path $ProjectRoot "public") + $DataSeparator + "public"
$ModelReadmeData = "--add-data=" + (Join-Path $ProjectRoot "artifacts\models\README.md") + $DataSeparator + "artifacts\models"
$LlamaLibraryDir = Join-Path $ProjectRoot ".venv\Lib\site-packages\llama_cpp\lib"
$PyInstallerArgs = @(
    "-m", "PyInstaller",
    "--noconfirm", "--clean", "--windowed",
    "--name", "EdgeOffice",
    "--distpath", (Join-Path $ProjectRoot "dist"),
    "--workpath", (Join-Path $ProjectRoot "build"),
    "--specpath", (Join-Path $ProjectRoot "build"),
    $PublicData,
    $ModelReadmeData,
    "--collect-all", "sentence_transformers",
    "--collect-all", "transformers",
    "--collect-all", "tokenizers",
    "--collect-all", "faiss",
    "--collect-all", "onnxruntime",
    "--collect-all", "rapidocr",
    "--collect-all", "pypdfium2",
    "--collect-all", "llama_cpp",
    "--collect-all", "webview",
    "--collect-all", "pythonnet",
    "--collect-all", "clr_loader",
    (Join-Path $ProjectRoot "desktop_launcher.py")
)

if (-not (Test-Path -LiteralPath $Python)) {
    throw "未找到项目虚拟环境：$Python"
}
if (-not (Test-Path -LiteralPath $LlamaLibraryDir)) {
    throw "未找到 llama.cpp 原生库目录：$LlamaLibraryDir"
}

$LlamaDllArgs = Get-ChildItem -LiteralPath $LlamaLibraryDir -Filter *.dll -File | ForEach-Object {
    "--add-binary=$($_.FullName)$DataSeparator" + "llama_cpp\lib"
}
if (-not $LlamaDllArgs) {
    throw "llama.cpp 原生 DLL 不完整，无法生成可运行安装包。"
}

& $Python -m PyInstaller --version
if ($LASTEXITCODE -ne 0) {
    & $Python -m pip install pyinstaller
    if ($LASTEXITCODE -ne 0) { throw "无法安装 PyInstaller。" }
}
& $Python @PyInstallerArgs @LlamaDllArgs
if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller 构建失败。"
}

if ($SkipInstaller) {
    Write-Host "已生成便携版：$ProjectRoot\dist\EdgeOffice\EdgeOffice.exe"
    exit 0
}

$IsccCandidates = @(@(
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) })

if (-not $IsccCandidates) {
    throw "未找到 Inno Setup 6。请安装后再次运行 packaging\build.ps1。"
}

& ($IsccCandidates[0]) (Join-Path $PSScriptRoot "EdgeOffice.iss")
if ($LASTEXITCODE -ne 0) {
    throw "Inno Setup 安装包构建失败。"
}

Write-Host "已生成安装包：$ProjectRoot\dist-installer\EdgeOffice-Setup-v0.1.0.exe"
