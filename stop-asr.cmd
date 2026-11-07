@echo off
setlocal
echo Stopping ASR service on port 8770 ...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8770" ^| findstr LISTENING') do (
  taskkill /pid %%p /f >nul 2>&1
  echo   killed pid %%p
)
echo Done.
ping -n 3 127.0.0.1 >nul
