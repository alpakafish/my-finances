const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/', (req, res) => {
  const { month, type, category_id } = req.query; // month: YYYY-MM, type: expense|income
  const conditions = [];
  const params = [];
  if (month) { conditions.push('substr(t.date, 1, 7) = ?'); params.push(month); }
  if (type === 'expense' || type === 'income') { conditions.push('t.type = ?'); params.push(type); }
  // Фильтр по категории (вкладка «Операции», поиск) — независим от month:
  // текстовый поиск на фронтенде запрашивает без month (по всей истории),
  // но продолжает уважать category_id, см. public/app.js loadTransactionsTable().
  if (category_id) { conditions.push('t.category_id = ?'); params.push(Number(category_id)); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT t.*, c.name AS category_name, c.color AS category_color
    FROM transactions t JOIN categories c ON c.id = t.category_id
    ${where}
    ORDER BY t.date DESC, t.id DESC
  `).all(...params);
  res.json(rows);
});

router.post('/', (req, res) => {
  const { date, type, category_id, amount, note, excluded_from_total, is_recurring } = req.body;
  if (!date || !['expense', 'income'].includes(type) || !category_id || !(amount > 0)) {
    return res.status(400).json({ error: 'Заполните дату, тип, категорию и сумму (> 0)' });
  }
  // Не более одной активной повторяющейся операции на (категория, тип) —
  // см. is_recurring в db.js. Снимаем флаг со старой перед установкой на
  // новую в той же транзакции, а не полагаемся на ограничение в схеме.
  const insert = db.transaction(() => {
    if (is_recurring) {
      db.prepare('UPDATE transactions SET is_recurring = 0 WHERE category_id = ? AND type = ? AND is_recurring = 1').run(category_id, type);
    }
    return db.prepare(
      'INSERT INTO transactions (date, type, category_id, amount, note, excluded_from_total, is_recurring) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(date, type, category_id, amount, note || '', excluded_from_total ? 1 : 0, is_recurring ? 1 : 0).lastInsertRowid;
  });
  const id = insert();
  res.status(201).json(db.prepare('SELECT * FROM transactions WHERE id = ?').get(id));
});

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Операция не найдена' });
  const { date, type, category_id, amount, note, excluded_from_total, is_recurring } = req.body;
  const finalCategoryId = category_id || existing.category_id;
  const finalType = type || existing.type;

  const update = db.transaction(() => {
    if (is_recurring) {
      db.prepare('UPDATE transactions SET is_recurring = 0 WHERE category_id = ? AND type = ? AND is_recurring = 1 AND id != ?')
        .run(finalCategoryId, finalType, req.params.id);
    }
    db.prepare(`
      UPDATE transactions SET
        date = COALESCE(?, date),
        type = COALESCE(?, type),
        category_id = COALESCE(?, category_id),
        amount = COALESCE(?, amount),
        note = COALESCE(?, note),
        excluded_from_total = COALESCE(?, excluded_from_total),
        is_recurring = COALESCE(?, is_recurring)
      WHERE id = ?
    `).run(
      date || null, type || null, category_id || null, amount || null, note ?? null,
      excluded_from_total === undefined ? null : (excluded_from_total ? 1 : 0),
      is_recurring === undefined ? null : (is_recurring ? 1 : 0),
      req.params.id
    );
  });
  update();
  res.json(db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id));
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM transactions WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

module.exports = router;
