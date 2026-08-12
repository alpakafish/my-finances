// Полный запуск упакованного (unpackaged) Electron-приложения: backend startup,
// создание БД в изолированном userData, и штатное завершение по SIGTERM.
// Требует реальную графическую сессию (запускается на macOS runner в CI, не headless-Linux).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const electronBin = require('electron');

test('app boots, seeds db in userData, shuts down cleanly', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-desktop-test-'));
  const appRoot = path.join(__dirname, '..');

  const child = spawn(electronBin, [appRoot, `--user-data-dir=${userDataDir}`, '--no-sandbox'], {
    cwd: appRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stdout += d.toString(); });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`app did not report backend readiness in time. Output:\n${stdout}`)), 20_000);
    const interval = setInterval(() => {
      if (/Мои финансы запущены/.test(stdout)) {
        clearTimeout(timer);
        clearInterval(interval);
        resolve();
      }
    }, 200);
    child.on('exit', (code) => {
      clearTimeout(timer);
      clearInterval(interval);
      reject(new Error(`app exited early with code ${code}. Output:\n${stdout}`));
    });
  });

  // Backend having started implies db.js already created + seeded the sqlite file.
  const dbPath = path.join(userDataDir, 'data', 'smeta.db');
  assert.ok(fs.existsSync(dbPath), `expected db at ${dbPath}`);

  const exitCode = await new Promise((resolve) => {
    child.on('exit', (code) => resolve(code));
    child.kill('SIGTERM');
  });
  assert.equal(exitCode, 0);

  // maxRetries/retryDelay: on Windows the OS can hold the file handle on smeta.db
  // for a brief moment even after the child process's 'exit' event has fired —
  // see test/server.test.js's removeDataDir for the same EBUSY issue hit first
  // in the root backend tests (2026-08-12, first Windows CI run).
  fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
