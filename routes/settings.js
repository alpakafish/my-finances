const express = require('express');
const db = require('../db');

const router = express.Router();

// Версия для веб-версии (desktop берёт свою версию через Electron app.getVersion(),
// см. desktop/src/main.js — там она читается из desktop/package.json, а не отсюда).
// package.json не входит в extraResources desktop-сборки (не нужен ей), поэтому
// require не должен падать при отсутствии файла — иначе крашится весь бэкенд ещё
// на старте, хотя этот роут для desktop и не используется.
let webVersion = 'unknown';
try { webVersion = require('../package.json').version; } catch (e) { /* нормально для desktop-сборки */ }

router.get('/version', (req, res) => {
  res.json({ version: webVersion });
});

router.delete('/all-data', (req, res) => {
  db.resetAllData();
  res.status(204).end();
});

// Флаг «онбординг уже показывали» — в БД, а не в localStorage, потому что у
// desktop-версии порт бэкенда меняется на каждом запуске (см. server.js), а
// localStorage привязан к origin http://127.0.0.1:<порт>.
router.get('/onboarding-seen', (req, res) => {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('onboarding_seen');
  res.json({ seen: row ? row.value === '1' : false });
});

router.put('/onboarding-seen', (req, res) => {
  db.prepare(`
    INSERT INTO app_settings (key, value) VALUES ('onboarding_seen', '1')
    ON CONFLICT(key) DO UPDATE SET value = '1'
  `).run();
  res.status(204).end();
});

// Валюта — только формат отображения сумм (символ, порядок), см. public/app.js
// fmt()/CURRENCIES. Никакой конвертации: старые операции не пересчитываются,
// это просто «в какой валюте вы вводите суммы». В app_settings, а не
// localStorage — по той же причине, что onboarding_seen выше. Переживает
// «Удалить все данные» (routes/settings.js DELETE /all-data не трогает
// app_settings) — это настройка приложения, а не финансовые данные.
router.get('/currency', (req, res) => {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('currency');
  res.json({ currency: row ? row.value : 'RUB' });
});

router.put('/currency', (req, res) => {
  const { currency } = req.body;
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
    return res.status(400).json({ error: 'Некорректный код валюты' });
  }
  db.prepare(`
    INSERT INTO app_settings (key, value) VALUES ('currency', ?)
    ON CONFLICT(key) DO UPDATE SET value = ?
  `).run(currency, currency);
  res.status(204).end();
});

module.exports = router;
