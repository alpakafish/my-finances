const { contextBridge, ipcRenderer } = require('electron');

// Общий мост для основной страницы приложения (Settings -> переключатель защиты)
// и для отдельного lock.html (экран входа при запуске). Ни один из методов не
// даёт доступа к Node/файловой системе из страницы — только точечные IPC-вызовы
// (contextIsolation+sandbox включены в main.js для обоих окон).
contextBridge.exposeInMainWorld('desktopApp', {
  isDesktop: true,
  platform: process.platform,

  // Версия приложения (Settings, футер вкладки)
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),

  // Ручная проверка обновлений (Settings). Диалоги (скачать?/установить?)
  // показывает main-процесс нативно — этот вызов просто их запускает.
  checkForUpdates: () => ipcRenderer.invoke('update:check'),

  // Настройка «Защищать приложение паролем» (Settings)
  getAppLockEnabled: () => ipcRenderer.invoke('app-lock:get'),
  setAppLockEnabled: (enabled) => ipcRenderer.invoke('app-lock:set', enabled),

  // Аутентификация — используется только внутри lock.html/lock.js (и экран
  // входа при запуске, и подтверждение перед выключением защиты в Settings —
  // см. confirmIdentity ниже — это один и тот же экран в разных режимах).
  canUseTouchID: () => ipcRenderer.invoke('app-lock:can-touchid'),
  authenticate: (reason) => ipcRenderer.invoke('app-lock:authenticate', reason),
  verifyPassword: (password) => ipcRenderer.invoke('app-lock:password', password),

  // Подтвердить личность перед действием вроде выключения защиты паролем
  // (Settings). Открывает нативное окно (Touch ID/пароль, с кнопкой
  // "Отмена") и резолвится true/false — сам основной процесс всё показывает,
  // здесь никакого window.prompt()/window.alert() из этой страницы не нужно
  // (Electron не отрисовывает window.prompt() в BrowserWindow, поэтому
  // раньше это делалось так и молча не работало на Windows).
  confirmIdentity: (reason) => ipcRenderer.invoke('app-lock:confirm-identity', reason),

  // Только для lock.html: сообщает main-процессу, что можно закрыть экран блокировки.
  notifyUnlocked: () => ipcRenderer.send('app-lock:unlocked'),
});
