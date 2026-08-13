const express = require('express');
const db = require('../db');

const router = express.Router();

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// Считаем по дням (округляя вверх), а не по «целым прошедшим месяцам» между датами —
// последнее давало скачок «ежемесячно нужно» на целый месяц вперёд сразу же, как
// только текущий день месяца становился больше дня дедлайна (даже если реально
// прошёл всего 1 день из срока цели). Пример бага: сегодня 13-е, дедлайн 12-е число
// через ~4 месяца — «целые месяцы» считали 3, хотя фактически прошёл только день.
// 30.44 — среднее число дней в месяце (365.25 / 12), Math.ceil — чтобы «месяцев
// осталось» не опускалось до 0, пока дедлайн буквально не наступил.
function monthsBetween(fromDate, toDate) {
  const days = (toDate.getTime() - fromDate.getTime()) / (24 * 60 * 60 * 1000);
  return Math.ceil(days / 30.44);
}

function addMonths(dateStr, months) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

function withProgress(goal) {
  const progress = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS s FROM transactions
    WHERE category_id = ? AND type = 'expense' AND date >= ?
  `).get(goal.category_id, goal.start_date).s;

  const pct = goal.target_amount > 0 ? Math.min(100, Math.round((progress / goal.target_amount) * 1000) / 10) : 0;
  const remaining = Math.max(0, goal.target_amount - progress);
  const completed = progress >= goal.target_amount;

  let deadline = null, monthlyNeeded = null, overdue = false;
  if (goal.duration_months) {
    deadline = addMonths(goal.start_date, goal.duration_months);
    if (!completed) {
      const today = new Date();
      const deadlineDate = new Date(deadline + 'T00:00:00');
      const monthsLeft = monthsBetween(today, deadlineDate);
      if (monthsLeft <= 0) {
        overdue = true;
        monthlyNeeded = remaining;
      } else {
        monthlyNeeded = remaining / monthsLeft;
      }
    }
  }

  return {
    ...goal,
    progress,
    pct,
    remaining,
    completed,
    deadline,
    monthlyNeeded,
    overdue,
  };
}

router.get('/', (req, res) => {
  const goals = db.prepare(`
    SELECT g.*, c.name AS category_name, c.color AS category_color
    FROM goals g JOIN categories c ON c.id = g.category_id
    ORDER BY g.created_at DESC
  `).all();
  res.json(goals.map(withProgress));
});

router.post('/', (req, res) => {
  const { name, target_amount, duration_months, category_id, new_category } = req.body;

  if (!name || !(target_amount > 0)) {
    return res.status(400).json({ error: 'Укажите назначение и сумму цели (> 0)' });
  }
  if (!category_id && !new_category) {
    return res.status(400).json({ error: 'Выберите существующую категорию или создайте новую' });
  }

  let resolvedCategoryId = category_id;

  const create = db.transaction(() => {
    if (!resolvedCategoryId && new_category) {
      const catName = (new_category.name || '').trim();
      if (!catName) throw new Error('Укажите название новой категории');
      const maxOrder = db.prepare("SELECT COALESCE(MAX(sort_order), -1) AS m FROM categories WHERE type = 'expense'").get().m;
      const info = db.prepare(
        'INSERT INTO categories (name, type, color, sort_order, rollup_id) VALUES (?, \'expense\', ?, ?, ?)'
      ).run(catName, new_category.color || '#1D9E75', maxOrder + 1, new_category.rollup_id || null);
      resolvedCategoryId = info.lastInsertRowid;
    }

    const info = db.prepare(`
      INSERT INTO goals (name, target_amount, category_id, duration_months)
      VALUES (?, ?, ?, ?)
    `).run(name.trim(), target_amount, resolvedCategoryId, duration_months || null);
    return info.lastInsertRowid;
  });

  let goalId;
  try {
    goalId = create();
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const goal = db.prepare(`
    SELECT g.*, c.name AS category_name, c.color AS category_color
    FROM goals g JOIN categories c ON c.id = g.category_id
    WHERE g.id = ?
  `).get(goalId);
  res.status(201).json(withProgress(goal));
});

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM goals WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Цель не найдена' });
  const { name, target_amount, duration_months } = req.body;
  db.prepare(`
    UPDATE goals SET
      name = COALESCE(?, name),
      target_amount = COALESCE(?, target_amount),
      duration_months = ?
    WHERE id = ?
  `).run(name || null, target_amount || null, duration_months === undefined ? existing.duration_months : duration_months, req.params.id);

  const goal = db.prepare(`
    SELECT g.*, c.name AS category_name, c.color AS category_color
    FROM goals g JOIN categories c ON c.id = g.category_id
    WHERE g.id = ?
  `).get(req.params.id);
  res.json(withProgress(goal));
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM goals WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

router.post('/:id/contribute', (req, res) => {
  const goal = db.prepare('SELECT * FROM goals WHERE id = ?').get(req.params.id);
  if (!goal) return res.status(404).json({ error: 'Цель не найдена' });
  const { amount, date, note } = req.body;
  if (!(amount > 0)) return res.status(400).json({ error: 'Сумма взноса должна быть больше нуля' });

  db.prepare(
    'INSERT INTO transactions (date, type, category_id, amount, note) VALUES (?, \'expense\', ?, ?, ?)'
  ).run(date || todayISO(), goal.category_id, amount, note || `Взнос в цель «${goal.name}»`);

  const updated = db.prepare(`
    SELECT g.*, c.name AS category_name, c.color AS category_color
    FROM goals g JOIN categories c ON c.id = g.category_id
    WHERE g.id = ?
  `).get(req.params.id);
  res.status(201).json(withProgress(updated));
});

module.exports = router;
