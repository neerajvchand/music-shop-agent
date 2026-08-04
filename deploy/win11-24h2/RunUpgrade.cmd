@echo off
setlocal EnableExtensions
:: ===========================================================================
::  Windows 11 24H2 Upgrade - one-click, self-elevating bootstrap
:: ---------------------------------------------------------------------------
::  The ISS just double-clicks this file (or runs it from any prompt).
::  It elevates itself via UAC if needed, then hands control to the
::  PowerShell orchestrator (RunUpgrade.ps1) sitting next to setup.exe.
:: ===========================================================================

:: Folder this script lives in (also the extracted media root). Keep the
:: trailing backslash off so PowerShell -MediaDir gets a clean path.
set "MEDIA_DIR=%~dp0"
if "%MEDIA_DIR:~-1%"=="\" set "MEDIA_DIR=%MEDIA_DIR:~0,-1%"

:: --- Elevate if we are not already running as Administrator ---------------
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting Administrator privileges...
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
        "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b 0
)

:: --- Elevated: run the orchestrator ---------------------------------------
powershell -NoProfile -ExecutionPolicy Bypass -File "%MEDIA_DIR%\RunUpgrade.ps1" -MediaDir "%MEDIA_DIR%"
set "RC=%errorlevel%"

echo.
echo Launcher finished with exit code %RC%.
echo This window can be closed. If the upgrade started, Windows Setup
echo continues in the background as SYSTEM and the PC will restart on its own.
echo.
pause
exit /b %RC%
