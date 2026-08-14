const express = require('express');
const path = require('path');

const db = require('./db'); // инициализирует БД и сиды категорий при первом запуске
const { startBackupSchedule } = require('./backup');

startBackupSchedule(); // раз при старте + перепроверка раз в 6 часов, см. backup.js

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/categories', require('./routes/categories'));
app.use('/api/transactions', require('./routes/transactions'));
app.use('/api/summary', require('./routes/summary'));
app.use('/api/export', require('./routes/export'));
app.use('/api/import', require('./routes/import'));
app.use('/api/goals', require('./routes/goals'));
app.use('/api/limits', require('./routes/limits'));
app.use('/api/recurring', require('./routes/recurring'));
app.use('/api/settings', require('./routes/settings'));

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
  // Desktop-обёртка слушает это сообщение, чтобы узнать реальный порт и открыть
  // окно. Обычный `child_process.fork()` даёт process.send(); Electron же
  // форкует через utilityProcess.fork(), у которого своя IPC-обвязка —
  // process.parentPort вместо process.send (см. Electron docs: utility-process).
  // При запуске `node server.js` (веб-версия) обоих нет — это no-op.
  if (process.send) process.send({ type: 'server-ready', port: actualPort });
  else if (process.parentPort) process.parentPort.postMessage({ type: 'server-ready', port: actualPort });
});

function shutdown() {
  server.close(() => {
    try { db.close(); } catch (_) { /* уже закрыта */ }
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
