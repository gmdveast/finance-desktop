const { MarkdownRenderChild, Modal, Notice, Plugin, PluginSettingTab, Setting, normalizePath } = require('obsidian');

// BEGIN GENERATED INPUT VALIDATION
class InputError extends Error {
  constructor(message, status = 400, code = 'VALIDATION') { super(message); this.status = status; this.code = code; }
}
const invalid = (message) => { throw new InputError(message); };
function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Ожидается объект JSON.');
  return value;
}
function textField(value, max, label, { optional = false } = {}) {
  if (value === undefined && optional) return '';
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) invalid(`Некорректное поле «${label}» (до ${max} символов).`);
  return value.trim();
}
function calendarDate(value, minimumYear = 1900) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < minimumYear || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}
function timestamp(value) {
  if (typeof value !== 'string') return false;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/);
  return Boolean(match && calendarDate(match[1]) && +match[2] < 24 && +match[3] < 60 && +match[4] < 60
    && (match[5] === 'Z' || (+match[6] <= 14 && +match[7] < 60 && (+match[6] < 14 || +match[7] === 0))) && Number.isFinite(Date.parse(value)));
}
function numberField(value, { min = 0, max = 1e8, decimals = 6, positive = false, label = 'Сумма' } = {}) {
  if (typeof value !== 'number' && typeof value !== 'string') invalid(`Некорректное поле «${label}».`);
  if (typeof value === 'string' && !/^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) invalid(`Некорректное поле «${label}».`);
  const number = Number(typeof value === 'string' ? value.replace(',', '.') : value);
  const [mantissa, exponent = '0'] = String(Math.abs(number)).toLowerCase().split('e');
  const fractional = Math.max(0, (mantissa.split('.')[1]?.length || 0) - Number(exponent));
  const significant = mantissa.replace('.', '').replace(/^0+/, '').length;
  if (!Number.isFinite(number) || number < min || number > max || (positive && number <= 0) || fractional > decimals || significant > 15) invalid(`Некорректное поле «${label}»: диапазон ${min}…${max}, до ${decimals} знаков после запятой.`);
  return number;
}
const rateField = (value) => numberField(value, { min: 1e-12, max: 1e6, decimals: 12, label: 'Курс' });
function rowId(value, { optional = false, max = 104, min = 5 } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return null;
  if (!['number', 'string'].includes(typeof value) || !/^\d+$/.test(String(value)) || !Number.isInteger(Number(value)) || +value < min || +value > max) invalid('Некорректный ID счёта/строки.');
  return +value;
}
// END GENERATED INPUT VALIDATION

function amountInputParts(value, decimalPointIndex = -1, dotsAsGroups = false) {
  let source = String(value ?? '').replace(/[\s\u00a0\u202f]/g, '');
  if (Number.isInteger(decimalPointIndex) && source[decimalPointIndex] === '.') {
    source = `${source.slice(0, decimalPointIndex)},${source.slice(decimalPointIndex + 1)}`;
  }

  let decimalIndex = source.lastIndexOf(',');
  if (decimalIndex === -1 && !dotsAsGroups) {
    const dots = [...source.matchAll(/\./g)];
    if (dots.length === 1) {
      const dotIndex = dots[0].index;
      const wholeDigits = source.slice(0, dotIndex).replace(/\D/g, '');
      const fractionDigits = source.slice(dotIndex + 1).replace(/\D/g, '');
      // A single dot followed by one or two digits is a pasted decimal value.
      // The formatter itself always uses groups of three digits after a dot.
      if (wholeDigits && fractionDigits.length > 0 && fractionDigits.length < 3) {
        source = `${source.slice(0, dotIndex)},${source.slice(dotIndex + 1)}`;
        decimalIndex = dotIndex;
      }
    }
  }

  const hasDecimal = decimalIndex !== -1;
  const whole = (hasDecimal ? source.slice(0, decimalIndex) : source).replace(/\D/g, '').replace(/^0+(?=\d)/, '');
  const fraction = hasDecimal ? source.slice(decimalIndex + 1).replace(/\D/g, '') : '';
  return { whole, fraction, hasDecimal, normalized: source };
}

function formatAmountInputValue(value, decimalPointIndex = -1, dotsAsGroups = false) {
  const { whole, fraction, hasDecimal } = amountInputParts(value, decimalPointIndex, dotsAsGroups);
  if (!whole && !fraction && !hasDecimal) return '';
  const integer = (whole || (hasDecimal ? '0' : '')).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${integer}${hasDecimal ? `,${fraction}` : ''}`;
}

function parseAmountInputValue(value) {
  const { whole, fraction, hasDecimal } = amountInputParts(value);
  const normalized = `${whole || '0'}${hasDecimal ? `.${fraction}` : ''}`;
  return Number(normalized);
}

function amountInputCaret(value, caret, formatted) {
  if (!Number.isInteger(caret)) return formatted.length;
  const prefix = value.slice(0, caret);
  const decimalIndex = prefix.lastIndexOf(',');
  if (decimalIndex !== -1) {
    const fractionDigits = (prefix.slice(decimalIndex + 1).match(/\d/g) || []).length;
    const formattedDecimalIndex = formatted.indexOf(',');
    return formattedDecimalIndex === -1 ? formatted.length : formattedDecimalIndex + 1 + fractionDigits;
  }
  const digitCount = (prefix.match(/\d/g) || []).length;
  if (digitCount === 0) return 0;
  let seen = 0;
  for (let index = 0; index < formatted.length; index += 1) {
    if (/\d/.test(formatted[index]) && ++seen === digitCount) return index + 1;
  }
  return formatted.length;
}

function configureAmountInput(field, value, onChange) {
  const input = field.inputEl;
  input.type = 'text';
  input.inputMode = 'decimal';
  input.placeholder = '0,00';
  input.addEventListener?.('input', (event) => {
    if (event.isComposing) return;
    const rawValue = input.value;
    const caret = input.selectionStart;
    const decimalPointIndex = event.data === '.' && Number.isInteger(caret) ? caret - 1 : -1;
    const dotsAsGroups = String(event.inputType || '').startsWith('delete');
    const formatted = formatAmountInputValue(rawValue, decimalPointIndex, dotsAsGroups);
    if (input.value === formatted) return;
    const nextCaret = amountInputCaret(amountInputParts(rawValue, decimalPointIndex, dotsAsGroups).normalized, caret, formatted);
    input.value = formatted;
    if (Number.isInteger(caret)) input.setSelectionRange?.(nextCaret, nextCaret);
  });
  field.setValue(formatAmountInputValue(value)).onChange(onChange);
}

const DEFAULT_SETTINGS = {
  author: 'owner',
  syncRoot: 'Finance Sync',
  recordsSubfolder: 'operations',
  recordLinks: {},
};

const RECORD_PENDING_PREFIX = '1 — В очереди — ';
const RECORD_ARCHIVED_PREFIX = '2 — Архив — ';
const FALLBACK_CATEGORY_EMOJIS = { 'Жильё и аренда': '🏠', 'Коммунальные услуги': '💡', 'Продукты': '🛒', 'Кафе и доставка': '🍽️', 'Транспорт': '🚕', 'Связь и интернет': '📶', 'Здоровье и аптека': '💊', 'Спорт и зал': '🏋️', 'Бытовые покупки': '🧹', 'Одежда и личное': '👕', 'Подписки и сервисы': '📱', 'Виза и документы': '📄', 'Путешествия': '✈️', 'Развлечения': '🎬', 'Подарки и помощь': '🎁', 'Комиссии и обмен валюты': '💱', 'Прочее': '📦', 'Работа / зарплата': '💼', 'Фриланс / подработки': '💻', 'Возврат / компенсация': '↩️', 'Прочие доходы': '💰' };

const CATEGORIES = {
  Расход: ['Жильё и аренда', 'Коммунальные услуги', 'Продукты', 'Кафе и доставка', 'Транспорт', 'Связь и интернет', 'Здоровье и аптека', 'Спорт и зал', 'Бытовые покупки', 'Одежда и личное', 'Подписки и сервисы', 'Виза и документы', 'Путешествия', 'Развлечения', 'Подарки и помощь', 'Комиссии и обмен валюты', 'Прочее'],
  Доход: ['Работа / зарплата', 'Фриланс / подработки', 'Возврат / компенсация', 'Прочие доходы'],
};
const CURRENCIES = ['RUB', 'VND', 'USD', 'GEL', 'THB', 'IDR', 'EUR'];
const NECESSITIES = ['Обязательная', 'Гибкая'];
const FALLBACK_LISTS = { categories: CATEGORIES, currencies: CURRENCIES, necessities: NECESSITIES, operationTypes: ['Расход', 'Доход', 'Перевод'], accounts: [] };

function localDate() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60000;
  return new Date(now - offset).toISOString().slice(0, 10);
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value ?? '').trim()).filter(Boolean))];
}

function normalizeMobileLists(payload) {
  if (payload !== null && payload?.schema !== 1) throw new Error('Неподдерживаемая версия списков. Обновите desktop и плагин.');
  if (payload && (!payload.lists || typeof payload.lists !== 'object' || Array.isArray(payload.lists))) throw new Error('Некорректные списки.');
  const lists = payload?.lists;
  for (const key of ['categories', 'currencies', 'necessities', 'operationTypes', 'accounts']) {
    if (lists?.[key] !== undefined && (!Array.isArray(lists[key]) || lists[key].length > (key === 'accounts' ? 100 : 200))) throw new Error('Некорректный размер списка.');
  }
  for (const item of lists?.categories || []) {
    if (!textField(item?.name, 100, 'Категория') || !['Доход', 'Расход'].includes(item.type)) throw new Error('Некорректная категория.');
    textField(item.emoji, 16, 'Эмодзи', { optional: true });
  }
  for (const item of lists?.accounts || []) {
    rowId(item?.id); if (typeof item.id !== 'number' || !textField(item.name, 100, 'Счёт') || !/^[A-Z]{3}$/.test(item.currency)) throw new Error('Некорректный счёт.');
  }
  if (new Set((lists?.accounts || []).map((item) => item.id)).size !== (lists?.accounts || []).length) throw new Error('Повтор ID счёта.');
  for (const key of ['currencies', 'necessities', 'operationTypes']) for (const value of lists?.[key] || []) textField(value, 100, key);
  if (lists?.currencies?.some((value) => !/^[A-Z]{3}$/.test(value))) throw new Error('Некорректная валюта.');
  const source = payload?.schema === 1 ? payload.lists : null;
  const categoryItems = Array.isArray(source?.categories) ? source.categories : [];
  const categories = {
    Расход: uniqueStrings(categoryItems.filter((item) => item?.type === 'Расход').map((item) => item.name)),
    Доход: uniqueStrings(categoryItems.filter((item) => item?.type === 'Доход').map((item) => item.name)),
    Перевод: [],
  };
  const categoryEmojis = Object.fromEntries(categoryItems.filter((item) => item?.name).map((item) => [String(item.name).trim(), String(item.emoji || '').trim()]));
  if (!categories.Расход.length) categories.Расход = [...FALLBACK_LISTS.categories.Расход];
  if (!categories.Доход.length) categories.Доход = [...FALLBACK_LISTS.categories.Доход];
  for (const names of Object.values(categories)) for (const name of names) categoryEmojis[name] ||= FALLBACK_CATEGORY_EMOJIS[name] || '';
  const withFallback = (values, fallback) => uniqueStrings(values).length ? uniqueStrings(values) : [...fallback];
  const operationTypes = withFallback(source?.operationTypes, FALLBACK_LISTS.operationTypes).filter((value) => ['Расход', 'Доход', 'Перевод'].includes(value));
  const accounts = Array.isArray(source?.accounts) ? source.accounts.map((account) => ({
    id: Number(account?.id), name: String(account?.name || '').trim(), currency: String(account?.currency || '').trim(),
  })).filter((account) => Number.isInteger(account.id) && account.name && account.currency) : [];
  return {
    categories,
    categoryEmojis,
    currencies: withFallback(source?.currencies, FALLBACK_LISTS.currencies),
    necessities: withFallback(source?.necessities, FALLBACK_LISTS.necessities),
    operationTypes: operationTypes.length ? operationTypes : [...FALLBACK_LISTS.operationTypes],
    accounts,
  };
}

function normalizeBalanceSnapshot(payload) {
  if (payload?.schema !== 1 || !calendarDate(payload.asOfDate)
    || !timestamp(payload.generatedAt) || !String(payload.workbook || '').trim()
    || !Array.isArray(payload.accounts) || !Array.isArray(payload.missingRates)) return null;
  if (typeof payload.workbook !== 'string' || payload.accounts.length > 100
    || new Set(payload.accounts.map((a) => a?.id)).size !== payload.accounts.length
    || payload.accounts.some((a) => !a || typeof a.id !== 'number' || typeof a.name !== 'string'
      || typeof a.currency !== 'string' || typeof a.balance !== 'number'
      || (a.rate !== null && typeof a.rate !== 'number')
      || (a.rubAmount !== null && typeof a.rubAmount !== 'number')
      || (a.rateEffectiveDate !== null && !calendarDate(a.rateEffectiveDate)))
    || (payload.totalRub !== null && typeof payload.totalRub !== 'number')
    || payload.missingRates.some((code) => typeof code !== 'string' || !/^[A-Z]{3}$/.test(code))) return null;
  const accounts = payload.accounts.map((account) => ({
    id: Number(account?.id),
    name: String(account?.name || '').trim(),
    currency: String(account?.currency || '').trim(),
    balance: Number(account?.balance),
    rate: account?.rate === null ? null : Number(account?.rate),
    rateEffectiveDate: account?.rateEffectiveDate ? String(account.rateEffectiveDate) : null,
    rubAmount: account?.rubAmount === null ? null : Number(account?.rubAmount),
  }));
  if (accounts.some((account) => !Number.isInteger(account.id) || account.id < 5 || account.id > 104 || !account.name || !/^[A-Z]{3}$/.test(account.currency)
    || !Number.isFinite(account.balance) || (account.rate !== null && !(Number.isFinite(account.rate) && account.rate > 0))
    || (account.rubAmount !== null && !Number.isFinite(account.rubAmount)))) return null;
  const totalRub = payload.totalRub === null ? null : Number(payload.totalRub);
  if (totalRub !== null && !Number.isFinite(totalRub)) return null;
  const missingRates = [...new Set(payload.missingRates.map((currency) => String(currency || '').trim()).filter((currency) => /^[A-Z]{3}$/.test(currency)))];
  return {
    schema: 1,
    generatedAt: payload.generatedAt,
    asOfDate: payload.asOfDate,
    workbook: String(payload.workbook),
    accounts,
    missingRates,
    totalRub,
  };
}

function formatBalanceAmount(amount, currency) {
  const formatted = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(amount);
  return `${formatted}\u00a0${currency}`;
}

function formatSignedBalanceAmount(amount, currency) {
  const stableAmount = Math.abs(amount) < 1e-9 ? 0 : amount;
  const sign = stableAmount > 0 ? '+' : stableAmount < 0 ? '−' : '';
  return `${sign}${formatBalanceAmount(Math.abs(stableAmount), currency)}`;
}

function operationWord(count) {
  const lastTwo = count % 100;
  const last = count % 10;
  if (last === 1 && lastTwo !== 11) return 'операция';
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) return 'операции';
  return 'операций';
}

function validBalanceForecastOperation(event, id) {
  const operation = event?.operation;
  if (event?.schema !== 1 || event.id !== id || !operation || typeof operation !== 'object'
    || !calendarDate(operation.date) || !['Доход', 'Расход', 'Перевод'].includes(operation.type)
    || !Number.isInteger(operation.accountId) || operation.accountId < 5 || operation.accountId > 104
    || typeof operation.currency !== 'string' || !/^[A-Z]{3}$/.test(operation.currency)
    || typeof operation.amount !== 'number') return false;
  try { numberField(operation.amount, { positive: true }); } catch { return false; }
  if (operation.type === 'Перевод') {
    if (!Number.isInteger(operation.destinationAccountId) || operation.destinationAccountId < 5 || operation.destinationAccountId > 104
      || operation.destinationAccountId === operation.accountId || typeof operation.destinationAmount !== 'number') return false;
    try { numberField(operation.destinationAmount, { positive: true }); } catch { return false; }
  } else if (typeof operation.category !== 'string' || !operation.category.trim()) return false;
  return true;
}

function formatSnapshotDate(value, includeTime = false) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat('ru-RU', includeTime
    ? { dateStyle: 'short', timeStyle: 'short' }
    : { day: 'numeric', month: 'long', year: 'numeric' }).format(date);
}

function renderBalancesPanel(containerEl, plugin) {
  containerEl.empty();
  containerEl.addClass('finance-balances-panel');
  containerEl.createEl('h3', { text: 'Общие балансы' });
  const snapshot = plugin.balanceSnapshot;
  if (!snapshot) {
    containerEl.createEl('p', {
      cls: 'finance-balances-hint',
      text: plugin.balanceSnapshotState === 'invalid'
        ? 'Файл балансов получен, но не прошёл проверку. Попробуйте дождаться завершения синхронизации.'
        : 'Баланс ещё не синхронизирован. Дождитесь получения снимка из desktop-приложения.',
    });
    return;
  }
  if (plugin.balanceSnapshotState === 'invalid') {
    containerEl.createEl('p', { cls: 'finance-balances-warning', text: 'Не удалось прочитать обновление. Показан последний корректный снимок.' });
  }
  containerEl.createEl('p', {
    cls: 'finance-balances-updated',
    text: `Данные на ${formatSnapshotDate(snapshot.asOfDate)} · снимок создан ${formatSnapshotDate(snapshot.generatedAt, true)}`,
  });
  if (plugin.pendingBalanceState === 'invalid') {
    containerEl.createEl('p', { cls: 'finance-balances-warning', text: 'Не удалось проверить очередь. Показаны текущие суммы; прогноз временно недоступен.' });
  } else if (plugin.pendingBalanceState === 'ready') {
    containerEl.createEl('p', {
      cls: 'finance-balances-queue-summary',
      text: `В прогнозе учтено из очереди: ${plugin.pendingBalanceOperationCount} ${operationWord(plugin.pendingBalanceOperationCount)}.`,
    });
    if (plugin.pendingBalanceSkippedCount) {
      containerEl.createEl('p', {
        cls: 'finance-balances-warning',
        text: `Не учтено записей очереди: ${plugin.pendingBalanceSkippedCount}. Проверьте их JSON и выбранные счета.`,
      });
    }
  }
  if (!snapshot.accounts.length) {
    containerEl.createEl('p', { cls: 'finance-balances-hint', text: 'Активных счетов нет.' });
  }
  const accountList = containerEl.createEl('div', { cls: 'finance-balances-accounts' });
  for (const account of snapshot.accounts) {
    const row = accountList.createEl('div', { cls: 'finance-balances-account' });
    const heading = row.createEl('div', { cls: 'finance-balances-account-heading' });
    heading.createEl('span', { cls: 'finance-balances-name', text: account.name });
    heading.createEl('span', { cls: 'finance-balances-amount', text: `Сейчас: ${formatBalanceAmount(account.balance, account.currency)}` });
    if (plugin.pendingBalanceState === 'ready') {
      const change = plugin.pendingBalanceChanges.get(account.id) || 0;
      const forecast = row.createEl('div', { cls: 'finance-balances-account-forecast' });
      forecast.createEl('span', { cls: 'finance-balances-forecast-label', text: 'Ожидаемое изменение' });
      forecast.createEl('span', {
        cls: 'finance-balances-forecast-change',
        text: formatSignedBalanceAmount(change, account.currency),
      });
      forecast.createEl('span', { cls: 'finance-balances-forecast-label', text: 'Ожидаемый остаток' });
      const projectedBalance = account.balance + change;
      forecast.createEl('strong', {
        cls: `finance-balances-forecast-total${projectedBalance > 0 ? ' is-positive' : projectedBalance < 0 ? ' is-negative' : ''}`,
        text: formatBalanceAmount(projectedBalance, account.currency),
      });
    }
  }
  if (snapshot.totalRub === null) {
    const missing = snapshot.missingRates.length ? ` Нет курса: ${snapshot.missingRates.join(', ')}.` : '';
    containerEl.createEl('p', { cls: 'finance-balances-total-unavailable', text: `Общий итог в RUB пока недоступен.${missing}` });
  } else {
    const total = containerEl.createEl('div', { cls: 'finance-balances-total' });
    total.createEl('span', { text: 'Общий итог по снимку' });
    total.createEl('strong', { text: formatBalanceAmount(snapshot.totalRub, 'RUB') });
  }
}

class FinanceBalancesPanelChild extends MarkdownRenderChild {
  constructor(plugin, containerEl) {
    super(containerEl);
    this.plugin = plugin;
    this.refresh = () => renderBalancesPanel(this.containerEl, this.plugin);
  }
  onload() {
    this.plugin.balancePanelRefreshers.add(this.refresh);
    this.refresh();
  }
  onunload() { this.plugin.balancePanelRefreshers.delete(this.refresh); }
}

function defaultOperation(plugin) {
  const lists = plugin.captureLists || normalizeMobileLists(null);
  const type = lists.operationTypes.includes('Расход') ? 'Расход' : lists.operationTypes[0];
  const account = lists.accounts[0];
  const destination = lists.accounts.find((item) => item.id !== account?.id);
  return {
    date: localDate(), type, category: lists.categories[type]?.[0] || '', amount: '',
    accountId: account?.id || '', destinationAccountId: destination?.id || '', destinationAmount: '',
    currency: account?.currency || (lists.currencies.includes('RUB') ? 'RUB' : lists.currencies[0]),
    necessity: lists.necessities[0], notes: '',
  };
}

function uniqueId(author) {
  const time = new Date().toISOString().replace(/[-:.TZ]/g, '');
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${author}-${time}-${random}`.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 128);
}

async function ensureFolder(vault, folderPath) {
  let current = '';
  for (const part of normalizePath(folderPath).split('/').filter(Boolean)) {
    current = current ? `${current}/${part}` : part;
    if (!vault.getAbstractFileByPath(current)) await vault.createFolder(current);
  }
}

function markdownCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>') || '—';
}

function filenamePart(value) {
  return String(value ?? '').replace(/[\\/:*?"<>|#[\]^]/g, '-').replace(/\s+/g, ' ').replace(/[. ]+$/g, '').trim() || 'Без категории';
}

function amountForFilename(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return filenamePart(value);
  return amount.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1').replace('.', ',');
}

function categoryLabel(lists, category) {
  const emoji = lists.categoryEmojis?.[category];
  return `${emoji ? `${emoji} ` : ''}${category}`;
}

function recordBaseName(operation, lists) {
  const category = operation.category ? categoryLabel(lists, operation.category) : operation.type;
  return `${filenamePart(operation.date)} — ${filenamePart(category)} — ${amountForFilename(operation.amount)} ${filenamePart(operation.currency)}`;
}

function recordNameWithStatus(name, pending) {
  const cleanName = String(name || '').replace(/^(?:1 — В очереди|2 — Архив) — /, '');
  return `${pending ? RECORD_PENDING_PREFIX : RECORD_ARCHIVED_PREFIX}${cleanName}`;
}

function recordPathWithStatus(recordPath, pending) {
  const slash = recordPath.lastIndexOf('/');
  const directory = slash >= 0 ? recordPath.slice(0, slash + 1) : '';
  const filename = recordPath.slice(slash + 1).replace(/\.md$/i, '');
  return `${directory}${recordNameWithStatus(filename, pending)}.md`;
}

function recordPathWithCategory(recordPath, category, lists) {
  const slash = recordPath.lastIndexOf('/');
  const directory = slash >= 0 ? recordPath.slice(0, slash + 1) : '';
  const filename = recordPath.slice(slash + 1).replace(/\.md$/i, '');
  const pending = filename.startsWith(RECORD_PENDING_PREFIX);
  const archived = filename.startsWith(RECORD_ARCHIVED_PREFIX);
  const cleanName = filename.replace(/^(?:1 — В очереди|2 — Архив) — /, '');
  const parts = cleanName.split(' — ');
  if (parts.length < 3) return recordPath;
  parts[1] = categoryLabel(lists, category);
  const updated = `${pending ? RECORD_PENDING_PREFIX : archived ? RECORD_ARCHIVED_PREFIX : ''}${parts.join(' — ')}`;
  return `${directory}${updated}.md`;
}

function operationMarkdown(event, jsonPath, lists) {
  const operation = event.operation;
  const accountName = (id) => lists.accounts.find((account) => account.id === Number(id))?.name || `#${id}`;
  const displayedCategory = operation.category ? categoryLabel(lists, operation.category) : '';
  const title = `${operation.type}: ${displayedCategory || String(operation.notes || '').split(/\r?\n/)[0] || `${accountName(operation.accountId)} → ${accountName(operation.destinationAccountId)}`}`;
  return `---
finance_capture: true
finance_id: ${JSON.stringify(event.id)}
finance_json: ${JSON.stringify(jsonPath)}
created_at: ${JSON.stringify(event.createdAt)}
finance_category: ${JSON.stringify(operation.category || '')}
---

# ${title}

> [!info] Карточка операции
> Это представление только для чтения. Изменения в этой заметке не изменяют JSON или Excel.

| Поле | Значение |
| --- | --- |
| Дата | ${markdownCell(operation.date)} |
| Тип | ${markdownCell(operation.type)} |
| Сумма | ${markdownCell(operation.amount)} ${markdownCell(operation.currency)} |
| Счёт | ${markdownCell(accountName(operation.accountId))} |
${operation.type === 'Перевод' ? `| Счёт назначения | ${markdownCell(accountName(operation.destinationAccountId))} |
| Зачислено | ${markdownCell(operation.destinationAmount)} ${markdownCell(lists.accounts.find((account) => account.id === Number(operation.destinationAccountId))?.currency)} |
` : ''}| Категория | ${markdownCell(displayedCategory)} |
| Необходимость | ${markdownCell(operation.necessity)} |
| Заметка | ${markdownCell(operation.notes)} |
| ID | \`${event.id}\` |

Удаление этой заметки отменит операцию, только если она ещё находится в очереди импорта.
`;
}

function frontmatterValue(markdown, key) {
  const match = String(markdown).match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  if (!match) return '';
  try { return JSON.parse(match[1]); } catch { return match[1].trim(); }
}

function renderCaptureForm(containerEl, plugin, options = {}) {
  let operation = defaultOperation(plugin);
  const render = (message = '') => {
    const lists = plugin.captureLists;
    if (!lists.accounts.some((account) => account.id === Number(operation.accountId))) {
      operation.accountId = lists.accounts[0]?.id || '';
      operation.currency = lists.accounts[0]?.currency || '';
    }
    if (operation.type === 'Перевод' && !lists.accounts.some((account) => account.id === Number(operation.destinationAccountId) && account.id !== Number(operation.accountId))) {
      operation.destinationAccountId = lists.accounts.find((account) => account.id !== Number(operation.accountId))?.id || '';
    }
    containerEl.empty();
    containerEl.addClass(options.inline ? 'finance-capture-panel' : 'finance-capture-modal');
    containerEl.createEl(options.inline ? 'h3' : 'h2', { text: 'Новая финансовая операция' });
    if (options.inline) containerEl.createEl('p', { cls: 'finance-capture-panel-hint', text: 'Запись сохранится локально и будет передана через Syncthing.' });
    if (message) containerEl.createEl('div', { cls: 'finance-capture-success', text: message });

    new Setting(containerEl).setName('Тип').addDropdown((field) => {
      lists.operationTypes.forEach((type) => field.addOption(type, type));
      field.setValue(operation.type).onChange((value) => { operation.type = value; operation.category = lists.categories[value]?.[0] || ''; render(); });
    });
    new Setting(containerEl).setName(operation.type === 'Доход' ? 'Счёт зачисления' : 'Счёт списания').setDesc(lists.accounts.length ? 'Валюта берётся из настроек счёта.' : 'Сначала синхронизируйте список счетов из desktop-приложения.').addDropdown((field) => {
      if (!lists.accounts.length) field.addOption('', 'Нет синхронизированных счетов');
      lists.accounts.forEach((account) => field.addOption(String(account.id), `${account.name} · ${account.currency}`));
      field.setValue(String(operation.accountId || '')).onChange((value) => {
        operation.accountId = Number(value) || '';
        operation.currency = lists.accounts.find((account) => account.id === operation.accountId)?.currency || '';
        render();
      });
    });
    if (operation.type === 'Перевод') {
      new Setting(containerEl).setName('Счёт назначения').addDropdown((field) => {
        lists.accounts.filter((account) => account.id !== operation.accountId).forEach((account) => field.addOption(String(account.id), `${account.name} · ${account.currency}`));
        field.setValue(String(operation.destinationAccountId || '')).onChange((value) => { operation.destinationAccountId = Number(value) || ''; render(); });
      });
    }
    const sameCurrencyTransfer = operation.type === 'Перевод' && lists.accounts.find((account) => account.id === Number(operation.destinationAccountId))?.currency === operation.currency;
    let destinationField;
    new Setting(containerEl).setName(operation.type === 'Перевод' ? 'Списано' : 'Сумма').addText((field) => {
      configureAmountInput(field, operation.amount, (value) => {
        operation.amount = value;
        if (sameCurrencyTransfer) {
          operation.destinationAmount = value;
          destinationField?.setValue(value);
        }
      });
      if (options.focusAmount) window.setTimeout(() => field.inputEl.focus(), 0);
    });
    if (operation.type !== 'Перевод') new Setting(containerEl).setName('Валюта').setDesc(operation.currency || 'Выберите счёт');
    if (operation.type === 'Перевод') {
      new Setting(containerEl).setName('Зачислено').setDesc('Для одинаковой валюты равно сумме списания.').addText((field) => {
        destinationField = field;
        if (sameCurrencyTransfer) operation.destinationAmount = operation.amount;
        field.inputEl.readOnly = sameCurrencyTransfer;
        if (sameCurrencyTransfer) field.inputEl.classList.add('finance-capture-readonly');
        configureAmountInput(field, operation.destinationAmount, (value) => { operation.destinationAmount = value; });
      });
    } else {
      new Setting(containerEl).setName('Категория').addDropdown((field) => {
        lists.categories[operation.type].forEach((category) => field.addOption(category, categoryLabel(lists, category)));
        field.setValue(operation.category).onChange((value) => { operation.category = value; });
      });
    }
    let dateInput;
    let datePicker;
    const dateSetting = new Setting(containerEl).setName('Дата');
    dateSetting.controlEl.classList.add('finance-capture-date-control');
    dateSetting.addButton((button) => {
      button.setIcon('calendar-days').setTooltip('Выбрать дату').onClick(() => {
        if (!dateInput) return;
        datePicker?.focus();
        try { if (typeof datePicker?.showPicker === 'function') datePicker.showPicker(); else datePicker?.click(); }
        catch { datePicker?.click(); }
      });
      button.buttonEl.classList.add('finance-capture-calendar-button');
      button.buttonEl.setAttribute('aria-label', 'Выбрать дату');
    }).addText((field) => {
      dateInput = field.inputEl;
      field.inputEl.type = 'text';
      field.inputEl.inputMode = 'numeric';
      field.inputEl.placeholder = 'ДД.ММ.ГГГГ';
      field.inputEl.classList.add('finance-capture-date-input');
      field.setValue(operation.date.split('-').reverse().join('.')).onChange((value) => {
        const match = String(value).match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
        if (!match) return;
        const [, day, month, year] = match;
        const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
        if (parsed.getUTCFullYear() === Number(year) && parsed.getUTCMonth() === Number(month) - 1 && parsed.getUTCDate() === Number(day)) operation.date = `${year}-${month}-${day}`;
      });
    });
    dateSetting.addText((field) => {
      datePicker = field.inputEl;
      field.inputEl.type = 'date';
      field.inputEl.classList.add('finance-capture-native-date-picker');
      field.inputEl.setAttribute('aria-hidden', 'true');
      field.inputEl.tabIndex = -1;
      field.setValue(operation.date).onChange((value) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
        operation.date = value;
        dateInput?.setValue?.(value.split('-').reverse().join('.'));
      });
    });
    if (operation.type === 'Расход') {
      new Setting(containerEl).setName('Необходимость').addDropdown((field) => {
        lists.necessities.forEach((necessity) => field.addOption(necessity, necessity));
        field.setValue(operation.necessity).onChange((value) => { operation.necessity = value; });
      });
    }
    new Setting(containerEl).setName('Заметка').addTextArea((field) => field.setValue(operation.notes).onChange((value) => { operation.notes = value; }));
    new Setting(containerEl).addButton((button) => button.setButtonText('Сохранить операцию').setCta().onClick(async () => {
      const amount = parseAmountInputValue(operation.amount);
      if (!(amount > 0)) { new Notice('Укажите сумму больше нуля.'); return; }
      const visibleDate = dateInput?.value?.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
      if (!visibleDate || operation.date !== `${visibleDate[3]}-${visibleDate[2]}-${visibleDate[1]}`) { new Notice('Введите дату в формате ДД.ММ.ГГГГ или выберите её в календаре.'); return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(operation.date)) { new Notice('Укажите дату.'); return; }
      const account = lists.accounts.find((item) => item.id === Number(operation.accountId));
      if (!account) { new Notice('Выберите синхронизированный счёт.'); return; }
      let destinationAmount = 0;
      if (operation.type === 'Перевод') {
        const destination = lists.accounts.find((item) => item.id === Number(operation.destinationAccountId));
        if (!destination || destination.id === account.id) { new Notice('Выберите другой счёт назначения.'); return; }
        destinationAmount = account.currency === destination.currency ? amount : parseAmountInputValue(operation.destinationAmount);
        if (!(destinationAmount > 0)) { new Notice('Укажите сумму зачисления.'); return; }
      }
      button.setDisabled(true).setButtonText('Сохраняем…');
      try {
        const saved = await plugin.saveOperation({ date: operation.date, type: operation.type, category: operation.type === 'Перевод' ? '' : operation.category, amount, currency: account.currency, accountId: Number(operation.accountId), necessity: operation.type === 'Расход' ? operation.necessity : '', notes: operation.notes, destinationAccountId: operation.type === 'Перевод' ? Number(operation.destinationAccountId) : null, destinationAmount });
        if (options.onSaved) options.onSaved(saved);
        else {
          operation = defaultOperation(plugin);
          render('Операция сохранена. Форма готова для следующей записи.');
        }
      } catch (error) {
        new Notice(`Не удалось сохранить: ${error.message}`);
        button.setDisabled(false).setButtonText('Сохранить операцию');
      }
    }));
  };
  const refresh = () => render('Список счетов обновлён из Excel.');
  plugin.captureFormRefreshers?.add(refresh);
  render();
  return () => plugin.captureFormRefreshers?.delete(refresh);
}

function renderManagerPanel(containerEl, plugin) {
  const render = (message = '') => {
    containerEl.empty();
    containerEl.addClass('finance-capture-panel', 'finance-capture-manager');
    containerEl.createEl('h3', { text: 'Управление мобильными операциями' });
    containerEl.createEl('p', { cls: 'finance-capture-panel-hint', text: 'Панель удаляет только карточки Finance Capture и ожидающие JSON.' });
    if (message) containerEl.createEl('div', { cls: 'finance-capture-success', text: message });

    new Setting(containerEl).setName('Архивные записи').setDesc('Карточки без JSON в очереди. Архив сам по себе не подтверждает импорт; смотрите статус квитанции в карточке.')
      .addButton((button) => button.setButtonText('Удалить архивные записи').onClick(async () => {
        const summary = await plugin.getCleanupSummary();
        if (!summary.archivedCards || !window.confirm(`Удалить архивные карточки: ${summary.archivedCards}?`)) return;
        button.setDisabled(true);
        const result = await plugin.deleteArchivedRecords();
        render(`Удалено архивных карточек: ${result.deletedCards}.`);
      }));
    new Setting(containerEl).setName('Все записи').setDesc('Все карточки операций и все ожидающие JSON. Импортированные строки в Excel не удаляются.')
      .addButton((button) => button.setButtonText('Удалить все записи').setWarning().onClick(async () => {
        const summary = await plugin.getCleanupSummary();
        const total = summary.allCards + summary.pendingJson;
        if (!total || !window.confirm(`Удалить карточки (${summary.allCards}) и ожидающие JSON (${summary.pendingJson})? Это действие нельзя отменить.`)) return;
        button.setDisabled(true);
        const result = await plugin.deleteAllRecords();
        render(`Удалено карточек: ${result.deletedCards}; JSON: ${result.deletedJson}.`);
      }));
  };
  render();
}

class FinanceCapturePanelChild extends MarkdownRenderChild {
  constructor(plugin, element) { super(element); this.plugin = plugin; }
  onload() { this.dispose = renderCaptureForm(this.containerEl, this.plugin, { inline: true }); }
  onunload() { this.dispose?.(); this.dispose = null; }
}

class CaptureModal extends Modal {
  constructor(app, plugin) { super(app); this.plugin = plugin; }
  onOpen() { this.disposeForm = renderCaptureForm(this.contentEl, this.plugin, { focusAmount: true, onSaved: () => this.close() }); }
  onClose() { this.disposeForm?.(); this.contentEl.empty(); }
}

class FinanceCaptureSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Finance Capture' });
    new Setting(containerEl).setName('Автор').setDesc('Латинские буквы, цифры, точка, дефис или подчёркивание.')
      .addText((field) => field.setValue(this.plugin.settings.author).onChange(async (value) => {
        this.plugin.settings.author = value.replace(/[^A-Za-z0-9._-]/g, '-') || 'owner'; await this.plugin.saveSettings();
      }));
    new Setting(containerEl).setName('Папка Syncthing в хранилище').setDesc('Корневая папка; JSON попадёт в incoming, а карточки — в отдельную подпапку.')
      .addText((field) => field.setValue(this.plugin.settings.syncRoot).onChange(async (value) => {
        this.plugin.settings.syncRoot = normalizePath(value || 'Finance Sync'); await this.plugin.saveSettings();
        await this.plugin.refreshMobileLists(); await this.plugin.refreshBalancesSnapshot();
      }));
    new Setting(containerEl).setName('Подпапка карточек').setDesc('Путь внутри папки Syncthing, например operations.')
      .addText((field) => field.setValue(this.plugin.settings.recordsSubfolder).onChange(async (value) => {
        this.plugin.settings.recordsSubfolder = normalizePath(value || 'operations'); await this.plugin.saveSettings();
      }));
  }
}

module.exports = class FinanceCapturePlugin extends Plugin {
  async onload() {
    this.disposed = false;
    const saved = await this.loadData() || {};
    this.settings = { ...DEFAULT_SETTINGS, ...saved, recordLinks: { ...(saved.recordLinks || {}) } };
    this.bulkDeleting = false;
    this.cardStatusSyncQueue = Promise.resolve();
    this.captureFormRefreshers = new Set();
    this.balancePanelRefreshers = new Set();
    this.captureLists = normalizeMobileLists(null);
    this.balanceSnapshot = null;
    this.balanceSnapshotState = 'missing';
    this.pendingBalanceChanges = new Map();
    this.pendingBalanceOperationCount = 0;
    this.pendingBalanceSkippedCount = 0;
    this.pendingBalanceState = 'unavailable';
    await this.refreshMobileLists();
    await this.refreshBalancesSnapshot({ notify: false });
    const openCaptureModal = async () => { await this.refreshMobileLists(); new CaptureModal(this.app, this).open(); };
    this.addRibbonIcon('wallet-cards', 'Добавить финансовую операцию', openCaptureModal);
    this.addCommand({ id: 'add-finance-operation', name: 'Добавить финансовую операцию', callback: openCaptureModal });
    this.addCommand({
      id: 'insert-finance-capture-panel',
      name: 'Вставить панель добавления операции в заметку',
      editorCallback: (editor) => editor.replaceRange('```finance-capture\n```\n', editor.getCursor()),
    });
    this.addCommand({
      id: 'insert-finance-capture-manager',
      name: 'Вставить панель управления мобильными операциями',
      editorCallback: (editor) => editor.replaceRange('```finance-capture-manager\n```\n', editor.getCursor()),
    });
    this.addCommand({
      id: 'insert-finance-balances-panel',
      name: 'Вставить панель общих балансов в заметку',
      editorCallback: (editor) => editor.replaceRange('```finance-balances\n```\n', editor.getCursor()),
    });
    this.addCommand({ id: 'show-finance-sync-status', name: 'Показать статус мобильных операций', callback: () => this.showStatus() });
    this.registerMarkdownCodeBlockProcessor('finance-capture', async (_source, element, context) => {
      await this.refreshMobileLists();
      if (this.disposed) return;
      const child = new FinanceCapturePanelChild(this, element);
      if (context?.addChild) context.addChild(child);
      else child.onload();
    });
    this.registerMarkdownCodeBlockProcessor('finance-capture-manager', (_source, element) => renderManagerPanel(element, this));
    this.registerMarkdownCodeBlockProcessor('finance-balances', async (_source, element, context) => {
      await this.refreshBalancesSnapshot({ notify: false });
      const child = new FinanceBalancesPanelChild(this, element);
      if (context?.addChild) context.addChild(child);
      else child.onload();
    });
    this.registerEvent(this.app.vault.on('delete', (file) => Promise.all([this.onVaultDelete(file), this.onListsFileChanged(file.path), this.onBalancesFileChanged(file.path)]).catch((error) => new Notice(`Ошибка Finance Capture: ${error.message}`))));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      this.onSyncFileArrived(file.path, oldPath);
      return Promise.all([this.onVaultRename(file, oldPath), this.onListsFileChanged(file.path, oldPath), this.onBalancesFileChanged(file.path, oldPath)]).catch(() => {});
    }));
    this.registerEvent(this.app.vault.on('create', (file) => {
      this.onSyncFileArrived(file.path);
      return Promise.all([this.onListsFileChanged(file.path), this.onBalancesFileChanged(file.path)]).catch(() => {});
    }));
    this.registerEvent(this.app.vault.on('modify', (file) => { this.onSyncFileArrived(file.path); return Promise.all([this.onListsFileChanged(file.path), this.onBalancesFileChanged(file.path)]).catch(() => {}); }));
    this.addSettingTab(new FinanceCaptureSettings(this.app, this));
    this.registerInterval(setInterval(() => { this.queueCardStatusSync().catch(() => {}); }, 10000));
    await this.applyDataReset();
    await this.reconcileDeletedRecords();
    await this.queueCardStatusSync();
  }

  async saveSettings() { await this.saveData(this.settings); }

  listsPath() { return normalizePath(`${this.settings.syncRoot}/config/lists.json`); }

  balancesPath() { return normalizePath(`${this.settings.syncRoot}/config/balances.json`); }

  async refreshBalancesSnapshot({ notify = true } = {}) {
    const file = this.app.vault.getAbstractFileByPath(this.balancesPath());
    if (!file) {
      this.pendingBalanceRefreshGeneration = (this.pendingBalanceRefreshGeneration || 0) + 1;
      this.balanceSnapshot = null;
      this.balanceSnapshotState = 'missing';
      this.pendingBalanceChanges = new Map();
      this.pendingBalanceOperationCount = 0;
      this.pendingBalanceSkippedCount = 0;
      this.pendingBalanceState = 'unavailable';
      if (notify) this.refreshBalancePanels();
      return false;
    }
    try {
      const snapshot = normalizeBalanceSnapshot(JSON.parse(await (this.app.vault.read ? this.app.vault.read(file) : this.app.vault.cachedRead(file))));
      if (!snapshot) throw new Error('Invalid balances snapshot');
      this.balanceSnapshot = snapshot;
      this.balanceSnapshotState = 'ready';
      await this.refreshPendingBalanceImpacts({ notify: false });
      if (notify) this.refreshBalancePanels();
      return true;
    } catch {
      this.balanceSnapshotState = 'invalid';
      if (notify) this.refreshBalancePanels();
      return false;
    }
  }

  refreshBalancePanels() {
    for (const refresh of this.balancePanelRefreshers) {
      try { refresh(); } catch { this.balancePanelRefreshers.delete(refresh); }
    }
  }

  async onBalancesFileChanged(filePath, oldPath = '') {
    const target = this.balancesPath();
    if (filePath !== target && oldPath !== target) return false;
    return this.refreshBalancesSnapshot();
  }

  async refreshPendingBalanceImpacts({ notify = true } = {}) {
    const generation = this.pendingBalanceRefreshGeneration = (this.pendingBalanceRefreshGeneration || 0) + 1;
    const snapshot = this.balanceSnapshot;
    if (!snapshot) {
      this.pendingBalanceState = 'unavailable';
      this.pendingBalanceChanges = new Map();
      this.pendingBalanceOperationCount = 0;
      this.pendingBalanceSkippedCount = 0;
      if (notify) this.refreshBalancePanels();
      return false;
    }

    const accountById = new Map(snapshot.accounts.map((account) => [account.id, account]));
    const changes = new Map(snapshot.accounts.map((account) => [account.id, 0]));
    const incomingPrefix = `${normalizePath(`${this.settings.syncRoot}/incoming`)}/`;
    const receiptsPrefix = `${normalizePath(`${this.settings.syncRoot}/receipts`)}/`;
    let operationCount = 0;
    let skippedCount = 0;

    try {
      for (const file of this.app.vault.getFiles()) {
        if (file.extension !== 'json' || !file.path.startsWith(incomingPrefix)) continue;
        const id = file.path.slice(incomingPrefix.length, -5);
        if (!this.validQueuePath(id, file.path)) continue;

        let event;
        try {
          event = JSON.parse(await (this.app.vault.read ? this.app.vault.read(file) : this.app.vault.cachedRead(file)));
        } catch {
          // A partially synchronized JSON must not temporarily erase the last valid estimate.
          throw new Error('An incoming operation could not be read completely.');
        }
        if (!validBalanceForecastOperation(event, id)) {
          skippedCount += 1;
          continue;
        }

        const operation = event.operation;
        const source = accountById.get(operation.accountId);
        if (!source || source.currency !== operation.currency) {
          skippedCount += 1;
          continue;
        }

        let receipt = null;
        const receiptFile = this.app.vault.getAbstractFileByPath(`${receiptsPrefix}${id}.json`);
        if (receiptFile?.extension === 'json') {
          try {
            const candidate = JSON.parse(await (this.app.vault.read ? this.app.vault.read(receiptFile) : this.app.vault.cachedRead(receiptFile)));
            if (candidate?.schema === 1 && candidate.id === id && timestamp(candidate.importedAt)) receipt = candidate;
          } catch { /* Partial receipts never prove import success. */ }
        }
        if (receipt?.status === 'discarded') continue;
        if (receipt?.status === 'imported' && receipt.duplicate === true) continue;
        if (receipt?.status === 'imported' && operation.date <= snapshot.asOfDate
          && Date.parse(receipt.importedAt) <= Date.parse(snapshot.generatedAt)) continue;

        if (operation.type === 'Перевод') {
          const destination = accountById.get(operation.destinationAccountId);
          if (!destination || (destination.currency === source.currency && operation.destinationAmount !== operation.amount)) {
            skippedCount += 1;
            continue;
          }
          changes.set(source.id, changes.get(source.id) - operation.amount);
          changes.set(destination.id, changes.get(destination.id) + operation.destinationAmount);
        } else {
          const sign = operation.type === 'Доход' ? 1 : -1;
          changes.set(source.id, changes.get(source.id) + sign * operation.amount);
        }
        operationCount += 1;
      }

      if ([...changes.values()].some((change) => !Number.isFinite(change))) throw new Error('Pending balance estimate overflow.');
      if (this.disposed || generation !== this.pendingBalanceRefreshGeneration) return false;
      this.pendingBalanceChanges = changes;
      this.pendingBalanceOperationCount = operationCount;
      this.pendingBalanceSkippedCount = skippedCount;
      this.pendingBalanceState = 'ready';
      if (notify) this.refreshBalancePanels();
      return true;
    } catch {
      if (this.disposed || generation !== this.pendingBalanceRefreshGeneration) return false;
      this.pendingBalanceState = 'invalid';
      if (notify) this.refreshBalancePanels();
      return false;
    }
  }

  schedulePendingBalanceRefresh() {
    if (this.disposed) return;
    clearTimeout(this.pendingBalanceRefreshTimeout);
    this.pendingBalanceRefreshTimeout = setTimeout(() => {
      this.pendingBalanceRefreshTimeout = null;
      if (!this.disposed) this.refreshPendingBalanceImpacts().catch(() => {});
    }, 0);
  }

  async refreshMobileLists() {
    const file = this.app.vault.getAbstractFileByPath(this.listsPath());
    if (!file) { this.captureLists = normalizeMobileLists(null); await this.syncCardCategoryEmojis(); this.refreshCaptureForms(); return false; }
    try {
      this.captureLists = normalizeMobileLists(JSON.parse(await (this.app.vault.read ? this.app.vault.read(file) : this.app.vault.cachedRead(file))));
      await this.syncCardCategoryEmojis();
      this.refreshCaptureForms();
      return true;
    } catch (error) {
      new Notice(`Справочники не приняты: ${error.message}`);
      this.captureLists = normalizeMobileLists(null);
      this.refreshCaptureForms();
      return false;
    }
  }

  refreshCaptureForms() {
    for (const refresh of this.captureFormRefreshers) {
      try { refresh(); } catch { this.captureFormRefreshers.delete(refresh); }
    }
  }

  async onListsFileChanged(filePath, oldPath = '') {
    if (filePath === this.listsPath() || oldPath === this.listsPath()) await this.refreshMobileLists();
    if (filePath.startsWith(`${normalizePath(this.settings.syncRoot)}/`)) await this.applyDataReset();
  }

  async applyDataReset() {
    if (this.applyingReset) return;
    this.applyingReset = true;
    const previousBulkDeleting = this.bulkDeleting;
    try {
      const file = this.app.vault.getAbstractFileByPath(normalizePath(`${this.settings.syncRoot}/config/reset.json`));
      if (!file) return;
      const reset = JSON.parse(await (this.app.vault.read ? this.app.vault.read(file) : this.app.vault.cachedRead(file)));
      if (reset.schema !== 1 || !Array.isArray(reset.ids) || reset.ids.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{5,127}$/.test(id)) || !timestamp(reset.cutoff)) return;
      const old = (id, date) => reset.ids.includes(id) || (Number.isFinite(Date.parse(date)) && Date.parse(date) <= Date.parse(reset.cutoff));
      this.bulkDeleting = true;
      const incomingPrefix = `${normalizePath(`${this.settings.syncRoot}/incoming`)}/`;
      for (const card of await this.listManagedCards()) {
        if (!normalizePath(card.jsonPath).startsWith(incomingPrefix)) continue;
        const markdown = await this.app.vault.cachedRead(card.file);
        if (!/^finance_capture:\s*true$/m.test(markdown) || !old(card.id, frontmatterValue(markdown, 'created_at'))) continue;
        await this.app.vault.delete(card.file);
        delete this.settings.recordLinks[card.recordPath];
      }
      for (const candidate of this.app.vault.getFiles()) {
        if (!candidate.path.startsWith(incomingPrefix) || !['json', 'pending'].includes(candidate.extension)) continue;
        let event;
        try { event = JSON.parse(await this.app.vault.cachedRead(candidate)); } catch { continue; }
        if (event.schema === 1 && event.operation && this.validQueuePath(event.id, candidate.path.replace(/\.pending$/, '.json')) && old(event.id, event.createdAt)) await this.app.vault.delete(candidate);
      }
      await this.saveSettings();
      this.schedulePendingBalanceRefresh();
    } finally { this.bulkDeleting = previousBulkDeleting; this.applyingReset = false; }
  }

  async saveOperation(operation) {
    object(operation);
    if (!calendarDate(operation.date)) throw new Error('Укажите существующую календарную дату.');
    if (!['Доход', 'Расход', 'Перевод'].includes(operation.type)) throw new Error('Некорректный тип операции.');
    operation = { ...operation, amount: numberField(operation.amount, { positive: true }), notes: textField(operation.notes, 500, 'Заметка', { optional: true }) };
    const account = this.captureLists.accounts.find((item) => item.id === rowId(operation.accountId));
    if (!account || account.currency !== operation.currency) throw new Error('Сначала получите актуальный счёт через синхронизацию.');
    if (operation.type === 'Перевод') {
      const target = this.captureLists.accounts.find((item) => item.id === rowId(operation.destinationAccountId));
      if (!target || target.id === account.id) throw new Error('Выберите другой действующий счёт назначения.');
      operation.destinationAmount = target.currency === account.currency ? operation.amount : numberField(operation.destinationAmount, { positive: true });
    } else {
      if (!this.captureLists.categories[operation.type].includes(textField(operation.category, 100, 'Категория'))) throw new Error('Категория отсутствует в справочнике.');
      if (operation.necessity && !this.captureLists.necessities.includes(textField(operation.necessity, 100, 'Необходимость'))) throw new Error('Необходимость отсутствует в справочнике.');
    }
    if (operation.rate !== undefined) operation.rate = operation.currency === 'RUB' ? 1 : rateField(operation.rate);
    textField(this.settings.author, 80, 'Автор');
    const author = this.settings.author.replace(/[^A-Za-z0-9._-]/g, '-') || 'owner';
    const id = uniqueId(author);
    const root = normalizePath(this.settings.syncRoot);
    const incoming = normalizePath(`${root}/incoming`);
    const records = normalizePath(`${root}/${this.settings.recordsSubfolder || 'operations'}`);
    await ensureFolder(this.app.vault, incoming);
    const event = { schema: 1, id, author, createdAt: new Date().toISOString(), operation };
    const temporaryPath = `${incoming}/${id}.pending`;
    const jsonPath = `${incoming}/${id}.json`;
    const baseName = recordNameWithStatus(recordBaseName(operation, this.captureLists), true);
    let recordPath = `${records}/${baseName}.md`;
    let temporaryFile;
    try {
      temporaryFile = await this.app.vault.create(temporaryPath, `${JSON.stringify(event, null, 2)}\n`);
      await this.app.vault.rename(temporaryFile, jsonPath);
      temporaryFile = null;
    } catch (error) {
      const unfinished = temporaryFile || this.app.vault.getAbstractFileByPath(temporaryPath);
      if (unfinished) await this.app.vault.delete(unfinished).catch(() => {});
      throw error;
    }

    let cardCreated = false;
    try {
      await ensureFolder(this.app.vault, records);
      if (this.app.vault.getAbstractFileByPath(recordPath)) recordPath = `${records}/${baseName} — ${id.slice(-8)}.md`;
      if (this.app.vault.getAbstractFileByPath(recordPath)) recordPath = `${records}/${baseName} — ${id}.md`;
      await this.app.vault.create(recordPath, operationMarkdown(event, jsonPath, this.captureLists));
      cardCreated = true;
      this.settings.recordLinks[recordPath] = { id, jsonPath };
      await this.saveSettings().catch((error) => new Notice(`Карточка создана, но её связь не записана в настройках: ${error.message}`));
      new Notice('Операция и карточка сохранены на телефоне.');
    } catch (error) {
      new Notice(`Операция сохранена, но карточку создать не удалось: ${error.message}`);
    }
    return { id, jsonPath, recordPath: cardCreated ? recordPath : null, cardCreated };
  }

  async onVaultDelete(file) {
    if (this.bulkDeleting) return;
    const incomingPrefix = `${normalizePath(`${this.settings.syncRoot}/incoming`)}/`;
    if (file.extension === 'json' && file.path.startsWith(incomingPrefix)) {
      this.schedulePendingBalanceRefresh();
      await this.queueCardStatusSync(file.path);
      this.scheduleCardStatusSync();
      return;
    }
    const link = this.settings.recordLinks[file.path];
    if (!link) return;
    if (!this.validRecordPath(file.path)) return;
    const id = typeof link === 'string' ? link : link.id;
    if ((await this.listManagedCards()).some((card) => card.id === id && card.recordPath !== file.path)) {
      await this.reconcileDeletedRecords();
      return;
    }
    const jsonPath = typeof link === 'string' ? `${this.settings.syncRoot}/incoming/${link}.json` : link.jsonPath;
    const queued = await this.validPendingFile(id, jsonPath);
    if (queued) {
      await this.app.vault.delete(queued);
      this.schedulePendingBalanceRefresh();
      new Notice('Карточка удалена, ожидающая операция отменена.');
    }
    delete this.settings.recordLinks[file.path];
    await this.saveSettings();
  }

  async onVaultRename(file, oldPath) {
    const link = this.settings.recordLinks[oldPath];
    if (!link) return;
    delete this.settings.recordLinks[oldPath];
    this.settings.recordLinks[file.path] = link;
    await this.saveSettings();
  }

  async reconcileDeletedRecords() {
    // Missing paths at startup can mean an offline rename or incomplete sync.
    // Only a live, explicit card deletion may cancel a queued operation.
    const links = {};
    for (const card of await this.listManagedCards()) links[card.recordPath] = { id: card.id, jsonPath: card.jsonPath };
    this.settings.recordLinks = links;
    await this.saveSettings();
  }

  validQueuePath(id, jsonPath) {
    const safe = (value) => typeof value === 'string' && value && !value.startsWith('/') && !/[\\:]/.test(value) && !value.split('/').some((part) => !part || part === '.' || part === '..');
    const root = this.settings.syncRoot;
    return safe(root) && safe(jsonPath) && typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{5,127}$/.test(id)
      && jsonPath === `${root}/incoming/${id}.json`;
  }

  validRecordPath(recordPath) {
    const folder = this.settings.recordsSubfolder || 'operations';
    if (folder.split('/').some((part) => !part || part === '.' || part === '..') || /[\\:]/.test(folder)) return false;
    return typeof recordPath === 'string' && !recordPath.split('/').some((part) => part === '.' || part === '..')
      && recordPath.startsWith(`${this.settings.syncRoot}/${folder}/`) && recordPath.endsWith('.md');
  }

  async validPendingFile(id, jsonPath) {
    if (!this.validQueuePath(id, jsonPath)) return null;
    const file = this.app.vault.getAbstractFileByPath(jsonPath);
    if (!file || file.extension !== 'json') return null;
    try {
      const event = JSON.parse(await (this.app.vault.read ? this.app.vault.read(file) : this.app.vault.cachedRead(file)));
      return event.schema === 1 && event.id === id && event.operation && typeof event.operation === 'object' ? file : null;
    } catch { return null; }
  }

  async setCardStatus(card, pending) {
    const desiredPath = recordPathWithStatus(card.recordPath, pending);
    if (desiredPath === card.recordPath) return false;
    let targetPath = desiredPath;
    const occupied = this.app.vault.getAbstractFileByPath(targetPath);
    if (occupied && occupied.path !== card.recordPath) targetPath = desiredPath.replace(/\.md$/i, ` — ${String(card.id).slice(-8)}.md`);
    const oldPath = card.recordPath;
    await this.app.vault.rename(card.file, targetPath);
    delete this.settings.recordLinks[oldPath];
    this.settings.recordLinks[targetPath] = { id: card.id, jsonPath: card.jsonPath };
    card.recordPath = targetPath;
    card.file = this.app.vault.getAbstractFileByPath(targetPath) || card.file;
    return true;
  }

  onunload() {
    this.disposed = true;
    clearTimeout(this.cardStatusSyncTimeout);
    clearTimeout(this.pendingBalanceRefreshTimeout);
    this.captureFormRefreshers?.clear();
    this.balancePanelRefreshers?.clear();
  }

  onSyncFileArrived(filePath, oldPath = '') {
    const incoming = `${normalizePath(`${this.settings.syncRoot}/incoming`)}/`;
    const receipts = `${normalizePath(`${this.settings.syncRoot}/receipts`)}/`;
    const records = `${normalizePath(`${this.settings.syncRoot}/${this.settings.recordsSubfolder || 'operations'}`)}/`;
    const changedPaths = [filePath, oldPath];
    if (changedPaths.some((value) => (value.startsWith(incoming) && value.endsWith('.json')) || (value.startsWith(receipts) && value.endsWith('.json')))) {
      this.schedulePendingBalanceRefresh();
    }
    if (changedPaths.some((value) => (value.startsWith(incoming) && value.endsWith('.json')) || (value.startsWith(records) && value.endsWith('.md')) || (value.startsWith(receipts) && value.endsWith('.json')))) {
      // Scheduling avoids awaiting our own card rename from inside the status queue.
      this.scheduleCardStatusSync();
    }
  }

  queueCardStatusSync(onlyJsonPath = '') {
    const task = this.cardStatusSyncQueue.catch(() => {}).then(() => this.disposed ? false : this.syncCardStatuses(onlyJsonPath));
    this.cardStatusSyncQueue = task.catch(() => {});
    return task;
  }

  scheduleCardStatusSync() {
    if (this.disposed) return;
    clearTimeout(this.cardStatusSyncTimeout);
    this.cardStatusSyncTimeout = setTimeout(() => {
      this.cardStatusSyncTimeout = null;
      this.queueCardStatusSync().catch((error) => new Notice(`Ошибка обновления статусов Finance Capture: ${error.message}`));
    }, 500);
    this.cardStatusSyncTimeout?.unref?.();
  }

  async syncCardStatuses(onlyJsonPath = '') {
    const cards = await this.listManagedCards();
    let changed = false;
    for (const card of cards) {
      if (onlyJsonPath && card.jsonPath !== onlyJsonPath) continue;
      const previous = this.settings.recordLinks[card.recordPath];
      if (previous?.id !== card.id || previous?.jsonPath !== card.jsonPath) {
        this.settings.recordLinks[card.recordPath] = { id: card.id, jsonPath: card.jsonPath };
        changed = true;
      }
      const pending = Boolean(this.app.vault.getAbstractFileByPath(card.jsonPath));
      if (this.disposed) return changed;
      if (await this.setCardStatus(card, pending)) changed = true;
      let status = pending ? 'В очереди. Подтверждения обработки пока нет.' : 'Архив: JSON отсутствует. Импорт не подтверждён.';
      const receiptFile = this.app.vault.getAbstractFileByPath(`${this.settings.syncRoot}/receipts/${card.id}.json`);
      if (receiptFile) {
        try {
          const receipt = JSON.parse(await this.app.vault.cachedRead(receiptFile));
          if (receipt.schema === 1 && receipt.id === card.id) {
            if (receipt.status === 'imported' && timestamp(receipt.importedAt)) status = `Импорт подтверждён компьютером: ${receipt.importedAt}.${pending ? ' JSON ещё находится в очереди синхронизации.' : ''}`;
            else if (receipt.status === 'discarded' && timestamp(receipt.importedAt)) status = 'Отклонено компьютером после сброса/восстановления. Не добавлено в Excel.';
            else if (receipt.status === 'error') status = 'Ошибка обработки на компьютере. Проверьте очередь в desktop-приложении.';
          }
        } catch { /* Partial receipts never prove success. */ }
      }
      const markdown = await this.app.vault.cachedRead(card.file);
      const block = `<!-- finance-status:start -->\n> ${status}\n<!-- finance-status:end -->`;
      const updated = /<!-- finance-status:start -->[\s\S]*?<!-- finance-status:end -->/.test(markdown)
        ? markdown.replace(/<!-- finance-status:start -->[\s\S]*?<!-- finance-status:end -->/, () => block)
        : `${markdown.trimEnd()}\n\n${block}\n`;
      if (!this.disposed && updated !== markdown) await this.app.vault.modify(card.file, updated);
    }
    if (changed) await this.saveSettings();
    return changed;
  }

  async syncCardCategoryEmojis() {
    const cards = await this.listManagedCards();
    let changed = false;
    for (const card of cards) {
      const markdown = await this.app.vault.cachedRead(card.file);
      let category = frontmatterValue(markdown, 'finance_category');
      if (!category) {
        const displayed = markdown.match(/^\| Категория \| (.+?) \|$/m)?.[1]?.replace(/\\\|/g, '|').trim() || '';
        category = Object.values(this.captureLists.categories).flat().find((name) => displayed === name || displayed.endsWith(` ${name}`)) || '';
      }
      if (!category) continue;
      let targetPath = recordPathWithCategory(card.recordPath, category, this.captureLists);
      if (targetPath === card.recordPath) continue;
      const occupied = this.app.vault.getAbstractFileByPath(targetPath);
      if (occupied && occupied.path !== card.recordPath) targetPath = targetPath.replace(/\.md$/i, ` — ${String(card.id).slice(-8)}.md`);
      const oldPath = card.recordPath;
      await this.app.vault.rename(card.file, targetPath);
      delete this.settings.recordLinks[oldPath];
      this.settings.recordLinks[targetPath] = { id: card.id, jsonPath: card.jsonPath };
      changed = true;
    }
    if (changed) await this.saveSettings();
    return changed;
  }

  async listManagedCards() {
    const cards = new Map();

    const recordsPrefix = `${normalizePath(`${this.settings.syncRoot}/${this.settings.recordsSubfolder || 'operations'}`)}/`;
    for (const file of this.app.vault.getFiles()) {
      if (file.extension !== 'md' || !this.validRecordPath(file.path) || !file.path.startsWith(recordsPrefix) || cards.has(file.path)) continue;
      const markdown = await this.app.vault.cachedRead(file);
      if (!/^finance_capture:\s*true$/m.test(markdown)) continue;
      const id = frontmatterValue(markdown, 'finance_id');
      const jsonPath = frontmatterValue(markdown, 'finance_json');
      if (this.validQueuePath(id, jsonPath)) cards.set(file.path, { file, recordPath: file.path, id, jsonPath });
    }
    return [...cards.values()];
  }

  async listPendingJson() {
    const incomingPrefix = `${normalizePath(`${this.settings.syncRoot}/incoming`)}/`;
    const files = [];
    for (const file of this.app.vault.getFiles()) {
      if (file.extension !== 'json' || !file.path.startsWith(incomingPrefix)) continue;
      const id = file.path.slice(incomingPrefix.length, -5);
      if (await this.validPendingFile(id, file.path)) files.push(file);
    }
    return files;
  }

  async getCleanupSummary() {
    const cards = await this.listManagedCards();
    return {
      allCards: cards.length,
      archivedCards: cards.filter((card) => !this.app.vault.getAbstractFileByPath(card.jsonPath)).length,
      pendingJson: (await this.listPendingJson()).length,
    };
  }

  async deleteArchivedRecords() {
    const cards = (await this.listManagedCards()).filter((card) => !this.app.vault.getAbstractFileByPath(card.jsonPath));
    this.bulkDeleting = true;
    try {
      for (const card of cards) await this.app.vault.delete(card.file);
    } finally { this.bulkDeleting = false; }
    for (const card of cards) delete this.settings.recordLinks[card.recordPath];
    if (cards.length) await this.saveSettings();
    return { deletedCards: cards.length };
  }

  async deleteAllRecords() {
    const cards = await this.listManagedCards();
    const jsonFiles = await this.listPendingJson();
    this.bulkDeleting = true;
    try {
      for (const card of cards) await this.app.vault.delete(card.file);
      for (const file of jsonFiles) await this.app.vault.delete(file);
    } finally { this.bulkDeleting = false; }
    this.settings.recordLinks = {};
    await this.saveSettings();
    this.schedulePendingBalanceRefresh();
    return { deletedCards: cards.length, deletedJson: jsonFiles.length };
  }

  async showStatus() {
    const root = normalizePath(this.settings.syncRoot);
    const incomingPrefix = `${root}/incoming/`;
    const receiptPrefix = `${root}/receipts/`;
    const files = this.app.vault.getFiles();
    const operations = files.filter((file) => file.path.startsWith(incomingPrefix) && file.extension === 'json').length;
    const receipts = files.filter((file) => file.path.startsWith(receiptPrefix) && file.extension === 'json').length;
    new Notice(`Ожидают импорта: ${operations}. Получено квитанций: ${receipts}.`);
  }
};

module.exports.formatAmountInputValue = formatAmountInputValue;
module.exports.parseAmountInputValue = parseAmountInputValue;
module.exports.configureAmountInput = configureAmountInput;
