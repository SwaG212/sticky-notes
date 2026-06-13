@echo off
cd /d "%~dp0"
start "" "%cd%\node_modules\electron\dist\electron.exe" .
