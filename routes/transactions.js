const express = require('express');
const db = require('../db');

const router = express.Router();

// Раньше `date` только проверялась на truthy — любая непустая строка проходила
// и сохранялась как есть (достижимо не через саму форму — там `<input
// type="date">` браузер уже ограничивает форматом — а через прямой вызов API
// или намеренно испорченный импортируемый файл). public/app.js экранирует
// пользовательский текст перед вставкой в innerHTML, но лишняя незавалидированная
// дыра в бэкенде — то же самое дублирование защиты, что уже принято для
// остальных полей (см. category/goals валидацию).
function isValidDate(d) {
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
}

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
  const { date, type, category_id, amount, note, excluded_from_total, is_recurring, auto_confirm } = req.body;
  if (!isValidDate(date) || !['expense', 'income'].includes(type) || !category_id || !(amount > 0)) {
    return res.status(400).json({ error: 'Заполните дату, тип, категорию и сумму (> 0)' });
  }
  // Не более одной активной повторяющейся операции на (категория, тип) —
  // см. is_recurring в db.js. Снимаем флаг со старой перед установкой на
  // новую в той же транзакции, а не полагаемся на ограничение в схеме.
  const insert = db.transaction(() => {
    if (is_recurring) {
      db.prepare('UPDATE transactions SET is_recurring = 0, auto_confirm = 0 WHERE category_id = ? AND type = ? AND is_recurring = 1').run(category_id, type);
    }
    return db.prepare(
      'INSERT INTO transactions (date, type, category_id, amount, note, excluded_from_total, is_recurring, auto_confirm) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(date, type, category_id, amount, note || '', excluded_from_total ? 1 : 0, is_recurring ? 1 : 0, is_recurring && auto_confirm ? 1 : 0).lastInsertRowid;
  });
  const id = insert();
  res.status(201).json(db.prepare('SELECT * FROM transactions WHERE id = ?').get(id));
});

// ---------- Корзина удалённых операций (см. db.js deleted_transactions) ----------
// Статичные пути — до router.delete('/:id') ниже, хотя коллизии тут в
// принципе нет (разные методы/литеральный путь), просто для единообразия с
// тем же приёмом в routes/limits.js.
router.get('/trash', (req, res) => {
  const rows = db.prepare('SELECT * FROM deleted_transactions ORDER BY id DESC LIMIT 10').all();
  res.json(rows);
});

router.post('/trash/:id/restore', (req, res) => {
  const trashed = db.prepare('SELECT * FROM deleted_transactions WHERE id = ?').get(req.params.id);
  if (!trashed) {
    return res.status(404).json({
      error: 'Эта операция уже не в корзине — либо восстановлена, либо вытеснена более новыми удалениями (хранятся последние 10)',
    });
  }
  const category = db.prepare('SELECT id FROM categories WHERE id = ?').get(trashed.category_id);
  if (!category) {
    return res.status(409).json({ error: `Категория «${trashed.category_name}» была удалена — восстановить операцию в неё нельзя` });
  }
  const restore = db.transaction(() => {
    if (trashed.is_recurring) {
      db.prepare('UPDATE transactions SET is_recurring = 0, auto_confirm = 0 WHERE category_id = ? AND type = ? AND is_recurring = 1')
        .run(trashed.category_id, trashed.type);
    }
    const id = db.prepare(
      'INSERT INTO transactions (date, type, category_id, amount, note, excluded_from_total, is_recurring, auto_confirm) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(trashed.date, trashed.type, trashed.category_id, trashed.amount, trashed.note, trashed.excluded_from_total, trashed.is_recurring, trashed.auto_confirm).lastInsertRowid;
    db.prepare('DELETE FROM deleted_transactions WHERE id = ?').run(req.params.id);
    return id;
  });
  const id = restore();
  res.status(201).json(db.prepare('SELECT * FROM transactions WHERE id = ?').get(id));
});

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Операция не найдена' });
  const { date, type, category_id, amount, note, excluded_from_total, is_recurring, auto_confirm } = req.body;
  if (date !== undefined && date !== null && !isValidDate(date)) {
    return res.status(400).json({ error: 'Некорректная дата' });
  }
  const finalCategoryId = category_id || existing.category_id;
  const finalType = type || existing.type;
  // "Не спрашивая" не имеет смысла без is_recurring — если снимают галочку
  // "Повтор." в этом же запросе, гасим и её, а не оставляем висеть молча.
  const finalIsRecurring = is_recurring === undefined ? existing.is_recurring : (is_recurring ? 1 : 0);
  const finalAutoConfirm = !finalIsRecurring ? 0 : (auto_confirm === undefined ? existing.auto_confirm : (auto_confirm ? 1 : 0));

  const update = db.transaction(() => {
    if (is_recurring) {
      db.prepare('UPDATE transactions SET is_recurring = 0, auto_confirm = 0 WHERE category_id = ? AND type = ? AND is_recurring = 1 AND id != ?')
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
        is_recurring = ?,
        auto_confirm = ?
      WHERE id = ?
    `).run(
      date || null, type || null, category_id || null, amount || null, note ?? null,
      excluded_from_total === undefined ? null : (excluded_from_total ? 1 : 0),
      finalIsRecurring, finalAutoConfirm,
      req.params.id
    );
  });
  update();
  res.json(db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id));
});

router.delete('/:id', (req, res) => {
  const existing = db.prepare(`
    SELECT t.*, c.name AS category_name
    FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.id = ?
  `).get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Операция не найдена' });
  const del = db.transaction(() => {
    db.prepare(`
      INSERT INTO deleted_transactions (date, type, category_id, category_name, amount, note, excluded_from_total, is_recurring, auto_confirm)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      existing.date, existing.type, existing.category_id, existing.category_name,
      existing.amount, existing.note, existing.excluded_from_total, existing.is_recurring, existing.auto_confirm
    );
    db.prepare('DELETE FROM transactions WHERE id = ?').run(req.params.id);
    // Держим только последние 10 — старше см. в бэкапах (backup.js).
    db.prepare(`
      DELETE FROM deleted_transactions
      WHERE id NOT IN (SELECT id FROM deleted_transactions ORDER BY id DESC LIMIT 10)
    `).run();
  });
  del();
  res.status(204).end();
});

module.exports = router;
