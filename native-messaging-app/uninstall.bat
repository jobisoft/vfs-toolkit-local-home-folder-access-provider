@echo off
:: Uninstall the expose_home_folder_host native messaging host for Thunderbird on Windows.

setlocal

set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "WRAPPER=%SCRIPT_DIR%\expose_home_folder_host_runner.bat"
set "MANIFEST_DEST=%APPDATA%\Mozilla\NativeMessagingHosts\expose_home_folder_host.json"
set "REG_KEY=HKCU\SOFTWARE\Mozilla\NativeMessagingHosts\expose_home_folder_host"

reg delete "%REG_KEY%" /f >nul 2>&1
if %errorlevel% equ 0 (
  echo Removed registry key: %REG_KEY%
) else (
  echo Registry key not found: %REG_KEY%
)

if exist "%MANIFEST_DEST%" (
  del "%MANIFEST_DEST%"
  echo Removed: %MANIFEST_DEST%
) else (
  echo Not installed (not found): %MANIFEST_DEST%
)

if exist "%WRAPPER%" (
  del "%WRAPPER%"
  echo Removed wrapper: %WRAPPER%
)

endlocal
