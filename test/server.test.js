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

test('monthly summary: a rolled-up category row carries a components breakdown (Dashboard drill-down), plain categories don\'t', async () => {
  const categories = await (await fetch(`${baseUrl}/api/categories`)).json();
  const savings = categories.find((c) => c.name === 'Сбережения');
  const food = categories.find((c) => c.name === 'Еда');

  const goal = await (await fetch(`${baseUrl}/api/goals`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Drill-down test goal', target_amount: 1000,
      new_category: { name: 'Drill-down test category', rollup_id: savings.id },
    }),
  })).json();

  await fetch(`${baseUrl}/api/transactions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: '2026-08-09', type: 'expense', category_id: savings.id, amount: 300, note: '' }),
  });
  await fetch(`${baseUrl}/api/transactions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: '2026-08-09', type: 'expense', category_id: goal.category_id, amount: 700, note: '' }),
  });
  await fetch(`${baseUrl}/api/transactions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: '2026-08-09', type: 'expense', category_id: food.id, amount: 50, note: '' }),
  });

  const summary = await (await fetch(`${baseUrl}/api/summary/2026-08`)).json();
  const savingsRow = summary.expenseByCategory.find((c) => c.id === savings.id);
  assert.equal(savingsRow.amount, 1000, 'combined sum unaffected — 300 direct + 700 rolled up from the goal category');
  assert.ok(savingsRow.components, 'a rollup happened, so there must be a breakdown to drill into');
  assert.equal(savingsRow.components.length, 2);
  assert.equal(savingsRow.components.find((c) => c.id === savings.id).amount, 300);
  assert.equal(savingsRow.components.find((c) => c.id === goal.category_id).amount, 700);

  const foodRow = summary.expenseByCategory.find((c) => c.id === food.id);
  assert.equal(foodRow.components, null, 'no rollup involved — nothing to drill into, must not carry a components array');

  await fetch(`${baseUrl}/api/goals/${goal.id}`, { method: 'DELETE' });
  await fetch(`${baseUrl}/api/categories/${goal.category_id}?deleteTransactions=true`, { method: 'DELETE' });
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

  const delRes = await fetch(`${baseUrl}/api/goals/${goal.id}`, { method: 'DELETE' });
  assert.equal(delRes.status, 204);
  // Regression: DELETE didn't check existence first — a repeat/stale delete
  // silently returned 204 for a goal that was never there, inconsistent with
  // every other DELETE route in this codebase.
  const repeatDelRes = await fetch(`${baseUrl}/api/goals/${goal.id}`, { method: 'DELETE' });
  assert.equal(repeatDelRes.status, 404);
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

test('partial export (?from=&to=): only the requested range round-trips; malformed/half-supplied range is rejected, not silently treated as "everything"', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smeta-test-partial-export-'));
  const { proc, baseUrl: exportBaseUrl } = await startServer(dir);
  try {
    const categories = await (await fetch(`${exportBaseUrl}/api/categories`)).json();
    const food = categories.find((c) => c.name === 'Еда');
    const seed = [
      { date: '2026-01-15', type: 'expense', category_id: food.id, amount: 100, note: 'january' },
      { date: '2026-06-15', type: 'expense', category_id: food.id, amount: 200, note: 'june' },
      { date: '2026-12-15', type: 'expense', category_id: food.id, amount: 300, note: 'december' },
    ];
    for (const tx of seed) {
      await fetch(`${exportBaseUrl}/api/transactions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tx),
      });
    }

    // A range without a matching "to" (or a malformed date) must 400, not
    // silently fall back to a full export — that would be a real backup/
    // period-accounting footgun (user thinks they got June only, actually got everything).
    assert.equal((await fetch(`${exportBaseUrl}/api/export?from=2026-06-01`)).status, 400);
    assert.equal((await fetch(`${exportBaseUrl}/api/export?from=not-a-date&to=2026-06-30`)).status, 400);

    const partialRes = await fetch(`${exportBaseUrl}/api/export?from=2026-06-01&to=2026-06-30`);
    assert.equal(partialRes.status, 200);
    assert.match(partialRes.headers.get('content-disposition'), /2026-06-01_2026-06-30/, 'filename should reflect the range, not a plain date');
    const partialBuffer = Buffer.from(await partialRes.arrayBuffer());

    const importDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smeta-test-partial-import-'));
    const { proc: importProc, baseUrl: importBaseUrl } = await startServer(importDir);
    try {
      const form = new FormData();
      form.append('file', new Blob([partialBuffer]), 'partial.xlsx');
      const importRes = await fetch(`${importBaseUrl}/api/import`, { method: 'POST', body: form });
      const result = await importRes.json();
      assert.equal(result.imported, 1, 'only the one transaction inside 2026-06 should be in this export');

      const june = await (await fetch(`${importBaseUrl}/api/transactions?month=2026-06`)).json();
      assert.ok(june.some((t) => t.note === 'june'));
      const january = await (await fetch(`${importBaseUrl}/api/transactions?month=2026-01`)).json();
      assert.equal(january.length, 0, 'january is outside the exported range, must not have come along');
      const december = await (await fetch(`${importBaseUrl}/api/transactions?month=2026-12`)).json();
      assert.equal(december.length, 0, 'december is outside the exported range, must not have come along');
    } finally {
      importProc.kill('SIGTERM');
      removeDataDir(importDir);
    }
  } finally {
    proc.kill('SIGTERM');
    removeDataDir(dir);
  }
});

test('sync-aware import: a transaction carries its uuid to a new device, re-importing the same file is still a no-op, and re-importing an older export after a local edit updates the row instead of duplicating it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smeta-test-sync-'));
  const { proc, baseUrl: syncBaseUrl } = await startServer(dir);
  try {
    const categories = await (await fetch(`${syncBaseUrl}/api/categories`)).json();
    const food = categories.find((c) => c.name === 'Еда');

    const created = await (await fetch(`${syncBaseUrl}/api/transactions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-09-01', type: 'expense', category_id: food.id, amount: 500, note: 'sync test' }),
    })).json();

    const exportRes = await fetch(`${syncBaseUrl}/api/export`);
    const oldBuffer = Buffer.from(await exportRes.arrayBuffer());

    // Fresh "device B" — doesn't have this transaction yet, so importing the
    // export inserts it, carrying the SAME uuid forward (not a fresh one) —
    // that's what lets a later re-sync recognize it as the same operation.
    const deviceBDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smeta-test-sync-deviceb-'));
    const { proc: procB, baseUrl: deviceBUrl } = await startServer(deviceBDir);
    try {
      const form1 = new FormData();
      form1.append('file', new Blob([oldBuffer]), 'export.xlsx');
      const import1 = await (await fetch(`${deviceBUrl}/api/import`, { method: 'POST', body: form1 })).json();
      assert.equal(import1.imported, 1);
      assert.equal(import1.updated, 0);

      // Re-importing the exact same file again on device B — matches by
      // uuid, values are identical, must be a no-op skip, not a duplicate.
      const form2 = new FormData();
      form2.append('file', new Blob([oldBuffer]), 'export.xlsx');
      const import2 = await (await fetch(`${deviceBUrl}/api/import`, { method: 'POST', body: form2 })).json();
      assert.equal(import2.imported, 0);
      assert.equal(import2.skippedDuplicates, 1);
      const bRows = await (await fetch(`${deviceBUrl}/api/transactions?month=2026-09`)).json();
      assert.equal(bRows.length, 1, 'must still be exactly one row, not duplicated');
    } finally {
      procB.kill('SIGTERM');
      removeDataDir(deviceBDir);
    }

    // Edit the original transaction on device A (this is the scenario the
    // old value-only dedup got wrong: re-importing an older export of the
    // now-edited row used to insert a second, duplicate row instead of
    // recognizing "this is the same operation, just changed").
    await fetch(`${syncBaseUrl}/api/transactions/${created.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: 999 }),
    });

    const form3 = new FormData();
    form3.append('file', new Blob([oldBuffer]), 'old-export.xlsx');
    const import3 = await (await fetch(`${syncBaseUrl}/api/import`, { method: 'POST', body: form3 })).json();
    assert.equal(import3.imported, 0);
    assert.equal(import3.updated, 1);

    const aRows = await (await fetch(`${syncBaseUrl}/api/transactions?month=2026-09`)).json();
    assert.equal(aRows.length, 1, 'must still be exactly one row — updated, not duplicated');
    assert.equal(aRows[0].amount, 500, 'the imported file\'s value wins the merge, matching "import overwrites the local row it matches"');
  } finally {
    proc.kill('SIGTERM');
    removeDataDir(dir);
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

test('"нал." (excluded_from_total): out of flat totals, still in category breakdown, yearly-totals keeps a 0/0/0 row for a cash-only year', async () => {
  const categories = await (await fetch(`${baseUrl}/api/categories`)).json();
  const salary = categories.find((c) => c.name === 'Зарплата');

  // Год, которого не касаются другие тесты этого файла — иначе строка в
  // yearly-totals могла бы существовать по другой причине.
  const cashOnlyMonth = '2031-03';
  const txRes = await fetch(`${baseUrl}/api/transactions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: `${cashOnlyMonth}-10`, type: 'income', category_id: salary.id, amount: 50000, note: '', excluded_from_total: true }),
  });
  const tx = await txRes.json();
  assert.equal(tx.excluded_from_total, 1);

  const summary = await (await fetch(`${baseUrl}/api/summary/${cashOnlyMonth}`)).json();
  assert.equal(summary.totalIncome, 0, 'excluded from the flat month total');
  assert.equal(summary.incomeByCategory.find((c) => c.name === 'Зарплата')?.amount, 50000, 'still counted in the category breakdown (charts)');

  // Регрессия 2026-08-14: список лет раньше выводился из уже отфильтрованной
  // суммы — год с ЕДИНСТВЕННОЙ «нал.»-операцией пропадал из таблицы целиком
  // вместо строки 0/0/0. См. CLAUDE.md/routes/summary.js.
  const yearlyTotals = await (await fetch(`${baseUrl}/api/summary/yearly-totals`)).json();
  const row2031 = yearlyTotals.find((r) => r.year === '2031');
  assert.ok(row2031, 'a year with only a cash-flagged transaction must still show a row, not disappear');
  assert.equal(row2031.income, 0);
});

test('currency display setting: defaults to RUB, rejects a malformed code, persists', async () => {
  const currDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smeta-test-currency-'));
  const { proc: currChild, baseUrl: currBaseUrl } = await startServer(currDataDir);
  try {
    const initial = await (await fetch(`${currBaseUrl}/api/settings/currency`)).json();
    assert.equal(initial.currency, 'RUB');

    const badRes = await fetch(`${currBaseUrl}/api/settings/currency`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currency: 'usd' }),
    });
    assert.equal(badRes.status, 400, 'lowercase/malformed code rejected');

    const okRes = await fetch(`${currBaseUrl}/api/settings/currency`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currency: 'USD' }),
    });
    assert.equal(okRes.status, 204);

    const after = await (await fetch(`${currBaseUrl}/api/settings/currency`)).json();
    assert.equal(after.currency, 'USD');
  } finally {
    currChild.kill('SIGTERM');
    removeDataDir(currDataDir);
  }
});

test('category validation: whitespace-only rename rejected, reassign-on-delete target must exist and match type', async () => {
  const categories = await (await fetch(`${baseUrl}/api/categories`)).json();
  const food = categories.find((c) => c.name === 'Еда');
  const salary = categories.find((c) => c.name === 'Зарплата'); // income — wrong type for reassigning an expense category

  // Регрессия: пробельное имя раньше тихо затирало название категории (truthy
  // строка проходила через COALESCE как непустое значение после .trim()).
  const blankRes = await fetch(`${baseUrl}/api/categories/${food.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '   ' }),
  });
  assert.equal(blankRes.status, 400);
  const stillFood = await (await fetch(`${baseUrl}/api/categories`)).json();
  assert.ok(stillFood.some((c) => c.id === food.id && c.name === 'Еда'), 'name must be unchanged after a rejected rename');

  const toDelete = await (await fetch(`${baseUrl}/api/categories`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Категория для удаления', type: 'expense', color: '#111111' }),
  })).json();
  await fetch(`${baseUrl}/api/transactions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: '2031-04-01', type: 'expense', category_id: toDelete.id, amount: 10, note: '' }),
  });

  const missingTargetRes = await fetch(`${baseUrl}/api/categories/${toDelete.id}?reassignTo=999999`, { method: 'DELETE' });
  assert.equal(missingTargetRes.status, 400, 'reassignTo pointing at a nonexistent category must be rejected');

  const crossTypeRes = await fetch(`${baseUrl}/api/categories/${toDelete.id}?reassignTo=${salary.id}`, { method: 'DELETE' });
  assert.equal(crossTypeRes.status, 400, 'reassigning an expense category onto an income one must be rejected');

  const okTargetRes = await fetch(`${baseUrl}/api/categories/${toDelete.id}?reassignTo=${food.id}`, { method: 'DELETE' });
  assert.equal(okTargetRes.status, 204, 'a same-type, existing target must still work');
});

test('category deletion: a category that another category rolls up into (e.g. a goal\'s dedicated category → "Сбережения") is rejected with 409, not a raw 500', async () => {
  // Regression: DELETE on a rollup TARGET threw an uncaught SQLITE_CONSTRAINT
  // (categories.rollup_id → categories(id), foreign_keys=ON, no ON DELETE) —
  // Express's default error middleware turned that into a bare "Внутренняя
  // ошибка сервера" instead of an actionable message, found 2026-08-14 via a
  // full-project review. Reproduced with a goal's own dedicated category
  // (new_category.rollup_id), the same path a real user hits from the UI.
  const categories = await (await fetch(`${baseUrl}/api/categories`)).json();
  const savings = categories.find((c) => c.name === 'Сбережения');

  const rollupTargetCat = await (await fetch(`${baseUrl}/api/categories`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Цель ролап-теста', type: 'expense', color: '#222222' }),
  })).json();
  await fetch(`${baseUrl}/api/categories/${rollupTargetCat.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Цель ролап-теста' }),
  }); // no-op PUT, just confirms the row exists before we hand-set rollup_id below

  // rollup_id isn't settable via PUT /api/categories/:id (only at creation, via
  // goals' new_category) — go through the goal-creation path directly, the
  // same one a real user exercises.
  const goal = await (await fetch(`${baseUrl}/api/goals`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Ролап-цель', target_amount: 1000,
      new_category: { name: 'Подкатегория ролап-теста', rollup_id: savings.id },
    }),
  })).json();
  assert.ok(goal.category_id, 'goal should have created its own category');

  const delRes = await fetch(`${baseUrl}/api/categories/${savings.id}`, { method: 'DELETE' });
  assert.equal(delRes.status, 409, 'deleting a rollup target must be a clean 409, not a raw 500');
  const body = await delRes.json();
  assert.match(body.error, /Дашборде/, 'error message should explain why (rollup), not just fail generically');

  const stillThere = await (await fetch(`${baseUrl}/api/categories`)).json();
  assert.ok(stillThere.some((c) => c.id === savings.id), '"Сбережения" must survive the rejected delete');

  // Cleanup so this category doesn't leak into other tests on the shared instance.
  await fetch(`${baseUrl}/api/goals/${goal.id}`, { method: 'DELETE' });
  await fetch(`${baseUrl}/api/categories/${goal.category_id}`, { method: 'DELETE' });
  await fetch(`${baseUrl}/api/categories/${rollupTargetCat.id}`, { method: 'DELETE' });
});

test('transaction date validation: malformed/missing date rejected on create and edit (not just stored as-is)', async () => {
  // Regression: `date` was only checked for truthy, not format — any string
  // was accepted and later rendered unescaped client-side (see the XSS fix in
  // public/app.js escapeHtml() — this is the matching backend-side gap that
  // let a non-date string reach that render path in the first place).
  const categories = await (await fetch(`${baseUrl}/api/categories`)).json();
  const food = categories.find((c) => c.name === 'Еда');

  const badCreateRes = await fetch(`${baseUrl}/api/transactions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: '<img src=x onerror=alert(1)>', type: 'expense', category_id: food.id, amount: 10, note: '' }),
  });
  assert.equal(badCreateRes.status, 400);

  const goodTx = await (await fetch(`${baseUrl}/api/transactions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: '2026-08-01', type: 'expense', category_id: food.id, amount: 10, note: '' }),
  })).json();

  const badEditRes = await fetch(`${baseUrl}/api/transactions/${goodTx.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: 'not-a-date' }),
  });
  assert.equal(badEditRes.status, 400);
  const stillGood = await (await fetch(`${baseUrl}/api/transactions?month=2026-08`)).json();
  assert.ok(stillGood.some((t) => t.id === goodTx.id && t.date === '2026-08-01'), 'date must be unchanged after a rejected edit');

  await fetch(`${baseUrl}/api/transactions/${goodTx.id}`, { method: 'DELETE' });
});

test('goal validation: duration_months must be a positive integer, target_amount must stay positive on edit', async () => {
  const categories = await (await fetch(`${baseUrl}/api/categories`)).json();
  const food = categories.find((c) => c.name === 'Еда');

  const zeroRes = await fetch(`${baseUrl}/api/goals`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Bad goal', target_amount: 1000, category_id: food.id, duration_months: 0 }),
  });
  assert.equal(zeroRes.status, 400);

  const negativeRes = await fetch(`${baseUrl}/api/goals`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Bad goal', target_amount: 1000, category_id: food.id, duration_months: -3 }),
  });
  assert.equal(negativeRes.status, 400);

  const goal = await (await fetch(`${baseUrl}/api/goals`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Editable goal', target_amount: 1000, category_id: food.id, duration_months: 4 }),
  })).json();

  // PUT раньше вообще не валидировал это поле: 0 тихо игнорировался через
  // `|| null`, отрицательное значение сохранялось как есть.
  const negativeEditRes = await fetch(`${baseUrl}/api/goals/${goal.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target_amount: -500 }),
  });
  assert.equal(negativeEditRes.status, 400);
});

test('recurring transactions: suggestion appears a month later, confirming moves the flag forward with day-of-month clamped, skip is scoped to one month', async () => {
  const rentCat = await (await fetch(`${baseUrl}/api/categories`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Recurring test rent', type: 'expense', color: '#222222' }),
  })).json();

  // 31-е число нарочно — проверяет clamp дня месяца в более коротком апреле (30 дней).
  const source = await (await fetch(`${baseUrl}/api/transactions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: '2031-03-31', type: 'expense', category_id: rentCat.id, amount: 1000, note: '', is_recurring: true }),
  })).json();
  assert.equal(source.is_recurring, 1);

  const aprilSuggestions = await (await fetch(`${baseUrl}/api/recurring/suggestions?month=2031-04`)).json();
  const suggestion = aprilSuggestions.find((s) => s.source_id === source.id);
  assert.ok(suggestion, 'a month later, with nothing yet in that category+type, must suggest repeating it');
  assert.equal(suggestion.amount, 1000);

  const confirmRes = await fetch(`${baseUrl}/api/recurring/${source.id}/confirm`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ month: '2031-04', amount: 1000 }),
  });
  assert.equal(confirmRes.status, 201);
  const created = await confirmRes.json();
  assert.equal(created.date, '2031-04-30', "day-of-month clamped to April's real length (30, not 31)");
  assert.equal(created.is_recurring, 1);

  const sourceAfter = await (await fetch(`${baseUrl}/api/transactions?month=2031-03`)).json();
  assert.equal(sourceAfter.find((t) => t.id === source.id).is_recurring, 0, 'the flag moves forward — the old source gets demoted');

  const maySuggestions = await (await fetch(`${baseUrl}/api/recurring/suggestions?month=2031-05`)).json();
  assert.ok(maySuggestions.some((s) => s.source_id === created.id));
  const skipRes = await fetch(`${baseUrl}/api/recurring/${created.id}/skip`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ month: '2031-05' }),
  });
  assert.equal(skipRes.status, 204);
  const mayAfterSkip = await (await fetch(`${baseUrl}/api/recurring/suggestions?month=2031-05`)).json();
  assert.ok(!mayAfterSkip.some((s) => s.source_id === created.id), 'dismissed for May');

  const juneSuggestions = await (await fetch(`${baseUrl}/api/recurring/suggestions?month=2031-06`)).json();
  assert.ok(juneSuggestions.some((s) => s.source_id === created.id), 'the May skip must not carry over to June');
});

test('recurring transactions: at most one active template per (category, type) — marking a new one demotes the old', async () => {
  const rentCat = await (await fetch(`${baseUrl}/api/categories`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Recurring invariant test', type: 'expense', color: '#333333' }),
  })).json();

  const first = await (await fetch(`${baseUrl}/api/transactions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: '2031-07-01', type: 'expense', category_id: rentCat.id, amount: 100, note: '', is_recurring: true }),
  })).json();
  const second = await (await fetch(`${baseUrl}/api/transactions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: '2031-07-15', type: 'expense', category_id: rentCat.id, amount: 200, note: '', is_recurring: true }),
  })).json();

  const rows = await (await fetch(`${baseUrl}/api/transactions?month=2031-07`)).json();
  assert.equal(rows.find((t) => t.id === first.id).is_recurring, 0, 'the first must be demoted once a second is marked recurring for the same category+type');
  assert.equal(rows.find((t) => t.id === second.id).is_recurring, 1);
});

test('recurring transactions: auto_confirm ("не спрашивая") carries forward through confirm, is visible in suggestions, and clears if is_recurring is turned off', async () => {
  const cat = await (await fetch(`${baseUrl}/api/categories`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Auto-confirm test', type: 'expense', color: '#444444' }),
  })).json();

  const source = await (await fetch(`${baseUrl}/api/transactions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: '2032-01-05', type: 'expense', category_id: cat.id, amount: 500, note: '', is_recurring: true, auto_confirm: true }),
  })).json();
  assert.equal(source.auto_confirm, 1);

  const febSuggestions = await (await fetch(`${baseUrl}/api/recurring/suggestions?month=2032-02`)).json();
  const suggestion = febSuggestions.find((s) => s.source_id === source.id);
  assert.ok(suggestion);
  assert.equal(suggestion.auto_confirm, 1, 'the frontend needs this to auto-fire confirm instead of rendering a card');

  const confirmed = await (await fetch(`${baseUrl}/api/recurring/${source.id}/confirm`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ month: '2032-02', amount: 500 }),
  })).json();
  assert.equal(confirmed.auto_confirm, 1, 'auto_confirm must carry forward to the new template, or it would silently revert to manual next month');

  // Turning off "Повтор." must also turn off "не спрашивая" — it's meaningless without it.
  const editedRes = await fetch(`${baseUrl}/api/transactions/${confirmed.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ is_recurring: false }),
  });
  const edited = await editedRes.json();
  assert.equal(edited.is_recurring, 0);
  assert.equal(edited.auto_confirm, 0, 'auto_confirm must not be left dangling on a non-recurring row');
});

test('automatic backups: a today-dated file exists after startup, listed via settings with no error', async () => {
  const backupDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smeta-test-backup-'));
  const { proc: backupChild, baseUrl: backupBaseUrl } = await startServer(backupDataDir);
  try {
    // startBackupSchedule() запускает первый прогон синхронно при старте, но не
    // ждёт его — даём секунду на запись файла на диск.
    await new Promise((r) => setTimeout(r, 1000));

    const today = new Date().toISOString().slice(0, 10);
    const backupsDir = path.join(backupDataDir, 'backups');
    assert.ok(fs.existsSync(path.join(backupsDir, `smeta-backup-${today}.xlsx`)), 'a backup file for today must exist after startup');

    const status = await (await fetch(`${backupBaseUrl}/api/settings/backups`)).json();
    assert.equal(status.folder, backupsDir);
    assert.equal(status.error, null);
  } finally {
    backupChild.kill('SIGTERM');
    removeDataDir(backupDataDir);
  }
});

test('automatic backups: keeps only the newest 7, oldest pruned first', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smeta-test-backup-prune-'));
  const backupsDir = path.join(dir, 'backups');
  fs.mkdirSync(backupsDir, { recursive: true });
  const oldDates = ['2031-01-01', '2031-01-02', '2031-01-03', '2031-01-04', '2031-01-05', '2031-01-06', '2031-01-07', '2031-01-08', '2031-01-09'];
  oldDates.forEach((d) => fs.writeFileSync(path.join(backupsDir, `smeta-backup-${d}.xlsx`), ''));

  const { proc, baseUrl: pruneBaseUrl } = await startServer(dir);
  try {
    await new Promise((r) => setTimeout(r, 1000));
    const remaining = fs.readdirSync(backupsDir).filter((f) => f.endsWith('.xlsx')).sort();
    assert.equal(remaining.length, 7, 'keeps exactly 7 after pruning');
    assert.ok(!remaining.includes('smeta-backup-2031-01-01.xlsx'), 'oldest deleted first');
    assert.ok(!remaining.includes('smeta-backup-2031-01-02.xlsx'));
  } finally {
    proc.kill('SIGTERM');
    removeDataDir(dir);
  }
});

test('automatic backups: a failed attempt surfaces as a dismissible error, scoped to that day', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smeta-test-backup-error-'));
  const { proc, baseUrl: errBaseUrl } = await startServer(dir);
  try {
    await new Promise((r) => setTimeout(r, 1000)); // let the real startup backup finish first

    // ENOSPC не воспроизвести по-настоящему в тесте — пишем провальный результат
    // напрямую в БД (второе, отдельное соединение с тем же файлом), как это
    // сделал бы backup.js после неудачной попытки.
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(path.join(dir, 'smeta.db'));
    const today = new Date().toISOString().slice(0, 10);
    const value = JSON.stringify({ date: today, ok: false, error: 'ENOSPC: no space left on device' });
    raw.prepare("INSERT INTO app_settings (key, value) VALUES ('backup_last_result', ?) ON CONFLICT(key) DO UPDATE SET value = ?").run(value, value);
    raw.close();

    const withError = await (await fetch(`${errBaseUrl}/api/settings/backups`)).json();
    assert.ok(withError.error, 'a failed result for today must surface as an error');
    assert.equal(withError.error.date, today);

    const dismissRes = await fetch(`${errBaseUrl}/api/settings/backups/dismiss-error`, { method: 'POST' });
    assert.equal(dismissRes.status, 204);

    const afterDismiss = await (await fetch(`${errBaseUrl}/api/settings/backups`)).json();
    assert.equal(afterDismiss.error, null, 'dismissed error must not resurface for the same day');
  } finally {
    proc.kill('SIGTERM');
    removeDataDir(dir);
  }
});

test('transactions list: category_id filter, and combines with type — month is intentionally not exercised here (that half is frontend-only, see TESTING.md)', async () => {
  const categories = await (await fetch(`${baseUrl}/api/categories`)).json();
  const food = categories.find((c) => c.name === 'Еда');
  const salary = categories.find((c) => c.name === 'Зарплата');

  // Уникальная дата/сумма — чтобы не пересечься с данными других тестов этого файла.
  await fetch(`${baseUrl}/api/transactions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: '2031-09-01', type: 'expense', category_id: food.id, amount: 111, note: 'category filter test' }),
  });
  await fetch(`${baseUrl}/api/transactions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: '2031-09-01', type: 'income', category_id: salary.id, amount: 222, note: 'category filter test' }),
  });

  const byCategory = await (await fetch(`${baseUrl}/api/transactions?category_id=${food.id}`)).json();
  assert.ok(byCategory.every((t) => t.category_id === food.id), 'category_id must narrow to only that category, across all months');
  assert.ok(byCategory.some((t) => t.note === 'category filter test'));

  // category_id + type вместе — категория расходов, но с типом "доход" не даёт ничего
  // (Еда — категория расходов), подтверждает, что фильтры действительно комбинируются через "И".
  const mismatched = await (await fetch(`${baseUrl}/api/transactions?category_id=${food.id}&type=income`)).json();
  assert.equal(mismatched.length, 0);
});

test('overall monthly budget: validation, progress excludes "нал." and ignores rollup, notification + dismiss, cleared by delete-all-data', async () => {
  // Свой процесс/БД — нужны предсказуемые суммы за месяц, без операций из других тестов файла.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smeta-test-overall-budget-'));
  const { proc, baseUrl: obBaseUrl } = await startServer(dir);
  try {
    const initial = await (await fetch(`${obBaseUrl}/api/limits/overall`)).json();
    assert.equal(initial.monthly_limit, null, 'unset by default');

    const zeroRes = await fetch(`${obBaseUrl}/api/limits/overall`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ monthly_limit: 0 }),
    });
    assert.equal(zeroRes.status, 400);

    const setRes = await fetch(`${obBaseUrl}/api/limits/overall`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ monthly_limit: 1000 }),
    });
    assert.equal(setRes.status, 200);
    assert.equal((await setRes.json()).monthly_limit, 1000);

    const categories = await (await fetch(`${obBaseUrl}/api/categories`)).json();
    const food = categories.find((c) => c.name === 'Еда');
    const savings = categories.find((c) => c.name === 'Сбережения');
    const month = new Date().toISOString().slice(0, 7);
    const today = new Date().toISOString().slice(0, 10);

    // Обычный расход — считается. "Нал." — не считается (как "Расход" в шапке
    // Дашборда). Цель с rollup_id → savings — считается по факту операции, а не
    // "сворачивается" куда-то ещё: общий бюджет суммирует все категории расходов
    // сразу, поэтому rollup здесь в принципе не может ничего изменить.
    await fetch(`${obBaseUrl}/api/transactions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: today, type: 'expense', category_id: food.id, amount: 600, note: '' }),
    });
    await fetch(`${obBaseUrl}/api/transactions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: today, type: 'expense', category_id: food.id, amount: 5000, note: '', excluded_from_total: true }),
    });
    await fetch(`${obBaseUrl}/api/transactions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: today, type: 'expense', category_id: savings.id, amount: 350, note: '' }),
    });

    const progress = await (await fetch(`${obBaseUrl}/api/limits/overall/progress?month=${month}`)).json();
    assert.equal(progress.spent, 950, '600 + 350 — the "нал." 5000 must not count');
    assert.equal(progress.pct, 95);
    assert.equal(progress.exceeded, false);

    let notifications = await (await fetch(`${obBaseUrl}/api/limits/notifications`)).json();
    let overallNotif = notifications.find((n) => n.overall);
    assert.equal(overallNotif?.notification_type, 'approaching');

    // Дошли до превышения — новое событие, закрытие "approaching" на него не влияет.
    await fetch(`${obBaseUrl}/api/transactions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: today, type: 'expense', category_id: food.id, amount: 100, note: '' }),
    });
    notifications = await (await fetch(`${obBaseUrl}/api/limits/notifications`)).json();
    overallNotif = notifications.find((n) => n.overall);
    assert.equal(overallNotif?.notification_type, 'exceeded');

    const dismissRes = await fetch(`${obBaseUrl}/api/limits/overall/notifications/dismiss`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notification_type: 'exceeded', period: month }),
    });
    assert.equal(dismissRes.status, 204);
    notifications = await (await fetch(`${obBaseUrl}/api/limits/notifications`)).json();
    assert.ok(!notifications.some((n) => n.overall), 'dismissed');

    // Изменение суммы бюджета сбрасывает закрытие, как у лимитов категорий.
    await fetch(`${obBaseUrl}/api/limits/overall`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ monthly_limit: 1050 }),
    });
    notifications = await (await fetch(`${obBaseUrl}/api/limits/notifications`)).json();
    assert.ok(notifications.some((n) => n.overall), 'changing the budget value un-dismisses notifications for it');

    // "Удалить все данные" — общий бюджет это финансовое планирование, не настройка
    // приложения (в отличие от currency/onboarding_seen), должен сброситься тоже.
    await fetch(`${obBaseUrl}/api/settings/all-data`, { method: 'DELETE' });
    const afterWipe = await (await fetch(`${obBaseUrl}/api/limits/overall`)).json();
    assert.equal(afterWipe.monthly_limit, null);
  } finally {
    proc.kill('SIGTERM');
    removeDataDir(dir);
  }
});

test('trash (deleted-transactions): keeps last 10 with oldest trimmed, restore round-trips, stale/foreign-category restores rejected, wiped by delete-all-data', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smeta-test-trash-'));
  const { proc, baseUrl: trashBaseUrl } = await startServer(dir);
  try {
    const categories = await (await fetch(`${trashBaseUrl}/api/categories`)).json();
    const food = categories.find((c) => c.name === 'Еда');

    // 11 удалений подряд — 11-е должно вытеснить самое первое (хранятся только последние 10).
    for (let i = 1; i <= 11; i++) {
      const created = await (await fetch(`${trashBaseUrl}/api/transactions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: '2026-08-01', type: 'expense', category_id: food.id, amount: i, note: `trash-${i}` }),
      })).json();
      const delRes = await fetch(`${trashBaseUrl}/api/transactions/${created.id}`, { method: 'DELETE' });
      assert.equal(delRes.status, 204);
    }
    const trash = await (await fetch(`${trashBaseUrl}/api/transactions/trash`)).json();
    assert.equal(trash.length, 10, 'only the last 10 deletions are kept');
    assert.ok(!trash.some((t) => t.note === 'trash-1'), 'the oldest (11th deletion ago) is trimmed');
    assert.ok(trash.some((t) => t.note === 'trash-11'), 'the most recent deletion is kept');
    assert.equal(trash[0].note, 'trash-11', 'newest deletion first');

    // Восстановление — новая операция появляется, запись уходит из корзины.
    const restoreRes = await fetch(`${trashBaseUrl}/api/transactions/trash/${trash[0].id}/restore`, { method: 'POST' });
    assert.equal(restoreRes.status, 201);
    const restored = await restoreRes.json();
    assert.equal(restored.note, 'trash-11');
    assert.equal(restored.amount, 11);
    const monthList = await (await fetch(`${trashBaseUrl}/api/transactions?month=2026-08`)).json();
    assert.ok(monthList.some((t) => t.id === restored.id));

    // auto_confirm ("не спрашивая") must round-trip through delete + restore,
    // same as is_recurring already does — otherwise restoring a recurring
    // template silently downgrades it to manual-confirm.
    const autoTx = await (await fetch(`${trashBaseUrl}/api/transactions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-08-02', type: 'expense', category_id: food.id, amount: 42, note: 'auto-trash', is_recurring: true, auto_confirm: true }),
    })).json();
    await fetch(`${trashBaseUrl}/api/transactions/${autoTx.id}`, { method: 'DELETE' });
    const trashWithAuto = await (await fetch(`${trashBaseUrl}/api/transactions/trash`)).json();
    const autoTrashEntry = trashWithAuto.find((t) => t.note === 'auto-trash');
    assert.equal(autoTrashEntry.auto_confirm, 1);
    const autoRestored = await (await fetch(`${trashBaseUrl}/api/transactions/trash/${autoTrashEntry.id}/restore`, { method: 'POST' })).json();
    assert.equal(autoRestored.auto_confirm, 1);
    const trashAfterRestore = await (await fetch(`${trashBaseUrl}/api/transactions/trash`)).json();
    assert.equal(trashAfterRestore.length, 9);

    // Повторное восстановление того же (уже не в корзине) id — 404, не 500.
    const staleRestoreRes = await fetch(`${trashBaseUrl}/api/transactions/trash/${trash[0].id}/restore`, { method: 'POST' });
    assert.equal(staleRestoreRes.status, 404);

    // Категорию удалили, пока операция лежала в корзине — восстановить в неё нельзя.
    const orphanCat = await (await fetch(`${trashBaseUrl}/api/categories`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Категория для корзины', type: 'expense', color: '#123456' }),
    })).json();
    const orphanTx = await (await fetch(`${trashBaseUrl}/api/transactions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-08-01', type: 'expense', category_id: orphanCat.id, amount: 50, note: 'orphan' }),
    })).json();
    await fetch(`${trashBaseUrl}/api/transactions/${orphanTx.id}`, { method: 'DELETE' });
    const trashWithOrphan = await (await fetch(`${trashBaseUrl}/api/transactions/trash`)).json();
    const orphanTrashEntry = trashWithOrphan.find((t) => t.note === 'orphan');
    await fetch(`${trashBaseUrl}/api/categories/${orphanCat.id}`, { method: 'DELETE' }); // без live-операций — удаляется сразу
    const orphanRestoreRes = await fetch(`${trashBaseUrl}/api/transactions/trash/${orphanTrashEntry.id}/restore`, { method: 'POST' });
    assert.equal(orphanRestoreRes.status, 409);

    // "Удалить все данные" стирает и корзину, не только сами операции.
    await fetch(`${trashBaseUrl}/api/settings/all-data`, { method: 'DELETE' });
    const trashAfterWipe = await (await fetch(`${trashBaseUrl}/api/transactions/trash`)).json();
    assert.equal(trashAfterWipe.length, 0);
  } finally {
    proc.kill('SIGTERM');
    removeDataDir(dir);
  }
});

test('card reconciliation: unset by default, month-before-anchor hides the card instead of an inverted-range false zero, wiped by delete-all-data', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smeta-test-reconciliation-'));
  const { proc, baseUrl: reconBaseUrl } = await startServer(dir);
  try {
    const initial = await (await fetch(`${reconBaseUrl}/api/reconciliation`)).json();
    assert.equal(initial.anchor_date, null);

    const badRes = await fetch(`${reconBaseUrl}/api/reconciliation`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ anchor_date: 'not-a-date', anchor_amount: 100 }),
    });
    assert.equal(badRes.status, 400);

    const setRes = await fetch(`${reconBaseUrl}/api/reconciliation`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ anchor_date: '2026-08-15', anchor_amount: 1000 }),
    });
    assert.equal(setRes.status, 200);

    const categories = await (await fetch(`${reconBaseUrl}/api/categories`)).json();
    const food = categories.find((c) => c.name === 'Еда');
    // A transaction BEFORE the anchor date — this is what exposed the
    // inverted-range bug: querying a month earlier than the anchor's month
    // used to silently return since_net=0 (0 matching rows) instead of
    // recognizing the question doesn't apply to that period.
    await fetch(`${reconBaseUrl}/api/transactions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-07-10', type: 'expense', category_id: food.id, amount: 5000, note: '' }),
    });

    const beforeAnchor = await (await fetch(`${reconBaseUrl}/api/reconciliation/2026-07`)).json();
    assert.equal(beforeAnchor.set, false, 'a month before the anchor\'s month must hide the card, not show a misleading since_net=0');

    const anchorMonthRes = await (await fetch(`${reconBaseUrl}/api/reconciliation/2026-08`)).json();
    assert.equal(anchorMonthRes.set, true);
    assert.equal(anchorMonthRes.since_net, 0, 'the July transaction is before anchor_date, so it must not count toward August either');
    assert.equal(anchorMonthRes.expected, 1000);

    // "Удалить все данные" — the anchor references a balance built from
    // transactions that no longer exist after a wipe, so it must be cleared
    // too (same reasoning already applied to overall_monthly_budget).
    await fetch(`${reconBaseUrl}/api/settings/all-data`, { method: 'DELETE' });
    const afterWipe = await (await fetch(`${reconBaseUrl}/api/reconciliation`)).json();
    assert.equal(afterWipe.anchor_date, null);
  } finally {
    proc.kill('SIGTERM');
    removeDataDir(dir);
  }
});

// ---------- Vacation pay (routes/vacation.js) ----------
// calculateVacation() is a pure function (no network, no db — the only route
// in this app with zero persisted state), so these run against hand-built
// calendar fixtures instead of the real isdayoff.ru — fast and deterministic,
// no flakiness from an external service being briefly unavailable during CI.
const { calculateVacation, calendarFetchRange, parseCalendarResponse } = require('../routes/vacation');

function addDaysFixture(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// Builds a calendar covering [from, to]: weekends ('1'), named holidays ('8'),
// everything else a working day ('0') — same shape routes/vacation.js's
// fetchCalendar()/fallbackCalendar() produce from the real API.
function buildCalendarFixture(from, to, holidays = []) {
  const calendar = {};
  let d = from;
  while (d <= to) {
    const dow = new Date(`${d}T00:00:00`).getDay();
    calendar[d] = holidays.includes(d) ? '8' : (dow === 0 || dow === 6) ? '1' : '0';
    d = addDaysFixture(d, 1);
  }
  return calendar;
}

test('vacation pay: matches the worked example (Sept 1-14 2026, oklad 100k, paydays 5/20) — including two payment dates the writer\'s own by-hand trace initially missed were on weekends', () => {
  const calendar = buildCalendarFixture('2026-07-01', '2026-09-20');
  const result = calculateVacation({
    salary: 100000, salaryIsGross: false, vacationStart: '2026-09-01', vacationEnd: '2026-09-14', payday1: 5, payday2: 20,
  }, calendar);

  assert.equal(result.netSalary, 100000);
  assert.equal(result.vacationPay.date, '2026-08-28', 'Aug 29 is a Saturday — rolled back to Friday the 28th, not paid late');
  assert.equal(result.vacationPay.totalDays, 14);
  assert.equal(result.vacationPay.paidDays, 14, 'no public holidays fall in this range, only ordinary weekends, which stay paid');
  assert.equal(result.vacationPay.holidaysExcluded, 0);
  assert.ok(Math.abs(result.vacationPay.amount - (100000 / 29.3) * 14) < 0.001);

  const p5 = result.payments.find((p) => p.day === 5);
  assert.equal(p5.date, '2026-09-04', 'the 5th is a Saturday — rolled back to Friday the 4th');
  assert.equal(p5.period.from, '2026-08-16');
  assert.equal(p5.period.to, '2026-08-31');
  assert.equal(p5.workingDaysInPeriod, 11);
  assert.equal(p5.workedDays, 11, 'this whole period is before the vacation starts, fully worked');
  assert.equal(p5.amount, 50000);

  const p20 = result.payments.find((p) => p.day === 20);
  assert.equal(p20.date, '2026-09-18', 'the 20th is a Sunday — rolled back to Friday the 18th');
  assert.equal(p20.period.from, '2026-09-01');
  assert.equal(p20.period.to, '2026-09-15');
  assert.equal(p20.workingDaysInPeriod, 11);
  assert.equal(p20.workedDays, 1, 'only the 15th (the day after vacation ends) was actually worked in this half-month');
  assert.ok(Math.abs(p20.amount - (100000 / 2) * (1 / 11)) < 0.001);

  assert.deepEqual(result.payments.map((p) => p.date), ['2026-09-04', '2026-09-18'], 'sorted chronologically');
});

test('vacation pay: a public holiday inside the range is excluded from paid days (weekends are not); gross salary is converted at 0.87', () => {
  const calendar = buildCalendarFixture('2026-03-01', '2026-05-20', ['2026-05-01']);
  const result = calculateVacation({
    salary: 100000, salaryIsGross: true, vacationStart: '2026-04-28', vacationEnd: '2026-05-05', payday1: 5, payday2: 20,
  }, calendar);

  assert.equal(result.netSalary, 87000);
  assert.equal(result.vacationPay.totalDays, 8);
  assert.equal(result.vacationPay.holidaysExcluded, 1, 'May 1st (Праздник Весны и Труда) does not count as a paid vacation day');
  assert.equal(result.vacationPay.paidDays, 7);
  assert.equal(result.vacationPay.date, '2026-04-24', 'raw due date (Apr 25) is a Saturday — rolled back to Friday the 24th');
});

test('vacation pay: a payment period entirely consumed by vacation pays close to nothing; payday clamps to the real end of a shorter month', () => {
  // A short, one-week vacation that fully covers the 1-15 half of its month —
  // that half's payment should be ~0 (every working day in it was vacation).
  const calendar = buildCalendarFixture('2026-01-20', '2026-02-20', []);
  const result = calculateVacation({
    salary: 60000, salaryIsGross: false, vacationStart: '2026-02-02', vacationEnd: '2026-02-13', payday1: 20, payday2: 5,
  }, calendar);
  const feb20 = result.payments.find((p) => p.day === 20);
  assert.equal(feb20.workedDays, 0, 'every working day of Feb 1-15 falls inside the vacation');
  assert.equal(feb20.amount, 0);

  // payday=31 for a vacation starting well into February (28 days in 2026,
  // not a leap year) — the *next* occurrence of "the 31st" on or after the
  // отпускные payment date (itself in February) must clamp to the 28th, not
  // silently roll into March or produce an invalid date — same clamp
  // routes/recurring.js already uses for recurring transactions' day-of-month.
  const clampCalendar = buildCalendarFixture('2026-01-01', '2026-03-05', []);
  const clamped = calculateVacation({
    salary: 60000, salaryIsGross: false, vacationStart: '2026-02-24', vacationEnd: '2026-02-26', payday1: 31, payday2: 5,
  }, clampCalendar);
  const clampedPayment = clamped.payments.find((p) => p.day === 31);
  // <= the 28th, not necessarily == it: Feb 28 2026 is itself a Saturday, so
  // the usual "не позднее" weekend roll-back (see rollBackToWorkingDay)
  // correctly moves it one day earlier still — the clamp and the roll-back
  // compose, this test only cares that neither rolled it into March.
  assert.ok(clampedPayment.date <= '2026-02-28' && clampedPayment.date.startsWith('2026-02'), 'payday 31 clamped into February, not rolled into March');
});

test('vacation pay: each payment is the NEXT occurrence of its payday on or after отпускные is paid — not just "same payday number, vacation-start month", which can pick an already-past date', () => {
  // Отпускные paid Oct 16 (3 days before Oct 19, no weekend adjustment
  // needed that year). October's own "5th" is Oct 5 — already in the past
  // relative to Oct 16 — so the correct next occurrence is Nov 5, not Oct 5.
  // Found by the user testing the real app: the first version of this logic
  // always resolved both paydays within the vacation-start month regardless
  // of whether that occurrence had already passed.
  const calendar = buildCalendarFixture('2026-09-01', '2026-11-30');
  const result = calculateVacation({
    salary: 175000, salaryIsGross: false, vacationStart: '2026-10-19', vacationEnd: '2026-11-01', payday1: 5, payday2: 20,
  }, calendar);

  assert.equal(result.vacationPay.date, '2026-10-16');
  assert.deepEqual(result.payments.map((p) => `${p.day}:${p.date}`), ['20:2026-10-20', '5:2026-11-05']);
});

test('vacation pay: calendarFetchRange fetches far enough ahead to cover a payday that nextPaydayOnOrAfter pushes into a later month — found via a live repro (2027-01-01 to 2027-01-01, paydays 10/20) where the old +5-day bound silently collapsed both payments onto the same wrong date', () => {
  // Short vacation right at the start of a month, both paydays still ahead —
  // отпускные itself is paid ~3 days before vacationStart, so the fetch
  // window used to end just a few days into January, well before the 10th
  // or 20th ever needed by nextPaydayOnOrAfter()/periodForPayday() below.
  const { to } = calendarFetchRange('2027-01-01', '2027-01-01');
  assert.ok(to >= '2027-01-20', `fetch range must reach at least the later payday (2027-01-20), got ${to}`);

  // General shape of the guarantee, not just this one example: the range
  // must reach at least a month past vacationEnd, since periodForPayday()
  // for a payday resolved into the month after vacationEnd can itself need
  // dates up to the 15th of the month after THAT.
  const wide = calendarFetchRange('2026-06-15', '2026-06-20');
  assert.ok(wide.to >= '2026-08-01', `fetch range must reach well past vacationEnd, got ${wide.to}`);
});

test('vacation pay: parseCalendarResponse rejects a response whose length does not match the requested range, instead of silently accepting isdayoff.ru\'s short numeric error codes (e.g. "100"/"101"/"199") as if they were real day-by-day data', () => {
  assert.throws(() => parseCalendarResponse('100', '2027-01-01', '2027-01-20'), /unexpected isdayoff\.ru response/, 'a 3-digit error code must not be accepted for a 20-day range');
  assert.throws(() => parseCalendarResponse('', '2027-01-01', '2027-01-05'), /unexpected isdayoff\.ru response/, 'empty response must not be accepted');
  assert.throws(() => parseCalendarResponse('abc', '2027-01-01', '2027-01-03'), /unexpected isdayoff\.ru response/, 'non-numeric response must not be accepted');

  const calendar = parseCalendarResponse('00110', '2027-01-01', '2027-01-05');
  assert.deepEqual(calendar, {
    '2027-01-01': '0', '2027-01-02': '0', '2027-01-03': '1', '2027-01-04': '1', '2027-01-05': '0',
  }, 'a correctly-sized response must still parse into a full per-day calendar');
});

test('vacation pay: end-to-end reproduction of the calendarFetchRange bug through calculateVacation — a too-narrow fetch window used to make both paydays collapse onto the same wrong (too-early) date', () => {
  // Real isdayoff.ru data (verified live against the actual API during
  // triage) marks Jan 8-11 2027 as working days — all-working here, rather
  // than buildCalendarFixture's plain day-of-week rule, to isolate exactly
  // the "fetch range too narrow" bug instead of mixing in unrelated weekend
  // logic. With the old +5-day bound, calendar['2027-01-10'] and
  // calendar['2027-01-20'] were both undefined (outside the fetched range),
  // isWorkingDay() treated that as "not a working day", and
  // rollBackToWorkingDay() walked backward until it hit an in-range date,
  // producing two identical, wrong payment dates.
  const { from, to } = calendarFetchRange('2027-01-01', '2027-01-01');
  const calendar = {};
  let d = from;
  while (d <= to) {
    calendar[d] = '0'; // everything a working day — isolates the range bug alone
    d = addDaysFixture(d, 1);
  }
  const result = calculateVacation({
    salary: 100000, salaryIsGross: false, vacationStart: '2027-01-01', vacationEnd: '2027-01-01', payday1: 10, payday2: 20,
  }, calendar);
  assert.deepEqual(result.payments.map((p) => `${p.day}:${p.date}`), ['10:2027-01-10', '20:2027-01-20']);
});

test('vacation pay: input validation, and one real end-to-end call against isdayoff.ru through the actual route (network-dependent — the only test in this file that is; everything else above is offline against a hand-built calendar)', async () => {
  const badSalaryRes = await fetch(`${baseUrl}/api/vacation/calculate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ salary: 0, vacationStart: '2026-09-01', vacationEnd: '2026-09-14', payday1: 5, payday2: 20 }),
  });
  assert.equal(badSalaryRes.status, 400);

  const badDatesRes = await fetch(`${baseUrl}/api/vacation/calculate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ salary: 100000, vacationStart: '2026-09-14', vacationEnd: '2026-09-01', payday1: 5, payday2: 20 }),
  });
  assert.equal(badDatesRes.status, 400, 'end before start must be rejected');

  const badPaydayRes = await fetch(`${baseUrl}/api/vacation/calculate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ salary: 100000, vacationStart: '2026-09-01', vacationEnd: '2026-09-14', payday1: 32, payday2: 20 }),
  });
  assert.equal(badPaydayRes.status, 400);

  const okRes = await fetch(`${baseUrl}/api/vacation/calculate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ salary: 100000, salaryIsGross: false, vacationStart: '2026-09-01', vacationEnd: '2026-09-14', payday1: 5, payday2: 20 }),
  });
  assert.equal(okRes.status, 200);
  const body = await okRes.json();
  assert.equal(body.calendarAvailable, true, 'isdayoff.ru should be reachable in CI; if this starts flaking, the service itself is down, not the code');
  assert.equal(body.vacationPay.date, '2026-08-28');
  assert.equal(body.vacationPay.amount, body.netSalary / 29.3 * body.vacationPay.paidDays);
});

// ---------- Budget forecast draft (routes/budget-forecast.js) ----------
test('budget forecast: empty by default, round-trips income/categories/one-off purchase, rejects invalid input, wiped by delete-all-data, unaffected by (and unaffecting) real transactions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smeta-test-forecast-'));
  const { proc, baseUrl: forecastBaseUrl } = await startServer(dir);
  try {
    const empty = await (await fetch(`${forecastBaseUrl}/api/budget-forecast/2026-09`)).json();
    assert.deepEqual(empty, { period: '2026-09', income: 0, one_off_name: '', one_off_amount: 0, items: [] });

    const badPeriodRes = await fetch(`${forecastBaseUrl}/api/budget-forecast/not-a-month`);
    assert.equal(badPeriodRes.status, 400);

    const categories = await (await fetch(`${forecastBaseUrl}/api/categories?type=expense`)).json();
    const food = categories.find((c) => c.name === 'Еда');
    const bills = categories.find((c) => c.name === 'Счета');
    const transport = categories.find((c) => c.name === 'Транспорт');

    const badIncomeRes = await fetch(`${forecastBaseUrl}/api/budget-forecast/2026-09`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ income: -1, one_off_name: '', one_off_amount: 0, items: [] }),
    });
    assert.equal(badIncomeRes.status, 400, 'negative income must be rejected');

    const dupCategoryRes = await fetch(`${forecastBaseUrl}/api/budget-forecast/2026-09`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        income: 100000, one_off_name: '', one_off_amount: 0,
        items: [{ category_id: food.id, amount: 100 }, { category_id: food.id, amount: 200 }],
      }),
    });
    assert.equal(dupCategoryRes.status, 400, 'the same category twice in one draft must be rejected');

    const incomeCategory = categories.find((c) => c.type !== 'expense');
    const wrongTypeRes = await fetch(`${forecastBaseUrl}/api/budget-forecast/2026-09`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ income: 100000, one_off_name: '', one_off_amount: 0, items: [{ category_id: 999999, amount: 100 }] }),
    });
    assert.equal(wrongTypeRes.status, 400, 'a nonexistent/non-expense category must be rejected');

    const saveRes = await fetch(`${forecastBaseUrl}/api/budget-forecast/2026-09`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        income: 100000, one_off_name: 'Клавиатура', one_off_amount: 8000,
        items: [{ category_id: food.id, amount: 40000 }, { category_id: bills.id, amount: 5000 }, { category_id: transport.id, amount: 10000 }],
      }),
    });
    assert.equal(saveRes.status, 200);
    const saved = await saveRes.json();
    assert.equal(saved.income, 100000);
    assert.equal(saved.one_off_name, 'Клавиатура');
    assert.equal(saved.one_off_amount, 8000);
    assert.equal(saved.items.length, 3);
    assert.ok(saved.items.every((i) => i.category_name), 'items carry the category name/color, not just the id');

    // Overwriting the same period replaces the item list wholesale (2 items,
    // not 5) — this is what exercises the "DELETE then re-INSERT" path in
    // the PUT handler, not just a first-time insert.
    const overwriteRes = await fetch(`${forecastBaseUrl}/api/budget-forecast/2026-09`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ income: 120000, one_off_name: '', one_off_amount: 0, items: [{ category_id: food.id, amount: 45000 }] }),
    });
    const overwritten = await overwriteRes.json();
    assert.equal(overwritten.items.length, 1);
    assert.equal(overwritten.income, 120000);

    // A real transaction in the same month must not be touched by, or
    // influence, the draft — this whole feature is explicitly supposed to be
    // invisible to routes/summary.js and everything else that reads
    // transactions.
    await fetch(`${forecastBaseUrl}/api/transactions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-09-05', type: 'expense', category_id: food.id, amount: 12345, note: 'real spending' }),
    });
    const summary = await (await fetch(`${forecastBaseUrl}/api/summary/2026-09`)).json();
    assert.equal(summary.totalExpense, 12345, 'the draft\'s planned 45000 for Еда must not leak into the real monthly summary');
    const draftAfterRealTx = await (await fetch(`${forecastBaseUrl}/api/budget-forecast/2026-09`)).json();
    assert.equal(draftAfterRealTx.items[0].amount, 45000, 'the real transaction must not change the draft either');

    // Deleting the category referenced by a draft item removes just that
    // item via ON DELETE CASCADE, instead of blocking the category delete or
    // leaving a dangling reference (see db.js schema comment).
    const anotherDraftRes = await fetch(`${forecastBaseUrl}/api/budget-forecast/2026-10`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ income: 50000, one_off_name: '', one_off_amount: 0, items: [{ category_id: transport.id, amount: 3000 }] }),
    });
    const anotherDraft = await anotherDraftRes.json();
    assert.equal(anotherDraft.items.length, 1);
    const catDeleteRes = await fetch(`${forecastBaseUrl}/api/categories/${transport.id}?reassignTo=${bills.id}`, { method: 'DELETE' });
    assert.equal(catDeleteRes.status, 204);
    const draftAfterCategoryDelete = await (await fetch(`${forecastBaseUrl}/api/budget-forecast/2026-10`)).json();
    assert.equal(draftAfterCategoryDelete.items.length, 0);

    const deleteRes = await fetch(`${forecastBaseUrl}/api/budget-forecast/2026-09`, { method: 'DELETE' });
    assert.equal(deleteRes.status, 204);
    const afterDelete = await (await fetch(`${forecastBaseUrl}/api/budget-forecast/2026-09`)).json();
    assert.deepEqual(afterDelete, { period: '2026-09', income: 0, one_off_name: '', one_off_amount: 0, items: [] });
    // Deleting an already-empty draft (no PUT ever made for this period) must
    // not error — the frontend can call this unconditionally.
    const deleteAgainRes = await fetch(`${forecastBaseUrl}/api/budget-forecast/2026-09`, { method: 'DELETE' });
    assert.equal(deleteAgainRes.status, 204);

    await fetch(`${forecastBaseUrl}/api/budget-forecast/2026-11`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ income: 90000, one_off_name: '', one_off_amount: 0, items: [{ category_id: bills.id, amount: 5000 }] }),
    });
    await fetch(`${forecastBaseUrl}/api/settings/all-data`, { method: 'DELETE' });
    const afterWipe = await (await fetch(`${forecastBaseUrl}/api/budget-forecast/2026-11`)).json();
    assert.deepEqual(afterWipe, { period: '2026-11', income: 0, one_off_name: '', one_off_amount: 0, items: [] });
  } finally {
    proc.kill('SIGTERM');
    removeDataDir(dir);
  }
});
