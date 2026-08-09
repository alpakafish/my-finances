// Разовый скрипт: наполняет базу правдоподобными, но выдуманными данными — только для
// скриншотов в публичном README. Реальные данные пользователя предварительно сохранены
// отдельно и восстанавливаются после съёмки скриншотов (см. restore-real-data.js).
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'smeta.db');
for (const suffix of ['', '-wal', '-shm']) {
  const p = DB_PATH + suffix;
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

const db = require('../db'); // пересоздаст схему и посеет дефолтные категории

function catId(name, type) {
  const row = db.prepare('SELECT id FROM categories WHERE name = ? AND type = ?').get(name, type);
  if (!row) throw new Error(`Категория не найдена: ${name} (${type})`);
  return row.id;
}

const addTx = db.prepare('INSERT INTO transactions (date, type, category_id, amount, note) VALUES (?, ?, ?, ?, ?)');

const MONTHS = ['2026-05', '2026-06', '2026-07', '2026-08'];

const EXPENSE_PLAN = {
  'Еда': [22000, 24500, 21000, 38000], // заметный скачок в августе — для демонстрации рекомендаций
  'Транспорт': [6000, 6500, 15000, 4000], // и заметное снижение
  'Счета': [12000, 12500, 12000, 12500],
  'Одежда': [4000, 0, 9000, 2000],
  'Развлечения': [5000, 8000, 6000, 7000],
  'Аптека': [1200, 0, 2400, 800],
  'Подписка': [990, 990, 1490, 1490],
  'Другое': [3000, 4500, 2000, 3500],
};

const INCOME_PLAN = {
  'Зарплата': [110000, 110000, 115000, 115000],
  'Подработка': [8000, 0, 12000, 5000],
};

function seedPlan(plan, type) {
  const days = [3, 8, 12, 17, 22, 27];
  Object.entries(plan).forEach(([catName, amounts]) => {
    amounts.forEach((amount, i) => {
      if (amount <= 0) return;
      const day = days[i % days.length];
      const date = `${MONTHS[i]}-${String(day).padStart(2, '0')}`;
      addTx.run(date, type, catId(catName, type), amount, '');
    });
  });
}

// добавим недостающие категории демо-плана, которых нет в дефолтном наборе
function ensureCategory(name, type, color) {
  const exists = db.prepare('SELECT id FROM categories WHERE name = ? AND type = ?').get(name, type);
  if (!exists) {
    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) m FROM categories WHERE type = ?').get(type).m;
    db.prepare('INSERT INTO categories (name, type, color, sort_order) VALUES (?, ?, ?, ?)')
      .run(name, type, color, maxOrder + 1);
  }
}
ensureCategory('Развлечения', 'expense', '#EF9F27');

seedPlan(EXPENSE_PLAN, 'expense');
seedPlan(INCOME_PLAN, 'income');

// пара целей накопления для вкладки «Цели»
const savingsId = catId('Сбережения', 'expense');
const vacationId = catId('Отпуск', 'expense');

const goal1 = db.prepare(
  'INSERT INTO goals (name, target_amount, category_id, duration_months, start_date) VALUES (?, ?, ?, ?, ?)'
).run('Отпуск в Грузии', 120000, vacationId, 6, '2026-06-01');
addTx.run('2026-06-05', 'expense', vacationId, 25000, 'Взнос в цель «Отпуск в Грузии»');
addTx.run('2026-07-05', 'expense', vacationId, 23000, 'Взнос в цель «Отпуск в Грузии»');

const laptopCatId = db.prepare(
  'INSERT INTO categories (name, type, color, sort_order, rollup_id) VALUES (?, ?, ?, ?, ?)'
).run('на ноутбук', 'expense', '#3C3489',
  db.prepare('SELECT COALESCE(MAX(sort_order), -1) m FROM categories WHERE type = ?').get('expense').m + 1,
  savingsId
).lastInsertRowid;
db.prepare(
  'INSERT INTO goals (name, target_amount, category_id, duration_months, start_date) VALUES (?, ?, ?, ?, ?)'
).run('Новый ноутбук', 90000, laptopCatId, 3, '2026-06-15');
addTx.run('2026-06-20', 'expense', laptopCatId, 90000, 'Взнос в цель «Новый ноутбук»');

console.log('Демо-данные готовы:', db.prepare('SELECT COUNT(*) c FROM transactions').get().c, 'операций,',
  db.prepare('SELECT COUNT(*) c FROM goals').get().c, 'цели');
