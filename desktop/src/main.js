const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Menu, shell, dialog, session, ipcMain } = require('electron');
const log = require('electron-log/main');
const { autoUpdater } = require('electron-updater');
const { Backend, dataDir } = require('./backend');
const { buildMenu } = require('./menu');
const config = require('./config');
const auth = require('./auth');

log.initialize();
log.transports.file.level = 'info';
log.transports.console.level = app.isPackaged ? false : 'debug';
autoUpdater.logger = log;
// По умолчанию electron-updater скачивает найденное обновление сразу, без
// вопроса — спрашиваем явно перед скачиванием вместо этого (см.
// 'update-available' ниже). macOS отдельно от Gatekeeper проверяет
// код-подпись скачанного обновления на соответствие подписи уже
// установленного приложения ("designated requirement") через Squirrel.Mac —
// это требует, чтобы каждая сборка подписывалась одним и тем же
// сертификатом. См. CLAUDE.md "Apple signing/notarization" про
// самоподписанный сертификат, который для этого используется без платного
// Apple Developer Program.
autoUpdater.autoDownload = false;
let manualUpdateCheck = false;

// Financial data — keep it out of logs.
log.hooks.push((message) => {
  const text = String(message.data?.[0] ?? '');
  if (/password|token|secret|api[_-]?key/i.test(text)) {
    message.data = ['[redacted]'];
  }
  return message;
});

// Electron берёт имя для userData/logs из package.json ("name": "my-finances-desktop"),
// а не из productName электрон-билдера — задаём явно, чтобы пути на диске совпадали
// с тем, что описано в README ("My Finances"), а не с internal npm-именем пакета.
app.setName('My Finances');

const backend = new Backend();
let mainWindow = null;
let quitting = false;

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 860,
    minHeight: 560,
    title: 'My Finances',
    backgroundColor: '#f5f5f3',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    show: false,
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(`http://127.0.0.1:${port}/`);

  // Открывать любые внешние ссылки в системном браузере, а не в самом приложении.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`http://127.0.0.1:${port}`)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function showFatalError(title, message) {
  log.error(`[fatal] ${title}: ${message}`);
  dialog.showErrorBox(title, message);
}

// app.getVersion() читает "version" из desktop/package.json, которую электрон-билдер
// зашивает в бандл при сборке — всегда совпадает с фактической версией установленного
// приложения (в отличие от веб-версии, у которой при желании проверить актуальность
// своего экземпляра нет смысла — она всегда последняя, т.к. запускается из исходников).
ipcMain.handle('app:get-version', () => app.getVersion());

// ---------- Защита паролем/Touch ID ----------
// IPC-обёртки над desktop/src/auth.js + config.js. Пароль (если введён) идёт
// напрямую в auth.verifyMacPassword и никогда не логируется и не сохраняется —
// см. log.hooks выше, которое дополнительно вычищает похожие на пароль строки.
ipcMain.handle('app-lock:get', () => config.isAppLockEnabled());
ipcMain.handle('app-lock:set', (event, enabled) => { config.setAppLockEnabled(enabled); return true; });
ipcMain.handle('app-lock:can-touchid', () => auth.canUseTouchID());
ipcMain.handle('app-lock:authenticate', (event, reason) => auth.promptTouchID(reason || 'Открыть «Мои финансы»'));
ipcMain.handle('app-lock:password', (event, password) => auth.verifyMacPassword(password));

function showLockScreen() {
  return new Promise((resolve) => {
    const lockWin = new BrowserWindow({
      width: 380,
      height: 380,
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: 'Мои финансы — вход',
      backgroundColor: '#f5f5f3',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
      show: false,
    });
    lockWin.setMenuBarVisibility(false);
    lockWin.once('ready-to-show', () => lockWin.show());
    lockWin.loadFile(path.join(__dirname, 'lock.html'));

    let resolved = false;
    const onUnlocked = () => {
      if (resolved) return;
      resolved = true;
      ipcMain.removeListener('app-lock:unlocked', onUnlocked);
      lockWin.close();
      resolve(true);
    };
    ipcMain.on('app-lock:unlocked', onUnlocked);
    lockWin.on('closed', () => {
      ipcMain.removeListener('app-lock:unlocked', onUnlocked);
      if (!resolved) { resolved = true; resolve(false); }
    });
  });
}

async function launch() {
  // Экспорт в Excel скачивается фронтендом как обычный download — вместо тихого
  // сохранения в ~/Downloads показываем нативный Save As с осмысленным именем.
  session.defaultSession.on('will-download', (event, item) => {
    const suggested = item.getFilename() || `smeta-export-${new Date().toISOString().slice(0, 10)}.xlsx`;
    const savePath = dialog.showSaveDialogSync(mainWindow, {
      defaultPath: path.join(app.getPath('downloads'), suggested),
      filters: [{ name: 'Excel', extensions: ['xlsx'] }],
    });
    if (!savePath) { item.cancel(); return; }
    item.setSavePath(savePath);
  });

  backend.onCrash = (err) => {
    showFatalError(
      'Бэкенд остановлен',
      `Внутренний сервис приложения аварийно завершился и не смог перезапуститься.\n\n${err.message}\n\nПерезапустите приложение. Если проблема повторится, посмотрите логи:\n${log.transports.file.getFile().path}`
    );
  };

  try {
    const port = await backend.start();

    if (config.isAppLockEnabled()) {
      const unlocked = await showLockScreen();
      if (!unlocked) { app.quit(); return; }
    }

    createWindow(port);
    Menu.setApplicationMenu(buildMenu({
      onCheckForUpdates: () => {
        manualUpdateCheck = true;
        autoUpdater.checkForUpdates().catch((e) => log.warn('[updater]', e.message));
      },
    }));
    // app-update.yml существует только в билдах, собранных с --publish (настоящий релиз);
    // в локальных dev-сборках (--dir/без publish) его нет — не дёргаем апдейтер впустую.
    const updateConfigExists = fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'));
    if (app.isPackaged && updateConfigExists) {
      autoUpdater.checkForUpdates().catch((e) => log.warn('[updater]', e.message));
    }
  } catch (e) {
    showFatalError(
      'Не удалось запустить приложение',
      `Внутренний сервис не смог стартовать.\n\n${e.message}\n\nПроверьте, что каталог с данными доступен для записи:\n${dataDir()}`
    );
    app.quit();
  }
}

app.whenReady().then(launch);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && backend.port) createWindow(backend.port);
});

app.on('before-quit', () => {
  quitting = true;
  backend.stop();
});

process.on('uncaughtException', (err) => {
  log.error('[main:uncaughtException]', err);
  if (!quitting) showFatalError('Непредвиденная ошибка', err.message);
});

autoUpdater.on('error', (err) => log.error('[updater:error]', err.message));

autoUpdater.on('update-available', (info) => {
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Доступно обновление',
    message: `Вышла новая версия My Finances (${info.version}). Скачать её сейчас?`,
    detail: 'Скачивание идёт в фоне, приложение продолжит работать. Ваши данные обновление не затрагивает.',
    buttons: ['Скачать', 'Не сейчас'],
  }).then(({ response }) => {
    if (response === 0) autoUpdater.downloadUpdate().catch((e) => log.warn('[updater]', e.message));
  });
});

autoUpdater.on('update-not-available', () => {
  if (!manualUpdateCheck) return;
  manualUpdateCheck = false;
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Обновлений нет',
    message: 'У вас уже установлена последняя версия My Finances.',
  });
});

autoUpdater.on('update-downloaded', () => {
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Обновление готово',
    message: 'Новая версия My Finances загружена и будет установлена при перезапуске.',
    detail: 'Ваши данные (база данных в Application Support) обновление не затрагивает.',
    buttons: ['Перезапустить сейчас', 'Позже'],
  }).then(({ response }) => {
    if (response === 0) autoUpdater.quitAndInstall();
  });
});
