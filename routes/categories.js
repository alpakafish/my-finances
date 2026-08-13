const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/', (req, res) => {
  const { type } = req.query;
  const rows = type
    ? db.prepare('SELECT * FROM categories WHERE type = ? ORDER BY sort_order, name').all(type)
    : db.prepare('SELECT * FROM categories ORDER BY type, sort_order, name').all();
  res.json(rows);
});

router.post('/', (req, res) => {
  const { name, type, color } = req.body;
  if (!name || !['expense', 'income'].includes(type)) {
    return res.status(400).json({ error: 'Укажите название и тип категории (expense/income)' });
  }
  try {
    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM categories WHERE type = ?').get(type).m;
    const info = db.prepare('INSERT INTO categories (name, type, color, sort_order) VALUES (?, ?, ?, ?)')
      .run(name.trim(), type, color || '#888780', maxOrder + 1);
    res.status(201).json(db.prepare('SELECT * FROM categories WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Такая категория уже есть' });
    }
    throw e;
  }
});

router.put('/:id', (req, res) => {
  const { name, color } = req.body;
  const existing = db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Категория не найдена' });
  try {
    db.prepare('UPDATE categories SET name = COALESCE(?, name), color = COALESCE(?, color) WHERE id = ?')
      .run(name ? name.trim() : null, color || null, req.params.id);
    res.json(db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id));
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Такая категория уже есть' });
    }
    throw e;
  }
});

router.delete('/:id', (req, res) => {
  const { reassignTo, deleteTransactions } = req.query;
  const id = Number(req.params.id);

  const goalUsing = db.prepare('SELECT name FROM goals WHERE category_id = ?').get(id);
  if (goalUsing) {
    return res.status(409).json({ error: `Эта категория привязана к цели «${goalUsing.name}» — удалите или измените цель во вкладке «Цели», прежде чем удалять категорию.` });
  }

  const usageCount = db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE category_id = ?').get(id).n;

  if (usageCount > 0) {
    if (reassignTo) {
      db.prepare('UPDATE transactions SET category_id = ? WHERE category_id = ?').run(Number(reassignTo), id);
    } else if (deleteTransactions === 'true') {
      db.prepare('DELETE FROM transactions WHERE category_id = ?').run(id);
    } else {
      return res.status(409).json({
        error: 'На эту категорию есть операции. Передайте reassignTo (перенести) или deleteTransactions=true (удалить их), чтобы удалить категорию.',
        usageCount,
      });
    }
  }

  db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  res.status(204).end();
});

module.exports = router;
