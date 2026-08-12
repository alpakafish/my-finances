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
  alone doesn't update an already-built `.app`.

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
npm run dist:dir                # unsigned dev build → desktop/dist/mac*/My Finances.app
npm run dist                    # full build (dmg+zip, arm64+x64); signs/notarizes if Apple env vars are set
```

**Release pipeline** (`.github/workflows/release-macos.yml`): triggers on
push of a `desktop-v*` tag, or manual `workflow_dispatch`. Runs on
`macos-latest`: `npm ci` + `npm test` (root, shared backend) → `npm ci` +
`npm test` (desktop) → `electron-builder --mac --arm64 --x64 --publish
always`. Builds both architectures as separate artifacts (no universal
binary — smaller download per arch), publishes `.dmg`/`.zip` to GitHub
Releases. `desktop/electron-builder.yml` sets `artifactName:
'My-Finances-mac-${arch}.${ext}'` (no version in the filename) specifically
so the `/releases/latest/download/My-Finances-mac-arm64.dmg` links in
README stay valid across every future release without edits.

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

**Apple signing/notarization** — GitHub Secrets required for the release
workflow to produce a signed build (without them it still succeeds, just
publishes unsigned):

| Secret | What |
|---|---|
| `MAC_CSC_LINK` | Developer ID Application cert, `.p12`, base64-encoded |
| `MAC_CSC_KEY_PASSWORD` | password for that `.p12` |
| `APPLE_ID` | the Apple ID enrolled in Apple Developer Program |
| `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password (appleid.apple.com) for notarytool |
| `APPLE_TEAM_ID` | 10-char Team ID from developer.apple.com/account |

Apple Developer Program is a paid ($99/yr) prerequisite for a Developer ID
cert — there's no free way to get a notarizable cert. As of this writing, no
certs are configured, so releases are unsigned; users need the Gatekeeper
bypass instructions that live in README's "Приложение для Mac" section.

**Unsigned build must still be ad-hoc re-signed, or downloads show "damaged"
(not bypassable)** — found and fixed 2026-08-12 (`v1.0.1`). Without a real
cert, electron-builder just skips signing entirely ("cannot find valid
identity"), leaving Electron's prebuilt binaries' own partial signature in
place — which doesn't cover the resources electron-builder just assembled
(icon, `extraResources`, edited `Info.plist`). `codesign --verify --deep
--strict` on a build like that fails ("code has no resources but signature
indicates they must be present"). A real user's download (which sets
`com.apple.quarantine` and triggers Gatekeeper's full assessment) then gets
the **non-bypassable** "My Finances.app is damaged and can't be opened, move
to Trash" dialog — not the expected/documented bypassable "unidentified
developer" one. A local unquarantined `--dir` build never hits that full
assessment, so this was invisible in dev the whole time this project
existed. Fixed in `desktop/scripts/notarize.js`'s `afterSign` hook: when
`CSC_LINK` isn't set, run `codesign --deep --force --sign - --entitlements
build/entitlements.mac.plist` on the fully assembled `.app` ourselves, so the
signature/resource seal is freshly consistent.

Second gotcha hit immediately after the first fix: do **not** pass
`--options runtime` (hardened runtime) on that ad-hoc resign. Hardened
runtime enforces library validation (loaded frameworks must share the main
executable's Team ID), but a `--deep` ad-hoc sign gives every nested
framework/helper `.app` its own independent ad-hoc identity with no team at
all — dyld then refuses to load them at launch (`Library not loaded: ...
different Team IDs`), so the app opens to nothing (one bare process, no
window, no log line) even after Gatekeeper is satisfied. Hardened runtime
only matters for notarization (which needs a real cert anyway), so it's
skipped entirely on the unsigned/ad-hoc path — see the comment in
`notarize.js` for the full explanation.

Verifying this class of bug requires an actual quarantined copy, not just a
local build: `cp -R dist/mac-arm64/*.app /tmp/x/ && xattr -w
com.apple.quarantine "0081;00000000;Google Chrome;" /tmp/x/*.app`, then
`codesign --verify --deep --strict` (must exit 0) and an actual `open` (must
spawn the full set of Electron helper processes and a real window, not just
one lingering main-binary process under `AppTranslocation`).

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
