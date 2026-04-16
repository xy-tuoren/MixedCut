$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$adbOutDir = Join-Path $projectRoot "resources\adb\win"

$adbExe = Join-Path $adbOutDir "adb.exe"
$adbWinApi = Join-Path $adbOutDir "AdbWinApi.dll"
$adbWinUsbApi = Join-Path $adbOutDir "AdbWinUsbApi.dll"

if ((Test-Path $adbExe) -and (Test-Path $adbWinApi) -and (Test-Path $adbWinUsbApi)) {
  Write-Host "ADB already prepared, skipping: $adbOutDir"
  exit 0
}

New-Item -ItemType Directory -Force -Path $adbOutDir | Out-Null

$url = "https://dl.google.com/android/repository/platform-tools-latest-windows.zip"
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("mixedcut-adb-" + [System.Guid]::NewGuid().ToString("N"))
$zipPath = Join-Path $tempRoot "platform-tools.zip"
$extractDir = Join-Path $tempRoot "extract"

New-Item -ItemType Directory -Force -Path $extractDir | Out-Null

Write-Host "Downloading platform-tools..."
Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing

Write-Host "Extracting platform-tools..."
Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force

$platformToolsDir = Join-Path $extractDir "platform-tools"

$srcAdbExe = Join-Path $platformToolsDir "adb.exe"
$srcAdbWinApi = Join-Path $platformToolsDir "AdbWinApi.dll"
$srcAdbWinUsbApi = Join-Path $platformToolsDir "AdbWinUsbApi.dll"

if (!(Test-Path $srcAdbExe)) { throw "Missing adb.exe (extracted dir: $platformToolsDir)" }
if (!(Test-Path $srcAdbWinApi)) { throw "Missing AdbWinApi.dll (extracted dir: $platformToolsDir)" }
if (!(Test-Path $srcAdbWinUsbApi)) { throw "Missing AdbWinUsbApi.dll (extracted dir: $platformToolsDir)" }

Copy-Item -Force $srcAdbExe $adbExe
Copy-Item -Force $srcAdbWinApi $adbWinApi
Copy-Item -Force $srcAdbWinUsbApi $adbWinUsbApi

Write-Host "ADB prepared: $adbOutDir"

Remove-Item -Recurse -Force $tempRoot -ErrorAction SilentlyContinue

