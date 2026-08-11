// Интеграционный тест общего бэкенда (server.js/db.js/routes/*) — того самого
// кода, что использует и веб-версия, и desktop-приложение. Поднимает реальный
// процесс на случайном порту с временным DATA_DIR, бьёт по нему http.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let child;
let baseUrl;
const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smeta-test-'));

before(async () => {
  await new Promise((resolve, reject) => {
    child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT: '0', DATA_DIR: tmpDataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => reject(new Error('server did not start in time')), 10_000);
    child.stdout.on('data', (d) => {
      const m = d.toString().match(/:(\d+)$/m);
      if (m) {
        clearTimeout(timer);
        baseUrl = `http://127.0.0.1:${m[1]}`;
        resolve();
      }
    });
    child.stderr.on('data', (d) => process.stderr.write(`[server stderr] ${d}`));
    child.on('exit', (code) => { if (code !== 0 && code !== null) reject(new Error(`server exited early with ${code}`)); });
  });
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
