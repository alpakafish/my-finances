const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/', (req, res) => {
  const { month, type } = req.query; // month: YYYY-MM, type: expense|income
  const conditions = [];
  const params = [];
  if (month) { conditions.push('substr(t.date, 1, 7) = ?'); params.push(month); }
  if (type === 'expense' || type === 'income') { conditions.push('t.type = ?'); params.push(type); }
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
  const { date, type, category_id, amount, note, excluded_from_total } = req.body;
  if (!date || !['expense', 'income'].includes(type) || !category_id || !(amount > 0)) {
    return res.status(400).json({ error: 'Заполните дату, тип, категорию и сумму (> 0)' });
  }
  const info = db.prepare(
    'INSERT INTO transactions (date, type, category_id, amount, note, excluded_from_total) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(date, type, category_id, amount, note || '', excluded_from_total ? 1 : 0);
  res.status(201).json(db.prepare('SELECT * FROM transactions WHERE id = ?').get(info.lastInsertRowid));
});

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Операция не найдена' });
  const { date, type, category_id, amount, note, excluded_from_total } = req.body;
  db.prepare(`
    UPDATE transactions SET
      date = COALESCE(?, date),
      type = COALESCE(?, type),
      category_id = COALESCE(?, category_id),
      amount = COALESCE(?, amount),
      note = COALESCE(?, note),
      excluded_from_total = COALESCE(?, excluded_from_total)
    WHERE id = ?
  `).run(date || null, type || null, category_id || null, amount || null, note ?? null, excluded_from_total === undefined ? null : (excluded_from_total ? 1 : 0), req.params.id);
  res.json(db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id));
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM transactions WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

module.exports = router;
