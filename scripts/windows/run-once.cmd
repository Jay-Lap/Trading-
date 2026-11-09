@echo off
rem Runs the bot ONE time (one decision) and exits. Called by Windows Task Scheduler.
cd /d "%~dp0\..\.."
if not exist data mkdir data
echo ===== %date% %time% =====>> data\scheduled-run.log
node src\chief.js --once >> data\scheduled-run.log 2>&1
