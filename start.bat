@echo off
cd /d "%~dp0"
start http://localhost:3456
node server.js
