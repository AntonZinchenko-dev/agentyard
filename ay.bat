@echo off
if "%~1"=="" goto console
node --experimental-strip-types --no-warnings "%~dp0src\cli.ts" %*
exit /b %errorlevel%

:console
chcp 65001 >nul
cd /d "%~dp0"
node --experimental-strip-types --no-warnings "%~dp0src\cli.ts"
echo.
echo Type commands here, for example: ay hw   ay models   ay run --repo agentyard-demo --goal fix-tests
cmd /k
