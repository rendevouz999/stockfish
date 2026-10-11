@echo off
setlocal DisableDelayedExpansion
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install a supported Node.js LTS release first.
  echo https://nodejs.org/en/download
  pause
  exit /b 1
)
set "QUIET_CHESS_BRAVE_ROOT="
if exist "F:\Brave-Isolated\App\brave.exe" set "QUIET_CHESS_BRAVE_ROOT=F:\Brave-Isolated"
if not defined QUIET_CHESS_BRAVE_ROOT set /p "QUIET_CHESS_BRAVE_ROOT=Existing portable Brave folder containing App\brave.exe, without quotes: "
if not defined QUIET_CHESS_BRAVE_ROOT (
  echo No folder supplied. Nothing was started.
  pause
  exit /b 1
)
node arena\server.mjs --open --browser brave
if errorlevel 1 pause
