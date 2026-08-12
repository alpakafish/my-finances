const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

// DATA_DIR можно переопределить (desktop-приложение указывает сюда каталог
// Application Support, чтобы БД не лежала внутри .app и переживала обновления).
// Веб-версия переменную не задаёт и, как и раньше, использует ./data рядом с проектом.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'smeta.db'));

// node:sqlite (встроен в Node, начиная с 22 LTS — компиляции не требует, в отличие от
// better-sqlite3, который на некоторых машинах пытается собираться из исходников и падает
// без настроенных инструментов сборки C++) не имеет .pragma()/.transaction() — весь
// остальной код (routes/*.js) написан под API better-sqlite3, поэтому просто дописываем
// эти два метода поверх встроенного драйвера, чтобы больше нигде ничего не менять.
db.pragma = (str) => db.exec(`PRAGMA ${str}`);

// SAVEPOINT-совместимая реализация — better-sqlite3 умеет вкладывать .transaction() друг
// в друга (routes/import.js так и делает: findOrCreateCategory внутри runImport), обычный
// голый BEGIN/COMMIT этого не позволяет ("cannot start a transaction within a transaction").
let txDepth = 0;
db.transaction = (fn) => (...args) => {
  const savepoint = `sp_${txDepth}`;
  const isOuter = txDepth === 0;
  txDepth++;
  try {
    db.exec(isOuter ? 'BEGIN' : `SAVEPOINT ${savepoint}`);
    const result = fn(...args);
    db.exec(isOuter ? 'COMMIT' : `RELEASE ${savepoint}`);
    return result;
  } catch (e) {
    if (isOuter) {
      db.exec('ROLLBACK');
    } else {
      db.exec(`ROLLBACK TO ${savepoint}`);
      db.exec(`RELEASE ${savepoint}`);
    }
    throw e;
  } finally {
    txDepth--;
  }
};

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

  -- Настройки самого приложения (не финансовые данные) — сейчас только флаг
  -- «онбординг уже показывали». Раньше жил в localStorage, но у desktop-версии
  -- порт бэкенда случайный на каждый запуск (см. server.js), а localStorage
  -- привязан к origin вида http://127.0.0.1:<порт> — с новым портом на каждом
  -- запуске флаг оказывался в другом origin и не находился. В БД он переживает
  -- любой порт.
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
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

function insertDefaultCategories() {
  const insert = db.prepare('INSERT INTO categories (name, type, color, sort_order) VALUES (?, ?, ?, ?)');
  DEFAULT_EXPENSE_CATEGORIES.forEach(([name, color], i) => insert.run(name, 'expense', color, i));
  DEFAULT_INCOME_CATEGORIES.forEach(([name, color], i) => insert.run(name, 'income', color, i));
}

function seedCategories() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM categories').get().n;
  if (count > 0) return;
  db.transaction(insertDefaultCategories)();
}

seedCategories();

// Настройки → «Удалить все данные»: полностью очищает операции/цели/категории и
// возвращает категории к значениям по умолчанию (иначе форма добавления операции
// осталась бы без единой категории на выбор — приложение стало бы нерабочим).
db.resetAllData = db.transaction(() => {
  db.exec('DELETE FROM transactions');
  db.exec('DELETE FROM goals');
  db.exec('DELETE FROM categories');
  insertDefaultCategories();
});

module.exports = db;
