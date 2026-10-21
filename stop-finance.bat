@echo off
setlocal
cd /d "%~dp0"

rem Match the isolated workspace preview started by start-finance.bat.
set "FINANCE_DATA_DIR=%~dp0.test-data\workdir-preview\data"
set "FINANCE_SYNC_DIR=%~dp0.test-data\workdir-preview\mobile-sync"
set "PORT=4174"

node scripts/stop-server.mjs
set "finance_exit=%errorlevel%"
if not "%finance_exit%"=="0" pause
endlocal & exit /b %finance_exit%
