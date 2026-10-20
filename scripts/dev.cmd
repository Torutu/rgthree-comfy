@echo off
rem Runs scripts\dev.ps1 without make:  scripts\dev.cmd <command> [options]
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0dev.ps1" %*
exit /b %ERRORLEVEL%
