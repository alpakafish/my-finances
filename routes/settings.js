const express = require('express');
const db = require('../db');

const router = express.Router();

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

module.exports = router;
