const express = require('express');
const db = require('../db');

const router = express.Router();

// Лимиты — только для категорий расходов (для дохода понятие «лимита» не имеет
// смысла, это был бы скорее минимум, а не максимум — с обратной логикой
// уведомлений, отдельная фича, не делали).
// Намеренно НЕ учитывают rollup_id (в отличие от summary.js categoryBreakdown) —
// решение пользователя: у категории с лимитом считаются только её собственные
// прямые операции, без сумм из подшитых категорий. См. пояснение в UI (public/app.js
// initLimitsTab) — это единственное место в приложении, где суммы по категории
// намеренно НЕ следуют rollup, поэтому пояснение обязательно, не факультативно.

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function currentMonthKey() {
  return todayISO().slice(0, 7);
}
function currentYearKey() {
  return todayISO().slice(0, 4);
}

// 90–99.999...% — «приближается», 100%+ — «превышен». Ниже 90% — ничего не показываем.
function classify(pct) {
  if (pct >= 100) return 'exceeded';
  if (pct >= 90) return 'approaching';
  return null;
}

router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
  if (!category) return res.status(404).json({ error: 'Категория не найдена' });
  if (category.type !== 'expense') {
    return res.status(400).json({ error: 'Лимиты можно задавать только категориям расходов' });
  }

  const toNullableNumber = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  const monthlyLimit = toNullableNumber(req.body.monthly_limit);
  const yearlyLimit = toNullableNumber(req.body.yearly_limit);
  if ((monthlyLimit !== null && !(monthlyLimit > 0)) || (yearlyLimit !== null && !(yearlyLimit > 0))) {
    return res.status(400).json({ error: 'Лимит должен быть положительным числом или пустым (не задан)' });
  }

  db.transaction(() => {
    // Смена значения лимита обесценивает ранее закрытые по нему уведомления за
    // текущий период — ситуация реально другая, пользователь должен увидеть
    // актуальное состояние ещё раз (см. requirements: "если изменить лимит —
    // закрытие сбрасывается").
    if (monthlyLimit !== category.monthly_limit) {
      db.prepare('DELETE FROM limit_notification_dismissals WHERE category_id = ? AND limit_type = ?').run(id, 'month');
    }
    if (yearlyLimit !== category.yearly_limit) {
      db.prepare('DELETE FROM limit_notification_dismissals WHERE category_id = ? AND limit_type = ?').run(id, 'year');
    }
    db.prepare('UPDATE categories SET monthly_limit = ?, yearly_limit = ? WHERE id = ?').run(monthlyLimit, yearlyLimit, id);
  })();

  res.json(db.prepare('SELECT * FROM categories WHERE id = ?').get(id));
});

function progressRow(category, spent, limit) {
  const pct = limit > 0 ? Math.round((spent / limit) * 1000) / 10 : 0;
  return {
    category_id: category.id,
    category_name: category.name,
    category_color: category.color,
    limit,
    spent,
    pct,
    exceeded: spent > limit,
  };
}

router.get('/progress', (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : currentMonthKey();
  const categories = db.prepare(`SELECT * FROM categories WHERE type = 'expense' AND monthly_limit IS NOT NULL ORDER BY sort_order, name`).all();
  const rows = categories.map((c) => {
    const spent = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE category_id = ? AND type = 'expense' AND substr(date, 1, 7) = ?`).get(c.id, month).s;
    return progressRow(c, spent, c.monthly_limit);
  });
  res.json(rows);
});

router.get('/progress-year', (req, res) => {
  const year = /^\d{4}$/.test(req.query.year || '') ? req.query.year : currentYearKey();
  const categories = db.prepare(`SELECT * FROM categories WHERE type = 'expense' AND yearly_limit IS NOT NULL ORDER BY sort_order, name`).all();
  const rows = categories.map((c) => {
    const spent = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE category_id = ? AND type = 'expense' AND substr(date, 1, 4) = ?`).get(c.id, year).s;
    return progressRow(c, spent, c.yearly_limit);
  });
  res.json(rows);
});

// Что показать в уведомлениях справа вверху ПРЯМО СЕЙЧАС — всегда про реальный
// текущий месяц/год (см. requirements), не про месяц/год, который пользователь
// просто просматривает на Дашборде/«По годам». Уже закрытые крестиком за этот
// период — не возвращаем.
router.get('/notifications', (req, res) => {
  const month = currentMonthKey();
  const year = currentYearKey();
  const dismissed = new Set(
    db.prepare('SELECT category_id, limit_type, notification_type, period FROM limit_notification_dismissals').all()
      .map((r) => `${r.category_id}:${r.limit_type}:${r.notification_type}:${r.period}`)
  );

  const notifications = [];
  const addFrom = (categories, limitType, period, limitField) => {
    categories.forEach((c) => {
      const dateFilter = limitType === 'month' ? 'substr(date, 1, 7) = ?' : 'substr(date, 1, 4) = ?';
      const spent = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE category_id = ? AND type = 'expense' AND ${dateFilter}`).get(c.id, period).s;
      const limit = c[limitField];
      const pct = limit > 0 ? Math.round((spent / limit) * 1000) / 10 : 0;
      const kind = classify(pct);
      if (!kind) return;
      const key = `${c.id}:${limitType}:${kind}:${period}`;
      if (dismissed.has(key)) return;
      notifications.push({ category_id: c.id, category_name: c.name, limit_type: limitType, notification_type: kind, pct, period, limit, spent });
    });
  };

  addFrom(db.prepare(`SELECT * FROM categories WHERE type = 'expense' AND monthly_limit IS NOT NULL`).all(), 'month', month, 'monthly_limit');
  addFrom(db.prepare(`SELECT * FROM categories WHERE type = 'expense' AND yearly_limit IS NOT NULL`).all(), 'year', year, 'yearly_limit');

  res.json(notifications);
});

router.post('/notifications/:id/dismiss', (req, res) => {
  const categoryId = Number(req.params.id);
  const { limit_type, notification_type, period } = req.body;
  if (!['month', 'year'].includes(limit_type) || !['approaching', 'exceeded'].includes(notification_type) || !period) {
    return res.status(400).json({ error: 'Некорректные параметры уведомления' });
  }
  db.prepare(`
    INSERT INTO limit_notification_dismissals (category_id, limit_type, notification_type, period)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (category_id, limit_type, notification_type, period) DO NOTHING
  `).run(categoryId, limit_type, notification_type, period);
  res.status(204).end();
});

module.exports = router;
