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
//
// ВАЖНО: txDepth — счётчик на уровне модуля, общий на все вызовы сразу. Это
// безопасно только потому, что ни один fn, переданный в db.transaction()
// нигде в проекте, не содержит await — вся функция от BEGIN/SAVEPOINT до
// COMMIT/RELEASE выполняется одним синхронным куском, event loop не может
// вклиниться с чужим db.transaction() посередине. Если когда-нибудь
// понадобится async fn внутри транзакции — эта схема сломается (два
// одновременных вызова будут делить один и тот же txDepth и путать глубину
// вложенности SAVEPOINT). Не передавай сюда async-функцию.
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

  -- Какие уведомления о лимитах категорий пользователь уже закрыл крестиком —
  -- пока не закрыто, уведомление показывается заново при каждом открытии
  -- приложения (см. routes/limits.js). period — "YYYY-MM" для месячных лимитов,
  -- "YYYY" для годовых; отдельная запись на (категория, тип лимита, тип
  -- уведомления, период) — новый период сам по себе "забывает" старое закрытие.
  CREATE TABLE IF NOT EXISTS limit_notification_dismissals (
    category_id INTEGER NOT NULL REFERENCES categories(id),
    limit_type TEXT NOT NULL CHECK (limit_type IN ('month', 'year')),
    notification_type TEXT NOT NULL CHECK (notification_type IN ('approaching', 'exceeded')),
    period TEXT NOT NULL,
    dismissed_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (category_id, limit_type, notification_type, period)
  );

  -- «Пропустить» на карточке-подсказке повторяющейся операции (см.
  -- routes/recurring.js) — не для этого периода, но сама пометка is_recurring
  -- на операции остаётся, подсказка вернётся в следующем периоде. ON DELETE
  -- CASCADE — если удалить саму операцию-источник, её отклонённые подсказки
  -- больше не нужны (иначе FK с foreign_keys=ON заблокировал бы удаление).
  CREATE TABLE IF NOT EXISTS recurring_dismissals (
    source_transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    period TEXT NOT NULL,
    dismissed_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (source_transaction_id, period)
  );

  -- Отдельная от limit_notification_dismissals выше — та привязана к
  -- category_id (NOT NULL + FK), а общий бюджет ни к какой категории не
  -- относится, только месяц (см. routes/limits.js). limit_type не нужен —
  -- общий бюджет пока только месячный, не годовой (осознанный выбор).
  CREATE TABLE IF NOT EXISTS overall_budget_notification_dismissals (
    notification_type TEXT NOT NULL CHECK (notification_type IN ('approaching', 'exceeded')),
    period TEXT NOT NULL,
    dismissed_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (notification_type, period)
  );

  -- Корзина последних удалённых операций (см. routes/transactions.js DELETE
  -- /:id). Раньше отмена удаления жила только в памяти вкладки и работала
  -- только для самого последнего удаления, сбрасываясь при любом другом
  -- действии — теперь это снимок на бэкенде, переживает перезапуск и любые
  -- другие действия, и таких снимков хранится последних 10 (обрезка — в
  -- самом DELETE-роуте). category_name — снимок на момент удаления, а не
  -- живой JOIN: категория могла быть потом переименована или вовсе удалена,
  -- запись в корзине должна остаться читаемой в любом случае. Операции
  -- старше 10-й по-прежнему можно найти только в бэкапах (см. backup.js).
  CREATE TABLE IF NOT EXISTS deleted_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('expense', 'income')),
    category_id INTEGER,
    category_name TEXT NOT NULL,
    amount REAL NOT NULL,
    note TEXT DEFAULT '',
    excluded_from_total INTEGER NOT NULL DEFAULT 0,
    is_recurring INTEGER NOT NULL DEFAULT 0,
    auto_confirm INTEGER NOT NULL DEFAULT 0,
    uuid TEXT,
    deleted_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Черновик прогноза бюджета на месяц (см. routes/budget-forecast.js) —
  -- гипотетические доход/расходы, которые пользователь прикидывает заранее
  -- ("хватит ли на новую клавиатуру"), намеренно НЕ создают ни одной строки
  -- в transactions и никак не влияют на реальные суммы/отчёты. period —
  -- "YYYY-MM", один черновик на месяц (не список — упрощение: конкурирующих
  -- сценариев на один месяц не предполагается).
  CREATE TABLE IF NOT EXISTS budget_drafts (
    period TEXT PRIMARY KEY,
    income REAL NOT NULL DEFAULT 0,
    one_off_name TEXT NOT NULL DEFAULT '',
    one_off_amount REAL NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Планируемая сумма по категории внутри черновика. ON DELETE CASCADE и на
  -- period (черновик очищен целиком — PUT ниже переcохраняет все строки
  -- разом), и на category_id — если пользователь удаляет саму категорию,
  -- строка прогноза по ней тихо исчезает вместе с ней, а не блокирует
  -- удаление категории и не остаётся висеть на несуществующей ссылке (тот
  -- же класс FK-проверки, что для goals/rollup, см. CLAUDE.md, только через
  -- каскад в схеме, а не ручную проверку в роуте — черновик ничем не рискует
  -- при таком удалении, в отличие от реальных операций/целей).
  CREATE TABLE IF NOT EXISTS budget_draft_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period TEXT NOT NULL REFERENCES budget_drafts(period) ON DELETE CASCADE,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    amount REAL NOT NULL,
    UNIQUE(period, category_id)
  );
`);

// Миграция: колонка rollup_id могла отсутствовать в базе, созданной до появления целей.
// Она указывает, что сумма этой категории на Дашборде должна суммироваться в другую категорию
// (например, отдельная категория цели "на ноутбук и айфон" учитывается как "Сбережения").
const categoryColumns = db.prepare('PRAGMA table_info(categories)').all().map((c) => c.name);
if (!categoryColumns.includes('rollup_id')) {
  db.exec('ALTER TABLE categories ADD COLUMN rollup_id INTEGER REFERENCES categories(id)');
}
// Необязательные лимиты трат по категории — месяц и год независимо, оба NULL,
// пока не заданы (см. routes/limits.js). Только категории расходов ими
// пользуются (валидируется в routes/limits.js), но колонки на categories в
// целом — проще, чем отдельная таблица один-к-одному.
if (!categoryColumns.includes('monthly_limit')) {
  db.exec('ALTER TABLE categories ADD COLUMN monthly_limit REAL');
}
if (!categoryColumns.includes('yearly_limit')) {
  db.exec('ALTER TABLE categories ADD COLUMN yearly_limit REAL');
}
// Операция «нал.» — доход наличными, который не должен раздувать официальный
// итог (шапка «Доход» за месяц/год, Баланс, Excel-сводка), но должен остаться
// виден в разбивке по категориям и на графиках (см. routes/summary.js —
// categoryBreakdown() её не фильтрует, а плоские SUM(amount) по типу — да).
const transactionColumns = db.prepare('PRAGMA table_info(transactions)').all().map((c) => c.name);
if (!transactionColumns.includes('excluded_from_total')) {
  db.exec('ALTER TABLE transactions ADD COLUMN excluded_from_total INTEGER NOT NULL DEFAULT 0');
}
// Повторяющаяся операция (см. routes/recurring.js) — не более одной активной
// на (category_id, type) одновременно, это инвариант, который поддерживают
// сами роуты записи (transactions.js POST/PUT и recurring.js confirm снимают
// флаг со старой при установке на новую), а не проверка в БД.
if (!transactionColumns.includes('is_recurring')) {
  db.exec('ALTER TABLE transactions ADD COLUMN is_recurring INTEGER NOT NULL DEFAULT 0');
}
// Только имеет смысл вместе с is_recurring=1 — «добавлять автоматически, не
// спрашивая» вместо карточки-подсказки (см. routes/recurring.js GET
// /suggestions и public/app.js loadRecurringSuggestions). Переносится на
// новую операцию вместе с самим is_recurring при подтверждении/авто-добавлении
// следующего месяца (routes/recurring.js confirm) — иначе автодобавление
// сработало бы только один раз и молча превратилось бы обратно в подсказку.
if (!transactionColumns.includes('auto_confirm')) {
  db.exec('ALTER TABLE transactions ADD COLUMN auto_confirm INTEGER NOT NULL DEFAULT 0');
}
// Стабильный идентификатор операции, переживающий экспорт/импорт — основа
// "умного" переноса между устройствами без сервера (см. routes/import.js):
// раньше импорт мог только "это точно новая" или "это точный дубль по всем
// полям", поэтому отредактированная на одном устройстве операция при
// повторном импорте на другом создавала дубль вместо обновления. uuid как
// последняя колонка в Excel-экспорте (см. routes/export.js, тот же принцип,
// что «Метка»/«Повтор.») позволяет импорту найти "ту же" операцию и
// обновить, а не задвоить. Бэкфилл ниже — чтобы это работало и для операций,
// созданных до этой миграции, не только для новых.
if (!transactionColumns.includes('uuid')) {
  db.exec('ALTER TABLE transactions ADD COLUMN uuid TEXT');
  const { randomUUID } = require('crypto');
  const withoutUuid = db.prepare('SELECT id FROM transactions WHERE uuid IS NULL').all();
  const setUuid = db.prepare('UPDATE transactions SET uuid = ? WHERE id = ?');
  db.transaction(() => { withoutUuid.forEach((r) => setUuid.run(randomUUID(), r.id)); })();
}
// deleted_transactions уже существовало (не CREATE TABLE-время-фичи) до
// добавления auto_confirm выше — та же ALTER-миграция нужна и здесь, иначе
// на уже созданных БД снимок при удалении падал бы на нехватке колонки.
const deletedTransactionColumns = db.prepare('PRAGMA table_info(deleted_transactions)').all().map((c) => c.name);
if (!deletedTransactionColumns.includes('auto_confirm')) {
  db.exec('ALTER TABLE deleted_transactions ADD COLUMN auto_confirm INTEGER NOT NULL DEFAULT 0');
}
if (!deletedTransactionColumns.includes('uuid')) {
  db.exec('ALTER TABLE deleted_transactions ADD COLUMN uuid TEXT');
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
  db.exec('DELETE FROM limit_notification_dismissals');
  db.exec('DELETE FROM recurring_dismissals');
  db.exec('DELETE FROM overall_budget_notification_dismissals');
  db.exec('DELETE FROM deleted_transactions');
  // Черновики прогноза ссылаются на category_id — после DELETE FROM categories
  // выше эти ссылки уже не на что указывали бы (см. auto_confirm/uuid чек-лист
  // в CLAUDE.md: любое новое хранилище нужно явно продумать на «Удалить все
  // данные»). budget_draft_items чистится сам через ON DELETE CASCADE от
  // budget_drafts, поэтому отдельного DELETE для него не нужно.
  db.exec('DELETE FROM budget_drafts');
  // В отличие от currency/onboarding_seen (настройки приложения, resetAllData
  // их не трогает) — общий бюджет и точка отсчёта сверки с картой это
  // финансовое планирование, того же рода, что monthly_limit у категорий
  // (который стирается вместе с DELETE FROM categories выше), поэтому их
  // тоже сбрасываем. Точку отсчёта — по той же причине ещё и потому, что она
  // ссылается на остаток, накопленный по операциям, которых после сброса
  // больше не существует: оставить её значило бы показывать на пустом
  // Дашборде карточку сверки, посчитанную по несуществующим данным (найдено
  // и исправлено вскоре после того, как сама фича появилась).
  db.exec("DELETE FROM app_settings WHERE key IN ('overall_monthly_budget', 'reconciliation_anchor_date', 'reconciliation_anchor_amount')");
  insertDefaultCategories();
});

// Открыт наружу для backup.js — бэкапы кладутся в подпапку той же DATA_DIR,
// что и сама база (desktop: Application Support, веб: ./data), а не куда-то
// ещё, чтобы жить рядом и переживать то же самое обновление приложения.
db.DATA_DIR = DATA_DIR;

module.exports = db;
