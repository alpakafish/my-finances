const express = require('express');
const ExcelJS = require('exceljs');
const db = require('../db');

const router = express.Router();

router.get('/', async (req, res) => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Мои финансы';
  workbook.created = new Date();

  const txSheet = workbook.addWorksheet('Операции');
  txSheet.columns = [
    { header: 'Дата', key: 'date', width: 12 },
    { header: 'Тип', key: 'type', width: 10 },
    { header: 'Категория', key: 'category', width: 22 },
    { header: 'Сумма', key: 'amount', width: 14 },
    { header: 'Заметка', key: 'note', width: 30 },
  ];
  txSheet.getRow(1).font = { bold: true };

  const transactions = db.prepare(`
    SELECT t.date, t.type, c.name AS category, t.amount, t.note
    FROM transactions t JOIN categories c ON c.id = t.category_id
    ORDER BY t.date, t.id
  `).all();

  transactions.forEach((t) => {
    txSheet.addRow({
      date: t.date,
      type: t.type === 'expense' ? 'Расход' : 'Доход',
      category: t.category,
      amount: t.amount,
      note: t.note,
    });
  });

  const months = db.prepare(`
    SELECT DISTINCT substr(date, 1, 7) AS month FROM transactions ORDER BY month
  `).all().map((r) => r.month);

  // Категории с rollup_id (например, отдельные категории целей) сюда отдельными столбцами
  // не попадают — их суммы включены в столбец целевой категории (обычно «Сбережения»).
  const categories = db.prepare('SELECT id, name, type FROM categories WHERE rollup_id IS NULL ORDER BY type, sort_order').all();

  const summarySheet = workbook.addWorksheet('Сводка по месяцам');
  const header = ['Месяц', ...categories.map((c) => `${c.name} (${c.type === 'expense' ? 'расход' : 'доход'})`), 'Доход', 'Расход', 'Баланс'];
  summarySheet.addRow(header);
  summarySheet.getRow(1).font = { bold: true };
  summarySheet.columns.forEach((col, i) => { col.width = i === 0 ? 12 : 20; });

  const sumStmt = db.prepare(`
    SELECT COALESCE(SUM(t.amount), 0) AS s
    FROM transactions t JOIN categories c ON c.id = t.category_id
    WHERE substr(t.date, 1, 7) = ? AND (t.category_id = ? OR c.rollup_id = ?)
  `);
  const totalStmt = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS s FROM transactions
    WHERE substr(date, 1, 7) = ? AND type = ?
  `);

  months.forEach((month) => {
    const row = [month];
    categories.forEach((c) => row.push(sumStmt.get(month, c.id, c.id).s || 0));
    const income = totalStmt.get(month, 'income').s;
    const expense = totalStmt.get(month, 'expense').s;
    row.push(income, expense, income - expense);
    summarySheet.addRow(row);
  });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="smeta-export-${new Date().toISOString().slice(0, 10)}.xlsx"`);
  await workbook.xlsx.write(res);
  res.end();
});

module.exports = router;
