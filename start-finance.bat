@echo off
setlocal
cd /d "%~dp0"

rem Start the current working tree with private preview data isolated from the installed app.
set "FINANCE_DATA_DIR=%~dp0.test-data\workdir-preview\data"
set "FINANCE_SYNC_DIR=%~dp0.test-data\workdir-preview\mobile-sync"
set "PORT=4174"

rem Open the browser only after this exact workspace instance answers on the preview port.
start "" /b node scripts/open-workdir-preview.mjs
call npm start
set "finance_exit=%errorlevel%"
endlocal & exit /b %finance_exit%
