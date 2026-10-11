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
node arena\server.mjs %*
if errorlevel 1 pause
