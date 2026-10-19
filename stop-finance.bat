@echo off
cd /d "%~dp0"
node scripts/stop-server.mjs
set "finance_exit=%errorlevel%"
if not "%finance_exit%"=="0" pause
exit /b %finance_exit%
