@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js не найден на этом компьютере.
  echo Установите его с https://nodejs.org/ (кнопка LTS^), затем запустите этот файл ещё раз.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Устанавливаю зависимости - это нужно только один раз...
  call npm install
  if errorlevel 1 (
    echo.
    echo Не получилось установить зависимости - смотрите ошибку выше.
    echo.
    pause
    exit /b 1
  )
)

start "" http://localhost:3000
call npm start

echo.
echo Сервер остановлен.
pause
