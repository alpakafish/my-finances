#!/bin/bash
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "Node.js не найден на этом компьютере."
  echo "Установите его с https://nodejs.org/ (кнопка LTS) или командой: brew install node"
  echo "Затем запустите этот файл ещё раз."
  echo ""
  read -p "Нажмите Enter, чтобы закрыть окно..."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Устанавливаю зависимости (это нужно только один раз)..."
  if ! npm install; then
    echo ""
    echo "Не получилось установить зависимости — смотрите ошибку выше."
    read -p "Нажмите Enter, чтобы закрыть окно..."
    exit 1
  fi
fi

(sleep 1 && open http://localhost:3000) &
npm start

echo ""
echo "Сервер остановлен."
read -p "Нажмите Enter, чтобы закрыть окно..."
