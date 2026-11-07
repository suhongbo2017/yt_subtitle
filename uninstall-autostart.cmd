@echo off
setlocal
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\YouTubeSubtitleASR.lnk"
if exist "%LNK%" (
  del "%LNK%"
  echo Autostart removed.
) else (
  echo Autostart was not installed.
)
if /i not "%~1"=="--quiet" pause
