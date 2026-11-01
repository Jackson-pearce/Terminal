@echo off
setlocal
cd /d "%~dp0"
title Terminal Python Server (localhost:8000)
echo.
echo  TERMINAL - private chat server
echo  ------------------------------
where python >nul 2>nul || (echo Install Python 3.10 or newer and add it to PATH. & pause & exit /b 1)
if not exist "dist\index.html" (
  where npm >nul 2>nul || (echo Install Node.js 20 or newer to build the Terminal UI. & pause & exit /b 1)
  if not exist "node_modules\@capacitor\cli" (
    call npm ci
    if errorlevel 1 (echo App dependency installation failed. & pause & exit /b 1)
  )
  call npm run build
  if errorlevel 1 (echo App build failed. & pause & exit /b 1)
)
if not exist ".venv\Scripts\python.exe" (
  python -m venv .venv
  if errorlevel 1 (echo Could not create the Python environment. & pause & exit /b 1)
)
.venv\Scripts\python.exe -m pip install -r server\requirements.txt
if errorlevel 1 (echo Could not install Python requirements. & pause & exit /b 1)
echo.
echo Open http://localhost:8000 in your browser.
echo Invite code file: server\data\invite.txt
echo Keep this window open while using Terminal. Close it to lock the workspace.
echo.
.venv\Scripts\python.exe server\app.py
pause
