@echo off
setlocal
cd /d "%~dp0"
title Terminal Android Builder
echo.
echo  TERMINAL - Android build helper
echo  --------------------------------
where node >nul 2>nul || (echo Install Node.js 20 or newer first. & pause & exit /b 1)
where npm >nul 2>nul || (echo npm was not found. Install Node.js first. & pause & exit /b 1)
where python >nul 2>nul || (echo Install Python 3.10 or newer and add it to PATH. & pause & exit /b 1)
if not exist "node_modules\@capacitor\cli" (
  echo Installing app dependencies...
  call npm ci
  if errorlevel 1 (echo Dependency installation failed. & pause & exit /b 1)
)
echo Building Terminal web bundle...
call npm run build
if errorlevel 1 (echo Web build failed. & pause & exit /b 1)
if not exist "android\app\src\main\AndroidManifest.xml" (
  echo Creating Android project...
  call npx cap add android
  if errorlevel 1 (echo Android project creation failed. & pause & exit /b 1)
)
python scripts\configure_native.py android
if errorlevel 1 (echo Could not configure Android permissions. & pause & exit /b 1)
call npx cap sync android
if errorlevel 1 (echo Capacitor sync failed. & pause & exit /b 1)
echo.
echo Android project is ready. Android Studio and its SDK are required to make an APK.
set /p BUILD=Build a debug APK now using Gradle? [y/N]:
if /I "%BUILD%"=="Y" (
  pushd android
  call gradlew.bat assembleDebug
  if errorlevel 1 (popd & echo APK build failed. Check Android Studio, SDK, and Java setup. & pause & exit /b 1)
  popd
  echo APK created: android\app\build\outputs\apk\debug\app-debug.apk
)
set /p OPEN=Open the project in Android Studio? [y/N]:
if /I "%OPEN%"=="Y" call npx cap open android
echo Finished. Read README.md for server setup.
pause
