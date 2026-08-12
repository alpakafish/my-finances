(async () => {
  const touchIdRow = document.getElementById('touchIdRow');
  const touchIdBtn = document.getElementById('touchIdBtn');
  const pwForm = document.getElementById('pwForm');
  const pwInput = document.getElementById('pwInput');
  const pwError = document.getElementById('pwError');

  function unlock() {
    window.desktopApp.notifyUnlocked();
  }

  async function tryTouchId() {
    pwError.textContent = '';
    const result = await window.desktopApp.authenticate('Открыть «Мои финансы»');
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
