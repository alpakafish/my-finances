const path = require('path');
const fs = require('fs');
const { app, utilityProcess } = require('electron');
const log = require('electron-log/main');

// В dev backendRoot — это сам smeta-web (два уровня вверх от desktop/src/).
// В упакованном приложении electron-builder копирует server.js/db.js/routes/public/
// node_modules в Resources/app (см. electron-builder.yml -> extraResources),
// поэтому там backendRoot — это resourcesPath/app.
function backendRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app')
    : path.join(__dirname, '..', '..');
}

function dataDir() {
  return path.join(app.getPath('userData'), 'data');
}

const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 30_000;

class Backend {
  constructor() {
    this.child = null;
    this.port = null;
    this.restarts = [];
    this.intentionalShutdown = false;
    this.everReadied = false; // true once we've reached 'server-ready' at least once, ever
    this.onCrash = null; // set by main.js: called when restarts are exhausted (fatal)
    this.onRestart = null; // set by main.js: called with the new port after a crash-restart
    // succeeds — PORT=0 means every fork gets a fresh random port, so an
    // already-open window pointed at the old one otherwise never reconnects
    // (not even via the menu's manual "Reload" — that just re-fetches the
    // same, now-dead, URL). Found 2026-08-14 during a codebase review: no
    // code anywhere called loadURL() again after the very first launch.
  }

  // Single Promise for the whole lifetime of the very first launch attempt —
  // _spawn() below is called again (same resolve/reject) on every crash-retry
  // instead of creating a new Promise per attempt. That's what lets a crash
  // that happens before the backend has EVER reached 'server-ready' correctly
  // reject this promise once retries are exhausted (previously: retries called
  // a brand-new this.start(), and this original Promise just hung forever —
  // launch()'s catch block, and its app.quit(), never ran; the only feedback
  // was a separate onCrash() dialog, leaving a windowless zombie process).
  // Calling resolve()/reject() again after this promise has already settled
  // (the common case: a crash+restart well after a successful initial start)
  // is a harmless no-op in JS — that's intentional, not an oversight.
  start() {
    return new Promise((resolve, reject) => {
      this._spawn(resolve, reject);
    });
  }

  _spawn(resolve, reject) {
    const entry = path.join(backendRoot(), 'server.js');
    if (!fs.existsSync(entry)) {
      reject(new Error(`Backend entry point not found: ${entry}`));
      return;
    }

    fs.mkdirSync(dataDir(), { recursive: true });

    log.info(`[backend] starting ${entry} (cwd=${backendRoot()})`);
    this.intentionalShutdown = false;
    const child = utilityProcess.fork(entry, [], {
      cwd: backendRoot(),
      env: {
        ...process.env,
        DATA_DIR: dataDir(),
        PORT: '0',
        NODE_ENV: 'production',
      },
      stdio: 'pipe',
    });
    this.child = child;

    // 30s, not 10s: on a fresh Windows install (unsigned build — no paid code
    // signing cert, see CLAUDE.md) Windows Defender/SmartScreen can spend
    // several seconds scanning the just-downloaded/installed exe and its
    // node_modules the first time anything in that folder actually runs,
    // which can blow straight through a tight timeout even though the
    // backend itself starts fine. Found 2026-08-12: user hit "did not
    // report readiness within 10s" once right after install, then the app
    // launched normally on every retry (the exe was already Defender-scanned
    // by then).
    const onReadyTimeout = setTimeout(() => {
      reject(new Error('Backend did not report readiness within 30s'));
    }, 30_000);

    child.stdout?.on('data', (d) => log.info(`[backend] ${d.toString().trim()}`));
    child.stderr?.on('data', (d) => log.error(`[backend:err] ${d.toString().trim()}`));

    child.on('message', (msg) => {
      if (msg && msg.type === 'server-ready') {
        clearTimeout(onReadyTimeout);
        this.port = msg.port;
        log.info(`[backend] ready on 127.0.0.1:${msg.port}`);
        if (this.everReadied && this.onRestart) this.onRestart(msg.port);
        this.everReadied = true;
        resolve(msg.port);
      }
    });

    child.on('exit', (code) => {
      clearTimeout(onReadyTimeout);
      log.warn(`[backend] exited with code ${code} (intentional=${this.intentionalShutdown})`);
      if (this.intentionalShutdown) return;

      const now = Date.now();
      this.restarts = this.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
      this.restarts.push(now);

      if (this.restarts.length > MAX_RESTARTS) {
        log.error('[backend] crash-looped, giving up on restart');
        const err = new Error(`Backend crashed repeatedly (exit code ${code})`);
        if (!this.everReadied) reject(err); // see start() above — otherwise this hangs forever
        if (this.onCrash) this.onCrash(err);
        return;
      }

      log.info('[backend] restarting after crash...');
      this._spawn(resolve, reject);
    });
  }

  stop() {
    this.intentionalShutdown = true;
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
  }
}

module.exports = { Backend, dataDir, backendRoot };
