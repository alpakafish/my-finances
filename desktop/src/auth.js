const os = require('os');
const { spawn } = require('child_process');
const { systemPreferences } = require('electron');

// Touch ID через встроенный Electron API (LocalAuthentication, только биометрия —
// пароль как таковой сюда не попадает и приложение его никогда не видит).
function canUseTouchID() {
  return typeof systemPreferences.canPromptTouchID === 'function' && systemPreferences.canPromptTouchID();
}

function promptTouchID(reason) {
  return systemPreferences.promptTouchID(reason).then(
    () => ({ ok: true, method: 'touchid' }),
    (e) => ({ ok: false, method: 'touchid', error: e.message }),
  );
}

// Фолбэк для Mac без Touch ID (или если пользователь предпочитает пароль):
// пароль сверяется с реальным паролем текущей учётной записи macOS через dscl -authonly —
// стандартный способ проверить логин-пароль без запроса admin/sudo прав.
// Пароль передаётся только через stdin (никогда не через argv/лог) и нигде не сохраняется.
function verifyMacPassword(password) {
  return new Promise((resolve) => {
    const username = os.userInfo().username;
    const child = spawn('/usr/bin/dscl', ['.', '-authonly', username], { stdio: ['pipe', 'ignore', 'ignore'] });
    let settled = false;
    const finish = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    child.on('exit', (code) => finish(code === 0));
    child.on('error', () => finish(false));
    child.stdin.write(`${password}\n`);
    child.stdin.end();
  }).then((ok) => (ok ? { ok: true, method: 'password' } : { ok: false, method: 'password', error: 'Неверный пароль' }));
}

module.exports = { canUseTouchID, promptTouchID, verifyMacPassword };
