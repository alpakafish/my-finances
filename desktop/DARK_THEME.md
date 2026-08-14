# Dark Theme — Analysis for Desktop Only

Status: **shipped in v1.0.13** (`a671c09`, "Add dark theme (desktop-only) per
DARK_THEME.md plan"). Written 2026-08-13 per user request as the
pre-implementation plan for a dark theme on the desktop app (macOS + Windows)
specifically — the web version (`legacy-web`) stayed light-only, unaffected,
as planned. Kept here as-is (not rewritten post-implementation) as the
reference for the surface inventory and the *why* behind the design
decisions below — check the actual CSS/JS for current implementation
details rather than assuming every line here still matches the shipped code
verbatim.

This doc is the reference for the future implementation pass. It inventories
every UI surface that needs a dark variant, flags the handful of places that
resist a pure-CSS approach (Chart.js, inline SVG, baked data-URI icons,
inline `style=`), and recommends a technical mechanism before any CSS is
written.

## Scope

- **Desktop only** (`desktop/`, loading the shared `public/`) — the identical
  static frontend is also served to plain-browser users at `localhost:3000`
  (`legacy-web`/web install path, see CLAUDE.md "Project shape"), who must
  keep seeing today's light theme unchanged, unconditionally.
- **Both platforms** — macOS and Windows share the exact same renderer code
  (`public/*`), so one CSS implementation covers both; only native-chrome
  pieces (window title bar, OS menu, OS dialogs) differ per platform and need
  separate handling (see "Native chrome" below).
- **Both themes must stay readable** — this is not "add dark and leave light
  alone": several fixes below (Chart.js colors, baked-in SVG colors, inline
  styles bypassing the cascade) are cross-cutting refactors that touch how
  light mode is implemented today too, even though light mode's *appearance*
  shouldn't change. Call these out explicitly during implementation so a
  reviewer doesn't mistake "necessary refactor" for "accidental light-mode
  regression."

## Reference inspiration — principles, not literal colors

Neither Telegram Desktop nor JetBrains IDEs are literally this app's genre
(chat client / code editor vs. a small finance-tracker CRUD app), so the
useful takeaway is the *conventions*, not their exact hex values:

- **Explicit in-app theme picker, not just OS auto-detection.** Both
  Telegram (Settings → Chat Settings → theme presets) and JetBrains
  (Settings → Appearance → Theme, with an explicit "Sync with OS" option)
  let the user pick Light/Dark/System independently of the OS setting. This
  app should do the same — a three-way choice in **Settings**, not a
  CSS-only `prefers-color-scheme` auto-switch with no override. See
  "Recommended mechanism" below.
- **Never pure black.** Both reference products use a dark warm/cool
  charcoal (Telegram's night theme ~`#17212B`-ish blue-black, JetBrains
  Darcula's `#2B2B2B`/`#3C3F41`) rather than `#000`. Pure black against
  vivid accent colors (this app's category colors, the red/green
  expense/income accents) tends to look harsh and crushes perceived depth
  between stacked surfaces (card-on-page). This codebase already has a
  precedent in exactly that spirit — see next section.
- **Consistent, limited "elevation" steps.** JetBrains distinguishes editor
  background vs. tool windows vs. menus with small, consistent lightness
  steps rather than arbitrary per-component grays. This app has an
  analogous surface stack already (page → `.card` → nested `.insight`/
  `.goal-monthly` accent panels → `.modal`/`.tooltip-box` "always dark"
  chips) — each level needs one deliberate step up in lightness from the one
  below it, reused consistently, not invented per component.
- **Accent colors stay saturated, not desaturated-for-dark.** Both
  references keep link/accent colors vivid against dark surfaces rather than
  muting them "to match the mood" — muted accents on dark backgrounds tend
  to lose contrast exactly where the UI needs it (buttons, active states,
  income/expense sums). Verify contrast, don't blanket-desaturate.
- **Deliberate, visible focus/selection state.** Both products have crisp
  selection/focus highlighting. This app currently has **no** custom
  `:focus-visible`/`::selection` styling at all (confirmed: no matches in
  `public/styles.css`) — it's riding on the browser/Chromium default outline,
  which is probably fine in both themes, but should be explicitly verified
  (not assumed) once dark mode exists, since a default focus ring's default
  color may not have been chosen with a dark background in mind.

## Existing precedent in this codebase — reuse it

`desktop/src/lock.html` **already has a working dark variant**, done via
plain `@media (prefers-color-scheme: dark)` (no in-app toggle yet — see
"gap" below). Its palette is the natural starting point, already in the
Darcula-ish "warm charcoal, not black" family the reference apps favor:

```css
:root { color-scheme: light dark; }
/* light (unprefixed) */
body { background: #f5f5f3; color: #1a1a18; }
/* dark */
body { background: #1c1c1a; color: #f2f2f0; }
.card { background: #262624; border-color: #34342f; }
input { background: #1c1c1a; border-color: #3a3a35; color: #f2f2f0; }
```

Extend this palette to the rest of the app rather than inventing a second
one — consistency between the lock screen and the main window matters more
than either individually.

**Gap to close**: `lock.html` only reacts to the OS's `prefers-color-scheme`
— it has no way to honor an in-app manual theme choice, because it's a
*separate* `BrowserWindow`/renderer (see `desktop/src/main.js`
`showAuthWindow`), so it doesn't share the main window's in-memory state.
Once a manual picker exists (see below), `lock.html`/`lock.js` need to read
the persisted preference too — through the same `preload.js` IPC pattern
already used for `app-lock:get` (i.e., a new `theme:get` handler backed by
`config.js`, read on load before first paint the same way `appLockToggle`'s
initial state is read today).

## Recommended mechanism (before writing any component CSS)

1. **Gate activation to desktop only.** The existing pattern (`typeof
   window.desktopApp !== 'undefined' && window.desktopApp.isDesktop`,
   already used repeatedly in `public/app.js` for other desktop-only
   features like app-lock and update-check) is the right signal — same
   static HTML/CSS/JS served to a plain browser tab must never dark-theme
   itself. Scope every dark-mode CSS rule under a selector this flag
   controls (e.g. `html[data-desktop]`), not bare `@media
   (prefers-color-scheme: dark)` alone (that would also dark-theme the web
   version for any visitor with a dark OS, which is explicitly out of
   scope).
2. **Avoid a flash of the wrong theme (FOUC).** `app.js` is loaded via
   `<script src="app.js">` at the very end of `<body>` — by the time it runs,
   the page has already painted once. Detecting desktop-ness and setting
   `data-desktop`/`data-theme` there would cause a visible flash on every
   launch (light frame, then dark). `window.desktopApp` is populated by
   `contextBridge.exposeInMainWorld` before any renderer script runs
   (including inline `<head>` scripts), so the fix is a small **inline
   `<script>` placed in `<head>`, before `<link rel="stylesheet">`**, that
   synchronously sets `document.documentElement.dataset.desktop`/
   `data-theme` from `window.desktopApp` + the persisted preference (see
   next point) before first paint. This needs a synchronous read, so the
   theme preference should be readable without an `await` — e.g. exposed via
   `contextBridge` as a plain value already fetched by preload at
   `document-start`, not an async `ipcRenderer.invoke` round-trip (which
   would itself cause the exact flash this step exists to avoid).
3. **Explicit Light/Dark/System picker in Settings**, not just automatic
   OS-detection — matches Telegram/JetBrains convention (see above) and this
   app's own existing `.type-toggle` three-button component (already used
   for expense/income and "Все/Расходы/Доходы" — reuse that same visual
   pattern for Light/Dark/System rather than introducing a new control
   style).
4. **Persist the choice** the same way `appLockEnabled` already is — a key
   in `desktop-config.json` via `desktop/src/config.js` (`readConfig`/
   `writeConfig`), e.g. `themePreference: 'light' | 'dark' | 'system'`. No
   new storage mechanism needed, this one's a direct precedent.
5. **`color-scheme` for native form controls, for free.** Neither
   `index.html` nor `styles.css` currently declares `color-scheme` at all
   (only `lock.html` does, `:root { color-scheme: light dark; }`). Chromium
   auto-dark-themes native controls — `<select>` dropdown lists, `<input
   type=date>`'s calendar popup, `<input type=number>` spinners, `<input
   type=color>` swatch, scrollbars (relevant: `.chart-scroll`'s horizontal
   scrollbar, part of the documented 6-of-12-months pattern in CLAUDE.md),
   and the native checkbox backing `.switch` — for free once `color-scheme`
   is set to match the active theme. Must be set dynamically (`light dark`
   for "system", or a hard `light`/`dark` for an explicit user choice),
   scoped to desktop the same way as point 1.
6. **Sync native OS-drawn chrome via `nativeTheme.themeSource`.** Electron's
   `nativeTheme` module (main process) drives the color of everything
   Electron/the OS draws outside our CSS: the application `Menu`
   (`desktop/src/menu.js`), native `dialog.*` calls (`showMessageBox`,
   `showSaveDialogSync`, `showErrorBox` — all used in `main.js`), and on
   **Windows specifically, the native window title bar/frame** (Windows gets
   a full standard OS title bar today — `titleBarStyle: 'hiddenInset'` in
   `createWindow()` is a macOS-only option and is silently ignored on
   Windows, so Windows so far has never had custom title-bar treatment at
   all). Without setting `nativeTheme.themeSource`, this native chrome only
   follows the *OS-wide* setting, independent of whatever the user picks
   inside the app — a real, visible mismatch (e.g., app content dark, native
   Windows title bar still light) if the in-app choice and the OS setting
   disagree. Set `nativeTheme.themeSource = 'light' | 'dark' | 'system'`
   whenever the in-app preference changes (main process, in response to the
   same IPC that persists the choice).
7. **`BrowserWindow`'s own `backgroundColor` is hardcoded light and causes a
   flash of white/light on window creation otherwise.** `main.js`
   `createWindow()` and `showAuthWindow()` both currently pass
   `backgroundColor: '#f5f5f3'` (the *light* page background) — this is the
   color Electron paints before the page finishes its first real paint, to
   avoid a flash of pure white. With dark mode, launching in dark theme
   would flash light-gray before the dark CSS ever applies unless this value
   is read from the persisted preference *before* `new BrowserWindow(...)`
   is called (synchronous `config.js` read, already how `isAppLockEnabled()`
   is read at the right point in `launch()` today — same pattern, one more
   field).
8. **CSS custom properties are a prerequisite, not optional.** The current
   stylesheet (`public/styles.css`, 256 lines) hardcodes color literals in
   nearly every rule — there is no `:root { --... }` layer to override today.
   The realistic first implementation step is a mechanical pass converting
   every color literal to a `var(--token-name)`, defined once on `:root` for
   light, then redefined under the dark selector from point 1 — this refactor
   should not change light mode's rendered appearance at all (verify with a
   visual diff/screenshot compare before/after), it just makes overriding
   possible. Don't skip straight to sprinkling `@media (prefers-color-scheme:
   dark)` overrides on the current hardcoded rules — with ~40+ distinct color
   literals across the file (see inventory below) that becomes an unmaintainable
   duplicate stylesheet fast.

## Full inventory — surfaces that need a dark variant

Grouped by area, with current (light-only) values from `public/styles.css`
unless noted. Numbers in parens are approximate line numbers at the time of
this analysis.

**Base**
- `body` background `#f5f5f3` / text `#1a1a18` (2–4)
- `.container`, `.header` background `#fff`, border `#e5e5e2` (12, 15)

**Navigation**
- `.tab-btn` idle text `#666`, border `#d5d5d2`; `.tab-btn.active` bg/border
  `#1a1a18` on white text (26–27) — active-tab treatment (dark chip on light
  page) needs rethinking for a dark page, where an all-`#1a1a18` chip would
  nearly vanish into the background; likely wants a distinct accent instead
  of "page-inverse" in dark mode.

**Cards / metrics**
- `.card`, `.metric` background `#fff`, border `#e5e5e2` (17, 19)
- `.metric.income .value` `#1D9E75`, `.metric.expense .value` `#D85A30`
  (22–23) — verify contrast against the new dark card surface, these look
  likely-fine (mid-saturation, not too dark) but must be checked, not assumed

**Buttons**
- `.btn` primary bg/border `#1a1a18` on white text; `:hover` `opacity:0.85`
  (42–43) — opacity-based hover dimming reads differently on dark vs. light
  surfaces, re-verify it still gives a clear hover cue on dark
- `.btn.secondary` bg `#fff`/text `#1a1a18` (44)
- `.btn.danger` bg `#fff`/text+border `#D85A30` (45)

**Month/year navigation**
- `.month-nav > button` border `#d5d5d2`, bg `#fff` (33)
- `.month-nav select`, `#yearSingleSelect` — border `#d5d5d2` **and** a
  hand-baked SVG dropdown-arrow as a `data:image/svg+xml` background-image
  with a hardcoded `stroke='%23666'` (36–39, 60–63). **This cannot be
  recolored via CSS at all** — it's a fixed-color raster reference baked
  into the rule. Needs either a second dark-mode data-URI variant with a
  light stroke, or (cleaner, and also improves the *light*-mode
  implementation per the "light may need rework too" scope note) switching
  to a `mask-image` + `background-color: currentColor`/`var(...)` technique
  so one shape recolors via normal CSS in both themes.
- `.year-chip` bg `#fff`, border `#d5d5d2`; `:has(input:checked)` inverts to
  `#1a1a18`/white (67–72) — same "page-inverse chip" concern as `.tab-btn.active`

**Category list / bars**
- `.cat-row` border `#f0f0ee` (75); `.cat-name` text `#444` (78)
- `.cat-bar-wrap` track `#f0f0ee` (79); `.cat-pct` `#bbb` (81)
- Category/segment colors themselves (`c.color`, per-category, user-chosen
  or `CAT_COLORS_FALLBACK = '#888780'` in `app.js:1`) — these come from
  user input (`<input type=color>`) or a fixed fallback; not something to
  reassign, but the **fallback** and any *derived* chrome around them (bar
  track, dot border if ever added) need to hold up on both backgrounds.

**Tables**
- `th`/`td` border `#f0f0ee` (85); `th` text `#999` (86)
- `td.amount-expense` `#D85A30`, `td.amount-income` `#1D9E75` (87–88)
- `.row-actions button` idle `#999`, `:hover` `#1a1a18` (90–91) — hover
  target color is literally the "page-inverse" dark; needs a dark-mode
  equivalent hover color that still reads as "more prominent," not the
  page's own background color

**Forms**
- `.field input`/`select`, `.tx-edit-row input`/`select`,
  `.goal-contribute-form input`, `.cat-manage-row input[type=text]` — all
  share the same `border: 1px solid #d5d5d2` pattern (93, 99, 126, 140) —
  good, consistent, one token covers all of these once variabilized
- `.type-toggle` idle button bg `#fff`/text `#666`, border `#d5d5d2` (100–101);
  active variants hardcode `#D85A30` (expense), `#1D9E75` (income), `#1a1a18`
  (neutral/"all"/"existing"/"new") (102–104, 110) — same page-inverse concern
  for the neutral/`#1a1a18` active variant as `.tab-btn.active`
- Two **inline-styled** inputs bypass the shared `.field input` styling
  entirely: `#newExpenseCatName`/`#newIncomeCatName` in `index.html` (164, 173)
  have `style="border:1px solid #d5d5d2; ..."` written directly in the
  markup. Inline `style=` wins over any stylesheet rule short of
  `!important` — these need to move to a shared class before a dark
  override can reach them at all.

**Goals**
- `.goal-card` bg `#fff`, border `#e5e5e2` (114); `.goal-card.completed`
  border `#1D9E75` **and background `#fafffd`** (115) — that pale
  near-white-green completed-state tint needs a dark equivalent (a subtle
  dark-green-tinted surface, not literally the same pale value)
- `.goal-meta` `#999` (121)
- `.goal-monthly` bg `#fafaf8`, left border `#d5d5d2`, text `#555` (122);
  `.overdue` variant border/text `#D85A30`/`#b34324` (123) — same "pale tint
  panel" pattern as `.insight` below, needs the same treatment
- `.goal-icon-btn` idle `#bbb`, hover `#D85A30` (127–128)
- **Goal progress ring is inline SVG with a hardcoded track color**:
  `ringSVG()` in `app.js:701` emits `stroke="#f0f0ee"` directly in the SVG
  string, generated per-render in JS — not reachable by CSS at all. Needs
  either a CSS class on that `<circle>` (`stroke: var(--ring-track)`, SVG
  presentation attributes *can* be overridden by CSS) or computing the
  color in JS from the active theme at render time.

**Insights** (dashboard "up/down/new/gone" callouts)
- `.insight` bg `#fafaf8`, left border `#d5d5d2`, text `#555` (131); `.insight
  b` `#1a1a18` (132); directional accent borders `.up` `#378ADD`, `.down`
  `#7F77DD`, `.new` `#EF9F27`, `.gone` `#999` (133–136) — same pale-tint-panel
  pattern as `.goal-monthly`, one shared token/approach should cover both

**Category management**
- `.cat-manage-row` border `#f0f0ee` (139); text input border `#d5d5d2` (140)

**Toast**
- `.toast` bg **`#1a1a18`, always**, regardless of page theme (144) — in
  light mode this is "dark chip on light page," a deliberate, working
  contrast choice. On a dark page (background likely landing somewhere near
  `#1c1c1a` per the lock-screen precedent), an unchanged `#1a1a18` toast
  would nearly disappear into the page — needs a **distinct, lighter**
  surface color in dark mode (e.g., the `.card`-equivalent dark surface, not
  the page background), not a straight carry-over of the current always-dark
  value.
- `.toast.error` bg `#D85A30` (150) — verify this still reads clearly next
  to the new non-error toast surface once that changes
- `.toast-undo` bg `rgba(255,255,255,0.14)` (153) — a white-tinted overlay
  atop the toast's own background; revisit once the toast surface itself
  changes, since the intended effect ("slightly lighter than the toast
  background") depends on what that background becomes

**Settings**
- `.settings-row-desc`, `.settings-version`, `.settings-contact` all `#999`
  (163, 166, 170); `.settings-row.disabled .settings-row-title` `#bbb` (164)
- `.icon-btn-plain` idle `#999`, hover `#1a1a18` bg `#f0f0ee` (167–168) — same
  "hover color = page-inverse" pattern seen elsewhere
- `.settings-contact a` `#1a1a18` (171, added just before this analysis) —
  will need a dark-mode link color too, now that it exists
- `.switch-track` off-state `#d5d5d2`, on-state `#1D9E75` (checked), knob
  `#fff` with `box-shadow: 0 1px 2px rgba(0,0,0,0.2)` (176–184) — knob shadow
  likely still reads fine on dark (shadows generally do), verify rather than
  assume; the underlying native `<input type=checkbox>` also benefits from
  `color-scheme` per point 5 above, though this control's visual is fully
  custom-drawn via `::before`, not the native checkbox appearance

**Modal**
- `.modal-overlay` scrim `rgba(20,20,18,0.4)` (188) — a dark semi-transparent
  veil; works reasonably over both light and dark content as-is, but
  contrast against an already-dark page is worth a quick visual check
  (may want a slightly higher opacity so the modal still visually separates)
- `.modal` bg `#fff` (192); `.modal p` text `#555` (194)

**Tooltip**
- `.tooltip-box` — **already a dark chip regardless of page theme**, bg
  `#1a1a18`/text `#eee` (201–202), same "always-dark chip" pattern as
  `.toast`. On a dark page this also risks blending into the background —
  needs a lighter surface than the page (not the same near-black), the same
  fix direction as `.toast`.
- `.info-icon` bg `#d5d5d2`, text `#fff` (215) — a light-gray dot with white
  glyph; on a dark page this exact combination might still work (light dot
  pops against dark page) but should be checked for whether it now reads as
  *too* prominent relative to its actual importance (it's a minor help
  affordance)

**Onboarding tour**
- `.tour-spotlight` dimming veil `rgba(15,15,14,0.65)` (233) — same category
  as the modal scrim, likely fine, verify against a dark page
- `.tour-card` bg `#fff` (239); `.tour-card-text` `#555` (244);
  `.tour-step-count` `#aaa` (246)

**Misc**
- `.empty-hint` `#aaa` (158)
- Inline `style="color:#999"` on the rollup-category label in `app.js:133`
  (`<span style="font-size:11px; color:#999; ...">на Дашборде → ...</span>`)
  — same inline-style-bypasses-cascade issue as the two category-name inputs
  above, needs to become a class

## Chart.js — needs explicit color config, not just CSS

**No chart currently sets any text/grid/legend color at all** — every
`new Chart(...)` call in `app.js` (`pieChart` ~406, the shared
`renderMonthlyCategoryChart` bar charts ~458, `yearsCompareChart` line chart
~854) omits `scales.x.ticks.color`, `scales.y.ticks.color`,
`scales.x.grid.color`, `scales.y.grid.color`, and
`plugins.legend.labels.color` entirely, so all of that text/gridline
rendering falls back to **Chart.js's own built-in defaults**, which are
tuned for a light page (axis/legend text renders in a semi-transparent dark
gray, gridlines in a light gray) — on a dark canvas these would be low- to
zero-contrast, effectively invisible. This is pure-CSS-unreachable — Chart.js
draws to `<canvas>`, not DOM elements a stylesheet can select. Needs either:

- a one-time global `Chart.defaults.color = ...` / `Chart.defaults.borderColor
  = ...` set (and re-set + all live chart instances `.update()`'d, or
  destroyed/recreated) whenever the active theme changes, or
- explicit `color`/`grid.color` passed into each chart's `options` at
  creation time, computed from the current theme.

Either way, **every chart must be re-rendered when the theme changes at
runtime** (not just on next app launch) if the picker is meant to apply
live — `pieChart`/`overviewCharts[type]`/`yearsCompareChart` are already
tracked as module-level variables specifically so they can be `.destroy()`'d
and recreated (see the existing `if (existing) existing.destroy()` pattern
already used on data refresh) — reuse that same mechanism for a theme change.

Chart.js's **tooltip** (hover popup on data points) already defaults to a
dark box with white text out of the box, regardless of page theme — this
one is probably fine unchanged in dark mode and low priority to touch.

**`YEAR_PALETTE` (`app.js:776`) includes a near-black entry that would
become invisible on a dark chart background:**
```js
const YEAR_PALETTE = ['#1a1a18', '#378ADD', '#D85A30', '#1D9E75', '#7F77DD', '#EF9F27', '#D4537E', '#639922', '#0F6E56', '#993556'];
```
The first entry (`#1a1a18`, used for whichever year is plotted first in the
"compare years" line chart) is exactly the page's own dark-mode-adjacent
near-black — a line in that color on a dark chart background would be
effectively invisible. Needs a dark-mode-specific swap for that one entry
(e.g., a light gray/white in dark mode) — either a second palette array
selected by theme, or a small per-color override list for just the
problem entries.

## Other implementation notes

- **Live theme switching vs. app restart**: decide whether the Settings
  picker applies immediately (requires the CSS-variable + Chart.js
  re-render + `nativeTheme`/`BrowserWindow.backgroundColor-on-next-launch`
  machinery all above to work live) or only takes effect on next launch
  (much simpler, but a worse UX than the Telegram/JetBrains reference
  point, both of which apply instantly). Recommend live — the app already
  has no restart-required precedent for its other Settings toggles
  (app-lock takes effect "next launch" per its own toast copy, so there's
  actually a mixed precedent — worth deciding deliberately, not by default).
- **`.type-toggle` reuse for the picker itself**: a three-button
  Light/Dark/System control fits the existing `.type-toggle` component
  exactly (already used four times for exactly this shape of choice) —
  build the picker with it rather than a new control type.
- Category/goal user-chosen colors (via `<input type=color>`) are
  intentionally left alone in this analysis — they're per-user data, not
  something a theme should override, only the *chrome around* them
  (fallback color, track colors, borders) is in scope.
