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
  // typeof-проверка, а не просто truthy `name` — пустая строка проходила бы
  // как "не менять" через COALESCE, но пробельная ("   ") раньше была truthy,
  // .trim() превращал её в "" и COALESCE(?, name) с "" (не NULL) реально
  // затирал название пустым. Явно отклоняем и то, и то.
  const trimmedName = typeof name === 'string' ? name.trim() : null;
  if (typeof name === 'string' && trimmedName === '') {
    return res.status(400).json({ error: 'Название категории не может быть пустым' });
  }
  try {
    db.prepare('UPDATE categories SET name = COALESCE(?, name), color = COALESCE(?, color) WHERE id = ?')
      .run(trimmedName, color || null, req.params.id);
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

  const existing = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Категория не найдена' });

  const goalUsing = db.prepare('SELECT name FROM goals WHERE category_id = ?').get(id);
  if (goalUsing) {
    return res.status(409).json({ error: `Эта категория привязана к цели «${goalUsing.name}» — удалите или измените цель во вкладке «Цели», прежде чем удалять категорию.` });
  }

  // Категория-цель rollup (см. rollup_id в db.js — например «Сбережения», в
  // которую подшита отдельная категория цели) не даёт себя удалить: FK
  // categories.rollup_id → categories(id) без ON DELETE, foreign_keys=ON —
  // без этой проверки DELETE падал бы необработанным SQLITE_CONSTRAINT и
  // роут отвечал бы голым 500 вместо понятной причины (найдено и
  // воспроизведено вручную: цель с новой категорией, rollup → «Сбережения»,
  // затем попытка удалить «Сбережения»).
  const rollupUsing = db.prepare('SELECT name FROM categories WHERE rollup_id = ?').all(id);
  if (rollupUsing.length > 0) {
    return res.status(409).json({
      error: `На эту категорию ссылается как на «Дашборде →» другая категория (${rollupUsing.map((c) => `«${c.name}»`).join(', ')}) — сначала измените или удалите её (обычно это категория цели), прежде чем удалять эту.`,
    });
  }

  const usageCount = db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE category_id = ?').get(id).n;

  if (usageCount > 0) {
    if (reassignTo) {
      // Без этой проверки перенос на несуществующую или на категорию другого
      // типа (расход↔доход) раньше проходил тихо — операции физически
      // остаются с этим category_id (FK ничего не проверяет на UPDATE
      // здесь), но ломается смысл: расходы оказываются "привязаны" к
      // категории дохода и наоборот.
      const target = db.prepare('SELECT * FROM categories WHERE id = ?').get(Number(reassignTo));
      if (!target) {
        return res.status(400).json({ error: 'Категория для переноса операций не найдена' });
      }
      if (target.type !== existing.type) {
        return res.status(400).json({ error: 'Перенести можно только на категорию того же типа (расход или доход)' });
      }
      db.prepare('UPDATE transactions SET category_id = ? WHERE category_id = ?').run(target.id, id);
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
