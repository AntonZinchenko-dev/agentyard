@echo off
rem AgentYard: drunk test - sloppy requests on demo projects, graded by the program. Needs Ollama.
chcp 65001 >nul
cd /d "%~dp0"
node --experimental-strip-types --no-warnings "%~dp0src\cli.ts" eval %*
pause
