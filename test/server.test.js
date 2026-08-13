// Интеграционный тест общего бэкенда (server.js/db.js/routes/*) — того самого
// кода, что использует и веб-версия, и desktop-приложение. Поднимает реальный
// процесс на случайном порту с временным DATA_DIR, бьёт по нему http.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// На Windows файл smeta.db остаётся заблокированным ОС ещё какое-то короткое время
// после kill() дочернего процесса (в отличие от POSIX, где unlink открытого файла
// работает всегда) — без retry здесь падает EBUSY. maxRetries/retryDelay — штатный
// способ fs.rmSync справиться с этим (см. доки Node: ретраит на EBUSY/EPERM/и т.п.).
function removeDataDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function startServer(dataDir) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT: '0', DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => reject(new Error('server did not start in time')), 10_000);
    proc.stdout.on('data', (d) => {
      const m = d.toString().match(/:(\d+)$/m);
      if (m) {
        clearTimeout(timer);
        resolve({ proc, baseUrl: `http://127.0.0.1:${m[1]}` });
      }
    });
    proc.stderr.on('data', (d) => process.stderr.write(`[server stderr] ${d}`));
    proc.on('exit', (code) => { if (code !== 0 && code !== null) reject(new Error(`server exited early with ${code}`)); });
  });
}

let child;
let baseUrl;
const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smeta-test-'));

before(async () => {
  ({ proc: child, baseUrl } = await startServer(tmpDataDir));
});

after(async () => {
  child.kill('SIGTERM');
  removeDataDir(tmpDataDir);
});

test('seeds default categories on first launch', async () => {
  const res = await fetch(`${baseUrl}/api/categories`);
  assert.equal(res.status, 200);
  const categories = await res.json();
  assert.ok(categories.length >= 20);
  assert.ok(categories.some((c) => c.name === 'Еда' && c.type === 'expense'));
});

test('transaction CRUD round-trip', async () => {
  const categories = await (await fetch(`${baseUrl}/api/categories`)).json();
  const food = categories.find((c) => c.name === 'Еда');

  const createRes = await fetch(`${baseUrl}/api/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: '2026-08-01', type: 'expense', category_id: food.id, amount: 1234.5, note: 'test' }),
  });
  assert.equal(createRes.status, 201);
  const created = await createRes.json();
  assert.equal(created.amount, 1234.5);

  const listRes = await fetch(`${baseUrl}/api/transactions?month=2026-08`);
  const list = await listRes.json();
  assert.ok(list.some((t) => t.id === created.id));

  const transport = categories.find((c) => c.name === 'Транспорт') || categories.find((c) => c.type === 'expense' && c.id !== food.id);
  const editRes = await fetch(`${baseUrl}/api/transactions/${created.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: '2026-09-01', type: 'expense', category_id: transport.id, amount: 777, note: 'edited' }),
  });
  assert.equal(editRes.status, 200);
  const edited = await editRes.json();
  assert.equal(edited.amount, 777);
  assert.equal(edited.category_id, transport.id);
  assert.equal(edited.date, '2026-09-01');

  const oldMonthList = await (await fetch(`${baseUrl}/api/transactions?month=2026-08`)).json();
  assert.ok(!oldMonthList.some((t) => t.id === created.id), 'edited transaction should move out of its old month');
  const newMonthList = await (await fetch(`${baseUrl}/api/transactions?month=2026-09`)).json();
  assert.ok(newMonthList.some((t) => t.id === created.id && t.amount === 777), 'edited transaction should appear in its new month with new amount');

  const summaryAfterEdit = await (await fetch(`${baseUrl}/api/summary/2026-09`)).json();
  assert.ok(summaryAfterEdit.totalExpense >= 777, 'monthly summary should reflect the edited transaction');

  const delRes = await fetch(`${baseUrl}/api/transactions/${created.id}`, { method: 'DELETE' });
  assert.equal(delRes.status, 204);
});

test('deleting a category in use: rejects without a choice, supports reassign and delete-transactions', async () => {
  const makeCat = async (name) => (await fetch(`${baseUrl}/api/categories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, type: 'expense', color: '#123456' }),
  })).json();

  // Плейн-удаление без операций работает сразу — не задевает сценарий с usageCount ниже.
  const empty = await makeCat('Пустая категория для удаления');
  const emptyDelRes = await fetch(`${baseUrl}/api/categories/${empty.id}`, { method: 'DELETE' });
  assert.equal(emptyDelRes.status, 204);

  // Без reassignTo/deleteTransactions — 409 с usageCount, категория и операция остаются на месте
  // (см. public/app.js showCategoryDeleteModal — на это опирается UI).
  const doomed = await makeCat('Категория с операциями');
  const other = await makeCat('Другая категория');
  const tx = await (await fetch(`${baseUrl}/api/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: '2026-08-01', type: 'expense', category_id: doomed.id, amount: 500, note: 'in use' }),
  })).json();

  const blockedRes = await fetch(`${baseUrl}/api/categories/${doomed.id}`, { method: 'DELETE' });
  assert.equal(blockedRes.status, 409);
  const blockedBody = await blockedRes.json();
  assert.equal(blockedBody.usageCount, 1);
  const stillThere = await (await fetch(`${baseUrl}/api/categories`)).json();
  assert.ok(stillThere.some((c) => c.id === doomed.id), 'category should survive a blocked delete attempt');

  // reassignTo — операция переезжает в другую категорию, старая категория удаляется.
  const reassignRes = await fetch(`${baseUrl}/api/categories/${doomed.id}?reassignTo=${other.id}`, { method: 'DELETE' });
  assert.equal(reassignRes.status, 204);
  const afterReassign = await (await fetch(`${baseUrl}/api/transactions?month=2026-08`)).json();
  const movedTx = afterReassign.find((t) => t.id === tx.id);
  assert.ok(movedTx, 'transaction should survive reassignment');
  assert.equal(movedTx.category_name, 'Другая категория');

  // deleteTransactions=true — категория и её операции удаляются вместе.
  const doomed2 = await makeCat('Категория с операциями 2');
  const tx2 = await (await fetch(`${baseUrl}/api/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: '2026-08-01', type: 'expense', category_id: doomed2.id, amount: 300, note: 'to be deleted' }),
  })).json();
  const deleteTxRes = await fetch(`${baseUrl}/api/categories/${doomed2.id}?deleteTransactions=true`, { method: 'DELETE' });
  assert.equal(deleteTxRes.status, 204);
  const afterDeleteTx = await (await fetch(`${baseUrl}/api/transactions?month=2026-08`)).json();
  assert.ok(!afterDeleteTx.some((t) => t.id === tx2.id), 'transaction should be gone along with its category');
  const catsAfter = await (await fetch(`${baseUrl}/api/categories`)).json();
  assert.ok(!catsAfter.some((c) => c.id === doomed2.id), 'category itself should be gone');
});

test('monthly summary reflects added transaction', async () => {
  const categories = await (await fetch(`${baseUrl}/api/categories`)).json();
  const salary = categories.find((c) => c.name === 'Зарплата');
  await fetch(`${baseUrl}/api/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: '2026-08-05', type: 'income', category_id: salary.id, amount: 1000, note: '' }),
  });
  const summary = await (await fetch(`${baseUrl}/api/summary/2026-08`)).json();
  assert.ok(summary.totalIncome >= 1000);
});

test('goal creation and contribution', async () => {
  const categories = await (await fetch(`${baseUrl}/api/categories`)).json();
  const savings = categories.find((c) => c.name === 'Сбережения');

  const goalRes = await fetch(`${baseUrl}/api/goals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Test goal', target_amount: 5000, category_id: savings.id, duration_months: 5 }),
  });
  assert.equal(goalRes.status, 201);
  const goal = await goalRes.json();
  assert.equal(goal.progress, 0);
  // На момент создания start_date === сегодня, так что monthsLeft должен ровно
  // совпасть с duration_months (5). Не ловит саму регрессию с округлением по
  // дню месяца, а не по дням (routes/goals.js monthsBetween, 2026-08-13) — тот
  // баг воспроизводится только на следующий день после создания цели (start_date
  // не задаётся через API, только date('now') на сервере), проверено вручную:
  // сегодня=2026-08-13, дедлайн=2026-12-12 → раньше 3 мес. (66 667/мес. вместо 50 000).
  assert.equal(goal.monthlyNeeded, 5000 / 5);

  const contribRes = await fetch(`${baseUrl}/api/goals/${goal.id}/contribute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: 500 }),
  });
  const updated = await contribRes.json();
  assert.equal(updated.progress, 500);
});

test('export from one instance re-imports cleanly on a fresh one (multi-device backup/restore)', async () => {
  const categories = await (await fetch(`${baseUrl}/api/categories`)).json();
  const food = categories.find((c) => c.name === 'Еда');
  const salary = categories.find((c) => c.name === 'Зарплата');

  const seed = [
    { date: '2026-05-03', type: 'expense', category_id: food.id, amount: 777.77, note: 'roundtrip note' },
    { date: '2026-05-10', type: 'income', category_id: salary.id, amount: 55000, note: '' },
  ];
  for (const tx of seed) {
    await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tx),
    });
  }

  const exportRes = await fetch(`${baseUrl}/api/export`);
  assert.equal(exportRes.status, 200);
  const xlsxBuffer = Buffer.from(await exportRes.arrayBuffer());

  // Свежий "второй девайс" — отдельный процесс, отдельная БД.
  const otherDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smeta-test-device2-'));
  const { proc: otherChild, baseUrl: otherBaseUrl } = await startServer(otherDataDir);
  try {
    const form = new FormData();
    form.append('file', new Blob([xlsxBuffer]), 'smeta-export.xlsx');
    const importRes = await fetch(`${otherBaseUrl}/api/import`, { method: 'POST', body: form });
    assert.equal(importRes.status, 200);
    // baseUrl накопил операции из предыдущих тестов этого файла — экспорт содержит
    // их все, поэтому проверяем не точное число, а что ничего не потерялось/не забраковано.
    const result = await importRes.json();
    assert.ok(result.imported >= seed.length);
    assert.equal(result.skippedInvalid, 0);

    const may = await (await fetch(`${otherBaseUrl}/api/transactions?month=2026-05`)).json();
    assert.equal(may.length, seed.length);
    const roundtrip = may.find((t) => t.note === 'roundtrip note');
    assert.ok(roundtrip);
    assert.equal(roundtrip.amount, 777.77);
    assert.equal(roundtrip.type, 'expense');
    assert.equal(roundtrip.category_name, 'Еда');
    assert.ok(may.some((t) => t.type === 'income' && t.amount === 55000));
  } finally {
    otherChild.kill('SIGTERM');
    removeDataDir(otherDataDir);
  }
});

test('settings: delete-all-data wipes transactions/goals and resets categories to defaults', async () => {
  // Собственный процесс/БД — не хотим тереть данные, накопленные другими тестами этого файла.
  const wipeDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smeta-test-wipe-'));
  const { proc: wipeChild, baseUrl: wipeBaseUrl } = await startServer(wipeDataDir);
  try {
    const categoriesBefore = await (await fetch(`${wipeBaseUrl}/api/categories`)).json();
    const food = categoriesBefore.find((c) => c.name === 'Еда');

    await fetch(`${wipeBaseUrl}/api/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-08-01', type: 'expense', category_id: food.id, amount: 10, note: '' }),
    });
    await fetch(`${wipeBaseUrl}/api/categories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Моя своя категория', type: 'expense', color: '#123456' }),
    });
    await fetch(`${wipeBaseUrl}/api/goals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Wipe goal', target_amount: 100, category_id: food.id }),
    });

    const delRes = await fetch(`${wipeBaseUrl}/api/settings/all-data`, { method: 'DELETE' });
    assert.equal(delRes.status, 204);

    const [tx, goals, categoriesAfter] = await Promise.all([
      fetch(`${wipeBaseUrl}/api/transactions`).then((r) => r.json()),
      fetch(`${wipeBaseUrl}/api/goals`).then((r) => r.json()),
      fetch(`${wipeBaseUrl}/api/categories`).then((r) => r.json()),
    ]);
    assert.equal(tx.length, 0);
    assert.equal(goals.length, 0);
    assert.equal(categoriesAfter.length, categoriesBefore.length);
    assert.ok(!categoriesAfter.some((c) => c.name === 'Моя своя категория'));
    assert.ok(categoriesAfter.some((c) => c.name === 'Еда' && c.type === 'expense'));

    // Приложение должно остаться рабочим сразу после сброса — можно добавить операцию.
    const newFood = categoriesAfter.find((c) => c.name === 'Еда');
    const addRes = await fetch(`${wipeBaseUrl}/api/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-08-01', type: 'expense', category_id: newFood.id, amount: 42, note: '' }),
    });
    assert.equal(addRes.status, 201);
  } finally {
    wipeChild.kill('SIGTERM');
    removeDataDir(wipeDataDir);
  }
});

test('onboarding-seen flag survives a restart on a different port (the desktop scenario)', async () => {
  // Desktop-версия каждый раз стартует бэкенд на новом случайном порту (PORT=0) —
  // именно поэтому флаг нельзя было хранить в localStorage (привязан к origin
  // http://127.0.0.1:<порт>). Тест эмулирует ровно это: два разных процесса/порта
  // на одном DATA_DIR, как при перезапуске desktop-приложения.
  const onboardDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smeta-test-onboard-'));
  try {
    const first = await startServer(onboardDataDir);
    const initial = await (await fetch(`${first.baseUrl}/api/settings/onboarding-seen`)).json();
    assert.equal(initial.seen, false);

    const putRes = await fetch(`${first.baseUrl}/api/settings/onboarding-seen`, { method: 'PUT' });
    assert.equal(putRes.status, 204);
    first.proc.kill('SIGTERM');

    // "Второй запуск" — новый процесс на другом (гарантированно отличном) порту.
    const second = await startServer(onboardDataDir);
    try {
      assert.notEqual(first.baseUrl, second.baseUrl);
      const afterRestart = await (await fetch(`${second.baseUrl}/api/settings/onboarding-seen`)).json();
      assert.equal(afterRestart.seen, true);
    } finally {
      second.proc.kill('SIGTERM');
    }
  } finally {
    removeDataDir(onboardDataDir);
  }
});

test('category spending limits: progress, notifications, dismissal, rollup intentionally ignored', async () => {
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const year = String(now.getFullYear());
  const today = now.toISOString().slice(0, 10);

  const makeCat = async (name) => (await fetch(`${baseUrl}/api/categories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, type: 'expense', color: '#123456' }),
  })).json();
  const addTx = (categoryId, amount) => fetch(`${baseUrl}/api/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: today, type: 'expense', category_id: categoryId, amount, note: '' }),
  });

  // Лимиты — только для категорий расходов.
  const categoriesNow = await (await fetch(`${baseUrl}/api/categories`)).json();
  const incomeCat = categoriesNow.find((c) => c.type === 'income');
  const rejectRes = await fetch(`${baseUrl}/api/limits/${incomeCat.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ monthly_limit: 100 }),
  });
  assert.equal(rejectRes.status, 400);

  const limited = await makeCat('Лимитная категория');
  const setRes = await fetch(`${baseUrl}/api/limits/${limited.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ monthly_limit: 1000, yearly_limit: 5000 }),
  });
  assert.equal(setRes.status, 200);
  assert.equal((await setRes.json()).monthly_limit, 1000);

  // Ничего не потрачено — 0%, без уведомлений.
  let progress = await (await fetch(`${baseUrl}/api/limits/progress?month=${month}`)).json();
  assert.equal(progress.find((r) => r.category_id === limited.id).pct, 0);
  let notifications = await (await fetch(`${baseUrl}/api/limits/notifications`)).json();
  assert.ok(!notifications.some((n) => n.category_id === limited.id));

  // 950 из 1000 = 95% — "приближается", не "превышен".
  await addTx(limited.id, 950);
  progress = await (await fetch(`${baseUrl}/api/limits/progress?month=${month}`)).json();
  let row = progress.find((r) => r.category_id === limited.id);
  assert.equal(row.spent, 950);
  assert.equal(row.pct, 95);
  assert.equal(row.exceeded, false);
  notifications = await (await fetch(`${baseUrl}/api/limits/notifications`)).json();
  let notif = notifications.find((n) => n.category_id === limited.id && n.limit_type === 'month');
  assert.equal(notif?.notification_type, 'approaching');

  // Закрываем — тут же пропадает из уведомлений.
  const dismissRes = await fetch(`${baseUrl}/api/limits/notifications/${limited.id}/dismiss`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit_type: 'month', notification_type: 'approaching', period: month }),
  });
  assert.equal(dismissRes.status, 204);
  notifications = await (await fetch(`${baseUrl}/api/limits/notifications`)).json();
  assert.ok(!notifications.some((n) => n.category_id === limited.id));

  // Ещё +200 — превышение (1150/1000 = 115%). Это отдельное событие ("exceeded") —
  // закрытие "approaching" выше на него не влияет, оно показывается заново.
  await addTx(limited.id, 200);
  progress = await (await fetch(`${baseUrl}/api/limits/progress?month=${month}`)).json();
  row = progress.find((r) => r.category_id === limited.id);
  assert.equal(row.spent, 1150);
  assert.equal(row.exceeded, true);
  notifications = await (await fetch(`${baseUrl}/api/limits/notifications`)).json();
  notif = notifications.find((n) => n.category_id === limited.id && n.limit_type === 'month');
  assert.equal(notif?.notification_type, 'exceeded');

  // Закрываем "exceeded" тоже, затем меняем сам лимит — закрытие должно сброситься
  // (ситуация реально другая, при том же факте превышения).
  await fetch(`${baseUrl}/api/limits/notifications/${limited.id}/dismiss`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit_type: 'month', notification_type: 'exceeded', period: month }),
  });
  notifications = await (await fetch(`${baseUrl}/api/limits/notifications`)).json();
  assert.ok(!notifications.some((n) => n.category_id === limited.id && n.limit_type === 'month'));

  await fetch(`${baseUrl}/api/limits/${limited.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ monthly_limit: 1200, yearly_limit: 5000 }),
  });
  notifications = await (await fetch(`${baseUrl}/api/limits/notifications`)).json();
  assert.ok(notifications.some((n) => n.category_id === limited.id && n.limit_type === 'month'), 'changing the limit value should un-dismiss notifications for that period');

  // Годовой лимит — та же трата (1150), но по годовому лимиту (5000) это всего 23%.
  const yearProgress = await (await fetch(`${baseUrl}/api/limits/progress-year?year=${year}`)).json();
  const yearRow = yearProgress.find((r) => r.category_id === limited.id);
  assert.equal(yearRow.spent, 1150);
  assert.equal(yearRow.limit, 5000);

  // Rollup намеренно НЕ учитывается в лимитах (в отличие от Дашборда/Excel) —
  // трата в подшитой к limited категории не должна попасть в его прогресс.
  const goalRes = await fetch(`${baseUrl}/api/goals`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Rollup test goal', target_amount: 100, new_category: { name: 'Ребёнок лимита', color: '#654321', rollup_id: limited.id } }),
  });
  const goal = await goalRes.json();
  await addTx(goal.category_id, 999);
  const progressAfterRollupTx = await (await fetch(`${baseUrl}/api/limits/progress?month=${month}`)).json();
  assert.equal(progressAfterRollupTx.find((r) => r.category_id === limited.id).spent, 1150, 'rollup child spending must not affect the parent category limit');
});
