# Testing

Developer-facing notes on what's tested, how to run it, and — the part worth
actually reading before touching test files — a log of which bug or feature
each non-obvious test guards against. See `CLAUDE.md` for broader repo
conventions and gotchas; this file is specifically about test coverage.

## Test suites

| Command | What it does |
|---|---|
| `npm test` (repo root) | Backend integration tests (`test/*.test.js`) — spawns real `server.js` processes against temp `DATA_DIR`s, hits the real HTTP API. Covers everything in `routes/*.js`, `db.js`, and `backup.js`. |
| `cd desktop && npm test` | `test/launch.test.js` — boots the actual Electron app (dev mode, unpackaged) and checks the backend comes up and the DB seeds correctly. `test/extra-resources.test.js` — static check, no Electron involved (see below). |

Neither suite touches your real data — both always set `DATA_DIR` to a fresh
temp directory per run (see `CLAUDE.md` "Testing" for why that matters).

**Known gap:** there is no frontend test harness (no jsdom/Playwright) —
`public/app.js`/`index.html` changes are verified manually (browser preview)
rather than by an automated test. UI-only fixes (e.g. disabling a button
during an in-flight request) rely on that manual check, not a checked-in
test. Worth adding a frontend harness if UI-only regressions start recurring.
The transactions-list search (by note/amount, see below) is the biggest
example so far — it's pure client-side filtering in `public/app.js`, so only
its backend half (`category_id` query param) has an automated test; the
search itself was verified manually (typed into a running preview, checked
results/title/disabled month select) and would silently regress if someone
changed the filter logic without also checking by hand.

**Also known:** `desktop/test/launch.test.js` runs Electron against the
*source* `desktop/` directory (`app.isPackaged` is `false`), not a packaged
build — the module-resolution differences between dev mode and a real
`Resources/app/` bundle (see the `extra-resources.test.js` entry below) are
invisible to it. A real `--dir` build is still the only way to catch
*everything* that differs between the two (see `CLAUDE.md` "Rebuild before
claiming a desktop-side fix works").

## Regression log

Every row here is a test that exists **because a specific bug was found** —
not general feature coverage. If you're touching the code a row points at,
read the row first; it's usually shorter than re-deriving why the assertion
is there.

| Found | Bug | Guarded by | Note |
|---|---|---|---|
| 2026-08-12 | Packaged desktop app crash-loops on startup (`Cannot find module '../package.json'`) — a shared route required a repo-root file not copied into the packaged bundle. | *(no automated test at the time — found via manual `/api/settings/version` check post-build)* | See `CLAUDE.md` "Desktop-specific gotchas". First occurrence of the `extraResources`-completeness class of bug. |
| 2026-08-14 | Same root cause, second occurrence: `backup.js` (new root-level file) required by `server.js`, missing from `extraResources` — same crash-loop. | `desktop/test/extra-resources.test.js` | Static check (no Electron build needed): every `require('./name')` in `server.js` that resolves to a root-level sibling file must have a matching `extraResources` entry. Verified it actually fails when the entry is removed, not just that it passes today. |
| 2026-08-14 | `yearly-totals` derived its year list from the *already-filtered* (`excluded_from_total = 0`) query — a year containing only a «нал.»-flagged transaction disappeared from the table entirely instead of showing a 0/0/0 row. | `test/server.test.js` → `"нал." (excluded_from_total): ...` | |
| 2026-08-14 | Goal `monthsBetween()` used `days ÷ 30.44` (average month length) — overestimated by a month whenever the actual months spanned were longer than average (e.g. Aug→Jan: three 31-day months). Found via CI failing on the release build, not locally (date-dependent, not flaky). | `test/server.test.js` → `goal creation and contribution` (`assert.equal(goal.monthlyNeeded, 5000 / 5)`) | Fixed by switching to real calendar-month arithmetic in `routes/goals.js`. The original day-of-month-mismatch bug this replaced (commit `219d1b0`) has no dedicated test — verified only via a one-off script during that fix. |
| 2026-08-14 | Category rename to a whitespace-only name silently blanked it (`PUT` didn't validate; `POST` did). | `test/server.test.js` → `category validation: whitespace-only rename rejected...` | |
| 2026-08-14 | Category delete-with-reassign didn't validate the target category existed or matched type — could silently reassign expenses onto an income category. | `test/server.test.js` → same test as above | UI already only offers same-type targets, so this is defense-in-depth for the API itself. |
| 2026-08-14 | Goal `duration_months`/`target_amount` accepted invalid values (0, negative, fractional months) on both create and edit, breaking the deadline math downstream. | `test/server.test.js` → `goal validation: duration_months must be a positive integer...` | |
| 2026-08-14 | Dashboard tab didn't refetch its data on switching to it — only the "По годам"/"Лимиты" tabs reloaded on click. Data changed outside the currently-loaded Dashboard view (e.g. a direct API call, or in principle a second window/tab against the same `DATA_DIR`) stayed invisible until a full page reload. Found via user report: an overall-budget notification (always computed fresh server-side) showed a higher "потрачено" than the Dashboard's own "Расход" headline for the same month, because the Dashboard hadn't refetched since data was added via `curl` during manual testing. | *(no automated test — frontend-only, see "Known gap" above)* | Fixed by adding `if (btn.dataset.tab === 'dashboard') refreshDashboard();` to the tab-click handler in `public/app.js`, matching the existing reload-on-click pattern already used by `years`/`limits`. Verified manually in browser preview: added a transaction via a direct `POST /api/transactions` call while Dashboard was already loaded and showing the old total, switched to another tab and back without reloading the page, confirmed new `/api/summary`/`/api/limits/*` requests fired and the displayed totals updated. |
| 2026-08-14 | **Stored XSS**: `public/app.js` inserted user-controlled text (transaction `note`, category/goal `name`, category `color`) into `innerHTML` — as text content in some places, inside HTML attributes (`value="..."`, `style="..."`) in others — with no escaping anywhere, in ~35 call sites. Confirmed live (not just theoretical): a transaction note of `<img src=x onerror=alert(1)>` actually executed on render. Reachable via the app itself, a direct API call, or a tampered imported `.xlsx` file. | *(no automated test — no frontend/XSS test harness, see "Known gap" above)* | Fixed with a single `escapeHtml()` helper (top of `public/app.js`) applied at every site that interpolates user/API-controlled text or attribute values into `innerHTML` — notes, category/goal names, category colors, and (see next row) transaction dates. Verified manually: injected `<img src=x onerror=alert(1)>` via `curl`, confirmed it renders as literal text and `alert` never fires (checked by stubbing `window.alert` before reload); confirmed a name containing `"`/`<`/`>`/`&` round-trips correctly through an `<input value="...">` attribute without breaking out. |
| 2026-08-14 | Transaction `date` was only checked for truthiness on create/edit, never format — any string was accepted and stored as-is, which is what let a non-date string reach the (now-fixed) unescaped render path above. Same gap for `PUT` (only when `date` is actually supplied). | `test/server.test.js` → `transaction date validation: malformed/missing date rejected...` | Fixed with a shared `isValidDate()` regex check (`routes/transactions.js`) requiring `YYYY-MM-DD`. |
| 2026-08-14 | `GET /api/export`'s handler is `async` with no try/catch — Express 4 does not catch a rejected promise from an async route handler (only synchronous throws), and Node 15+ terminates the whole process by default on an unhandled rejection. Any failure inside (a `buildWorkbook()` error, or the response stream erroring if the client cancels the download mid-write) would crash the entire backend, not just fail that one request. Confirmed the general mechanism with a standalone repro (bare Express app, `async` handler that throws → process exits immediately, code 1) — found via a full-project review, not a user report. | *(no automated test — realistic trigger (e.g. a client aborting the download mid-stream) didn't reliably reproduce the failure through the HTTP integration harness; the fix itself removes the crash path structurally)* | Wrapped the handler body in try/catch, matching the pattern `routes/import.js`'s async handler already used. Also added a process-wide `unhandledRejection` logger in `server.js` as a safety net for any future async route handler that misses the same pattern — not a substitute for the per-route try/catch. |
| 2026-08-14 | Deleting a category that another category rolls up into (`rollup_id`) — e.g. deleting "Сбережения" while a goal's own dedicated category still points at it — threw an uncaught `SQLITE_CONSTRAINT` (FK, `foreign_keys=ON`, no `ON DELETE`), surfacing as a bare "Внутренняя ошибка сервера" (500) instead of an actionable message. Reachable from the UI (Категории tab), not just a crafted API call. | `test/server.test.js` → `category deletion: a category that another category rolls up into...` | Fixed with an explicit check in `routes/categories.js` `DELETE /:id`, same shape as the existing "category is tied to a goal" check right above it. |
| 2026-08-14 | Goals `DELETE /:id` didn't check the goal existed first — inconsistent with every other DELETE route in the codebase (always returned 204, even for an already-deleted/never-existed id). | `test/server.test.js` → `goal creation and contribution` (repeat-delete assertion) | Minor; fixed for consistency, not a user-facing symptom. |
| 2026-08-14 | Desktop: after the backend crashed and successfully self-restarted (`desktop/src/backend.js`'s existing retry logic), the already-open window kept pointing at the old port — `PORT=0` gives every fork a new random port, and nothing anywhere called `loadURL()` again after the initial launch. Not even the menu's manual "Reload" helped (it re-fetches the same, now-dead, URL). Separately: if the crash happened on the very first launch attempt (before ever reaching `'server-ready'`) and repeated past `MAX_RESTARTS`, the original `backend.start()` promise that `launch()` awaits never resolved *or* rejected — `launch()`'s catch block (which calls `app.quit()`) never ran, leaving a windowless zombie process behind the `onCrash` error dialog. | *(no automated test — needs a real Electron crash/restart scenario, out of reach of the existing launch-smoke-test harness; see "Known gap" above, plus CLAUDE.md's broader note on what `desktop/test/launch.test.js` can and can't catch)* | `Backend._spawn()` now reuses the *same* `resolve`/`reject` across every retry (previously each retry called `this.start()` fresh, orphaning the original promise) — so an exhausted-retries crash before the first successful start now correctly rejects, and a crash well after a successful start is a harmless no-op resolve. Added `backend.onRestart(newPort)`, wired in `main.js` to `mainWindow.loadURL()` on the new port. Had to also change the window's `will-navigate` external-link guard to check the *live* `backend.port` instead of the port captured at window-creation time — otherwise the reconnect's own `loadURL()` call would have tripped that same guard and bounced out to the system browser instead of reloading. |
| 2026-08-16 | Card reconciliation (`routes/reconciliation.js`, added 2026-08-15 with no tests): `GET /:month` for a month *before* the anchor's month built an inverted date range (`date >= anchor_date AND date < конец_запрошенного_месяца`, with the upper bound earlier than the lower one) — silently matched 0 rows instead of erroring, so the Dashboard card showed `since_net: 0` and `expected: anchor_amount`, implying nothing happened since the anchor when the real issue was that the question doesn't apply to that period at all. Separately, `db.resetAllData` didn't clear the anchor — same bug class already fixed once for `overall_monthly_budget`, and explicitly called out as a checklist item in `CLAUDE.md` after that fix, missed anyway because the new feature shipped without consulting it. Found via a full-project review, reproduced live both ways before fixing. | `test/server.test.js` → `card reconciliation: unset by default, month-before-anchor hides the card...` | Fixed by hiding the card (`{ set: false }`, same response shape as "no anchor at all") for any month lexicographically before the anchor's month (`YYYY-MM` string comparison is chronological), and adding `reconciliation_anchor_date`/`reconciliation_anchor_amount` to the same `DELETE FROM app_settings WHERE key IN (...)` as `overall_monthly_budget` in `resetAllData`. Also updated `TOUR_STEPS`' Settings step to mention the feature — it shipped without a tour update too, violating `CLAUDE.md`'s explicit "update TOUR_STEPS in the same change" rule. |

## What's covered but not bug-driven

The rest of `test/server.test.js` is straightforward feature coverage, added
alongside each feature rather than after a bug: transaction CRUD, category
delete-in-use (reassign/delete-transactions), monthly summary, goal
create+contribute, Excel export/import round-trip (multi-device
backup/restore scenario), `delete-all-data`, onboarding-seen persistence
across a port change (the desktop restart scenario), category spending
limits (progress/notifications/dismissal/rollup-exclusion), currency
setting, recurring transactions (suggestion/confirm/skip, the
one-active-template-per-category+type invariant), automatic backups
(creation on startup, retention pruning, failure/dismiss notification), and
the transactions-list `category_id` filter (combines with `type` via AND;
the note/amount search and the "search drops the month filter" behavior are
frontend-only, see the "known gap" above), the overall monthly budget
(validation, progress correctly excludes «нал.» and is unaffected by
rollup, notification/dismiss, value reset by `delete-all-data`), and the
deleted-transactions trash (`deleted_transactions` table: keeps only the
last 10 with the oldest trimmed, restore round-trips into `transactions`,
restoring a stale/already-restored id 404s instead of 500ing, restoring into
a category deleted after the fact 409s, wiped by `delete-all-data`). The
frontend half of the trash — the Cmd/Ctrl+Z shortcut now always retrying
against whatever is currently in the trash (instead of the old
single-slot "invalidated by any other action" undo), the toast's
"Отменить"/"Открыть бэкапы" action button, and the «Корзина» card's
restore buttons — is manual-only, same known gap as above.
