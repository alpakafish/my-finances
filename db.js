const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'smeta.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('expense', 'income')),
    color TEXT NOT NULL DEFAULT '#888780',
    sort_order INTEGER NOT NULL DEFAULT 0,
    UNIQUE(name, type)
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('expense', 'income')),
    category_id INTEGER NOT NULL REFERENCES categories(id),
    amount REAL NOT NULL,
    note TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    target_amount REAL NOT NULL,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    duration_months INTEGER,
    start_date TEXT NOT NULL DEFAULT (date('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Миграция: колонка rollup_id могла отсутствовать в базе, созданной до появления целей.
// Она указывает, что сумма этой категории на Дашборде должна суммироваться в другую категорию
// (например, отдельная категория цели "на ноутбук и айфон" учитывается как "Сбережения").
const categoryColumns = db.prepare('PRAGMA table_info(categories)').all().map((c) => c.name);
if (!categoryColumns.includes('rollup_id')) {
  db.exec('ALTER TABLE categories ADD COLUMN rollup_id INTEGER REFERENCES categories(id)');
}

const DEFAULT_EXPENSE_CATEGORIES = [
  ['Еда', '#7F77DD'], ['Алкоголь', '#D85A30'], ['Счета', '#378ADD'],
  ['Покупки маркетплейсы', '#EF9F27'], ['Одежда', '#D4537E'], ['Другое', '#888780'],
  ['Растения', '#639922'], ['Собаки', '#BA7517'], ['Аптека', '#A32D2D'],
  ['Бытовая химия', '#5DCAA5'], ['Подарки', '#534AB7'], ['Отпуск', '#0F6E56'],
  ['Игры', '#185FA5'], ['Для дома', '#5F5E5A'], ['Здоровье', '#E24B4A'],
  ['Уход', '#993556'], ['Транспорт', '#444441'], ['Подписка', '#3C3489'],
  ['Сбережения', '#1D9E75'],
];

const DEFAULT_INCOME_CATEGORIES = [
  ['Зарплата', '#1D9E75'], ['Подработка', '#378ADD'], ['Прочий доход', '#888780'],
];

function seedCategories() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM categories').get().n;
  if (count > 0) return;
  const insert = db.prepare('INSERT INTO categories (name, type, color, sort_order) VALUES (?, ?, ?, ?)');
  const seedAll = db.transaction(() => {
    DEFAULT_EXPENSE_CATEGORIES.forEach(([name, color], i) => insert.run(name, 'expense', color, i));
    DEFAULT_INCOME_CATEGORIES.forEach(([name, color], i) => insert.run(name, 'income', color, i));
  });
  seedAll();
}

seedCategories();

module.exports = db;
