@echo off
setlocal
cd /d "%~dp0"

set "PY=%~dp0.venv\Scripts\python.exe"
if not exist "%PY%" (
  echo [ERROR] .venv not found. Run these first:
  echo     python -m venv .venv
  echo     .venv\Scripts\python.exe -m pip install -r requirements.txt
  pause
  exit /b 1
)

echo Starting local ASR service (faster-whisper, model base, port 8770) ...
echo Keep this window open while using the extension.
echo
echo.
"%PY%" -m asrsvc.server %*
echo.
echo Service stopped.
pause
