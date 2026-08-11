const { contextBridge } = require('electron');

// Фронтенд (public/app.js) сегодня ничего отсюда не использует — вся работа
// идёт через тот же HTTP API, что и в веб-версии. Оставлено как безопасная,
// доступная точка расширения (например, для «О программе»), без доступа к
// Node/файловой системе из страницы (contextIsolation+sandbox включены в main.js).
contextBridge.exposeInMainWorld('desktopApp', {
  version: process.env.npm_package_version || null,
  platform: process.platform,
});
