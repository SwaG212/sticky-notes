@echo off
taskkill /f /im "Sticky Notes.exe" >nul 2>&1
taskkill /f /im electron.exe >nul 2>&1
timeout /t 1 /nobreak >nul
cd /d "%~dp0"
start "" cmd /c "启动便利贴.bat"
