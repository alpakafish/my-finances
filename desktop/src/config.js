const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// Настройки самого desktop-приложения (не финансовые данные — те в SQLite).
// Простой JSON-файл в userData, никаких секретов внутри не хранится: только
// булев флаг «включена ли защита паролем/Touch ID».
function configPath() {
  return path.join(app.getPath('userData'), 'desktop-config.json');
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch (_) {
    return {};
  }
}

function writeConfig(patch) {
  const merged = { ...readConfig(), ...patch };
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(merged, null, 2));
  return merged;
}

module.exports = {
  isAppLockEnabled: () => readConfig().appLockEnabled === true,
  setAppLockEnabled: (enabled) => writeConfig({ appLockEnabled: !!enabled }),

  // Тема оформления — desktop-only (см. desktop/DARK_THEME.md), веб-версия
  // этот файл вообще не читает. 'system' по умолчанию, как и в референсах
  // (Telegram/JetBrains) — явный выбор пользователя, не только auto по ОС.
  getThemePreference: () => {
    const v = readConfig().themePreference;
    return v === 'light' || v === 'dark' ? v : 'system';
  },
  setThemePreference: (pref) => writeConfig({ themePreference: pref === 'light' || pref === 'dark' ? pref : 'system' }),
};
