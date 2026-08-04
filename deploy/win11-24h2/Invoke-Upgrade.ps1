<#
.SYNOPSIS
    SYSTEM-context upgrade worker for Windows 11 24H2.

.DESCRIPTION
    Started by RunUpgrade.ps1 as a SYSTEM scheduled task so it survives the
    ISS disconnecting. Runs Windows Setup with /noreboot, waits for the
    down-level phase to finish, then triggers a single COORDINATED, WARNED
    reboot so the user is not yanked mid-work. On failure it collects the
    Setup (Panther) logs and leaves the machine on 23H2 untouched.

    Reads its parameters from C:\ProgramData\Win11_24H2_Logs\upgrade.config.json.
    Do not run this directly - use RunUpgrade.cmd.
#>

$ErrorActionPreference = 'Stop'
$LogDir     = 'C:\ProgramData\Win11_24H2_Logs'
$LogFile    = Join-Path $LogDir 'Setup_Worker.log'
$ConfigFile = Join-Path $LogDir 'upgrade.config.json'

function Write-Log {
    param([string]$Message, [ValidateSet('INFO','WARN','ERROR','OK')][string]$Level = 'INFO')
    $line = ('[{0}] [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message)
    Add-Content -Path $LogFile -Value $line
}

function Notify-User {
    param([string]$Text)
    try { & msg.exe * /TIME:180 $Text 2>$null } catch { }
}

Write-Log ('=' * 60)
Write-Log 'Upgrade worker started (SYSTEM context).'

if (-not (Test-Path $ConfigFile)) { Write-Log "Config not found: $ConfigFile" 'ERROR'; exit 1 }
$cfg = Get-Content $ConfigFile -Raw | ConvertFrom-Json

$setupExe  = $cfg.SetupExe
$setupArgs = @($cfg.SetupArgs)
$countdown = [int]$cfg.RebootCountdownSeconds
$workerTask = $cfg.WorkerTask

if (-not (Test-Path $setupExe)) { Write-Log "setup.exe missing: $setupExe" 'ERROR'; exit 2 }

Write-Log ("Launching: {0} {1}" -f $setupExe, ($setupArgs -join ' '))

try {
    $proc = Start-Process -FilePath $setupExe -ArgumentList $setupArgs -PassThru -Wait
    $code = $proc.ExitCode
} catch {
    Write-Log "Failed to launch Windows Setup: $($_.Exception.Message)" 'ERROR'
    exit 3
}

Write-Log ("Windows Setup (down-level phase) exited with code {0} (0x{1:X})." -f $code, $code)

# Exit 0 = success. 3010 = success, reboot required. Anything else: treat as
# a failure, keep the machine on 23H2, and gather logs for the ISS.
# NOTE: confirm the success code(s) for your exact 24H2 media on a pilot box.
if ($code -eq 0 -or $code -eq 3010) {
    Write-Log 'Down-level phase completed successfully. Preparing coordinated reboot.' 'OK'

    # Remove the one-shot worker task; it has done its job.
    try { Unregister-ScheduledTask -TaskName $workerTask -Confirm:$false -EA SilentlyContinue } catch { }

    $mins = [math]::Round($countdown / 60)
    Notify-User ("Windows 11 24H2 is ready to finish installing. Your computer will restart in about $mins minute(s). Please save your work now.")
    Write-Log "Warned the user; issuing shutdown /r /t $countdown."

    # shutdown.exe shows its own on-screen countdown/warning to the user.
    & shutdown.exe /r /t $countdown /c "Windows 11 24H2 upgrade: your PC will restart to finish installing. Please save your work." 2>$null
    Write-Log 'Coordinated reboot scheduled. Verifier will confirm the result after restart.' 'OK'
    exit 0
}
else {
    Write-Log "Windows Setup reported a problem (code 0x$('{0:X}' -f $code)). Machine stays on 23H2." 'ERROR'

    # Collect Setup logs for diagnosis.
    $dest = Join-Path $LogDir ('SetupLogs_{0}' -f (Get-Date -Format 'yyyyMMdd_HHmmss'))
    New-Item -Path $dest -ItemType Directory -Force | Out-Null
    foreach ($src in @('C:\$WINDOWS.~BT\Sources\Panther', 'C:\Windows\Panther')) {
        if (Test-Path $src) {
            try {
                Copy-Item -Path (Join-Path $src '*') -Destination $dest -Recurse -Force -EA SilentlyContinue
                Write-Log "Collected logs from $src"
            } catch { Write-Log "Could not copy logs from $src : $($_.Exception.Message)" 'WARN' }
        }
    }
    Notify-User 'The Windows 11 update could not be completed and your computer was left unchanged. Please contact IT support.'
    Write-Log "Setup logs saved to: $dest" 'ERROR'
    exit $code
}
