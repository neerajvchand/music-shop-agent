<#
.SYNOPSIS
    Windows 11 24H2 in-place upgrade orchestrator (ISS launcher).

.DESCRIPTION
    Run by RunUpgrade.cmd (elevated). Performs all pre-flight safety checks,
    notifies the signed-in user, then hands the actual upgrade off to a
    SYSTEM-context scheduled task (Invoke-Upgrade.ps1) so it survives the
    ISS disconnecting. Also registers a post-reboot verifier
    (Verify-Upgrade.ps1) that confirms the upgrade succeeded - or flags a
    rollback - after the machine comes back.

    Design keeps the proven "SYSTEM via Task Scheduler" handoff from the
    original RunUpgrade.cmd and adds: disk/power/pending-reboot pre-checks,
    a user notification, a real poll loop (no more 8-second false alarms),
    a coordinated warned reboot, and post-upgrade rollback detection.

.NOTES
    Validate the setup.exe switch string on ONE pilot machine before fleet
    use - Windows 11 24H2 changed some Setup behavior. See README.md.
#>

[CmdletBinding()]
param(
    # Folder containing setup.exe + \sources (passed in by RunUpgrade.cmd).
    [Parameter(Mandatory = $true)]
    [string]$MediaDir,

    # Minimum free space required on the system drive (GB).
    [int]$MinFreeGB = 25,

    # Seconds the user sees on the coordinated reboot countdown (default 5 min).
    [int]$RebootCountdownSeconds = 300,

    # 'enable' downloads Setup/compat updates during the upgrade (fewer
    # rollbacks, needs internet). 'disable' is fully offline but skips the
    # fixes Microsoft ships specifically to prevent 24H2 rollbacks.
    [ValidateSet('enable', 'disable')]
    [string]$DynamicUpdate = 'enable',

    # Allow the upgrade to proceed on a laptop running on battery.
    [switch]$AllowOnBattery,

    # Treat a pending reboot as a hard stop instead of a warning.
    [switch]$BlockOnPendingReboot
)

# --------------------------------------------------------------------------
# Constants
# --------------------------------------------------------------------------
$ErrorActionPreference = 'Stop'
$TargetVersion  = '24H2'
$LogDir         = 'C:\ProgramData\Win11_24H2_Logs'
$LogFile        = Join-Path $LogDir 'RunUpgrade.log'
$ConfigFile     = Join-Path $LogDir 'upgrade.config.json'
$WorkerScript   = Join-Path $LogDir 'Invoke-Upgrade.ps1'
$VerifyScript   = Join-Path $LogDir 'Verify-Upgrade.ps1'
$WorkerTask     = 'Win11_24H2_Upgrade'
$VerifyTask     = 'Win11_24H2_Verify'

# --------------------------------------------------------------------------
# Logging
# --------------------------------------------------------------------------
if (-not (Test-Path $LogDir)) { New-Item -Path $LogDir -ItemType Directory -Force | Out-Null }

function Write-Log {
    param([string]$Message, [ValidateSet('INFO','WARN','ERROR','OK')][string]$Level = 'INFO')
    $line = ('[{0}] [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message)
    Add-Content -Path $LogFile -Value $line
    $color = @{ INFO = 'Gray'; WARN = 'Yellow'; ERROR = 'Red'; OK = 'Green' }[$Level]
    Write-Host $Message -ForegroundColor $color
}

function Notify-User {
    # Cross-session, no dependencies: msg.exe reaches the console user even
    # though we may be in a different session. Best-effort only.
    param([string]$Text)
    try { & msg.exe * /TIME:120 $Text 2>$null } catch { }
}

function Fail {
    param([string]$Message, [int]$Code)
    Write-Log $Message 'ERROR'
    Write-Host ''
    Write-Host "RESULT: NOT STARTED (exit $Code). See $LogFile" -ForegroundColor Red
    exit $Code
}

# --------------------------------------------------------------------------
Write-Log ('=' * 60)
Write-Log ("Upgrade launcher started on {0} (user session: {1})" -f $env:COMPUTERNAME, $env:USERNAME)

Write-Host ''
Write-Host '==========================================' -ForegroundColor Cyan
Write-Host ' Windows 11 24H2 Upgrade Launcher' -ForegroundColor Cyan
Write-Host '==========================================' -ForegroundColor Cyan
Write-Host ''

# --- Resolve media dir ----------------------------------------------------
try { $MediaDir = (Resolve-Path -LiteralPath $MediaDir).Path } catch { Fail "Media folder not found: $MediaDir" 2 }
$SetupExe = Join-Path $MediaDir 'setup.exe'
Write-Log "Media folder: $MediaDir"

# --- 1. Administrator (belt & suspenders; .cmd already elevated) ----------
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
          ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Fail 'This launcher must run as Administrator.' 1 }

# --- 2. Already on 24H2? --------------------------------------------------
$current = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -Name DisplayVersion -EA SilentlyContinue).DisplayVersion
Write-Log "Current Windows version: $current"
if ($current -eq $TargetVersion) {
    Write-Log 'Computer is already running Windows 11 24H2. Nothing to do.' 'OK'
    Write-Host ''
    Write-Host 'RESULT: ALREADY ON 24H2 - no action needed.' -ForegroundColor Green
    exit 0
}

# --- 3. Media present -----------------------------------------------------
if (-not (Test-Path $SetupExe))                    { Fail "setup.exe not found in: $MediaDir" 2 }
if (-not (Test-Path (Join-Path $MediaDir 'sources'))) { Fail "sources folder not found in: $MediaDir" 3 }
Write-Log 'Installation media verified (setup.exe + sources present).' 'OK'

# --- 4. Setup already running? -------------------------------------------
$running = Get-Process -Name setup, setupprep, SetupHost -EA SilentlyContinue
if ($running) { Fail 'Windows Setup is already running on this machine.' 4 }

# --- 5. Free disk space ---------------------------------------------------
$sysDrive = $env:SystemDrive
$disk     = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$sysDrive'"
$freeGB   = [math]::Round($disk.FreeSpace / 1GB, 1)
Write-Log ("Free space on {0} : {1} GB (need >= {2} GB)" -f $sysDrive, $freeGB, $MinFreeGB)
if ($freeGB -lt $MinFreeGB) {
    Fail ("Not enough free space on {0}: {1} GB free, need at least {2} GB." -f $sysDrive, $freeGB, $MinFreeGB) 10
}

# --- 6. AC power (laptops) ------------------------------------------------
$battery = Get-CimInstance Win32_Battery -EA SilentlyContinue
if ($battery) {
    # BatteryStatus: 1 = discharging (on battery), 2 = AC connected.
    $onBattery = ($battery | Where-Object { $_.BatteryStatus -eq 1 })
    if ($onBattery -and -not $AllowOnBattery) {
        Fail 'This laptop is running on battery. Plug into AC power and re-run (or pass -AllowOnBattery).' 11
    } elseif ($onBattery) {
        Write-Log 'Running on battery, continuing because -AllowOnBattery was set.' 'WARN'
    } else {
        Write-Log 'Laptop is on AC power.' 'OK'
    }
}

# --- 7. Pending reboot ----------------------------------------------------
$pending = $false
$cbs = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending'
$wu  = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired'
if (Test-Path $cbs) { $pending = $true }
if (Test-Path $wu)  { $pending = $true }
$pfr = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager' -Name PendingFileRenameOperations -EA SilentlyContinue).PendingFileRenameOperations
if ($pfr) { $pending = $true }
if ($pending) {
    if ($BlockOnPendingReboot) {
        Fail 'A reboot is pending from prior updates. Restart the PC and re-run.' 12
    }
    Write-Log 'A reboot is pending from prior updates - upgrade may fail. Recommend restarting first.' 'WARN'
} else {
    Write-Log 'No pending reboot detected.' 'OK'
}

# --- 8. Compatibility bypass (Windows-To-Go / portable flag) --------------
try {
    $priorPos = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control' -Name PortableOperatingSystem -EA SilentlyContinue).PortableOperatingSystem
    Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control' -Name PortableOperatingSystem -Value 0 -Type DWord
    Write-Log ("PortableOperatingSystem set to 0 (was: {0})." -f ($priorPos -as [string]))
} catch {
    Fail "Failed to set PortableOperatingSystem registry value: $($_.Exception.Message)" 20
}

# --- 9. Stage helper scripts into ProgramData -----------------------------
# Copied off the media so they survive even if C:\Temp media is cleaned up
# before the post-reboot verifier runs.
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Invoke-Upgrade.ps1') -Destination $WorkerScript -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Verify-Upgrade.ps1') -Destination $VerifyScript -Force

$setupArgs = @(
    '/auto', 'upgrade',
    '/quiet',
    '/eula', 'accept',
    '/compat', 'ignorewarning',
    '/showoobe', 'none',
    '/noreboot',
    '/copylogs', (Join-Path $LogDir 'Panther'),
    '/dynamicupdate', $DynamicUpdate
)

$config = [ordered]@{
    MediaDir               = $MediaDir
    SetupExe               = $SetupExe
    SetupArgs              = $setupArgs
    LogDir                 = $LogDir
    RebootCountdownSeconds = $RebootCountdownSeconds
    WorkerTask             = $WorkerTask
    VerifyTask             = $VerifyTask
    TargetVersion          = $TargetVersion
}
$config | ConvertTo-Json -Depth 4 | Set-Content -Path $ConfigFile -Encoding UTF8
Write-Log "Wrote upgrade config: $ConfigFile"

# --- 10. Register tasks ---------------------------------------------------
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

try {
    # Worker: runs the upgrade as SYSTEM, right now.
    $workerAction = New-ScheduledTaskAction -Execute $psExe `
        -Argument ('-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $WorkerScript)
    $workerTaskObj = New-ScheduledTask -Action $workerAction -Principal $principal
    Register-ScheduledTask -TaskName $WorkerTask -InputObject $workerTaskObj -Force | Out-Null
    Write-Log "Registered worker task '$WorkerTask'."

    # Verifier: runs at every boot; self-cleans once it reaches a verdict.
    $verifyAction = New-ScheduledTaskAction -Execute $psExe `
        -Argument ('-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $VerifyScript)
    $verifyTrigger = New-ScheduledTaskTrigger -AtStartup
    $verifyTrigger.Delay = 'PT3M'
    $verifyTaskObj = New-ScheduledTask -Action $verifyAction -Trigger $verifyTrigger -Principal $principal
    Register-ScheduledTask -TaskName $VerifyTask -InputObject $verifyTaskObj -Force | Out-Null
    Write-Log "Registered post-reboot verifier task '$VerifyTask'."
} catch {
    Fail "Failed to register scheduled task(s): $($_.Exception.Message)" 21
}

# --- 11. Notify the user, then start the worker ---------------------------
Notify-User 'Your computer is starting a Windows 11 24H2 update in the background. You can keep working - please save your files. The PC will warn you before it restarts to finish.'
Write-Log 'Notified the signed-in user that the upgrade is starting.'

try {
    Start-ScheduledTask -TaskName $WorkerTask
    Write-Log 'Started the upgrade worker task.'
} catch {
    Fail "Failed to start the upgrade worker task: $($_.Exception.Message)" 22
}

# --- 12. Confirm Setup actually launched (real poll loop) -----------------
Write-Host ''
Write-Host 'Waiting for Windows Setup to start (up to 90 seconds)...' -ForegroundColor Cyan
$deadline = (Get-Date).AddSeconds(90)
$setupSeen = $false
while ((Get-Date) -lt $deadline) {
    if (Get-Process -Name setup, setupprep, SetupHost -EA SilentlyContinue) { $setupSeen = $true; break }
    Start-Sleep -Seconds 3
    Write-Host '.' -NoNewline
}
Write-Host ''

if ($setupSeen) {
    Write-Log 'Windows Setup processes detected - upgrade is running.' 'OK'
    Write-Host ''
    Write-Host '=====================================================' -ForegroundColor Green
    Write-Host ' RESULT: UPGRADE STARTED' -ForegroundColor Green
    Write-Host '=====================================================' -ForegroundColor Green
    Write-Host ''
    Write-Host ' - Setup is running silently as SYSTEM.' -ForegroundColor Green
    Write-Host " - The user was told to save their work; the PC will warn them" -ForegroundColor Green
    Write-Host "   and restart on its own (about $([math]::Round($RebootCountdownSeconds/60)) min warning) to finish." -ForegroundColor Green
    Write-Host ' - You may disconnect. The upgrade takes ~30-45 minutes total.' -ForegroundColor Green
    Write-Host ''
    Write-Host ' Verify anytime:  tasklist | findstr /i "setup setuphost setupprep"' -ForegroundColor Gray
    Write-Host " Log file:        $LogFile" -ForegroundColor Gray
    Write-Host ''
    exit 0
} else {
    Write-Log 'Setup processes not visible after 90s. It may still be initializing (copying media).' 'WARN'
    Write-Host ''
    Write-Host 'RESULT: NOT CONFIRMED YET' -ForegroundColor Yellow
    Write-Host 'Wait a minute, then run: tasklist | findstr /i "setup setuphost setupprep"' -ForegroundColor Yellow
    Write-Host "If nothing appears, check the log: $LogFile" -ForegroundColor Yellow
    exit 23
}
