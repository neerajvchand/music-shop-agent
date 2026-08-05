@echo off
setlocal EnableExtensions
:: ===========================================================================
::  Windows 11 24H2 Upgrade Launcher  -  single self-contained file
:: ---------------------------------------------------------------------------
::  The ISS runs this file as Administrator from the extracted media folder
::  (the folder that holds setup.exe and \sources). It:
::    1. Validates admin rights, media, and current version.
::    2. Applies the PortableOperatingSystem compatibility fix.
::    3. Creates a Scheduled Task that runs THIS SAME FILE as SYSTEM
::       (the "RUNSETUP" worker) - proven more reliable than direct launch.
::    4. Confirms Windows Setup started, then the ISS can disconnect.
::  The SYSTEM worker runs Setup with /noreboot, waits for it to finish, then
::  notifies the user and performs a TIMED, warned restart to complete the
::  upgrade - so the user is never rebooted without warning.
::
::  No other files are required.  Logs: C:\ProgramData\Win11_24H2_Logs
:: ===========================================================================

set "TASK_NAME=Win11_24H2"
set "LOG_DIR=C:\ProgramData\Win11_24H2_Logs"
set "LOG_FILE=%LOG_DIR%\RunUpgrade.log"
:: Seconds of on-screen warning before the restart (300 = 5 minutes).
set "REBOOT_DELAY=300"
:: Windows Setup switches. NOTE: /dynamicupdate enable pulls Microsoft's
:: compatibility/SafeOS fixes during the upgrade and reduces rollbacks; change
:: to "disable" only for offline machines.
set "SETUP_SWITCHES=/auto upgrade /quiet /eula accept /compat ignorewarning /showoobe none /noreboot /copylogs "%LOG_DIR%\Panther" /dynamicupdate enable"

for %%I in ("%~dp0.") do set "MEDIA_DIR=%%~fI"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>&1

:: If launched by the Scheduled Task as SYSTEM, run the worker section.
if /i "%~1"=="RUNSETUP" goto :RUNSETUP

:: ==========================================================================
::  MAIN  -  runs in the ISS's session
:: ==========================================================================

:: --- Self-elevate so a double-click works (relaunch via UAC if needed) -----
net session >nul 2>&1
if errorlevel 1 (
    echo Requesting Administrator privileges...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b 0
)

echo.>>"%LOG_FILE%"
echo ==================================================>>"%LOG_FILE%"
echo [%DATE% %TIME%] Launcher started on %COMPUTERNAME%>>"%LOG_FILE%"
echo Media folder: %MEDIA_DIR%>>"%LOG_FILE%"

echo ==========================================
echo  Windows 11 24H2 Upgrade Launcher
echo ==========================================
echo.

:: --- Already on 24H2? -----------------------------------------------------
for /f "tokens=3" %%A in ('reg query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion" /v DisplayVersion 2^>nul') do set "CURRENT_VERSION=%%A"
if /i "%CURRENT_VERSION%"=="24H2" (
    echo This computer is already running Windows 11 24H2.
    echo [%DATE% %TIME%] EXIT: Already on 24H2.>>"%LOG_FILE%"
    pause
    exit /b 0
)

:: --- Media present --------------------------------------------------------
if not exist "%MEDIA_DIR%\setup.exe" (
    echo ERROR: setup.exe was not found in:
    echo %MEDIA_DIR%
    echo [%DATE% %TIME%] ERROR: setup.exe not found.>>"%LOG_FILE%"
    pause
    exit /b 2
)
if not exist "%MEDIA_DIR%\sources" (
    echo ERROR: The sources folder was not found in:
    echo %MEDIA_DIR%
    echo [%DATE% %TIME%] ERROR: sources folder not found.>>"%LOG_FILE%"
    pause
    exit /b 3
)

:: --- Setup already running? ----------------------------------------------
tasklist | findstr /i "setup.exe setupprep.exe SetupHost.exe" >nul
if not errorlevel 1 (
    echo ERROR: Windows Setup is already running.
    echo [%DATE% %TIME%] ERROR: Existing Windows Setup process detected.>>"%LOG_FILE%"
    pause
    exit /b 4
)

echo Current Windows version: %CURRENT_VERSION%
echo Applying compatibility fix (PortableOperatingSystem=0)...
reg add "HKLM\SYSTEM\CurrentControlSet\Control" /v PortableOperatingSystem /t REG_DWORD /d 0 /f >nul
if errorlevel 1 (
    echo ERROR: The registry change failed.
    echo [%DATE% %TIME%] ERROR: PortableOperatingSystem update failed.>>"%LOG_FILE%"
    pause
    exit /b 10
)
echo [%DATE% %TIME%] PortableOperatingSystem set to 0.>>"%LOG_FILE%"

:: --- Tell the user the upgrade is starting --------------------------------
msg * /time:120 "Your computer is starting a Windows 11 24H2 update in the background. You can keep working - please save your files. The PC will warn you before it restarts to finish." 2>nul

:: --- Create + start the SYSTEM worker task --------------------------------
echo Removing any previous scheduled task...
schtasks /Delete /TN "%TASK_NAME%" /F >nul 2>&1

echo Creating scheduled task (runs Setup as SYSTEM)...
schtasks /Create /TN "%TASK_NAME%" /RU SYSTEM /RL HIGHEST /SC ONCE /ST 23:59 /TR "\"%~f0\" RUNSETUP" /F >nul
if errorlevel 1 (
    echo ERROR: The scheduled task could not be created.
    echo [%DATE% %TIME%] ERROR: Scheduled task creation failed.>>"%LOG_FILE%"
    pause
    exit /b 20
)

echo Starting the upgrade...
schtasks /Run /TN "%TASK_NAME%" >nul
if errorlevel 1 (
    echo ERROR: The scheduled task could not be started.
    echo [%DATE% %TIME%] ERROR: Scheduled task launch failed.>>"%LOG_FILE%"
    pause
    exit /b 21
)

:: --- Confirm Setup actually started (poll up to 90 seconds) ---------------
echo Waiting for Windows Setup to start...
set /a WAIT_MAIN=0
:MAIN_WAIT
timeout /t 5 /nobreak >nul
tasklist | findstr /i "setup.exe setupprep.exe SetupHost.exe" >nul
if not errorlevel 1 goto MAIN_STARTED
set /a WAIT_MAIN+=5
if %WAIT_MAIN% LSS 90 goto MAIN_WAIT

echo.
echo WARNING: Windows Setup is not visible yet. It may still be initializing.
echo Wait a minute, then run:
echo    tasklist ^| findstr /i "setup setuphost setupprep"
echo [%DATE% %TIME%] WARNING: Setup not detected after launch.>>"%LOG_FILE%"
echo.
echo Log file: %LOG_FILE%
pause
exit /b 23

:MAIN_STARTED
echo [%DATE% %TIME%] SUCCESS: Windows Setup started.>>"%LOG_FILE%"
echo.
echo =====================================================
echo  UPGRADE STARTED
echo =====================================================
echo  - Setup is running silently as SYSTEM.
echo  - The user was told to save their work.
echo  - When Setup finishes preparing, the user gets a notification
echo    and the PC restarts on a timed %REBOOT_DELAY%-second warning to complete.
echo  - You may disconnect. Total time is about 30-45 minutes.
echo.
echo  Check progress:  tasklist ^| findstr /i "setup setuphost setupprep"
echo  Log file:        %LOG_FILE%
echo.
pause
exit /b 0

:: ==========================================================================
::  RUNSETUP  -  worker, launched by the Scheduled Task as SYSTEM
:: ==========================================================================
:RUNSETUP
echo [%DATE% %TIME%] Worker started (SYSTEM). Launching Windows Setup.>>"%LOG_FILE%"

:: Launch Setup (non-blocking); we watch the processes to know when it's done.
start "" "%MEDIA_DIR%\setup.exe" %SETUP_SWITCHES%

:: Phase A - wait up to 5 minutes for Setup to appear.
set /a WA=0
:WORKER_APPEAR
ping -n 16 127.0.0.1 >nul
tasklist | findstr /i "setup.exe setupprep.exe SetupHost.exe" >nul
if not errorlevel 1 goto WORKER_RUNNING
set /a WA+=15
if %WA% LSS 300 goto WORKER_APPEAR
echo [%DATE% %TIME%] ERROR: Setup never started; no reboot performed.>>"%LOG_FILE%"
goto WORKER_END

:WORKER_RUNNING
echo [%DATE% %TIME%] Setup running; waiting for the preparation phase to complete.>>"%LOG_FILE%"

:: Phase B - wait up to 2 hours for Setup to finish the down-level phase.
set /a WB=0
:WORKER_WAIT
ping -n 31 127.0.0.1 >nul
tasklist | findstr /i "setup.exe setupprep.exe SetupHost.exe" >nul
if errorlevel 1 goto WORKER_DONE
set /a WB+=30
if %WB% LSS 7200 goto WORKER_WAIT
echo [%DATE% %TIME%] WARNING: Setup still running after 2h; no timed reboot issued.>>"%LOG_FILE%"
goto WORKER_END

:WORKER_DONE
:: Only reboot if the upgrade actually staged (guards against a failed prep).
if not exist "C:\$WINDOWS.~BT\Sources\Panther" (
    echo [%DATE% %TIME%] ERROR: Setup ended but upgrade not staged; machine left unchanged. No reboot.>>"%LOG_FILE%"
    goto WORKER_END
)

echo [%DATE% %TIME%] Down-level complete. Notifying user and scheduling timed restart.>>"%LOG_FILE%"
msg * /time:180 "Windows 11 24H2 is ready to finish installing. Your computer will restart in about 5 minutes. Please save your work now." 2>nul
shutdown /r /t %REBOOT_DELAY% /c "Windows 11 24H2 upgrade: your PC will restart to finish installing. Please save your work." >nul 2>&1
echo [%DATE% %TIME%] Timed restart scheduled (%REBOOT_DELAY%s). Upgrade will complete after reboot.>>"%LOG_FILE%"

:WORKER_END
:: Clean up the one-shot task (does not cancel the scheduled restart).
schtasks /Delete /TN "%TASK_NAME%" /F >nul 2>&1
exit /b 0
