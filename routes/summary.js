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

  // Та же сумма, но по исходным категориям — до сворачивания rollup — чтобы на
  // Дашборде можно было "провалиться внутрь" строки со свёрнутой суммой и
  // увидеть, сколько из неё сама категория, а сколько — какая подшитая цель
  // (раньше для этого нужно было идти на вкладку «Операции» и фильтровать
  // вручную). components у строки нет вовсе, если туда ничего не сворачивалось
  // (обычная, не-rollup категория) — нечего разворачивать.
  const rawRows = db.prepare(`
    SELECT c.id, c.name, c.color, c.rollup_id, SUM(t.amount) AS amount
    FROM transactions t JOIN categories c ON c.id = t.category_id
    WHERE substr(t.date, 1, 7) = ? AND t.type = ?
    GROUP BY c.id
  `).all(month, type);
  const componentsByTargetId = {};
  rawRows.forEach((r) => {
    const targetId = r.rollup_id || r.id;
    (componentsByTargetId[targetId] ||= []).push({ id: r.id, name: r.name, color: r.color, amount: r.amount });
  });

  return rows.map((r) => ({
    ...r,
    pct: total ? Math.round((r.amount / total) * 1000) / 10 : 0,
    components: (componentsByTargetId[r.id]?.length ?? 0) > 1 ? componentsByTargetId[r.id] : null,
  }));
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

// Список лет, за которые есть хоть одна операция, плюс текущий год (даже пустой) —
// чтобы на вкладке «По годам» и в навигации по годам всегда был как минимум он.
router.get('/years', (req, res) => {
  const years = db.prepare(`SELECT DISTINCT substr(date, 1, 4) AS year FROM transactions ORDER BY year`).all().map((r) => r.year);
  const currentYear = String(new Date().getFullYear());
  if (!years.includes(currentYear)) years.push(currentYear);
  years.sort();
  res.json(years);
});

// Помесячная разбивка одного типа операций по всем годам, где есть данные —
// для линейного графика сравнения лет (каждый год — отдельная линия, Янв..Дек).
router.get('/yearly', (req, res) => {
  const type = req.query.type === 'income' ? 'income' : 'expense';
  const rows = db.prepare(`
    SELECT substr(date, 1, 4) AS year, CAST(substr(date, 6, 2) AS INTEGER) AS month, SUM(amount) AS amount
    FROM transactions WHERE type = ?
    GROUP BY year, month
  `).all(type);

  const byYear = {};
  rows.forEach((r) => {
    if (!byYear[r.year]) byYear[r.year] = Array(12).fill(0);
    byYear[r.year][r.month - 1] = r.amount;
  });

  const years = Object.keys(byYear).sort();
  res.json(years.map((year) => ({
    year,
    monthly: byYear[year],
    total: byYear[year].reduce((s, v) => s + v, 0),
  })));
});

// Годовые итоги (доход/расход/баланс) — для таблицы под графиком сравнения лет.
router.get('/yearly-totals', (req, res) => {
  // Список лет — по ВСЕМ операциям (включая «нал.»), иначе год, где были только
  // операции «нал.», пропал бы из таблицы целиком вместо строки 0/0/0 — так же,
  // как /years ниже не фильтрует их для выпадающих списков.
  const allYears = db.prepare(`SELECT DISTINCT substr(date, 1, 4) AS year FROM transactions`).all().map((r) => r.year);
  // Сами суммы — плоский итог по типу без разбивки на категории, как шапка
  // месяца/года и Баланс, «нал.»-операции сюда не входят (см. excluded_from_total в db.js).
  const rows = db.prepare(`
    SELECT substr(date, 1, 4) AS year, type, SUM(amount) AS s
    FROM transactions WHERE excluded_from_total = 0 GROUP BY year, type
  `).all();

  const byYear = {};
  allYears.forEach((year) => { byYear[year] = { income: 0, expense: 0 }; });
  rows.forEach((r) => {
    byYear[r.year][r.type] = r.s;
  });

  const years = Object.keys(byYear).sort();
  res.json(years.map((year) => ({
    year,
    income: byYear[year].income,
    expense: byYear[year].expense,
    balance: byYear[year].income - byYear[year].expense,
  })));
});

router.get('/:month', (req, res) => {
  const { month } = req.params;
  // «Нал.»-операции (excluded_from_total) не входят в эти плоские итоги — см.
  // db.js. categoryBreakdown() ниже их намеренно не фильтрует, оставляя видными
  // в разбивке по категориям и на графиках.
  const totalIncome = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS s FROM transactions
    WHERE substr(date, 1, 7) = ? AND type = 'income' AND excluded_from_total = 0
  `).get(month).s;
  const totalExpense = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS s FROM transactions
    WHERE substr(date, 1, 7) = ? AND type = 'expense' AND excluded_from_total = 0
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
