<#
.SYNOPSIS
    Post-reboot verifier for the Windows 11 24H2 upgrade.

.DESCRIPTION
    Registered by RunUpgrade.ps1 to run at every startup (3-minute delay).
    Implements a small state machine so it does not cry "rollback" during
    the normal multi-reboot online phase:

        * On 24H2                         -> SUCCESS  (notify user, clean up)
        * Upgrade still in progress       -> stay quiet, run again next boot
          (C:\$WINDOWS.~BT present, or Setup still running)
        * Back on 23H2 and no upgrade     -> ROLLBACK (collect logs, alert)
          in flight

    This closes the "ISS reported success but the PC silently reverted" gap:
    the outcome is recorded in the log whether or not anyone is watching.
#>

$ErrorActionPreference = 'SilentlyContinue'
$LogDir     = 'C:\ProgramData\Win11_24H2_Logs'
$LogFile    = Join-Path $LogDir 'Verify.log'
$ConfigFile = Join-Path $LogDir 'upgrade.config.json'

function Write-Log {
    param([string]$Message, [ValidateSet('INFO','WARN','ERROR','OK')][string]$Level = 'INFO')
    $line = ('[{0}] [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message)
    Add-Content -Path $LogFile -Value $line
}
function Notify-User { param([string]$Text) try { & msg.exe * /TIME:120 $Text 2>$null } catch { } }

$target     = '24H2'
$verifyTask = 'Win11_24H2_Verify'
$workerTask = 'Win11_24H2_Upgrade'
if (Test-Path $ConfigFile) {
    try {
        $cfg = Get-Content $ConfigFile -Raw | ConvertFrom-Json
        if ($cfg.TargetVersion) { $target = $cfg.TargetVersion }
        if ($cfg.VerifyTask)    { $verifyTask = $cfg.VerifyTask }
        if ($cfg.WorkerTask)    { $workerTask = $cfg.WorkerTask }
    } catch { }
}

function Remove-AllTasks {
    foreach ($t in @($workerTask, $verifyTask)) {
        try { Unregister-ScheduledTask -TaskName $t -Confirm:$false -EA SilentlyContinue } catch { }
    }
}

Write-Log '--- Verifier run ---'
$current = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -Name DisplayVersion -EA SilentlyContinue).DisplayVersion
Write-Log "Current DisplayVersion: $current (target: $target)"

if ($current -eq $target) {
    Write-Log 'SUCCESS: computer is now running Windows 11 24H2.' 'OK'
    Notify-User 'Your Windows 11 24H2 update finished successfully. Thank you for your patience.'
    Remove-AllTasks
    exit 0
}

# Not on target yet. Are we mid-upgrade, or did it roll back?
$upgradeInFlight = (Test-Path 'C:\$WINDOWS.~BT') -or
                   (Test-Path 'C:\$WINDOWS.~WS') -or
                   [bool](Get-Process -Name setup, setupprep, SetupHost -EA SilentlyContinue)

if ($upgradeInFlight) {
    Write-Log 'Upgrade still in progress (staging folder or Setup present). Will re-check next boot.' 'INFO'
    exit 0
}

# On 23H2, nothing in flight -> the upgrade rolled back.
Write-Log "ROLLBACK: computer is back on '$current' with no upgrade in progress." 'ERROR'
$dest = Join-Path $LogDir ('RollbackLogs_{0}' -f (Get-Date -Format 'yyyyMMdd_HHmmss'))
New-Item -Path $dest -ItemType Directory -Force | Out-Null
foreach ($src in @('C:\$WINDOWS.~BT\Sources\Panther',
                   'C:\$WINDOWS.~BT\Sources\Rollback',
                   'C:\Windows\Panther')) {
    if (Test-Path $src) {
        try {
            Copy-Item -Path (Join-Path $src '*') -Destination $dest -Recurse -Force -EA SilentlyContinue
            Write-Log "Collected logs from $src"
        } catch { }
    }
}
Notify-User 'The Windows 11 update did not complete and your computer returned to its previous version. Please contact IT support.'
Write-Log "Rollback logs saved to: $dest" 'ERROR'
Remove-AllTasks
exit 1
