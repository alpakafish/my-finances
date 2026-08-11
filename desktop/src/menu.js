const { app, Menu, shell, BrowserWindow } = require('electron');
const log = require('electron-log/main');

function runInPage(js) {
  const win = BrowserWindow.getFocusedWindow();
  if (win) win.webContents.executeJavaScript(js).catch((e) => log.warn('[menu]', e.message));
}

function buildMenu({ onCheckForUpdates }) {
  const isMac = process.platform === 'darwin';

  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Проверить обновления…', click: onCheckForUpdates },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'Файл',
      submenu: [
        { label: 'Импорт из Excel…', accelerator: 'CmdOrCtrl+I', click: () => runInPage("document.getElementById('importBtn')?.click()") },
        { label: 'Экспорт в Excel', accelerator: 'CmdOrCtrl+E', click: () => runInPage("document.getElementById('exportBtn')?.click()") },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Правка',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'Вид',
      submenu: [
        { label: 'Дашборд', accelerator: 'CmdOrCtrl+1', click: () => runInPage("document.querySelector('[data-tab=dashboard]')?.click()") },
        { label: 'Операции', accelerator: 'CmdOrCtrl+2', click: () => runInPage("document.querySelector('[data-tab=transactions]')?.click()") },
        { label: 'Категории', accelerator: 'CmdOrCtrl+3', click: () => runInPage("document.querySelector('[data-tab=categories]')?.click()") },
        { label: 'Цели', accelerator: 'CmdOrCtrl+4', click: () => runInPage("document.querySelector('[data-tab=goals]')?.click()") },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools', visible: !app.isPackaged },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Окно',
      submenu: [
        { role: 'minimize' }, { role: 'zoom' },
        ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : [{ role: 'close' }]),
      ],
    },
    {
      role: 'help',
      submenu: [
        { label: 'Открыть папку с логами', click: () => shell.showItemInFolder(log.transports.file.getFile().path) },
        { label: 'Открыть репозиторий на GitHub', click: () => shell.openExternal('https://github.com/alpakafish/my-finances') },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

module.exports = { buildMenu };
