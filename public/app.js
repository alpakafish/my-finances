const CAT_COLORS_FALLBACK = '#888780';

let categories = [];
let currentMonth = monthKey(new Date());
let pieChart = null;
let txType = 'expense';
let txFilterType = 'all';
const overviewCharts = { expense: null, income: null };
const INSIGHT_RATIO = 1.5;

function monthKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
}
function fmt(n) {
  return Math.round(n).toLocaleString('ru-RU') + ' ₽';
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
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

function toast(message, isError = false, duration = 2500, action = null) {
  const el = document.getElementById('toast');
  const undoBtn = document.getElementById('toastUndoBtn');
  document.getElementById('toastMsg').textContent = message;
  el.className = 'toast show' + (isError ? ' error' : '');
  undoBtn.hidden = !action;
  undoBtn.onclick = action ? () => { action(); el.className = 'toast'; clearTimeout(toast._t); } : null;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.className = 'toast'; }, action ? Math.max(duration, 8000) : duration);
}

// ---------- Undo (пока доступна только отмена удаления операции) ----------
// Живёт до следующего изменения данных — не по таймеру: если тост уже скрылся,
// Cmd/Ctrl+Z всё ещё восстановит операцию, пока ничего другого не поменялось.
let pendingUndo = null;
function invalidateUndo() { pendingUndo = null; }

async function undoLastDelete() {
  if (!pendingUndo) return;
  const restore = pendingUndo;
  pendingUndo = null;
  try {
    await api('/api/transactions', { method: 'POST', body: JSON.stringify(restore) });
    toast('Удаление отменено');
    await loadTransactionsTable();
    refreshDashboard();
  } catch (e) { toast(e.message, true); }
}

document.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.key.toLowerCase() !== 'z') return;
  const t = e.target;
  const isEditable = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  if (isEditable || !pendingUndo) return;
  e.preventDefault();
  undoLastDelete();
});

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

// ---------- Tabs ----------
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'years') loadYearsTab();
  });
});

// ---------- Categories ----------
async function loadCategories() {
  categories = await api('/api/categories');
  renderTxCategoryOptions();
  renderCategoryManageLists();
  renderGoalCategoryOptions();
}

function renderTxCategoryOptions() {
  const select = document.getElementById('txCategory');
  const filtered = categories.filter((c) => c.type === txType);
  select.innerHTML = filtered.map((c) => `<option value="${c.id}">${c.name}</option>`).join('');
}

function renderCategoryManageLists() {
  const renderGroup = (type, containerId) => {
    const container = document.getElementById(containerId);
    const list = categories.filter((c) => c.type === type);
    container.innerHTML = list.map((c) => {
      const rollupName = c.rollup_id ? (categories.find((x) => x.id === c.rollup_id) || {}).name : null;
      return `
      <div class="cat-manage-row" data-id="${c.id}">
        <input type="color" value="${c.color}" data-role="color">
        <input type="text" value="${c.name}" data-role="name">
        ${rollupName ? `<span style="font-size:11px; color:#999; white-space:nowrap;">на Дашборде → ${rollupName}</span>` : ''}
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
          invalidateUndo();
          toast('Категория обновлена');
          await loadCategories();
          refreshDashboard();
        } catch (e) { toast(e.message, true); }
      });
      row.querySelector('[data-role="delete"]').addEventListener('click', async () => {
        try {
          await api(`/api/categories/${id}`, { method: 'DELETE' });
          invalidateUndo();
          toast('Категория удалена');
          await loadCategories();
          refreshDashboard();
        } catch (e) {
          if (e.body && e.body.usageCount) {
            const others = categories.filter((c) => c.type === type && String(c.id) !== id);
            const names = others.map((c) => `${c.id}: ${c.name}`).join('\n');
            const target = prompt(
              `На эту категорию есть ${e.body.usageCount} операций.\nВведите ID категории, куда их перенести:\n${names}`
            );
            const targetId = Number(target);
            if (targetId && others.some((c) => c.id === targetId)) {
              await api(`/api/categories/${id}?reassignTo=${targetId}`, { method: 'DELETE' });
              invalidateUndo();
              toast('Операции перенесены, категория удалена');
              await loadCategories();
              refreshDashboard();
            }
          } else {
            toast(e.message, true);
          }
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
    invalidateUndo();
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

// ---------- Add transaction ----------
document.getElementById('txForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    type: txType,
    date: document.getElementById('txDate').value,
    category_id: Number(document.getElementById('txCategory').value),
    amount: Number(document.getElementById('txAmount').value),
    note: document.getElementById('txNote').value,
  };
  try {
    await api('/api/transactions', { method: 'POST', body: JSON.stringify(payload) });
    invalidateUndo();
    document.getElementById('txAmount').value = '';
    document.getElementById('txNote').value = '';
    toast('Операция добавлена');
    await loadTransactionsTable();
    refreshDashboard();
  } catch (e) { toast(e.message, true); }
});

// ---------- Transactions filter (type) ----------
document.getElementById('txFilterType').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-type]');
  if (!btn) return;
  txFilterType = btn.dataset.type;
  document.querySelectorAll('#txFilterType button').forEach((b) => b.classList.toggle('active', b === btn));
  loadTransactionsTable();
});

// ---------- Transactions table ----------
let currentTxRows = [];

async function loadTransactionsTable() {
  const month = document.getElementById('txMonthSelect').value;
  const typeParam = txFilterType === 'all' ? '' : `&type=${txFilterType}`;
  const rows = await api(`/api/transactions?month=${month}${typeParam}`);
  currentTxRows = rows;
  const tbody = document.getElementById('txTableBody');
  const emptyHint = document.getElementById('txEmptyHint');
  if (!rows.length) {
    tbody.innerHTML = '';
    emptyHint.style.display = 'block';
    return;
  }
  emptyHint.style.display = 'none';
  tbody.innerHTML = rows.map((r) => `
    <tr data-id="${r.id}">
      <td>${r.date}</td>
      <td>${r.type === 'expense' ? 'Расход' : 'Доход'}</td>
      <td>${r.category_name}</td>
      <td class="amount-${r.type}">${fmt(r.amount)}</td>
      <td>${r.note || ''}</td>
      <td class="row-actions">
        <button data-role="edit" title="Изменить">✎</button>
        <button data-role="delete" title="Удалить">✕</button>
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('[data-role="delete"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('tr').dataset.id;
      const tx = currentTxRows.find((r) => String(r.id) === String(id));
      await api(`/api/transactions/${id}`, { method: 'DELETE' });
      pendingUndo = tx ? { date: tx.date, type: tx.type, category_id: tx.category_id, amount: tx.amount, note: tx.note } : null;
      toast('Операция удалена', false, 2500, pendingUndo ? undoLastDelete : null);
      await loadTransactionsTable();
      refreshDashboard();
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
    .map((c) => `<option value="${c.id}" ${c.id === selectedId ? 'selected' : ''}>${c.name}</option>`)
    .join('');
}

function renderTxEditRow(tx) {
  const row = document.querySelector(`#txTableBody tr[data-id="${tx.id}"]`);
  if (!row) return;
  row.classList.add('tx-edit-row');
  row.innerHTML = `
    <td><input type="date" class="edit-date" value="${tx.date}"></td>
    <td>
      <select class="edit-type">
        <option value="expense" ${tx.type === 'expense' ? 'selected' : ''}>Расход</option>
        <option value="income" ${tx.type === 'income' ? 'selected' : ''}>Доход</option>
      </select>
    </td>
    <td><select class="edit-category">${categoryOptionsHtml(tx.type, tx.category_id)}</select></td>
    <td><input type="number" class="edit-amount" min="0" step="0.01" value="${tx.amount}"></td>
    <td><input type="text" class="edit-note" value="${tx.note || ''}"></td>
    <td class="row-actions">
      <button data-role="save-edit" title="Сохранить">✓</button>
      <button data-role="cancel-edit" title="Отмена">✕</button>
    </td>
  `;

  row.querySelector('.edit-type').addEventListener('change', (e) => {
    row.querySelector('.edit-category').innerHTML = categoryOptionsHtml(e.target.value, null);
  });

  row.querySelector('[data-role="cancel-edit"]').addEventListener('click', () => loadTransactionsTable());

  row.querySelector('[data-role="save-edit"]').addEventListener('click', async () => {
    const payload = {
      date: row.querySelector('.edit-date').value,
      type: row.querySelector('.edit-type').value,
      category_id: Number(row.querySelector('.edit-category').value),
      amount: Number(row.querySelector('.edit-amount').value),
      note: row.querySelector('.edit-note').value,
    };
    if (!payload.date || !payload.category_id || !(payload.amount > 0)) {
      toast('Заполните дату, категорию и сумму (> 0)', true);
      return;
    }
    try {
      await api(`/api/transactions/${tx.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      invalidateUndo();
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
  document.getElementById('txMonthSelect').innerHTML = options;
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
      <div class="cat-row">
        <div class="cat-dot" style="background:${c.color || CAT_COLORS_FALLBACK}"></div>
        <div class="cat-name">${c.name}</div>
        <div class="cat-bar-wrap"><div class="cat-bar" style="width:${c.pct}%; background:${c.color || CAT_COLORS_FALLBACK}"></div></div>
        <div class="cat-pct">${c.pct}%</div>
        <div class="cat-val">${fmt(c.amount)}</div>
      </div>
    `).join('');
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
  return names.map((n) => `«${n}»`).join(', ');
}

function buildRatioLine(names, ratios, direction, wordCapital, baselineLabel) {
  const word = names.length === 1 ? 'категории' : 'категориях';
  const verb = direction === 'up' ? 'выросли' : 'снизились';
  const withRatios = names.map((n, i) => `«${n}» (×${ratios[i].toFixed(1)})`).join(', ');
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
}

// ---------- Export ----------
document.getElementById('exportBtn').addEventListener('click', () => {
  window.location.href = '/api/export';
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
  toast(`Загружаю ${file.name}…`);
  try {
    const res = await fetch('/api/import', { method: 'POST', body: formData });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Ошибка импорта');
    invalidateUndo();
    const parts = [`Добавлено операций: ${body.imported}`];
    if (body.skippedDuplicates) parts.push(`пропущено дублей: ${body.skippedDuplicates}`);
    if (body.newCategories.length) parts.push(`новые категории: ${body.newCategories.join(', ')}`);
    toast(parts.join(' · '), false, 6000);
    await loadCategories();
    await loadTransactionsTable();
    await refreshDashboard();
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------- Goals ----------
let goalCatMode = 'existing';

function renderGoalCategoryOptions() {
  // Категории, которые сами уже свёрнуты в другую (rollup_id задан), не предлагаем
  // в качестве цели второго уровня — это была бы путаница вложенности.
  const expenseCats = categories.filter((c) => c.type === 'expense' && !c.rollup_id);
  const options = expenseCats.map((c) => `<option value="${c.id}">${c.name}</option>`).join('');
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
    invalidateUndo();
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
  return `<svg viewBox="0 0 84 84">
    <circle cx="42" cy="42" r="${r}" fill="none" stroke="#f0f0ee" stroke-width="8"/>
    <circle cx="42" cy="42" r="${r}" fill="none" stroke="${color}" stroke-width="8" stroke-linecap="round"
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
        <h3>${g.name}</h3>
        <div class="goal-meta">${fmt(g.progress)} из ${fmt(g.target_amount)} · категория «${g.category_name}»</div>
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
        invalidateUndo();
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
      invalidateUndo();
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
document.getElementById('yearSingleSelect').addEventListener('change', loadYearSingleChart);

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
  const datasets = filtered.map((y, i) => {
    const color = YEAR_PALETTE[i % YEAR_PALETTE.length];
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
  await Promise.all([loadYearSingleChart(), loadYearsCompareChart(), loadYearsTotals()]);
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
        invalidateUndo();
        toast('Все данные удалены');
        await loadCategories();
        await loadTransactionsTable();
        await refreshDashboard();
        await loadGoals();
      } catch (e) { toast(e.message, true); }
    },
  });
});

// Touch ID/пароль Mac — доступно только в desktop-приложении (см. desktop/src/preload.js).
// В обычном браузере window.desktopApp не определён — нет доступа к системной авторизации.
async function initAppLockSetting() {
  const toggle = document.getElementById('appLockToggle');
  const row = toggle.closest('.settings-row');
  const desc = document.getElementById('appLockDesc');
  const isDesktop = typeof window.desktopApp !== 'undefined' && window.desktopApp.isDesktop;

  if (!isDesktop) {
    toggle.disabled = true;
    row.classList.add('disabled');
    desc.textContent = 'Доступно только в desktop-приложении для macOS — у веб-версии нет доступа к Touch ID/паролю учётной записи Mac.';
    return;
  }

  toggle.checked = await window.desktopApp.getAppLockEnabled();

  toggle.addEventListener('change', async () => {
    const wantEnabled = toggle.checked;
    if (!wantEnabled) {
      let result = await window.desktopApp.authenticate('отключить защиту паролем в «Мои финансы»');
      if (!result.ok) {
        const pw = prompt('Подтвердите паролем от учётной записи Mac, чтобы выключить защиту:');
        result = pw ? await window.desktopApp.verifyPassword(pw) : { ok: false };
      }
      if (!result.ok) {
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
    desc.textContent = 'Доступно только в приложении для Mac — у веб-версии нет отдельных обновлений, она всегда работает из актуального кода.';
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
    text: 'Здесь сводка по операциям за выбранный месяц: доход, расход, баланс и разбивка расходов по категориям. Месяц переключается стрелками или списком справа.',
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
    selector: '#txListCard',
    title: 'Операции — список, изменение и удаление',
    text: 'Кнопка ✎ открывает редактирование прямо в строке — можно поменять дату, тип, категорию, сумму и заметку, все графики пересчитаются. Кнопка ✕ удаляет операцию; удалённую по ошибке можно вернуть кнопкой «Отменить» во всплывающем уведомлении или сочетанием Cmd/Ctrl+Z — пока не сделано другое изменение. Список фильтруется по типу и месяцу сверху.',
  },
  // ---------- Категории ----------
  {
    tab: 'categories',
    selector: '#tab-categories',
    title: 'Категории',
    text: 'Здесь можно переименовать категорию, сменить цвет или удалить её — при удалении уже занесённые операции можно перенести на другую категорию.',
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
    text: 'Здесь — защита приложения паролем/Touch ID, ручная проверка обновлений (обе — в desktop-версии) и полная очистка данных, с подтверждением, что это необратимо.',
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
  document.getElementById('txDate').valueAsDate = new Date();
  populateMonthSelectors();
  await loadCategories();
  await loadTransactionsTable();
  await refreshDashboard();
  await loadGoals();
  await initAppLockSetting();
  await initAppVersion();
  initUpdateCheckSetting();

  if (!(await hasSeenOnboarding())) {
    setTimeout(startTour, 400);
  }
})();
