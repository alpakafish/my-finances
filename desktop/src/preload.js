const { contextBridge, ipcRenderer } = require('electron');

// Синхронный IPC (sendSync, не invoke) — preload выполняется ДО любого скрипта
// страницы, в т.ч. до inline-скрипта в <head> index.html, который ставит
// data-theme на <html> ещё до первой отрисовки, чтобы не мигнуть не той темой
// (см. main.js "theme:get-initial-sync" и DARK_THEME.md). invoke() тут не
// подходит — он всегда возвращает Promise, то есть минимум на один тик позже,
// когда страница уже могла отрисоваться со светлой темой по умолчанию.
const initialTheme = ipcRenderer.sendSync('theme:get-initial-sync');

// Общий мост для основной страницы приложения (Settings -> переключатель защиты)
// и для отдельного lock.html (экран входа при запуске). Ни один из методов не
// даёт доступа к Node/файловой системе из страницы — только точечные IPC-вызовы
// (contextIsolation+sandbox включены в main.js для обоих окон).
contextBridge.exposeInMainWorld('desktopApp', {
  isDesktop: true,
  platform: process.platform,

  // Тема оформления (desktop-only, см. desktop/DARK_THEME.md).
  // initialThemePreference/initialEffectiveTheme — готовые значения, прочитанные
  // синхронно ДО того как выполнился этот скрипт (см. initialTheme выше);
  // get/setThemePreference — обычные async IPC для переключателя в Settings;
  // onEffectiveThemeChange — событие на случай, если пользователь выбрал
  // "Системная" и поменял тему в самой ОС, пока приложение открыто.
  initialThemePreference: initialTheme.preference,
  initialEffectiveTheme: initialTheme.effective,
  getThemePreference: () => ipcRenderer.invoke('theme:get'),
  setThemePreference: (pref) => ipcRenderer.invoke('theme:set', pref),
  onEffectiveThemeChange: (cb) => ipcRenderer.on('theme:effective-changed', (event, effective) => cb(effective)),

  // Версия приложения (Settings, футер вкладки)
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),

  // Ручная проверка обновлений (Settings). Диалоги (скачать?/установить?)
  // показывает main-процесс нативно — этот вызов просто их запускает.
  checkForUpdates: () => ipcRenderer.invoke('update:check'),

  // Кнопка «Открыть папку с бэкапами» (Settings) — открывает Finder/Проводник
  // на папке с автоматическими резервными копиями (см. backup.js). В вебе
  // недоступно (браузер не может открыть системный файловый менеджер) —
  // там вместо кнопки просто показывается путь текстом, см. public/app.js.
  openBackupsFolder: () => ipcRenderer.invoke('backups:open-folder'),

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
