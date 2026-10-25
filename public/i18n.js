const STORAGE_KEY = 'finance:locale';
const TEXT_SOURCE = new WeakMap();
const ATTRIBUTE_SOURCE = new WeakMap();
const ATTRIBUTES = ['title', 'aria-label', 'placeholder', 'alt'];
const PRESERVED = '[data-locale-preserve], .operation-note, .operation-category-label, .account-route, .account-name, .category-name, .setting-value, code, option';
let locale = 'ru';
let catalog = { messages: {}, fragments: {}, plurals: {}, errors: {} };
let observer = null;

function normalizeLocale(value) { return value === 'en' ? 'en' : 'ru'; }

async function loadCatalog(value) {
  const response = await fetch(`/locales/${value}.json`, { cache: 'no-store' });
  if (!response.ok) throw new Error('Locale file is unavailable.');
  const data = await response.json();
  return { messages: data.messages || {}, fragments: data.fragments || {}, plurals: data.plurals || {}, errors: data.errors || {} };
}

function translateValue(source) {
  if (Object.hasOwn(catalog.messages, source)) return catalog.messages[source];
  let result = source;
  for (const [from, to] of Object.entries(catalog.fragments).sort((a, b) => b[0].length - a[0].length)) {
    if (from) result = result.split(from).join(to);
  }
  return result;
}

function applyTextNode(node) {
  const parent = node.parentElement;
  if (!parent || parent.closest(PRESERVED)) return;
  if (!TEXT_SOURCE.has(node)) TEXT_SOURCE.set(node, node.nodeValue);
  const source = TEXT_SOURCE.get(node);
  const leading = source.match(/^\s*/)?.[0] || '';
  const trailing = source.match(/\s*$/)?.[0] || '';
  const core = source.slice(leading.length, source.length - trailing.length || undefined);
  const translated = translateValue(core);
  const value = `${leading}${translated}${trailing}`;
  if (node.nodeValue !== value) node.nodeValue = value;
}

function applyAttributes(element) {
  if (element.closest(PRESERVED)) return;
  let origins = ATTRIBUTE_SOURCE.get(element);
  if (!origins) { origins = new Map(); ATTRIBUTE_SOURCE.set(element, origins); }
  for (const name of ATTRIBUTES) {
    if (!element.hasAttribute(name)) continue;
    if (!origins.has(name)) origins.set(name, element.getAttribute(name));
    const translated = translateValue(origins.get(name));
    if (element.getAttribute(name) !== translated) element.setAttribute(name, translated);
  }
}

export function applyTranslations(root = document.documentElement) {
  if (root.nodeType === Node.TEXT_NODE) { applyTextNode(root); return; }
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
  if (root.nodeType === Node.ELEMENT_NODE) applyAttributes(root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) applyTextNode(node);
  if (root.nodeType === Node.ELEMENT_NODE) root.querySelectorAll('*').forEach(applyAttributes);
}

export async function initializeLocale() {
  let preferred = '';
  try { preferred = localStorage.getItem(STORAGE_KEY) || ''; } catch {}
  const selected = preferred ? normalizeLocale(preferred) : normalizeLocale(navigator.language?.slice(0, 2).toLowerCase());
  await setLocale(selected, { persist: false });
  observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'characterData') applyTextNode(record.target);
      else if (record.type === 'attributes') applyAttributes(record.target);
      else for (const node of record.addedNodes) applyTranslations(node);
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ATTRIBUTES,
  });
  return locale;
}

export async function setLocale(value, { persist = true } = {}) {
  const selected = normalizeLocale(value);
  try { catalog = await loadCatalog(selected); }
  catch { catalog = { messages: {}, fragments: {}, plurals: {}, errors: {} }; }
  locale = selected;
  document.documentElement.lang = locale;
  applyTranslations();
  if (persist) { try { localStorage.setItem(STORAGE_KEY, locale); } catch {} }
  return locale;
}

export function currentLocale() { return locale; }
export function localeCode() { return locale === 'en' ? 'en-GB' : 'ru-RU'; }
export function isEnglish() { return locale === 'en'; }
export function translate(source, values = {}) {
  return translateValue(source).replace(/\{([A-Za-z0-9_]+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);
}

export function translateCount(key, count, values = {}) {
  const forms = catalog.plurals[key];
  if (!forms || typeof forms !== 'object') return translate(key, { count, ...values });
  const form = new Intl.PluralRules(localeCode()).select(count);
  return translate(forms[form] || forms.other || key, { count, ...values });
}

export function translateError(code, fallback = '', retryable = false) {
  const message = (locale === 'en' && catalog.errors[code]) || translateValue(fallback) || translateValue('Ошибка соединения с сервером.');
  return retryable ? `${message} ${translateValue('Можно повторить после устранения причины.')}` : message;
}
