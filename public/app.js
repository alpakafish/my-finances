const CAT_COLORS_FALLBACK = '#888780';

// Экранирование для любого пользовательского текста (заметка операции, название
// категории/цели, цвет категории), который идёт в innerHTML — как текстовое
// содержимое, так и внутрь HTML-атрибутов (value="...", style="...") ниже по
// файлу. Без этого, например, заметка вида `<img src=x onerror=...>` реально
// выполнялась бы как код при отрисовке списка операций (проверено вручную) —
// категории/операции могут прийти и через импорт Excel-файла, не только через
// форму в самом приложении, так что это не только «сам себе злобный Буратино».
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------- Тема оформления (desktop-only, см. desktop/DARK_THEME.md) ----------
// html[data-theme] уже проставлен inline-скриптом в <head> index.html (до первой
// отрисовки, чтобы не мигнуть не той темой) — здесь просто читаем то, что там есть.
// Для веб-версии window.desktopApp не определён вовсе, data-theme никогда не
// ставится, currentTheme() ниже всегда 'light' — тема веб-версии не трогается.
function currentTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

// Chart.js рисует в <canvas> — CSS до текста осей/сетки/легенды не достаёт,
// нужно явно передавать цвета (см. DARK_THEME.md "Chart.js — needs explicit
// color config"). Светлые значения — это ТОЧНО дефолты самой Chart.js (сверено
// с public/vendor/chart.umd.js: color:'#666', borderColor:rgba(0,0,0,0.1)),
// чтобы светлая тема не изменилась ни на пиксель.
function applyChartDefaults() {
  const dark = currentTheme() === 'dark';
  Chart.defaults.color = dark ? '#c8c8c4' : '#666';
  Chart.defaults.borderColor = dark ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.1)';
}

// YEAR_PALETTE[0] (см. ниже, вкладка «По годам») — тот же почти-чёрный, что и
// текст страницы в светлой теме; на тёмном фоне графика станет невидимым.
// yearPalette() ниже подменяет только этот один цвет.
function yearPalette() {
  return currentTheme() === 'dark' ? ['#f2f2f0', ...YEAR_PALETTE.slice(1)] : YEAR_PALETTE;
}

// Пере-рендер того, что тема не может перекрасить сама через CSS: графики на
// <canvas> (кольца целей это уже CSS-класс .ring-track, пере-рендер не нужен).
// Вызывается и при явном выборе темы, и при живой смене OS-темы в режиме
// "Системная" (см. initThemeSetting).
function rerenderThemedContent() {
  applyChartDefaults();
  refreshDashboard();
  loadGoals();
  if (yearSingleChart || yearsCompareChart) {
    loadYearSingleChart();
    loadYearsCompareChart();
  }
}

function applyEffectiveTheme(effective) {
  const root = document.documentElement;
  if (root.dataset.theme === effective) return; // не изменилось — не дёргаем графики зря
  root.dataset.theme = effective;
  root.style.colorScheme = effective;
  rerenderThemedContent();
}

async function initThemeSetting() {
  const isDesktop = typeof window.desktopApp !== 'undefined' && window.desktopApp.isDesktop;
  const toggle = document.getElementById('themeModeToggle');
  const row = toggle.closest('.settings-row');
  const desc = document.getElementById('themeModeDesc');

  if (!isDesktop) {
    Array.from(toggle.querySelectorAll('button')).forEach((b) => { b.disabled = true; });
    row.classList.add('disabled');
    return;
  }
  desc.textContent = 'Применяется сразу, без перезапуска.';

  const { preference } = await window.desktopApp.getThemePreference();
  toggle.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.mode === preference));

  toggle.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    toggle.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
    const { effective } = await window.desktopApp.setThemePreference(btn.dataset.mode);
    applyEffectiveTheme(effective);
  });

  // Пользователь выбрал "Системная" и поменял тему в самой ОС, пока приложение
  // открыто — main-процесс (nativeTheme.on('updated', ...) в main.js) шлёт новое
  // эффективное значение, здесь просто применяем.
  window.desktopApp.onEffectiveThemeChange((effective) => applyEffectiveTheme(effective));
}

let categories = [];
let currentMonth = monthKey(new Date());
let pieChart = null;
let txType = 'expense';
let txFilterType = 'all';
let txFilterCategory = ''; // '' = все категории, иначе id
let txSearchQuery = '';
const overviewCharts = { expense: null, income: null };
const INSIGHT_RATIO = 1.5;

function monthKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
}
// Символ и порядок для настройки «Валюта отображения» (Настройки, #currencySelect) —
// чисто формат, без конвертации: fmt() просто меняет, как подписано число, а не
// пересчитывает его. 'before' — символ вплотную к числу без пробела (как $1 234),
// 'after' — число, пробел, символ (как 1 234 ₽).
const CURRENCIES = {
  RUB: { symbol: '₽', position: 'after' },
  USD: { symbol: '$', position: 'before' },
  EUR: { symbol: '€', position: 'before' },
  GBP: { symbol: '£', position: 'before' },
  CNY: { symbol: '¥', position: 'before' },
  BRL: { symbol: 'R$', position: 'before' },
  TRY: { symbol: '₺', position: 'after' },
  GEL: { symbol: '₾', position: 'after' },
  AMD: { symbol: '֏', position: 'after' },
  KZT: { symbol: '₸', position: 'after' },
  AED: { symbol: 'د.إ', position: 'after' },
  JPY: { symbol: '¥', position: 'before' },
};
let currentCurrency = 'RUB';

// kopecks: true показывает точную сумму с копейками (99,9 → «99,90», не
// «100») — пока только для списка операций (вкладка «Операции», см.
// loadTransactionsTable/loadRecurringSuggestions/refreshTrashCard ниже), где
// округление реально теряло данные, которые пользователь только что ввёл.
// Остальные места (Дашборд, Лимиты, Цели, По годам) — по-прежнему округляют:
// это агрегированные суммы за период, где копейки только шумят, не так
// значимы, как в списке конкретных, только что введённых операций.
function fmt(n, { kopecks = false } = {}) {
  const { symbol, position } = CURRENCIES[currentCurrency] || CURRENCIES.RUB;
  const absNum = Math.abs(n);
  const abs = kopecks
    ? absNum.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : Math.round(absNum).toLocaleString('ru-RU');
  const sign = n < 0 ? '-' : '';
  return position === 'before' ? `${sign}${symbol}${abs}` : `${sign}${abs} ${symbol}`;
}
function lastNMonths(n) {
  const now = new Date();
  const list = [];
  for (let i = 0; i < n; i++) {
    list.push(monthKey(new Date(now.getFullYear(), now.getMonth() - i, 1)));
  }
  return list;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || `Ошибка запроса: ${res.status}`);
    err.body = body;
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

function toast(message, isError = false, duration = 2500, action = null, actionLabel = 'Отменить') {
  const el = document.getElementById('toast');
  const undoBtn = document.getElementById('toastUndoBtn');
  document.getElementById('toastMsg').textContent = message;
  el.className = 'toast show' + (isError ? ' error' : '');
  undoBtn.hidden = !action;
  document.getElementById('toastUndoLabel').textContent = actionLabel;
  undoBtn.onclick = action ? () => { action(); el.className = 'toast'; clearTimeout(toast._t); } : null;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.className = 'toast'; }, action ? Math.max(duration, 8000) : duration);
}

// ---------- Корзина удалённых операций (public/../db.js: deleted_transactions) ----------
// Раньше отмена удаления жила только в памяти вкладки и работала только для
// самого последнего удаления, сбрасываясь при любом другом действии (см. git
// history). Теперь источник правды — бэкенд: хранит последние 10 удалений,
// переживает перезапуск приложения, и Cmd/Ctrl+Z всегда пробует восстановить
// самое последнее из них, независимо от того, что произошло с тех пор.
async function undoLastDelete() {
  let trash;
  try { trash = await api('/api/transactions/trash'); } catch (e) { return; }
  if (!trash.length) {
    toast(
      'Нечего восстанавливать — последние 10 удалений уже разобраны. Операции постарше можно найти в бэкапе.',
      false, 6000, openBackupsFolder, 'Открыть бэкапы'
    );
    return;
  }
  try {
    await api(`/api/transactions/trash/${trash[0].id}/restore`, { method: 'POST' });
    toast('Удаление отменено');
    await loadTransactionsTable();
    refreshDashboard();
    await refreshTrashCard();
  } catch (e) { toast(e.message, true); }
}

document.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.key.toLowerCase() !== 'z') return;
  const t = e.target;
  const isEditable = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  if (isEditable) return;
  e.preventDefault();
  undoLastDelete();
});

// Карточка «Корзина» внизу вкладки «Операции» — видна всегда (а не только
// когда там что-то есть), чтобы место в интерфейсе, о котором пишет тост при
// удалении, было предсказуемым и не появлялось из ниоткуда.
function trashRowLabel(row) {
  const sign = row.type === 'expense' ? '−' : '+';
  const cash = row.excluded_from_total ? ' <span class="cash-badge">нал.</span>' : '';
  const note = row.note ? ` · ${escapeHtml(row.note)}` : '';
  return `${escapeHtml(row.date)} · ${escapeHtml(row.category_name)} · ${sign}${fmt(row.amount, { kopecks: true })}${cash}${note}`;
}

async function refreshTrashCard() {
  let trash;
  try { trash = await api('/api/transactions/trash'); } catch (e) { return; }
  const countEl = document.getElementById('trashCount');
  countEl.textContent = trash.length;
  countEl.hidden = trash.length === 0;

  const list = document.getElementById('trashList');
  const emptyHint = document.getElementById('trashEmptyHint');
  if (!trash.length) {
    list.innerHTML = '';
    emptyHint.style.display = 'block';
    return;
  }
  emptyHint.style.display = 'none';
  list.innerHTML = trash.map((row) => `
    <div class="trash-row" data-id="${row.id}">
      <span class="trash-row-info">${trashRowLabel(row)}</span>
      <button type="button" class="btn small secondary" data-role="trash-restore">Восстановить</button>
    </div>
  `).join('');

  list.querySelectorAll('[data-role="trash-restore"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('.trash-row').dataset.id;
      btn.disabled = true;
      try {
        await api(`/api/transactions/trash/${id}/restore`, { method: 'POST' });
        toast('Операция восстановлена');
        await loadTransactionsTable();
        refreshDashboard();
        await refreshTrashCard();
      } catch (e) {
        toast(e.message, true);
        btn.disabled = false;
      }
    });
  });
}
document.getElementById('trashOpenBackupsBtn').addEventListener('click', openBackupsFolder);

// ---------- Confirm modal ----------
function showConfirmModal({ title, text, confirmLabel = 'Удалить', onConfirm }) {
  const overlay = document.getElementById('confirmModal');
  document.getElementById('confirmModalTitle').textContent = title;
  document.getElementById('confirmModalText').textContent = text;
  const confirmBtn = document.getElementById('confirmModalConfirm');
  confirmBtn.textContent = confirmLabel;
  const cancelBtn = document.getElementById('confirmModalCancel');

  const close = () => { overlay.hidden = true; confirmBtn.onclick = null; cancelBtn.onclick = null; };
  confirmBtn.onclick = async () => { close(); await onConfirm(); };
  cancelBtn.onclick = close;
  overlay.hidden = false;
}

// ---------- Category-in-use modal (удаление категории с операциями) ----------
// Раньше это делалось через window.prompt() — Electron не отрисовывает его в
// BrowserWindow вообще (см. CLAUDE.md "General lesson"), поэтому в desktop-версии
// клик по «Удалить» у категории с операциями визуально ничего не делал. Здесь тот
// же паттерн, что для confirmIdentity/showLockScreen — обычная модалка, не
// window.*, плюс третий вариант (удалить операции вместе с категорией), которого
// раньше не было вовсе.
function showCategoryDeleteModal({ categoryName, type, excludeId, usageCount, onReassign, onDeleteTransactions }) {
  const overlay = document.getElementById('categoryDeleteModal');
  document.getElementById('categoryDeleteText').textContent =
    `На категорию «${categoryName}» есть операций: ${usageCount}. Что с ними сделать?`;

  const reassignField = document.getElementById('categoryDeleteReassignField');
  const reassignSelect = document.getElementById('categoryDeleteReassignSelect');
  const reassignBtn = document.getElementById('categoryDeleteReassignBtn');
  const removeTxBtn = document.getElementById('categoryDeleteRemoveTx');
  const cancelBtn = document.getElementById('categoryDeleteCancel');

  const others = categories.filter((c) => c.type === type && String(c.id) !== String(excludeId));
  const canReassign = others.length > 0;
  reassignField.style.display = canReassign ? '' : 'none';
  reassignBtn.style.display = canReassign ? '' : 'none';
  if (canReassign) {
    reassignSelect.innerHTML = others.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  }

  const close = () => {
    overlay.hidden = true;
    reassignBtn.onclick = null; removeTxBtn.onclick = null; cancelBtn.onclick = null;
  };
  reassignBtn.onclick = async () => { const targetId = Number(reassignSelect.value); close(); await onReassign(targetId); };
  removeTxBtn.onclick = async () => { close(); await onDeleteTransactions(); };
  cancelBtn.onclick = close;
  overlay.hidden = false;
}

// ---------- Tabs ----------
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'years') loadYearsTab();
    if (btn.dataset.tab === 'limits') loadLimitsTab();
    if (btn.dataset.tab === 'dashboard') refreshDashboard();
  });
});

// ---------- Categories ----------
async function loadCategories() {
  categories = await api('/api/categories');
  renderTxCategoryOptions();
  renderTxFilterCategoryOptions();
  renderCategoryManageLists();
  renderGoalCategoryOptions();
}

function renderTxCategoryOptions() {
  const select = document.getElementById('txCategory');
  const filtered = categories.filter((c) => c.type === txType);
  select.innerHTML = filtered.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
}

// Фильтр по категории на вкладке «Операции» — список сужается под выбранный
// там тип (кнопки «Все/Расходы/Доходы»), тот же принцип, что и у категории в
// форме новой операции выше, только с доп. вариантом «Все категории» и
// группировкой (optgroup), когда тип — «Все» (иначе пришлось бы показывать
// расходы и доходы вперемешку одним плоским списком).
function renderTxFilterCategoryOptions() {
  const select = document.getElementById('txFilterCategory');
  const previousValue = select.value;
  const optionHtml = (c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`;

  let html = '<option value="">Все категории</option>';
  if (txFilterType === 'all') {
    const expense = categories.filter((c) => c.type === 'expense');
    const income = categories.filter((c) => c.type === 'income');
    html += `<optgroup label="Расходы">${expense.map(optionHtml).join('')}</optgroup>`;
    html += `<optgroup label="Доходы">${income.map(optionHtml).join('')}</optgroup>`;
  } else {
    html += categories.filter((c) => c.type === txFilterType).map(optionHtml).join('');
  }
  select.innerHTML = html;

  // Сохраняем текущий выбор, только если он ещё существует в новом наборе —
  // сменили тип и выбранная категория стала несовместимой ("Еда" при "Доходы")
  // → тихо сбрасываем на "Все категории" вместо невидимого несоответствия,
  // которое молча вернуло бы пустой список без объяснений.
  const stillValid = [...select.options].some((o) => o.value === previousValue);
  select.value = stillValid ? previousValue : '';
  txFilterCategory = select.value;
}

function renderCategoryManageLists() {
  const renderGroup = (type, containerId) => {
    const container = document.getElementById(containerId);
    const list = categories.filter((c) => c.type === type);
    container.innerHTML = list.map((c) => {
      const rollupName = c.rollup_id ? (categories.find((x) => x.id === c.rollup_id) || {}).name : null;
      return `
      <div class="cat-manage-row" data-id="${c.id}">
        <input type="color" value="${escapeHtml(c.color)}" data-role="color">
        <input type="text" value="${escapeHtml(c.name)}" data-role="name">
        ${rollupName ? `<span class="rollup-label">на Дашборде → ${escapeHtml(rollupName)}</span>` : ''}
        <button class="btn small secondary" data-role="save">Сохранить</button>
        <button class="btn small danger" data-role="delete">Удалить</button>
      </div>
    `;
    }).join('') || '<div class="empty-hint">Нет категорий</div>';

    container.querySelectorAll('.cat-manage-row').forEach((row) => {
      const id = row.dataset.id;
      row.querySelector('[data-role="save"]').addEventListener('click', async () => {
        const name = row.querySelector('[data-role="name"]').value.trim();
        const color = row.querySelector('[data-role="color"]').value;
        try {
          await api(`/api/categories/${id}`, { method: 'PUT', body: JSON.stringify({ name, color }) });
          toast('Категория обновлена');
          await loadCategories();
          refreshDashboard();
        } catch (e) { toast(e.message, true); }
      });
      row.querySelector('[data-role="delete"]').addEventListener('click', async () => {
        const categoryName = row.querySelector('[data-role="name"]').value;
        try {
          await api(`/api/categories/${id}`, { method: 'DELETE' });
          toast('Категория удалена');
          await loadCategories();
          refreshDashboard();
        } catch (e) {
          if (!(e.body && e.body.usageCount)) {
            toast(e.message, true);
            return;
          }
          showCategoryDeleteModal({
            categoryName, type, excludeId: id, usageCount: e.body.usageCount,
            onReassign: async (targetId) => {
              try {
                await api(`/api/categories/${id}?reassignTo=${targetId}`, { method: 'DELETE' });
                toast('Операции перенесены, категория удалена');
                await loadCategories();
                await loadTransactionsTable();
                await loadGoals();
                refreshDashboard();
              } catch (err) { toast(err.message, true); }
            },
            onDeleteTransactions: async () => {
              try {
                await api(`/api/categories/${id}?deleteTransactions=true`, { method: 'DELETE' });
                toast('Операции и категория удалены');
                await loadCategories();
                await loadTransactionsTable();
                await loadGoals();
                refreshDashboard();
              } catch (err) { toast(err.message, true); }
            },
          });
        }
      });
    });
  };
  renderGroup('expense', 'expenseCatList');
  renderGroup('income', 'incomeCatList');
}

document.getElementById('addExpenseCat').addEventListener('click', () => addCategory('expense', 'newExpenseCatName', 'newExpenseCatColor'));
document.getElementById('addIncomeCat').addEventListener('click', () => addCategory('income', 'newIncomeCatName', 'newIncomeCatColor'));

async function addCategory(type, nameId, colorId) {
  const nameEl = document.getElementById(nameId);
  const colorEl = document.getElementById(colorId);
  const name = nameEl.value.trim();
  if (!name) return;
  try {
    await api('/api/categories', { method: 'POST', body: JSON.stringify({ name, type, color: colorEl.value }) });
    nameEl.value = '';
    toast('Категория добавлена');
    await loadCategories();
  } catch (e) { toast(e.message, true); }
}

// ---------- Transaction type toggle ----------
document.getElementById('txTypeToggle').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-type]');
  if (!btn) return;
  txType = btn.dataset.type;
  document.querySelectorAll('#txTypeToggle button').forEach((b) => b.classList.toggle('active', b === btn));
  renderTxCategoryOptions();
});

// «Не спрашивая» имеет смысл только вместе с «Повтор.» — поле спрятано, пока
// «Повтор.» не отмечено, и снимается вместе с ним, а не остаётся висеть
// отмеченным-но-невидимым.
document.getElementById('txRecurring').addEventListener('change', (e) => {
  document.getElementById('txAutoConfirmField').hidden = !e.target.checked;
  if (!e.target.checked) document.getElementById('txAutoConfirm').checked = false;
});

// ---------- Add transaction ----------
document.getElementById('txForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const excludedCheckbox = document.getElementById('txExcludedFromTotal');
  const recurringCheckbox = document.getElementById('txRecurring');
  const autoConfirmCheckbox = document.getElementById('txAutoConfirm');
  const payload = {
    type: txType,
    date: document.getElementById('txDate').value,
    category_id: Number(document.getElementById('txCategory').value),
    amount: Number(document.getElementById('txAmount').value),
    note: document.getElementById('txNote').value,
    excluded_from_total: excludedCheckbox.checked,
    is_recurring: recurringCheckbox.checked,
    auto_confirm: autoConfirmCheckbox.checked,
  };
  try {
    await api('/api/transactions', { method: 'POST', body: JSON.stringify(payload) });
    document.getElementById('txAmount').value = '';
    document.getElementById('txNote').value = '';
    excludedCheckbox.checked = false;
    recurringCheckbox.checked = false;
    autoConfirmCheckbox.checked = false;
    document.getElementById('txAutoConfirmField').hidden = true;
    toast('Операция добавлена');
    await loadTransactionsTable();
    refreshDashboard();
  } catch (e) { toast(e.message, true); }
});

// ---------- Transactions filter (type/category/search) ----------
document.getElementById('txFilterType').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-type]');
  if (!btn) return;
  txFilterType = btn.dataset.type;
  document.querySelectorAll('#txFilterType button').forEach((b) => b.classList.toggle('active', b === btn));
  renderTxFilterCategoryOptions(); // список категорий сужается под новый тип, несовместимый выбор сбрасывается
  loadTransactionsTable();
});

document.getElementById('txFilterCategory').addEventListener('change', (e) => {
  txFilterCategory = e.target.value;
  loadTransactionsTable();
});

// Поиск — по заметке и сумме (см. loadTransactionsTable: фильтруется на
// фронтенде через .toLowerCase(), не SQL LIKE — тот регистронезависим только
// для ASCII, кириллицу без ICU-расширения не считает совпадением). Небольшой
// debounce, чтобы не дёргать запрос на каждую букву при быстром вводе.
let txSearchDebounceTimer = null;
document.getElementById('txSearchInput').addEventListener('input', (e) => {
  txSearchQuery = e.target.value;
  document.getElementById('txSearchClear').hidden = txSearchQuery.length === 0;
  clearTimeout(txSearchDebounceTimer);
  txSearchDebounceTimer = setTimeout(loadTransactionsTable, 250);
});

document.getElementById('txSearchClear').addEventListener('click', () => {
  const input = document.getElementById('txSearchInput');
  input.value = '';
  txSearchQuery = '';
  document.getElementById('txSearchClear').hidden = true;
  loadTransactionsTable();
});

// ---------- Recurring transaction suggestions ----------
// Карточки над списком операций: «Зарплата — повторяется, добавить за этот
// месяц?» — см. чекбокс «Повтор.» в форме выше и routes/recurring.js. Шаблоны
// с «не спрашивая» (auto_confirm) сюда карточкой не попадают вообще — тихо
// подтверждаются САМИ, той же суммой, что в прошлый раз, до того как
// отрисуется список: пользователь просто видит уже добавленную операцию.
async function loadRecurringSuggestions(month) {
  const container = document.getElementById('recurringSuggestions');
  const suggestions = await api(`/api/recurring/suggestions?month=${month}`);

  const autoOnes = suggestions.filter((s) => s.auto_confirm);
  const manualOnes = suggestions.filter((s) => !s.auto_confirm);

  if (autoOnes.length) {
    const results = await Promise.allSettled(autoOnes.map((s) => api(`/api/recurring/${s.source_id}/confirm`, {
      method: 'POST', body: JSON.stringify({ month, amount: s.amount }),
    })));
    const added = autoOnes.filter((_, i) => results[i].status === 'fulfilled');
    const failed = autoOnes.filter((_, i) => results[i].status === 'rejected');
    if (added.length) toast(`Добавлено автоматически: ${added.map((s) => s.category_name).join(', ')}`);
    if (failed.length) toast(`Не удалось автоматически добавить: ${failed.map((s) => s.category_name).join(', ')}`, true);
  }

  if (!manualOnes.length) { container.innerHTML = ''; return; }

  container.innerHTML = manualOnes.map((s) => `
    <div class="recurring-suggestion" data-source-id="${s.source_id}">
      <span class="recurring-icon">↻</span>
      <div class="recurring-suggestion-text">
        <div class="recurring-suggestion-title">${escapeHtml(s.category_name)} — повторяется ежемесячно</div>
        <div class="recurring-suggestion-meta">В прошлый раз: ${fmt(s.amount, { kopecks: true })}</div>
      </div>
      <input type="number" class="recurring-amount-input" min="0" step="0.01" value="${s.amount}">
      <button type="button" class="btn small recurring-confirm-btn">Добавить</button>
      <button type="button" class="recurring-suggestion-skip">Пропустить</button>
    </div>
  `).join('');

  container.querySelectorAll('.recurring-suggestion').forEach((el) => {
    const sourceId = el.dataset.sourceId;

    el.querySelector('.recurring-confirm-btn').addEventListener('click', async () => {
      const amount = Number(el.querySelector('.recurring-amount-input').value);
      if (!(amount > 0)) { toast('Сумма должна быть больше нуля', true); return; }
      try {
        await api(`/api/recurring/${sourceId}/confirm`, { method: 'POST', body: JSON.stringify({ month, amount }) });
        toast('Операция добавлена');
        await loadTransactionsTable();
        refreshDashboard();
      } catch (e) { toast(e.message, true); }
    });

    el.querySelector('.recurring-suggestion-skip').addEventListener('click', async () => {
      try {
        await api(`/api/recurring/${sourceId}/skip`, { method: 'POST', body: JSON.stringify({ month }) });
        el.remove();
      } catch (e) { toast(e.message, true); }
    });
  });
}

// ---------- Transactions table ----------
let currentTxRows = [];

async function loadTransactionsTable() {
  const monthSelect = document.getElementById('txMonthSelect');
  const selectedMonth = monthSelect.value; // '' = «Все время», как '' у фильтра категории = «Все категории»
  const query = txSearchQuery.trim();
  // Поиск — по всей истории, а не только за выбранный месяц (в этом весь
  // смысл: искать операцию, которую не помнишь, в каком месяце вносил), но
  // тип и категория продолжают действовать. «Все время» в селекторе месяца —
  // то же самое отсутствие ограничения по месяцу, только выбранное явно, а
  // не через поиск (нужно, например, чтобы посмотреть вообще все операции
  // категории, а не только за один месяц).
  const isSearching = query.length > 0;
  const showAllTime = isSearching || selectedMonth === '';
  const params = new URLSearchParams();
  if (!showAllTime) params.set('month', selectedMonth);
  if (txFilterType !== 'all') params.set('type', txFilterType);
  if (txFilterCategory) params.set('category_id', txFilterCategory);

  // Поиск блокирует сам селектор месяца (он в это время ничего не решает,
  // не хотим, чтобы выглядело забытым) — «Все время» же остаётся обычным
  // выбираемым значением, доступным и без поиска.
  monthSelect.disabled = isSearching;

  let title = 'Операции за месяц';
  if (isSearching) title = `Результаты поиска: «${query}»`;
  else if (selectedMonth === '') title = 'Операции за всё время';
  document.getElementById('txListTitle').textContent = title;

  // Подсказки про повторяющиеся операции — про конкретный месяц, без него
  // (поиск или «Все время») не имеют смысла, просто прячем. Дожидаемся ДО
  // запроса списка операций ниже (не Promise.all параллельно, как раньше) —
  // шаблоны с «не спрашивая» добавляют операцию сами внутри
  // loadRecurringSuggestions, и если бы список операций запрашивался
  // одновременно, только что автодобавленная операция могла не попасть в
  // этот же рендер, показавшись только после следующей перезагрузки.
  if (showAllTime) document.getElementById('recurringSuggestions').innerHTML = '';
  else await loadRecurringSuggestions(selectedMonth);

  const allRows = await api(`/api/transactions?${params.toString()}`);

  // Регистронезависимо и корректно для кириллицы (SQL LIKE — только для ASCII
  // без ICU-расширения, которого в node:sqlite нет) — поэтому фильтруем в JS,
  // а не через SQL-параметр. По заметке и по сумме (как строке — "1500"
  // находит и 1500, и 11500, не только точное совпадение).
  const rows = isSearching
    ? allRows.filter((r) => (r.note || '').toLowerCase().includes(query.toLowerCase()) || String(r.amount).includes(query))
    : allRows;

  currentTxRows = rows;
  const tbody = document.getElementById('txTableBody');
  const emptyHint = document.getElementById('txEmptyHint');
  if (!rows.length) {
    tbody.innerHTML = '';
    if (isSearching) emptyHint.textContent = 'Совпадений не найдено';
    else if (selectedMonth === '') emptyHint.textContent = 'Операций пока нет';
    else emptyHint.textContent = 'Пока нет операций за этот месяц';
    emptyHint.style.display = 'block';
    return;
  }
  emptyHint.style.display = 'none';
  tbody.innerHTML = rows.map((r) => `
    <tr data-id="${r.id}">
      <td>${escapeHtml(r.date)}</td>
      <td>${r.type === 'expense' ? 'Расход' : 'Доход'}</td>
      <td>${escapeHtml(r.category_name)}</td>
      <td class="amount-${r.type}">${fmt(r.amount, { kopecks: true })}${r.excluded_from_total ? ' <span class="cash-badge">нал.</span>' : ''}${r.is_recurring ? `
        <span class="tooltip-wrap recurring-badge-wrap">
          <span class="recurring-badge">↻</span>
          <div class="tooltip-box">Повторяется каждый месяц. Чтобы отключить — нажмите ✎ и снимите галочку «повторять каждый месяц».</div>
        </span>
      ` : ''}</td>
      <td>${escapeHtml(r.note || '')}</td>
      <td class="row-actions">
        <button data-role="edit" title="Изменить">✎</button>
        <button data-role="delete" title="Удалить">✕</button>
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('[data-role="delete"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('tr').dataset.id;
      await api(`/api/transactions/${id}`, { method: 'DELETE' });
      toast('Операция удалена. Последние 10 удалений можно вернуть в Корзине внизу вкладки «Операции».', false, 4000, undoLastDelete);
      await loadTransactionsTable();
      refreshDashboard();
      await refreshTrashCard();
    });
  });

  tbody.querySelectorAll('[data-role="edit"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.closest('tr').dataset.id;
      const tx = currentTxRows.find((r) => String(r.id) === String(id));
      if (tx) renderTxEditRow(tx);
    });
  });
}

// ---------- Edit transaction (inline row) ----------
function categoryOptionsHtml(type, selectedId) {
  return categories.filter((c) => c.type === type)
    .map((c) => `<option value="${c.id}" ${c.id === selectedId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`)
    .join('');
}

function renderTxEditRow(tx) {
  const row = document.querySelector(`#txTableBody tr[data-id="${tx.id}"]`);
  if (!row) return;
  row.classList.add('tx-edit-row');
  row.innerHTML = `
    <td><input type="date" class="edit-date" value="${escapeHtml(tx.date)}"></td>
    <td>
      <select class="edit-type">
        <option value="expense" ${tx.type === 'expense' ? 'selected' : ''}>Расход</option>
        <option value="income" ${tx.type === 'income' ? 'selected' : ''}>Доход</option>
      </select>
    </td>
    <td><select class="edit-category">${categoryOptionsHtml(tx.type, tx.category_id)}</select></td>
    <td><input type="number" class="edit-amount" min="0" step="0.01" value="${tx.amount}"></td>
    <td>
      <input type="text" class="edit-note" value="${escapeHtml(tx.note || '')}">
      <label style="display:flex; align-items:center; gap:4px; font-size:11px; color:var(--color-text-tertiary); margin-top:4px; cursor:pointer; white-space:nowrap;">
        <input type="checkbox" class="edit-excluded" ${tx.excluded_from_total ? 'checked' : ''}> нал., не в общей сумме
      </label>
      <label style="display:flex; align-items:center; gap:4px; font-size:11px; color:var(--color-text-tertiary); margin-top:4px; cursor:pointer; white-space:nowrap;">
        <input type="checkbox" class="edit-recurring" ${tx.is_recurring ? 'checked' : ''}> повторять каждый месяц
      </label>
      <label class="edit-auto-confirm-label" style="display:flex; align-items:center; gap:4px; font-size:11px; color:var(--color-text-tertiary); margin-top:4px; cursor:pointer; white-space:nowrap;" ${tx.is_recurring ? '' : 'hidden'}>
        <input type="checkbox" class="edit-auto-confirm" ${tx.auto_confirm ? 'checked' : ''}> добавлять не спрашивая
      </label>
    </td>
    <td class="row-actions">
      <button data-role="save-edit" title="Сохранить">✓</button>
      <button data-role="cancel-edit" title="Отмена">✕</button>
    </td>
  `;

  row.querySelector('.edit-type').addEventListener('change', (e) => {
    row.querySelector('.edit-category').innerHTML = categoryOptionsHtml(e.target.value, null);
  });

  row.querySelector('.edit-recurring').addEventListener('change', (e) => {
    row.querySelector('.edit-auto-confirm-label').hidden = !e.target.checked;
    if (!e.target.checked) row.querySelector('.edit-auto-confirm').checked = false;
  });

  row.querySelector('[data-role="cancel-edit"]').addEventListener('click', () => loadTransactionsTable());

  row.querySelector('[data-role="save-edit"]').addEventListener('click', async () => {
    const payload = {
      date: row.querySelector('.edit-date').value,
      type: row.querySelector('.edit-type').value,
      category_id: Number(row.querySelector('.edit-category').value),
      amount: Number(row.querySelector('.edit-amount').value),
      note: row.querySelector('.edit-note').value,
      excluded_from_total: row.querySelector('.edit-excluded').checked,
      is_recurring: row.querySelector('.edit-recurring').checked,
      auto_confirm: row.querySelector('.edit-auto-confirm').checked,
    };
    if (!payload.date || !payload.category_id || !(payload.amount > 0)) {
      toast('Заполните дату, категорию и сумму (> 0)', true);
      return;
    }
    try {
      await api(`/api/transactions/${tx.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      toast('Операция изменена');
      await loadTransactionsTable();
      refreshDashboard();
    } catch (e) { toast(e.message, true); }
  });
}

// ---------- Month selectors ----------
function populateMonthSelectors() {
  const months = lastNMonths(24);
  const options = months.map((m) => `<option value="${m}">${monthLabel(m)}</option>`).join('');
  document.getElementById('monthSelect').innerHTML = options;
  // «Все время» — только на вкладке «Операции» (значение "", как «Все категории»
  // у фильтра по категории), не на Дашборде: отчёт за месяц там неотделим от
  // конкретного месяца, «за всё время» ему просто некуда было бы деться.
  document.getElementById('txMonthSelect').innerHTML = `<option value="">Все время</option>${options}`;
  document.getElementById('monthSelect').value = currentMonth;
  document.getElementById('txMonthSelect').value = currentMonth;
}

document.getElementById('monthSelect').addEventListener('change', (e) => {
  currentMonth = e.target.value;
  refreshDashboard();
});
document.getElementById('prevMonth').addEventListener('click', () => shiftMonth(-1));
document.getElementById('nextMonth').addEventListener('click', () => shiftMonth(1));
function shiftMonth(delta) {
  const select = document.getElementById('monthSelect');
  const idx = Array.from(select.options).findIndex((o) => o.value === currentMonth);
  const newIdx = idx - delta; // list is newest-first (i=0 is current month), so "next" = smaller index
  if (newIdx >= 0 && newIdx < select.options.length) {
    currentMonth = select.options[newIdx].value;
    select.value = currentMonth;
    refreshDashboard();
  }
}
document.getElementById('txMonthSelect').addEventListener('change', loadTransactionsTable);

// ---------- Dashboard ----------
async function loadDashboardMonth() {
  const data = await api(`/api/summary/${currentMonth}`);
  document.getElementById('m-income').textContent = fmt(data.totalIncome);
  document.getElementById('m-expense').textContent = fmt(data.totalExpense);
  document.getElementById('m-balance').textContent = fmt(data.balance);

  const list = document.getElementById('month-cat-list');
  const twoCol = document.getElementById('monthTwoCol');
  const structureCol = document.getElementById('structureCol');
  twoCol.classList.toggle('is-empty', !data.expenseByCategory.length);
  structureCol.style.display = data.expenseByCategory.length ? '' : 'none';
  if (!data.expenseByCategory.length) {
    list.innerHTML = '<div class="empty-hint">Нет расходов за этот месяц</div>';
  } else {
    list.innerHTML = data.expenseByCategory.map((c) => `
      <div class="cat-row${c.components ? ' cat-row-expandable' : ''}">
        <div class="cat-dot" style="background:${escapeHtml(c.color || CAT_COLORS_FALLBACK)}"></div>
        <div class="cat-name">${escapeHtml(c.name)}${c.components ? ' <span class="cat-expand-chevron">▸</span>' : ''}</div>
        <div class="cat-bar-wrap"><div class="cat-bar" style="width:${c.pct}%; background:${escapeHtml(c.color || CAT_COLORS_FALLBACK)}"></div></div>
        <div class="cat-pct">${c.pct}%</div>
        <div class="cat-val">${fmt(c.amount)}</div>
      </div>
      ${c.components ? `<div class="cat-breakdown" hidden>${c.components.map((comp) => `
        <div class="cat-breakdown-row">
          <span class="cat-breakdown-name">${escapeHtml(comp.name)}</span>
          <span class="cat-breakdown-val">${fmt(comp.amount)}</span>
        </div>
      `).join('')}</div>` : ''}
    `).join('');

    // Клик по строке со свёрнутой rollup-суммой (например «Сбережения», куда
    // подшита отдельная категория цели) разворачивает разбивку — сколько из
    // показанной суммы сама категория, а сколько каждая подшитая цель. Без
    // этого узнать долю можно было только вручную фильтруя «Операции» по
    // каждой категории по отдельности.
    list.querySelectorAll('.cat-row-expandable').forEach((row) => {
      row.addEventListener('click', () => {
        const breakdown = row.nextElementSibling;
        const chevron = row.querySelector('.cat-expand-chevron');
        const willShow = breakdown.hidden;
        breakdown.hidden = !willShow;
        if (chevron) chevron.textContent = willShow ? '▾' : '▸';
      });
    });
  }

  if (pieChart) pieChart.destroy();
  const ctx = document.getElementById('pieChart');
  if (data.expenseByCategory.length) {
    pieChart = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: data.expenseByCategory.map((c) => c.name),
        datasets: [{
          data: data.expenseByCategory.map((c) => c.amount),
          backgroundColor: data.expenseByCategory.map((c) => c.color || CAT_COLORS_FALLBACK),
          borderWidth: 0,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } } },
      },
    });
  }
}

// «Расходы/Доходы по месяцам» на дашборде всегда показывают текущий календарный
// год (Янв–Дек, без переключения — смотреть другие годы можно на вкладке
// «По годам»), 6 месяцев видно, остальные — скроллом внутри .chart-scroll.
const CURRENT_YEAR = new Date().getFullYear();

function monthShortLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('ru-RU', { month: 'short' });
}

document.querySelectorAll('[data-role="currentYearLabel"]').forEach((el) => { el.textContent = CURRENT_YEAR; });

// Общий рендер «сумма по категориям x месяц» — переиспользуется дашбордом
// (текущий год) и вкладкой «По годам» (выбранный год).
async function renderMonthlyCategoryChart({ endpoint, canvasId, chartSetter, chartGetter }) {
  const data = await api(endpoint);
  const allCatNames = new Set();
  data.forEach((m) => m.cats.forEach((c) => allCatNames.add(c.name)));
  const catMeta = {};
  data.forEach((m) => m.cats.forEach((c) => { catMeta[c.name] = c.color; }));
  const names = Array.from(allCatNames);

  const datasets = names.map((name) => ({
    label: name,
    data: data.map((m) => {
      const found = m.cats.find((c) => c.name === name);
      return found ? found.amount : 0;
    }),
    backgroundColor: catMeta[name] || CAT_COLORS_FALLBACK,
  }));

  const existing = chartGetter();
  if (existing) existing.destroy();
  const canvas = document.getElementById(canvasId);
  const chart = new Chart(canvas, {
    type: 'bar',
    data: { labels: data.map((m) => monthShortLabel(m.month)), datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { x: { stacked: true }, y: { stacked: true } },
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } } },
    },
  });
  chartSetter(chart);
  // По умолчанию прокручиваем к последним заполненным месяцам — они обычно интереснее первых.
  const scrollEl = canvas.closest('.chart-scroll');
  if (scrollEl) scrollEl.scrollLeft = scrollEl.scrollWidth;

  return data;
}

async function loadOverview(type, canvasId, insightsId, wordCapital, wordLower) {
  const data = await renderMonthlyCategoryChart({
    endpoint: `/api/summary/overview?months=12&type=${type}&end=${CURRENT_YEAR}-12`,
    canvasId,
    chartSetter: (c) => { overviewCharts[type] = c; },
    chartGetter: () => overviewCharts[type],
  });
  renderInsights(document.getElementById(insightsId), computeInsights(data, wordCapital, wordLower));
}

function refreshOverviewCharts() {
  loadOverview('expense', 'expenseOverviewChart', 'expense-insights', 'Расходы', 'траты');
  loadOverview('income', 'incomeOverviewChart', 'income-insights', 'Доходы', 'доходы');
}

// ---------- Insights (category increase/decrease recommendations) ----------
function categoryAmountMap(monthEntry) {
  const map = {};
  (monthEntry ? monthEntry.cats : []).forEach((c) => { map[c.name] = c.amount; });
  return map;
}

function catPhrase(names) {
  return names.map((n) => `«${escapeHtml(n)}»`).join(', ');
}

function buildRatioLine(names, ratios, direction, wordCapital, baselineLabel) {
  const word = names.length === 1 ? 'категории' : 'категориях';
  const verb = direction === 'up' ? 'выросли' : 'снизились';
  const withRatios = names.map((n, i) => `«${escapeHtml(n)}» (×${ratios[i].toFixed(1)})`).join(', ');
  return {
    cls: direction,
    text: `${wordCapital} в ${word} ${withRatios} ${verb} более чем в 1,5 раза по сравнению с ${baselineLabel}.`,
  };
}

function buildEdgeLine(names, kind, wordCapital, wordLower, baselineLabel) {
  const word = names.length === 1 ? 'категории' : 'категориях';
  if (kind === 'new') {
    return { cls: 'new', text: `В этом месяце впервые появились ${wordLower} в ${word} ${catPhrase(names)} (сравнение с ${baselineLabel}).` };
  }
  return { cls: 'gone', text: `В этом месяце пропали ${wordLower} в ${word} ${catPhrase(names)}, которые были ${kind === 'gone-prev' ? 'в прошлом месяце' : 'в среднем в последние 3 месяца'} (сравнение с ${baselineLabel}).` };
}

function compareMonths(currMap, baseMap) {
  const names = new Set([...Object.keys(currMap), ...Object.keys(baseMap)]);
  const up = [], upRatios = [], down = [], downRatios = [], created = [], gone = [];
  names.forEach((name) => {
    const curr = currMap[name] || 0;
    const base = baseMap[name] || 0;
    if (base > 0 && curr > 0) {
      const ratio = curr / base;
      if (ratio >= INSIGHT_RATIO) { up.push(name); upRatios.push(ratio); }
      else if (ratio <= 1 / INSIGHT_RATIO) { down.push(name); downRatios.push(base / curr); }
    } else if (base === 0 && curr > 0) {
      created.push(name);
    } else if (base > 0 && curr === 0) {
      gone.push(name);
    }
  });
  return { up, upRatios, down, downRatios, created, gone };
}

function monthTotal(monthEntry) {
  return Object.values(categoryAmountMap(monthEntry)).reduce((s, v) => s + v, 0);
}

function computeInsights(data, wordCapital, wordLower) {
  const lines = [];
  // Если текущий (реальный) месяц ещё пуст — по нему рано делать выводы,
  // берём за «текущий» последний месяц, за который что-то занесено.
  let idxCurr = data.length - 1;
  while (idxCurr > 0 && monthTotal(data[idxCurr]) === 0) idxCurr--;
  if (idxCurr < 1) return { lines, anchorMonth: null };
  const anchorMonth = idxCurr < data.length - 1 ? data[idxCurr].month : null;

  const currMap = categoryAmountMap(data[idxCurr]);

  // Сравнение с прошлым месяцем
  const prevMap = categoryAmountMap(data[idxCurr - 1]);
  const vsPrev = compareMonths(currMap, prevMap);
  if (vsPrev.up.length) lines.push(buildRatioLine(vsPrev.up, vsPrev.upRatios, 'up', wordCapital, 'прошлым месяцем'));
  if (vsPrev.down.length) lines.push(buildRatioLine(vsPrev.down, vsPrev.downRatios, 'down', wordCapital, 'прошлым месяцем'));
  if (vsPrev.created.length) lines.push(buildEdgeLine(vsPrev.created, 'new', wordCapital, wordLower, 'прошлым месяцем'));
  if (vsPrev.gone.length) lines.push(buildEdgeLine(vsPrev.gone, 'gone-prev', wordCapital, wordLower, 'прошлым месяцем'));

  // Сравнение со средним за последние 3 месяца (нужно 3 полных предыдущих месяца)
  if (idxCurr >= 3) {
    const avg3Map = {};
    const names = new Set();
    for (let i = idxCurr - 3; i <= idxCurr - 1; i++) {
      Object.keys(categoryAmountMap(data[i])).forEach((n) => names.add(n));
    }
    names.forEach((name) => {
      const sum = [1, 2, 3].reduce((s, back) => s + (categoryAmountMap(data[idxCurr - back])[name] || 0), 0);
      avg3Map[name] = sum / 3;
    });
    const vsAvg3 = compareMonths(currMap, avg3Map);
    const baseline = 'средним за последние 3 месяца';
    if (vsAvg3.up.length) lines.push(buildRatioLine(vsAvg3.up, vsAvg3.upRatios, 'up', wordCapital, baseline));
    if (vsAvg3.down.length) lines.push(buildRatioLine(vsAvg3.down, vsAvg3.downRatios, 'down', wordCapital, baseline));
    if (vsAvg3.created.length) lines.push(buildEdgeLine(vsAvg3.created, 'new', wordCapital, wordLower, baseline));
    if (vsAvg3.gone.length) lines.push(buildEdgeLine(vsAvg3.gone, 'gone-avg', wordCapital, wordLower, baseline));
  }

  return { lines, anchorMonth };
}

function renderInsights(container, { lines, anchorMonth }) {
  if (!lines.length) {
    container.innerHTML = '';
    return;
  }
  const caption = anchorMonth
    ? `<div class="empty-hint" style="text-align:left; padding:0 0 6px;">Текущий месяц ещё пуст — сравнение за ${monthLabel(anchorMonth)}, последний месяц с записями</div>`
    : '';
  container.innerHTML = `${caption}<div class="insight-list">${
    lines.map((l) => `<div class="insight ${l.cls}">${l.text}</div>`).join('')
  }</div>`;
}

function refreshDashboard() {
  loadDashboardMonth();
  refreshOverviewCharts();
  loadMonthlyLimitsProgress();
  loadReconciliationCard();
  loadLimitNotifications();
  loadBackupNotification();
}

// ---------- Category spending limits ----------
// Переиспользует .cat-row/.cat-bar-wrap/.cat-bar — тот же визуальный язык, что
// «Расходы по категориям» на Дашборде (см. styles.css .cat-bar.exceeded).
function renderLimitRow(row) {
  const color = escapeHtml(row.category_color || CAT_COLORS_FALLBACK);
  return `
    <div class="cat-row">
      <div class="cat-dot" style="background:${color}"></div>
      <div class="cat-name">${escapeHtml(row.category_name)}</div>
      <div class="cat-bar-wrap"><div class="cat-bar${row.exceeded ? ' exceeded' : ''}" style="width:${Math.min(100, row.pct)}%;${row.exceeded ? '' : ` background:${color}`}"></div></div>
      <div class="cat-pct">${Math.min(999, row.pct)}%</div>
      <div class="cat-val limit-val">${fmt(row.spent)} из ${fmt(row.limit)}</div>
    </div>
  `;
}

// Общий бюджет на месяц — не строка в списке категорий (renderLimitRow выше),
// а отдельный, более заметный блок над ним: не привязан к категории, поэтому
// нет ни .cat-dot, ни фиксированной ширины названия под самое длинное имя
// категории. См. .overall-budget-* в styles.css.
function renderOverallBudgetRow(data) {
  return `
    <div class="overall-budget-row">
      <div class="overall-budget-header">
        <span class="overall-budget-label">Общий бюджет на месяц</span>
        <span class="overall-budget-values">${fmt(data.spent)} из ${fmt(data.limit)} (${Math.min(999, data.pct)}%)</span>
      </div>
      <div class="overall-budget-bar-wrap"><div class="overall-budget-bar${data.exceeded ? ' exceeded' : ''}" style="width:${Math.min(100, data.pct)}%;"></div></div>
    </div>
  `;
}

// Следует за выбранным на Дашборде месяцем (см. currentMonth) — как и остальной
// блок «Отчёт за месяц», под которым эта карточка расположена.
async function loadMonthlyLimitsProgress() {
  const [rows, overall] = await Promise.all([
    api(`/api/limits/progress?month=${currentMonth}`),
    api(`/api/limits/overall/progress?month=${currentMonth}`),
  ]);
  const hasOverall = overall.limit !== null;
  document.getElementById('monthlyLimitsCard').hidden = rows.length === 0 && !hasOverall;
  const overallSection = document.getElementById('overallBudgetSection');
  overallSection.hidden = !hasOverall;
  overallSection.innerHTML = hasOverall ? renderOverallBudgetRow(overall) : '';
  document.getElementById('monthlyLimitsList').innerHTML = rows.map(renderLimitRow).join('');
}

function formatDateRu(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

function renderReconciliationRows(data) {
  const netColor = data.since_net >= 0 ? 'var(--color-income)' : 'var(--color-expense)';
  const netSign = data.since_net >= 0 ? '+' : '';
  return `
    <div class="recon-row">
      <div class="rl">Остаток на ${formatDateRu(data.anchor_date)}<small>точка отсчёта, задана в Настройках</small></div>
      <div class="rv">${fmt(data.anchor_amount)}</div>
    </div>
    <div class="recon-row">
      <div class="rl">Операции с ${formatDateRu(data.anchor_date)}</div>
      <div class="rv" style="color:${netColor}">${netSign}${fmt(data.since_net)}</div>
    </div>
    <div class="recon-row total">
      <div class="rl">Ожидаемый остаток</div>
      <div class="rv">${fmt(data.expected)}</div>
    </div>
  `;
}

// Сравнение «Фактически на карте» ничего не сохраняет на бэкенде — это разовая
// сверка в моменте, введённое число нужно только чтобы посчитать и показать
// расхождение прямо сейчас (см. концепт, обсуждённый перед реализацией).
// Кнопка «Обновить точку отсчёта» показывается, как только введено число —
// и на «Сходится», и на расхождении: во втором случае перенос анкора на
// сегодня с введённым фактическим числом «принимает» реальность картой как
// новую базу, не гоняясь за причиной разницы задним числом.
function updateReconciliationMatch(expected) {
  const input = document.getElementById('reconciliationActualInput');
  const pill = document.getElementById('reconciliationMatchPill');
  const rebaseBtn = document.getElementById('reconciliationRebaseBtn');
  const raw = input.value;
  if (raw === '') { pill.innerHTML = ''; rebaseBtn.hidden = true; return; }
  const actual = Number(raw);
  if (Number.isNaN(actual)) { pill.innerHTML = ''; rebaseBtn.hidden = true; return; }
  const diff = actual - expected;
  if (Math.round(Math.abs(diff)) === 0) {
    pill.innerHTML = '<div class="match-pill ok">✓ Сходится</div>';
  } else {
    const sign = diff > 0 ? '+' : '';
    pill.innerHTML = `<div class="match-pill mismatch">Расхождение: ${sign}${fmt(diff)}</div>`;
  }
  rebaseBtn.hidden = false;
}

document.getElementById('reconciliationRebaseBtn').addEventListener('click', async () => {
  const actual = Number(document.getElementById('reconciliationActualInput').value);
  if (!Number.isFinite(actual)) return;
  try {
    await api('/api/reconciliation', {
      method: 'PUT',
      body: JSON.stringify({ anchor_date: todayISO(), anchor_amount: actual }),
    });
    toast('Точка отсчёта обновлена на сегодня');
    document.getElementById('reconciliationActualInput').value = '';
    await refreshDashboard();
  } catch (e) { toast(e.message, true); }
});

// Следует за выбранным на Дашборде месяцем (currentMonth), как и «Лимиты за
// месяц» выше — карточка вообще не рендерится, пока в Настройках не задана
// точка отсчёта (см. routes/reconciliation.js GET /:month → { set: false }).
async function loadReconciliationCard() {
  const data = await api(`/api/reconciliation/${currentMonth}`);
  const card = document.getElementById('reconciliationCard');
  card.hidden = !data.set;
  if (!data.set) return;

  document.getElementById('reconciliationRows').innerHTML = renderReconciliationRows(data);
  // Не очищаем поле «Фактически» здесь — refreshDashboard() вызывается на
  // множество не связанных с этой карточкой событий (любая новая операция,
  // переключение вкладок и т.п.), и стирать то, что пользователь только что
  // сверял, было бы раздражающим регрессом. Явно чистим только там, где это
  // осмысленно — после успешного переноса точки отсчёта, см. кнопку выше.
  const actualInput = document.getElementById('reconciliationActualInput');
  actualInput.oninput = () => updateReconciliationMatch(data.expected);
  updateReconciliationMatch(data.expected);
}

// Следует за годом, выбранным в #yearSingleSelect на вкладке «По годам» — как и
// остальной блок «Операции по месяцам за год», под которым эта карточка расположена.
async function loadYearlyLimitsProgress() {
  const year = document.getElementById('yearSingleSelect').value || String(CURRENT_YEAR);
  const rows = await api(`/api/limits/progress-year?year=${year}`);
  document.getElementById('yearlyLimitsCard').hidden = rows.length === 0;
  document.getElementById('yearlyLimitsYearLabel').textContent = year;
  document.getElementById('yearlyLimitsList').innerHTML = rows.map(renderLimitRow).join('');
}

// Общий бюджет на месяц (верх вкладки «Лимиты», не привязан к категории) —
// значение перечитывается при каждом заходе на вкладку, как и сами категории
// ниже, на случай если поменяли на другой вкладке/устройстве.
async function loadOverallBudgetSetting() {
  const { monthly_limit } = await api('/api/limits/overall');
  document.getElementById('overallBudgetInput').value = monthly_limit ?? '';
}

document.getElementById('overallBudgetSaveBtn').addEventListener('click', async () => {
  const val = document.getElementById('overallBudgetInput').value;
  try {
    await api('/api/limits/overall', {
      method: 'PUT',
      body: JSON.stringify({ monthly_limit: val === '' ? null : Number(val) }),
    });
    toast('Общий бюджет сохранён');
    await loadMonthlyLimitsProgress();
    await loadLimitNotifications();
  } catch (e) { toast(e.message, true); }
});

// Вкладка «Лимиты» — настройка месячного/годового лимита по каждой категории
// расходов. Перерисовывается при каждом заходе на вкладку (см. обработчик кликов
// по .tab-btn ниже), как и «По годам» — категории могли измениться.
async function loadLimitsTab() {
  await loadOverallBudgetSetting();
  const cats = await api('/api/categories?type=expense');
  const container = document.getElementById('limitsCatList');
  container.innerHTML = cats.map((c) => `
    <div class="limit-row" data-id="${c.id}">
      <div class="cat-dot" style="background:${escapeHtml(c.color)}"></div>
      <div class="limit-cat-name">${escapeHtml(c.name)}</div>
      <div class="field">
        <label>Лимит в месяц</label>
        <input type="number" min="0" step="0.01" data-role="monthly" value="${c.monthly_limit ?? ''}" placeholder="не задан">
      </div>
      <div class="field">
        <label>Лимит в год</label>
        <input type="number" min="0" step="0.01" data-role="yearly" value="${c.yearly_limit ?? ''}" placeholder="не задан">
      </div>
      <button class="btn small secondary" data-role="save-limit">Сохранить</button>
    </div>
  `).join('') || '<div class="empty-hint">Нет категорий расходов</div>';

  container.querySelectorAll('.limit-row').forEach((row) => {
    const id = row.dataset.id;
    row.querySelector('[data-role="save-limit"]').addEventListener('click', async () => {
      const monthlyVal = row.querySelector('[data-role="monthly"]').value;
      const yearlyVal = row.querySelector('[data-role="yearly"]').value;
      try {
        await api(`/api/limits/${id}`, {
          method: 'PUT',
          body: JSON.stringify({
            monthly_limit: monthlyVal === '' ? null : Number(monthlyVal),
            yearly_limit: yearlyVal === '' ? null : Number(yearlyVal),
          }),
        });
        toast('Лимиты сохранены');
        await loadMonthlyLimitsProgress();
        await loadYearlyLimitsProgress();
        await loadLimitNotifications();
      } catch (e) { toast(e.message, true); }
    });
  });
}

// ---------- Уведомления о лимитах (справа вверху) ----------
// Всегда про текущий реальный месяц/год (см. routes/limits.js) — не про то, что
// сейчас просматривается на Дашборде/«По годам». Не исчезают сами — только по
// крестику; закрытие помнится на бэкенде до конца периода (месяца/года).
function limitNotificationMessage(n) {
  const verb = n.notification_type === 'exceeded' ? 'превышен' : 'почти исчерпан';
  if (n.overall) {
    return `Общий бюджет на месяц ${verb} (${n.pct}%) — потрачено ${fmt(n.spent)} из ${fmt(n.limit)} в этом месяце.`;
  }
  const periodLabel = n.limit_type === 'month' ? 'в этом месяце' : 'в этом году';
  const limitLabel = n.limit_type === 'month' ? 'Месячный лимит' : 'Годовой лимит';
  return `${limitLabel} категории «${escapeHtml(n.category_name)}» ${verb} (${n.pct}%) — потрачено ${fmt(n.spent)} из ${fmt(n.limit)} ${periodLabel}.`;
}

async function loadLimitNotifications() {
  let notifications;
  try {
    notifications = await api('/api/limits/notifications');
  } catch (e) { return; }

  const container = document.getElementById('limitNotificationsList');
  container.innerHTML = notifications.map((n) => `
    <div class="limit-notification${n.notification_type === 'exceeded' ? ' exceeded' : ''}"
         data-overall="${n.overall ? '1' : ''}" data-category-id="${n.category_id ?? ''}" data-limit-type="${n.limit_type}"
         data-notification-type="${n.notification_type}" data-period="${n.period}">
      <div>${limitNotificationMessage(n)}</div>
      <button type="button" class="limit-notification-close" aria-label="Закрыть">✕</button>
    </div>
  `).join('');

  container.querySelectorAll('.limit-notification').forEach((el) => {
    el.querySelector('.limit-notification-close').addEventListener('click', async () => {
      el.remove();
      try {
        const dismissUrl = el.dataset.overall
          ? '/api/limits/overall/notifications/dismiss'
          : `/api/limits/notifications/${el.dataset.categoryId}/dismiss`;
        await api(dismissUrl, {
          method: 'POST',
          body: JSON.stringify({
            limit_type: el.dataset.limitType,
            notification_type: el.dataset.notificationType,
            period: el.dataset.period,
          }),
        });
      } catch (e) { /* не критично — просто не запомнится, покажется снова при следующей загрузке */ }
    });
  });
}

// ---------- Уведомление о неудачном автобэкапе (справа вверху, тот же блок,
// что лимиты) ---------- см. backup.js/routes/settings.js GET /backups: error
// приходит только пока последняя попытка не удалась И её не закрыли крестиком
// за этот же день — успешный следующий прогон гасит её сам.
async function openBackupsFolder() {
  const isDesktop = typeof window.desktopApp !== 'undefined' && window.desktopApp.isDesktop;
  if (isDesktop) {
    await window.desktopApp.openBackupsFolder();
    return;
  }
  try {
    const { folder } = await api('/api/settings/backups');
    toast(`Папка с бэкапами: ${folder}`, false, 8000);
  } catch (e) { /* не критично */ }
}

async function loadBackupNotification() {
  let status;
  try {
    status = await api('/api/settings/backups');
  } catch (e) { return; }

  const container = document.getElementById('backupNotificationSlot');
  if (!status.error) { container.innerHTML = ''; return; }

  container.innerHTML = `
    <div class="limit-notification backup-notification">
      <div>
        <b>Резервную копию сохранить не удалось</b>
        Похоже, на диске не хватает места. Посмотрите бэкапы — можно удалить старые вручную — или освободите место любым другим способом. При следующем запуске приложение попробует снова.
        <div class="limit-notification-actions">
          <button type="button" class="btn small secondary" id="backupNotificationOpenBtn">Посмотреть бэкапы</button>
        </div>
      </div>
      <button type="button" class="limit-notification-close" aria-label="Закрыть">✕</button>
    </div>
  `;

  container.querySelector('#backupNotificationOpenBtn').addEventListener('click', openBackupsFolder);
  container.querySelector('.limit-notification-close').addEventListener('click', async () => {
    container.innerHTML = '';
    try { await api('/api/settings/backups/dismiss-error', { method: 'POST' }); } catch (e) { /* не критично */ }
  });
}

// Кнопка/путь в Настройках — десктоп открывает Finder/Проводник напрямую,
// веб не может (браузер не даёт доступа к системному файловому менеджеру) —
// там вместо кнопки показываем путь текстом.
async function initBackupsSetting() {
  const isDesktop = typeof window.desktopApp !== 'undefined' && window.desktopApp.isDesktop;
  const btn = document.getElementById('openBackupsFolderBtn');
  if (isDesktop) {
    btn.addEventListener('click', openBackupsFolder);
    return;
  }
  btn.style.display = 'none';
  try {
    const { folder } = await api('/api/settings/backups');
    const desc = document.getElementById('backupsPathDesc');
    desc.textContent = `Папка: ${folder}`;
    desc.style.display = 'block';
  } catch (e) { /* не критично */ }
}

// ---------- Export ----------
document.getElementById('exportBtn').addEventListener('click', () => {
  window.location.href = '/api/export';
});

// Настройки → «Экспорт за период» — та же кнопка «Экспорт в Excel» в шапке
// намеренно не трогается (осталась «выгрузить всё» в один клик, как раньше);
// это отдельная, менее заметная опция специально для случаев вроде
// бухгалтерии за конкретный год, чтобы не загромождать основной путь.
document.getElementById('periodExportBtn').addEventListener('click', () => {
  const from = document.getElementById('periodExportFromInput').value;
  const to = document.getElementById('periodExportToInput').value;
  if (!from || !to) { toast('Укажите обе даты — «с» и «по»', true); return; }
  if (from > to) { toast('Дата «с» должна быть раньше даты «по»', true); return; }
  window.location.href = `/api/export?from=${from}&to=${to}`;
});

// ---------- Import ----------
document.getElementById('importBtn').addEventListener('click', () => {
  document.getElementById('importFile').click();
});
document.getElementById('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const formData = new FormData();
  formData.append('file', file);
  // Блокируем кнопку на время запроса — без этого быстрый повторный клик по
  // «Импорт из Excel» (второй выбор файла, пока первый импорт ещё в процессе)
  // мог отправить два параллельных POST /api/import.
  const importBtn = document.getElementById('importBtn');
  importBtn.disabled = true;
  toast(`Загружаю ${file.name}…`);
  try {
    const res = await fetch('/api/import', { method: 'POST', body: formData });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Ошибка импорта');
    const parts = [`Добавлено операций: ${body.imported}`];
    if (body.updated) parts.push(`обновлено: ${body.updated}`);
    if (body.skippedDuplicates) parts.push(`пропущено дублей: ${body.skippedDuplicates}`);
    if (body.newCategories.length) parts.push(`новые категории: ${body.newCategories.join(', ')}`);
    toast(parts.join(' · '), false, 6000);
    await loadCategories();
    await loadTransactionsTable();
    await refreshDashboard();
  } catch (err) {
    toast(err.message, true);
  } finally {
    importBtn.disabled = false;
  }
});

// ---------- Goals ----------
let goalCatMode = 'existing';

function renderGoalCategoryOptions() {
  // Категории, которые сами уже свёрнуты в другую (rollup_id задан), не предлагаем
  // в качестве цели второго уровня — это была бы путаница вложенности.
  const expenseCats = categories.filter((c) => c.type === 'expense' && !c.rollup_id);
  const options = expenseCats.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  const existingSelect = document.getElementById('goalExistingCategory');
  const rollupSelect = document.getElementById('goalRollupCategory');
  existingSelect.innerHTML = options;
  rollupSelect.innerHTML = options;
  const savings = expenseCats.find((c) => c.name === 'Сбережения');
  if (savings) rollupSelect.value = savings.id;
}

document.getElementById('goalCatModeToggle').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-mode]');
  if (!btn) return;
  goalCatMode = btn.dataset.mode;
  document.querySelectorAll('#goalCatModeToggle button').forEach((b) => b.classList.toggle('active', b === btn));
  document.getElementById('goalExistingCatRow').style.display = goalCatMode === 'existing' ? 'flex' : 'none';
  document.getElementById('goalNewCatRow').style.display = goalCatMode === 'new' ? 'flex' : 'none';
});

document.getElementById('goalForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('goalName').value.trim();
  const target_amount = Number(document.getElementById('goalAmount').value);
  const monthsVal = document.getElementById('goalMonths').value;
  const payload = {
    name,
    target_amount,
    duration_months: monthsVal ? Number(monthsVal) : null,
  };

  if (goalCatMode === 'existing') {
    payload.category_id = Number(document.getElementById('goalExistingCategory').value);
  } else {
    const newName = document.getElementById('goalNewCatName').value.trim();
    if (!newName) { toast('Укажите название новой категории', true); return; }
    payload.new_category = {
      name: newName,
      color: document.getElementById('goalNewCatColor').value,
      rollup_id: Number(document.getElementById('goalRollupCategory').value) || null,
    };
  }

  try {
    await api('/api/goals', { method: 'POST', body: JSON.stringify(payload) });
    toast('Цель создана');
    document.getElementById('goalForm').reset();
    document.getElementById('goalExistingCatRow').style.display = 'flex';
    document.getElementById('goalNewCatRow').style.display = 'none';
    document.querySelectorAll('#goalCatModeToggle button').forEach((b) => b.classList.toggle('active', b.dataset.mode === 'existing'));
    goalCatMode = 'existing';
    await loadCategories();
    await loadGoals();
  } catch (err) { toast(err.message, true); }
});

function ringSVG(pct, color) {
  const r = 36;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - Math.max(0, Math.min(100, pct)) / 100);
  // Трек-круг красится через CSS-класс (.ring-track { stroke: var(--color-border-subtle) }),
  // не через фиксированный атрибут stroke — иначе не отвечает на смену темы
  // (CSS stroke на элементе переопределяет SVG-атрибут).
  return `<svg viewBox="0 0 84 84">
    <circle class="ring-track" cx="42" cy="42" r="${r}" fill="none" stroke-width="8"/>
    <circle cx="42" cy="42" r="${r}" fill="none" stroke="${escapeHtml(color)}" stroke-width="8" stroke-linecap="round"
      stroke-dasharray="${c}" stroke-dashoffset="${offset}"/>
  </svg>`;
}

function renderGoalCard(g) {
  const color = g.category_color || '#1D9E75';
  let monthlyHtml = '';
  if (g.duration_months) {
    if (g.completed) {
      monthlyHtml = '<div class="goal-monthly">Цель достигнута 🎉</div>';
    } else if (g.overdue) {
      monthlyHtml = `<div class="goal-monthly overdue">Срок (до ${g.deadline}) истёк — осталось внести ${fmt(g.remaining)}</div>`;
    } else {
      monthlyHtml = `<div class="goal-monthly">Чтобы уложиться к ${g.deadline}, откладывайте ≈ ${fmt(g.monthlyNeeded)} в месяц</div>`;
    }
  }
  return `
    <div class="goal-card ${g.completed ? 'completed' : ''}" data-id="${g.id}">
      <div class="goal-ring-wrap">${ringSVG(g.pct, color)}<div class="goal-ring-pct">${g.pct}%</div></div>
      <div class="goal-info">
        <h3>${escapeHtml(g.name)}</h3>
        <div class="goal-meta">${fmt(g.progress)} из ${fmt(g.target_amount)} · категория «${escapeHtml(g.category_name)}»</div>
        ${monthlyHtml}
      </div>
      <div class="goal-actions-col">
        <form class="goal-contribute-form" data-id="${g.id}">
          <input type="number" min="0" step="0.01" placeholder="Сумма" required>
          <button type="submit" class="btn small">Внести</button>
        </form>
        <button type="button" class="goal-icon-btn" data-role="delete-goal" data-id="${g.id}">Удалить цель</button>
      </div>
    </div>
  `;
}

async function loadGoals() {
  const goals = await api('/api/goals');
  const container = document.getElementById('goalsList');
  if (!goals.length) {
    container.innerHTML = '<div class="empty-hint">Пока нет целей — создайте первую выше</div>';
    return;
  }
  container.innerHTML = goals.map(renderGoalCard).join('');

  container.querySelectorAll('.goal-contribute-form').forEach((form) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = form.querySelector('input');
      const amount = Number(input.value);
      if (!amount) return;
      try {
        await api(`/api/goals/${form.dataset.id}/contribute`, { method: 'POST', body: JSON.stringify({ amount }) });
        toast('Взнос добавлен');
        await loadGoals();
        await loadTransactionsTable();
        await refreshDashboard();
      } catch (err) { toast(err.message, true); }
    });
  });

  container.querySelectorAll('[data-role="delete-goal"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Удалить цель? Уже внесённые деньги останутся в категории как есть.')) return;
      await api(`/api/goals/${btn.dataset.id}`, { method: 'DELETE' });
      toast('Цель удалена');
      await loadGoals();
    });
  });
}

// ---------- Years tab ----------
const YEAR_PALETTE = ['#1a1a18', '#378ADD', '#D85A30', '#1D9E75', '#7F77DD', '#EF9F27', '#D4537E', '#639922', '#0F6E56', '#993556'];
const MONTH_SHORT_NAMES = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];
let allYears = [];

// Один выбранный год — тот же виджет (12 месяцев, скролл), что на дашборде,
// только год выбирается из выпадающего списка, а не всегда текущий.
let yearSingleType = 'expense';
let yearSingleChart = null;

document.getElementById('yearSingleTypeToggle').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-type]');
  if (!btn) return;
  yearSingleType = btn.dataset.type;
  document.querySelectorAll('#yearSingleTypeToggle button').forEach((b) => b.classList.toggle('active', b === btn));
  loadYearSingleChart();
});
document.getElementById('yearSingleSelect').addEventListener('change', () => {
  loadYearSingleChart();
  loadYearlyLimitsProgress();
});

function populateYearSingleSelect() {
  const select = document.getElementById('yearSingleSelect');
  select.innerHTML = allYears.map((y) => `<option value="${y}">${y}</option>`).join('');
  select.value = allYears.includes(String(CURRENT_YEAR)) ? String(CURRENT_YEAR) : allYears[allYears.length - 1];
}

async function loadYearSingleChart() {
  const year = document.getElementById('yearSingleSelect').value;
  await renderMonthlyCategoryChart({
    endpoint: `/api/summary/overview?months=12&type=${yearSingleType}&end=${year}-12`,
    canvasId: 'yearSingleChart',
    chartSetter: (c) => { yearSingleChart = c; },
    chartGetter: () => yearSingleChart,
  });
}

// Сравнение годов между собой — выбираются чипами (можно любое подмножество,
// например только 2022 и 2025), каждый выбранный год — своя линия на графике.
let yearsCompareType = 'expense';
let yearsCompareChart = null;
let selectedCompareYears = new Set();

document.getElementById('yearsCompareTypeToggle').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-type]');
  if (!btn) return;
  yearsCompareType = btn.dataset.type;
  document.querySelectorAll('#yearsCompareTypeToggle button').forEach((b) => b.classList.toggle('active', b === btn));
  loadYearsCompareChart();
});

function initYearsCompareChips() {
  const container = document.getElementById('yearsCompareChips');
  if (selectedCompareYears.size === 0) {
    // По умолчанию — два последних года: самое частое сравнение («этот год» vs «прошлый»).
    selectedCompareYears = new Set(allYears.slice(-2));
  }
  container.innerHTML = allYears.map((y) => `
    <label class="year-chip">
      <input type="checkbox" value="${y}" ${selectedCompareYears.has(y) ? 'checked' : ''}>
      <span>${y}</span>
    </label>
  `).join('');
  container.querySelectorAll('input[type=checkbox]').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.checked) selectedCompareYears.add(cb.value);
      else selectedCompareYears.delete(cb.value);
      loadYearsCompareChart();
    });
  });
}

async function loadYearsCompareChart() {
  const data = await api(`/api/summary/yearly?type=${yearsCompareType}`);
  const filtered = data.filter((y) => selectedCompareYears.has(y.year));
  const palette = yearPalette();
  const datasets = filtered.map((y, i) => {
    const color = palette[i % palette.length];
    return { label: y.year, data: y.monthly, borderColor: color, backgroundColor: color, fill: false, tension: 0.25, pointRadius: 3 };
  });

  if (yearsCompareChart) yearsCompareChart.destroy();
  yearsCompareChart = new Chart(document.getElementById('yearsCompareChart'), {
    type: 'line',
    data: { labels: MONTH_SHORT_NAMES, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } } },
      scales: { y: { beginAtZero: true } },
    },
  });
}

async function loadYearsTotals() {
  const rows = await api('/api/summary/yearly-totals');
  document.getElementById('yearsTotalsBody').innerHTML = rows.map((r) => `
    <tr>
      <td>${r.year}</td>
      <td class="amount-income">${fmt(r.income)}</td>
      <td class="amount-expense">${fmt(r.expense)}</td>
      <td>${fmt(r.balance)}</td>
    </tr>
  `).join('') || '<tr><td colspan="4" class="empty-hint">Нет данных</td></tr>';
}

async function loadYearsTab() {
  allYears = await api('/api/summary/years');
  populateYearSingleSelect();
  initYearsCompareChips();
  await Promise.all([loadYearSingleChart(), loadYearsCompareChart(), loadYearsTotals(), loadYearlyLimitsProgress()]);
}

// ---------- Settings ----------
document.getElementById('deleteAllDataBtn').addEventListener('click', () => {
  showConfirmModal({
    title: 'Удалить все данные?',
    text: 'Это необратимо удалит все операции, категории и цели за всё время. Категории вернутся к списку по умолчанию. Если нужна копия — сначала сделайте «Экспорт в Excel».',
    confirmLabel: 'Удалить всё',
    onConfirm: async () => {
      try {
        await api('/api/settings/all-data', { method: 'DELETE' });
        toast('Все данные удалены');
        await loadCategories();
        await loadTransactionsTable();
        await refreshDashboard();
        await loadGoals();
      } catch (e) { toast(e.message, true); }
    },
  });
});

// Touch ID (Mac)/пароль учётной записи (Mac или Windows) — доступно только в
// desktop-приложении (см. desktop/src/preload.js). В обычном браузере
// window.desktopApp не определён — нет доступа к системной авторизации.
async function initAppLockSetting() {
  const toggle = document.getElementById('appLockToggle');
  const row = toggle.closest('.settings-row');
  const desc = document.getElementById('appLockDesc');
  const isDesktop = typeof window.desktopApp !== 'undefined' && window.desktopApp.isDesktop;

  if (!isDesktop) {
    toggle.disabled = true;
    row.classList.add('disabled');
    desc.textContent = 'Доступно только в desktop-приложении (Mac или Windows) — у веб-версии нет доступа к системной авторизации.';
    return;
  }

  toggle.checked = await window.desktopApp.getAppLockEnabled();

  toggle.addEventListener('change', async () => {
    const wantEnabled = toggle.checked;
    if (!wantEnabled) {
      const confirmed = await window.desktopApp.confirmIdentity('Подтвердите личность, чтобы отключить защиту паролем');
      if (!confirmed) {
        toggle.checked = true;
        toast('Не удалось подтвердить личность — защита осталась включена', true);
        return;
      }
    }
    const ok = await window.desktopApp.setAppLockEnabled(wantEnabled);
    if (!ok) {
      toggle.checked = !wantEnabled;
      toast('Не удалось сохранить настройку', true);
      return;
    }
    toast(wantEnabled ? 'Защита включена — применится при следующем запуске приложения' : 'Защита выключена');
  });
}

// Валюта отображения — только формат (см. fmt()/CURRENCIES), должна быть загружена
// ДО первого рендера сумм (loadTransactionsTable/refreshDashboard/loadGoals в init()
// ниже), иначе первая отрисовка мелькнёт с ₽ по умолчанию и тут же перерисуется.
async function initCurrencySetting() {
  const select = document.getElementById('currencySelect');
  try {
    currentCurrency = (await api('/api/settings/currency')).currency;
  } catch (e) { /* остаёмся на RUB по умолчанию */ }
  select.value = currentCurrency;

  select.addEventListener('change', async () => {
    const next = select.value;
    try {
      await api('/api/settings/currency', { method: 'PUT', body: JSON.stringify({ currency: next }) });
      currentCurrency = next;
      await loadTransactionsTable();
      await refreshDashboard();
      await loadGoals();
      if (document.querySelector('.tab-btn[data-tab="years"]').classList.contains('active')) await loadYearsTab();
      if (document.querySelector('.tab-btn[data-tab="limits"]').classList.contains('active')) await loadLimitsTab();
      toast('Валюта изменена');
    } catch (e) {
      select.value = currentCurrency;
      toast(e.message, true);
    }
  });
}

// Настройки → «Сверка с картой» — точка отсчёта для карточки на Дашборде
// (public/index.html #reconciliationCard). Оба поля читаются/пишутся вместе:
// раздел на Дашборде показывается только когда задано и то, и другое (см.
// routes/reconciliation.js).
async function initReconciliationSetting() {
  const dateInput = document.getElementById('reconciliationDateInput');
  const amountInput = document.getElementById('reconciliationAmountInput');

  const anchor = await api('/api/reconciliation');
  dateInput.value = anchor.anchor_date || '';
  amountInput.value = anchor.anchor_amount ?? '';

  document.getElementById('reconciliationSaveBtn').addEventListener('click', async () => {
    if (!dateInput.value || amountInput.value === '') {
      toast('Укажите и дату, и сумму', true);
      return;
    }
    try {
      await api('/api/reconciliation', {
        method: 'PUT',
        body: JSON.stringify({ anchor_date: dateInput.value, anchor_amount: Number(amountInput.value) }),
      });
      toast('Точка отсчёта сохранена');
      await refreshDashboard();
    } catch (e) { toast(e.message, true); }
  });

  document.getElementById('reconciliationClearBtn').addEventListener('click', async () => {
    await api('/api/reconciliation', { method: 'DELETE' });
    dateInput.value = '';
    amountInput.value = '';
    toast('Точка отсчёта сброшена');
    await refreshDashboard();
  });
}

// Версия приложения — в desktop-версии через Electron (app.getVersion(), точная версия
// собранного бандла), в веб-версии — с бэкенда (version из корневого package.json).
async function initAppVersion() {
  const textEl = document.getElementById('appVersionText');
  const isDesktop = typeof window.desktopApp !== 'undefined' && window.desktopApp.isDesktop;
  let version;
  try {
    version = isDesktop ? await window.desktopApp.getAppVersion() : (await api('/api/settings/version')).version;
  } catch (e) {
    textEl.textContent = 'Версия неизвестна';
    return;
  }
  textEl.textContent = `Версия ${version}`;
  textEl.dataset.version = version;

  document.getElementById('copyVersionBtn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(version);
      toast('Скопировано');
    } catch (e) {
      toast('Не удалось скопировать', true);
    }
  });
}

// Ручная проверка обновлений — доступно только в desktop-версии (см. desktop/src/main.js
// triggerUpdateCheck): скачать/установить предлагают нативные диалоги самого приложения,
// эта кнопка их просто запускает — в т.ч. если раньше нажали «Позже»/«Не сейчас».
function initUpdateCheckSetting() {
  const btn = document.getElementById('checkUpdatesBtn');
  const row = btn.closest('.settings-row');
  const desc = document.getElementById('updateCheckDesc');
  const isDesktop = typeof window.desktopApp !== 'undefined' && window.desktopApp.isDesktop;

  if (!isDesktop) {
    btn.disabled = true;
    row.classList.add('disabled');
    desc.textContent = 'Доступно только в desktop-приложении (Mac или Windows) — у веб-версии нет отдельных обновлений, она всегда работает из актуального кода.';
    return;
  }

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const originalLabel = btn.textContent;
    btn.textContent = 'Проверяю…';
    try {
      await window.desktopApp.checkForUpdates();
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  });
}

// ---------- Onboarding tour ----------
// Флаг «уже показывали» хранится на бэкенде (не в localStorage — у desktop-версии
// порт бэкенда случайный на каждый запуск, а localStorage привязан к origin
// http://127.0.0.1:<порт>, так что localStorage-флаг никогда бы не находился заново).
async function hasSeenOnboarding() {
  try { return (await api('/api/settings/onboarding-seen')).seen; } catch (e) { return true; }
}
async function markOnboardingSeen() {
  try { await api('/api/settings/onboarding-seen', { method: 'PUT' }); } catch (e) { /* не критично */ }
}

// Шаги сгруппированы по вкладкам (поле tab переключает её перед показом шага) —
// см. также CLAUDE.md: при изменении функциональности/вкладок этот список нужно
// перепроверять и поправлять вместе с кодом.
const TOUR_STEPS = [
  // ---------- Дашборд ----------
  {
    tab: 'dashboard',
    selector: '#dashboardMonthCard',
    title: 'Дашборд — отчёт за месяц',
    text: 'Здесь сводка по операциям за выбранный месяц: доход, расход, баланс и разбивка расходов по категориям. Месяц переключается стрелками или списком справа. Строку со стрелочкой ▸ (сумма, в которую подшита категория цели) можно раскрыть кликом — увидите, сколько из неё сама категория, а сколько каждая подшитая цель.',
  },
  {
    tab: 'dashboard',
    selector: '#structureCol',
    title: 'Структура расходов',
    text: 'Категории на диаграмме можно скрывать — нажмите на категорию в подписях под ней, чтобы временно убрать её и посмотреть на картину без неё. Нажмите ещё раз, чтобы вернуть.',
  },
  {
    tab: 'dashboard',
    selector: '#expenseChartCard',
    title: 'Дашборд — расходы по месяцам',
    text: 'Текущий год целиком: видно 6 месяцев, остальные — прокруткой внутри графика. Ниже — автоматические заметки о заметных изменениях по категориям.',
  },
  {
    selector: '#importBtn',
    title: 'Импорт из Excel',
    text: 'Загружает операции из .xlsx — в том числе из файла, который приложение само экспортировало ранее. Повторный импорт безопасен: точные дубли не добавляются.',
  },
  {
    selector: '#exportBtn',
    title: 'Экспорт в Excel',
    text: 'Скачивает все операции и сводку по месяцам одним файлом — удобно для бэкапа или переноса на другое устройство через «Импорт».',
  },
  // ---------- Операции ----------
  {
    tab: 'transactions',
    selector: '#txForm',
    title: 'Операции — новая запись',
    text: 'Здесь можно добавить операцию: тип, дата, категория, сумма и необязательная заметка. Появится сразу в списке ниже.',
  },
  {
    tab: 'transactions',
    selector: '#txExcludedField',
    title: 'Наличные, мимо общей суммы',
    text: 'Отметьте «Нал.» для дохода наличными (или расхода), который не должен раздувать официальные цифры — например, деньги мимо основного счёта. Такая операция получит пометку «нал.», не войдёт в общий доход/расход за месяц и год, в Баланс и в Excel-сводку — но будет учитываться в разбивке по категориям, на графиках и на вкладке «По годам», как обычная. Подробности — под значком ⓘ рядом.',
  },
  {
    tab: 'transactions',
    selector: '#txRecurringField',
    title: 'Повторяющиеся операции',
    text: 'Отметьте «Повтор.» для зарплаты, аренды, подписок — того, что вносится каждый месяц. Когда откроете новый месяц, где такой операции ещё нет, над списком появится подсказка добавить её снова (сумму можно поправить) или пропустить на этот месяц. Для платежей с неизменной суммой можно вдобавок отметить «Не спрашивая» — тогда операция будет добавляться сама, без подсказки. Отключить повтор — кнопкой ✎ у последней такой операции в списке ниже.',
  },
  {
    tab: 'transactions',
    selector: '#txListCard',
    title: 'Операции — список, изменение и удаление',
    text: 'Кнопка ✎ открывает редактирование прямо в строке — можно поменять дату, тип, категорию, сумму и заметку, все графики пересчитаются. Кнопка ✕ удаляет операцию; удалённую по ошибке можно вернуть кнопкой «Отменить» во всплывающем уведомлении, сочетанием Cmd/Ctrl+Z или позже из Корзины внизу вкладки. Сверху — фильтры по типу, категории и месяцу (можно выбрать «Все время», например, чтобы увидеть все операции категории целиком), а поиск по заметке или сумме сразу ищет по всей истории, независимо от выбранного месяца.',
  },
  {
    tab: 'transactions',
    selector: '#trashCard',
    title: 'Корзина',
    text: 'Здесь хранятся последние 10 удалённых операций — восстановить можно любую из них, в любой момент, а не только самую последнюю. Более старые операции в корзине не хранятся — их можно найти в автоматическом бэкапе (кнопка в Настройках).',
  },
  // ---------- Категории ----------
  {
    tab: 'categories',
    selector: '#tab-categories',
    title: 'Категории',
    text: 'Здесь можно переименовать категорию, сменить цвет или удалить её — при удалении уже занесённые операции можно перенести на другую категорию.',
  },
  // ---------- Лимиты ----------
  {
    tab: 'limits',
    selector: '#tab-limits',
    title: 'Лимиты и общий бюджет',
    text: 'Сверху — общий бюджет на месяц (сумма вообще всех расходов, не одной категории); ниже — можно задать лимит трат по конкретной категории, на месяц, на год или сразу оба. Прогресс появится на Дашборде (месячные лимиты) и на вкладке «По годам» (годовые), а при приближении к лимиту или его превышении — уведомление в правом верхнем углу.',
  },
  // ---------- Цели ----------
  {
    tab: 'goals',
    selector: '#goalForm',
    title: 'Цели накопления',
    text: 'Здесь можно завести цель: сумма и необязательный срок — приложение само посчитает, сколько откладывать в месяц. Можно привязать её к отдельной категории, которая на Дашборде и в Excel будет учитываться как часть другой (например, «Сбережения»).',
  },
  // ---------- По годам ----------
  {
    tab: 'years',
    selector: '#yearSingleCard',
    title: 'По годам — операции за год',
    text: 'Тот же скроллящийся график, что на Дашборде, но здесь можно выбрать любой год из списка, а не только текущий.',
  },
  {
    tab: 'years',
    selector: '#yearsCompareChips',
    title: 'По годам — сравнение',
    text: 'Отметьте любые годы — например, этот и позапрошлый, — чтобы сравнить их месяц к месяцу на одном графике.',
  },
  // ---------- Настройки ----------
  {
    tab: 'settings',
    selector: '#tab-settings',
    title: 'Настройки',
    text: 'Здесь — валюта отображения (меняет только символ, без пересчёта старых операций), точка отсчёта для сверки с картой (дата и сумма, от которой считается накопительный остаток — после заполнения на Дашборде появится карточка сравнения с тем, что реально на карте), экспорт в Excel только за выбранный период (например, для бухгалтерии за год — кнопка «Экспорт в Excel» в шапке по-прежнему выгружает всё), автоматические резервные копии раз в день (последние 7, восстановить — через «Импорт из Excel»), защита приложения паролем/Touch ID, ручная проверка обновлений (последние две — в desktop-версии) и полная очистка данных, с подтверждением, что это необратимо.',
  },
  {
    selector: '#helpBtn',
    title: 'Обзор всегда под рукой',
    text: 'Нажмите этот значок в любой момент, чтобы посмотреть обзор снова.',
  },
];

let tourStepIndex = 0;

function positionTourUI(target) {
  const rect = target.getBoundingClientRect();
  const pad = 6;
  const spotlight = document.getElementById('tourSpotlight');
  spotlight.style.top = `${rect.top - pad}px`;
  spotlight.style.left = `${rect.left - pad}px`;
  spotlight.style.width = `${rect.width + pad * 2}px`;
  spotlight.style.height = `${rect.height + pad * 2}px`;

  const card = document.getElementById('tourCard');
  const cardWidth = 300;
  const margin = 14;
  // Реальная высота карточки, а не догадка — текст шагов разной длины
  // (например, у шага про удаление операций текста заметно больше), и с
  // фиксированной оценкой карточка могла вылезать за нижний край окна.
  const cardHeight = card.offsetHeight || 200;

  let top = rect.bottom + pad + margin;
  if (top + cardHeight + margin > window.innerHeight) {
    top = rect.top - pad - margin - cardHeight;
  }
  // На случай, если карточка не помещается ни снизу, ни сверху от цели (маленькое
  // окно/длинный текст) — прижимаем её к границам видимой области, а не даём вылезти.
  top = Math.min(Math.max(top, margin), Math.max(margin, window.innerHeight - cardHeight - margin));

  let left = rect.left;
  if (left + cardWidth + margin > window.innerWidth) left = window.innerWidth - cardWidth - margin;
  if (left < margin) left = margin;
  card.style.top = `${top}px`;
  card.style.left = `${left}px`;
}

// Переход между шагами асинхронный (переключение таба + скролл) — если разрешить
// запускать следующий переход до того, как отрисуется предыдущий, они наложатся
// друг на друга и подпись может отстать от реального шага. Проще всего — не
// пытаться распутывать гонку постфактум, а просто игнорировать клики по «Далее»/
// «Назад», пока предыдущий переход ещё не завершился (см. обработчики кнопок ниже).
let tourBusy = false;

async function goToTourStep(index) {
  if (index < 0 || tourBusy) return;
  if (index >= TOUR_STEPS.length) return endTour();
  tourBusy = true;
  try {
    tourStepIndex = index;
    const step = TOUR_STEPS[index];

    if (step.tab) {
      const tabBtn = document.querySelector(`.tab-btn[data-tab="${step.tab}"]`);
      if (tabBtn && !tabBtn.classList.contains('active')) {
        tabBtn.click();
        await new Promise((r) => setTimeout(r, 150));
      }
    }

    const target = document.querySelector(step.selector);
    if (!target) { tourBusy = false; return goToTourStep(index + 1); }

    target.scrollIntoView({ block: 'center' });
    await new Promise((r) => setTimeout(r, 80));

    document.getElementById('tourTitle').textContent = step.title;
    document.getElementById('tourText').textContent = step.text;
    document.getElementById('tourStepCount').textContent = `${index + 1} из ${TOUR_STEPS.length}`;
    document.getElementById('tourPrevBtn').disabled = index === 0;
    document.getElementById('tourNextBtn').textContent = index === TOUR_STEPS.length - 1 ? 'Готово' : 'Далее';

    // positionTourUI меряет реальную высоту карточки (card.offsetHeight), чтобы не дать
    // ей вылезти за нижний край окна на шагах с длинным текстом. Сразу после смены
    // textContent высота ещё может быть не той, что после реального прохода layout —
    // ждём кадр отрисовки и только потом меряем и позиционируем.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    positionTourUI(target);
    // Подстраховка: если что-то (например, отрисовка графика) сдвинет разметку
    // сразу после скролла, поправим позицию ещё раз на следующих кадрах.
    requestAnimationFrame(() => requestAnimationFrame(() => positionTourUI(target)));
  } finally {
    tourBusy = false;
  }
}

function startTour() {
  tourStepIndex = 0;
  document.getElementById('tourOverlay').hidden = false;
  window.addEventListener('resize', repositionCurrentTourStep);
  // scrollIntoView не гарантирует, что скролл не сдвинется ещё раз сам (например,
  // из-за отрисовки графиков сразу после) — держим подсветку приклеенной к цели
  // на любой скролл, а не только на явный ресайз окна.
  window.addEventListener('scroll', repositionCurrentTourStep, { passive: true, capture: true });
  goToTourStep(0);
}

function repositionCurrentTourStep() {
  const step = TOUR_STEPS[tourStepIndex];
  if (!step) return;
  const target = document.querySelector(step.selector);
  if (target) positionTourUI(target);
}

function endTour() {
  document.getElementById('tourOverlay').hidden = true;
  window.removeEventListener('resize', repositionCurrentTourStep);
  window.removeEventListener('scroll', repositionCurrentTourStep, { capture: true });
  markOnboardingSeen();
}

document.getElementById('helpBtn').addEventListener('click', startTour);
document.getElementById('tourNextBtn').addEventListener('click', () => goToTourStep(tourStepIndex + 1));
document.getElementById('tourPrevBtn').addEventListener('click', () => goToTourStep(tourStepIndex - 1));
document.getElementById('tourSkipBtn').addEventListener('click', endTour);
document.getElementById('tourOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'tourOverlay') endTour();
});
document.addEventListener('keydown', (e) => {
  if (document.getElementById('tourOverlay').hidden) return;
  if (e.key === 'Escape') endTour();
  else if (e.key === 'ArrowRight' || e.key === 'Enter') goToTourStep(tourStepIndex + 1);
  else if (e.key === 'ArrowLeft') goToTourStep(tourStepIndex - 1);
});

// ---------- Init ----------
(async function init() {
  applyChartDefaults(); // до первого refreshDashboard() ниже — Chart.js читает Chart.defaults в момент создания графика
  document.getElementById('txDate').valueAsDate = new Date();
  populateMonthSelectors();
  await loadCategories();
  await initCurrencySetting();
  await loadTransactionsTable();
  await refreshDashboard();
  await refreshTrashCard();
  await loadGoals();
  await initAppLockSetting();
  await initAppVersion();
  initUpdateCheckSetting();
  await initThemeSetting();
  await initBackupsSetting();
  await initReconciliationSetting();

  if (!(await hasSeenOnboarding())) {
    setTimeout(startTour, 400);
  }
})();
