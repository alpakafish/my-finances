const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const db = require('../db');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const FALLBACK_EXPENSE_CATEGORY = 'Другое';
const FALLBACK_INCOME_CATEGORY = 'Прочий доход';

// Детерминированный цвет для категорий, которых нет среди дефолтных.
function colorForName(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  return hslToHex(hue, 55, 50);
}

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (x) => Math.round(255 * x).toString(16).padStart(2, '0');
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

function cellText(cell) {
  const v = cell ? cell.value : null;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((r) => r.text).join('');
    if ('result' in v) return String(v.result);
    if (v instanceof Date) return v.toISOString();
  }
  return String(v).trim();
}

function cellDate(cell) {
  const v = cell ? cell.value : null;
  if (!v) return null;
  if (v instanceof Date) {
    const y = v.getUTCFullYear();
    const m = String(v.getUTCMonth() + 1).padStart(2, '0');
    const d = String(v.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  return null;
}

function cellNumber(cell) {
  const v = cell ? cell.value : null;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && v && 'result' in v && typeof v.result === 'number') return v.result;
  const parsed = parseFloat(v);
  return Number.isFinite(parsed) ? parsed : null;
}

router.post('/', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не передан' });

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(req.file.buffer);
  } catch (e) {
    return res.status(400).json({ error: 'Не удалось прочитать файл — это точно .xlsx?' });
  }

  const categoryCache = new Map(); // `${type}:${lowercaseName}` -> id
  for (const c of db.prepare('SELECT id, name, type FROM categories').all()) {
    categoryCache.set(`${c.type}:${c.name.toLowerCase()}`, c.id);
  }

  const findOrCreateCategory = db.transaction((name, type) => {
    const key = `${type}:${name.toLowerCase()}`;
    if (categoryCache.has(key)) return { id: categoryCache.get(key), created: false };
    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM categories WHERE type = ?').get(type).m;
    const info = db.prepare('INSERT INTO categories (name, type, color, sort_order) VALUES (?, ?, ?, ?)')
      .run(name, type, colorForName(name), maxOrder + 1);
    categoryCache.set(key, info.lastInsertRowid);
    return { id: info.lastInsertRowid, created: true };
  });

  const existsStmt = db.prepare(
    'SELECT id FROM transactions WHERE date = ? AND type = ? AND category_id = ? AND amount = ? AND note = ?'
  );
  const insertStmt = db.prepare(
    'INSERT INTO transactions (date, type, category_id, amount, note) VALUES (?, ?, ?, ?, ?)'
  );

  let imported = 0;
  let skippedDuplicates = 0;
  let skippedInvalid = 0;
  const newCategories = new Set();
  const sheetsProcessed = [];

  // Общая для обоих форматов часть: найти/создать категорию, пропустить дубль, вставить.
  function importRow(date, type, amount, note, categoryName) {
    if (!date || !type || amount === null || amount <= 0) { skippedInvalid++; return; }
    const fallbackCategory = type === 'expense' ? FALLBACK_EXPENSE_CATEGORY : FALLBACK_INCOME_CATEGORY;
    const name = categoryName || fallbackCategory;

    const { id: categoryId, created } = findOrCreateCategory(name, type);
    if (created) newCategories.add(`${name} (${type === 'expense' ? 'расход' : 'доход'})`);

    if (existsStmt.get(date, type, categoryId, amount, note)) { skippedDuplicates++; return; }

    insertStmt.run(date, type, categoryId, amount, note);
    imported++;
  }

  const runImport = db.transaction(() => {
    workbook.worksheets.forEach((ws) => {
      const name = ws.name.trim();

      // Собственный формат экспорта этого приложения (см. routes/export.js, лист
      // «Операции») — используется для бэкапа/переноса данных между устройствами:
      // один лист на оба типа операций, тип в столбце B, 1 строка заголовка.
      if (name === 'Операции') {
        sheetsProcessed.push(name);
        for (let rowNum = 2; rowNum <= ws.rowCount; rowNum++) {
          const row = ws.getRow(rowNum);
          const date = cellDate(row.getCell(1));
          const typeText = cellText(row.getCell(2));
          const type = typeText === 'Доход' ? 'income' : typeText === 'Расход' ? 'expense' : null;
          const amount = cellNumber(row.getCell(4));
          const note = cellText(row.getCell(5));
          const categoryName = cellText(row.getCell(3));
          importRow(date, type, amount, note, categoryName);
        }
        return;
      }

      // Старый формат — лист из ручной Excel-таблицы («Траты…»/«Приход…»), которую
      // вели до этого приложения: один тип на лист, 2 строки заголовка, столбцы
      // дата/сумма/заметка/категория.
      let type = null;
      if (name.startsWith('Траты')) type = 'expense';
      else if (name.startsWith('Приход')) type = 'income';
      else return; // "Сводка по месяцам", "Итого" и прочие служебные листы пропускаем

      sheetsProcessed.push(name);
      for (let rowNum = 3; rowNum <= ws.rowCount; rowNum++) {
        const row = ws.getRow(rowNum);
        const date = cellDate(row.getCell(1));
        const amount = cellNumber(row.getCell(2));
        const note = cellText(row.getCell(3));
        const categoryName = cellText(row.getCell(4));
        importRow(date, type, amount, note, categoryName);
      }
    });
  });

  try {
    runImport();
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Ошибка при импорте: ' + e.message });
  }

  res.json({
    imported,
    skippedDuplicates,
    skippedInvalid,
    newCategories: Array.from(newCategories),
    sheetsProcessed,
  });
});

module.exports = router;
