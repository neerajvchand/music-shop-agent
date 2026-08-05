<#
.SYNOPSIS
    Post-reboot verifier for the Windows 11 24H2 upgrade.

.DESCRIPTION
    Runs at every startup (3-minute delay). State machine:
        * On 24H2                      -> SUCCESS  (notify, record, clean up)
        * Upgrade still in progress    -> stay quiet, re-check next boot
          (C:\$WINDOWS.~BT present, or Setup running)
        * Back on 23H2, nothing in     -> ROLLBACK: collect Panther+Rollback
          flight                          logs, run SetupDiag to capture the
                                          failing rule/driver, record it, alert

    Records the outcome in HKLM\SOFTWARE\Win11_24H2_Upgrade so a silent
    rollback after the tech leaves is caught - and surfaced fleet-wide by a
    KACE Custom Inventory Rule (see DEPLOYMENT.md).
#>

$ErrorActionPreference = 'SilentlyContinue'
$LogDir     = 'C:\ProgramData\Win11_24H2_Logs'
$LogFile    = Join-Path $LogDir 'Verify.log'
$ConfigFile = Join-Path $LogDir 'upgrade.config.json'
$StatusKey  = 'HKLM:\SOFTWARE\Win11_24H2_Upgrade'

function Write-Log {
    param([string]$Message, [ValidateSet('INFO','WARN','ERROR','OK')][string]$Level = 'INFO')
    Add-Content -Path $LogFile -Value ('[{0}] [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message)
}
function Set-Status {
    param([hashtable]$Values)
    try {
        if (-not (Test-Path $StatusKey)) { New-Item -Path $StatusKey -Force | Out-Null }
        foreach ($k in $Values.Keys) { New-ItemProperty -Path $StatusKey -Name $k -Value ([string]$Values[$k]) -PropertyType String -Force | Out-Null }
        New-ItemProperty -Path $StatusKey -Name 'LastUpdated' -Value (Get-Date -Format 's') -PropertyType String -Force | Out-Null
    } catch { }
}
function Notify-User { param([string]$Text) try { & msg.exe * /TIME:120 $Text 2>$null } catch { } }

$target     = '24H2'
$verifyTask = 'Win11_24H2_Verify'
$workerTask = 'Win11_24H2_Upgrade'
$mediaDir   = ''
if (Test-Path $ConfigFile) {
    try {
        $cfg = Get-Content $ConfigFile -Raw | ConvertFrom-Json
        if ($cfg.TargetVersion) { $target = $cfg.TargetVersion }
        if ($cfg.VerifyTask)    { $verifyTask = $cfg.VerifyTask }
        if ($cfg.WorkerTask)    { $workerTask = $cfg.WorkerTask }
        if ($cfg.MediaDir)      { $mediaDir  = $cfg.MediaDir }
    } catch { }
}

function Remove-AllTasks {
    foreach ($t in @($workerTask, $verifyTask)) {
        try { Unregister-ScheduledTask -TaskName $t -Confirm:$false -EA SilentlyContinue } catch { }
    }
}

function Find-SetupDiag {
    foreach ($c in @((Join-Path $LogDir 'tools\SetupDiag.exe'),
                     (Join-Path $mediaDir 'tools\SetupDiag.exe'),
                     'C:\Windows\System32\SetupDiag.exe')) {
        if ($c -and (Test-Path $c)) { return $c }
    }
    return $null
}

# Analyze the rolled-back machine's logs and return a one-line cause.
function Get-RollbackCause {
    param([string]$OutDir)
    $exe = Find-SetupDiag
    if (-not $exe) { Write-Log 'SetupDiag.exe not found (place in <media>\tools) - cannot auto-analyze rollback.' 'WARN'; return $null }
    $out = Join-Path $OutDir 'SetupDiagResults.log'
    try {
        & $exe /Output:$out /Format:xml 2>$null | Out-Null
        $rule = $null; $fail = $null
        if (Test-Path $out) {
            $text = Get-Content $out -Raw
            $rule = ([regex]'ProfileName?\s*[:=]\s*"?([^"\r\n<]+)').Match($text).Groups[1].Value
            if (-not $rule) { $rule = ([regex]'Rule(?:\sName)?\s*[:=]\s*"?([^"\r\n<]+)').Match($text).Groups[1].Value }
            $fail = ([regex]'FailureData\s*[:=]\s*"?([^"\r\n<]+)').Match($text).Groups[1].Value
        }
        $rk = 'HKLM:\SYSTEM\Setup\SetupDiag\Results'
        if (Test-Path $rk) {
            $p = Get-ItemProperty $rk -EA SilentlyContinue
            if (-not $rule -and $p.ProfileName) { $rule = $p.ProfileName }
            if (-not $fail -and $p.FailureData) { $fail = $p.FailureData }
        }
        $summary = ("Rule='{0}' FailureData='{1}'" -f ("$rule").Trim(), ("$fail").Trim())
        Write-Log "SetupDiag: $summary" 'ERROR'
        return @{ Rule = ("$rule").Trim(); FailureData = ("$fail").Trim() }
    } catch { Write-Log "SetupDiag failed: $($_.Exception.Message)" 'WARN'; return $null }
}

# --------------------------------------------------------------------------
Write-Log '--- Verifier run ---'
$current = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -Name DisplayVersion -EA SilentlyContinue).DisplayVersion
Write-Log "Current DisplayVersion: $current (target: $target)"

if ($current -eq $target) {
    Write-Log 'SUCCESS: computer is now running Windows 11 24H2.' 'OK'
    Set-Status @{ Stage = 'Complete'; Result = 'Success'; DisplayVersion = $current; ExitCode = 0 }
    Notify-User 'Your Windows 11 24H2 update finished successfully. Thank you for your patience.'
    Remove-AllTasks
    exit 0
}

# Not on target yet - mid-upgrade or rolled back?
# NOTE: a bare "C:\$WINDOWS.~BT exists" test is NOT a reliable in-progress
# signal - that folder lingers for ~10 days AFTER a rollback too. Key off
# active indicators instead: Setup running, or Windows still in setup state.
$setupRunning = [bool](Get-Process -Name setup, setupprep, SetupHost -EA SilentlyContinue)
$setupState   = (Get-ItemProperty 'HKLM:\SYSTEM\Setup' -Name SystemSetupInProgress -EA SilentlyContinue).SystemSetupInProgress
$inFlight = $setupRunning -or ($setupState -eq 1)
if ($inFlight) {
    Write-Log 'Upgrade still in progress (Setup running / system in setup state). Will re-check next boot.' 'INFO'
    Set-Status @{ Stage = 'OnlinePhase'; Result = 'InProgress'; DisplayVersion = $current }
    exit 0
}

# Rolled back.
Write-Log "ROLLBACK: computer is back on '$current' with no upgrade in progress." 'ERROR'
$dest = Join-Path $LogDir ('RollbackLogs_{0}' -f (Get-Date -Format 'yyyyMMdd_HHmmss'))
New-Item -Path $dest -ItemType Directory -Force | Out-Null
foreach ($src in @('C:\$WINDOWS.~BT\Sources\Panther', 'C:\$WINDOWS.~BT\Sources\Rollback', 'C:\Windows\Panther')) {
    if (Test-Path $src) {
        try { Copy-Item -Path (Join-Path $src '*') -Destination $dest -Recurse -Force -EA SilentlyContinue; Write-Log "Collected logs from $src" } catch { }
    }
}
$cause = Get-RollbackCause -OutDir $dest
Set-Status @{
    Stage       = 'RolledBack'
    Result      = 'Rollback'
    DisplayVersion = $current
    FailureRule = if ($cause) { $cause.Rule } else { 'unknown (SetupDiag unavailable)' }
    FailingItem = if ($cause) { $cause.FailureData } else { '' }
    LogPath     = $dest
    ExitCode    = 1
}
Notify-User 'The Windows 11 update did not complete and your computer returned to its previous version. Please contact IT support.'
Write-Log "Rollback logs + SetupDiag saved to: $dest" 'ERROR'
Remove-AllTasks
exit 1
