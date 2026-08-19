const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { randomUUID } = require('crypto');
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
    'SELECT id FROM transactions WHERE date = ? AND type = ? AND category_id = ? AND amount = ? AND note = ? AND excluded_from_total = ? AND is_recurring = ?'
  );
  const findByUuidStmt = db.prepare('SELECT * FROM transactions WHERE uuid = ?');
  const insertStmt = db.prepare(
    'INSERT INTO transactions (date, type, category_id, amount, note, excluded_from_total, is_recurring, uuid) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const updateStmt = db.prepare(
    'UPDATE transactions SET date = ?, type = ?, category_id = ?, amount = ?, note = ?, excluded_from_total = ?, is_recurring = ? WHERE id = ?'
  );
  // ? в конце — id, который демоутить нельзя (сама обновляемая строка, если
  // она уже recurring; при обычной вставке передаём 0, что не совпадёт ни с
  // одним реальным id).
  const demoteRecurringStmt = db.prepare(
    'UPDATE transactions SET is_recurring = 0 WHERE category_id = ? AND type = ? AND is_recurring = 1 AND id != ?'
  );

  let imported = 0;
  let updated = 0;
  let skippedDuplicates = 0;
  let skippedInvalid = 0;
  const newCategories = new Set();
  const sheetsProcessed = [];

  // Общая для обоих форматов часть: найти/создать категорию, сопоставить с уже
  // существующей операцией (по uuid, если он был в файле — перенос между
  // устройствами, см. export.js) или по точному совпадению всех полей (старые
  // файлы без uuid, и легаси-формат «Траты/Приход»), обновить или вставить.
  //
  // Раньше (до uuid) импорт умел только "точно новая" или "точный дубль по
  // всем полям" — операция, отредактированная на одном устройстве, при
  // повторном импорте на другом создавала БЫ дубль вместо обновления
  // существующей. С uuid: нашли ту же операцию, но значения разошлись —
  // обновляем существующую строку, а не вставляем вторую. uuid есть, но
  // локально такой операции ещё нет — значит она создана на другом
  // устройстве позже последней синхронизации, вставляем как новую, сохраняя
  // тот же uuid (не генерируя новый), чтобы будущие синхронизации продолжали
  // находить её. Удаления сознательно НЕ переносятся этим механизмом —
  // операция, удалённая на одном устройстве, при импорте старого экспорта с
  // другого может "ожить" снова; для реальной синхронизации без этого
  // ограничения нужен сервер, а не просто файл.
  function importRow(date, type, amount, note, categoryName, excludedFromTotal = false, isRecurring = false, uuid = null) {
    if (!date || !type || amount === null || amount <= 0) { skippedInvalid++; return; }
    const fallbackCategory = type === 'expense' ? FALLBACK_EXPENSE_CATEGORY : FALLBACK_INCOME_CATEGORY;
    const name = categoryName || fallbackCategory;
    const excluded = excludedFromTotal ? 1 : 0;
    const recurring = isRecurring ? 1 : 0;

    const { id: categoryId, created } = findOrCreateCategory(name, type);
    if (created) newCategories.add(`${name} (${type === 'expense' ? 'расход' : 'доход'})`);

    const existingByUuid = uuid ? findByUuidStmt.get(uuid) : null;

    if (existingByUuid) {
      const unchanged = existingByUuid.date === date && existingByUuid.type === type
        && existingByUuid.category_id === categoryId && existingByUuid.amount === amount
        && existingByUuid.note === note && existingByUuid.excluded_from_total === excluded
        && existingByUuid.is_recurring === recurring;
      if (unchanged) { skippedDuplicates++; return; }
      if (recurring) demoteRecurringStmt.run(categoryId, type, existingByUuid.id);
      updateStmt.run(date, type, categoryId, amount, note, excluded, recurring, existingByUuid.id);
      updated++;
      return;
    }

    // Без совпадения по uuid — старый путь, точный дубль по значениям (uuid
    // либо отсутствовал в файле вовсе, либо был, но такой операции здесь ещё нет).
    if (!uuid && existsStmt.get(date, type, categoryId, amount, note, excluded, recurring)) {
      skippedDuplicates++;
      return;
    }

    // Тот же инвариант, что в routes/transactions.js POST — не более одной
    // активной повторяющейся операции на (категорию, тип). Обычный экспорт
    // этого приложения не может нарушить его сам по себе (в БД-источнике
    // инвариант уже соблюдён), но это защита на случай вручную отредактированного
    // файла с несколькими «Повтор.=да» на одну категорию.
    if (recurring) demoteRecurringStmt.run(categoryId, type, 0);

    insertStmt.run(date, type, categoryId, amount, note, excluded, recurring, uuid || randomUUID());
    imported++;
  }

  const runImport = db.transaction(() => {
    workbook.worksheets.forEach((ws) => {
      const name = ws.name.trim();

      // Собственный формат экспорта этого приложения (см. routes/export.js, лист
      // «Операции») — используется для бэкапа/переноса данных между устройствами:
      // один лист на оба типа операций, тип в столбце B, 1 строка заголовка.
      // Столбцы 6 «Метка» («нал.» или пусто), 7 «Повтор.» («да» или пусто) и
      // 8 «UUID» появились позже столбцов 1–5 и намеренно идут последними (см.
      // export.js) — старые файлы, экспортированные до этих изменений, их
      // просто не имеют, cellText на несуществующей ячейке вернёт '', что
      // корректно читается как «нет метки»/«не повторяется»/«нет uuid, сверять
      // по значениям, как раньше» (см. importRow выше).
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
          const excludedFromTotal = cellText(row.getCell(6)).toLowerCase() === 'нал.';
          const isRecurring = cellText(row.getCell(7)).toLowerCase() === 'да';
          const uuid = cellText(row.getCell(8)) || null;
          importRow(date, type, amount, note, categoryName, excludedFromTotal, isRecurring, uuid);
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
    updated,
    skippedDuplicates,
    skippedInvalid,
    newCategories: Array.from(newCategories),
    sheetsProcessed,
  });
});

module.exports = router;
