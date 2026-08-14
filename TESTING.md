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
frontend-only, see the "known gap" above).
