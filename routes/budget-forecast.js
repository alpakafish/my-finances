const express = require('express');
const db = require('../db');

const router = express.Router();

// Черновой прогноз бюджета на месяц ("я получу зп 100000, на еду уйдёт
// 40000... хватит ли на новую клавиатуру?") — гипотетические цифры,
// намеренно не пишутся в transactions и не участвуют ни в одном отчёте.
// Один черновик на период (period = "YYYY-MM"), см. схему в db.js.

function isValidPeriod(period) {
  return typeof period === 'string' && /^\d{4}-\d{2}$/.test(period);
}

function getDraft(period) {
  const draft = db.prepare('SELECT * FROM budget_drafts WHERE period = ?').get(period);
  const items = db.prepare(`
    SELECT i.category_id, i.amount, c.name AS category_name, c.color AS category_color
    FROM budget_draft_items i JOIN categories c ON c.id = i.category_id
    WHERE i.period = ?
    ORDER BY c.sort_order, c.name
  `).all(period);
  return {
    period,
    income: draft ? draft.income : 0,
    one_off_name: draft ? draft.one_off_name : '',
    one_off_amount: draft ? draft.one_off_amount : 0,
    items,
  };
}

router.get('/:period', (req, res) => {
  if (!isValidPeriod(req.params.period)) {
    return res.status(400).json({ error: 'Некорректный месяц' });
  }
  res.json(getDraft(req.params.period));
});

router.put('/:period', (req, res) => {
  const { period } = req.params;
  if (!isValidPeriod(period)) {
    return res.status(400).json({ error: 'Некорректный месяц' });
  }

  const { income, one_off_name, one_off_amount, items } = req.body;
  if (!(Number(income) >= 0)) {
    return res.status(400).json({ error: 'Планируемый доход должен быть числом от 0' });
  }
  const oneOffAmount = one_off_amount === undefined || one_off_amount === null || one_off_amount === ''
    ? 0 : Number(one_off_amount);
  if (!(oneOffAmount >= 0)) {
    return res.status(400).json({ error: 'Сумма разовой покупки должна быть числом от 0' });
  }
  if (!Array.isArray(items)) {
    return res.status(400).json({ error: 'Список категорий передан некорректно' });
  }

  const seen = new Set();
  for (const item of items) {
    if (!Number.isInteger(item.category_id)) {
      return res.status(400).json({ error: 'Некорректная категория в списке' });
    }
    if (!(Number(item.amount) >= 0)) {
      return res.status(400).json({ error: 'Сумма по категории должна быть числом от 0' });
    }
    if (seen.has(item.category_id)) {
      return res.status(400).json({ error: 'Одна категория указана в прогнозе дважды' });
    }
    seen.add(item.category_id);
  }
  const categoryCheck = db.prepare("SELECT id FROM categories WHERE id = ? AND type = 'expense'");
  for (const item of items) {
    if (!categoryCheck.get(item.category_id)) {
      return res.status(400).json({ error: 'Категория не найдена среди категорий расходов' });
    }
  }

  const save = db.transaction(() => {
    db.prepare(`
      INSERT INTO budget_drafts (period, income, one_off_name, one_off_amount, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(period) DO UPDATE SET
        income = excluded.income,
        one_off_name = excluded.one_off_name,
        one_off_amount = excluded.one_off_amount,
        updated_at = excluded.updated_at
    `).run(period, Number(income), (one_off_name || '').trim(), oneOffAmount);
    db.prepare('DELETE FROM budget_draft_items WHERE period = ?').run(period);
    const insertItem = db.prepare('INSERT INTO budget_draft_items (period, category_id, amount) VALUES (?, ?, ?)');
    items.forEach((item) => insertItem.run(period, item.category_id, Number(item.amount)));
  });
  save();

  res.json(getDraft(period));
});

router.delete('/:period', (req, res) => {
  if (!isValidPeriod(req.params.period)) {
    return res.status(400).json({ error: 'Некорректный месяц' });
  }
  db.prepare('DELETE FROM budget_drafts WHERE period = ?').run(req.params.period);
  res.status(204).end();
});

module.exports = router;
