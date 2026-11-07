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

echo Starting document translator UI: http://127.0.0.1:8765/
start "" http://127.0.0.1:8765/
"%PY%" -m pdftranslate.server %*
pause
