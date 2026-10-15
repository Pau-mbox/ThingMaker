param([string]$TunnelHost = 'hermes-server')
$ErrorActionPreference = 'Stop'
if ($TunnelHost -notmatch '^[a-zA-Z0-9.-]+$') { throw 'Invalid SSH host alias' }
$ssh = Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe'
# SSH can exit successfully after a clean disconnect. Retry every exit, not
# just failures, while retaining loopback-only origin and key authentication.
while ($true) {
    try {
        & $ssh -N -T -o BatchMode=yes -o ExitOnForwardFailure=yes -o ConnectTimeout=10 -o ServerAliveInterval=20 -o ServerAliveCountMax=3 -R 127.0.0.1:18420:127.0.0.1:18420 $TunnelHost 2>$null
    } catch { }
    Start-Sleep -Seconds 5
}
