# Architecture Decision Record — Desktop App (macOS, Windows)

## Context

`smeta-web` (repo: `alpakafish/my-finances`) is a single-user local finance
tracker: a plain Express + `node:sqlite` backend serving a static vanilla
HTML/CSS/JS frontend on `localhost:3000`. No build step, no frontend
framework, no external APIs/OAuth/API keys — the only integration is
`.xlsx` import/export via `exceljs`. `node:sqlite` is built into Node ≥ 22
(chosen specifically to avoid native compilation, see `db.js` comment and
commit `9e69f3c`).

Goal: ship a production `.app` that a non-technical user can download from
GitHub Releases and run, with no Node/terminal/localhost exposure, while
leaving the existing web app (`legacy-web` branch) fully intact and
independently runnable.

## Decision

```
Desktop framework: Electron (+ electron-builder, electron-updater, electron-log)
Frontend:          existing public/ (vanilla HTML/CSS/JS + Chart.js), unmodified,
                    loaded from the embedded backend over 127.0.0.1
Backend:           existing server.js/db.js/routes/, run unmodified inside an
                    Electron utilityProcess (own crash domain, restart logic)
Database:          node:sqlite, file moved to app.getPath('userData')/data/smeta.db
                    via DATA_DIR env override (legacy web still defaults to ./data)
IPC:               none needed for app logic — frontend already talks to the
                    backend over HTTP; Electron main <-> utilityProcess uses
                    process.send/on('message') just to hand back the bound port
Secrets:            none exist in this app today (no API keys/OAuth/tokens).
                    electron-safeStorage/Keychain is wired as a helper module for
                    any future secret, but has nothing to store yet — documented,
                    not fabricated
Application data:  ~/Library/Application Support/My Finances (mac) /
                    %APPDATA%\My Finances (Windows) — db + logs
Updates:           electron-updater, GitHub Releases provider
Packaging:         electron-builder; mac targets dmg + zip (arch [arm64, x64]),
                    Windows target nsis (arch [x64] only — added 2026-08-12)
Signing:           mac — self-signed cert via CI secrets (CSC_LINK/CSC_KEY_PASSWORD,
                    see CLAUDE.md; not a real Apple Developer ID). Windows — none
                    (unsigned NSIS installer, SmartScreen bypass documented in README)
Notarization:      @electron/notarize via electron-builder afterSign hook,
                    Apple ID / app-specific password / team ID from CI secrets
                    (mac only — not applicable to Windows)
CI/CD:             GitHub Actions, two independent workflows publishing into the
                    same GitHub Release: macos-latest (arm64 + x64, signs when
                    secrets present) and windows-latest (x64, always unsigned)
```

## Why Electron, not Tauri or native Swift

**Tauri** would need the Node backend either (a) rewritten in Rust — throwing
away ~650 lines of working, tested Express/SQLite business logic (imports,
exports, goal math, category rollups) for no functional gain, or (b) shipped
as a bundled Node sidecar binary (`pkg`/`nexe`), which is extra build
complexity to reinvent something Electron gives for free: Electron's main
process *is* a full Node.js runtime.

**Native Swift/AppKit** means a full rewrite of both frontend and backend —
by far the largest effort and highest risk of silently dropping a feature,
for an app whose UI is a handful of static screens, not something that needs
deep native platform integration.

**Electron** lets the existing backend run essentially unchanged (two small,
backward-compatible edits: `DATA_DIR` override in `db.js`, loopback bind +
graceful shutdown in `server.js` — both no-ops for the web version) inside a
`utilityProcess`, and the existing frontend loads unmodified in a
`BrowserWindow`. This is the smallest, lowest-risk path to a real native
`.app`, at the cost of a larger bundle size than Tauri (~150–200MB vs
~10-20MB) — an accepted tradeoff given the app has no performance-sensitive
UI and the priority is not losing functionality.

## Consequences / known tradeoffs

- Bundle size is Electron-sized, not Tauri-sized. Acceptable for a personal
  finance app with no bandwidth-sensitive distribution requirement.
- The app still runs an HTTP server internally (implementation detail, bound
  to `127.0.0.1` on an OS-assigned port, never exposed to the user).
- No secrets exist to protect today, so Phase 6 (Keychain) ships as a ready,
  unused helper rather than a real integration — documented in README rather
  than overstated.
- Code signing/notarization require Apple Developer credentials this
  environment does not have installed (`security find-identity` returns zero
  identities). CI is fully wired for it via GitHub Secrets; local builds are
  unsigned dev builds until those secrets are added.
