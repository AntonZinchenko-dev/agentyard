@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo AgentYard: shop demo, goal in plain words (plan by model, test first, then code).
echo.
if not exist agentyard-shop call ay.bat demo-shop agentyard-shop
call ay.bat run --repo agentyard-shop --goal shop-demo
echo.
pause
