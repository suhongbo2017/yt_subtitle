@echo off
setlocal
cd /d "%~dp0"
".venv\Scripts\python.exe" native\install.py --uninstall
if /i not "%~1"=="--quiet" pause
