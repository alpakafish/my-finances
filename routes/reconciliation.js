const express = require('express');
const db = require('../db');

const router = express.Router();

// Точка отсчёта для ручной сверки с картой: дата + сумма, от которой считается
// накопительный остаток (в отличие от «Баланс» на Дашборде — тот всегда только
// за один месяц, без переноса, см. routes/summary.js). В app_settings, а не
// отдельной таблицей — тот же принцип, что currency/overall_monthly_budget
// (routes/settings.js, routes/limits.js): единственная пара значений на всё
// приложение, ключ-значение проще отдельной таблицы из одной строки.
// Отсутствие обоих ключей — это осознанное состояние «не задано», а не 0/0:
// пока пользователь ничего не ввёл в Настройках, карточка на Дашборде вообще
// не показывается (см. public/app.js loadReconciliationCard).
function getAnchor() {
  const dateRow = db.prepare("SELECT value FROM app_settings WHERE key = 'reconciliation_anchor_date'").get();
  const amountRow = db.prepare("SELECT value FROM app_settings WHERE key = 'reconciliation_anchor_amount'").get();
  if (!dateRow || !amountRow) return null;
  return { anchor_date: dateRow.value, anchor_amount: Number(amountRow.value) };
}

function setAnchor(date, amount) {
  db.transaction(() => {
    db.prepare(`
      INSERT INTO app_settings (key, value) VALUES ('reconciliation_anchor_date', ?)
      ON CONFLICT(key) DO UPDATE SET value = ?
    `).run(date, date);
    db.prepare(`
      INSERT INTO app_settings (key, value) VALUES ('reconciliation_anchor_amount', ?)
      ON CONFLICT(key) DO UPDATE SET value = ?
    `).run(String(amount), String(amount));
  })();
}

function clearAnchor() {
  db.transaction(() => {
    db.exec("DELETE FROM app_settings WHERE key = 'reconciliation_anchor_date'");
    db.exec("DELETE FROM app_settings WHERE key = 'reconciliation_anchor_amount'");
  })();
}

// Границы месяца как полуоткрытый интервал [anchor_date, следующий месяц) —
// не substr(date,1,7) = ?, как в summary.js, потому что здесь копится диапазон
// от anchor_date (любой день, не обязательно 1-е число) по конец выбранного
// месяца, а не один календарный месяц.
function firstDayOfNextMonth(month) {
  const [y, m] = month.split('-').map(Number);
  const next = new Date(y, m, 1); // m уже "1-индексирован" как аргумент — Date получает следующий месяц
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-01`;
}

router.get('/', (req, res) => {
  const anchor = getAnchor();
  res.json(anchor || { anchor_date: null, anchor_amount: null });
});

router.put('/', (req, res) => {
  const { anchor_date, anchor_amount } = req.body;
  if (typeof anchor_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(anchor_date)) {
    return res.status(400).json({ error: 'Некорректная дата точки отсчёта' });
  }
  const amount = Number(anchor_amount);
  if (!Number.isFinite(amount)) {
    return res.status(400).json({ error: 'Сумма должна быть числом' });
  }
  setAnchor(anchor_date, amount);
  res.json(getAnchor());
});

router.delete('/', (req, res) => {
  clearAnchor();
  res.status(204).end();
});

// Ожидаемый остаток на конец :month = anchor_amount + (доход − расход) по всем
// операциям с anchor_date по конец месяца включительно. excluded_from_total —
// тот же фильтр, что у помесячных итогов (routes/summary.js), «нал.»-доход не
// должен раздувать сумму здесь так же, как не раздувает «Баланс» на Дашборде.
router.get('/:month', (req, res) => {
  const { month } = req.params;
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'Некорректный месяц' });
  }
  const anchor = getAnchor();
  if (!anchor) return res.json({ set: false });

  // Месяц раньше месяца точки отсчёта — «накопительный остаток с X» не имеет
  // смысла для периода до X. Без этой проверки date >= anchor_date AND date <
  // конец_запрошенного_месяца получался перевёрнутым диапазоном (нижняя
  // граница позже верхней), молча находил 0 строк и отдавал since_net=0 —
  // выглядело так, будто с точки отсчёта вообще ничего не происходило, хотя
  // на самом деле вопрос просто не про этот период. Сравнение строк работает
  // корректно для формата YYYY-MM (тот же порядок, что и хронологический).
  const anchorMonth = anchor.anchor_date.slice(0, 7);
  if (month < anchorMonth) return res.json({ set: false });

  const upperBound = firstDayOfNextMonth(month);
  const netRow = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE -amount END), 0) AS net
    FROM transactions
    WHERE excluded_from_total = 0 AND date >= ? AND date < ?
  `).get(anchor.anchor_date, upperBound);

  res.json({
    set: true,
    anchor_date: anchor.anchor_date,
    anchor_amount: anchor.anchor_amount,
    since_net: netRow.net,
    expected: anchor.anchor_amount + netRow.net,
  });
});

module.exports = router;
