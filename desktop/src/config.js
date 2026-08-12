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
};
