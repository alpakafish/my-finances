# CLAUDE.md

Guidance for Claude Code (or any agent) working in this repo.

## Project shape

`smeta-web` is a personal finance tracker with **two front doors sharing one backend**:

- **Web** (`legacy-web` branch): `npm start` → `server.js` on `localhost:3000`.
- **Desktop** (`desktop-macos` branch, `desktop/`): Electron app that embeds the
  same backend in a `utilityProcess` and loads the same frontend in a window.
  See `desktop/ARCHITECTURE.md` for the full design rationale.

`server.js`, `db.js`, `routes/*.js`, and `public/*` (`index.html`, `app.js`,
`styles.css`) are **shared** — a change there affects both web and desktop
automatically. There is no build step and no frontend framework: vanilla
HTML/CSS/JS + Chart.js, Express + `node:sqlite` on the backend.

## Onboarding tour — keep it in sync

`public/app.js` has a guided tour (`TOUR_STEPS`, search `Onboarding tour`) that
spotlights UI elements tab-by-tab, shown once automatically and replayable via
the `?` button in the header (`#helpBtn`).

**Whenever you add, remove, rename, or move a tab/feature/button, re-check
`TOUR_STEPS` in the same change**: update or add a step, fix a `selector` that
no longer matches, or delete a step for something that no longer exists. A
stale tour (highlighting a moved button, or silently skipping new
functionality) is a real regression, not a cosmetic detail — treat it as part
of the feature, not a follow-up.

Gotcha when picking a `selector`: don't target an element that lives inside a
horizontally-scrollable container (`.chart-scroll-inner`, which is 200% width
by design — see below) directly, e.g. a `<canvas>` — its bounding rect can be
much wider than what's visible, producing a spotlight that bleeds into empty
space. Target the enclosing `.card` (give it an `id` if it doesn't have one)
instead.

## Dashboard/years chart-scroll pattern

`.chart-scroll` (outer, `width:100%`) + `.chart-scroll-inner` (`width:200%`)
is how the 12-month bar charts show exactly 6 months at a time with the rest
reachable by horizontal scroll, responsively (no fixed pixel widths). Reuse
this pattern for any new "show N of 2N" chart rather than inventing another
one.

## Desktop-specific gotchas learned the hard way

- `utilityProcess.fork()` (how the desktop app runs the backend) does **not**
  give the child `process.send()`. Use `process.parentPort.postMessage()`
  from the child, `child.on('message', ...)` from the parent. `server.js`
  handles both (`process.send` for a plain `child_process.fork`, `parentPort`
  for Electron) so it stays correct for the web path too.
- `app.getName()` (and therefore the userData/logs folder name) comes from
  `package.json`'s `"name"`, not electron-builder's `productName`, unless you
  call `app.setName()` explicitly. `desktop/src/main.js` does this so paths
  match what README documents.
- `titleBarStyle: 'hiddenInset'` does not make the window draggable by
  itself — the web content needs `-webkit-app-region: drag` on the header
  (with `no-drag` on anything clickable inside it). See `.header` in
  `styles.css`.
- App-lock (Settings → "Защищать приложение паролем") uses Touch ID via
  `systemPreferences.promptTouchID()` when available, and falls back to
  verifying the macOS account password via `dscl . -authonly <user>` (password
  piped through stdin only, never argv, never logged) — see `desktop/src/auth.js`.
  On Windows there's no Touch ID equivalent wired up (Electron's
  `systemPreferences.canPromptTouchID` is macOS-only and just returns
  `false`/`undefined` there, so the lock screen falls back to the password
  field automatically, no platform branching needed in `lock.js`/`lock.html`).
  The Windows password check (`verifyWindowsPassword` in `auth.js`) shells out
  to `powershell.exe` and validates via
  `System.DirectoryServices.AccountManagement.PrincipalContext('Machine').ValidateCredentials`
  — same stdin-only-password discipline as the mac path. **Caveat**: this only
  validates local Windows accounts; a user signed into Windows with a
  Microsoft account may find app-lock never accepts their password (Microsoft
  account credentials aren't checked by the local `Machine` context) — no fix
  currently, the only way out in that case is deleting
  `desktop-config.json` (`config.js`) to force-disable app-lock. Both mac and
  Windows implementations are unified behind `auth.verifyPassword(password)`,
  which branches on `process.platform` — call sites (`main.js`) never call the
  platform-specific functions directly.
- **Never store a "seen it once" / preference flag in `localStorage` for
  anything that needs to survive a desktop relaunch.** The desktop backend
  binds to `PORT=0` (a fresh random port every launch, on purpose, to avoid
  conflicts) — `localStorage` is scoped per-origin
  (`http://127.0.0.1:<port>`), so a new port each launch means a new origin
  each launch, and the flag never "carries over" even though it really was
  saved. Symptom: something that should happen once (e.g. onboarding) happens
  on every launch instead. Fix: persist it server-side (SQLite `app_settings`
  key/value table, or a file under `DATA_DIR`) via a small API route instead —
  see `/api/settings/onboarding-seen` in `routes/settings.js` for the pattern.
- **A shared `routes/*.js` file doing `require('../package.json')` (or
  reading any other repo-root-only file) crash-loops the whole desktop
  backend on startup, silently — not just that one route.** Desktop's
  `extraResources` (`electron-builder.yml`) copies `server.js`, `db.js`,
  `routes/`, `public/`, and `node_modules/` into `Resources/app/`, but *not*
  `package.json` — it doesn't need it for anything else. A module-level
  `require` that assumes it's there throws at load time, before Express even
  starts, and the desktop backend's restart-on-crash logic just gives up
  after a few attempts (`crash-looped, giving up on restart` in
  `main.log`) — found via `/api/settings/version` (`routes/settings.js`),
  2026-08-12. The `npm test` desktop smoke test does **not** catch this: it
  runs `../server.js` straight from the repo (dev mode), where the root
  `package.json` genuinely is one level up — only a real packaged `--dir`
  build + actual launch exposes the missing-file problem, per "Rebuild
  before claiming a desktop-side fix works" above. Fix: wrap that kind of
  require in try/catch with a safe fallback rather than assuming it's there.

**`window.prompt()` does not render anything in an Electron `BrowserWindow` —
found via a real user report on v1.0.11, 2026-08-12.** Unlike
`window.alert()`/`window.confirm()` (which Electron does implement as native
dialogs), `window.prompt()` for free-text input is a known long-standing gap
— calling it produces no visible UI at all, not an error, just nothing (see
electron/electron#40341). `public/app.js`'s "disable app-lock" flow used to
call `window.prompt()` as a fallback when Touch ID wasn't available/declined
— this silently did nothing on Windows (which has no Touch ID at all, so
that fallback path is the *only* path there, hit on every attempt) and
likely never really worked reliably on Mac either (just went unnoticed
because most Mac testers have Touch ID and never hit the fallback). Fixed by
removing `window.prompt()`/`window.confirm()`-style renderer dialogs from
this app's playbook entirely: `desktop/src/main.js`'s `showLockScreen()`
(the existing native password/Touch ID window used for launch-time unlock)
was generalized into `showAuthWindow({mode, reason})`, reused via a new
`app-lock:confirm-identity` IPC handler for the disable-lock confirmation
too (mode `'confirm'` adds a Cancel button via `lock.html`/`lock.js`, mode
`'unlock'` is the original launch-time behavior unchanged). `public/app.js`
now just calls `window.desktopApp.confirmIdentity(reason)` and gets a plain
boolean — no dialog logic in the renderer at all. **General lesson: never
reach for `window.prompt()`/`window.confirm()` in this codebase's Electron
renderer code — they don't render.** `alert()` does work but wasn't used
here regardless, in favor of the existing `toast()` pattern.

**Windows icon looked noticeably smaller than other apps' icons (taskbar,
Start menu, desktop shortcut) — user report, 2026-08-12.** `build/icon.png`
(shared source electron-builder converts to both `.icns` and `.ico`) is
drawn with generous transparent padding around the circular badge — normal
for macOS icons (Big Sur+ "safe zone" convention keeps content around ~78%
of the canvas so the OS's own rounded-square puffiness reads consistently
across apps) but Windows has no such convention, so the same PNG reused
as-is for `.ico` conversion just looks under-filled/small next to other
Windows icons. Fixed with a Windows-only icon source,
`desktop/build/icon-windows.png` — same artwork, cropped to the alpha
channel's bounding box and rescaled to fill ~90% of a 1024×1024 canvas
instead of ~78%, `win.icon` in `electron-builder.yml` points at it instead
of the shared `build/icon.png` (`mac.icon` still points at `build/icon.icns`,
untouched). Regenerate after any edit to the source `build/icon.png` with:
```bash
python3 -c "
from PIL import Image
im = Image.open('build/icon.png')
bbox = im.getbbox()
cropped = im.crop(bbox)
cw, ch = cropped.size
canvas_size = 1024
fill_fraction = 0.92
scale = (canvas_size * fill_fraction) / max(cw, ch)
new_w, new_h = round(cw * scale), round(ch * scale)
resized = cropped.resize((new_w, new_h), Image.LANCZOS)
canvas = Image.new('RGBA', (canvas_size, canvas_size), (0, 0, 0, 0))
x, y = (canvas_size - new_w) // 2, (canvas_size - new_h) // 2
canvas.paste(resized, (x, y), resized)
canvas.save('build/icon-windows.png')
"
```
No checked-in script for this (needs Pillow, a dependency the repo
otherwise has zero use for) — it's a rare, manual, one-off regeneration, not
worth a permanent `sharp`/`jimp` devDependency (the latter would also cut
against the whole `node:sqlite`-over-`better-sqlite3` "avoid native/extra
toolchain deps" stance elsewhere in this file).

## Testing

- **Never** run a test server against the default `DATA_DIR` (`./data/`) —
  that's the user's real financial data. Always set `DATA_DIR=/tmp/...` (or
  similar) when starting `server.js` for manual/automated testing.
- Backend integration tests: `npm test` (root) — spawns real `server.js`
  processes against temp `DATA_DIR`s, hits the real HTTP API.
- Desktop smoke test: `cd desktop && npm test` — boots the actual packaged
  Electron flow and checks the backend comes up and the DB seeds correctly.
- Rebuild before claiming a desktop-side fix works: `cd desktop && npx
  electron-builder --mac --dir --arm64`, then verify the built `.app`'s
  `Resources/app/public/app.js` (or wherever relevant) actually contains the
  change — `files`/`extraResources` copy at build time, so editing source
  alone doesn't update an already-built `.app`. `npx electron-builder --win
  --dir` (equivalent Windows check) also runs fine from macOS — no Windows
  machine needed to verify the *build* succeeds and
  `dist/win-unpacked/resources/app/` has the right files, though actually
  *launching* `My Finances.exe` obviously still needs a real Windows machine
  or the `windows-latest` CI runner (`npm test` in `desktop/` via the release
  workflow).
- **`test/server.test.js`'s cleanup (`kill('SIGTERM')` immediately followed by
  `fs.rmSync(dataDir, ...)`) fails with `EBUSY: resource busy or locked,
  unlink ... smeta.db` on Windows, even though it always passed on macOS/Linux
  CI.** Found on the very first `windows-latest` CI run (2026-08-12,
  `v1.0.9`'s first attempt — this is the *root backend* test, unrelated to
  Electron packaging, so it also would have broken `npm test` for the plain
  web version on Windows). Root cause: POSIX lets you `unlink` a file that
  still has an open handle (the inode just survives until the last fd
  closes); Windows/NTFS does not — a `node:sqlite` handle held by the
  just-killed child process can still be locking the file for a few ms after
  `kill()` returns (killing is not synchronous, and even after the process
  is fully gone the OS can take a moment to release the handle). Fix:
  `removeDataDir()` helper wraps `fs.rmSync` with `maxRetries: 10,
  retryDelay: 100` — the standard Node-documented way to retry through
  exactly this class of transient Windows `EBUSY`/`EPERM` — used at all 4
  cleanup call sites in the file. `desktop/test/launch.test.js` already
  awaited the child's `'exit'` event before its own `rmSync` (more correct
  than the root test's fire-and-forget `kill()`), but got the same
  `maxRetries`/`retryDelay` added anyway as a cheap safety net against the
  same "OS hasn't fully released the handle yet" race.
- **`desktop/test/launch.test.js` asserted the app exits with code `0` after
  `child.kill('SIGTERM')` — true on macOS/Linux, but always `null` on
  Windows.** Found right after the EBUSY fix above, same first
  `windows-latest` CI run. Windows has no real POSIX signal delivery:
  `child.kill('SIGTERM')` there is emulated via `TerminateProcess`, a hard
  kill with no graceful-shutdown path, so Node always reports `exitCode:
  null` (never `0`) regardless of what the app itself would have done given
  an actual chance to shut down. macOS/Linux get `0` because Electron
  installs its own SIGTERM handler that runs a real `app.quit()` before
  exiting. Fix: `assert.equal(exitCode, process.platform === 'win32' ? null
  : 0)` — the test still verifies the process actually stops (doesn't hang),
  just with the platform-correct expected value instead of assuming POSIX
  semantics everywhere.
- **Turning OFF app-lock (Settings toggle) silently did nothing on Windows —
  found via a real user report on v1.0.10, not caught by any test.**
  `public/app.js`'s disable-flow (`initAppLockSetting`, search "выключить
  защиту паролем") does `await window.desktopApp.authenticate(...)` first and
  only falls back to a password prompt if that resolves `{ok:false}`. But
  `auth.js`'s `promptTouchID()` called `systemPreferences.promptTouchID`
  unconditionally, with no availability guard — that Electron API is
  macOS-only and doesn't exist on Windows at all, so the call threw
  synchronously (`TypeError`), `ipcMain.handle` turned that into a **rejected**
  IPC promise (not a resolved `{ok:false}`), and the `await` in the
  un-try/catch'd renderer event handler died right there — never reaching the
  password-prompt fallback or the `setAppLockEnabled()` call, with no error
  toast either (the whole async function just aborted). From the user's side:
  the checkbox visually unchecks (native DOM state) but the underlying config
  never changes, so the lock screen keeps appearing on every launch, and
  there's zero on-screen indication of *why*. Fix: `promptTouchID()` now
  checks `canUseTouchID()` first (same guard `canUseTouchID()` itself already
  had) and resolves `{ok:false, method:'touchid', error:'Touch ID недоступен'}`
  immediately on platforms without it, instead of assuming the API exists —
  lets `app.js`'s existing password-prompt fallback run as designed. Good
  reminder that `canUseTouchID()` being guarded doesn't mean every caller of
  the *other* Touch ID function is safe — check each cross-platform Electron
  API individually, not just the "is it available" probe.

## Building & releasing

README.md is end-user-only now (see "README is for users, not developers"
below) — this is where the developer-facing build/release info actually lives.

**Tech stack**: Node.js, Express, `node:sqlite` (built into Node ≥22, no
native compilation), vanilla HTML/CSS/JS, Chart.js (bundled locally), ExcelJS
for `.xlsx` import/export. No frontend framework, no build step.

**Dev commands**:
```bash
# web (repo root)
npm install && npm start        # http://localhost:3000

# desktop
cd desktop
npm install
npm start                       # Electron dev mode over ../server.js directly
npm test                        # backend integration tests + real .app launch
npm run dist:dir                # unsigned dev build (mac) → desktop/dist/mac*/My Finances.app
npm run dist                    # full mac build (dmg+zip, arm64+x64); signs/notarizes if Apple env vars are set
npm run dist:win:dir            # unsigned dev build (Windows) → desktop/dist/win-unpacked/My Finances.exe
npm run dist:win                # full Windows build (nsis installer, x64), unsigned (no cert configured)
```

`electron-builder --win` **works fine run locally on macOS** — no Windows
machine or VM needed for a dev build. electron-builder bundles its own
`winCodeSign`/Wine binaries (downloaded on first use, cached under
`~/Library/Caches/electron-builder`) and ships a portable `.ico` generator
(`getOrConvertIcon('ico')` in `app-builder-lib`), so `build/icon.ico` doesn't
need to exist — it auto-converts `build/icon.png` (the same 1024×1024 source
already used for the mac `.icns`) into `dist/.icon-ico/icon.ico` and embeds
it in the `.exe` as a binary resource. Confirmed 2026-08-12: a `--win --dir`
build from this Mac produced a working `dist/win-unpacked/` tree with
`resources/app/node_modules` containing zero `.node` native binaries
(express/exceljs/multer are pure JS — the same reason `node:sqlite` over
`better-sqlite3` was chosen, see top of this file), so nothing in the shared
backend needs a Windows-specific rebuild.

**Release pipeline** — two independent workflows, both triggered by the same
`desktop-v*` tag (or manual `workflow_dispatch`) and publishing into the
*same* GitHub Release (electron-builder looks up the release by tag, so
each platform's job just adds its own assets):

- `.github/workflows/release-macos.yml`: `macos-latest` →
  `electron-builder --mac --arm64 --x64 --publish always`. Builds both
  architectures as separate artifacts (no universal binary — smaller
  download per arch), publishes `.dmg`/`.zip`. `artifactName:
  'My-Finances-mac-${arch}.${ext}'` (no version in the filename) keeps
  `/releases/latest/download/My-Finances-mac-arm64.dmg` valid across every
  future release without edits.
- `.github/workflows/release-windows.yml`: `windows-latest` →
  `electron-builder --win --x64 --publish always`. Single x64 target (no
  arm64 Windows build — not worth the added CI/QA surface for how rare
  Windows-on-ARM still is). No code-signing secrets at all (see below) —
  unlike mac there's no self-signed-cert dance needed here since
  electron-updater's Windows/NSIS path doesn't do Squirrel.Mac-style
  designated-requirement signature pinning, so an unsigned build updates
  itself over unsigned builds without issue. `artifactName:
  'My-Finances-windows-${arch}.${ext}'` (same no-version-in-filename
  reasoning) keeps `/releases/latest/download/My-Finances-windows-x64.exe`
  stable.

**Gotchas fixed the hard way on the actual first release run** (`v1.0.0`,
2026-08-12 — all four bit in sequence, one per retry):
- The repo root **is** `smeta-web` (no nested `smeta-web/` folder) — the
  workflow originally had `working-directory: smeta-web` everywhere, which
  fails checkout-relative paths immediately (`npm ci`: "No such file or
  directory"). Paths in the workflow are relative to the repo root directly
  (`desktop`, not `smeta-web/desktop`).
- `${{ secrets.X }}` for a secret that doesn't exist in the repo evaluates to
  an **empty string**, not "unset" — electron-builder treats a non-null
  `CSC_LINK=""` as a real (if garbage) cert path, resolves it to `cwd`, and
  fails ("not a file"). `CSC_IDENTITY_AUTO_DISCOVERY: false` does **not** fix
  this (that only disables local-keychain auto-discovery, unrelated). The fix:
  stage secrets under different env var names (`SECRET_CSC_LINK` etc.) and
  only `export CSC_LINK=...` under the real name inside the `run:` script
  when the staged value is non-empty — so the variable plain doesn't exist at
  all when there's no secret, rather than existing-but-empty.
- The default `GITHUB_TOKEN` only has `contents: read` — publishing a release
  needs `permissions: contents: write` set explicitly (workflow- or job-level).
  Without it: `403 Resource not accessible by integration`.
- electron-builder's GitHub publisher creates the release as a **draft** by
  default — invisible on `/releases/latest` (and to non-collaborators) until
  manually published. Fixed going forward via `publish.releaseType: release`
  in `electron-builder.yml`; the very first release needed one manual
  `gh release edit v1.0.0 --draft=false`.

**Do NOT create a tag matching `desktop-v*`** unless you actually intend to
trigger a real signed/published release — that pattern is the CI trigger.
Use a different prefix (e.g. `backup-YYYY-MM-DD`) for plain safety/checkpoint
tags.

**Apple signing/notarization** — GitHub Secrets read by the release workflow:

| Secret | What |
|---|---|
| `MAC_CSC_LINK` | code-signing cert, `.p12`, base64-encoded (see below — currently self-signed, not from Apple) |
| `MAC_CSC_KEY_PASSWORD` | password for that `.p12` |
| `APPLE_ID` | the Apple ID enrolled in Apple Developer Program (notarization only, not currently set) |
| `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password (appleid.apple.com) for notarytool (not currently set) |
| `APPLE_TEAM_ID` | 10-char Team ID from developer.apple.com/account (not currently set) |

A real Developer ID cert (Apple Developer Program, $99/yr) is the only way
to get the app notarized and to skip the Gatekeeper bypass dance entirely —
that's still not set up (declined, cost), so first-run still needs the
Gatekeeper bypass instructions in README's "Приложение для Mac" section, and
`APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` stay unset (unused
by `notarize.js` without them, notarization silently skipped).

**`MAC_CSC_LINK`/`MAC_CSC_KEY_PASSWORD` are a self-signed certificate, not
from Apple** — set up 2026-08-12 (`v1.0.5`) specifically to fix in-app
auto-update (see below); it does **not** help with Gatekeeper/notarization
(self-signed certs get no more trust from Gatekeeper than no signature at
all). The private key lives at `~/.my-finances-codesign/` on this machine
(`cert.p12` + `p12-password.txt`) — **outside the repo, never commit it**;
back it up somewhere durable, since losing it means every future build gets
a new certificate and existing installs need one more manual reinstall to
get back on the update train (same situation as right now, just once more).
Regenerate with:
```bash
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 3650 -nodes \
  -subj "/CN=My Finances Self-Signed Code Signing/O=alpakafish (self-signed, not Apple-issued)" \
  -addext "extendedKeyUsage=codeSigning" -addext "keyUsage=digitalSignature" \
  -addext "basicConstraints=critical,CA:false"
openssl pkcs12 -export -out cert.p12 -inkey key.pem -in cert.pem -legacy -password "pass:<password>"
```
(`-legacy` matters — macOS's `security import` expects the older RC2/3DES
PKCS12 format; modern OpenSSL 3.x defaults to AES-256, which it can't read.)

**electron-builder can't use the self-signed cert itself — it has to be
signed manually, bypassing electron-builder's own identity lookup
entirely.** First attempt (`v1.0.5`'s first, broken release run) exported
the secret as `CSC_LINK`/`CSC_KEY_PASSWORD`, same as a real Apple cert
would be — electron-builder resolves identities via `security find-identity
-p codesigning`, which filters to identities the *system trusts*, and a
self-signed cert never passes that (`CSSMERR_TP_NOT_TRUSTED`), so
electron-builder silently fell back to "skipped macOS application code
signing" and shipped a completely unsigned build — no error, no warning
that mattered, just quietly wrong. (`codesign --sign <hash>` on the exact
same certificate works fine *directly* — the trust check is specific to how
electron-builder/`security find-identity` locate identities by name, not a
real signing restriction.) Fixed by never handing the cert to
electron-builder at all: the workflow exports it as `SELFSIGNED_CSC_LINK`/
`SELFSIGNED_CSC_KEY_PASSWORD` instead (names electron-builder doesn't look
at), and `desktop/scripts/notarize.js`'s `afterSign` hook does the signing
itself — imports the `.p12` into a throwaway keychain and signs by the
certificate's SHA-1 fingerprint (computed straight from the cert via
`openssl x509 -noout -fingerprint -sha1`, independent of any keychain trust
state), rather than asking `security`/electron-builder to "find" it.

One more gotcha inside that fix: `codesign --keychain <path> --sign <hash>`
does **not** reliably restrict identity lookup to that keychain — it failed
with "no identity found" even right after importing. `codesign` actually
resolves identities via the keychain *search list* (`security
list-keychains`), not the `--keychain` flag. Fix: temporarily add the
throwaway keychain to the user's search list (keeping the existing ones),
sign, then restore the original list in a `finally` block.

Ad-hoc signing (no cert configured at all — `signAdHoc()` in
`notarize.js`) is kept as a fallback for local dev builds with no
`SELFSIGNED_CSC_LINK` set. It solves a related but different problem, found
and fixed earlier (2026-08-12, `v1.0.1`): without *any* signing at all,
electron-builder skips signing entirely and leaves Electron's prebuilt
binaries' own partial signature in place — which doesn't cover the
resources electron-builder just assembled (icon, `extraResources`, edited
`Info.plist`). `codesign --verify --deep --strict` on a build like that
fails ("code has no resources but signature indicates they must be
present"), and a real user's download (which sets `com.apple.quarantine`
and triggers Gatekeeper's full assessment) gets the **non-bypassable** "My
Finances.app is damaged and can't be opened, move to Trash" dialog instead
of the expected bypassable "unidentified developer" one. A local
unquarantined `--dir` build never hits that full assessment, so this was
invisible in dev for a while. The ad-hoc fallback re-signs the fully
assembled bundle fresh (`codesign --deep --force --sign -`) so the
signature/resource seal is consistent with the final contents.

**Hardened runtime + any identity with no real Team ID (ad-hoc *or*
self-signed) breaks the app at launch** — hit twice, same root cause both
times (2026-08-12, `v1.0.1` then again setting up the self-signed cert for
`v1.0.5`). Hardened runtime's library validation requires every loaded
framework/helper to share the main executable's Team ID — a field that only
exists on Apple-issued Developer ID certs. Ad-hoc signing has no Team ID at
all; a self-signed cert (see above) also has none (`TeamIdentifier=not set`
either way, even though `Authority=` correctly shows our cert). Either way,
dyld refuses to load nested binaries at launch (`Library not loaded: ...
different Team IDs`) — the app opens to nothing (one bare process, no
window, no log line), Gatekeeper never even gets involved. Neither signing
path in `notarize.js` passes `--options runtime` (hardened runtime isn't
needed without real notarization anyway), and
`com.apple.security.cs.disable-library-validation` is set in
`build/entitlements.mac.plist` as a second layer of protection — a
standard, widely-used Electron entitlement for exactly this case, harmless
if a real Apple Developer ID cert is ever added later.

Verifying this class of bug requires an actual quarantined copy, not just a
local build: `cp -R dist/mac-arm64/*.app /tmp/x/ && xattr -w
com.apple.quarantine "0081;00000000;Google Chrome;" /tmp/x/*.app`, then
`codesign --verify --deep --strict` (must exit 0) and an actual `open` (must
spawn the full set of Electron helper processes and a real window, not just
one lingering main-binary process under `AppTranslocation`).

**In-app auto-update (Squirrel.Mac) needs a *stable* signing identity across
builds — found 2026-08-12, `v1.0.2`→`v1.0.3`, fixed in `v1.0.5` with the
self-signed cert above.** This is a separate mechanism from the
Gatekeeper/DMG-open issues above: `electron-updater`'s macOS path hands the
downloaded update to the OS's built-in Squirrel.Mac framework, which
independently verifies the new bundle's code signature against the
*running* app's signature ("designated requirement") before letting it
install — this happens automatically right after download completes, not
when the user clicks "restart". With the old ad-hoc-only setup (freshly
generated identity every build, no stable reference at all — `codesign -d
-r-` showed the requirement tied to that exact build's binary hash), this
always failed: `Code signature at URL ... did not pass validation` in
`main.log`, a few seconds after "New version X has been downloaded" — the
"Restart Now" button the UI had already shown (from `update-downloaded`) did
nothing, because the update was already broken before the click.

The fix is **not** "get a real Apple cert" (still not done) — it's "sign
every build with the same identity", which a self-signed certificate
achieves too. Confirmed via `codesign -d -r-` on a cert-signed build: the
generated designated requirement is `identifier "com.alpakafish.myfinances"
and certificate root = H"<sha1 of our cert>"` — a hash of the *certificate*,
not the binary, so it matches across every future build signed with the
same `.p12`, with no dependency on Apple trusting it. Squirrel.Mac's
validation doesn't require the certificate to be trusted by the system
either (confirmed: `security add-trusted-cert` hangs waiting on a GUI
prompt that never appears headlessly/in CI — never needed it; a plain
`security import ... -T /usr/bin/codesign` plus signing by the cert's SHA-1
hash directly was enough). `desktop/src/main.js` still asks before
downloading (`autoUpdater.autoDownload = false`, confirm dialog on
`update-available`), then on confirmation downloads and, once ready, offers
to restart and install (`update-downloaded` → `quitAndInstall()`) — this now
actually works end-to-end.

One caveat worth remembering: this only works between two builds signed
with the *same* identity. An install from before the cert existed (ad-hoc,
e.g. `v1.0.4` and earlier) checking for `v1.0.5` will still fail the same
way, once — those users need one manual DMG reinstall to get onto a
cert-signed version; every update after that should work automatically.

**Both release workflows racing to create the same GitHub Release can make
one of them silently lose its uploaded assets — found on `v1.0.11`
(2026-08-12), the first time both workflows genuinely ran concurrently
end-to-end.** electron-builder's GitHub publisher does a check-then-create
("release doesn't exist for this tag → create it") before uploading; when
`release-macos.yml` and `release-windows.yml` both start from the same
`desktop-v*` tag push, they can both pass that check before either has
created the release, race to `POST /releases`, and the loser gets `422
already_exists` — normally harmless (electron-builder is supposed to treat
that as "fine, release exists, proceed"), but here it triggered an
`⨯ Cannot cleanup:` failure that aborted the mac job **after** its log
showed every `.dmg`/`.zip` as "uploading" — those uploads did not actually
survive; the finished release ended up with only the Windows assets
(`gh release view` showed just `latest.yml`/`.exe`/`.exe.blockmap`, no mac
files at all). Whichever workflow finishes its own "create or find release"
step first appears to win; the loser's uploads get caught up in electron-
builder's own conflict-cleanup logic and dropped rather than retried. No fix
shipped for the race itself (it's inside electron-builder, not our config) —
mitigation: if either `release-*.yml` job fails after the tag push, re-run
*that platform's* workflow alone via `gh workflow run release-<platform>.yml
--ref main` once the tag's release already exists (confirm with `gh release
view v<version>` first) — with the release no longer racing to be created,
the retry just attaches that platform's assets cleanly. Always verify with
`gh release view v<version>` that **both** platforms' assets actually landed
after a `desktop-v*` tag push — a green workflow run is necessary but a
failed one doesn't always mean *zero* assets uploaded, so check the asset
list, not just job status.

**Windows signing — deliberately not set up (2026-08-12), same call as
Apple notarization above (real cost, declined).** No `WIN_CSC_LINK` secret,
no `certificateFile`/`certificateSubjectName` in `electron-builder.yml`'s
`win:` block — `electron-builder --win` builds and
`release-windows.yml` publishes a fully unsigned NSIS installer
(`no signing info identified, signing is skipped` in the build log, harmless).
User-facing consequence: first run shows Windows SmartScreen's "Windows
protected your PC" (More info → Run anyway to bypass) — documented in
README's "Приложение для Windows" section, same shape as the mac Gatekeeper
bypass dance. Unlike mac, this does **not** block in-app auto-update:
electron-updater's Windows/NSIS path re-runs the downloaded installer
directly rather than asking the OS to verify a designated-requirement
signature match against the running binary (that's a macOS/Squirrel.Mac-only
mechanism, see above) — so update-over-unsigned-build should work without
the self-signed-cert workaround the mac path needed. Not yet verified
end-to-end with a real two-version update cycle (no released Windows build
exists yet to update *from*) — worth confirming once `v1.x` Windows releases
exist on both sides of an update.

## README is for users, not developers

README.md should only ever contain what a non-technical person downloading
or running the app needs: what it does, screenshots, how to get it running
(web or Mac app), and the security/privacy explanation. Anything about
building, testing, CI, signing secrets, or the tech stack belongs here in
CLAUDE.md instead — if you add a dev-facing README section, move it here
instead the next time you touch README.

## Git

`main` is the live branch (web at repo root + `desktop/`, merged from
`desktop-macos` on 2026-08-12). `backup-YYYY-MM-DD` tags are periodic
safety checkpoints — never named `desktop-v*` (see release pipeline note
above, that prefix triggers a real release). The original pre-desktop
snapshot (`legacy-web`/`legacy-web-v1`) was deleted once desktop work was
verified — its commit is still reachable as an ancestor of `main`
(`6ceee2a`, "Убрать better-sqlite3 полностью..."), so nothing was lost by
removing the named refs.
