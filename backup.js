const fs = require('fs');
const path = require('path');
const db = require('./db');
const { buildWorkbook } = require('./routes/export');

const BACKUPS_DIR = path.join(db.DATA_DIR, 'backups');
const KEEP_COUNT = 7;
// Раз при запуске + перепроверка раз в 6 часов, пока процесс жив — на случай,
// если приложение (особенно desktop) держат открытым по многу дней подряд, не
// перезапуская. Сам бэкап при этом создаётся не чаще раза в день (см. ниже
// проверку на файл за сегодня) — это просто подстраховка, чтобы день не
// пропустился у того, кто не перезапускает.
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function backupFilePath(date) {
  return path.join(BACKUPS_DIR, `smeta-backup-${date}.xlsx`);
}

// Последний результат (успех/ошибка) — для карточки-уведомления в приложении
// (см. routes/settings.js GET /backups) и чтобы не пытаться повторно писать
// файл, который уже есть за сегодня. В app_settings, той же таблице, что
// onboarding_seen/currency — переживает «Удалить все данные».
function recordResult(ok, error) {
  const value = JSON.stringify({ date: todayISO(), ok, error: error || null });
  db.prepare(`
    INSERT INTO app_settings (key, value) VALUES ('backup_last_result', ?)
    ON CONFLICT(key) DO UPDATE SET value = ?
  `).run(value, value);
}

function pruneOldBackups() {
  let files;
  try {
    files = fs.readdirSync(BACKUPS_DIR)
      .filter((f) => /^smeta-backup-\d{4}-\d{2}-\d{2}\.xlsx$/.test(f))
      .sort(); // дата в имени файла — сортировка по имени совпадает с сортировкой по дате
  } catch (e) {
    return;
  }
  const excess = files.length - KEEP_COUNT;
  if (excess <= 0) return;
  files.slice(0, excess).forEach((f) => {
    try { fs.unlinkSync(path.join(BACKUPS_DIR, f)); } catch (e) { /* не критично — переживёт до следующей уборки */ }
  });
}

async function runBackupIfNeeded() {
  const target = backupFilePath(todayISO());
  if (fs.existsSync(target)) return; // за сегодня уже есть

  try {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    const workbook = buildWorkbook();
    await workbook.xlsx.writeFile(target);
    recordResult(true, null);
    pruneOldBackups();
  } catch (e) {
    // Самая частая причина — нехватка места на диске (ENOSPC), но текст
    // ошибки не форсируем к конкретной причине: показываем как есть, а
    // предположение о месте — на уровне UI-подсказки (routes/settings.js
    // description), не здесь.
    recordResult(false, e.message);
  }
}

function startBackupSchedule() {
  runBackupIfNeeded();
  setInterval(runBackupIfNeeded, RECHECK_INTERVAL_MS);
}

module.exports = { startBackupSchedule, runBackupIfNeeded, BACKUPS_DIR };
