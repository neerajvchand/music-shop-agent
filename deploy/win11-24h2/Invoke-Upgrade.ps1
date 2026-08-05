<#
.SYNOPSIS
    SYSTEM-context upgrade worker for Windows 11 24H2.

.DESCRIPTION
    Started by RunUpgrade.ps1 as a SYSTEM scheduled task so it survives the
    tech disconnecting. Runs Windows Setup with /noreboot, then triggers a
    single reboot to finish - either on a warned countdown or deferred until
    after active hours, so users are not interrupted mid-day. On failure it
    collects the Panther logs and runs SetupDiag so the cause is captured
    automatically instead of hand-read from setuperr.log.

    Reads parameters from C:\ProgramData\Win11_24H2_Logs\upgrade.config.json.
    Do not run directly - use RunUpgrade.cmd (attended) or KACE (unattended).
#>

$ErrorActionPreference = 'Stop'
$LogDir     = 'C:\ProgramData\Win11_24H2_Logs'
$LogFile    = Join-Path $LogDir 'Setup_Worker.log'
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
function Notify-User { param([string]$Text) try { & msg.exe * /TIME:180 $Text 2>$null } catch { } }

function Find-SetupDiag {
    param([string]$MediaDir)
    foreach ($c in @((Join-Path $LogDir 'tools\SetupDiag.exe'),
                     (Join-Path $MediaDir 'tools\SetupDiag.exe'),
                     'C:\Windows\System32\SetupDiag.exe')) {
        if ($c -and (Test-Path $c)) { return $c }
    }
    return $null
}

# Runs SetupDiag against the live machine's logs and returns a short summary.
function Invoke-SetupDiag {
    param([string]$MediaDir, [string]$OutDir)
    $exe = Find-SetupDiag -MediaDir $MediaDir
    if (-not $exe) { Write-Log 'SetupDiag.exe not found (place it in <media>\tools). Skipping auto-analysis.' 'WARN'; return $null }
    $out = Join-Path $OutDir 'SetupDiagResults.log'
    try {
        # With no /LogsPath, SetupDiag scans the standard Panther/Rollback/NewOS
        # folders on this machine and matches the most recent failure.
        & $exe /Output:$out /Format:xml 2>$null | Out-Null
        $summary = $null
        if (Test-Path $out) {
            $text = Get-Content $out -Raw
            $rule = ([regex]'ProfileName?\s*[:=]\s*"?([^"\r\n<]+)').Match($text).Groups[1].Value
            if (-not $rule) { $rule = ([regex]'Rule(?:\sName)?\s*[:=]\s*"?([^"\r\n<]+)').Match($text).Groups[1].Value }
            $fail = ([regex]'FailureData\s*[:=]\s*"?([^"\r\n<]+)').Match($text).Groups[1].Value
            $summary = ("Rule='{0}' FailureData='{1}'" -f $rule.Trim(), $fail.Trim())
            Write-Log "SetupDiag: $summary" 'ERROR'
        }
        # Registry copy of the result, if SetupDiag wrote one.
        $rk = 'HKLM:\SYSTEM\Setup\SetupDiag\Results'
        if (Test-Path $rk) {
            $p = Get-ItemProperty $rk -EA SilentlyContinue
            if ($p.ProfileName) { Write-Log ("SetupDiag(registry): ProfileName={0} FailureData={1}" -f $p.ProfileName, $p.FailureData) 'ERROR' }
            if (-not $summary -and $p.ProfileName) { $summary = ("Rule='{0}' FailureData='{1}'" -f $p.ProfileName, $p.FailureData) }
        }
        return $summary
    } catch { Write-Log "SetupDiag run failed: $($_.Exception.Message)" 'WARN'; return $null }
}

# Chooses when to restart based on config + current time.
function Start-CoordinatedReboot {
    param($cfg)
    $now      = Get-Date
    $ahStart  = [int]$cfg.ActiveHoursStart
    $ahEnd    = [int]$cfg.ActiveHoursEnd
    $hour     = $now.Hour
    if ($ahStart -le $ahEnd) { $inActive = ($hour -ge $ahStart -and $hour -lt $ahEnd) }
    else                     { $inActive = ($hour -ge $ahStart -or  $hour -lt $ahEnd) }

    if ($cfg.RebootPolicy -eq 'afterhours' -and $inActive) {
        $target = Get-Date -Hour $ahEnd -Minute 0 -Second 0
        if ($target -le $now) { $target = $target.AddDays(1) }
        $delay = [int]($target - $now).TotalSeconds
        $when  = $target.ToString('h:mm tt')
        Notify-User "Your Windows 11 update is staged. Your computer will restart automatically after $when to finish. Please leave it powered on."
        & shutdown.exe /r /t $delay /c "Windows 11 24H2 upgrade will finish with a restart after hours. Please leave the PC on." 2>$null
        Write-Log "Reboot deferred until after active hours ($when); shutdown /r /t $delay." 'OK'
        Set-Status @{ Stage = 'RebootScheduled'; Result = 'InProgress'; Detail = "After hours ($when)" }
    }
    else {
        $secs = [int]$cfg.RebootCountdownSeconds
        $mins = [math]::Round($secs / 60)
        Notify-User "Windows 11 24H2 is ready to finish installing. Your computer will restart in about $mins minute(s). Please save your work now."
        & shutdown.exe /r /t $secs /c "Windows 11 24H2 upgrade: your PC will restart to finish installing. Please save your work." 2>$null
        Write-Log "Warned countdown reboot; shutdown /r /t $secs." 'OK'
        Set-Status @{ Stage = 'RebootScheduled'; Result = 'InProgress'; Detail = "Countdown ${mins}m" }
    }
}

# --------------------------------------------------------------------------
Write-Log ('=' * 60)
Write-Log 'Upgrade worker started (SYSTEM context).'
if (-not (Test-Path $ConfigFile)) { Write-Log "Config not found: $ConfigFile" 'ERROR'; exit 1 }
$cfg = Get-Content $ConfigFile -Raw | ConvertFrom-Json

$setupExe   = $cfg.SetupExe
$setupArgs  = @($cfg.SetupArgs)
$workerTask = $cfg.WorkerTask
if (-not (Test-Path $setupExe)) { Write-Log "setup.exe missing: $setupExe" 'ERROR'; exit 2 }

Write-Log ("Launching: {0} {1}" -f $setupExe, ($setupArgs -join ' '))
Set-Status @{ Stage = 'DownlevelRunning'; Result = 'InProgress' }

try {
    $proc = Start-Process -FilePath $setupExe -ArgumentList $setupArgs -PassThru -Wait
    $code = $proc.ExitCode
} catch {
    Write-Log "Failed to launch Windows Setup: $($_.Exception.Message)" 'ERROR'
    Set-Status @{ Stage = 'LaunchFailed'; Result = 'Failed'; ExitCode = 3 }
    exit 3
}

Write-Log ("Windows Setup (down-level phase) exited with code {0} (0x{1:X})." -f $code, $code)

# 0 = success, 3010 = success/reboot-required. Validate on a pilot machine.
if ($code -eq 0 -or $code -eq 3010) {
    Write-Log 'Down-level phase completed successfully. Preparing reboot.' 'OK'
    Set-Status @{ Stage = 'DownlevelComplete'; Result = 'InProgress'; ExitCode = $code }
    try { Unregister-ScheduledTask -TaskName $workerTask -Confirm:$false -EA SilentlyContinue } catch { }
    Start-CoordinatedReboot -cfg $cfg
    Write-Log 'Reboot arranged. Verifier will confirm the result after restart.' 'OK'
    exit 0
}
else {
    Write-Log "Windows Setup reported a problem (code 0x$('{0:X}' -f $code)). Machine stays on 23H2." 'ERROR'
    $dest = Join-Path $LogDir ('SetupLogs_{0}' -f (Get-Date -Format 'yyyyMMdd_HHmmss'))
    New-Item -Path $dest -ItemType Directory -Force | Out-Null
    foreach ($src in @('C:\$WINDOWS.~BT\Sources\Panther', 'C:\Windows\Panther')) {
        if (Test-Path $src) {
            try { Copy-Item -Path (Join-Path $src '*') -Destination $dest -Recurse -Force -EA SilentlyContinue; Write-Log "Collected logs from $src" }
            catch { Write-Log "Could not copy logs from $src : $($_.Exception.Message)" 'WARN' }
        }
    }
    $diag = Invoke-SetupDiag -MediaDir $cfg.MediaDir -OutDir $dest
    Set-Status @{ Stage = 'DownlevelFailed'; Result = 'Failed'; ExitCode = $code; FailingItem = $diag; LogPath = $dest }
    Notify-User 'The Windows 11 update could not be completed and your computer was left unchanged. Please contact IT support.'
    Write-Log "Setup logs saved to: $dest" 'ERROR'
    exit $code
}
