param([string]$TunnelHost = 'hermes-server')
$ErrorActionPreference = 'Stop'
if ($TunnelHost -notmatch '^[a-zA-Z0-9.-]+$') { throw 'Invalid SSH host alias' }
# Use PowerShell 7, avoiding the Windows PowerShell 5 startup hang on this PC.
$runtime = (Get-Process -Id $PID).Path
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'Run this installer with PowerShell 7.' }
$worker = Join-Path $PSScriptRoot 'remote-forward-worker.ps1'
$action = New-ScheduledTaskAction -Execute $runtime -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -File `"$worker`" -TunnelHost $TunnelHost"
$loginTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# Recover even if the worker itself is stopped or exits with status zero.
$watchdogTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Stop-ScheduledTask -TaskName ThingMakerRemoteForward -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName ThingMakerRemoteForward -Action $action -Trigger @($loginTrigger, $watchdogTrigger) -Settings $settings -Description 'ThingMaker HTTPS origin with automatic reconnect and watchdog' -Force | Out-Null
Start-ScheduledTask -TaskName ThingMakerRemoteForward
