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

function toast(message, isError = false, duration = 2500) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.className = 'toast'; }, duration);
}

// ---------- Tabs ----------
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
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
          toast('Категория обновлена');
          await loadCategories();
          refreshDashboard();
        } catch (e) { toast(e.message, true); }
      });
      row.querySelector('[data-role="delete"]').addEventListener('click', async () => {
        try {
          await api(`/api/categories/${id}`, { method: 'DELETE' });
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
async function loadTransactionsTable() {
  const month = document.getElementById('txMonthSelect').value;
  const typeParam = txFilterType === 'all' ? '' : `&type=${txFilterType}`;
  const rows = await api(`/api/transactions?month=${month}${typeParam}`);
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
      <td class="row-actions"><button data-role="delete" title="Удалить">✕</button></td>
    </tr>
  `).join('');

  tbody.querySelectorAll('[data-role="delete"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('tr').dataset.id;
      await api(`/api/transactions/${id}`, { method: 'DELETE' });
      toast('Операция удалена');
      await loadTransactionsTable();
      refreshDashboard();
    });
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

async function loadOverview(type, canvasId, insightsId, wordCapital, wordLower) {
  const data = await api(`/api/summary/overview?months=6&type=${type}&end=${currentMonth}`);
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

  if (overviewCharts[type]) overviewCharts[type].destroy();
  overviewCharts[type] = new Chart(document.getElementById(canvasId), {
    type: 'bar',
    data: { labels: data.map((m) => monthLabel(m.month)), datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { x: { stacked: true }, y: { stacked: true } },
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } } },
    },
  });

  renderInsights(document.getElementById(insightsId), computeInsights(data, wordCapital, wordLower));
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
  loadOverview('expense', 'expenseOverviewChart', 'expense-insights', 'Расходы', 'траты');
  loadOverview('income', 'incomeOverviewChart', 'income-insights', 'Доходы', 'доходы');
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

// ---------- Init ----------
(async function init() {
  document.getElementById('txDate').valueAsDate = new Date();
  populateMonthSelectors();
  await loadCategories();
  await loadTransactionsTable();
  await refreshDashboard();
  await loadGoals();
})();
