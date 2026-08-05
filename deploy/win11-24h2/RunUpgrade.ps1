<#
.SYNOPSIS
    Windows 11 24H2 in-place upgrade orchestrator (ISS launcher + KACE payload).

.DESCRIPTION
    Two ways to run it:
      * Attended  - via RunUpgrade.cmd (a tech double-clicks; UAC elevates).
      * Unattended - as a KACE Managed Installation / scheduled job:
            powershell -NoProfile -ExecutionPolicy Bypass -File RunUpgrade.ps1 -Unattended
        Unattended auto-detects when there is no interactive desktop, suppresses
        prompts/pauses, communicates only through exit codes + a status registry
        key, and defaults the reboot to "after active hours" so users are not
        interrupted mid-day.

    Keeps the proven "run Setup as SYSTEM via Task Scheduler" handoff, and adds
    pre-flight checks, user notification, a real poll loop, an active-hours-aware
    warned reboot, automatic post-upgrade success/ROLLBACK detection with
    SetupDiag analysis, and fleet-reportable status in the registry.

.NOTES
    Fleet reporting: everything lands in HKLM\SOFTWARE\Win11_24H2_Upgrade
    (Stage, Result, DisplayVersion, FailureRule, FailingItem, ExitCode,
    LastUpdated) so a KACE Custom Inventory Rule can surface upgrade state
    across the whole estate. See DEPLOYMENT.md.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$MediaDir,                       # folder with setup.exe + \sources

    [int]$MinFreeGB = 25,                     # required free space on system drive
    [int]$RebootCountdownSeconds = 300,       # user warning before a countdown reboot

    # Reboot policy after the down-level phase completes:
    #   'afterhours' - wait until ActiveHoursEnd, then restart (default unattended)
    #   'countdown'  - warn for RebootCountdownSeconds, then restart (default attended)
    [ValidateSet('afterhours', 'countdown')]
    [string]$RebootPolicy,
    [int]$ActiveHoursStart = 8,               # 24h clock; users considered "working"
    [int]$ActiveHoursEnd   = 18,              # between these hours

    # 'enable' pulls Setup/compat/SafeOS fixes during the upgrade (fewer
    # rollbacks, needs internet). 'disable' is offline but skips the fixes
    # Microsoft ships specifically to PREVENT 24H2 driver rollbacks.
    [ValidateSet('enable', 'disable')]
    [string]$DynamicUpdate = 'enable',

    [switch]$Unattended,                      # force unattended (else auto-detected)
    [switch]$AllowOnBattery,
    [switch]$BlockOnPendingReboot
)

# --------------------------------------------------------------------------
$ErrorActionPreference = 'Stop'
$TargetVersion  = '24H2'
$LogDir         = 'C:\ProgramData\Win11_24H2_Logs'
$LogFile        = Join-Path $LogDir 'RunUpgrade.log'
$ConfigFile     = Join-Path $LogDir 'upgrade.config.json'
$WorkerScript   = Join-Path $LogDir 'Invoke-Upgrade.ps1'
$VerifyScript   = Join-Path $LogDir 'Verify-Upgrade.ps1'
$StatusKey      = 'HKLM:\SOFTWARE\Win11_24H2_Upgrade'
$WorkerTask     = 'Win11_24H2_Upgrade'
$VerifyTask     = 'Win11_24H2_Verify'

# Unattended if forced, or if there is no interactive desktop (KACE/SYSTEM).
$IsUnattended = $Unattended.IsPresent -or (-not [Environment]::UserInteractive)
if (-not $RebootPolicy) { $RebootPolicy = if ($IsUnattended) { 'afterhours' } else { 'countdown' } }

if (-not (Test-Path $LogDir)) { New-Item -Path $LogDir -ItemType Directory -Force | Out-Null }

function Write-Log {
    param([string]$Message, [ValidateSet('INFO','WARN','ERROR','OK')][string]$Level = 'INFO')
    $line = ('[{0}] [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message)
    Add-Content -Path $LogFile -Value $line
    if (-not $IsUnattended) {
        $color = @{ INFO='Gray'; WARN='Yellow'; ERROR='Red'; OK='Green' }[$Level]
        Write-Host $Message -ForegroundColor $color
    } else {
        Write-Output $line   # goes to the KACE run log
    }
}

function Set-Status {
    param([hashtable]$Values)
    try {
        if (-not (Test-Path $StatusKey)) { New-Item -Path $StatusKey -Force | Out-Null }
        foreach ($k in $Values.Keys) {
            New-ItemProperty -Path $StatusKey -Name $k -Value ([string]$Values[$k]) -PropertyType String -Force | Out-Null
        }
        New-ItemProperty -Path $StatusKey -Name 'LastUpdated' -Value (Get-Date -Format 's') -PropertyType String -Force | Out-Null
    } catch { }
}

function Notify-User {
    param([string]$Text)
    try { & msg.exe * /TIME:120 $Text 2>$null } catch { }
}

function Fail {
    param([string]$Message, [int]$Code)
    Write-Log $Message 'ERROR'
    Set-Status @{ Stage = 'PrecheckFailed'; Result = 'NotStarted'; ExitCode = $Code; Detail = $Message }
    if (-not $IsUnattended) {
        Write-Host ''
        Write-Host "RESULT: NOT STARTED (exit $Code). See $LogFile" -ForegroundColor Red
    }
    exit $Code
}

# --------------------------------------------------------------------------
Write-Log ('=' * 60)
Write-Log ("Launcher started on {0} (unattended={1}, rebootPolicy={2})" -f $env:COMPUTERNAME, $IsUnattended, $RebootPolicy)
Set-Status @{ Stage = 'Starting'; Result = 'InProgress'; Computer = $env:COMPUTERNAME }

if (-not $IsUnattended) {
    Write-Host ''
    Write-Host '==========================================' -ForegroundColor Cyan
    Write-Host ' Windows 11 24H2 Upgrade Launcher' -ForegroundColor Cyan
    Write-Host '==========================================' -ForegroundColor Cyan
    Write-Host ''
}

# --- Resolve media dir ----------------------------------------------------
try { $MediaDir = (Resolve-Path -LiteralPath $MediaDir).Path } catch { Fail "Media folder not found: $MediaDir" 2 }
$SetupExe = Join-Path $MediaDir 'setup.exe'
Write-Log "Media folder: $MediaDir"

# --- 1. Administrator -----------------------------------------------------
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
          ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Fail 'This launcher must run as Administrator (or SYSTEM).' 1 }

# --- 2. Already on 24H2? --------------------------------------------------
$current = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -Name DisplayVersion -EA SilentlyContinue).DisplayVersion
Write-Log "Current Windows version: $current"
if ($current -eq $TargetVersion) {
    Write-Log 'Computer is already running Windows 11 24H2. Nothing to do.' 'OK'
    Set-Status @{ Stage = 'AlreadyCurrent'; Result = 'Success'; DisplayVersion = $current; ExitCode = 0 }
    if (-not $IsUnattended) { Write-Host ''; Write-Host 'RESULT: ALREADY ON 24H2 - no action needed.' -ForegroundColor Green }
    exit 0
}

# --- 3. Media present -----------------------------------------------------
if (-not (Test-Path $SetupExe))                       { Fail "setup.exe not found in: $MediaDir" 2 }
if (-not (Test-Path (Join-Path $MediaDir 'sources'))) { Fail "sources folder not found in: $MediaDir" 3 }
Write-Log 'Installation media verified (setup.exe + sources present).' 'OK'

# --- 4. Setup already running? -------------------------------------------
if (Get-Process -Name setup, setupprep, SetupHost -EA SilentlyContinue) {
    Fail 'Windows Setup is already running on this machine.' 4
}

# --- 5. Free disk space ---------------------------------------------------
$sysDrive = $env:SystemDrive
$disk     = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$sysDrive'"
$freeGB   = [math]::Round($disk.FreeSpace / 1GB, 1)
Write-Log ("Free space on {0}: {1} GB (need >= {2} GB)" -f $sysDrive, $freeGB, $MinFreeGB)
if ($freeGB -lt $MinFreeGB) { Fail ("Not enough free space on {0}: {1} GB free, need >= {2} GB." -f $sysDrive, $freeGB, $MinFreeGB) 10 }

# --- 6. AC power (laptops) ------------------------------------------------
$battery = Get-CimInstance Win32_Battery -EA SilentlyContinue
if ($battery) {
    $onBattery = ($battery | Where-Object { $_.BatteryStatus -eq 1 })  # 1 = discharging
    if ($onBattery -and -not $AllowOnBattery) {
        Fail 'This laptop is on battery. Connect AC power and re-run (or pass -AllowOnBattery).' 11
    } elseif ($onBattery) { Write-Log 'On battery, continuing (-AllowOnBattery).' 'WARN' }
    else { Write-Log 'Laptop is on AC power.' 'OK' }
}

# --- 7. Pending reboot ----------------------------------------------------
$pending = $false
if (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending') { $pending = $true }
if (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired') { $pending = $true }
if ((Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager' -Name PendingFileRenameOperations -EA SilentlyContinue).PendingFileRenameOperations) { $pending = $true }
if ($pending) {
    if ($BlockOnPendingReboot) { Fail 'A reboot is pending from prior updates. Restart the PC and re-run.' 12 }
    Write-Log 'A reboot is pending from prior updates - upgrade may fail. Recommend restarting first.' 'WARN'
} else { Write-Log 'No pending reboot detected.' 'OK' }

# --- 8. Compatibility bypass (Windows-To-Go / portable flag) --------------
try {
    $priorPos = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control' -Name PortableOperatingSystem -EA SilentlyContinue).PortableOperatingSystem
    Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control' -Name PortableOperatingSystem -Value 0 -Type DWord
    Write-Log ("PortableOperatingSystem set to 0 (was: {0})." -f ($priorPos -as [string]))
} catch { Fail "Failed to set PortableOperatingSystem: $($_.Exception.Message)" 20 }

# --- 9. Stage helper scripts + config into ProgramData --------------------
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
    RebootPolicy           = $RebootPolicy
    RebootCountdownSeconds = $RebootCountdownSeconds
    ActiveHoursStart       = $ActiveHoursStart
    ActiveHoursEnd         = $ActiveHoursEnd
    WorkerTask             = $WorkerTask
    VerifyTask             = $VerifyTask
    TargetVersion          = $TargetVersion
    FromVersion            = $current
}
$config | ConvertTo-Json -Depth 4 | Set-Content -Path $ConfigFile -Encoding UTF8
Write-Log "Wrote upgrade config: $ConfigFile"

# --- 10. Register tasks ---------------------------------------------------
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
try {
    $workerAction = New-ScheduledTaskAction -Execute $psExe -Argument ('-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $WorkerScript)
    Register-ScheduledTask -TaskName $WorkerTask -InputObject (New-ScheduledTask -Action $workerAction -Principal $principal) -Force | Out-Null
    Write-Log "Registered worker task '$WorkerTask'."

    $verifyAction  = New-ScheduledTaskAction -Execute $psExe -Argument ('-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $VerifyScript)
    $verifyTrigger = New-ScheduledTaskTrigger -AtStartup
    $verifyTrigger.Delay = 'PT3M'
    Register-ScheduledTask -TaskName $VerifyTask -InputObject (New-ScheduledTask -Action $verifyAction -Trigger $verifyTrigger -Principal $principal) -Force | Out-Null
    Write-Log "Registered post-reboot verifier task '$VerifyTask'."
} catch { Fail "Failed to register scheduled task(s): $($_.Exception.Message)" 21 }

# --- 11. Notify the user, then start the worker ---------------------------
Notify-User 'Your computer is starting a Windows 11 24H2 update in the background. You can keep working - please save your files. The PC will warn you before it restarts to finish.'
Write-Log 'Notified the signed-in user that the upgrade is starting.'
Set-Status @{ Stage = 'HandedOff'; Result = 'InProgress'; FromVersion = $current }

try {
    Start-ScheduledTask -TaskName $WorkerTask
    Write-Log 'Started the upgrade worker task.'
} catch { Fail "Failed to start the upgrade worker task: $($_.Exception.Message)" 22 }

# --- 12. Confirm Setup actually launched (real poll loop) -----------------
if (-not $IsUnattended) { Write-Host ''; Write-Host 'Waiting for Windows Setup to start (up to 90 seconds)...' -ForegroundColor Cyan }
$deadline = (Get-Date).AddSeconds(90)
$setupSeen = $false
while ((Get-Date) -lt $deadline) {
    if (Get-Process -Name setup, setupprep, SetupHost -EA SilentlyContinue) { $setupSeen = $true; break }
    Start-Sleep -Seconds 3
    if (-not $IsUnattended) { Write-Host '.' -NoNewline }
}
if (-not $IsUnattended) { Write-Host '' }

if ($setupSeen) {
    Write-Log 'Windows Setup processes detected - upgrade is running.' 'OK'
    Set-Status @{ Stage = 'SetupRunning'; Result = 'InProgress' }
    if (-not $IsUnattended) {
        Write-Host ''
        Write-Host '=====================================================' -ForegroundColor Green
        Write-Host ' RESULT: UPGRADE STARTED' -ForegroundColor Green
        Write-Host '=====================================================' -ForegroundColor Green
        Write-Host ' - Setup is running silently as SYSTEM.' -ForegroundColor Green
        if ($RebootPolicy -eq 'afterhours') {
            Write-Host " - The PC will restart to finish AFTER active hours (after $ActiveHoursEnd:00)." -ForegroundColor Green
        } else {
            Write-Host " - The user was warned; the PC restarts on a ~$([math]::Round($RebootCountdownSeconds/60))-min countdown to finish." -ForegroundColor Green
        }
        Write-Host ' - You may disconnect. Total time ~30-45 minutes.' -ForegroundColor Green
        Write-Host ''
        Write-Host ' Verify anytime:  tasklist | findstr /i "setup setuphost setupprep"' -ForegroundColor Gray
        Write-Host " Log file:        $LogFile" -ForegroundColor Gray
        Write-Host ''
    }
    exit 0
} else {
    Write-Log 'Setup processes not visible after 90s. It may still be initializing (copying media).' 'WARN'
    Set-Status @{ Stage = 'SetupNotConfirmed'; Result = 'InProgress'; ExitCode = 23 }
    if (-not $IsUnattended) {
        Write-Host ''
        Write-Host 'RESULT: NOT CONFIRMED YET' -ForegroundColor Yellow
        Write-Host 'Wait a minute, then run: tasklist | findstr /i "setup setuphost setupprep"' -ForegroundColor Yellow
    }
    exit 23
}
