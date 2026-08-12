(async () => {
  // Два режима, один и тот же экран: 'unlock' (запуск приложения, закрытие
  // окна = выход из приложения — см. main.js showAuthWindow/launch) и
  // 'confirm' (подтвердить личность перед действием вроде выключения защиты —
  // закрытие/отмена просто ничего не меняет, приложение продолжает работать).
  // Раньше "confirm" делался через window.prompt() прямо в public/app.js —
  // Electron не отрисовывает window.prompt() в BrowserWindow вообще (в
  // отличие от alert()/confirm()), так что на Windows, где нет Touch ID и
  // confirm-путь срабатывает всегда, экран просто не появлялся — молча
  // ничего не происходило (2026-08-12). Теперь оба режима — то же самое
  // нативное окно с паролем, которое уже работало для unlock.
  const params = new URLSearchParams(location.search);
  const mode = params.get('mode') || 'unlock';
  const reason = params.get('reason') || '';

  const titleText = document.getElementById('titleText');
  const subtitleText = document.getElementById('subtitleText');
  const touchIdRow = document.getElementById('touchIdRow');
  const touchIdBtn = document.getElementById('touchIdBtn');
  const divider = document.getElementById('divider');
  const pwForm = document.getElementById('pwForm');
  const pwInput = document.getElementById('pwInput');
  const pwError = document.getElementById('pwError');
  const cancelBtn = document.getElementById('cancelBtn');

  const accountLabel = window.desktopApp.platform === 'win32' ? 'Windows' : 'Mac';
  pwInput.placeholder = `Пароль учётной записи ${accountLabel}`;
  divider.textContent = `или паролем от ${accountLabel}`;

  if (mode === 'confirm') {
    titleText.textContent = 'Подтвердите личность';
    subtitleText.textContent = reason || 'Подтвердите личность, чтобы продолжить';
    cancelBtn.hidden = false;
    cancelBtn.addEventListener('click', () => window.close());
  }

  function unlock() {
    window.desktopApp.notifyUnlocked();
  }

  async function tryTouchId() {
    pwError.textContent = '';
    const result = await window.desktopApp.authenticate(reason || 'Открыть «Мои финансы»');
    if (result.ok) unlock();
  }

  const canTouchId = await window.desktopApp.canUseTouchID();
  if (canTouchId) {
    touchIdRow.hidden = false;
    touchIdBtn.addEventListener('click', tryTouchId);
    tryTouchId(); // сразу предлагаем Touch ID при открытии экрана
  }

  pwForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    pwError.textContent = '';
    if (!pwInput.value) return;
    const result = await window.desktopApp.verifyPassword(pwInput.value);
    pwInput.value = '';
    if (result.ok) {
      unlock();
    } else {
      pwError.textContent = 'Неверный пароль';
      pwInput.focus();
    }
  });
})();
