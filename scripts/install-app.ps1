$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$installRecord = Join-Path $root 'target\install-directory.txt'
$installDir = $env:THINGMAKER_INSTALL_DIR
if (!$installDir -and (Test-Path -LiteralPath $installRecord)) { $installDir = (Get-Content -LiteralPath $installRecord -Raw).Trim() }
if (!$installDir) { $installDir = Join-Path $env:LOCALAPPDATA 'ThingMaker' }
if (![IO.Path]::IsPathRooted($installDir)) { throw 'THINGMAKER_INSTALL_DIR must be an absolute path.' }
$installDir = [IO.Path]::GetFullPath($installDir)
. (Join-Path $PSScriptRoot 'windows-build-env.ps1')
Push-Location $root
try {
    & pnpm.cmd --filter '@thingmaker/desktop' exec tauri build --config src-tauri/tauri.windows.conf.json --bundles nsis
    if ($LASTEXITCODE -ne 0) { throw 'ThingMaker build failed.' }
    $installer = Get-ChildItem -LiteralPath (Join-Path $root 'target\release\bundle\nsis') -Filter '*-setup.exe' |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (!$installer) { throw 'The build did not produce a Windows installer.' }
    $running = Get-Process -Name 'thingmaker-desktop' -ErrorAction SilentlyContinue
    if ($running) { throw 'Quit ThingMaker from its tray menu before updating, so local tasks can stop safely.' }
    # NSIS requires /D to be the last argument; it consumes the full path,
    # including spaces, without shell interpretation.
    $setup = Start-Process -FilePath $installer.FullName -ArgumentList @('/S', "/D=$installDir") -Wait -PassThru -WindowStyle Hidden
    if ($setup.ExitCode -ne 0) { throw "Installer exited with code $($setup.ExitCode)." }
    $commit = & git rev-parse HEAD
    Set-Content -LiteralPath (Join-Path $root 'target\installed-build.txt') -Value $commit
    Set-Content -LiteralPath $installRecord -Value $installDir
    Write-Host 'ThingMaker installed. Open ThingMaker from the Windows Start menu.'
} finally { Pop-Location }
