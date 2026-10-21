const content = document.querySelector('#content');
const dialog = document.querySelector('#operation-dialog');
const operationForm = document.querySelector('#operation-form');
const savingsHistoryDialog = document.querySelector('#savings-history-dialog');
dialog.addEventListener('click', (event) => {
  if (event.target === dialog) dialog.close();
});
savingsHistoryDialog.addEventListener('click', (event) => {
  if (event.target === savingsHistoryDialog) savingsHistoryDialog.close();
});
const toast = document.querySelector('#toast');
const restoreDialog = document.querySelector('#restore-dialog');
const restoreForm = document.querySelector('#restore-form');
const VIEWS = ['overview', 'operations', 'balance', 'savings', 'lists', 'phone', 'settings'];
const PHONE_CHECKS_KEY = 'finance-phone-setup-checks';

function storedView() {
  const hashView = location.hash.slice(1);
  if (VIEWS.includes(hashView)) return hashView;
  try {
    const saved = localStorage.getItem('finance-view');
    if (VIEWS.includes(saved)) return saved;
  } catch {}
  return 'overview';
}

const state = {
  data: null,
  settings: null,
  view: storedView(),
  month: '',
  operationMonth: '',
  operationType: 'Все',
  operationSection: 'operations',
  search: '',
  dateFrom: '',
  dateTo: '',
  operationCategory: '',
  operationAccount: '',
  operationNecessity: '',
  operationSort: 'date',
  operationSortDirection: 'desc',
  updateCheck: null,
  updateChecking: false,
  updateInstallQueued: false,
};

const esc = (value = '') => String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const money = (value, currency = 'RUB') => new Intl.NumberFormat('ru-RU', { style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(Number(value) || 0);
const number = (value, digits = 2) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(Number(value) || 0);
const dateLabel = (iso) => iso ? new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(`${iso}T12:00:00`)) : '—';
const monthLabel = (iso) => new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric' }).format(new Date(`${iso}-01T12:00:00`));
const operationCountLabel = (count) => {
  const remainder100 = count % 100;
  const remainder10 = count % 10;
  const word = remainder10 === 1 && remainder100 !== 11 ? 'операция' : remainder10 >= 2 && remainder10 <= 4 && (remainder100 < 12 || remainder100 > 14) ? 'операции' : 'операций';
  return `${count} ${word}`;
};
const accountCountLabel = (count) => {
  const remainder100 = count % 100;
  const remainder10 = count % 10;
  const word = remainder10 === 1 && remainder100 !== 11 ? 'активный счёт' : remainder10 >= 2 && remainder10 <= 4 && (remainder100 < 12 || remainder100 > 14) ? 'активных счёта' : 'активных счетов';
  return `${count} ${word}`;
};
const localIsoDate = () => {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60000;
  return new Date(now - offset).toISOString().slice(0, 10);
};

function notify(message, type = '') {
  toast.textContent = message;
  toast.className = `toast show ${type}`;
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => { toast.className = 'toast'; }, 3500);
}

async function request(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error((payload.error || 'Ошибка соединения с сервером.') + (payload.retryable ? ' Можно повторить после устранения причины.' : ''));
    error.code = payload.code; error.retryable = Boolean(payload.retryable); throw error;
  }
  return payload;
}

let loadSequence = 0;
let freshnessCheck = null;
let draftDirty = false;
document.addEventListener('input', (event) => { if (event.target.closest('form')) draftDirty = true; });
async function loadData({ automatic = false } = {}) {
  const sequence = ++loadSequence;
  const previous = state.data;
  const [data, settings] = await Promise.all([request('/api/data'), request('/api/settings')]);
  if (sequence !== loadSequence || state.data !== previous || (automatic && (draftDirty || dialog.open))) return;
  state.data = data;
  state.settings = settings;
  state.month ||= data.summaryMonth || localIsoDate().slice(0, 7);
  state.operationMonth ||= localIsoDate().slice(0, 7);
  document.querySelector('#workbook-name').textContent = data.workbook;
  document.querySelector('#workbook-name').dataset.asOfDate = data.asOfDate;
  document.querySelector('#workbook-name').dataset.revision = data.revision;
  render();
}

function refreshIfStale() {
  if (document.hidden || freshnessCheck || draftDirty || dialog.open || document.activeElement?.matches('input, textarea, select')) return freshnessCheck;
  freshnessCheck = (async () => {
    const snapshot = await request('/api/snapshot');
    if (!state.data || state.data.revision !== snapshot.revision || state.data.asOfDate !== snapshot.asOfDate || state.data.asOfDate !== localIsoDate()) await loadData({ automatic: true });
  })().catch((error) => notify(error.message, 'error')).finally(() => { freshnessCheck = null; });
  return freshnessCheck;
}

function monthOperations(month = state.month) {
  return state.data.operations.filter((operation) => operation.date.startsWith(month));
}

function accounts() {
  const result = state.data.accounts || state.data.balances || [];
  return [...result].sort((a, b) => {
    const orderA = Number(a.order) > 0 ? Number(a.order) : Number(a.id) || 0;
    const orderB = Number(b.order) > 0 ? Number(b.order) : Number(b.id) || 0;
    return orderA - orderB || Number(a.id) - Number(b.id);
  });
}

function accountById(id) {
  return accounts().find((account) => account.id === Number(id));
}

function savingsAccountById(id) { return (state.data?.savingsAccounts || []).find((account) => account.id === Number(id)); }

function categoryByName(name) {
  return state.data?.lists?.categories?.find((category) => category.name === name);
}

function categoryLabel(name) {
  const category = categoryByName(name);
  return `${category?.emoji ? `${category.emoji} ` : ''}${name || 'Без категории'}`;
}

function navigateTo(view, { replace = false } = {}) {
  const target = VIEWS.includes(view) ? view : 'overview';
  state.view = target;
  updateTopbarActions();
  try { localStorage.setItem('finance-view', target); } catch {}
  const url = `${location.pathname}${location.search}#${target}`;
  history[replace ? 'replaceState' : 'pushState']({}, '', url);
  document.querySelector('.sidebar').classList.remove('open');
  if (state.data) { render(); refreshIfStale(); }
}

function totals(operations) {
  return operations.reduce((result, operation) => {
    if (operation.type === 'Доход') result.income += operation.rubAmount;
    if (operation.type === 'Расход' || operation.type === 'Инвестиция') result.expense += operation.rubAmount;
    if (operation.type === 'Инвестиция') result.investment += operation.rubAmount;
    if (operation.type === 'Расход' && operation.necessity === 'Обязательная') result.required += operation.rubAmount;
    if (operation.type === 'Расход' && operation.necessity === 'Гибкая') result.flexible += operation.rubAmount;
    return result;
  }, { income: 0, expense: 0, investment: 0, required: 0, flexible: 0 });
}

function pageHeader(title, subtitle, withMonth = false) {
  return `<div class="page-head"><div><div class="eyebrow">${esc(subtitle)}</div><h1>${esc(title)}</h1></div>${withMonth ? `<label class="month-control"><span>Период</span><input id="month-picker" type="month" value="${state.month}"></label>` : ''}</div>`;
}

function renderOverview() {
  const operations = monthOperations();
  const sum = totals(operations);
  const net = sum.income - sum.expense;
  const resultNote = sum.income ? `${Math.round((net / sum.income) * 100)}% от доходов` : sum.expense ? 'Нет доходов за период' : 'Нет операций за период';
  const categories = new Map();
  operations.filter((item) => item.type === 'Расход' || item.type === 'Инвестиция').forEach((item) => categories.set(item.category || 'Без категории', (categories.get(item.category || 'Без категории') || 0) + item.rubAmount));
  const sortedCategories = [...categories.entries()].sort((a, b) => b[1] - a[1]);
  const topCategories = sortedCategories.length > 6
    ? [...sortedCategories.slice(0, 5), ['Остальные', sortedCategories.slice(5).reduce((sumValue, [, value]) => sumValue + value, 0)]]
    : sortedCategories;
  const unclassified = Math.max(0, sum.expense - sum.required - sum.flexible - sum.investment);
  const months = [];
  const anchor = new Date(`${state.month}-01T12:00:00`);
  for (let i = 5; i >= 0; i -= 1) {
    const date = new Date(anchor.getFullYear(), anchor.getMonth() - i, 1);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    const shortMonth = new Intl.DateTimeFormat('ru-RU', { month: 'short' }).format(date).replace('.', '');
    months.push({ key, label: `${shortMonth} ${String(date.getFullYear()).slice(-2)}`, fullLabel: monthLabel(key), ...totals(monthOperations(key)) });
  }
  const chartMax = Math.max(...months.flatMap((item) => [item.income, item.expense]), 1);
  const recent = operations.slice(0, 5);
  const categoryRows = topCategories.map(([name, value]) => {
    const share = sum.expense ? Math.round(value / sum.expense * 100) : 0;
    return `<div class="category-row"><span class="category-name">${esc(name === 'Остальные' ? `📊 ${name}` : categoryLabel(name))} <small>${share}%</small></span><strong>${money(value)}</strong><div class="track"><i style="width:${share}%"></i></div></div>`;
  }).join('');
  const necessityRows = [
    ['Обязательные', sum.required, 'required'],
    ['Гибкие', sum.flexible, 'flexible'],
    ['Инвестиции', sum.investment, 'investment'],
    ['Не указано', unclassified, 'unclassified'],
  ].filter(([, value]) => value > 0);

  content.innerHTML = `${pageHeader(`Обзор за ${monthLabel(state.month)}`, 'Сводка по книге', true)}
    <div class="dashboard-grid">
      <section class="overview-main">
    <div class="metrics">
      <article class="metric" data-overview-metric="income"><span class="metric-label">Доходы</span><strong class="metric-value">${money(sum.income)}</strong><span class="metric-note">${operationCountLabel(operations.filter((x) => x.type === 'Доход').length)}</span></article>
      <article class="metric" data-overview-metric="expense"><span class="metric-label">Расходы</span><strong class="metric-value">${money(sum.expense)}</strong><span class="metric-note">${operationCountLabel(operations.filter((x) => x.type === 'Расход' || x.type === 'Инвестиция').length)}</span></article>
      <article class="metric accent ${net < 0 ? 'negative' : ''}" data-overview-metric="result"><span class="metric-label">Результат месяца</span><strong class="metric-value">${money(net)}</strong><span class="metric-note">${resultNote}</span></article>
      <article class="metric" data-overview-metric="balance"><span class="metric-label">Текущий остаток</span><strong class="metric-value">${money(accounts().reduce((a, b) => a + b.rubAmount, 0))}</strong><span class="metric-note">Расчётно по всем активным счетам</span></article>
    </div>
      <article class="card overview-chart-card"><div class="card-head"><h2>Динамика за 6 месяцев</h2><div class="legend"><span><i class="income"></i>Доход</span><span><i class="expense"></i>Расход</span><span><i class="investment"></i>Инвестиции в расходах</span></div></div>
        <div class="chart">${months.map((item) => { const investmentShare = item.expense ? item.investment / item.expense : 0; const split = `${Math.max(0, 100 - investmentShare * 100)}%`; const expenseStyle = item.investment > 0 ? `background:linear-gradient(to top,var(--expense-series) ${split},var(--investment-series) ${split})` : ''; return `<div class="chart-group" tabindex="0" aria-label="${esc(`${item.fullLabel}: доход ${money(item.income)}, расход ${money(item.expense)}, включая инвестиции ${money(item.investment)}`)}" title="${esc(`${item.fullLabel}: доход ${money(item.income)}, расход ${money(item.expense)}, включая инвестиции ${money(item.investment)}`)}"><i class="bar" style="height:${item.income ? Math.max(2, item.income / chartMax * 175) : 0}px"></i><i class="bar expense" style="height:${item.expense ? Math.max(2, item.expense / chartMax * 175) : 0}px;${expenseStyle}"></i><span class="chart-label">${esc(item.label)}</span></div>`; }).join('')}</div>
      </article>
      </section>
      <article class="card spending-card"><div class="card-head"><h2>Структура расходов</h2><span>${money(sum.expense)}</span></div>
        ${sum.expense ? `<section class="necessity-summary" aria-label="Расходы по необходимости"><h3>По необходимости</h3><div class="necessity-track">${necessityRows.map(([label, value, className]) => `<i class="${className}" style="width:${value / sum.expense * 100}%" title="${esc(`${label}: ${money(value)}`)}"></i>`).join('')}</div><div class="necessity-legend">${necessityRows.map(([label, value, className]) => `<div><i class="${className}"></i><span>${esc(label)}<small>${money(value)} · ${Math.round(value / sum.expense * 100)}%</small></span></div>`).join('')}</div></section><div class="section-title"><h3>По категориям</h3><span>доля от всех расходов</span></div><div class="category-list">${categoryRows}</div>` : '<div class="empty-state">В этом месяце расходов пока нет</div>'}
      </article>
      <article class="card recent-card"><div class="card-head"><h2>Последние операции за месяц</h2><button class="row-action" data-view="operations">Все операции →</button></div>${operationTable(recent, false)}</article>
    </div>`;
}

function operationSupplement(item) {
  const exchange = item.exchange;
  const hasTransferRoute = item.type === 'Перевод' && (!item.savingsTransfer || item.savingsTransfer === 'from-savings');
  const hasRoute = item.type === 'Инвестиция' || hasTransferRoute;
  const details = [];
  if (hasRoute) {
    const sourceAmount = exchange?.sourceAmount ?? (item.savingsTransfer === 'from-savings' ? item.savingsAmount || item.amount : item.amount);
    const sourceCurrency = exchange?.sourceCurrency ?? item.currency;
    const destinationAmount = exchange?.destinationAmount ?? (item.type === 'Инвестиция' ? item.savingsAmount : item.destinationAmount);
    const destinationCurrency = exchange?.destinationCurrency ?? (item.type === 'Инвестиция'
      ? savingsAccountById(item.savingsAccountId)?.currency || ''
      : accountById(item.destinationAccountId)?.currency || '');
    details.push(`<small class="muted">${number(sourceAmount, 6)} ${esc(sourceCurrency)} → ${number(destinationAmount, 6)} ${esc(destinationCurrency)}</small>`);
  }

  if (exchange) {
    if (exchange.rubDifference === null) {
      details.push('<small class="muted">Нет курса ЦБ для сравнения</small>');
    } else {
      const difference = Math.round(exchange.rubDifference * 100) / 100;
      const differenceText = `${difference > 0 ? '+' : difference < 0 ? '−' : ''}${number(Math.abs(difference))} ₽`;
      const label = difference > 0 ? 'Лучше ЦБ' : difference < 0 ? 'Хуже ЦБ' : 'По курсу ЦБ';
      const color = difference > 0 ? 'exchange-gain' : difference < 0 ? 'exchange-loss' : 'muted';
      details.push(`<small class="${color}">${label}: ${differenceText}</small>`);
    }
  } else if (item.type === 'Инвестиция' && item.currency !== 'RUB') {
    details.push(`<small class="muted">Курс оценки расхода: ${number(item.rate, 6)} ₽</small>`);
  } else if (item.type !== 'Инвестиция' && item.currency !== 'RUB') {
    details.push(`<small class="muted">${number(item.amount)} ${esc(item.currency)} · курс ${number(item.rate, 6)}</small>`);
  }
  return details.join('');
}

function operationTable(operations, actions = true, sortable = false) {
  if (!operations.length) return '<div class="empty-state">Операций пока нет. Добавьте первую запись.</div>';
  const header = (key, label, right = false) => {
    const direction = state.operationSortDirection;
    const active = state.operationSort === key;
    const ariaSort = active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none';
    return sortable
      ? `<th${right ? ' style="text-align:right"' : ''} aria-sort="${ariaSort}"><button type="button" class="sort-button ${active ? 'active' : ''}" data-sort-key="${key}" aria-label="Сортировать по полю ${label}">${label}<span aria-hidden="true">${active ? direction === 'asc' ? '↑' : '↓' : '↕'}</span></button></th>`
      : `<th${right ? ' style="text-align:right"' : ''}>${label}</th>`;
  };
  return `<div class="table-wrap${sortable ? ' operations-table-scroll' : ''}"${sortable ? ' role="region" aria-label="Таблица операций"' : ''}><table><thead><tr>${header('date', 'Дата')}<th>Заметка</th>${header('category', 'Категория')}${header('account', 'Счёт')}<th>Тип</th><th>Необходимость</th>${header('amount', 'Сумма', true)}${actions ? '<th>Действия</th>' : ''}</tr></thead><tbody>${operations.map((item) => `<tr class="keyboard-row" tabindex="0" data-keyboard-row data-operation-row="${item.id}" aria-label="Операция ${esc(item.notes || categoryLabel(item.category))}">
    <td class="muted">${dateLabel(item.date)}</td><td class="operation-note"><span>${esc(item.notes || 'Без заметки')}</span>${operationSupplement(item)}</td>
    <td>${item.type === 'Перевод' ? (item.savingsTransfer ? '🏦 Между учётами' : '🔁 Между счетами') : esc(categoryLabel(item.category))}</td><td class="account-route">${item.savingsTransfer === 'investment' ? `${esc(accountById(item.accountId)?.name || 'Счёт')} → ${esc(savingsAccountById(item.savingsAccountId)?.name || 'Накопления')}` : item.savingsTransfer === 'to-savings' ? `${esc(accountById(item.accountId)?.name || 'Счёт')} → ${esc(savingsAccountById(item.savingsAccountId)?.name || 'Накопления')}` : item.savingsTransfer === 'from-savings' ? `${esc(savingsAccountById(item.savingsAccountId)?.name || 'Накопления')} → ${esc(accountById(item.destinationAccountId)?.name || 'Счёт')}` : item.type === 'Перевод' ? `${esc(accountById(item.accountId)?.name || 'Счёт')} → ${esc(accountById(item.destinationAccountId)?.name || 'Счёт')}` : esc(accountById(item.accountId)?.name || 'История без счёта')}</td><td><span class="tag ${item.type === 'Расход' ? 'expense' : item.type === 'Инвестиция' ? 'investment' : item.type === 'Доход' ? 'income' : 'transfer'}">${esc(item.type)}</span></td><td>${item.type === 'Расход' && item.necessity ? `<span class="tag ${item.necessity === 'Гибкая' ? 'flex' : 'required'}">${esc(item.necessity)}</span>` : '<span class="muted">—</span>'}</td>
    <td class="money ${item.type === 'Расход' ? 'expense' : item.type === 'Инвестиция' ? 'investment' : item.type === 'Доход' ? 'income' : ''}">${item.type === 'Расход' || item.type === 'Инвестиция' ? '−' : item.type === 'Доход' ? '+' : '↔ '}${money(item.rubAmount)}</td>
    ${actions ? `<td><div class="row-actions">${['investment', 'from-savings'].includes(item.savingsTransfer) ? `<button class="row-action" data-delete="${item.id}" title="${item.savingsTransfer === 'investment' ? 'Удалить инвестицию и отменить движение средств' : 'Удалить перевод и отменить движение средств'}">×</button>` : item.savingsTransfer ? '<small class="muted">Связанный перевод</small>' : `<button class="row-action" data-edit="${item.id}" title="Редактировать">✎</button><button class="row-action" data-delete="${item.id}" title="Удалить">×</button>`}</div></td>` : ''}</tr>`).join('')}</tbody></table></div>`;
}

function openingBalanceTable(rows) {
  if (!rows.length) return '';
  return `<div class="table-wrap"><table><thead><tr><th>Дата</th><th>Счёт</th><th style="text-align:right">Начальный баланс</th><th style="text-align:right">Эквивалент в рублях</th><th></th></tr></thead><tbody>${rows.map((item) => {
    const account = accountById(item.accountId);
    return `<tr><td class="muted">${dateLabel(item.date)}</td><td>${esc(account?.name || '')}</td><td class="money">${money(item.amount, account?.currency || 'RUB')}</td><td class="money">${money(item.amount * (account?.rate || 1))}</td><td><button type="button" class="row-action" data-edit-opening="${item.accountId}" title="Изменить">✎</button></td></tr>`;
  }).join('')}</tbody></table></div>`;
}

function renderOpeningBalances() {
  const openingType = '\u041d\u0430\u0447\u0430\u043b\u044c\u043d\u044b\u0439 \u0431\u0430\u043b\u0430\u043d\u0441';
  const accountOrder = new Map(accounts().map((account, index) => [account.id, index]));
  const rows = (state.data.openingBalances || []).map((item) => ({ ...item, type: openingType }))
    .sort((a, b) => (accountOrder.get(a.accountId) ?? Infinity) - (accountOrder.get(b.accountId) ?? Infinity));
  content.innerHTML = `${pageHeader('Операции', `${state.data.operations.length} записей в Excel`)}
    <div class="operation-sections" role="tablist" aria-label="Разделы операций"><button type="button" role="tab" aria-selected="false" data-operations-section="operations">Операции</button><button type="button" role="tab" aria-selected="true" class="active" data-operations-section="opening-balances">Начальные балансы</button></div>
    <form class="opening-balance-card" id="opening-balance-form"><div class="opening-balance-heading"><strong>Начальный баланс</strong><span>Повторный ввод заменит прежнюю сумму. В доходы и расходы она не входит.</span></div><div class="opening-balance-fields"><label><span>Счёт</span><select name="accountId">${accounts().map((account) => `<option value="${account.id}">${esc(account.name)} · ${esc(account.currency)}</option>`).join('')}</select></label><label><span>Сумма в валюте счёта</span><input name="amount" type="number" min="0" step="any" placeholder="0" required></label><button type="submit" class="primary-button">Сохранить</button></div></form>
    <section class="table-card opening-balance-table">${rows.length ? openingBalanceTable(rows) : '<div class="empty-state">Начальные балансы пока не заданы.</div>'}</section>`;
}

function mountOpeningDateField() {
  const saveButton = content.querySelector('#opening-balance-form .opening-balance-fields button');
  if (!saveButton || content.querySelector('#opening-balance-form [name="date"]')) return;
  saveButton.insertAdjacentHTML('beforebegin', `<label><span>Дата баланса</span><input name="date" type="date" value="${localIsoDate()}" required></label>`);
}

function renderOperations() {
  if (state.operationSection === 'opening-balances') { renderOpeningBalances(); mountOpeningDateField(); return; }
  const allRows = state.data.operations;
  const filtered = allRows.filter((item) => {
    const matchesMonth = !state.operationMonth || item.date.startsWith(state.operationMonth);
    const matchesType = state.operationType === 'Все' || item.type === state.operationType;
    const matchesFrom = !state.dateFrom || item.date >= state.dateFrom;
    const matchesTo = !state.dateTo || item.date <= state.dateTo;
    const matchesCategory = !state.operationCategory || item.category === state.operationCategory;
    const selectedAccount = Number(state.operationAccount);
    const matchesAccount = !selectedAccount || item.accountId === selectedAccount || item.destinationAccountId === selectedAccount || item.savingsAccountId === selectedAccount;
    const matchesNecessity = !state.operationNecessity || item.necessity === state.operationNecessity;
    const haystack = `${item.category} ${item.notes} ${item.type} ${item.necessity} ${accountById(item.accountId)?.name || ''} ${accountById(item.destinationAccountId)?.name || ''}`.toLowerCase();
    return matchesMonth && matchesFrom && matchesTo && matchesType && matchesCategory && matchesAccount && matchesNecessity && haystack.includes(state.search.toLowerCase());
  });
  const sortValue = (item) => {
    if (state.operationSort === 'date') return item.date || '';
    if (state.operationSort === 'amount') return Number(item.rubAmount) || 0;
    if (state.operationSort === 'category') return (item.category || (item.type === 'Перевод' ? item.savingsTransfer ? 'Между учётами' : 'Между счетами' : '')).toLocaleLowerCase('ru-RU');
    if (state.operationSort === 'account') {
      const from = item.savingsTransfer === 'from-savings' ? savingsAccountById(item.savingsAccountId)?.name : accountById(item.accountId)?.name;
      const to = ['to-savings', 'investment'].includes(item.savingsTransfer) ? savingsAccountById(item.savingsAccountId)?.name : accountById(item.destinationAccountId)?.name;
      return `${from || ''} ${to ? `→ ${to}` : ''}`.toLocaleLowerCase('ru-RU');
    }
    return '';
  };
  const direction = state.operationSortDirection === 'asc' ? 1 : -1;
  filtered.sort((a, b) => {
    const left = sortValue(a); const right = sortValue(b);
    const comparison = typeof left === 'number' ? left - right : String(left).localeCompare(String(right), 'ru');
    return comparison ? comparison * direction : (a.id - b.id) * direction;
  });
  const categories = [...new Map([
    ...state.data.lists.categories.filter((item) => item.type === 'Расход' || item.type === 'Доход'),
    { name: 'Вклад', type: 'Инвестиция', emoji: '' },
    { name: 'Отложенные', type: 'Инвестиция', emoji: '' },
  ].map((item) => [item.name, item])).values()];
  const currentOperationMonth = localIsoDate().slice(0, 7);
  const activeFilters = Boolean(state.operationMonth !== currentOperationMonth || state.dateFrom || state.dateTo || state.operationType !== 'Все' || state.operationCategory || state.operationAccount || state.operationNecessity || state.search);
  const filteredRubTotal = filtered.every((item) => item.currency === 'RUB' || item.rate > 0)
    ? filtered.reduce((sum, item) => sum + item.rubAmount, 0)
    : null;
  content.innerHTML = `${pageHeader('Операции', `${allRows.length} записей в Excel`)}
    <div class="operation-filters"><div class="operation-filter-row">
      <label class="filter-field search-field"><span>Поиск</span><input class="search" id="operation-search" value="${esc(state.search)}" placeholder="Заметка, категория или счёт"></label>
      <label class="filter-field"><span>Месяц</span><input id="operation-month" type="month" value="${state.operationMonth}"></label>
      <label class="filter-field"><span>С даты</span><input id="operation-date-from" type="date" value="${state.dateFrom}"></label>
      <label class="filter-field"><span>По дату</span><input id="operation-date-to" type="date" value="${state.dateTo}"></label>
      <label class="filter-field"><span>Тип</span><select id="operation-type"><option value="Все">Все типы</option>${['Расход', 'Доход', 'Перевод', 'Инвестиция'].map((type) => `<option value="${type}" ${state.operationType === type ? 'selected' : ''}>${type}</option>`).join('')}</select></label>
      <label class="filter-field"><span>Категория</span><select id="operation-category"><option value="">Все категории</option>${categories.map((item) => `<option value="${esc(item.name)}" ${state.operationCategory === item.name ? 'selected' : ''}>${esc(item.emoji ? `${item.emoji} ${item.name}` : item.name)}</option>`).join('')}</select></label>
      <label class="filter-field"><span>Счёт</span><select id="operation-account"><option value="">Все счета</option>${accounts().map((item) => `<option value="${item.id}" ${String(item.id) === state.operationAccount ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}</select></label>
      <label class="filter-field"><span>Необходимость</span><select id="operation-necessity"><option value="">Любая</option>${state.data.lists.necessities.map((item) => `<option value="${esc(item)}" ${state.operationNecessity === item ? 'selected' : ''}>${esc(item)}</option>`).join('')}</select></label>
      <button type="button" class="secondary-button clear-operation-filters" id="clear-operation-filters" ${activeFilters ? '' : 'disabled'}>Сбросить фильтры</button>
    </div><div class="operation-filter-meta"><span>Показано ${filtered.length} из ${allRows.length}</span><span>Сумма в рублях: ${filteredRubTotal === null ? 'нет курса для части операций' : money(filteredRubTotal)}</span></div></div>
    <div class="table-card">${operationTable(filtered, true, true)}</div>`;
  for (const item of filtered.filter((operation) => ['investment', 'from-savings'].includes(operation.savingsTransfer))) {
    content.querySelector(`[data-operation-row="${item.id}"] .row-actions`)?.insertAdjacentHTML('afterbegin', `<button type="button" class="row-action" data-edit="${item.id}" title="Редактировать перевод" aria-label="Редактировать перевод">✎</button>`);
  }
  content.querySelector('.page-head').insertAdjacentHTML('afterend', '<div class="operation-sections" role="tablist" aria-label="Разделы операций"><button type="button" role="tab" aria-selected="true" class="active" data-operations-section="operations">Операции</button><button type="button" role="tab" aria-selected="false" data-operations-section="opening-balances">Начальные балансы</button></div>');
}

function accountRowHtml(item = {}) {
  const isNew = !item.id;
  const canDelete = accounts().length > 1;
  const currency = item.currency || 'RUB';
  return `<tr data-account-row="${item.id || ''}" class="${isNew ? 'new-account-row' : ''}"><td class="account-name-cell"><input name="name" value="${esc(item.name)}" title="${esc(item.name)}" placeholder="Название счёта" required></td><td class="account-currency-cell"><select name="currency" required>${state.data.lists.currencies.map((value) => `<option ${value === currency ? 'selected' : ''}>${esc(value)}</option>`).join('')}</select></td><td class="account-rate-cell"><input name="rate" type="number" min="0.000001" step="any" value="${currency === 'RUB' ? '1' : item.rate || ''}" placeholder="${currency === 'RUB' ? '1' : 'Курс ЦБ на сегодня'}" ${currency === 'RUB' ? 'readonly' : ''}></td><td class="money account-balance-cell" data-account-calculated>${number(item.calculatedBalance)} ${esc(currency)}</td><td class="money account-rub-cell">${item.rubAmount === null ? '—' : money(item.rubAmount)}</td><td class="account-actions-cell"><div class="account-row-actions">${isNew ? '<button type="button" class="row-action" data-remove-new-account title="Убрать">×</button>' : `<button type="button" class="row-action danger" data-delete-account="${item.id}" title="${canDelete ? 'Удалить счёт' : 'Нельзя удалить единственный счёт'}" ${canDelete ? '' : 'disabled'}>×</button>`}</div></td></tr>`;
}

function prepareAccountRow(row) {
  if (row.dataset.accountRow) {
    const handle = document.createElement('button');
    handle.type = 'button'; handle.className = 'account-drag-handle'; handle.textContent = '⠿'; handle.draggable = true;
    handle.title = 'Перетащить счёт · Alt+↑/↓'; handle.setAttribute('aria-label', 'Изменить порядок счёта');
    row.querySelector('.account-name-cell').prepend(handle);
  }
  row.tabIndex = 0;
  row.dataset.keyboardRow = '';
  row.classList.add('keyboard-row');
  row.setAttribute('aria-label', `Счёт ${row.querySelector('[name="name"]').value || 'без названия'}`);
}

function renderBalance() {
  const allAccounts = accounts();
  const active = allAccounts.filter((item) => item.active);
  const total = cachedRubTotal(active);
  content.innerHTML = `${pageHeader('Счета и остатки', 'Расчётный баланс по операциям')}
    <div class="balance-hero"><div class="balance-hero-main"><div><small>Расчётно доступно</small><strong data-rub-total>${total === null ? '—' : money(total)}</strong></div><div class="balance-hero-equivalents"><small>Эквивалент в USD</small><div class="currency-equivalent-list" data-total-currency-equivalents>${cachedUsdEquivalent(total)}</div></div></div><span class="balance-account-count">${accountCountLabel(active.length)}</span></div>
    <div class="account-explainer"><strong>Как считается остаток</strong><span>Доходы − расходы + переводы между своими счетами. Будущие операции появятся в остатке в дату операции; эквивалент в рублях использует курс ЦБ на сегодня.</span></div>
    <form id="accounts-form" class="table-card balance-form"><div class="table-wrap"><table class="accounts-table"><thead><tr><th>Счёт</th><th>Валюта</th><th>Курс к рублю</th><th class="numeric-heading">Текущий остаток</th><th class="numeric-heading">Эквивалент в рублях</th><th>Действия</th></tr></thead><tbody>
      ${allAccounts.map((item) => accountRowHtml(item)).join('')}
    </tbody></table></div><div class="balance-actions"><p>Добавление, изменение и удаление сразу обновляют список счетов для Obsidian через Syncthing. Перед каждой записью создаётся бэкап.</p><div><button class="secondary-button" type="button" data-add-account>+ Добавить счёт</button><button class="primary-button" type="submit">Сохранить изменения</button></div></div></form>`;
  content.querySelectorAll('[data-account-row]').forEach((row) => {
    prepareAccountRow(row);
  });
  const comparison = document.createElement('section');
  comparison.className = 'card currency-comparison';
  comparison.innerHTML = '<h2>Изменение стоимости текущего остатка</h2>';
  content.append(comparison);
  loadCurrencyComparison(comparison);
}

function cachedUsdEquivalent(totalRub) {
  if (totalRub === null) return '<span>— USD</span>';
  const rate = Number(state.data?.currentRates?.USD);
  return rate > 0
    ? `<span class="currency-equivalent">≈ ${number(totalRub / rate)} USD</span>`
    : '<span class="currency-equivalent">— USD</span>';
}

function cachedRubTotal(accountsToConvert) {
  const rates = state.data?.currentRates || {};
  let total = 0;
  for (const account of accountsToConvert) {
    const rate = account.currency === 'RUB' ? 1 : Number(rates[account.currency]);
    if (!(rate > 0)) return null;
    total += account.calculatedBalance * rate;
  }
  return total;
}

async function loadCurrencyComparison(container, ledger = 'main', refresh = false, providedData = null) {
  try {
    const query = new URLSearchParams();
    if (ledger === 'savings') query.set('ledger', 'savings');
    if (refresh) query.set('refresh', 'true');
    const snapshot = state.data;
    snapshot.comparisons ||= {};
    const key = `${ledger}:${localIsoDate()}`;
    if (providedData || refresh || !snapshot.comparisons[key]) {
      snapshot.comparisons[key] = providedData ? Promise.resolve(providedData) : request(`/api/balance/currency-comparison${query.size ? `?${query}` : ''}`).catch((error) => { delete snapshot.comparisons[key]; throw error; });
    }
    const data = await snapshot.comparisons[key];
    if (snapshot !== state.data) return;
    if (!container.isConnected) return;
    const signed = (value) => `${value > 0 ? '+' : ''}${money(value)}`;
    container.innerHTML = `<h2>Изменение стоимости текущего остатка</h2><p>Сравнение одной и той же суммы по курсам ЦБ на ${dateLabel(data.firstDay)} и ${dateLabel(data.today)}. Это не доход или расход за месяц.</p><div class="table-wrap"><table><thead><tr><th>Валюта</th><th>Остаток</th><th>Курс на 1-е число</th><th>Курс сегодня</th><th>На 1-е число, ₽</th><th>Сегодня, ₽</th><th>Разница, ₽</th></tr></thead><tbody>${data.currencies.map((item) => `<tr><td>${esc(item.currency)}</td><td>${number(item.amount)}</td>${item.error ? `<td colspan="5">${esc(item.error)}</td>` : `<td title="Курс ЦБ от ${esc(item.firstEffectiveDate)}">${number(item.firstRate, 6)}</td><td title="Курс ЦБ от ${esc(item.currentEffectiveDate)}">${number(item.currentRate, 6)}</td><td>${money(item.firstValue)}</td><td>${money(item.currentValue)}</td><td>${signed(item.difference)}</td>`}</tr>`).join('')}</tbody><tfoot><tr><th colspan="4">Итого по всем счетам</th><td>${data.total ? money(data.total.firstValue) : '—'}</td><td>${data.total ? money(data.total.currentValue) : '—'}</td><td>${data.total ? signed(data.total.difference) : 'Нет всех курсов'}</td></tr></tfoot></table></div>${data.currencies.length ? '' : '<p>Добавьте первый счёт, чтобы сравнивать стоимость остатка.</p>'}`;
  } catch (error) { if (container.isConnected) container.innerHTML = `<h2>Изменение стоимости текущего остатка</h2><p>${esc(error.message)}</p><button type="button" class="secondary-button" data-retry-comparison>Повторить</button>`; }
}

function renderSavings() {
  const savings = state.data.savingsAccounts || [];
  operationForm.querySelector('input[name="type"][value="Инвестиция"]').disabled = savings.length === 0;
  const totalRub = cachedRubTotal(savings);
  const mainAccounts = accounts().filter((item) => item.active);
  const currencies = state.data.lists.currencies || ['RUB'];
  const groupBalance = (type) => {
    const byCurrency = new Map();
    for (const item of savings.filter((account) => account.type === type)) byCurrency.set(item.currency, (byCurrency.get(item.currency) || 0) + item.calculatedBalance);
    return [...byCurrency].map(([currency, amount]) => money(amount, currency)).join(' · ') || 'Нет счетов';
  };
  content.innerHTML = `${pageHeader('Накопления', 'Отдельные накопительные счета')}
    <div class="balance-hero savings-hero"><div class="balance-hero-main"><div><small>Общий баланс накоплений</small><strong data-rub-total>${totalRub === null ? '—' : money(totalRub)}</strong></div><div class="balance-hero-equivalents"><small>Эквивалент в USD</small><div class="currency-equivalent-list" data-total-currency-equivalents>${totalRub === null ? '<span class="currency-equivalent">— USD</span>' : cachedUsdEquivalent(totalRub)}</div></div></div><span class="balance-account-count">${savings.length} активных счетов</span></div>
    <div class="metrics savings-metrics"><article class="metric"><span>Отложенные</span><strong class="savings-metric-values">${esc(groupBalance('Отложенные'))}</strong><small>остатки по валютам</small></article><article class="metric"><span>Вклады</span><strong class="savings-metric-values">${esc(groupBalance('Вклад'))}</strong><small>остатки по валютам</small></article><article class="metric savings-rub-total"><span>Итого сегодня</span><strong data-rub-total>${totalRub === null ? '—' : money(totalRub)}</strong><small>рублёвый эквивалент</small></article></div>
    <section class="card savings-accounts"><div class="section-title"><h3>Счета накоплений</h3><span>Начальный капитал + движения</span></div>${savings.length ? `<div class="savings-card-grid">${savings.map((item) => `<article class="savings-account-card" data-savings-account="${item.id}"><div class="savings-account-head"><div><span class="tag">${esc(item.type)}</span><h3>${esc(item.name)}</h3></div><button class="row-action danger" type="button" data-delete-savings="${item.id}" title="Удалить счёт">×</button></div><strong class="savings-balance">${money(item.calculatedBalance, item.currency)}</strong><small>Начальный капитал: ${money(item.initialCapital, item.currency)}</small><form class="savings-increase-form" data-savings-increase="${item.id}"><label class="field"><span>Изменить капитал · ${esc(item.currency)}</span><input name="amount" type="number" step="0.01" inputmode="decimal" required placeholder="Можно ввести отрицательную"></label><label class="field"><span>Дата</span><input name="date" type="date" value="${localIsoDate()}" required></label><div class="savings-increase-actions"><button class="primary-button" type="submit">Изменить капитал</button><button class="secondary-button" type="button" data-savings-history="${item.id}" aria-label="Открыть историю счёта ${esc(item.name)}">История</button></div></form></article>`).join('')}</div>` : '<div class="empty-state">Добавьте первый накопительный счёт.</div>'}</section>
    <section class="card savings-create"><div class="section-title"><h3>Новый накопительный счёт</h3></div><form id="savings-create-form" class="savings-create-form"><label class="field"><span>Название</span><input name="name" maxlength="100" required placeholder="Например, Резервный вклад"></label><label class="field"><span>Тип</span><select name="type"><option>Отложенные</option><option>Вклад</option></select></label><label class="field"><span>Валюта</span><select name="currency">${currencies.map((value) => `<option>${esc(value)}</option>`).join('')}</select></label><label class="field"><span>Начальный капитал</span><input name="initialCapital" type="number" min="0" step="0.01" value="0" required></label><button class="primary-button" type="submit">Добавить счёт</button></form></section>
    <section class="card savings-transfer"><div class="section-title"><h3>Вывод на обычный счёт</h3><span>Пополнение накоплений оформляется как инвестиция</span></div>${mainAccounts.length && savings.length ? `<form id="savings-transfer-form" class="savings-transfer-form"><input type="hidden" name="direction" value="from-savings"><label class="field savings-transfer-savings-account"><span>Счёт накоплений</span><select name="savingAccountId">${savings.map((item) => `<option value="${item.id}">${esc(item.name)} · ${esc(item.currency)}</option>`).join('')}</select></label><label class="field savings-transfer-saving-amount"><span>Сумма списания · ${esc(savings[0].currency)}</span><input name="savingAmount" type="number" min="0.000001" step="any" required></label><label class="field savings-transfer-main-account"><span>Обычный счёт для зачисления</span><select name="mainAccountId">${mainAccounts.map((item) => `<option value="${item.id}">${esc(item.name)} · ${esc(item.currency)}</option>`).join('')}</select></label><label class="field savings-transfer-main-amount"><span>Сумма зачисления · ${esc(mainAccounts[0].currency)}</span><input name="mainAmount" type="number" min="0.000001" step="any" required></label><label class="field savings-transfer-date"><span>Дата</span><input name="date" type="date" value="${localIsoDate()}" required></label><button class="primary-button savings-transfer-submit" type="submit">Вывести</button></form>` : '<p class="reference-note">Для вывода добавьте хотя бы один счёт в каждом учёте.</p>'}</section>
    <section class="card currency-comparison savings-comparison"><h2>Изменение стоимости текущего остатка</h2></section>`;
  const comparison = content.querySelector('.savings-comparison');
  loadCurrencyComparison(comparison, 'savings');
}

function savingsHistoryTable(account) {
  const rows = [
    { date: account.createdDate, amount: account.initialCapital, kind: 'Начальный капитал', notes: 'Капитал на дату создания счёта', order: 0 },
    ...(account.movements || []).map((movement) => ({ ...movement, order: movement.id })),
  ].sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.order - a.order);
  return `<div class="table-wrap savings-history-table-scroll" role="region" aria-label="История счёта ${esc(account.name)}"><table><thead><tr><th>Дата</th><th>Тип</th><th>Заметка</th><th style="text-align:right">Сумма</th></tr></thead><tbody>${rows.map((item) => {
    const amount = Number(item.amount) || 0;
    const sign = amount > 0 ? '+' : amount < 0 ? '−' : '';
    const tone = amount > 0 ? 'positive' : amount < 0 ? 'negative' : '';
    const kindClass = item.kind === 'Инвестиция' ? 'investment' : item.kind === 'Перевод' ? 'transfer' : '';
    return `<tr><td class="muted">${dateLabel(item.date)}</td><td><span class="tag ${kindClass}">${esc(item.kind)}</span></td><td class="savings-history-note">${esc(item.notes || 'Без заметки')}</td><td class="savings-history-amount ${tone}">${sign}${money(Math.abs(amount), account.currency)}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}

function updateAccountPreview(row) {
  const currency = row.querySelector('[name="currency"]').value;
  const rate = currency === 'RUB' ? 1 : Number(row.querySelector('[name="rate"]').value) || 0;
  const calculated = row.querySelector('[data-account-calculated]');
  const rubEquivalent = row.querySelector('.account-rub-cell');
  const stored = accountById(row.dataset.accountRow);
  const preview = stored?.active ? stored.calculatedBalance : 0;
  const hasName = row.querySelector('[name="name"]').value.trim();
  if (calculated) calculated.textContent = hasName ? `${number(preview)} ${currency}` : `0 ${currency}`;
  if (rubEquivalent) rubEquivalent.textContent = hasName ? money(preview * rate) : money(0);
  const total = [...content.querySelectorAll('[data-account-row]')].reduce((sum, accountRow) => {
    const storedAccount = accountById(accountRow.dataset.accountRow);
    const rowCurrency = accountRow.querySelector('[name="currency"]').value;
    const rowRate = rowCurrency === 'RUB' ? 1 : Number(accountRow.querySelector('[name="rate"]').value) || 0;
    return sum + (storedAccount?.calculatedBalance || 0) * rowRate;
  }, 0);
  const totalDisplay = content.querySelector('.balance-hero strong');
  if (totalDisplay) totalDisplay.textContent = money(total);
  const equivalents = content.querySelector('[data-total-currency-equivalents]');
  if (equivalents) equivalents.innerHTML = cachedUsdEquivalent(total);
}

async function refreshRatesFromTopbar(button) {
  const labels = [...button.querySelectorAll('.desktop-label, .mobile-label')];
  const originalLabels = labels.map((label) => label.textContent);
  const totals = [...content.querySelectorAll('[data-rub-total]')];
  const originalTotals = totals.map((total) => total.textContent);
  button.disabled = true;
  labels.forEach((label) => { label.textContent = 'Обновляем…'; });
  totals.forEach((total) => { total.textContent = 'Загружаем курс…'; });
  try {
    // The forced request refreshes currencies for both ledgers in one batch.
    const mainData = await request('/api/balance/currency-comparison?refresh=true');
    const savingsData = await request('/api/balance/currency-comparison?ledger=savings');
    state.data = await request('/api/data');
    state.data.comparisons = {
      [`main:${localIsoDate()}`]: Promise.resolve(mainData),
      [`savings:${localIsoDate()}`]: Promise.resolve(savingsData),
    };
    render();
    const unavailable = [...new Set([...mainData.currencies, ...savingsData.currencies].filter((item) => item.error).map((item) => item.currency).concat(Object.keys(mainData.rateErrors || {}), Object.keys(savingsData.rateErrors || {})))];
    notify(unavailable.length ? `Не удалось обновить курсы: ${unavailable.join(', ')}.` : 'Курсы валют обновлены.', unavailable.length ? 'error' : '');
  } catch (error) { notify(error.message, 'error'); }
  finally {
    button.disabled = false;
    labels.forEach((label, index) => { label.textContent = originalLabels[index]; });
    totals.forEach((total, index) => {
      if (total.isConnected && total.textContent === 'Загружаем курс…') total.textContent = originalTotals[index];
    });
  }
}

async function updateAccountRate(row) {
  const currencySelect = row.querySelector('[name="currency"]');
  const rateInput = row.querySelector('[name="rate"]');
  const currency = currencySelect.value;
  rateInput.setCustomValidity('');
  if (!currency) {
    rateInput.value = '';
    rateInput.readOnly = false;
    rateInput.placeholder = 'Курс ЦБ';
    updateAccountPreview(row);
    return;
  }
  if (currency === 'RUB') {
    rateInput.value = 1;
    rateInput.readOnly = true;
    rateInput.placeholder = '1';
    rateInput.title = 'Для RUB курс всегда равен 1';
    updateAccountPreview(row);
    return;
  }
  rateInput.value = '';
  rateInput.readOnly = true;
  rateInput.placeholder = 'Загрузка…';
  updateAccountPreview(row);
  try {
    const result = await request(`/api/rates?currency=${encodeURIComponent(currency)}&date=${encodeURIComponent(localIsoDate())}`);
    if (currencySelect.value !== currency) return;
    rateInput.value = result.rate;
    rateInput.title = `ЦБ РФ на ${dateLabel(result.effectiveDate)}`;
  } catch (error) {
    if (currencySelect.value !== currency) return;
    rateInput.setCustomValidity(error.message);
    notify(error.message, 'error');
  } finally {
    if (currencySelect.value === currency) {
      rateInput.readOnly = true;
      rateInput.placeholder = 'Курс ЦБ';
      updateAccountPreview(row);
    }
  }
}

function renderLists() {
  const { categories, currencies, necessities, operationTypes, investmentCategories } = state.data.lists;
  const stringRows = (name, items) => `<div class="reference-rows" data-reference-list="${name}">${items.map((item) => `<div class="reference-row"><input value="${esc(item)}" required><button type="button" class="reference-remove" data-remove-reference title="Удалить">×</button></div>`).join('')}</div>`;
  content.innerHTML = `${pageHeader('Справочники', 'Редактирование листа «Списки» и мобильного меню')}
    <form id="lists-form">
      <div class="reference-grid">
        <article class="card reference-card reference-wide"><div class="card-head"><div><h2>Категории</h2><p>Эмодзи, название и тип операции</p></div><span>${categories.length}</span></div>
          <div class="reference-rows" data-reference-list="categories">${categories.map((item) => `<div class="reference-row category-reference-row"><input class="category-emoji-input" value="${esc(item.emoji)}" maxlength="16" aria-label="Эмодзи категории" placeholder="📌"><input class="category-name-input" value="${esc(item.name)}" required aria-label="Название категории"><select aria-label="Тип категории"><option ${item.type === 'Расход' ? 'selected' : ''}>Расход</option><option ${item.type === 'Доход' ? 'selected' : ''}>Доход</option></select><button type="button" class="reference-remove" data-remove-reference title="Удалить">×</button></div>`).join('')}</div>
          <button type="button" class="reference-add" data-add-reference="categories">+ Добавить категорию</button></article>
        <article class="card reference-card"><div class="card-head"><div><h2>Валюты</h2><p>Трёхбуквенные коды ЦБ РФ; RUB обязательна</p></div><span>${currencies.length}</span></div>${stringRows('currencies', currencies)}<button type="button" class="reference-add" data-add-reference="currencies">+ Добавить валюту</button></article>
        <article class="card reference-card"><div class="card-head"><div><h2>Необходимость</h2><p>Метки расходов</p></div><span>${necessities.length}</span></div>${stringRows('necessities', necessities)}<button type="button" class="reference-add" data-add-reference="necessities">+ Добавить значение</button></article>
        <article class="card reference-card system-reference"><div class="card-head"><div><h2>Типы операций</h2><p>Системные значения</p></div></div><div class="list-columns">${operationTypes.map((item) => `<div class="list-chip"><span>${esc(item)}</span><small>Защищено</small></div>`).join('')}</div><p class="reference-note">«Доход», «Расход», «Перевод» и «Инвестиция» встроены в расчёты приложения и не редактируются. Инвестиция доступна только в desktop-приложении.</p></article>
        <article class="card reference-card system-reference"><div class="card-head"><div><h2>Категории инвестиций</h2><p>Определяются типом накопительного счёта</p></div></div><div class="list-columns">${investmentCategories.map((item) => `<div class="list-chip"><span>${esc(item)}</span><small>Защищено</small></div>`).join('')}</div><p class="reference-note">Названия фиксированы и не редактируются. Категория выбирается автоматически по типу накопительного счёта.</p></article>
      </div>
      <div class="reference-actions"><p>Старые операции сохранят прежние значения. Перед записью будет создан бэкап, затем справочники отправятся в Syncthing.</p><button class="primary-button" type="submit">Сохранить справочники</button></div>
    </form>`;
}

function readPhoneSetupChecks() {
  try {
    const value = JSON.parse(localStorage.getItem(PHONE_CHECKS_KEY) || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch { return {}; }
}

function renderPhoneSetup() {
  const mobile = state.settings?.mobileLists || { state: 'unavailable', accountCount: 0 };
  const sync = state.settings?.sync || {};
  const checks = readPhoneSetupChecks();
  const checkedCount = ['syncthing', 'vault', 'plugin'].filter((key) => checks[key] === true).length;
  let statusTitle = 'Справочники ещё не опубликованы';
  let statusDescription = 'Подготовьте данные для телефона. Это не создаёт финансовую операцию.';
  let statusClass = 'setup-status-waiting';
  let nextStep = 'Нажмите «Подготовить данные для телефона», затем дождитесь синхронизации папки.';
  if (mobile.state === 'ready') {
    statusTitle = 'На компьютере подготовлены счета';
    statusDescription = `${mobile.accountCount} активных счетов и справочники записаны в папку Finance Sync.`;
    statusClass = 'setup-status-ready';
    nextStep = checkedCount < 2 ? 'Подключите папку Finance Sync на телефоне и добавьте её в хранилище Obsidian.' : 'Откройте форму Finance Capture в Obsidian и проверьте, что в ней видны счета.';
  } else if (mobile.state === 'no-accounts') {
    statusTitle = 'Сначала добавьте активный счёт';
    statusDescription = 'Мобильная форма не включится, пока в книге нет хотя бы одного активного счёта.';
    statusClass = 'setup-status-waiting';
    nextStep = 'Добавьте счёт на экране «Баланс», затем вернитесь сюда и подготовьте данные.';
  } else if (mobile.state === 'invalid') {
    statusTitle = 'Файл справочников не читается';
    statusDescription = 'Повторно подготовьте данные. Если сообщение останется, откройте диагностику ниже.';
    statusClass = 'setup-status-attention';
    nextStep = 'Нажмите «Подготовить данные для телефона».';
  } else if (mobile.state === 'unavailable') {
    statusTitle = 'Не удалось проверить папку синхронизации';
    statusDescription = 'Проверьте доступ к папке Finance Sync на компьютере.';
    statusClass = 'setup-status-attention';
    nextStep = 'Откройте папку синхронизации или раздел диагностики внизу страницы.';
  }
  if (sync.lastError || Number(sync.errors) > 0 || Number(sync.cleanupPending) > 0) {
    statusTitle = 'Синхронизация требует внимания';
    statusDescription = 'Последняя проверка обнаружила проблему. Desktop-приложение продолжает работать.';
    statusClass = 'setup-status-attention';
    nextStep = 'Посмотрите подробности последней проверки и устраните причину; затем подготовьте данные повторно.';
  }
  const lastCheck = sync.lastScanAt ? new Date(sync.lastScanAt).toLocaleString('ru-RU') : 'Пока не выполнялась';
  const updatedAt = mobile.modifiedAt ? new Date(mobile.modifiedAt).toLocaleString('ru-RU') : 'Файл пока не найден';
  content.innerHTML = `${pageHeader('Подключить телефон', 'Необязательная настройка · desktop работает и без телефона')}
    <section class="phone-ready-banner"><div><span class="phone-ready-kicker">DESKTOP ГОТОВ</span><h2>Продолжайте вести журнал на компьютере</h2><p>Подключение телефона можно завершить позже. Принятые с телефона операции импортируются в книгу только на этом компьютере.</p></div><div class="phone-banner-actions"><button class="secondary-button" type="button" data-phone-instructions>Открыть инструкцию</button><button class="secondary-button" type="button" data-phone-later>Продолжить позже</button></div></section>
    <div class="phone-setup-grid">
      <article class="card phone-status-card ${statusClass}"><div class="card-head"><div><h2>${esc(statusTitle)}</h2><p>${esc(statusDescription)}</p></div></div>
        <div class="phone-status-meta"><div><span>Последняя проверка на компьютере</span><strong>${esc(lastCheck)}</strong></div><div><span>Следующий шаг</span><strong>${esc(nextStep)}</strong></div></div>
        <div class="settings-actions settings-actions-wrap"><button class="primary-button" type="button" data-publish-mobile>Подготовить данные для телефона</button><button class="secondary-button" type="button" data-open-folder="sync">Открыть папку Finance Sync</button></div>
        <p class="phone-safe-note">Подготовка публикует справочники и балансы. Она не обрабатывает очередь операций и не создаёт финансовых записей.</p>
        <details class="phone-diagnostics"><summary>Показать расположение и диагностику</summary><div><p>Путь папки на компьютере</p><code>${esc(state.settings?.syncDirectory || 'Неизвестно')}</code><p>Справочники изменены</p><strong>${esc(updatedAt)}</strong>${sync.lastError ? `<p>Последняя ошибка</p><strong>${esc(sync.lastError)}</strong>` : ''}</div></details>
      </article>
      <article class="card phone-checklist-card"><div class="card-head"><div><h2>Шаги подключения</h2><p>Отметки сохраняются в этом браузере и служат только вашим списком дел.</p></div><span class="tag">${checkedCount} из 3</span></div>
        <progress class="phone-progress" max="3" value="${checkedCount}" aria-label="Отмечено шагов подключения"></progress>
        <label class="phone-check"><input type="checkbox" data-phone-check="syncthing" ${checks.syncthing === true ? 'checked' : ''}><span><strong>Syncthing работает на компьютере и телефоне</strong><small>Добавьте устройства и разрешите им синхронизировать одну папку.</small></span></label>
        <label class="phone-check"><input type="checkbox" data-phone-check="vault" ${checks.vault === true ? 'checked' : ''}><span><strong>Папка Finance Sync появилась внутри хранилища Obsidian</strong><small>Имя общей папки должно быть Finance Sync. На компьютере ей соответствует путь из диагностики.</small></span></label>
        <label class="phone-check"><input type="checkbox" data-phone-check="plugin" ${checks.plugin === true ? 'checked' : ''}><span><strong>Finance Capture установлен и включён</strong><small>Плагин нужен для создания операций в Obsidian; BRAT доставляет только плагин.</small></span></label>
      </article>
    </div>
    <article class="card phone-guide" id="phone-guide"><div class="card-head"><div><h2>Краткая инструкция</h2><p>Синхронизация переносит файлы, Finance на компьютере записывает принятые операции в Excel.</p></div></div>
      <div class="phone-guide-steps">
        <section><span class="phone-guide-number">01</span><div><h3>Подключите Syncthing</h3><ol class="phone-guide-list"><li>Запустите Syncthing на компьютере и телефоне, затем свяжите устройства.</li><li>На компьютере добавьте общую папку с меткой <strong>Finance Sync</strong>, укажите путь из диагностики выше и разрешите доступ телефону.</li><li>На телефоне примите папку и выберите расположение <strong>Finance Sync</strong> внутри хранилища Obsidian.</li></ol><a href="https://docs.syncthing.net/intro/gui.html" target="_blank" rel="noopener">Официальная инструкция Syncthing</a></div></section>
        <section><span class="phone-guide-number">02</span><div><h3>Установите beta-плагин через BRAT</h3><ol class="phone-guide-list"><li>В Obsidian установите и включите BRAT.</li><li>В BRAT добавьте beta-плагин по идентификатору ниже и установите доступный beta-релиз.</li><li>Включите <strong>Finance Capture</strong>. После синхронизации в форме должны появиться счета.</li></ol><div class="phone-repo-copy"><code>gmdveast/finance-capture</code><button class="secondary-button" type="button" data-copy-repo>Скопировать идентификатор</button></div><a href="https://github.com/TfTHacker/obsidian42-brat" target="_blank" rel="noopener">BRAT на GitHub</a></div></section>
      </div>
    </article>`;
}

function renderSettings() {
  const settings = state.settings;
  const sync = settings.sync || {};
  const updates = settings.updates || {};
  const settingRow = (label, value) => `<div class="setting-row"><span>${esc(label)}</span><strong title="${esc(value || '—')}">${esc(value || '—')}</strong></div>`;
  const updateInfo = state.updateCheck;
  const updateResult = state.updateInstallQueued
    ? '<p class="update-message">Установщик запущен. Завершите установку в его окне; Finance перезапустится после неё.</p>'
    : state.updateChecking
    ? '<p class="update-message">Проверяем опубликованные версии…</p>'
    : updateInfo?.error
      ? `<p class="update-message update-error">${esc(updateInfo.error)}</p>`
      : updateInfo?.enabled === false
        ? '<p class="update-message">Проверка обновлений доступна в установленной версии Finance.</p>'
        : updateInfo?.update
          ? `<p class="update-message">Доступна версия <strong>${esc(updateInfo.update.version)}</strong> (${updateInfo.update.channel === 'beta' ? 'beta' : 'стабильная'}).</p>${updateInfo.update.notes ? `<pre class="update-notes">${esc(updateInfo.update.notes)}</pre>` : ''}<div class="settings-actions settings-actions-wrap"><a class="secondary-button update-release-link" href="${esc(updateInfo.update.url)}" target="_blank" rel="noopener">Описание выпуска</a><button class="primary-button" type="button" data-install-update="${esc(updateInfo.update.version)}">Скачать и установить</button></div>`
          : updateInfo?.enabled
            ? '<p class="update-message">Установлена последняя доступная версия для этого канала.</p>'
            : '<p class="update-message">Проверка выполняется только по запросу. Финансовые данные при этом не отправляются.</p>';
  const channelLabel = updates.channel === 'beta' ? 'beta: beta и стабильные версии' : updates.channel === 'stable' ? 'стабильный: только стабильные версии' : 'сборка разработчика';
  const rollbackLabel = updates.rollbackVersion === 'legacy' ? 'предыдущую установленную версию' : `версию ${updates.rollbackVersion || ''}`;
  content.innerHTML = `${pageHeader('Настройки', 'Системные параметры приложения')}
    <div class="settings-grid">
      <article class="card settings-card"><div class="card-head"><div><h2>Excel и резервные копии</h2><p>Текущие локальные пути и состояние хранения</p></div></div>
        ${settingRow('Папка данных Finance', settings.dataDirectory)}${settingRow('Рабочая книга', settings.workbookPath)}${settingRow('Последнее изменение', new Date(settings.workbookModifiedAt).toLocaleString('ru-RU'))}${settingRow('Папка бэкапов', settings.backupDirectory)}${settingRow('Бэкапы', `${settings.backupCount} из ${settings.backupLimit}`)}${settingRow('Последний бэкап', settings.latestBackup)}
        <div class="settings-actions settings-actions-wrap"><button class="secondary-button" type="button" data-open-folder="data">Открыть папку данных</button><button class="secondary-button" type="button" data-open-folder="workbook">Открыть папку книги</button><button class="secondary-button" type="button" data-open-folder="backups">Открыть бэкапы</button><button class="danger-button" type="button" data-open-restore>Восстановить из бэкапа</button></div>
      </article>
      <article class="card settings-card settings-sync-card"><div class="card-head"><div><h2>Мобильная синхронизация</h2><p>Обработка на компьютере. Доставку на телефон выполняет Syncthing.</p></div><span class="tag sync-status ${sync.lastError ? 'required' : ''}">${sync.running ? 'Синхронизация…' : sync.lastError ? 'Требует внимания' : sync.lastScanAt ? 'Обработано на компьютере' : 'Ожидает обработки'}</span></div>
        ${settingRow('Папка Syncthing', settings.syncDirectory)}${settingRow('Последняя проверка', sync.lastScanAt ? new Date(sync.lastScanAt).toLocaleString('ru-RU') : 'Ещё не выполнялась')}${settingRow('Импортировано', sync.imported)}${settingRow('Дубликаты', sync.duplicates)}${settingRow('Ошибки', sync.errors)}${settingRow('Хранение квитанций', `${settings.receiptRetentionDays} дней`)}
        ${settingRow('Ожидают удаления', sync.cleanupPending ?? 0)}${sync.lastError ? settingRow('Последняя ошибка', sync.lastError) : ''}
        <div class="settings-actions settings-actions-wrap"><button class="secondary-button" type="button" data-open-folder="sync">Открыть папку Syncthing</button><button class="secondary-button" type="button" data-export-mobile>Обновить данные Obsidian</button></div>
      </article>
      <article class="card settings-card settings-update-card"><div class="card-head"><div><h2>Обновление Finance</h2><p>Версии устанавливаются отдельно от книги и пользовательских настроек.</p></div></div>
        ${settingRow('Текущая версия', updates.version || 'неизвестна')}${settingRow('Канал', channelLabel)}
        ${updateResult}
        <div class="settings-actions settings-actions-wrap"><button class="secondary-button" type="button" data-check-update ${state.updateChecking ? 'disabled' : ''}>Проверить обновления</button>${updates.rollbackVersion ? `<button class="danger-button" type="button" data-rollback-version="${esc(updates.rollbackVersion)}">Вернуть ${esc(rollbackLabel)}</button>` : ''}</div>
        <p class="update-plugin-note">Finance Capture обновляется отдельно: в Obsidian через BRAT запустите обновление beta-плагинов. Эта проверка desktop не меняет версию плагина. <a href="https://github.com/TfTHacker/obsidian42-brat" target="_blank" rel="noopener">BRAT</a> · <a href="https://github.com/gmdveast/finance-capture" target="_blank" rel="noopener">Finance Capture</a>.</p>
      </article>
    </div><article class="card settings-card reset-settings"><h2>Очистка данных</h2>${state.data.syncBlocked ? '<p class="reference-note">Импорт и выдача новых ID заблокированы: после восстановления требуется достоверный реестр синхронизации. Входящие файлы сохраняются.</p>' : ''}<p>Перед очисткой создаётся бэкап Excel. Мобильная очередь и связанные карточки также удаляются. Бэкапы и справочники сохраняются.</p><div class="settings-actions settings-actions-wrap"><button type="button" class="danger-button" data-clear-data="history">Удалить историю</button><button type="button" class="danger-button" data-clear-data="all">Полная очистка</button></div></article>`;
}

function render() {
  draftDirty = false;
  updateTopbarActions();
  document.querySelectorAll('.nav-item').forEach((button) => {
    const active = button.dataset.view === state.view;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  ({ overview: renderOverview, operations: renderOperations, balance: renderBalance, savings: renderSavings, lists: renderLists, phone: renderPhoneSetup, settings: renderSettings }[state.view] || renderOverview)();
}

function updateTopbarActions() {
  const refresh = document.querySelector('[data-action="refresh-rates"]');
  const addOperation = document.querySelector('[data-action="add-operation"]');
  if (refresh) refresh.hidden = !['balance', 'savings'].includes(state.view);
  if (addOperation) addOperation.hidden = ['phone', 'settings'].includes(state.view);
}

function populateOperationForm(type = 'Расход', savingsTransfer = '') {
  const categorySelect = operationForm.elements.category;
  categorySelect.innerHTML = state.data.lists.categories.filter((item) => item.type === type).map((item) => `<option value="${esc(item.name)}">${esc(categoryLabel(item.name))}</option>`).join('');
  const activeAccounts = accounts().filter((item) => item.active);
  const accountOptions = activeAccounts.map((item) => `<option value="${item.id}">${esc(item.name)} · ${esc(item.currency)}</option>`).join('');
  const savings = state.data.savingsAccounts || [];
  operationForm.elements.accountId.innerHTML = accountOptions;
  operationForm.elements.destinationAccountId.innerHTML = accountOptions;
  operationForm.elements.savingsAccountId.innerHTML = savings.map((item) => `<option value="${item.id}">${esc(item.name)} · ${esc(item.currency)}</option>`).join('');
  if (type === 'Перевод' && activeAccounts.length > 1) operationForm.elements.destinationAccountId.value = String(activeAccounts[1].id);
  operationForm.elements.currency.innerHTML = state.data.lists.currencies.map((item) => `<option>${esc(item)}</option>`).join('');
  operationForm.elements.necessity.innerHTML = state.data.lists.necessities.map((item) => `<option>${esc(item)}</option>`).join('');
  const transfer = type === 'Перевод';
  const investment = type === 'Инвестиция';
  const fromSavings = transfer && savingsTransfer === 'from-savings';
  const savingsMovement = investment || fromSavings;
  const linkedMovement = transfer || investment;
  operationForm.dataset.savingsDirection = fromSavings ? 'from-savings' : investment ? 'investment' : '';
  operationForm.elements.currency.closest('.field').hidden = linkedMovement;
  operationForm.querySelector('.rate-panel').hidden = transfer || investment;
  document.querySelector('#amount-label').textContent = linkedMovement ? 'Сумма списания' : 'Сумма';
  document.querySelector('#category-field').hidden = linkedMovement;
  categorySelect.required = !linkedMovement;
  document.querySelector('#investment-category-field').hidden = !investment;
  document.querySelector('#necessity-field').hidden = type !== 'Расход';
  document.querySelector('#destination-account-field').hidden = !transfer || fromSavings;
  document.querySelector('#investment-account-field').hidden = !savingsMovement;
  if (savingsMovement) document.querySelector('#investment-account-field span').textContent = fromSavings ? 'Счёт накопления · списание' : 'Счёт накопления · зачисление';
  document.querySelector('#destination-amount-field').hidden = !linkedMovement;
  operationForm.elements.destinationAccountId.required = transfer && !fromSavings;
  operationForm.elements.destinationAccountId.disabled = !transfer || fromSavings;
  operationForm.elements.savingsAccountId.required = savingsMovement;
  operationForm.elements.savingsAccountId.disabled = !savingsMovement;
  operationForm.elements.destinationAmount.required = linkedMovement;
  document.querySelector('#destination-amount-field span').textContent = investment ? 'Сумма зачисления' : 'Сумма зачисления';
  document.querySelector('#destination-amount-help').textContent = investment
    ? 'Сумму зачисления задайте вручную. Она не пересчитывается по курсу.'
    : 'Для перевода между разными валютами укажите фактически зачисленную сумму.';
  document.querySelector('#account-label').textContent = fromSavings ? 'Счёт зачисления' : type === 'Доход' ? 'Счёт зачисления' : 'Счёт списания';
  updateInvestmentCategory();
  syncOperationAccountCurrency(false);
}

function updateInvestmentCategory() {
  const saving = savingsAccountById(operationForm.elements.savingsAccountId.value);
  const category = saving?.type === 'Вклад' ? 'Вклад' : saving ? 'Отложенные' : '';
  document.querySelector('#investment-category-label').value = category;
}

function syncOperationAccountCurrency(fetchRate = true) {
  const fromSavings = operationForm.dataset.savingsDirection === 'from-savings';
  const account = fromSavings ? savingsAccountById(operationForm.elements.savingsAccountId.value) : accountById(operationForm.elements.accountId.value);
  if (!account) return;
  operationForm.elements.currency.value = account.currency;
  const type = operationForm.elements.type.value;
  if (type === 'Перевод' || type === 'Инвестиция') {
    document.querySelector('#amount-label').textContent = `Сумма списания · ${account.currency}`;
    const destination = fromSavings
      ? accountById(operationForm.elements.accountId.value)
      : type === 'Перевод'
        ? accountById(operationForm.elements.destinationAccountId.value)
      : savingsAccountById(operationForm.elements.savingsAccountId.value);
    const sameCurrency = destination?.currency === account.currency;
    const wasSameCurrency = operationForm.elements.destinationAmount.readOnly;
    operationForm.elements.destinationAmount.readOnly = sameCurrency;
    if (sameCurrency || wasSameCurrency || !operationForm.elements.destinationAmount.value) operationForm.elements.destinationAmount.value = sameCurrency ? operationForm.elements.amount.value : '';
    document.querySelector('#destination-amount-field span').textContent = destination ? `Сумма зачисления · ${destination.currency}` : 'Сумма зачисления';
  }
  updateRateUi(fetchRate);
}

function openOperation(operation = null) {
  operationForm.reset();
  operationForm.querySelector('input[name="type"][value="Инвестиция"]').disabled = !state.data.savingsAccounts?.length || (Boolean(operation) && operation.savingsTransfer !== 'investment');
  const type = operation?.type || 'Расход';
  operationForm.elements.type.value = type;
  populateOperationForm(type, operation?.savingsTransfer || '');
  operationForm.elements.id.value = operation?.id || '';
  operationForm.elements.date.value = operation?.date || localIsoDate();
  const formAccountId = operation?.savingsTransfer === 'from-savings' ? operation.destinationAccountId : operation?.accountId;
  if (formAccountId && !accountById(formAccountId)) operationForm.elements.accountId.insertAdjacentHTML('afterbegin', `<option value="${formAccountId}">Архивный счёт #${formAccountId}</option>`);
  if (!formAccountId && operation && operation.savingsTransfer !== 'from-savings') operationForm.elements.accountId.insertAdjacentHTML('afterbegin', '<option value="">Историческая операция — без счёта</option>');
  operationForm.elements.accountId.value = formAccountId || operationForm.elements.accountId.options[0]?.value || '';
  operationForm.elements.destinationAccountId.value = operation?.destinationAccountId || operationForm.elements.destinationAccountId.options[0]?.value || '';
  operationForm.elements.savingsAccountId.value = operation?.savingsAccountId || operationForm.elements.savingsAccountId.options[0]?.value || '';
  operationForm.elements.destinationAmount.value = operation?.type === 'Инвестиция' ? operation?.savingsAmount || '' : operation?.destinationAmount || '';
  operationForm.elements.category.value = operation?.category || operationForm.elements.category.options[0]?.value || '';
  operationForm.elements.amount.value = operation?.amount || '';
  operationForm.elements.currency.value = operation?.currency || accountById(operationForm.elements.accountId.value)?.currency || 'RUB';
  operationForm.elements.rate.value = operation?.rate || 1;
  operationForm.elements.necessity.value = operation?.necessity || 'Обязательная';
  operationForm.elements.notes.value = operation?.notes || '';
  operationForm.elements.destinationAmount.readOnly = false;
  updateInvestmentCategory();
  operationForm.querySelector('.type-switch').hidden = Boolean(operation);
  document.querySelector('#dialog-title').textContent = operation ? `Редактирование: ${operation.type}${operation.savingsTransfer === 'from-savings' ? ' из накоплений' : ''}` : 'Новая операция';
  syncOperationAccountCurrency(!operation);
  dialog.showModal();
}

let operationRateRequest = 0;
async function updateRateUi(fetchRate = true) {
  const requestId = ++operationRateRequest;
  if (operationForm.elements.type.value === 'Перевод') { operationForm.elements.rate.value = 1; return; }
  const currency = operationForm.elements.currency.value;
  const date = operationForm.elements.date.value;
  const manual = operationForm.elements.manualRate.checked;
  const rateInput = operationForm.elements.rate;
  const status = document.querySelector('#rate-status');
  if (currency === 'RUB') {
    rateInput.value = 1; rateInput.disabled = true; status.textContent = 'Для RUB курс равен 1'; return;
  }
  rateInput.disabled = !manual;
  if (manual) { status.textContent = 'Используется ваш курс'; rateInput.focus(); return; }
  if (!fetchRate || !date) { status.textContent = 'Курс сохранён в операции'; return; }
  status.textContent = 'Загружаем курс ЦБ РФ…';
  try {
    const result = await request(`/api/rates?currency=${encodeURIComponent(currency)}&date=${encodeURIComponent(date)}`);
    if (requestId !== operationRateRequest) return;
    rateInput.value = result.rate;
    status.textContent = `ЦБ РФ на ${dateLabel(result.effectiveDate)}${result.effectiveDate !== date ? ' — ближайший опубликованный' : ''}`;
  } catch (error) {
    if (requestId !== operationRateRequest) return;
    rateInput.disabled = false;
    operationForm.elements.manualRate.checked = true;
    status.textContent = error.message;
    notify(error.message, 'error');
  }
}

document.addEventListener('click', async (event) => {
  const savingsHistoryButton = event.target.closest('[data-savings-history]');
  if (savingsHistoryButton) {
    const account = (state.data?.savingsAccounts || []).find((item) => item.id === Number(savingsHistoryButton.dataset.savingsHistory));
    if (!account) { notify('Не удалось найти накопительный счёт. Обновите данные и повторите.', 'error'); return; }
    document.querySelector('#savings-history-title').textContent = `История: ${account.name}`;
    document.querySelector('#savings-history-balance').textContent = money(account.calculatedBalance, account.currency);
    document.querySelector('#savings-history-content').innerHTML = savingsHistoryTable(account);
    savingsHistoryDialog.showModal();
    return;
  }
  if (event.target.closest('[data-close-savings-history]')) { savingsHistoryDialog.close(); return; }
  const refreshRatesButton = event.target.closest('[data-action="refresh-rates"]');
  if (refreshRatesButton) { await refreshRatesFromTopbar(refreshRatesButton); return; }
  const clearOperationFilters = event.target.closest('#clear-operation-filters');
  if (clearOperationFilters) {
    state.operationMonth = localIsoDate().slice(0, 7); state.dateFrom = ''; state.dateTo = ''; state.operationType = 'Все';
    state.operationCategory = ''; state.operationAccount = ''; state.operationNecessity = ''; state.search = '';
    renderOperations();
    return;
  }
  const sortButton = event.target.closest('[data-sort-key]');
  if (sortButton) {
    const key = sortButton.dataset.sortKey;
    if (!['date', 'amount', 'category', 'account'].includes(key)) return;
    if (state.operationSort === key) state.operationSortDirection = state.operationSortDirection === 'asc' ? 'desc' : 'asc';
    else { state.operationSort = key; state.operationSortDirection = key === 'date' ? 'desc' : 'asc'; }
    renderOperations();
    content.querySelector(`[data-sort-key="${key}"]`)?.focus();
    return;
  }
  const operationsSection = event.target.closest('[data-operations-section]');
  if (operationsSection) { state.operationSection = operationsSection.dataset.operationsSection; renderOperations(); return; }
  const editOpening = event.target.closest('[data-edit-opening]');
  if (editOpening) {
    const form = content.querySelector('#opening-balance-form');
    const current = (state.data.openingBalances || []).find((item) => item.accountId === Number(editOpening.dataset.editOpening));
    if (form && current) { form.elements.accountId.value = current.accountId; form.elements.amount.value = current.amount; form.elements.date.value = current.date; form.elements.amount.focus(); }
    return;
  }
  const deleteSavings = event.target.closest('[data-delete-savings]');
  if (deleteSavings) {
    if (!confirm('Удалить этот накопительный счёт? Счёт с историей движения капитала удалить нельзя.')) return;
    deleteSavings.disabled = true;
    try { await request(`/api/savings/accounts/${deleteSavings.dataset.deleteSavings}`, { method: 'DELETE' }); state.data = await request('/api/data'); render(); notify('Накопительный счёт удалён.'); }
    catch (error) { notify(error.message, 'error'); deleteSavings.disabled = false; }
    return;
  }
  if (event.target.closest('[data-retry-comparison]')) { loadCurrencyComparison(event.target.closest('.currency-comparison'), state.view === 'savings' ? 'savings' : 'main', false); return; }
  const clearButton = event.target.closest('[data-clear-data]');
  if (clearButton) {
    const mode = clearButton.dataset.clearData;
    const phrase = mode === 'all' ? 'ПОЛНАЯ ОЧИСТКА' : 'УДАЛИТЬ ИСТОРИЮ';
    const explanation = mode === 'all' ? 'Будут удалены операции, оба вида счетов, начальные остатки и капитал накоплений. Справочники сохранятся.' : 'Будут удалены операции и движения накоплений. Оба вида счетов, начальные остатки и начальный капитал сохранятся.';
    if (prompt(`${explanation}\nМобильная очередь и карточки также будут удалены.\nДля подтверждения введите: ${phrase}`) !== phrase) return;
    clearButton.disabled = true;
    try {
      const result = await request('/api/settings/clear-data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode, confirmation: phrase }) });
      state.data = result.data; state.settings = await request('/api/settings'); render();
      const warning = [...(result.warnings || []), ...(result.cleanup.failures || [])].join('; ');
      notify(`Данные очищены. Бэкап: ${result.backup}.${warning ? ` Очистка синхронизации повторится: ${warning}` : ''}`);
    } catch (error) { notify(error.message, 'error'); clearButton.disabled = false; }
    return;
  }
  const checkUpdateButton = event.target.closest('[data-check-update]');
  if (checkUpdateButton) {
    state.updateChecking = true;
    state.updateCheck = null;
    renderSettings();
    try { state.updateCheck = await request('/api/updates/check'); }
    catch (error) { state.updateCheck = { error: error.message }; }
    finally { state.updateChecking = false; renderSettings(); }
    return;
  }
  const installUpdateButton = event.target.closest('[data-install-update]');
  if (installUpdateButton) {
    const version = installUpdateButton.dataset.installUpdate;
    if (!confirm(`Установить Finance ${version}? Приложение закроется на время установки и запустится снова после неё. Книга, настройки и очередь синхронизации хранятся отдельно от версии приложения.`)) return;
    installUpdateButton.disabled = true;
    installUpdateButton.textContent = 'Загружаю и проверяю…';
    try {
      await request('/api/updates/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version }) });
      state.updateInstallQueued = true;
      renderSettings();
      notify('Установщик запущен. Подтвердите установку в окне Finance; приложение откроется после завершения.');
    } catch (error) {
      notify(error.message, 'error');
      state.updateCheck = { error: error.message };
      renderSettings();
    }
    return;
  }
  const rollbackButton = event.target.closest('[data-rollback-version]');
  if (rollbackButton) {
    const version = rollbackButton.dataset.rollbackVersion;
    const label = version === 'legacy' ? 'предыдущую установленную версию' : `версию ${version}`;
    if (!confirm(`Вернуть ${label}? Finance штатно завершит текущие операции, переключится на сохранённую версию и перезапустится. Книга и настройки останутся прежними.`)) return;
    rollbackButton.disabled = true;
    try {
      await request('/api/updates/rollback', { method: 'POST' });
      notify('Finance закрывается и перезапускается на предыдущей версии.');
    } catch (error) {
      notify(error.message, 'error');
      rollbackButton.disabled = false;
    }
    return;
  }
  const viewButton = event.target.closest('[data-view]');
  if (viewButton) {
    if (['settings', 'phone'].includes(viewButton.dataset.view)) {
      try { state.settings = await request('/api/settings'); } catch (error) { notify(error.message, 'error'); }
    }
    navigateTo(viewButton.dataset.view);
    return;
  }
  if (event.target.closest('[data-phone-later]')) { navigateTo('overview'); return; }
  if (event.target.closest('[data-phone-instructions]')) { document.querySelector('#phone-guide')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
  if (event.target.closest('[data-copy-repo]')) {
    try { await navigator.clipboard.writeText('gmdveast/finance-capture'); notify('Идентификатор репозитория скопирован.'); }
    catch { notify('Не удалось скопировать. Выделите идентификатор и скопируйте вручную.', 'error'); }
    return;
  }
  if (event.target.closest('[data-action="add-operation"]')) { openOperation(); return; }
  if (event.target.closest('[data-action="close-dialog"]')) { dialog.close(); return; }
  const publishMobile = event.target.closest('[data-publish-mobile]');
  if (publishMobile) {
    const idleLabel = publishMobile.dataset.idleLabel || publishMobile.textContent;
    publishMobile.dataset.idleLabel = idleLabel;
    publishMobile.disabled = true;
    publishMobile.textContent = 'Подготовка…';
    try {
      const result = await request('/api/settings/publish-mobile', { method: 'POST' });
      state.settings = await request('/api/settings');
      if (state.view === 'phone') renderPhoneSetup();
      const parts = [];
      parts.push(result.listsPublished ? 'Справочники готовы для Syncthing.' : 'Не удалось опубликовать справочники.');
      parts.push(result.balancesPublished ? result.balancesChanged ? 'Балансы обновлены.' : 'Балансы без изменений.' : 'Не удалось обновить балансы.');
      if (result.warnings?.length) parts.push(result.warnings.join('; '));
      notify(parts.join(' '), result.ok ? '' : 'error');
    } catch (error) { notify(error.message, 'error'); }
    finally { publishMobile.disabled = false; publishMobile.textContent = idleLabel; }
    return;
  }
  const exportMobile = event.target.closest('[data-export-mobile]');
  if (exportMobile) {
    const idleLabel = exportMobile.dataset.idleLabel || exportMobile.textContent;
    exportMobile.dataset.idleLabel = idleLabel;
    exportMobile.disabled = true;
    exportMobile.textContent = 'Синхронизация…';
    try {
      const result = await request('/api/settings/export-mobile', { method: 'POST' });
      if (!Number.isInteger(result.imported) || typeof result.balancesPublished !== 'boolean') {
        throw new Error('Сервер использует старый формат синхронизации. Перезапустите desktop-приложение (сервер), затем обновите страницу и повторите синхронизацию.');
      }
      await loadData();
      const parts = [`Обработано на компьютере. Импортировано: ${result.imported}.`];
      if (result.duplicates) parts.push(`Уже были в Excel: ${result.duplicates}.`);
      if (result.discarded) parts.push(`Отклонено после сброса: ${result.discarded}.`);
      parts.push(!result.balancesPublished ? 'Не удалось опубликовать балансы.' : result.balancesChanged ? 'Балансы обновлены.' : 'Балансы без изменений.');
      if (result.changed) parts.push('Справочники обновлены.');
      if (result.errors) parts.push(`Ошибок импорта: ${result.errors}.`);
      if (result.cleanupPending) parts.push(`Ожидают удаления: ${result.cleanupPending}. Повторим автоматически.`);
      if (result.warnings?.length) parts.push(result.warnings.join('; '));
      notify(parts.join(' '), result.ok ? '' : 'error');
    } catch (error) { notify(error.message, 'error'); }
    finally { exportMobile.disabled = false; exportMobile.textContent = idleLabel; }
    return;
  }
  const openFolder = event.target.closest('[data-open-folder]');
  if (openFolder) {
    openFolder.disabled = true;
    try {
      await request('/api/settings/open-folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: openFolder.dataset.openFolder }) });
      notify('Запрос на открытие папки передан Проводнику.');
    } catch (error) { notify(error.message, 'error'); }
    finally { openFolder.disabled = false; }
    return;
  }
  if (event.target.closest('[data-open-restore]')) {
    const select = restoreForm.elements.backup;
    select.innerHTML = (state.settings.backups || []).map((backup) => `<option value="${esc(backup.name)}">${esc(new Date(backup.modifiedAt).toLocaleString('ru-RU'))} · ${number(backup.size / 1024, 0)} КБ · ${esc(backup.name)}</option>`).join('');
    restoreForm.querySelector('#restore-backup-details').textContent = select.options.length ? 'Перед восстановлением будет создана страховочная копия текущей книги.' : 'Доступных резервных копий нет.';
    restoreForm.querySelector('button[type="submit"]').disabled = !select.options.length;
    restoreDialog.showModal();
    return;
  }
  if (event.target.closest('[data-close-restore]')) { restoreDialog.close(); return; }
  const addReference = event.target.closest('[data-add-reference]');
  if (addReference) {
    const name = addReference.dataset.addReference;
    const rows = content.querySelector(`[data-reference-list="${name}"]`);
    const row = name === 'categories'
      ? '<div class="reference-row category-reference-row"><input class="category-emoji-input" value="📌" maxlength="16" aria-label="Эмодзи категории"><input class="category-name-input" value="" required placeholder="Название категории" aria-label="Название категории"><select aria-label="Тип категории"><option>Расход</option><option>Доход</option></select><button type="button" class="reference-remove" data-remove-reference title="Удалить">×</button></div>'
      : `<div class="reference-row"><input value="" required placeholder="${name === 'currencies' ? 'Код, например USD' : 'Новое значение'}"><button type="button" class="reference-remove" data-remove-reference title="Удалить">×</button></div>`;
    rows.insertAdjacentHTML('beforeend', row);
    rows.lastElementChild.querySelector(name === 'categories' ? '.category-name-input' : 'input').focus();
    return;
  }
  const removeReference = event.target.closest('[data-remove-reference]');
  if (removeReference) { removeReference.closest('.reference-row').remove(); return; }
  const addAccount = event.target.closest('[data-add-account]');
  if (addAccount) {
    const body = content.querySelector('.accounts-table tbody');
    body.insertAdjacentHTML('beforeend', accountRowHtml());
    const row = body.lastElementChild;
    prepareAccountRow(row);
    row.querySelector('[name="name"]').focus();
    return;
  }
  const removeNewAccount = event.target.closest('[data-remove-new-account]');
  if (removeNewAccount) { removeNewAccount.closest('[data-account-row]').remove(); return; }
  const deleteAccount = event.target.closest('[data-delete-account]');
  if (deleteAccount) {
    const account = accountById(deleteAccount.dataset.deleteAccount);
    if (!confirm(`Удалить счёт «${account?.name || 'Без названия'}»? Счёт с операциями удалить нельзя.`)) return;
    deleteAccount.disabled = true;
    try {
      const result = await request(`/api/accounts/${deleteAccount.dataset.deleteAccount}`, { method: 'DELETE' });
      state.data = result.data; render(); notify(`Счёт удалён. Бэкап: ${result.backup}. Список Obsidian обновлён.`);
    } catch (error) { notify(error.message, 'error'); deleteAccount.disabled = false; }
    return;
  }
  const edit = event.target.closest('[data-edit]');
  if (edit) { openOperation(state.data.operations.find((item) => item.id === Number(edit.dataset.edit))); return; }
  const remove = event.target.closest('[data-delete]');
  const removingOperation = remove && state.data.operations.find((item) => item.id === Number(remove.dataset.delete));
  const confirmation = removingOperation?.savingsTransfer === 'from-savings'
    ? 'Удалить перевод из накоплений? Движение в накопительном счёте и зачисление на обычный счёт будут отменены. Перед удалением будет создан бэкап.'
    : removingOperation?.savingsTransfer === 'investment'
      ? 'Удалить инвестицию? Расход обычного счёта и движение накоплений будут отменены. Перед удалением будет создан бэкап.'
      : 'Удалить эту операцию из Excel? Перед удалением будет создан бэкап.';
  if (remove && confirm(confirmation)) {
    try {
      const result = await request(`/api/operations/${remove.dataset.delete}`, { method: 'DELETE' });
      state.data = result.data; render(); notify(`${removingOperation?.savingsTransfer === 'from-savings' ? 'Перевод удалён, движение средств отменено' : removingOperation?.savingsTransfer === 'investment' ? 'Инвестиция удалена, движение средств отменено' : 'Операция удалена'}. Бэкап: ${result.backup}`);
    } catch (error) { notify(error.message, 'error'); }
  }
});

document.addEventListener('change', (event) => {
  const checkbox = event.target.closest('[data-phone-check]');
  if (!checkbox) return;
  const checks = readPhoneSetupChecks();
  checks[checkbox.dataset.phoneCheck] = checkbox.checked;
  try { localStorage.setItem(PHONE_CHECKS_KEY, JSON.stringify(checks)); } catch {}
  const checkedCount = ['syncthing', 'vault', 'plugin'].filter((key) => checks[key] === true).length;
  const progress = content.querySelector('.phone-progress');
  if (progress) progress.value = checkedCount;
  const count = content.querySelector('.phone-checklist-card .card-head .tag');
  if (count) count.textContent = `${checkedCount} из 3`;
});

document.querySelector('#mobile-menu').addEventListener('click', () => document.querySelector('.sidebar').classList.toggle('open'));

content.addEventListener('change', async (event) => {
  const accountRow = event.target.closest?.('[data-account-row]');
  if (accountRow && event.target.matches('[name="currency"]')) await updateAccountRate(accountRow);
  const currencyList = event.target.closest?.('[data-reference-list="currencies"]');
  if (currencyList && event.target.matches('input')) {
    const input = event.target;
    const currency = input.value.trim().toUpperCase();
    input.value = currency;
    input.setCustomValidity('');
    if (currency && currency !== 'RUB') {
      try {
        await request(`/api/rates?currency=${encodeURIComponent(currency)}&date=${encodeURIComponent(localIsoDate())}`);
      } catch (error) {
        input.setCustomValidity(error.message);
        alert(error.message);
        input.focus();
      }
    }
  }
  if (event.target.id === 'month-picker') { state.month = event.target.value; render(); }
  if (event.target.id === 'operation-month') { state.operationMonth = event.target.value; state.dateFrom = ''; state.dateTo = ''; renderOperations(); }
  if (event.target.id === 'operation-date-from' || event.target.id === 'operation-date-to') {
    state.operationMonth = '';
    state.dateFrom = content.querySelector('#operation-date-from')?.value || '';
    state.dateTo = content.querySelector('#operation-date-to')?.value || '';
    renderOperations();
  }
  if (event.target.id === 'operation-type') { state.operationType = event.target.value; renderOperations(); }
  if (event.target.id === 'operation-category') { state.operationCategory = event.target.value; renderOperations(); }
  if (event.target.id === 'operation-account') { state.operationAccount = event.target.value; renderOperations(); }
  if (event.target.id === 'operation-necessity') { state.operationNecessity = event.target.value; renderOperations(); }
});
content.addEventListener('input', (event) => {
  const accountRow = event.target.closest?.('[data-account-row]');
  if (accountRow && event.target.matches('[name="rate"], [name="name"]')) updateAccountPreview(accountRow);
  if (event.target.id === 'operation-search') {
    state.search = event.target.value;
    const cursor = event.target.selectionStart;
    renderOperations();
    const input = document.querySelector('#operation-search'); input.focus(); input.setSelectionRange(cursor, cursor);
  }
});

operationForm.addEventListener('change', (event) => {
  if (event.target.name === 'type') populateOperationForm(event.target.value);
  if (event.target.name === 'accountId' || event.target.name === 'destinationAccountId' || event.target.name === 'savingsAccountId') {
    updateInvestmentCategory();
    syncOperationAccountCurrency(true);
  }
  if (['date', 'manualRate'].includes(event.target.name)) updateRateUi(true);
});

operationForm.addEventListener('input', (event) => {
  if (event.target.name === 'amount' && ['Перевод', 'Инвестиция'].includes(operationForm.elements.type.value)) syncOperationAccountCurrency(false);
});

operationForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = document.querySelector('#save-operation');
  button.disabled = true; button.textContent = 'Сохраняем…';
  const formData = new FormData(operationForm);
  const payload = Object.fromEntries(formData.entries());
  payload.rate = operationForm.elements.rate.value;
  payload.currency = operationForm.elements.currency.value;
  const id = payload.id; delete payload.id; delete payload.manualRate;
  try {
    const result = await request(id ? `/api/operations/${id}` : '/api/operations', { method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    state.data = result.data; dialog.close(); render(); notify(`Сохранено в Excel. Бэкап: ${result.backup}`);
  } catch (error) { notify(error.message, 'error'); }
  finally { button.disabled = false; button.textContent = 'Сохранить в Excel'; }
});

content.addEventListener('submit', async (event) => {
  if (event.target.id === 'opening-balance-form') {
    event.preventDefault();
    const form = event.target;
    const button = form.querySelector('button[type="submit"]'); button.disabled = true;
    try {
      const result = await request('/api/operations/opening-balance', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      state.data = result.data; render(); notify('Начальный баланс счёта сохранён и заменил прежнее значение.');
    } catch (error) { notify(error.message, 'error'); button.disabled = false; }
    return;
  }
  if (event.target.id === 'savings-create-form') {
    event.preventDefault();
    const form = event.target, button = form.querySelector('button[type="submit"]'); button.disabled = true;
    try { await request('/api/savings/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(form))) }); state.data = await request('/api/data'); render(); notify('Накопительный счёт создан.'); }
    catch (error) { notify(error.message, 'error'); button.disabled = false; }
    return;
  }
  const increaseForm = event.target.closest('[data-savings-increase]');
  if (increaseForm) {
    event.preventDefault();
    const button = increaseForm.querySelector('button[type="submit"]'); button.disabled = true;
    try { await request(`/api/savings/accounts/${increaseForm.dataset.savingsIncrease}/increase`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(increaseForm))) }); state.data = await request('/api/data'); render(); notify('Изменение капитала сохранено.'); }
    catch (error) { notify(error.message, 'error'); button.disabled = false; }
    return;
  }
  if (event.target.id === 'savings-transfer-form') {
    event.preventDefault();
    const form = event.target, button = form.querySelector('button[type="submit"]'); button.disabled = true;
    try { await request('/api/savings/transfers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(form))) }); state.data = await request('/api/data'); render(); notify('Перевод сохранён в обоих учётах.'); }
    catch (error) { notify(error.message, 'error'); button.disabled = false; }
    return;
  }
  if (event.target.id === 'lists-form') {
    event.preventDefault();
    const form = event.target;
    const values = (name) => [...form.querySelectorAll(`[data-reference-list="${name}"] input`)].map((input) => input.value.trim()).filter(Boolean);
    const categories = [...form.querySelectorAll('[data-reference-list="categories"] .reference-row')].map((row) => ({
      name: row.querySelector('.category-name-input').value.trim(), emoji: row.querySelector('.category-emoji-input').value.trim(), type: row.querySelector('select').value,
    })).filter((item) => item.name);
    const payload = { categories, currencies: values('currencies'), paymentMethods: state.data.lists.paymentMethods, necessities: values('necessities') };
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true; button.textContent = 'Сохраняем…';
    try {
      const result = await request('/api/lists', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      state.data = result.data; render();
      const syncNote = result.mobileLists?.warning ? ` Синхронизация повторится автоматически: ${result.mobileLists.warning}` : ' Мобильные справочники обновлены.';
      notify(`Справочники сохранены. Бэкап: ${result.backup}.${syncNote}`);
    } catch (error) {
      if (error.message.includes('справочнике ЦБ РФ')) alert(error.message);
      notify(error.message, 'error'); button.disabled = false; button.textContent = 'Сохранить справочники';
    }
    return;
  }
  if (event.target.id !== 'accounts-form') return;
  event.preventDefault();
  const button = event.target.querySelector('button[type="submit"]');
  button.disabled = true; button.textContent = 'Сохраняем…';
  const submittedAccounts = [...event.target.querySelectorAll('[data-account-row]')].map((row) => ({
    id: row.dataset.accountRow ? Number(row.dataset.accountRow) : null, name: row.querySelector('[name="name"]').value, currency: row.querySelector('[name="currency"]').value,
    rate: row.querySelector('[name="rate"]').value,
  }));
  try {
    const result = await request('/api/accounts', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accounts: submittedAccounts }) });
    state.data = result.data; render();
    const syncNote = result.mobileLists?.warning ? ` Syncthing: ${result.mobileLists.warning}` : ' Список счетов Obsidian обновлён.';
    notify(`Счета сохранены. Бэкап: ${result.backup}.${syncNote}`);
  } catch (error) { notify(error.message, 'error'); button.disabled = false; button.textContent = 'Сохранить изменения'; }
});

content.addEventListener('input', (event) => {
  const form = event.target.closest('#savings-transfer-form');
  if (!form) return;
  const mainCurrency = accountById(form.elements.mainAccountId.value)?.currency;
  const savingsCurrency = savingsAccountById(form.elements.savingAccountId.value)?.currency;
  form.elements.mainAmount.closest('.field').querySelector('span').textContent = `Сумма основного счёта · ${mainCurrency || ''}`;
  form.elements.savingAmount.closest('.field').querySelector('span').textContent = `Сумма накопительного счёта · ${savingsCurrency || ''}`;
  if (mainCurrency !== savingsCurrency) return;
  if (event.target.name === 'mainAmount') form.elements.savingAmount.value = event.target.value;
  if (event.target.name === 'savingAmount') form.elements.mainAmount.value = event.target.value;
});
content.addEventListener('change', (event) => {
  const form = event.target.closest('#savings-transfer-form');
  if (!form) return;
  const mainCurrency = accountById(form.elements.mainAccountId.value)?.currency;
  const savingsCurrency = savingsAccountById(form.elements.savingAccountId.value)?.currency;
  form.elements.mainAmount.closest('.field').querySelector('span').textContent = `Сумма основного счёта · ${mainCurrency || ''}`;
  form.elements.savingAmount.closest('.field').querySelector('span').textContent = `Сумма накопительного счёта · ${savingsCurrency || ''}`;
  if (mainCurrency === savingsCurrency) {
    if (form.elements.savingAmount.value) form.elements.mainAmount.value = form.elements.savingAmount.value;
    else if (form.elements.mainAmount.value) form.elements.savingAmount.value = form.elements.mainAmount.value;
  }
});

restoreForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const backup = restoreForm.elements.backup.value;
  if (!backup || !confirm(`Восстановить Excel из «${backup}»? Текущее состояние будет предварительно сохранено отдельным бэкапом. Необработанные мобильные события, созданные до восстановления, будут отброшены.`)) return;
  const button = restoreForm.querySelector('button[type="submit"]');
  button.disabled = true; button.textContent = 'Восстанавливаем…';
  try {
    const response = await request('/api/settings/restore-backup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ backup }) });
    state.data = response.result.data;
    state.settings = await request('/api/settings');
    restoreDialog.close(); render();
    notify(`Книга восстановлена. Страховочный бэкап: ${response.result.safetyBackup}. ${(response.result.warnings || []).join(" ")}`);
  } catch (error) { notify(error.message, 'error'); }
  finally { button.disabled = false; button.textContent = 'Восстановить'; }
});

let draggedAccount = null;
let orderingAccounts = false;
async function saveAccountOrder() {
  orderingAccounts = true;
  const ids = [...content.querySelectorAll('[data-account-row]')].map((row) => Number(row.dataset.accountRow));
  try {
    const result = await request('/api/accounts/order', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
    state.data = result.data;
    notify(result.warning || 'Порядок счетов сохранён и передан в Obsidian.');
  } catch (error) {
    const body = content.querySelector('.accounts-table tbody');
    for (const account of accounts()) { const row = body?.querySelector(`[data-account-row="${account.id}"]`); if (row) body.append(row); }
    notify(error.message, 'error');
  } finally { orderingAccounts = false; }
}
content.addEventListener('dragstart', (event) => {
  if (!event.target.closest('.account-drag-handle')) return;
  if (orderingAccounts || content.querySelector('.new-account-row')) { event.preventDefault(); notify('Сначала сохраните новые счета.'); return; }
  draggedAccount = event.target.closest('[data-account-row]');
  event.dataTransfer.setData('text/plain', draggedAccount.dataset.accountRow);
  event.dataTransfer.effectAllowed = 'move';
});
content.addEventListener('dragover', (event) => { if (draggedAccount && event.target.closest('[data-account-row]')) event.preventDefault(); });
content.addEventListener('drop', (event) => {
  const target = event.target.closest('[data-account-row]');
  if (!draggedAccount || !target || target === draggedAccount) return;
  event.preventDefault();
  const after = event.clientY > target.getBoundingClientRect().top + target.getBoundingClientRect().height / 2;
  target.parentElement.insertBefore(draggedAccount, after ? target.nextSibling : target);
  draggedAccount = null; saveAccountOrder();
});
content.addEventListener('dragend', () => { draggedAccount = null; });
const regionFocus = { sidebar: null, main: null };
document.addEventListener('focusin', (event) => {
  if (event.target.closest('.sidebar')) regionFocus.sidebar = event.target;
  else if (event.target.closest('.main')) regionFocus.main = event.target;
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'F6' && !document.querySelector('dialog[open]')) {
    event.preventDefault();
    const targetRegion = event.target.closest?.('.sidebar') ? 'main' : 'sidebar';
    const remembered = regionFocus[targetRegion];
    const fallback = targetRegion === 'sidebar' ? document.querySelector('.nav-item.active') : content.querySelector('button, input, select, [tabindex="0"]') || content;
    (remembered?.isConnected ? remembered : fallback)?.focus();
    return;
  }
  if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key) && event.target.closest?.('.account-drag-handle')) {
    event.preventDefault();
    if (orderingAccounts || content.querySelector('.new-account-row')) return;
    const row = event.target.closest('[data-account-row]');
    const sibling = event.key === 'ArrowUp' ? row.previousElementSibling : row.nextElementSibling;
    if (sibling) { row.parentElement.insertBefore(row, event.key === 'ArrowUp' ? sibling : sibling.nextSibling); event.target.focus(); saveAccountOrder(); }
    return;
  }
  const navItem = event.target.closest?.('.nav-item');
  if (navItem && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const items = [...document.querySelectorAll('.nav-item')];
    const current = items.indexOf(navItem);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next].focus();
    return;
  }
  const row = event.target.closest?.('[data-keyboard-row]');
  if (!row || event.target !== row) return;
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    event.preventDefault();
    const rows = [...row.closest('tbody').querySelectorAll('[data-keyboard-row]')];
    const next = Math.max(0, Math.min(rows.length - 1, rows.indexOf(row) + (event.key === 'ArrowDown' ? 1 : -1)));
    rows[next].focus();
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    if (row.dataset.operationRow) { const operation = state.data.operations.find((item) => item.id === Number(row.dataset.operationRow)); if (operation) openOperation(operation); }
    else row.querySelector('[name="name"]')?.focus();
  }
});

function syncViewFromLocation() {
  const view = location.hash.slice(1);
  if (VIEWS.includes(view) && view !== state.view) {
    state.view = view;
    updateTopbarActions();
    try { localStorage.setItem('finance-view', view); } catch {}
    if (['settings', 'phone'].includes(view)) request('/api/settings').then((settings) => { state.settings = settings; if (state.view === view) render(); }).catch((error) => notify(error.message, 'error'));
    if (state.data) { render(); refreshIfStale(); }
  }
}

async function refreshPhoneStatus() {
  if (state.view !== 'phone' || document.hidden || document.activeElement?.matches('[data-phone-check]')) return;
  try {
    state.settings = await request('/api/settings');
    if (state.view === 'phone') renderPhoneSetup();
  } catch (error) { notify(error.message, 'error'); }
}

window.addEventListener('popstate', syncViewFromLocation);
window.addEventListener('hashchange', syncViewFromLocation);
if (!VIEWS.includes(location.hash.slice(1))) navigateTo(state.view, { replace: true });
updateTopbarActions();

document.querySelectorAll('.nav-item').forEach((button) => { const active = button.dataset.view === state.view; button.classList.toggle('active', active); if (active) button.setAttribute('aria-current', 'page'); });
content.tabIndex = -1;
content.querySelector('.loading-card p').textContent = `Загружаем: ${{ overview: 'Обзор', operations: 'Операции', balance: 'Баланс', savings: 'Накопления', lists: 'Справочники', phone: 'Подключение телефона', settings: 'Настройки' }[state.view]}…`;
setInterval(() => { refreshIfStale(); refreshPhoneStatus(); }, 15000);
window.addEventListener('focus', refreshIfStale);
document.addEventListener('visibilitychange', refreshIfStale);

loadData().catch((error) => { content.innerHTML = `<div class="empty-state"><h2>Не удалось открыть таблицу</h2><p>${esc(error.message)}</p></div>`; });
