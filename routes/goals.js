const express = require('express');
const db = require('../db');

const router = express.Router();

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// Считаем по календарным месяцам (год/месяц), округляя вверх любой неполный
// остаток — НЕ по дням/30.44 (среднее число дней в месяце): такое давало
// завышение на месяц, когда конкретные охваченные месяцы длиннее среднего
// (например, авг→янв через 5 месяцев — три месяца по 31 дню, 153 дня против
// 5×30.44=152.2 — Math.ceil(153/30.44) давало 6 месяцев вместо реальных 5,
// найдено 2026-08-14 при релизе 1.0.17: тест создаёт цель на 5 месяцев
// «сегодня» и ждёт monthsLeft ровно 5).
// Округление вверх (а не отбрасывание неполного месяца) сохраняет более
// ранний фикс — см. коммит 219d1b0: «сегодня 13-е, дедлайн 12-е через ~4
// месяца» не должно давать скачок «ежемесячно нужно» на месяц раньше срока.
function monthsBetween(fromDate, toDate) {
  if (toDate <= fromDate) return 0;
  let months = (toDate.getFullYear() - fromDate.getFullYear()) * 12
    + (toDate.getMonth() - fromDate.getMonth());
  const probe = new Date(fromDate);
  probe.setMonth(probe.getMonth() + months);
  if (probe < toDate) months += 1;
  return months;
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
  // Без этого 0/отрицательный/дробный duration_months тихо сохранялся и ломал
  // addMonths()/monthsBetween() дальше по цепочке (дедлайн в прошлом или
  // дробное число месяцев не имеет смысла) — duration_months необязателен,
  // поэтому проверяем только когда он реально передан.
  if (duration_months !== undefined && duration_months !== null
    && !(Number.isInteger(duration_months) && duration_months > 0)) {
    return res.status(400).json({ error: 'Срок цели должен быть целым числом месяцев больше нуля' });
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
  // Та же проверка, что в POST — раньше PUT вообще не валидировал эти два поля:
  // target_amount: 0 тихо игнорировался (0 || null → COALESCE оставлял старое
  // значение, без сообщения об ошибке), а отрицательный проходил насквозь и
  // сохранялся как есть. duration_months: null явно разрешён (снимает срок
  // цели), поэтому проверяем только когда передано непустое значение.
  if (target_amount !== undefined && target_amount !== null && !(target_amount > 0)) {
    return res.status(400).json({ error: 'Сумма цели должна быть больше нуля' });
  }
  if (duration_months !== undefined && duration_months !== null
    && !(Number.isInteger(duration_months) && duration_months > 0)) {
    return res.status(400).json({ error: 'Срок цели должен быть целым числом месяцев больше нуля' });
  }
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
  const existing = db.prepare('SELECT id FROM goals WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Цель не найдена' });
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
