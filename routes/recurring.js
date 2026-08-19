const express = require('express');
const db = require('../db');

const router = express.Router();

function daysInMonth(year, month) { // month: 1-12
  return new Date(year, month, 0).getDate();
}

// Держит день месяца операции-источника (например, аренда пятого числа
// остаётся пятого), но не вылезает за реальное число дней в целевом месяце
// (31-е в феврале → 28-е/29-е).
function dateForMonth(sourceDate, month) {
  const day = Number(sourceDate.slice(8, 10));
  const [year, mon] = month.split('-').map(Number);
  const clampedDay = Math.min(day, daysInMonth(year, mon));
  return `${month}-${String(clampedDay).padStart(2, '0')}`;
}

function isValidMonth(month) {
  return /^\d{4}-\d{2}$/.test(month || '');
}

// Операции с is_recurring=1, у которых ещё нет "потомка" в запрошенном месяце
// (любая операция той же категории+типа — не обязательно тоже помеченная
// повторяющейся: если пользователь уже внёс её вручную, подсказка не нужна)
// и которые не отклонили именно для этого месяца (recurring_dismissals).
router.get('/suggestions', (req, res) => {
  const { month } = req.query;
  if (!isValidMonth(month)) return res.status(400).json({ error: 'Некорректный месяц' });

  const rows = db.prepare(`
    SELECT t.id AS source_id, t.date AS source_date, t.type, t.category_id, t.amount,
           t.excluded_from_total, t.auto_confirm, c.name AS category_name, c.color AS category_color
    FROM transactions t
    JOIN categories c ON c.id = t.category_id
    WHERE t.is_recurring = 1
      AND substr(t.date, 1, 7) < ?
      AND NOT EXISTS (
        SELECT 1 FROM transactions t2
        WHERE t2.category_id = t.category_id AND t2.type = t.type AND substr(t2.date, 1, 7) = ?
      )
      AND NOT EXISTS (
        SELECT 1 FROM recurring_dismissals d WHERE d.source_transaction_id = t.id AND d.period = ?
      )
    ORDER BY t.type, c.sort_order, c.name
  `).all(month, month, month);

  res.json(rows);
});

router.post('/:sourceId/confirm', (req, res) => {
  const sourceId = Number(req.params.sourceId);
  const source = db.prepare('SELECT * FROM transactions WHERE id = ?').get(sourceId);
  if (!source) return res.status(404).json({ error: 'Операция-источник не найдена' });
  const { month, amount } = req.body;
  if (!isValidMonth(month)) return res.status(400).json({ error: 'Некорректный месяц' });
  if (!(amount > 0)) return res.status(400).json({ error: 'Сумма должна быть больше нуля' });

  const date = dateForMonth(source.date, month);

  // Пометка "повторяющаяся" переходит на новую операцию, со старой снимается —
  // в любой момент активна не более одной на (категория, тип), см. is_recurring
  // в db.js. excluded_from_total ("нал.") тоже переносится — это свойство самого
  // повторяющегося платежа (например, аренда наличными), а не разовая пометка;
  // note намеренно не переносится — обычно одноразовый комментарий, устаревает.
  // auto_confirm переносится по той же причине, что и is_recurring: без этого
  // "не спрашивая" сработало бы один раз и молча вернулось бы к подсказкам
  // со следующего месяца — источник для него исчезает вместе с demote ниже.
  const confirm = db.transaction(() => {
    db.prepare('UPDATE transactions SET is_recurring = 0, auto_confirm = 0 WHERE id = ?').run(sourceId);
    return db.prepare(`
      INSERT INTO transactions (date, type, category_id, amount, note, excluded_from_total, is_recurring, auto_confirm)
      VALUES (?, ?, ?, ?, '', ?, 1, ?)
    `).run(date, source.type, source.category_id, amount, source.excluded_from_total, source.auto_confirm).lastInsertRowid;
  });

  const id = confirm();
  res.status(201).json(db.prepare('SELECT * FROM transactions WHERE id = ?').get(id));
});

router.post('/:sourceId/skip', (req, res) => {
  const sourceId = Number(req.params.sourceId);
  const source = db.prepare('SELECT id FROM transactions WHERE id = ?').get(sourceId);
  if (!source) return res.status(404).json({ error: 'Операция-источник не найдена' });
  const { month } = req.body;
  if (!isValidMonth(month)) return res.status(400).json({ error: 'Некорректный месяц' });

  db.prepare(`
    INSERT INTO recurring_dismissals (source_transaction_id, period) VALUES (?, ?)
    ON CONFLICT (source_transaction_id, period) DO NOTHING
  `).run(sourceId, month);
  res.status(204).end();
});

module.exports = router;
