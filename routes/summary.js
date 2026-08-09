const express = require('express');
const db = require('../db');

const router = express.Router();

// Категория с заполненным rollup_id (например, отдельная категория цели) суммируется
// на Дашборде в целевую категорию (обычно «Сбережения»), а не показывается отдельно.
function categoryBreakdown(month, type) {
  const rows = db.prepare(`
    SELECT
      COALESCE(rc.id, c.id) AS id,
      COALESCE(rc.name, c.name) AS name,
      COALESCE(rc.color, c.color) AS color,
      SUM(t.amount) AS amount
    FROM transactions t
    JOIN categories c ON c.id = t.category_id
    LEFT JOIN categories rc ON rc.id = c.rollup_id
    WHERE substr(t.date, 1, 7) = ? AND t.type = ?
    GROUP BY COALESCE(c.rollup_id, c.id)
    ORDER BY amount DESC
  `).all(month, type);
  const total = rows.reduce((s, r) => s + r.amount, 0);
  return rows.map((r) => ({ ...r, pct: total ? Math.round((r.amount / total) * 1000) / 10 : 0 }));
}

router.get('/overview', (req, res) => {
  const months = Math.min(Math.max(Number(req.query.months) || 6, 1), 24);
  const type = req.query.type === 'income' ? 'income' : 'expense';

  // Окно из `months` месяцев заканчивается на `end` (YYYY-MM) — обычно это месяц,
  // выбранный в «Отчёте за месяц», а не обязательно реальный текущий календарный месяц.
  let endYear, endMonth;
  if (/^\d{4}-\d{2}$/.test(req.query.end || '')) {
    [endYear, endMonth] = req.query.end.split('-').map(Number);
    endMonth -= 1;
  } else {
    const now = new Date();
    endYear = now.getFullYear();
    endMonth = now.getMonth();
  }

  const list = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(endYear, endMonth - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const cats = categoryBreakdown(key, type);
    const total = cats.reduce((s, c) => s + c.amount, 0);
    list.push({ month: key, total, cats });
  }
  res.json(list);
});

router.get('/:month', (req, res) => {
  const { month } = req.params;
  const totalIncome = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS s FROM transactions
    WHERE substr(date, 1, 7) = ? AND type = 'income'
  `).get(month).s;
  const totalExpense = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS s FROM transactions
    WHERE substr(date, 1, 7) = ? AND type = 'expense'
  `).get(month).s;

  res.json({
    month,
    totalIncome,
    totalExpense,
    balance: totalIncome - totalExpense,
    expenseByCategory: categoryBreakdown(month, 'expense'),
    incomeByCategory: categoryBreakdown(month, 'income'),
  });
});

module.exports = router;
