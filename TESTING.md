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
| 2026-08-19 | Vacation pay (`routes/vacation.js`, shipped the same day): the two surrounding salary/avans payments were always resolved within the *vacation-start month*, regardless of whether that specific payday had already passed by the time отпускные itself gets paid. Found by the user testing the real app: vacation starting Oct 19 → отпускные paid Oct 16 → the "5th" payment was shown as Oct 5, which is *before* Oct 16 and therefore already in the past; the correct next occurrence is Nov 5. | `test/server.test.js` → `vacation pay: each payment is the NEXT occurrence of its payday on or after отпускные is paid...` | Added `nextPaydayOnOrAfter(day, afterDate)` — walks forward month by month from the отпускные payment date (not from vacation-start's month) until it finds an occurrence of that payday number `>= afterDate`. The original worked example (Sept 1–14) still passes unchanged, since both paydays there already happened to fall after отпускные within the same month — the bug only showed up once a payday's same-month occurrence had already passed. |
| 2026-08-19 | Vacation pay UI: the "До вычета налогов" checkbox's tooltip rendered off the left edge of the window, text clipped. Root cause: `.tooltip-wrap:last-child .tooltip-box` right-anchors the tooltip (`right: 0`) — a heuristic for "last child in its container is usually near the right edge of the layout" that assumes DOM position tracks visual position. This tooltip genuinely is the last child of its `.checkbox-field`, but the field itself sits at the *left* edge of the page (the first field in the form) — right-anchoring a 280px box there pushes it far off-screen to the left. Found via a user screenshot. | *(no automated test — layout/CSS, no frontend test harness, see "Known gap" above; verified manually via `getBoundingClientRect()` in a live preview after the fix, confirming the tooltip box's left/right edges both fall within the viewport)* | Added a `.anchor-left` escape hatch (mirrors the existing `.anchor-right` one) that forces `left: 0` back regardless of `:last-child`, applied to this specific tooltip. Worth checking any *future* tooltip that's both DOM-last-child and visually near the left of its container for the same issue. |
| 2026-08-19 | Vacation pay UI, same batch: the "Оклад" field's checkbox sat inside that `.field` column, making it taller than its siblings — `.form-row`'s `align-items: flex-end` then bottom-aligned all columns, visually dropping the "Начало отпуска"/"Конец отпуска"/"Числа выплат" labels out of line with "Оклад". The first fix copied `#txAmountField`'s established pattern (absolute-position the checkbox row out of flow) — worked at the tested width, but the vacation form's natural unwrapped width (~883px, measured via a hidden clone) is *wider than the desktop app's own 860px minimum window width*, so `.form-row`'s `flex-wrap: wrap` triggering there is a normal case, not a rare edge one — and an absolutely-positioned checkbox row doesn't participate in flow, so it overlapped whatever field wrapped onto the next line. Found via a user screenshot (first fix), then reasoned through and caught before shipping (second issue, no separate user report). | *(no automated test — layout/CSS, same known gap)* | Second fix took a different shape than `#txAmountField`'s: rather than reuse the absolute-positioning trick, moved the checkbox out of `.form-row` entirely onto its own line below it — sidesteps the alignment problem and the wrap-overlap problem at once, at the cost of the checkbox sitting slightly less visually "attached" to the Оклад field specifically. `#txAmountField` itself wasn't touched — its own row reliably fits without wrapping in practice, so the trade-off didn't apply there. |
| 2026-08-19 | Vacation pay, found via a full-repo review (not a user report): `calendarFetchRange()`'s fetch window only extended `vacationEnd + 5` days — too narrow now that `nextPaydayOnOrAfter()` (see the row above) can push a payment's date into a later month than vacationStart's, and `periodForPayday()` for that later date can itself need days up to the 15th of the month *after that*. When a needed date fell outside the fetched range, `calendar[date]` was `undefined`, `isWorkingDay()` silently read that as "not a working day" (`undefined !== '0'`), and `rollBackToWorkingDay()` walked backward until it hit an in-range date — producing a plausible-looking but wrong payment date instead of an error. Live-reproduced against the real isdayoff.ru API before fixing: `vacationStart=vacationEnd=2027-01-01`, `payday1=10`, `payday2=20` → both payments incorrectly returned `2027-01-06` (real data confirms Jan 8-11 2027 are all working days, so the correct dates are Jan 10 and Jan 20). | `test/server.test.js` → `vacation pay: calendarFetchRange fetches far enough ahead...` and `vacation pay: end-to-end reproduction of the calendarFetchRange bug...` | Fixed by widening the upper bound from `vacationEnd + 5` days to `vacationEnd + 60` days — a generous margin over the ~45-day worst case derived above. Same review also found a related bug (next row) — both share the root cause of `calendar[date]` silently going `undefined` rather than erroring loudly. |
| 2026-08-19 | Vacation pay, same review: `fetchCalendar()` validated the isdayoff.ru response was a non-empty numeric string, but never checked its *length* matched the requested date range. isdayoff.ru's documented error codes (`100`/`101`/`199`, etc.) are themselves short numeric strings that would pass that check — silently populating only the first few days of the calendar map and leaving the rest `undefined`, the same "reads as not-a-working-day, rolls back to a wrong date" corruption as the row above, except triggered by an API *error response* rather than a too-narrow request range, and not caught by the existing fetch-failure→fallback path since no exception would be thrown. Found by code review, not live-triggered (isdayoff.ru didn't happen to return an error during triage) — the risk is real but unconfirmed against a live error response. | `test/server.test.js` → `vacation pay: parseCalendarResponse rejects a response whose length does not match the requested range...` | Fixed by checking `text.length` against the expected day count (`countDays(from, to, () => true)`) alongside the existing numeric-string check. Refactored the validation+parsing logic out of `fetchCalendar()` into a standalone pure `parseCalendarResponse(text, from, to)` so this could be tested offline instead of needing to mock the network. |

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

Also covered: `auto_confirm` ("не спрашивая") on recurring templates —
carries forward through `confirm` (otherwise it would silently revert to
manual after one month), appears on `GET /suggestions`, clears itself if
`is_recurring` is turned off via `PUT`, and round-trips through the trash
delete/restore cycle same as `is_recurring` already did. The frontend half —
`loadRecurringSuggestions()` auto-firing `confirm` for these instead of
rendering a card, and the toast summarizing what got added — is manual-only,
same known gap. `auto_confirm`'s checkbox itself (both the add-transaction
form and the inline edit row) is visible-but-disabled+dimmed until
"Повтор." is checked, rather than hidden outright — changed 2026-08-19 per
user feedback so the option's existence is discoverable and its tooltip
(explaining what activates it) stays hoverable either way; shared between
both locations via `setAutoConfirmAvailable()` in `public/app.js`. And the
Dashboard category-breakdown `components` field
(`routes/summary.js` `categoryBreakdown()`) — present only on rows where an
actual rollup happened (more than one source category), `null` on plain
categories — backs the click-to-expand drill-down on the Dashboard; the
click/expand interaction itself is manual-only. And `setButtonLoading()` —
swaps a button's label for a spinner and disables it for the duration of a
request, added 2026-08-19 for the vacation calculator's "Рассчитать" (the
one button in the app whose request can visibly take a moment, since it
waits on isdayoff.ru — see `routes/vacation.js`) but written as a general
helper, reusable for any future button fronting a network call.

Also covered: partial export by date range (`GET /api/export?from=&to=`) —
only the requested range round-trips through import, a half-supplied or
malformed range 400s instead of silently falling back to a full export, and
`buildWorkbook()` called with no arguments (the exact call `backup.js`
makes) stays a full export — verified indirectly (the existing full
export/import round-trip test still passes unchanged) rather than by
calling `buildWorkbook()` directly, to keep the test black-box over HTTP
like the rest of this file. Caught by this test before ever shipping: the
first draft of the per-month summary-sheet range filter used a table alias
(`t.date`) in a query that didn't have that alias in scope — a bug that
never reached a real build, since the test failed immediately.

Also covered: sync-aware import via a stable per-transaction `uuid` (new
column, backfilled for pre-existing rows, exported as a hidden last column
in the "Операции" sheet, generated fresh for every new transaction). Import
now matches by `uuid` when present — identical values skip as before,
different values UPDATE the existing row instead of inserting a duplicate,
and a `uuid` present but not found locally inserts a new row that keeps the
same `uuid` (not a fresh one) so future syncs keep recognizing it. Files
without a `uuid` column (exported before this feature, or the legacy
"Траты/Приход" format) fall back to the original exact-value-match dedup
untouched. Deletions are NOT synced by this mechanism — an operation
deleted on one device can be revived by importing an older export from
another; this is a known, accepted limitation of a serverless "sync",
not a bug.

Also covered: vacation pay calculation (`routes/vacation.js`, ТК РФ only).
`calculateVacation()` is a pure function — no network, no db, the only route
in the app with zero persisted state — so three of the four tests run
offline against a hand-built calendar fixture (same `{date: '0'|'1'|'8'}`
shape the real isdayoff.ru response is parsed into), covering: the worked
example from the original design discussion (own by-hand trace missed that
both the 5th *and* the 20th land on a weekend that particular month — the
code caught both, the test pins it down); a public holiday inside the
vacation range excluded from paid days while ordinary weekends are not, and
gross→net at 0.87; a payment period fully consumed by vacation paying ~0,
and payday-of-month clamping into a short month (same clamp
`routes/recurring.js` already uses). The fourth test is deliberately
network-dependent — one real call through the actual HTTP route against the
live isdayoff.ru, to check the route wiring and validation end-to-end; if it
ever flakes, that's the external service being down, not a code regression.
Not covered by an automated test: the `calendarAvailable: false` degraded
path (external service unreachable → falls back to weekends-only via
`fallbackCalendar()`, frontend shows a warning) — verified manually (see
`public/app.js` `renderVacationResult`), same class of gap as other
frontend-only behavior above.
