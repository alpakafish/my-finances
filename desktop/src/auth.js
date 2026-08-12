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

// Аналог verifyMacPassword для Windows: сверяем пароль с текущей учётной записью
// через .NET PrincipalContext.ValidateCredentials (System.DirectoryServices.AccountManagement),
// которую PowerShell даёт "из коробки" — без нативного Node-модуля (см. CLAUDE.md про
// node:sqlite и то же самое соображение — на машине пользователя может не быть настроенных
// build tools). Имя пользователя и пароль передаются процессу только через stdin (никогда
// через argv/env/лог), как и в мак-варианте.
// Ограничение: ValidateCredentials с контекстом 'Machine' проверяет локальные учётные
// записи Windows; для входа через учётную запись Microsoft (очень частый случай на Windows
// 10/11) может не сработать — тогда единственный способ снять защиту в таком билде это
// удалить desktop-config.json (см. config.js) вручную.
function verifyWindowsPassword(password) {
  return new Promise((resolve) => {
    const username = os.userInfo().username;
    const script = [
      'Add-Type -AssemblyName System.DirectoryServices.AccountManagement',
      '$u = [Console]::In.ReadLine()',
      '$p = [Console]::In.ReadLine()',
      "$ctx = New-Object System.DirectoryServices.AccountManagement.PrincipalContext('Machine')",
      'if ($ctx.ValidateCredentials($u, $p)) { exit 0 } else { exit 1 }',
    ].join('; ');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
    });
    let settled = false;
    const finish = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    child.on('exit', (code) => finish(code === 0));
    child.on('error', () => finish(false));
    child.stdin.write(`${username}\n${password}\n`);
    child.stdin.end();
  }).then((ok) => (ok ? { ok: true, method: 'password' } : { ok: false, method: 'password', error: 'Неверный пароль' }));
}

function verifyPassword(password) {
  return process.platform === 'win32' ? verifyWindowsPassword(password) : verifyMacPassword(password);
}

module.exports = { canUseTouchID, promptTouchID, verifyPassword };
