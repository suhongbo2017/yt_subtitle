@echo off
setlocal
cd /d "%~dp0"

set "PYW=%~dp0.venv\Scripts\pythonw.exe"
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\YouTubeSubtitleASR.lnk"

if not exist "%PYW%" (
  echo [ERROR] pythonw.exe not found. Create the venv first.
  if /i not "%~1"=="--quiet" pause
  exit /b 1
)

powershell -NoProfile -Command ^
  "$s = (New-Object -ComObject WScript.Shell).CreateShortcut('%LNK%');" ^
  "$s.TargetPath = '%PYW%';" ^
  "$s.Arguments = '-m asrsvc.server --port 8770';" ^
  "$s.WorkingDirectory = '%~dp0';" ^
  "$s.WindowStyle = 7;" ^
  "$s.Description = 'YouTube subtitle ASR service';" ^
  "$s.Save()"

if errorlevel 1 (
  echo [ERROR] failed to create shortcut
  if /i not "%~1"=="--quiet" pause
  exit /b 1
)

echo Autostart installed:
echo   %LNK%
echo.
echo Starting it now in background (no window)...
start "" "%PYW%" -m asrsvc.server --port 8770
ping -n 7 127.0.0.1 >nul
powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 4 http://127.0.0.1:8770/health).Content } catch { 'not responding yet (first model load may take ~30s)' }"
echo.
echo Done. From now on the service starts automatically at login.
if /i not "%~1"=="--quiet" pause
