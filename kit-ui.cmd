@echo off
rem Double-click: start the hub (if needed) and open the control panel in the browser.
where node >nul 2>nul || (echo Node.js is not installed: https://nodejs.org & pause & exit /b 1)
node "%~dp0bin\kit.mjs" ui || pause
