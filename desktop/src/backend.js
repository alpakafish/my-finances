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
    this.onCrash = null; // set by main.js: called when restarts are exhausted
  }

  start() {
    return new Promise((resolve, reject) => {
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

      const onReadyTimeout = setTimeout(() => {
        reject(new Error('Backend did not report readiness within 10s'));
      }, 10_000);

      child.stdout?.on('data', (d) => log.info(`[backend] ${d.toString().trim()}`));
      child.stderr?.on('data', (d) => log.error(`[backend:err] ${d.toString().trim()}`));

      child.on('message', (msg) => {
        if (msg && msg.type === 'server-ready') {
          clearTimeout(onReadyTimeout);
          this.port = msg.port;
          log.info(`[backend] ready on 127.0.0.1:${msg.port}`);
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
          if (this.onCrash) this.onCrash(new Error(`Backend crashed repeatedly (exit code ${code})`));
          return;
        }

        log.info('[backend] restarting after crash...');
        this.start().catch((e) => {
          log.error('[backend] restart failed', e);
          if (this.onCrash) this.onCrash(e);
        });
      });
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
