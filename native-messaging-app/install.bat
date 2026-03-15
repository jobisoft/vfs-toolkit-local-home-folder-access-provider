@echo off
:: Install the expose_home_folder_host native messaging host for Thunderbird on Windows.
:: Run once after extracting; re-run if you move the folder.
:: Requires Python 3 to be installed and on PATH.

setlocal

set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "FS_PY=%SCRIPT_DIR%\expose_home_folder_host.py"
set "WRAPPER=%SCRIPT_DIR%\expose_home_folder_host_runner.bat"
set "MANIFEST_SRC=%SCRIPT_DIR%\expose_home_folder_host.json"
set "MANIFEST_DEST=%APPDATA%\Mozilla\NativeMessagingHosts\expose_home_folder_host.json"
set "REG_KEY=HKCU\SOFTWARE\Mozilla\NativeMessagingHosts\expose_home_folder_host"

:: Create a .bat wrapper so Thunderbird can launch the Python script as an executable
(
  echo @echo off
  echo python "%FS_PY%" %%*
) > "%WRAPPER%"

:: Write manifest to AppData with the wrapper path substituted in
if not exist "%APPDATA%\Mozilla\NativeMessagingHosts" mkdir "%APPDATA%\Mozilla\NativeMessagingHosts"
powershell -NoProfile -Command ^
  "(Get-Content '%MANIFEST_SRC%') -replace '/path/to/native-messaging-app/expose_home_folder_host.py', ('%WRAPPER%' -replace '\\', '\\\\') | Set-Content '%MANIFEST_DEST%'"

:: Register the manifest path in the Windows registry
reg add "%REG_KEY%" /ve /t REG_SZ /d "%MANIFEST_DEST%" /f >nul

echo Installed native messaging manifest to: %MANIFEST_DEST%
echo Native app wrapper:                     %WRAPPER%
echo Registry key set:                       %REG_KEY%
echo.
echo Restart Thunderbird to apply the changes.

endlocal
