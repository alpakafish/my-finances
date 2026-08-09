const express = require('express');
const path = require('path');

require('./db'); // инициализирует БД и сиды категорий при первом запуске

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Мои финансы запущены: http://localhost:${PORT}`);
});
