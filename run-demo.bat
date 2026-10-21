@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo AgentYard demo run: scripted model, Ollama is not needed.
echo.
if not exist agentyard-demo call ay.bat demo agentyard-demo
call ay.bat run --repo agentyard-demo --goal fix-tests --mock --yes
echo.
pause
