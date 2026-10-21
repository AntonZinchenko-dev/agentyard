@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo AgentYard run on real Ollama models (demo project).
echo.
call ay.bat hw
echo.
if not exist agentyard-demo call ay.bat demo agentyard-demo
call ay.bat run --repo agentyard-demo --goal fix-tests
echo.
pause
