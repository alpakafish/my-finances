const express = require('express');
const path = require('path');

const db = require('./db'); // инициализирует БД и сиды категорий при первом запуске

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/categories', require('./routes/categories'));
app.use('/api/transactions', require('./routes/transactions'));
app.use('/api/summary', require('./routes/summary'));
app.use('/api/export', require('./routes/export'));
app.use('/api/import', require('./routes/import'));
app.use('/api/goals', require('./routes/goals'));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

// PORT=0 просит ОС выдать свободный порт — так запускает desktop-приложение,
// чтобы не конфликтовать с чужим процессом на 3000. host фиксирован на loopback:
// сервис локальный, слушать на всех интерфейсах ему незачем.
const PORT = process.env.PORT || 3000;
const HOST = '127.0.0.1';
const server = app.listen(PORT, HOST, () => {
  const actualPort = server.address().port;
  console.log(`Мои финансы запущены: http://${HOST}:${actualPort}`);
  // Desktop-обёртка (Electron utilityProcess.fork) слушает это сообщение, чтобы
  // узнать реальный порт и открыть окно. При обычном запуске через `node server.js`
  // process.send отсутствует, так что для веб-версии это no-op.
  if (process.send) process.send({ type: 'server-ready', port: actualPort });
});

function shutdown() {
  server.close(() => {
    try { db.close(); } catch (_) { /* уже закрыта */ }
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
