@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Устанавливаю зависимости (это нужно только один раз)...
  call npm install
)
start "" http://localhost:3000
call npm start
