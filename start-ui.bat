@echo off
rem AgentYard: the same interface in your default browser, no Electron needed.
chcp 65001 >nul
cd /d "%~dp0"
node --experimental-strip-types --no-warnings "%~dp0src\cli.ts" ui
pause
