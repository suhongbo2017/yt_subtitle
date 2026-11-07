@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo [ERROR] .venv not found
  if /i not "%~1"=="--quiet" pause
  exit /b 1
)
".venv\Scripts\python.exe" native\install.py %*
if /i not "%~1"=="--quiet" pause
