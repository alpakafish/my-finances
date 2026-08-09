#!/bin/bash
cd "$(dirname "$0")"
if [ ! -d node_modules ]; then
  echo "Устанавливаю зависимости (это нужно только один раз)..."
  npm install
fi
(sleep 1 && open http://localhost:3000) &
npm start
