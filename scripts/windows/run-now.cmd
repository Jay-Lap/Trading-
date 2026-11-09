@echo off
rem Manual one-off run with output on screen (for checking).
cd /d "%~dp0\..\.."
node src\chief.js --once
pause
