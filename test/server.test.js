// Интеграционный тест общего бэкенда (server.js/db.js/routes/*) — того самого
// кода, что использует и веб-версия, и desktop-приложение. Поднимает реальный
// процесс на случайном порту с временным DATA_DIR, бьёт по нему http.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
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

  const delRes = await fetch(`${baseUrl}/api/transactions/${created.id}`, { method: 'DELETE' });
  assert.equal(delRes.status, 204);
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
    fs.rmSync(otherDataDir, { recursive: true, force: true });
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
    fs.rmSync(wipeDataDir, { recursive: true, force: true });
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
    fs.rmSync(onboardDataDir, { recursive: true, force: true });
  }
});
