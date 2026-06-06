@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "PS_SCRIPT=%SCRIPT_DIR%scripts\Invoke-ObsidianWebClipper.ps1"

if not exist "%PS_SCRIPT%" (
  echo PowerShell script not found:
  echo %PS_SCRIPT%
  exit /b 1
)

if "%~1"=="" (
  if exist "%SCRIPT_DIR%video-links.txt" (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%" -InputFile "%SCRIPT_DIR%video-links.txt"
  ) else (
    echo Usage:
    echo   %~nx0 video-links.txt
    echo   %~nx0 https://www.youtube.com/watch?v=VIDEO_ID https://www.youtube.com/watch?v=VIDEO_ID2
    echo.
    echo Tip: create video-links.txt next to this .bat to run it with no arguments.
    exit /b 1
  )
) else (
  if exist "%~1" (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%" -InputFile "%~1"
  ) else (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%" -Urls %*
  )
)

exit /b %ERRORLEVEL%
