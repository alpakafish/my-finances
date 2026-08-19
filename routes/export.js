const express = require('express');
const ExcelJS = require('exceljs');
const db = require('../db');

const router = express.Router();

function isValidDate(d) {
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
}

// Вынесено из обработчика роута, чтобы переиспользовать в backup.js — там нужен
// точно тот же файл, что скачивает кнопка «Экспорт в Excel», просто записанный
// на диск вместо HTTP-ответа (см. buildWorkbook ниже).
//
// { from, to } — необязательный диапазон дат (обе включительно) для «Экспорт за
// период» в Настройках (см. public/app.js initPeriodExportSetting). ВАЖНО: вызов
// без аргументов (buildWorkbook()) должен всегда давать ПОЛНЫЙ экспорт — backup.js
// вызывает именно так, и автоматические резервные копии не должны случайно стать
// частичными. Не меняй дефолт here без пересмотра backup.js.
function buildWorkbook({ from, to } = {}) {
  const hasRange = isValidDate(from) && isValidDate(to);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Мои финансы';
  workbook.created = new Date();

  // Столбцы 1–5 (Дата/Тип/Категория/Сумма/Заметка) — фиксированный порядок,
  // который routes/import.js читает позиционно при обратном импорте этого же
  // формата (лист «Операции»). «Метка», «Повтор.» и «UUID» — новые столбцы,
  // каждый раз добавлялись ПОСЛЕДНИМИ, а не перед «Заметкой» — иначе импорт
  // файла, экспортированного уже после этого изменения, начал бы читать не тот
  // столбец как реальную заметку (см. import.js). UUID скрыт (hidden: true) —
  // нужен для переноса между устройствами (routes/import.js сопоставляет по
  // нему изменённые операции вместо задваивания), не предназначен для
  // разглядывания глазами.
  const txSheet = workbook.addWorksheet('Операции');
  txSheet.columns = [
    { header: 'Дата', key: 'date', width: 12 },
    { header: 'Тип', key: 'type', width: 10 },
    { header: 'Категория', key: 'category', width: 22 },
    { header: 'Сумма', key: 'amount', width: 14 },
    { header: 'Заметка', key: 'note', width: 30 },
    { header: 'Метка', key: 'label', width: 8 },
    { header: 'Повтор.', key: 'recurring', width: 8 },
    { header: 'UUID', key: 'uuid', width: 24, hidden: true },
  ];
  txSheet.getRow(1).font = { bold: true };

  const transactions = db.prepare(`
    SELECT t.date, t.type, c.name AS category, t.amount, t.note, t.excluded_from_total, t.is_recurring, t.uuid
    FROM transactions t JOIN categories c ON c.id = t.category_id
    ${hasRange ? 'WHERE t.date >= ? AND t.date <= ?' : ''}
    ORDER BY t.date, t.id
  `).all(...(hasRange ? [from, to] : []));

  transactions.forEach((t) => {
    txSheet.addRow({
      date: t.date,
      type: t.type === 'expense' ? 'Расход' : 'Доход',
      category: t.category,
      amount: t.amount,
      note: t.note,
      label: t.excluded_from_total ? 'нал.' : '',
      recurring: t.is_recurring ? 'да' : '',
      uuid: t.uuid || '',
    });
  });

  const months = db.prepare(`
    SELECT DISTINCT substr(date, 1, 7) AS month FROM transactions
    ${hasRange ? 'WHERE date >= ? AND date <= ?' : ''}
    ORDER BY month
  `).all(...(hasRange ? [from, to] : [])).map((r) => r.month);

  // Категории с rollup_id (например, отдельные категории целей) сюда отдельными столбцами
  // не попадают — их суммы включены в столбец целевой категории (обычно «Сбережения»).
  const categories = db.prepare('SELECT id, name, type FROM categories WHERE rollup_id IS NULL ORDER BY type, sort_order').all();

  const summarySheet = workbook.addWorksheet('Сводка по месяцам');
  const header = ['Месяц', ...categories.map((c) => `${c.name} (${c.type === 'expense' ? 'расход' : 'доход'})`), 'Доход', 'Расход', 'Баланс'];
  summarySheet.addRow(header);
  summarySheet.getRow(1).font = { bold: true };
  summarySheet.columns.forEach((col, i) => { col.width = i === 0 ? 12 : 20; });

  // При частичном экспорте суммы за месяц на границе диапазона (например, from
  // приходится на середину месяца) считаются ТОЛЬКО в пределах from/to — иначе
  // строка сводки показала бы весь месяц целиком, разойдясь с тем, что реально
  // попало на лист «Операции» выше для этого же месяца.
  const sumStmt = db.prepare(`
    SELECT COALESCE(SUM(t.amount), 0) AS s
    FROM transactions t JOIN categories c ON c.id = t.category_id
    WHERE substr(t.date, 1, 7) = ? AND (t.category_id = ? OR c.rollup_id = ?) ${hasRange ? 'AND t.date >= ? AND t.date <= ?' : ''}
  `);
  // Плоский итог по типу — как «Доход»/«Расход»/«Баланс» в приложении, «нал.»-
  // операции сюда не входят (см. excluded_from_total в db.js); поколоночные
  // суммы sumStmt выше по категориям их не фильтруют, как и на графиках в приложении.
  const totalStmt = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS s FROM transactions
    WHERE substr(date, 1, 7) = ? AND type = ? AND excluded_from_total = 0 ${hasRange ? 'AND date >= ? AND date <= ?' : ''}
  `);

  months.forEach((month) => {
    const row = [month];
    const rangeArgs = hasRange ? [from, to] : [];
    categories.forEach((c) => row.push(sumStmt.get(month, c.id, c.id, ...rangeArgs).s || 0));
    const income = totalStmt.get(month, 'income', ...rangeArgs).s;
    const expense = totalStmt.get(month, 'expense', ...rangeArgs).s;
    row.push(income, expense, income - expense);
    summarySheet.addRow(row);
  });

  return workbook;
}

router.get('/', async (req, res) => {
  // try/catch обязателен здесь, а не факультативен: Express 4 не ловит сам
  // отклонённый promise async-хендлера (в отличие от синхронного throw) — без
  // этого любая ошибка внутри (например, обрыв записи в res, если пользователь
  // отменил скачивание на середине) становится unhandled rejection, а с Node
  // 15+ это по умолчанию роняет процесс целиком, а не только этот запрос
  // (проверено отдельным репро — тот же паттерн валит процесс сразу).
  try {
    const { from, to } = req.query;
    const hasRange = isValidDate(from) && isValidDate(to);
    if ((from || to) && !hasRange) {
      return res.status(400).json({ error: 'Некорректный диапазон дат' });
    }
    const workbook = buildWorkbook(hasRange ? { from, to } : {});
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const suffix = hasRange ? `${from}_${to}` : new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename="smeta-export-${suffix}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: 'Ошибка при экспорте: ' + e.message });
    else res.end();
  }
});

module.exports = router;
module.exports.buildWorkbook = buildWorkbook;
