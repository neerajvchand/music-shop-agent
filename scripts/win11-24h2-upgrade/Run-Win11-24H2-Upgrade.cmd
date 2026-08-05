@echo off
setlocal EnableExtensions

rem When the scheduled task re-launches us as SYSTEM, jump straight to the
rem upgrade branch that runs Setup, waits for it, then warns and reboots.
if /i "%~1"=="/runupgrade" goto :runupgrade

set "TASK_NAME=Win11_24H2"
set "LOG_DIR=C:\ProgramData\Win11_24H2_Logs"
set "LOG_FILE=%LOG_DIR%\RunUpgrade.log"
for %%I in ("%~dp0.") do set "MEDIA_DIR=%%~fI"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>&1

echo.>>"%LOG_FILE%"
echo ==================================================>>"%LOG_FILE%"
echo [%DATE% %TIME%] Upgrade launcher started on %COMPUTERNAME%>>"%LOG_FILE%"
echo Media folder: %MEDIA_DIR%>>"%LOG_FILE%"

echo ==========================================
echo Windows 11 24H2 Upgrade Launcher
echo ==========================================
echo.

net session >nul 2>&1
if errorlevel 1 (
    echo ERROR: Run this file as Administrator.
    echo [%DATE% %TIME%] ERROR: Administrator rights required.>>"%LOG_FILE%"
    pause
    exit /b 1
)

for /f "tokens=3" %%A in ('reg query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion" /v DisplayVersion 2^>nul') do set "CURRENT_VERSION=%%A"

if /i "%CURRENT_VERSION%"=="24H2" (
    echo This computer is already running Windows 11 24H2.
    echo [%DATE% %TIME%] EXIT: Computer is already on 24H2.>>"%LOG_FILE%"
    pause
    exit /b 0
)

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

tasklist | findstr /i "setup.exe setupprep.exe SetupHost.exe" >nul
if not errorlevel 1 (
    echo ERROR: Windows Setup is already running.
    echo [%DATE% %TIME%] ERROR: Existing Windows Setup process detected.>>"%LOG_FILE%"
    pause
    exit /b 4
)

echo Current Windows version: %CURRENT_VERSION%
echo Setting PortableOperatingSystem to 0...

reg add "HKLM\SYSTEM\CurrentControlSet\Control" /v PortableOperatingSystem /t REG_DWORD /d 0 /f >nul
if errorlevel 1 (
    echo ERROR: The registry change failed.
    echo [%DATE% %TIME%] ERROR: PortableOperatingSystem registry update failed.>>"%LOG_FILE%"
    pause
    exit /b 10
)

echo [%DATE% %TIME%] PortableOperatingSystem set to 0.>>"%LOG_FILE%"

echo Removing any previous scheduled task...
schtasks /Delete /TN "%TASK_NAME%" /F >nul 2>&1

echo Creating scheduled task...
schtasks /Create ^
 /TN "%TASK_NAME%" ^
 /RU SYSTEM ^
 /RL HIGHEST ^
 /SC ONCE ^
 /ST 23:59 ^
 /TR "cmd /c \"\"%~f0\" /runupgrade\"" ^
 /F >nul

if errorlevel 1 (
    echo ERROR: The scheduled task could not be created.
    echo [%DATE% %TIME%] ERROR: Scheduled task creation failed.>>"%LOG_FILE%"
    pause
    exit /b 20
)

echo Starting scheduled task...
schtasks /Run /TN "%TASK_NAME%" >nul

if errorlevel 1 (
    echo ERROR: The scheduled task could not be started.
    echo [%DATE% %TIME%] ERROR: Scheduled task launch failed.>>"%LOG_FILE%"
    pause
    exit /b 21
)

timeout /t 8 /nobreak >nul

echo Checking whether Windows Setup started...
tasklist | findstr /i "setup.exe setupprep.exe SetupHost.exe" >nul

if errorlevel 1 (
    echo WARNING: Windows Setup processes are not visible yet.
    echo Wait one minute and run:
    echo tasklist ^| findstr /i "setup setuphost setupprep"
    echo [%DATE% %TIME%] WARNING: Setup processes not detected after launch.>>"%LOG_FILE%"
) else (
    echo Windows Setup is running.
    echo [%DATE% %TIME%] SUCCESS: Windows Setup processes detected.>>"%LOG_FILE%"
)

schtasks /Change /TN "%TASK_NAME%" /DISABLE >nul 2>&1

echo.
echo Upgrade handed off to Task Scheduler.
echo Setup is running silently as SYSTEM.
echo When Setup finishes, users get a 5-minute reboot warning before restart.
echo The technician may disconnect after confirming Setup is running.
echo.
echo Check progress with:
echo tasklist ^| findstr /i "setup setuphost setupprep"
echo.
echo Log file:
echo %LOG_FILE%
echo.
pause
exit /b 0

rem ==================================================================
rem  /runupgrade branch - runs as SYSTEM via the scheduled task.
rem  Setup is launched with /noreboot so WE own the restart. That lets
rem  us give users a visible 5-minute countdown instead of the silent,
rem  instant reboot /quiet would otherwise do (which Qualys can flag as
rem  intrusive). We reboot only after Setup has fully finished.
rem ==================================================================
:runupgrade
set "LOG_DIR=C:\ProgramData\Win11_24H2_Logs"
set "LOG_FILE=%LOG_DIR%\RunUpgrade.log"
for %%I in ("%~dp0.") do set "MEDIA_DIR=%%~fI"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>&1

echo [%DATE% %TIME%] Setup starting as SYSTEM with /noreboot.>>"%LOG_FILE%"

"%MEDIA_DIR%\setup.exe" /auto upgrade /quiet /noreboot /showoobe none /eula accept /compat ignorewarning /dynamicupdate disable
set "SETUP_RC=%ERRORLEVEL%"
echo [%DATE% %TIME%] Setup returned exit code %SETUP_RC%.>>"%LOG_FILE%"

rem Do not reboot until Setup's offline phase is completely finished.
:waitsetup
tasklist | findstr /i "setup.exe setupprep.exe SetupHost.exe" >nul
if not errorlevel 1 (
    timeout /t 30 /nobreak >nul
    goto :waitsetup
)

rem Reboot only on a success result (0 = success, 3010 = success/reboot
rem required). Anything else is a failed or aborted upgrade - leave the
rem machine on the current OS so a technician can investigate.
if "%SETUP_RC%"=="0" goto :warnreboot
if "%SETUP_RC%"=="3010" goto :warnreboot

echo [%DATE% %TIME%] Setup did not report success (code %SETUP_RC%). No reboot issued.>>"%LOG_FILE%"
exit /b %SETUP_RC%

:warnreboot
echo [%DATE% %TIME%] Offline phase complete. Issuing 5-minute reboot warning.>>"%LOG_FILE%"
shutdown /r /t 300 /d p:2:4 /c "Windows 11 24H2 upgrade is ready. This PC will restart in 5 minutes to finish installing. Please save your work and close your files now."
echo [%DATE% %TIME%] Reboot scheduled in 5 minutes (planned).>>"%LOG_FILE%"
exit /b 0
