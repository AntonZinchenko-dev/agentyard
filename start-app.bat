@echo off
rem AgentYard: desktop window (Electron). First start installs Electron via npm, about 100 MB.
chcp 65001 >nul
cd /d "%~dp0"
if exist "node_modules\electron\dist\electron.exe" goto run
echo Installing Electron, one time only...
call npm install --no-audit --no-fund
if errorlevel 1 goto fail
:run
call npx electron .
exit /b 0
:fail
echo.
echo npm install failed. The same interface works in a browser: run start-ui.bat
pause
exit /b 1
