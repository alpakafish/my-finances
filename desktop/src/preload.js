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

  // Аутентификация — используется и на экране блокировки, и при выключении
  // защиты из Settings (нужно подтвердить личность перед тем как её снять).
  canUseTouchID: () => ipcRenderer.invoke('app-lock:can-touchid'),
  authenticate: (reason) => ipcRenderer.invoke('app-lock:authenticate', reason),
  verifyPassword: (password) => ipcRenderer.invoke('app-lock:password', password),

  // Только для lock.html: сообщает main-процессу, что можно закрыть экран блокировки.
  notifyUnlocked: () => ipcRenderer.send('app-lock:unlocked'),
});
