import { AsyncLocalStorage } from 'node:async_hooks';
import { InputError, object, textField, calendarDate, timestamp, numberField, rateField, rowId, localHttpBoundary, publicError, createDiagnostics } from './lib/input-boundary.mjs';
import { createWriteStream } from 'node:fs';
import express from 'express';
import { readIdentity, saveIdentity, mergeIdentity, assertIdentityAvailable } from './lib/identity-state.mjs';
import JSZip from 'jszip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { createHash, randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkbookStore, digest, acquireWorkbookLock } from './lib/workbook-store.mjs';
import { exportRecoveryBundle, verifyRecoveryBundle, rehearseRecoveryContents } from './lib/recovery-bundle.mjs';
import { authorizedShutdown, publishRuntime, removeRuntime } from './lib/runtime-control.mjs';
import { startFirstRunApplication } from './lib/first-run.mjs';
import { createUpdateService } from './lib/update-service.mjs';
import { createClientPresence, validClientId } from './lib/client-presence.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageInfo = await readFile(path.join(__dirname, 'package.json'), 'utf8').then(JSON.parse).catch(() => ({}));
const RELEASE_INFO = await readFile(path.join(__dirname, 'release-info.json'), 'utf8').then(JSON.parse).catch(() => ({ version: packageInfo.version || 'development', channel: 'development' }));
const updateService = createUpdateService({ currentVersion: RELEASE_INFO.version, channel: RELEASE_INFO.channel });
let updateInstallPending = false;
let updateProgress = { stage: 'idle', received: 0, total: null };
const DATA_DIR = path.resolve(process.env.FINANCE_DATA_DIR || path.join(__dirname, 'local-data'));
const CONFIG_PATH = process.env.FINANCE_CONFIG_PATH
  ? path.resolve(process.env.FINANCE_CONFIG_PATH)
  : path.join(DATA_DIR, 'finance.config.json');
const localConfig = await readFile(CONFIG_PATH, 'utf8')
  .then((text) => JSON.parse(text))
  .catch(() => ({}));
const WORKBOOK_PATH = process.env.WORKBOOK_PATH ? path.resolve(process.env.WORKBOOK_PATH) : path.join(DATA_DIR, 'uchet_povsednevnyh_finansov.xlsx');
const BACKUP_DIR = process.env.BACKUP_DIR ? path.resolve(process.env.BACKUP_DIR) : path.join(DATA_DIR, 'backups');
const CBR_BASE_URL = process.env.CBR_BASE_URL || 'https://www.cbr.ru/scripts/XML_daily.asp';
const CBR_CACHE_PATH = process.env.CBR_CACHE_PATH ? path.resolve(process.env.CBR_CACHE_PATH) : path.join(DATA_DIR, 'cbr-rates.json');
const configuredSyncDir = process.env.FINANCE_SYNC_DIR || localConfig.syncInboxDir || 'mobile-sync';
const SYNC_DIR = path.isAbsolute(configuredSyncDir) ? configuredSyncDir : path.resolve(__dirname, configuredSyncDir);
const PORT = process.env.PORT === undefined || process.env.PORT === '' ? 4173 : Number(process.env.PORT);
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) throw new RangeError('PORT must be an integer from 0 to 65535.');
const BACKUP_LIMIT = 30;
const MAX_RECOVERY_UPLOAD_BYTES = 256 * 1024 * 1024;
const RECEIPT_RETENTION_DAYS = Number(localConfig.receiptRetentionDays) || 30;
const ACCOUNT_START_ROW = 5;
const ACCOUNT_END_ROW = 14;
const ACCOUNT_MAX_ROW = 104;
const SYSTEM_OPERATION_TYPES = ['Доход', 'Расход', 'Перевод', 'Инвестиция'];
const MOBILE_OPERATION_TYPES = ['Доход', 'Расход', 'Перевод'];
const SYSTEM_INVESTMENT_CATEGORIES = [
  { name: 'Вклад', type: 'Инвестиция' },
  { name: 'Отложенные', type: 'Инвестиция' },
];
const app = express();
const { diagnose, recentDiagnostics } = createDiagnostics();
let writeQueue = Promise.resolve();
const mutationContext = new AsyncLocalStorage();
class PrepareRate extends Error {
  constructor(currency, date) { super('Prepare rate outside workbook lock'); this.currency = currency; this.date = date; }
}
class PrepareReferenceRate extends Error {
  constructor(currency, date) { super('Prepare optional reference rate outside workbook lock'); this.currency = currency; this.date = date; }
}
let inboxScanPromise = null;
let syncQueue = Promise.resolve();
const syncRuns = new Map();
let cbrCacheLoadPromise = null;
let cbrCacheWriteQueue = Promise.resolve();
let shuttingDown = false;
let clientPresence = null;
const importerStops = new Set();
const workbookStore = new WorkbookStore({ file: WORKBOOK_PATH, backupDirectory: BACKUP_DIR, validate: validateWorkbookFile });
let runtimeControl = null;
let shutdownPromise = null;
const cbrRateCache = new Map();
const cbrRateRequests = new Map();
const syncStatus = { enabled: false, directory: SYNC_DIR, lastScanAt: null, imported: 0, duplicates: 0, errors: 0, lastError: null };
const CATEGORY_EMOJIS = new Map(Object.entries({
  'Жильё и аренда': '🏠', 'Коммунальные услуги': '💡', 'Продукты': '🛒', 'Кафе и доставка': '🍽️',
  'Транспорт': '🚕', 'Связь и интернет': '📶', 'Здоровье и аптека': '💊', 'Спорт и зал': '🏋️',
  'Бытовые покупки': '🧹', 'Одежда и личное': '👕', 'Подписки и сервисы': '📱', 'Виза и документы': '📄',
  'Путешествия': '✈️', 'Развлечения': '🎬', 'Подарки и помощь': '🎁', 'Комиссии и обмен валюты': '💱',
  'Прочее': '📦', 'Работа / зарплата': '💼', 'Фриланс / подработки': '💻',
  'Возврат / компенсация': '↩️', 'Прочие доходы': '💰',
}));

app.disable('x-powered-by');
app.use((req, res, next) => localHttpBoundary(req, res, next, {
  allowedBodyTypes: req.method === 'POST' && ['/api/settings/recovery/verify', '/api/settings/recovery/rehearse'].includes(req.path)
    ? ['application/octet-stream']
    : [],
}));

app.post('/api/system/shutdown', (req, res) => {
  if (!runtimeControl) return res.status(404).json({ error: 'Управление остановкой недоступно.', code: 'NOT_FOUND', retryable: false });
  if (!authorizedShutdown(req, runtimeControl.descriptor)) return res.status(403).json({ error: 'Запрос остановки не разрешён.', code: 'FORBIDDEN_ORIGIN', retryable: false });
  res.status(202).json({ stopping: true });
  runtimeControl.stop().catch((error) => { diagnose(error); process.exitCode = 1; });
});
app.use(express.json({ limit: '1mb' }));
app.use((req, _res, next) => {
  try { if (req.body !== undefined) object(req.body); next(); } catch (error) { next(error); }
});
app.use((_req, res, next) => shuttingDown ? res.status(503).json({ error: 'Приложение завершает текущие операции и останавливается.', code: 'SHUTTING_DOWN', retryable: true }) : next());
app.post('/api/system/presence', (req, res) => {
  if (!clientPresence) return res.status(404).json({ error: 'Регистрация вкладок недоступна.', code: 'NOT_FOUND', retryable: false });
  const { clientId, active } = req.body || {};
  if (!validClientId(clientId) || (active !== undefined && typeof active !== 'boolean')) {
    return res.status(400).json({ error: 'Некорректный идентификатор вкладки.', code: 'VALIDATION', retryable: false });
  }
  const accepted = active === false ? clientPresence.release(clientId) : clientPresence.heartbeat(clientId);
  if (!accepted) return res.status(410).json({ error: 'Приложение завершает работу.', code: 'SHUTTING_DOWN', retryable: false });
  res.status(204).end();
});
app.use(express.static(path.join(__dirname, 'public')));

const clean = (value) => String(value ?? '').trim();
const asNumber = (value) => {
  if (value && typeof value === 'object' && 'result' in value) value = value.result;
  const number = typeof value === 'string' ? Number(value.replace(',', '.')) : Number(value);
  return Number.isFinite(number) ? number : 0;
};

function dateToIso(value) {
  if (!value) return '';
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
  }
  if (typeof value === 'number') {
    const date = new Date(Date.UTC(1899, 11, 30) + value * 86400000);
    return dateToIso(date);
  }
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? match[0] : '';
}

function excelDate(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12));
}

function localIsoDate() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60000;
  return new Date(now - offset).toISOString().slice(0, 10);
}

const SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function columnLetters(column) {
  let result = '';
  for (let value = column; value; value = Math.floor((value - 1) / 26)) result = String.fromCharCode(65 + ((value - 1) % 26)) + result;
  return result;
}

function columnNumber(letters) {
  return [...letters].reduce((number, character) => number * 26 + character.charCodeAt(0) - 64, 0);
}

function nodeText(node) {
  return [...Array.from(node?.childNodes || [])].map((child) => child.nodeType === 3 || child.nodeType === 4 ? child.data : nodeText(child)).join('');
}

class XmlCell {
  constructor(sheet, row, column) { this.sheet = sheet; this.row = row; this.column = column; }
  get value() { return this.sheet.readCell(this.row, this.column); }
  set value(value) { this.sheet.writeCell(this.row, this.column, value); }
}

class XmlSheet {
  constructor(document) {
    this.document = document;
    this.dimension = document.getElementsByTagNameNS(SHEET_NS, 'dimension')[0];
    this.sheetData = document.getElementsByTagNameNS(SHEET_NS, 'sheetData')[0];
    this.rows = new Map();
    this.cells = new Map();
    for (const row of Array.from(document.getElementsByTagNameNS(SHEET_NS, 'row'))) {
      this.rows.set(Number(row.getAttribute('r')), row);
      for (const cell of Array.from(row.getElementsByTagNameNS(SHEET_NS, 'c'))) this.cells.set(cell.getAttribute('r'), cell);
    }
    this.rowCount = Math.max(0, ...this.rows.keys());
    const extent = this.dimension?.getAttribute('ref')?.match(/([A-Z]+)(\d+)$/);
    this.dimensionColumn = extent ? columnNumber(extent[1]) : 1;
    this.dimensionRow = Math.max(this.rowCount, Number(extent?.[2]) || 0);
    for (const reference of this.cells.keys()) this.dimensionColumn = Math.max(this.dimensionColumn, columnNumber(reference.match(/^[A-Z]+/)[0]));
  }
  getCell(row, column) { return new XmlCell(this, row, column); }
  hideColumn(column) {
    let columns = this.document.getElementsByTagNameNS(SHEET_NS, 'cols')[0];
    if (!columns) {
      columns = this.document.createElementNS(SHEET_NS, 'x:cols');
      const sheetData = this.document.getElementsByTagNameNS(SHEET_NS, 'sheetData')[0];
      this.document.documentElement.insertBefore(columns, sheetData);
    }
    let definition = Array.from(columns.getElementsByTagNameNS(SHEET_NS, 'col')).find((item) => Number(item.getAttribute('min')) === column && Number(item.getAttribute('max')) === column);
    if (!definition) {
      definition = this.document.createElementNS(SHEET_NS, 'x:col');
      definition.setAttribute('min', String(column));
      definition.setAttribute('max', String(column));
      definition.setAttribute('width', '0');
      definition.setAttribute('customWidth', '1');
      columns.appendChild(definition);
    }
    definition.setAttribute('hidden', '1');
  }
  extendRows(templateRowNumber, newEndRow) {
    const template = this.rows.get(templateRowNumber);
    if (!template) throw new Error(`Не найдена строка-шаблон ${templateRowNumber}.`);
    const sheetData = this.document.getElementsByTagNameNS(SHEET_NS, 'sheetData')[0];
    for (let rowNumber = templateRowNumber + 1; rowNumber <= newEndRow; rowNumber += 1) {
      const row = template.cloneNode(true);
      row.setAttribute('r', String(rowNumber));
      for (const cell of Array.from(row.getElementsByTagNameNS(SHEET_NS, 'c'))) {
        const oldReference = cell.getAttribute('r');
        const column = oldReference.match(/^[A-Z]+/)?.[0];
        const reference = `${column}${rowNumber}`;
        cell.setAttribute('r', reference);
        // Clone layout and formulas, never operation values or cached formula results.
        cell.removeAttribute('t');
        for (const child of Array.from(cell.childNodes)) {
          if (child.localName !== 'f' || column !== 'H') cell.removeChild(child);
        }
        for (const formula of Array.from(cell.getElementsByTagNameNS(SHEET_NS, 'f'))) {
          formula.textContent = formula.textContent.replace(new RegExp(`([A-Z])${templateRowNumber}\\b`, 'g'), `$1${rowNumber}`);
        }
        this.cells.set(reference, cell);
      }
      sheetData.appendChild(row);
      this.rows.set(rowNumber, row);
    }
    for (const validation of Array.from(this.document.getElementsByTagNameNS(SHEET_NS, 'dataValidation'))) {
      const range = validation.getAttribute('sqref');
      validation.setAttribute('sqref', range.replace(/([A-Z]+\d+:[A-Z]+)\d+\b/g, `$1${newEndRow}`));
    }
    this.rowCount = newEndRow;
  }
  ensureCell(rowNumber, column) {
    const reference = `${columnLetters(column)}${rowNumber}`;
    if (this.cells.has(reference)) return this.cells.get(reference);
    let row = this.rows.get(rowNumber);
    if (!row) {
      row = this.document.createElementNS(SHEET_NS, 'x:row');
      row.setAttribute('r', String(rowNumber));
      this.sheetData.appendChild(row);
      this.rows.set(rowNumber, row);
      this.rowCount = Math.max(this.rowCount, rowNumber);
    }
    const cell = this.document.createElementNS(SHEET_NS, 'x:c');
    cell.setAttribute('r', reference);
    const later = Array.from(row.getElementsByTagNameNS(SHEET_NS, 'c')).find((item) => {
      const itemColumn = item.getAttribute('r').match(/[A-Z]+/)?.[0] || '';
      return itemColumn.localeCompare(columnLetters(column), 'en', { numeric: true }) > 0;
    });
    if (later) row.insertBefore(cell, later); else row.appendChild(cell);
    this.cells.set(reference, cell);
    const dimension = this.dimension;
    if (dimension) {
      this.dimensionColumn = Math.max(this.dimensionColumn, column);
      this.dimensionRow = Math.max(this.dimensionRow, rowNumber, this.rowCount);
      dimension.setAttribute('ref', `A1:${columnLetters(this.dimensionColumn)}${this.dimensionRow}`);
    }
    return cell;
  }
  readCell(row, column) {
    const cell = this.cells.get(`${columnLetters(column)}${row}`);
    if (!cell) return null;
    const type = cell.getAttribute('t');
    if (type === 'inlineStr') return nodeText(cell.getElementsByTagNameNS(SHEET_NS, 'is')[0]);
    const value = nodeText(cell.getElementsByTagNameNS(SHEET_NS, 'v')[0]);
    if (value === '') return null;
    if (type === 's') return this.sharedStrings?.[Number(value)] ?? '';
    if (type === 'str') return value;
    return Number.isFinite(Number(value)) ? Number(value) : value;
  }
  writeCell(row, column, value) {
    const cell = this.ensureCell(row, column);
    while (cell.firstChild) cell.removeChild(cell.firstChild);
    cell.removeAttribute('t');
    const appendTextNode = (name, text) => {
      const node = this.document.createElementNS(SHEET_NS, `x:${name}`);
      node.appendChild(this.document.createTextNode(String(text)));
      cell.appendChild(node);
    };
    if (value === null || value === undefined || value === '') return;
    if (typeof value === 'object' && 'formula' in value) {
      appendTextNode('f', value.formula);
      if (value.result !== '' && value.result !== null && value.result !== undefined) appendTextNode('v', value.result);
      return;
    }
    if (value instanceof Date) {
      appendTextNode('v', (Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()) - Date.UTC(1899, 11, 30)) / 86400000);
      return;
    }
    if (typeof value === 'number') { appendTextNode('v', value); return; }
    cell.setAttribute('t', 'inlineStr');
    const inline = this.document.createElementNS(SHEET_NS, 'x:is');
    const text = this.document.createElementNS(SHEET_NS, 'x:t');
    text.appendChild(this.document.createTextNode(String(value)));
    inline.appendChild(text); cell.appendChild(inline);
  }
}

class XmlWorkbook {
  constructor(zip, sheets, paths, sharedStrings, extraDocuments, workbookDoc, relsDoc, contentTypesDoc) {
    this.zip = zip; this.sheets = sheets; this.paths = paths; this.sharedStrings = sharedStrings; this.extraDocuments = extraDocuments;
    this.workbookDoc = workbookDoc; this.relsDoc = relsDoc; this.contentTypesDoc = contentTypesDoc;
    for (const sheet of sheets.values()) sheet.sharedStrings = sharedStrings;
  }
  getWorksheet(name) { return this.sheets.get(name); }
  addWorksheet(name) {
    if (this.sheets.has(name)) return this.sheets.get(name);
    const parser = new DOMParser();
    const document = parser.parseFromString(`<worksheet xmlns="${SHEET_NS}"><dimension ref="A1"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><sheetData/></worksheet>`, 'application/xml');
    const sheetPath = `xl/worksheets/sheet${Math.max(0, ...[...this.paths.values()].map((item) => Number(item.match(/sheet(\d+)\.xml$/)?.[1] || 0))) + 1}.xml`;
    const sheetIds = Array.from(this.workbookDoc.getElementsByTagNameNS(SHEET_NS, 'sheet')).map((item) => Number(item.getAttribute('sheetId')) || 0);
    const relIds = Array.from(this.relsDoc.documentElement.childNodes).map((item) => Number((item.getAttribute?.('Id') || '').replace('rId', '')) || 0);
    const relationshipId = `rId${Math.max(0, ...relIds) + 1}`;
    const sheetNode = this.workbookDoc.createElementNS(SHEET_NS, 'x:sheet');
    sheetNode.setAttribute('name', name); sheetNode.setAttribute('sheetId', String(Math.max(0, ...sheetIds) + 1));
    sheetNode.setAttributeNS(REL_NS, 'r:id', relationshipId);
    this.workbookDoc.getElementsByTagNameNS(SHEET_NS, 'sheets')[0].appendChild(sheetNode);
    const relation = this.relsDoc.createElementNS('http://schemas.openxmlformats.org/package/2006/relationships', 'Relationship');
    relation.setAttribute('Id', relationshipId); relation.setAttribute('Type', `${REL_NS}/worksheet`); relation.setAttribute('Target', `worksheets/${path.basename(sheetPath)}`);
    this.relsDoc.documentElement.appendChild(relation);
    const override = this.contentTypesDoc.createElementNS('http://schemas.openxmlformats.org/package/2006/content-types', 'Override');
    override.setAttribute('PartName', `/${sheetPath}`); override.setAttribute('ContentType', 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml');
    this.contentTypesDoc.documentElement.appendChild(override);
    this.zip.file(sheetPath, new XMLSerializer().serializeToString(document));
    const sheet = new XmlSheet(document); sheet.sharedStrings = this.sharedStrings;
    this.sheets.set(name, sheet); this.paths.set(name, sheetPath);
    return sheet;
  }
  async writeFile(filePath) {
    const serializer = new XMLSerializer();
    for (const [name, sheet] of this.sheets) this.zip.file(this.paths.get(name), serializer.serializeToString(sheet.document));
    for (const [documentPath, document] of this.extraDocuments) this.zip.file(documentPath, serializer.serializeToString(document));
    this.zip.file('xl/workbook.xml', serializer.serializeToString(this.workbookDoc));
    this.zip.file('xl/_rels/workbook.xml.rels', serializer.serializeToString(this.relsDoc));
    this.zip.file('[Content_Types].xml', serializer.serializeToString(this.contentTypesDoc));
    const buffer = await this.zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    await writeFile(filePath, buffer);
  }
}

export async function loadWorkbook(filePath = WORKBOOK_PATH) {
  const bytes = await readFile(filePath);
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const parser = new DOMParser({ onError: (level, message) => { if (level !== 'warning') throw new Error(message); } });
  const parseXml = async (file) => parser.parseFromString((await zip.file(file).async('string')).replace(/^[\uFEFF\s]*/, ''), 'application/xml');
  const workbookDoc = await parseXml('xl/workbook.xml');
  const relsDoc = await parseXml('xl/_rels/workbook.xml.rels');
  const contentTypesDoc = await parseXml('[Content_Types].xml');
  const relationships = new Map(Array.from(relsDoc.documentElement.childNodes).filter((node) => node.localName === 'Relationship').map((node) => [node.getAttribute('Id'), node.getAttribute('Target')]));
  const sharedStrings = [];
  const sharedFile = zip.file('xl/sharedStrings.xml');
  if (sharedFile) {
    const sharedDoc = parser.parseFromString((await sharedFile.async('string')).replace(/^[\uFEFF\s]*/, ''), 'application/xml');
    for (const item of Array.from(sharedDoc.getElementsByTagNameNS(SHEET_NS, 'si'))) sharedStrings.push(nodeText(item));
  }
  const sheets = new Map();
  const paths = new Map();
  for (const sheetNode of Array.from(workbookDoc.getElementsByTagNameNS(SHEET_NS, 'sheet'))) {
    const name = sheetNode.getAttribute('name');
    const target = relationships.get(sheetNode.getAttributeNS(REL_NS, 'id')).replace(/^\//, '');
    const sheetPath = target.startsWith('xl/') ? target : `xl/${target}`;
    const sheetDoc = await parseXml(sheetPath);
    sheets.set(name, new XmlSheet(sheetDoc)); paths.set(name, sheetPath);
  }
  const extraDocuments = new Map();
  for (const file of Object.keys(zip.files).filter((name) => /^xl\/tables\/[^/]+\.xml$/.test(name))) extraDocuments.set(file, await parseXml(file));
  const workbook = new XmlWorkbook(zip, sheets, paths, sharedStrings, extraDocuments, workbookDoc, relsDoc, contentTypesDoc);
  workbook.revision = digest(bytes);
  return workbook;
}

export async function validateWorkbookFile(file) {
  const workbook = await loadWorkbook(file);
  for (const name of ['Операции', 'Списки', 'Баланс', 'Сводка']) {
    const sheet = workbook.getWorksheet(name);
    if (!sheet || !sheet.document.getElementsByTagNameNS(SHEET_NS, 'sheetData').length) throw new Error(`Некорректная книга: отсутствует лист «${name}» или его данные.`);
  }
  readIdentity(workbook);
  return workbook;
}

function readLists(workbook, includeSummaryCategories = true) {
  const sheet = workbook.getWorksheet('Списки');
  const categories = [];
  for (let row = 2; row <= Math.max(sheet.rowCount, 30); row += 1) {
    const name = clean(sheet.getCell(row, 1).value);
    const type = clean(sheet.getCell(row, 2).value);
    const emoji = clean(sheet.getCell(row, 3).value);
    if (name && ['Доход', 'Расход'].includes(type) && !name.startsWith('Справочник')) categories.push({ name, type, emoji });
  }
  if (includeSummaryCategories) {
    const summary = workbook.getWorksheet('Сводка');
    for (let row = 12; row <= 28; row += 1) {
      const name = clean(summary.getCell(row, 1).value);
      if (name && !categories.some((item) => item.name === name)) categories.push({ name, type: 'Расход', emoji: CATEGORY_EMOJIS.get(name) || '📌' });
    }
  }
  const readColumn = (column, max = 30) => {
    const result = [];
    for (let row = 2; row <= Math.max(max, sheet.rowCount); row += 1) {
      const value = clean(sheet.getCell(row, column).value);
      if (value) result.push(value);
    }
    return result;
  };
  const operations = readOperations(workbook);
  const accounts = readAccounts(workbook, operations).filter((account) => account.active).map((account) => ({
    id: account.id, name: account.name, currency: account.currency,
    // Schema 1 clients still require this field; the sentinel imposes no meaningful date restriction.
    startDate: '0001-01-01',
  }));
  return {
    categories,
    currencies: readColumn(4),
    paymentMethods: readColumn(6),
    necessities: readColumn(8),
    operationTypes: [...new Set([...readColumn(10), ...SYSTEM_OPERATION_TYPES])],
    accounts,
  };
}

function ensureSystemOperationTypes(workbook) {
  const sheet = workbook.getWorksheet('Списки');
  let lastRow = 1;
  for (let row = 2; row <= Math.max(sheet.rowCount, 30); row += 1) {
    if (clean(sheet.getCell(row, 10).value)) lastRow = row;
  }
  let changed = false;
  for (const type of SYSTEM_OPERATION_TYPES) {
    const exists = Array.from({ length: Math.max(sheet.rowCount, 30) - 1 }, (_item, index) => clean(sheet.getCell(index + 2, 10).value)).includes(type);
    if (exists) continue;
    let row = 2;
    while (clean(sheet.getCell(row, 10).value)) row += 1;
    sheet.getCell(row, 10).value = type;
    lastRow = Math.max(lastRow, row);
    changed = true;
  }
  let formulaChanged = false;
  const operations = workbook.getWorksheet('Операции');
  for (const formula of Array.from(operations.document.getElementsByTagNameNS(SHEET_NS, 'formula1'))) {
    const value = nodeText(formula).replace(/(Списки!\$J\$2:\$J\$)\d+/g, `$1${lastRow}`);
    if (value !== nodeText(formula)) { formula.textContent = value; formulaChanged = true; }
  }
  return { changed: changed || formulaChanged, lastRow };
}

function ensureSystemInvestmentCategories(workbook) {
  const sheet = workbook.getWorksheet('Списки');
  const operations = workbook.getWorksheet('Операции');
  let changed = false;
  const oldCategoryRows = [];
  const hasRenamedCategory = Array.from({ length: Math.max(sheet.rowCount, 30) - 1 }, (_item, index) => index + 2)
    .some((row) => clean(sheet.getCell(row, 1).value) === 'Отложенные' && clean(sheet.getCell(row, 2).value) === 'Инвестиция');
  for (let row = 2; row <= Math.max(sheet.rowCount, 30); row += 1) {
    if (clean(sheet.getCell(row, 1).value) === 'Накопление' && clean(sheet.getCell(row, 2).value) === 'Инвестиция') oldCategoryRows.push(row);
  }
  for (const [index, row] of oldCategoryRows.entries()) {
    if (!hasRenamedCategory && index === 0) sheet.getCell(row, 1).value = 'Отложенные';
    else for (const column of [1, 2, 3]) sheet.getCell(row, column).value = null;
    changed = true;
  }
  for (let row = 5; row <= operations.rowCount; row += 1) {
    if (clean(operations.getCell(row, 2).value) === 'Инвестиция' && clean(operations.getCell(row, 3).value) === 'Накопление') {
      operations.getCell(row, 3).value = 'Отложенные';
      changed = true;
    }
  }
  let lastRow = 1;
  for (let row = 2; row <= Math.max(sheet.rowCount, 30); row += 1) {
    if (clean(sheet.getCell(row, 1).value)) lastRow = row;
  }
  for (const category of SYSTEM_INVESTMENT_CATEGORIES) {
    const exists = Array.from({ length: Math.max(sheet.rowCount, 30) - 1 }, (_item, index) => index + 2)
      .some((row) => clean(sheet.getCell(row, 1).value) === category.name && clean(sheet.getCell(row, 2).value) === category.type);
    if (exists) continue;
    let row = 2;
    while (clean(sheet.getCell(row, 1).value)) row += 1;
    sheet.getCell(row, 1).value = category.name;
    sheet.getCell(row, 2).value = category.type;
    sheet.getCell(row, 3).value = null;
    lastRow = Math.max(lastRow, row);
    changed = true;
  }
  let formulaChanged = false;
  for (const formula of Array.from(operations.document.getElementsByTagNameNS(SHEET_NS, 'formula1'))) {
    const value = nodeText(formula).replace(/(Списки!\$A\$2:\$A\$)\d+/g, `$1${lastRow}`);
    if (value !== nodeText(formula)) { formula.textContent = value; formulaChanged = true; }
  }
  return { changed: changed || formulaChanged, lastRow };
}

function withWorkbookQueue(task) {
  const result = writeQueue.then(() => workbookStore.exclusive(task));
  writeQueue = result.catch(() => {});
  return result;
}

// Read inside the same queue as Excel writes: callers cannot publish a stale workbook.
export function exportMobileListsOnce(rootDirectory = SYNC_DIR) {
  return withWorkbookQueue(async () => publishMobileLists(rootDirectory, await loadWorkbook()));
}

async function publishMobileLists(rootDirectory, workbook) {
  const { paymentMethods: _legacyPaymentMethods, ...lists } = readLists(workbook, false);
  lists.operationTypes = MOBILE_OPERATION_TYPES;
  const target = path.join(rootDirectory, 'config', 'lists.json');
  const existing = await readFile(target, 'utf8').then((text) => JSON.parse(text)).catch(() => null);
  if (existing?.schema === 1 && JSON.stringify(existing.lists) === JSON.stringify(lists)) {
    return { changed: false, path: target, payload: existing };
  }
  const payload = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    workbook: path.basename(WORKBOOK_PATH),
    lists,
  };
  await writeJsonAtomic(target, payload);
  return { changed: true, path: target, payload };
}

export async function exportMobileBalancesOnce(rootDirectory = SYNC_DIR) {
  await prepareBalanceRates();
  return withWorkbookQueue(async () => publishMobileBalances(rootDirectory, await loadWorkbook()));
}

export async function publishMobileSnapshotOnce(rootDirectory = SYNC_DIR) {
  await prepareBalanceRates();
  return withWorkbookQueue(async () => {
    const workbook = await loadWorkbook();
    const lists = await publishMobileLists(rootDirectory, workbook);
    const balances = await publishMobileBalances(rootDirectory, workbook);
    return { lists, balances };
  });
}

async function prepareBalanceRates() {
  const workbook = await loadWorkbook();
  const date = localIsoDate();
  const currencies = new Set(readAccounts(workbook).filter((a) => a.active).map((a) => a.currency));
  await Promise.allSettled([...currencies].map((currency) => fetchCbrRate(currency, date)));
}

async function publishMobileBalances(rootDirectory, workbook) {
  const asOfDate = localIsoDate();
  const workbookName = path.basename(WORKBOOK_PATH);
  const accountRows = readAccounts(workbook).filter((account) => account.active);
  const currencies = [...new Set(accountRows.map((account) => account.currency))];
  // Network preparation happens before the lock; publish balances from the latest workbook.
  const rates = Object.fromEntries(currencies.map((currency) => {
    const result = currency === 'RUB' ? { rate: 1, effectiveDate: asOfDate } : cbrRateCache.get(`${currency}:${asOfDate}`);
    return [currency, result ? { rate: result.rate, effectiveDate: result.effectiveDate } : null];
  }));
  const missingRates = currencies.filter((currency) => !rates[currency]);
  const accounts = accountRows.map((account) => {
    const currentRate = rates[account.currency]?.rate ?? null;
    return {
      id: account.id,
      name: account.name,
      currency: account.currency,
      balance: account.calculatedBalance,
      rate: currentRate,
      rateEffectiveDate: rates[account.currency]?.effectiveDate ?? null,
      rubAmount: currentRate === null ? null : account.calculatedBalance * currentRate,
    };
  });
  const snapshot = {
    schema: 1,
    asOfDate,
    workbook: workbookName,
    accounts,
    rates,
    missingRates,
    totalRub: missingRates.length ? null : accounts.reduce((sum, account) => sum + account.rubAmount, 0),
  };
  const target = path.join(rootDirectory, 'config', 'balances.json');
  const existing = await readFile(target, 'utf8').then((text) => JSON.parse(text)).catch(() => null);
  if (existing?.schema === 1 && Number.isFinite(Date.parse(existing.generatedAt))) {
    const { generatedAt: _generatedAt, ...existingSnapshot } = existing;
    if (JSON.stringify(existingSnapshot) === JSON.stringify(snapshot)) {
      return { changed: false, path: target, payload: existing };
    }
  }
  const payload = { ...snapshot, generatedAt: new Date().toISOString() };
  await writeJsonAtomic(target, payload);
  return { changed: true, path: target, payload };
}

function readOperations(workbook) {
  const sheet = workbook.getWorksheet('Операции');
  const operations = [];
  for (let row = 5; row <= sheet.rowCount; row += 1) {
    const values = [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19].map((column) => sheet.getCell(row, column).value);
    if (!values.some((value) => clean(value))) continue;
    const amount = asNumber(sheet.getCell(row, 5).value);
    const currency = clean(sheet.getCell(row, 6).value);
    const rate = currency === 'RUB' ? 1 : asNumber(sheet.getCell(row, 7).value);
    const type = clean(sheet.getCell(row, 2).value);
    const storedCategory = clean(sheet.getCell(row, 3).value);
    operations.push({
      id: row,
      date: dateToIso(sheet.getCell(row, 1).value),
      type,
      category: type === 'Инвестиция' && storedCategory === 'Накопление' ? 'Отложенные' : storedCategory,
      amount,
      currency,
      rate,
      rubAmount: currency === 'RUB' ? amount : amount * rate,
      necessity: clean(sheet.getCell(row, 10).value),
      notes: clean(sheet.getCell(row, 11).value),
      sourceId: clean(sheet.getCell(row, 12).value),
      accountId: asNumber(sheet.getCell(row, 13).value) || null,
      destinationAccountId: asNumber(sheet.getCell(row, 14).value) || null,
      destinationAmount: asNumber(sheet.getCell(row, 15).value),
      savingsTransfer: clean(sheet.getCell(row, 16).value),
      savingsAccountId: asNumber(sheet.getCell(row, 17).value) || null,
      savingsAmount: asNumber(sheet.getCell(row, 18).value),
      recordedAt: timestamp(clean(sheet.getCell(row, 19).value)) ? new Date(sheet.getCell(row, 19).value).toISOString() : null,
    });
  }
  return operations.sort((a, b) => b.date.localeCompare(a.date)
    || (a.recordedAt && b.recordedAt ? b.recordedAt.localeCompare(a.recordedAt)
      : a.recordedAt ? -1 : b.recordedAt ? 1 : 0)
    || b.id - a.id);
}

export function operationCapacity(workbook) {
  const sheet = workbook.getWorksheet('\u041e\u043f\u0435\u0440\u0430\u0446\u0438\u0438');
  let used = 0;
  for (let row = 5; row <= sheet.rowCount; row += 1) {
    if ([1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19].some((column) => clean(sheet.getCell(row, column).value))) used += 1;
  }
  return { startRow: 5, endRow: sheet.rowCount, total: Math.max(0, sheet.rowCount - 4), used, available: Math.max(0, sheet.rowCount - 4 - used) };
}

export function ensureOperationCapacity(workbook, minimumFree = 100, batchSize = 100) {
  const before = operationCapacity(workbook);
  if (before.available >= minimumFree) return { expanded: false, ...before };

  const oldEndRow = before.endRow;
  const newEndRow = oldEndRow + batchSize;
  workbook.getWorksheet('\u041e\u043f\u0435\u0440\u0430\u0446\u0438\u0438').extendRows(oldEndRow, newEndRow);

  const summary = workbook.getWorksheet('\u0421\u0432\u043e\u0434\u043a\u0430');
  for (const formula of Array.from(summary.document.getElementsByTagNameNS(SHEET_NS, 'f'))) {
    formula.textContent = formula.textContent.replace(/(Операции!\$[A-Z]+\$5:\$[A-Z]+\$)\d+\b/g, `$1${newEndRow}`);
  }
  for (const document of workbook.extraDocuments.values()) {
    for (const element of Array.from(document.getElementsByTagName('*'))) {
      const reference = element.getAttribute?.('ref');
      if (reference) element.setAttribute('ref', reference.replace(/^([A-Z]+4:[A-Z]+)\d+$/, `$1${newEndRow}`));
    }
  }
  return { expanded: true, ...operationCapacity(workbook), previousEndRow: oldEndRow, added: batchSize };
}

function hasAccountModel(workbook) {
  const balance = workbook.getWorksheet('Баланс');
  const operations = workbook.getWorksheet('Операции');
  return clean(balance.getCell(4, 1).value) === 'Счёт'
    && clean(balance.getCell(4, 2).value) === 'Валюта'
    && clean(operations.getCell(4, 13).value) === 'Счёт (ID строки Баланса)';
}

function readAccounts(workbook, operations = readOperations(workbook)) {
  const sheet = workbook.getWorksheet('Баланс');
  const migrated = hasAccountModel(workbook);
  const openingBalances = new Map(readOpeningBalances(workbook).map((item) => [item.accountId, item.amount]));
  const accounts = [];
  for (let row = ACCOUNT_START_ROW; row <= ACCOUNT_MAX_ROW; row += 1) {
    const name = clean(sheet.getCell(row, 1).value);
    const currency = clean(sheet.getCell(row, 2).value);
    const rate = currency === 'RUB' ? 1 : asNumber(sheet.getCell(row, 4).value);
    const openingBalance = openingBalances.get(row) || 0;
    let calculatedBalance = openingBalance;
    if (migrated && currency) {
      for (const operation of operations) {
        if (operation.date > localIsoDate()) continue;
        if (operation.type === 'Доход' && operation.accountId === row) calculatedBalance += operation.amount;
        if (['Расход', 'Инвестиция'].includes(operation.type) && operation.accountId === row) calculatedBalance -= operation.amount;
        if (operation.type === 'Перевод' && operation.accountId === row) calculatedBalance -= operation.amount;
        if (operation.type === 'Перевод' && operation.destinationAccountId === row) calculatedBalance += operation.destinationAmount || operation.amount;
      }
    }
    accounts.push({
      id: row,
      name,
      currency,
      stored: Array.from({ length: 12 }, (_value, index) => clean(sheet.getCell(row, index + 1).value)).some(Boolean),
      active: Boolean(name && currency),
      calculatedBalance,
      openingBalance,
      order: asNumber(sheet.getCell(row, 13).value) || row,
      rate,
      rubAmount: currency === 'RUB' ? calculatedBalance : calculatedBalance * rate,
    });
  }
  return accounts.sort((a, b) => a.order - b.order || a.id - b.id);
}

const OPENING_BALANCE_SHEET = '\u041d\u0430\u0447\u0430\u043b\u044c\u043d\u044b\u0435 \u0431\u0430\u043b\u0430\u043d\u0441\u044b';
function openingBalanceSheet(workbook) {
  const sheet = workbook.getWorksheet(OPENING_BALANCE_SHEET) || workbook.addWorksheet(OPENING_BALANCE_SHEET);
  if (!clean(sheet.getCell(1, 1).value)) ['ID счета', 'Сумма', 'Дата изменения'].forEach((value, index) => { sheet.getCell(1, index + 1).value = value; });
  sheet.getCell(1, 4).value = '\u041a\u0443\u0440\u0441 \u0426\u0411 \u043d\u0430 \u0434\u0430\u0442\u0443';
  return sheet;
}

function readOpeningBalances(workbook) {
  const sheet = openingBalanceSheet(workbook);
  const balances = [];
  for (let row = 2; row <= sheet.rowCount; row += 1) {
    const accountId = asNumber(sheet.getCell(row, 1).value);
    if (!accountId) continue;
    const rate = asNumber(sheet.getCell(row, 4).value);
    balances.push({ id: row, accountId, amount: asNumber(sheet.getCell(row, 2).value), date: dateToIso(sheet.getCell(row, 3).value), rate: rate > 0 ? rate : null });
  }
  return balances;
}

function recalculateAccountCells(workbook) {
  if (!hasAccountModel(workbook)) return;
  const sheet = workbook.getWorksheet('Баланс');
  for (const account of readAccounts(workbook).filter((item) => item.active)) {
    sheet.getCell(account.id, 5).value = account.active ? account.calculatedBalance : null;
    sheet.getCell(account.id, 11).value = account.active ? account.rubAmount : null;
  }
}

function savingsSheets(workbook) {
  const accounts = workbook.getWorksheet('Накопления') || workbook.addWorksheet('Накопления');
  const movements = workbook.getWorksheet('Движение накоплений') || workbook.addWorksheet('Движение накоплений');
  if (!clean(accounts.getCell(1, 1).value)) ['Название', 'Тип', 'Валюта', 'Начальный капитал', 'Дата создания'].forEach((value, index) => { accounts.getCell(1, index + 1).value = value; });
  if (!clean(movements.getCell(1, 1).value)) ['Счёт', 'Дата', 'Сумма', 'Тип', 'Операция основного учёта', 'Заметка'].forEach((value, index) => { movements.getCell(1, index + 1).value = value; });
  return { accounts, movements };
}

function readSavings(workbook) {
  const { accounts: sheet, movements } = savingsSheets(workbook);
  const entries = [];
  for (let row = 2; row <= movements.rowCount; row += 1) {
    const id = asNumber(movements.getCell(row, 1).value);
    if (!id) continue;
    entries.push({ id: row, accountId: id, date: dateToIso(movements.getCell(row, 2).value), amount: asNumber(movements.getCell(row, 3).value), kind: clean(movements.getCell(row, 4).value), operationId: asNumber(movements.getCell(row, 5).value) || null, notes: clean(movements.getCell(row, 6).value) });
  }
  const today = localIsoDate();
  const accounts = [];
  for (let row = 2; row <= sheet.rowCount; row += 1) {
    const name = clean(sheet.getCell(row, 1).value), currency = clean(sheet.getCell(row, 3).value);
    if (!name || !currency) continue;
    const initialCapital = asNumber(sheet.getCell(row, 4).value);
    const calculatedBalance = initialCapital + entries.filter((entry) => entry.accountId === row && entry.date <= today).reduce((sum, entry) => sum + entry.amount, 0);
    accounts.push({ id: row, name, type: clean(sheet.getCell(row, 2).value), currency, initialCapital, createdDate: dateToIso(sheet.getCell(row, 5).value), calculatedBalance, movements: entries.filter((entry) => entry.accountId === row).sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id) });
  }
  return accounts;
}

function operationExchangeInfo(operation, accountsById, savingsById) {
  let sourceCurrency, sourceAmount, destinationCurrency, destinationAmount;
  if (operation.type === 'Инвестиция') {
    sourceCurrency = operation.currency;
    sourceAmount = operation.amount;
    const savings = savingsById.get(operation.savingsAccountId);
    destinationCurrency = savings?.currency;
    destinationAmount = operation.savingsAmount;
  } else if (operation.type === 'Перевод' && operation.savingsTransfer === 'from-savings') {
    const savings = savingsById.get(operation.savingsAccountId);
    const main = accountsById.get(operation.destinationAccountId);
    sourceCurrency = savings?.currency || operation.currency;
    sourceAmount = operation.savingsAmount || operation.amount;
    destinationCurrency = main?.currency;
    destinationAmount = operation.destinationAmount;
  } else if (operation.type === 'Перевод' && !operation.savingsTransfer) {
    const source = accountsById.get(operation.accountId);
    const destination = accountsById.get(operation.destinationAccountId);
    sourceCurrency = source?.currency || operation.currency;
    sourceAmount = operation.amount;
    destinationCurrency = destination?.currency;
    destinationAmount = operation.destinationAmount || operation.amount;
  } else return null;

  if (!sourceCurrency || !destinationCurrency || sourceCurrency === destinationCurrency
    || !(sourceAmount > 0) || !(destinationAmount > 0)) return null;
  const referenceRate = (currency) => currency === 'RUB'
    ? { currency, rate: 1, requestedDate: operation.date, effectiveDate: operation.date, source: 'RUB' }
    : cbrRateCache.get(`${currency}:${operation.date}`) || null;
  const sourceRate = referenceRate(sourceCurrency);
  const destinationRate = referenceRate(destinationCurrency);
  const referenceRates = [sourceRate, destinationRate].filter(Boolean);
  const rubDifference = sourceRate && destinationRate
    ? destinationAmount * destinationRate.rate - sourceAmount * sourceRate.rate
    : null;
  return {
    sourceCurrency, sourceAmount, destinationCurrency, destinationAmount,
    referenceRates, rubDifference: Number.isFinite(rubDifference) ? rubDifference : null,
  };
}

function serialize(workbook) {
  const summaryMonth = dateToIso(workbook.getWorksheet('Сводка').getCell('B2').value).slice(0, 7);
  const storedOperations = readOperations(workbook);
  const currentDate = localIsoDate();
  const savingsAccounts = readSavings(workbook);
  const accountRows = readAccounts(workbook, storedOperations).filter((account) => account.active);
  const accountsById = new Map(accountRows.map((account) => [account.id, account]));
  const savingsById = new Map(savingsAccounts.map((account) => [account.id, account]));
  const operations = storedOperations.map((operation) => ({
    ...operation,
    exchange: operationExchangeInfo(operation, accountsById, savingsById),
  }));
  const currencies = new Set(['USD', ...[...accountRows, ...savingsAccounts].map((account) => account.currency)]);
  const currentRates = Object.fromEntries([...currencies].map((currency) => {
    if (currency === 'RUB') return [currency, 1];
    const cached = cbrRateCache.get(`${currency}:${currentDate}`);
    return [currency, cached?.rate || null];
  }));
  const accounts = accountRows.map((account) => {
    const rate = currentRates[account.currency];
    return { ...account, rate, rubAmount: rate > 0 ? account.calculatedBalance * rate : null };
  });
  return {
    workbook: path.basename(WORKBOOK_PATH),
    summaryMonth,
    revision: workbook.revision,
    asOfDate: currentDate,
    loadedAt: new Date().toISOString(),
    operations,
    operationCapacity: operationCapacity(workbook),
    accounts,
    balances: accounts,
    savingsAccounts,
    currentRates,
    openingBalances: readOpeningBalances(workbook),
    syncBlocked: readIdentity(workbook).blocked,
    accountCapacity: { used: accounts.length, issued: identityState(workbook).accounts.size, total: ACCOUNT_MAX_ROW - ACCOUNT_START_ROW + 1 },
    lists: { ...readLists(workbook, false), investmentCategories: SYSTEM_INVESTMENT_CATEGORIES.map((item) => item.name) },
  };
}

async function saveWorkbook(workbook) {
  return workbookStore.commit({ revision: workbook.revision, prepare: (target) => workbook.writeFile(target) });
}

export async function listBackups() {
  return (await workbookStore.listBackups()).map(({ time: _time, ...item }) => item);
}

async function restoreBackup(backupName) {
  let restoredIdentity;
  const result = await workbookStore.restore(backupName, async (target) => {
    const restored = await validateWorkbookFile(target);
    restoredIdentity = identityState(restored);
    try {
      const current = await validateWorkbookFile(WORKBOOK_PATH);
      mergeIdentity(restoredIdentity, identityState(current));
      const previous = await resetState(current);
      if (previous) mergeIdentity(restoredIdentity, { events: new Set(previous.ids), discarded: new Set(previous.ids), accounts: new Set(), savings: new Set(), cutoff: previous.cutoff, blocked: false });
    } catch {
      // A damaged live book cannot prove which identities have already been used.
      restoredIdentity.blocked = true;
    }
    for (const id of restoredIdentity.events) restoredIdentity.discarded.add(id);
    restoredIdentity.cutoff = [restoredIdentity.cutoff, new Date().toISOString()].filter(Boolean).sort().at(-1);
    saveIdentity(restored, restoredIdentity);
    restored.getWorksheet('Баланс').getCell(1, 14).value = JSON.stringify({ schema: 1, cutoff: restoredIdentity.cutoff, ids: [] });
    restored.getWorksheet('Баланс').hideColumn(14);
    await restored.writeFile(target);
  });
  result.warnings = result.warnings.map(() => 'Восстановление сохранено; обслуживание хранилища не завершено.');
  if (restoredIdentity.blocked) result.warnings.push('Реестр текущей книги недоступен. Импорт и выдача новых ID заблокированы до восстановления достоверных метаданных.');
  try {
    // Do not publish a destructive reset when recovery is ambiguous: retain the queue.
    if (!restoredIdentity.blocked) await writeJsonAtomic(path.join(SYNC_DIR, 'config', 'reset.json'), { schema: 1, cutoff: restoredIdentity.cutoff, ids: [...restoredIdentity.discarded] });
  } catch (error) { result.warnings.push(`Публикация границы восстановления: ${publicError(error).error}`); }
  return { restored: backupName, safetyBackup: result.backup, warnings: result.warnings, syncBlocked: restoredIdentity.blocked, data: serialize(await loadWorkbook()) };
}

export async function restoreWorkbookOffline(backupName) {
  const release = await acquireWorkbookLock(WORKBOOK_PATH, { purpose: 'server', timeout: 0 });
  try { return await restoreBackup(backupName); } finally { await release(); }
}

function identityState(workbook) {
  const state = readIdentity(workbook);
  for (const operation of readOperations(workbook)) {
    if (operation.sourceId) state.events.add(operation.sourceId);
    for (const id of [operation.accountId, operation.destinationAccountId]) if (id) state.accounts.add(id);
    if (operation.savingsAccountId) state.savings.add(operation.savingsAccountId);
  }
  for (const account of readAccounts(workbook).filter((item) => item.name || item.currency)) state.accounts.add(account.id);
  for (const opening of readOpeningBalances(workbook)) state.accounts.add(opening.accountId);
  for (const saving of readSavings(workbook)) state.savings.add(saving.id);
  const reset = workbookReset(workbook);
  if (reset) {
    for (const id of reset.ids) { state.events.add(id); state.discarded.add(id); }
    state.cutoff = [state.cutoff, reset.cutoff].filter(Boolean).sort().at(-1);
  }
  return state;
}

async function mutateWorkbook(mutator, { publish = true, includeData = true } = {}) {
  await loadCbrRateCache();
  let payload;
  const prepared = new Set();
  const unavailableOptionalRates = new Set();
  for (;;) {
    const task = writeQueue.then(() => workbookStore.exclusive(() => mutationContext.run({ unavailableOptionalRates }, async () => {
      const workbook = await validateWorkbookFile(WORKBOOK_PATH);
      const identity = identityState(workbook);
      const mutation = await mutator(workbook);
      if (mutation?.skipSave) return { result: mutation.result, backup: null, data: includeData ? serialize(workbook) : undefined };
      saveIdentity(workbook, mergeIdentity(identity, identityState(workbook)));
      recalculateAccountCells(workbook);
      const result = mutation;
      const saved = await saveWorkbook(workbook);
      workbook.revision = digest(await readFile(WORKBOOK_PATH));
      return { result, backup: saved.backup, warnings: saved.warnings.map(() => 'Запись сохранена; обслуживание хранилища не завершено. Проверьте резервные копии.'), data: includeData ? serialize(workbook) : undefined };
    })));
    writeQueue = task.catch(() => {});
    try { payload = await task; break; }
    catch (error) {
      if (error instanceof PrepareReferenceRate) {
        const key = `${error.currency}:${error.date}`;
        try { await fetchCbrRate(error.currency, error.date); }
        catch { unavailableOptionalRates.add(key); }
        continue;
      }
      if (!(error instanceof PrepareRate)) throw error;
      const key = `${error.currency}:${error.date}`;
      if (prepared.has(key)) throw new InputError('Данные изменились. Повторите действие.', 409, 'CONFLICT');
      prepared.add(key);
      await fetchCbrRate(error.currency, error.date);
      // Reload and validate all account identities and amounts again under the lock.
    }
  }

  if (publish && payload.backup) {
    try { await exportMobileBalancesOnce(); }
    catch (error) { if (process.env.NODE_ENV !== 'test') diagnose(error); }
  }
  return payload;
}

// Explicit maintenance only; never run this migration while rendering history.
export async function repairTransferRatesOnce() {
  return mutateWorkbook(async (workbook) => {
    const transfers = readOperations(workbook).filter((item) => item.type === 'Перевод' && item.currency !== 'RUB' && item.rate === 1);
    if (!transfers.length) return { skipSave: true, result: { repaired: 0 } };
    const rates = await Promise.all(transfers.map((item) => fetchCbrRate(item.currency, item.date)));
    const sheet = workbook.getWorksheet('Операции');
    transfers.forEach((item, index) => {
      const rate = rates[index].rate;
      sheet.getCell(item.id, 7).value = rate;
      sheet.getCell(item.id, 8).value = {
        formula: `IF(OR(E${item.id}="",F${item.id}=""),"",IF(F${item.id}="RUB",E${item.id},IF(G${item.id}="", "",E${item.id}*G${item.id})))`,
        result: item.amount * rate,
      };
    });
    return { repaired: transfers.length };
  });
}

function validateOperation(body, { requireAccount = true } = {}) {
  object(body);
  const isTransfer = body.type === 'Перевод';
  const isInvestment = body.type === 'Инвестиция';
  const operation = {
    date: textField(body.date, 10, 'date', { optional: false }),
    type: textField(body.type, 20, 'type', { optional: false }),
    category: textField(body.category, 100, 'category', { optional: true }),
    amount: numberField(body.amount, { positive: true }),
    currency: textField(body.currency, 3, 'currency', { optional: false }),
    rate: isTransfer || body.currency === 'RUB' ? 1 : rateField(body.rate),
    necessity: textField(body.necessity, 100, 'necessity', { optional: true }),
    notes: textField(body.notes, 500, 'notes', { optional: true }),
    sourceId: textField(body.sourceId, 128, 'sourceId', { optional: true }),
    accountId: rowId(body.accountId, { optional: !requireAccount }),
    destinationAccountId: rowId(body.destinationAccountId, { optional: !isTransfer }),
    destinationAmount: isTransfer || isInvestment ? numberField(body.destinationAmount ?? 0) : 0,
    savingsAccountId: isInvestment ? rowId(body.savingsAccountId, { min: 2, max: 1048576 }) : null,
  };
  if (!calendarDate(operation.date)) throw new InputError('Укажите корректную дату.');
  if (!SYSTEM_OPERATION_TYPES.includes(operation.type)) throw new InputError('Выберите тип операции.');
  if (!isTransfer && !isInvestment && !operation.category) throw new InputError('Выберите категорию.');
  if (!(operation.amount > 0)) throw new InputError('Сумма должна быть больше нуля.');
  if (!/^[A-Z]{3}$/.test(operation.currency)) throw new InputError('Выберите валюту.');
  if (operation.amount * operation.rate > 1e12) throw new InputError('Рублёвый эквивалент превышает 1e12.');
  if (isTransfer) operation.rate = 1;
  if (operation.currency === 'RUB') operation.rate = 1;
  if (!(operation.rate > 0)) throw new InputError('Для иностранной валюты нужен курс к рублю.');
  if (requireAccount && !operation.accountId) throw new InputError(operation.type === 'Доход' ? 'Выберите счёт зачисления.' : 'Выберите счёт списания.');
  if (isTransfer) {
    operation.category = '';
    operation.necessity = '';
    if (!operation.destinationAccountId) throw new InputError('Выберите счёт назначения.');
    if (operation.destinationAccountId === operation.accountId) throw new InputError('Счета перевода должны отличаться.');
  } else if (isInvestment) {
    operation.category = '';
    operation.necessity = '';
    if (!operation.savingsAccountId) throw new InputError('Выберите счёт накоплений.');
    if (!(operation.destinationAmount > 0)) throw new InputError('Укажите сумму зачисления на накопительный счёт.');
    operation.destinationAccountId = null;
  } else {
    operation.destinationAccountId = null;
    operation.destinationAmount = 0;
    if (operation.type === 'Доход') operation.necessity = '';
  }
  if (operation.sourceId && !/^[A-Za-z0-9][A-Za-z0-9._:-]{5,127}$/.test(operation.sourceId)) throw new InputError('Некорректный идентификатор синхронизированной операции.');
  return operation;
}

function validateOperationAccounts(workbook, operation, { requireAccount = true } = {}) {
  const lists = readLists(workbook, false);
  if (!lists.currencies.includes(operation.currency)) throw new InputError('Валюта отсутствует в справочнике.');
  if (!['Перевод', 'Инвестиция'].includes(operation.type) && !lists.categories.some((item) => item.name === operation.category && item.type === operation.type)) throw new InputError('Категория не соответствует типу операции или отсутствует в справочнике.');
  if (operation.necessity && !lists.necessities.includes(operation.necessity)) throw new InputError('Необходимость отсутствует в справочнике.');
  const accounts = new Map(readAccounts(workbook).filter((account) => account.active).map((account) => [account.id, account]));
  if (!operation.accountId && !requireAccount) return operation;
  const account = accounts.get(operation.accountId);
  if (!account) throw new InputError('Выбранный счёт больше не существует.');
  if (account.currency !== operation.currency) throw new InputError(`Валюта операции должна совпадать с валютой счёта «${account.name}».`);
  if (operation.type === 'Перевод') {
    const destination = accounts.get(operation.destinationAccountId);
    if (!destination) throw new InputError('Счёт назначения больше не существует.');
    if (account.currency === destination.currency) operation.destinationAmount = operation.amount;
    if (!(operation.destinationAmount > 0)) throw new InputError('Укажите сумму зачисления.');
  } else if (operation.type === 'Инвестиция') {
    const savings = readSavings(workbook).find((item) => item.id === operation.savingsAccountId);
    if (!savings) throw new InputError('Выбранный накопительный счёт больше не существует.');
    if (!['Вклад', 'Отложенные'].includes(savings.type)) throw new InputError('Тип накопительного счёта не поддерживается для инвестиций.');
    if (savings.currency === account.currency && operation.amount !== operation.destinationAmount) throw new InputError('Для счетов в одной валюте суммы списания и зачисления должны совпадать.');
    operation.category = savings.type === 'Вклад' ? 'Вклад' : 'Отложенные';
    operation.savingsTransfer = 'investment';
    operation.savingsAmount = operation.destinationAmount;
    operation.necessity = '';
  }
  return operation;
}

function validateReferenceLists(body) {
  object(body);
  const strings = (value, label) => {
    if (!Array.isArray(value)) throw new InputError(`Некорректный список «${label}».`);
    const items = value.map((item) => textField(item, 100, label)).filter(Boolean);
    if (!items.length) throw new InputError(`Список «${label}» не может быть пустым.`);
    if (items.length > 200) throw new InputError(`В списке «${label}» слишком много значений.`);
    if (items.some((item) => item.length > 100)) throw new InputError(`Слишком длинное значение в списке «${label}».`);
    if (new Set(items.map((item) => item.toLocaleLowerCase('ru-RU'))).size !== items.length) throw new InputError(`В списке «${label}» есть повторы.`);
    return items;
  };
  if (!Array.isArray(body.categories)) throw new InputError('Некорректный список категорий.');
  const categories = body.categories.map((item) => ({ name: textField(item?.name, 100, 'Категория'), type: textField(item?.type, 20, 'Тип'), emoji: textField(item?.emoji, 16, 'Эмодзи', { optional: true }) })).filter((item) => item.name);
  if (!categories.length || categories.length > 200) throw new InputError('Добавьте хотя бы одну категорию.');
  if (categories.some((item) => item.name.length > 100 || !['Доход', 'Расход'].includes(item.type))) throw new InputError('Проверьте названия и типы категорий.');
  if (categories.some((item) => item.emoji.length > 16 || /[\r\n]/.test(item.emoji))) throw new InputError('Эмодзи категории должно быть коротким и записываться в одну строку.');
  if (!categories.some((item) => item.type === 'Доход') || !categories.some((item) => item.type === 'Расход')) throw new InputError('Нужна хотя бы одна категория дохода и расхода.');
  if (new Set(categories.map((item) => item.name.toLocaleLowerCase('ru-RU'))).size !== categories.length) throw new InputError('Названия категорий не должны повторяться.');
  const currencies = strings(body.currencies, 'Валюты').map((item) => item.toUpperCase());
  if (new Set(currencies).size !== currencies.length) throw new InputError('В списке «Валюты» есть повторы.');
  if (!currencies.includes('RUB')) throw new InputError('В списке валют должна оставаться RUB.');
  return {
    categories,
    currencies,
    paymentMethods: strings(body.paymentMethods, 'Способы оплаты'),
    necessities: strings(body.necessities, 'Необходимость'),
  };
}

function writeReferenceLists(workbook, lists) {
  const sheet = workbook.getWorksheet('Списки');
  const lastRow = Math.max(sheet.rowCount, lists.categories.length + 1, lists.currencies.length + 1, lists.paymentMethods.length + 1, lists.necessities.length + 1);
  for (let row = 2; row <= lastRow; row += 1) {
    for (const column of [1, 2, 3, 4, 6, 8]) sheet.getCell(row, column).value = null;
  }
  lists.categories.forEach((item, index) => {
    sheet.getCell(index + 2, 1).value = item.name;
    sheet.getCell(index + 2, 2).value = item.type;
    sheet.getCell(index + 2, 3).value = item.emoji;
  });
  const writeColumn = (column, values) => values.forEach((value, index) => { sheet.getCell(index + 2, column).value = value; });
  writeColumn(4, lists.currencies);
  writeColumn(6, lists.paymentMethods);
  writeColumn(8, lists.necessities);

  ensureSystemInvestmentCategories(workbook);
  ensureSystemOperationTypes(workbook);
  const operationTypes = readLists(workbook, false).operationTypes;
  const ranges = new Map([
    ['A', lists.categories.length + SYSTEM_INVESTMENT_CATEGORIES.length], ['D', lists.currencies.length], ['F', lists.paymentMethods.length],
    ['H', lists.necessities.length], ['J', operationTypes.length],
  ]);
  const operations = workbook.getWorksheet('Операции');
  for (const formula of Array.from(operations.document.getElementsByTagNameNS(SHEET_NS, 'formula1'))) {
    let value = nodeText(formula);
    for (const [column, length] of ranges) {
      value = value.replace(new RegExp(`(Списки!\\$${column}\\$2:\\$${column}\\$)\\d+`, 'g'), `$1${Math.max(2, length + 1)}`);
    }
    formula.textContent = value;
  }
}

function writeOperation(sheet, row, operation) {
  sheet.getCell(row, 1).value = excelDate(operation.date);
  sheet.getCell(row, 2).value = operation.type;
  sheet.getCell(row, 3).value = operation.category;
  sheet.getCell(row, 4).value = null;
  sheet.getCell(row, 5).value = operation.amount;
  sheet.getCell(row, 6).value = operation.currency;
  sheet.getCell(row, 7).value = operation.currency === 'RUB' ? null : operation.rate;
  sheet.getCell(row, 8).value = {
    formula: `IF(OR(E${row}="",F${row}=""),"",IF(F${row}="RUB",E${row},IF(G${row}="", "",E${row}*G${row})))`,
    result: operation.amount * operation.rate,
  };
  sheet.getCell(row, 9).value = null;
  sheet.getCell(row, 10).value = operation.type === 'Доход' ? '' : operation.necessity;
  sheet.getCell(row, 11).value = operation.notes;
  if (operation.sourceId) {
    sheet.getCell(row, 12).value = operation.sourceId;
    sheet.hideColumn(12);
  }
  sheet.getCell(row, 13).value = operation.accountId || null;
  sheet.getCell(row, 14).value = operation.type === 'Перевод' ? operation.destinationAccountId : null;
  sheet.getCell(row, 15).value = operation.type === 'Перевод' ? operation.destinationAmount : null;
  sheet.getCell(row, 16).value = operation.savingsTransfer || null;
  sheet.getCell(row, 17).value = operation.savingsAccountId || null;
  sheet.getCell(row, 18).value = operation.savingsTransfer ? operation.savingsAmount : null;
  const recordedAt = Object.hasOwn(operation, 'recordedAt')
    ? (timestamp(operation.recordedAt || '') ? new Date(operation.recordedAt).toISOString() : null)
    : (timestamp(operation.sourceCreatedAt || '') ? new Date(operation.sourceCreatedAt).toISOString() : new Date().toISOString());
  sheet.getCell(row, 19).value = recordedAt;
  sheet.hideColumn(19);
  if (operation.savingsTransfer) {
    sheet.hideColumn(16); sheet.hideColumn(17); sheet.hideColumn(18);
  }
}

function linkedSavingsMovement(workbook, row) {
  const sheet = workbook.getWorksheet('Операции');
  const linkedKind = clean(sheet.getCell(row, 16).value);
  if (!['investment', 'from-savings'].includes(linkedKind)) {
    throw new InputError('Межсистемный перевод нельзя редактировать как обычную операцию.', 409, 'LINKED_MOVEMENT_MISMATCH');
  }
  const operation = readOperations(workbook).find((item) => item.id === row);
  const savingsAccountId = asNumber(sheet.getCell(row, 17).value);
  const savingsAmount = asNumber(sheet.getCell(row, 18).value);
  const date = dateToIso(sheet.getCell(row, 1).value);
  const expectedType = linkedKind === 'investment' ? 'Инвестиция' : 'Перевод';
  const expectedMovementType = expectedType;
  const sourceAccountId = asNumber(sheet.getCell(row, 13).value);
  const destinationAccountId = asNumber(sheet.getCell(row, 14).value);
  const destinationAmount = asNumber(sheet.getCell(row, 15).value);
  const validLinkedOperation = operation
    && operation.type === expectedType
    && operation.amount > 0
    && savingsAccountId > 0
    && savingsAmount > 0
    && operation.savingsAccountId === savingsAccountId
    && operation.savingsAmount === savingsAmount
    && (linkedKind === 'investment'
      ? sourceAccountId > 0 && operation.accountId === sourceAccountId && !destinationAccountId && !destinationAmount
      : !sourceAccountId && destinationAccountId > 0 && destinationAmount > 0 && operation.destinationAccountId === destinationAccountId
        && operation.destinationAmount === destinationAmount && savingsAmount === operation.amount);
  if (!validLinkedOperation) {
    throw new InputError('Связь перевода с движением накоплений повреждена; запись не изменена.', 409, 'LINKED_MOVEMENT_MISMATCH');
  }
  const { movements } = savingsSheets(workbook);
  const linkedRows = [];
  for (let movementRow = 2; movementRow <= movements.rowCount; movementRow += 1) {
    if (asNumber(movements.getCell(movementRow, 5).value) === row) linkedRows.push(movementRow);
  }
  if (linkedRows.length !== 1) {
    throw new InputError('Не удалось однозначно найти связанное движение накоплений; запись не изменена.', 409, 'LINKED_MOVEMENT_MISMATCH');
  }
  const movementRow = linkedRows[0];
  if (asNumber(movements.getCell(movementRow, 1).value) !== savingsAccountId
    || dateToIso(movements.getCell(movementRow, 2).value) !== date
    || asNumber(movements.getCell(movementRow, 3).value) !== (linkedKind === 'investment' ? savingsAmount : -savingsAmount)
    || clean(movements.getCell(movementRow, 4).value) !== expectedMovementType) {
    throw new InputError('Связь перевода с движением накоплений повреждена; запись не изменена.', 409, 'LINKED_MOVEMENT_MISMATCH');
  }
  return { linkedKind, movementRow, savingsAccountId, savingsAmount, date };
}

export function migrateAccountModel(workbook) {
  if (hasAccountModel(workbook)) return { changed: false };

  const operations = workbook.getWorksheet('Операции');
  operations.getCell(2, 1).value = 'Доходы и расходы привязываются к счёту. Перевод перемещает деньги между своими счетами и не влияет на финансовый результат.';
  operations.getCell(4, 12).value = 'ID синхронизации';
  operations.getCell(4, 13).value = 'Счёт (ID строки Баланса)';
  operations.getCell(4, 14).value = 'Счёт назначения (ID)';
  operations.getCell(4, 15).value = 'Сумма назначения';
  operations.hideColumn(12);
  const dimension = operations.document.getElementsByTagNameNS(SHEET_NS, 'dimension')[0];
  if (dimension) dimension.setAttribute('ref', dimension.getAttribute('ref').replace(/:[A-Z]+(\d+)$/, (_match, lastRow) => `:O${lastRow}`));

  const lists = workbook.getWorksheet('Списки');
  const operationTypes = [];
  for (let row = 2; row <= 10; row += 1) {
    const value = clean(lists.getCell(row, 10).value);
    if (value) operationTypes.push(value);
  }
  if (!operationTypes.includes('Перевод')) lists.getCell(operationTypes.length + 2, 10).value = 'Перевод';
  for (const formula of Array.from(operations.document.getElementsByTagNameNS(SHEET_NS, 'formula1'))) {
    formula.textContent = nodeText(formula).replace(/(Списки!\$J\$2:\$J\$)\d+/g, (_match, prefix) => `${prefix}4`);
  }

  const balance = workbook.getWorksheet('Баланс');
  balance.getCell(1, 1).value = 'СЧЕТА И РАСЧЁТНЫЕ ОСТАТКИ';
  balance.getCell(2, 1).value = 'Остатки рассчитываются от нуля по привязанным операциям; будущие операции не учитываются.';
  const headers = new Map([[1, 'Счёт'], [2, 'Валюта'], [4, 'Курс ЦБ на сегодня'], [5, 'Текущий остаток'], [11, 'Эквивалент в рублях']]);
  for (let column = 1; column <= 12; column += 1) balance.getCell(4, column).value = headers.get(column) || null;
  for (let row = 5; row <= ACCOUNT_MAX_ROW; row += 1) {
    for (const column of [3, 6, 7, 8, 9, 10, 12]) balance.getCell(row, column).value = null;
  }
  const balanceDimension = balance.document.getElementsByTagNameNS(SHEET_NS, 'dimension')[0];
  if (balanceDimension) balanceDimension.setAttribute('ref', balanceDimension.getAttribute('ref').replace(/:[A-Z]+(\d+)$/, (_match, lastRow) => `:K${lastRow}`));
  recalculateAccountCells(workbook);
  return { changed: true };
}

export function migrateCategoryEmojis(workbook) {
  const sheet = workbook.getWorksheet('Списки');
  let changed = false;
  for (let row = 2; row <= Math.max(sheet.rowCount, 30); row += 1) {
    const name = clean(sheet.getCell(row, 1).value);
    const type = clean(sheet.getCell(row, 2).value);
    if (!name || !['Доход', 'Расход'].includes(type) || clean(sheet.getCell(row, 3).value)) continue;
    sheet.getCell(row, 3).value = CATEGORY_EMOJIS.get(name) || (type === 'Доход' ? '💰' : '📌');
    changed = true;
  }
  return { changed };
}

export function migrateStreamlinedModel(workbook) {
  const operations = workbook.getWorksheet('Операции');
  const balance = workbook.getWorksheet('Баланс');
  const obsoleteHeaders = [3, 6, 7, 8, 9, 10, 12];
  const legacyColumnsHidden = obsoleteHeaders.every((column) => Array.from(balance.document.getElementsByTagNameNS(SHEET_NS, 'col'))
    .some((item) => Number(item.getAttribute('min')) <= column && Number(item.getAttribute('max')) >= column && item.getAttribute('hidden') === '1'));
  const hasObsoleteBalanceData = obsoleteHeaders.some((column) => {
    if (clean(balance.getCell(4, column).value)) return true;
    for (let row = 5; row <= Math.max(balance.rowCount, ACCOUNT_MAX_ROW); row += 1) {
      if (clean(balance.getCell(row, column).value)) return true;
    }
    return false;
  });
  if (clean(operations.getCell(4, 11).value) === 'Заметка' && !hasObsoleteBalanceData && legacyColumnsHidden) return { changed: false };
  operations.getCell(4, 4).value = 'Описание (устар.)';
  operations.getCell(4, 9).value = 'Способ оплаты (устар.)';
  operations.getCell(4, 11).value = 'Заметка';
  operations.hideColumn(4);
  operations.hideColumn(9);
  for (const column of [1, 2, 4, 5, 11]) balance.getCell(4, column).value = column === 1 ? 'Счёт' : column === 2 ? 'Валюта' : column === 4 ? 'Курс ЦБ на сегодня' : column === 5 ? 'Текущий остаток' : 'Эквивалент в рублях';
  for (const column of obsoleteHeaders) {
    balance.getCell(4, column).value = null;
    for (let row = 5; row <= Math.max(balance.rowCount, ACCOUNT_MAX_ROW); row += 1) balance.getCell(row, column).value = null;
    balance.hideColumn(column);
  }
  for (const account of readAccounts(workbook).filter((item) => item.active)) balance.getCell(account.id, 11).value = account.rubAmount;
  const dimension = balance.document.getElementsByTagNameNS(SHEET_NS, 'dimension')[0];
  if (dimension) dimension.setAttribute('ref', dimension.getAttribute('ref').replace(/:[A-Z]+(\d+)$/, (_match, lastRow) => `:K${lastRow}`));
  return { changed: true };
}

async function createOperation(body, options = {}) {
  return mutateWorkbook(async (workbook) => {
    if (body.sourceId && await isResetEvent(workbook, body.sourceId, body.sourceCreatedAt)) {
      return { skipSave: true, result: { discarded: true, duplicate: true } };
    }
    const sheet = workbook.getWorksheet('Операции');
    const sourceId = clean(body.sourceId);
    if (sourceId) {
      const state = identityState(workbook);
      assertIdentityAvailable(state);
      if (state.events.has(sourceId)) {
        const previous = readOperations(workbook).find((item) => item.sourceId === sourceId);
        return { skipSave: true, result: { id: previous?.id, discarded: !previous, duplicate: true } };
      }
    }
    const operation = validateOperation(body);
    if (options.recordedAt !== undefined) operation.recordedAt = options.recordedAt;
    validateOperationAccounts(workbook, operation);
    if (operation.type === 'Перевод') operation.rate = (await fetchCbrRate(operation.currency, operation.date)).rate;
    await prepareOperationReferenceRates(workbook, operation);
    if (operation.amount * operation.rate > 1e12) throw new InputError('Рублёвый эквивалент превышает 1e12.');
    if (operation.type === 'Инвестиция') {
      ensureSystemInvestmentCategories(workbook);
      ensureSystemOperationTypes(workbook);
    }
    let targetRow = 0;
    for (let row = 5; row <= sheet.rowCount; row += 1) {
      const hasData = [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19].some((column) => clean(sheet.getCell(row, column).value));
      if (!hasData) { targetRow = row; break; }
    }
    if (!targetRow) {
      ensureOperationCapacity(workbook);
      targetRow = sheet.rowCount - 99;
    }
    writeOperation(sheet, targetRow, operation);
    if (operation.type === 'Инвестиция') {
      const { movements } = savingsSheets(workbook);
      const movementRow = Math.max(2, movements.rowCount + 1);
      [operation.savingsAccountId, excelDate(operation.date), operation.savingsAmount, 'Инвестиция', targetRow, operation.notes].forEach((value, index) => { movements.getCell(movementRow, index + 1).value = value; });
    }
    const capacity = ensureOperationCapacity(workbook);
    return { id: targetRow, duplicate: false, capacity };
  }, options);
}

async function loadCbrRateCache() {
  if (!cbrCacheLoadPromise) {
    cbrCacheLoadPromise = readFile(CBR_CACHE_PATH, 'utf8').then((text) => {
      const payload = JSON.parse(text);
      if (payload?.schema !== 1 || !payload.rates || typeof payload.rates !== 'object') return;
      for (const [key, value] of Object.entries(payload.rates)) {
        if (value && /^[A-Z]{3}:\d{4}-\d{2}-\d{2}$/.test(key) && Number.isFinite(value.rate) && value.rate > 0) cbrRateCache.set(key, value);
      }
    }).catch(() => {});
  }
  await cbrCacheLoadPromise;
}

function persistCbrRateCache() {
  const snapshot = { schema: 1, generatedAt: new Date().toISOString(), rates: Object.fromEntries(cbrRateCache) };
  cbrCacheWriteQueue = cbrCacheWriteQueue.catch(() => {}).then(() => writeJsonAtomic(CBR_CACHE_PATH, snapshot));
  return cbrCacheWriteQueue;
}

async function fetchCbrRate(currency, date, { refresh = false } = {}) {
  if (!calendarDate(date)) throw new InputError('Некорректная дата курса.');
  if (currency === 'RUB') return { currency, rate: 1, requestedDate: date, effectiveDate: date, source: 'RUB' };
  if (!/^[A-Z]{3}$/.test(currency)) throw new InputError(`Валюта «${currency}» отсутствует в справочнике ЦБ РФ.`);
  const cacheKey = `${currency}:${date}`;
  await loadCbrRateCache();
  if (!refresh && cbrRateCache.has(cacheKey)) return cbrRateCache.get(cacheKey);
  if (mutationContext.getStore()) throw new PrepareRate(currency, date);
  // XML_daily contains the entire daily bulletin: share it across currencies.
  if (!cbrRateRequests.has(date)) {
    const request = (async () => {
      const [year, month, day] = date.split('-');
      const response = await fetch(`${CBR_BASE_URL}?date_req=${day}/${month}/${year}`, { headers: { 'User-Agent': 'FinanceWorkbook/1.0' }, signal: AbortSignal.timeout(10000) }).catch(() => { throw Object.assign(new Error('CBR unavailable'), { status: 502 }); });
      if (!response.ok) throw Object.assign(new Error('CBR unavailable'), { status: 502 });
      const reader = response.body.getReader();
      const chunks = []; let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > 1024 * 1024) throw new Error('CBR response exceeds limit');
          chunks.push(value);
        }
      } catch {
        await reader.cancel().catch(() => {});
        throw Object.assign(new Error('CBR response unavailable'), { status: 502 });
      } finally { reader.releaseLock(); }
      const xml = new TextDecoder('windows-1251').decode(Buffer.concat(chunks));
      const effective = xml.match(/ValCurs[^>]+Date="([^"]+)"/i)?.[1] || '';
      const [effectiveDay, effectiveMonth, effectiveYear] = effective.split('.');
      const rates = new Map();
      for (const entry of xml.matchAll(/<Valute\b[^>]*>([\s\S]*?)<\/Valute>/g)) {
        const body = entry[1];
        const code = body.match(/<CharCode>([A-Z]{3})<\/CharCode>/)?.[1];
        const nominal = Number(body.match(/<Nominal>([^<]+)<\/Nominal>/)?.[1].replace(',', '.'));
        const value = Number(body.match(/<Value>([^<]+)<\/Value>/)?.[1].replace(',', '.'));
        if (!code || !(nominal > 0) || !(value > 0) || !Number.isFinite(value / nominal)) continue;
        try { rateField(value / nominal); } catch { continue; }
        const result = { currency: code, rate: value / nominal, requestedDate: date,
          effectiveDate: effective ? `${effectiveYear}-${effectiveMonth}-${effectiveDay}` : date, nominal, source: 'ЦБ РФ' };
        rates.set(code, result);

      }
      if (!rates.size || !calendarDate(`${effectiveYear}-${effectiveMonth}-${effectiveDay}`)) throw Object.assign(new Error('Invalid CBR bulletin'), { status: 502 });
      for (const [code, result] of rates) cbrRateCache.set(`${code}:${date}`, result);
      await persistCbrRateCache();
      return rates;
    })();
    cbrRateRequests.set(date, request);
    request.finally(() => { if (cbrRateRequests.get(date) === request) cbrRateRequests.delete(date); }).catch(() => {});
  }
  const result = (await cbrRateRequests.get(date)).get(currency);
  if (!result) throw new InputError(`Валюта «${currency}» отсутствует в справочнике ЦБ РФ.`);
  return result;
}

async function prepareReferenceRate(currency, date) {
  if (currency === 'RUB') return;
  const key = `${currency}:${date}`;
  await loadCbrRateCache();
  if (cbrRateCache.has(key)) return;
  const context = mutationContext.getStore();
  if (context) {
    if (!context.unavailableOptionalRates.has(key)) throw new PrepareReferenceRate(currency, date);
    return;
  }
  try { await fetchCbrRate(currency, date); } catch { /* Reference-only rates do not block a manually entered transfer. */ }
}

async function prepareOperationReferenceRates(workbook, operation) {
  if (operation.type === 'Инвестиция') {
    const source = readAccounts(workbook).find((account) => account.id === operation.accountId);
    const destination = readSavings(workbook).find((account) => account.id === operation.savingsAccountId);
    await Promise.all([...new Set([source?.currency, destination?.currency].filter(Boolean))].map((currency) => prepareReferenceRate(currency, operation.date)));
  } else if (operation.type === 'Перевод' && !operation.savingsTransfer) {
    const source = readAccounts(workbook).find((account) => account.id === operation.accountId);
    const destination = readAccounts(workbook).find((account) => account.id === operation.destinationAccountId);
    await Promise.all([...new Set([source?.currency, destination?.currency].filter(Boolean))].map((currency) => prepareReferenceRate(currency, operation.date)));
  }
}

async function listJsonFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listJsonFiles(target));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) files.push(target);
  }
  return files.sort();
}

async function writeJsonAtomic(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temporary, target);
  } finally { await unlink(temporary).catch(() => {}); }
}

async function pruneReceipts(directory, retentionDays = RECEIPT_RETENTION_DAYS) {
  if (!(retentionDays > 0)) return;
  const cutoff = Date.now() - retentionDays * 86400000;
  const pendingNames = new Set((await listJsonFiles(path.join(path.dirname(directory), 'incoming'))).map((file) => path.basename(file)));
  for (const file of await listJsonFiles(directory)) {
    const details = await stat(file).catch(() => null);
    if (!details || details.mtimeMs >= cutoff) continue;
    try {
      const receipt = JSON.parse(await readFile(file, 'utf8'));
      if (receipt.schema !== 1 || typeof receipt.author !== 'string' || !receipt.author || !/^[a-f0-9]{64}$/.test(receipt.checksum) || typeof receipt.duplicate !== 'boolean' || !['imported', 'discarded'].includes(receipt.status)
        || !timestamp(receipt.importedAt) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{5,127}$/.test(receipt.id)
        || path.basename(file) !== `${receipt.id}.json`) continue;
      if (pendingNames.has(`${receipt.id}.json`)) continue;
      await unlink(file);
    } catch { /* Unknown, failed and partial receipts are retained. */ }
  }
}

function validateInboxEvent(event) {
  object(event);
  if (event.schema !== 1) throw new InputError('Поддерживается только schema: 1.');
  const id = textField(event.id, 128, 'id');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{5,127}$/.test(id)) throw new InputError('Поле id отсутствует или имеет неверный формат.');
  const author = textField(event.author, 80, 'author');
  if (!timestamp(event.createdAt)) throw new InputError('Некорректный createdAt: нужен ISO timestamp с часовым поясом.');
  object(event.operation);
  if (!author) throw new InputError('Поле author обязательно.');
  return { id, author };
}

// Backward-compatible array result for integrations; all entry points use the coordinator.
export async function importInboxOnce(rootDirectory = SYNC_DIR) {
  return (await synchronizeMobile(rootDirectory)).results;
}

async function scanInboxOnce(rootDirectory) {
  if (inboxScanPromise) return inboxScanPromise;
  inboxScanPromise = (async () => {
    const incomingDirectory = path.join(rootDirectory, 'incoming');
    const receiptsDirectory = path.join(rootDirectory, 'receipts');
    await Promise.all([mkdir(incomingDirectory, { recursive: true }), mkdir(receiptsDirectory, { recursive: true })]);
    const results = [];
    for (const file of await listJsonFiles(incomingDirectory)) {
      let raw = '';
      let eventId = path.basename(file, '.json').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100) || 'invalid-event';
      try {
        if ((await stat(file)).size > 65536) throw new InputError('Размер мобильного JSON превышает 64 KiB.', 413, 'PAYLOAD_TOO_LARGE');
        raw = await readFile(file, 'utf8');
        if (Buffer.byteLength(raw, 'utf8') > 65536) throw new InputError('Размер мобильного JSON превышает 64 KiB.', 413, 'PAYLOAD_TOO_LARGE');
        let event;
        try { event = JSON.parse(raw); } catch { throw new InputError('Некорректный JSON.', 400, 'INVALID_JSON'); }
        const identity = validateInboxEvent(event);
        eventId = identity.id;
        const operation = { ...event.operation, sourceId: identity.id, sourceCreatedAt: event.createdAt };
        if (clean(operation.currency) === 'RUB') operation.rate = 1;
        if (operation.type !== 'Перевод' && clean(operation.currency) !== 'RUB' && !(asNumber(operation.rate) > 0)) {
          const snapshot = await loadWorkbook();
          const knownIdentity = identityState(snapshot);
          assertIdentityAvailable(knownIdentity);
          if (!knownIdentity.events.has(identity.id) && !(await isResetEvent(snapshot, identity.id, event.createdAt))) operation.rate = (await fetchCbrRate(clean(operation.currency), clean(operation.date))).rate;
        }
        const payload = await createOperation(operation, { publish: false, includeData: false, recordedAt: event.createdAt });
        const receipt = {
          schema: 1,
          id: identity.id,
          author: identity.author,
          status: payload.result.discarded ? 'discarded' : 'imported',
          duplicate: payload.result.duplicate,
          excelRow: payload.result.id,
          importedAt: new Date().toISOString(),
          checksum: createHash('sha256').update(raw).digest('hex'),
          backup: payload.backup,
        };
        const receiptPath = path.join(receiptsDirectory, `${identity.id}.json`);
        await writeJsonAtomic(receiptPath, receipt);
        try {
          await unlink(file);
          receipt.sourceDeleted = true;
        } catch (cleanupError) {
          receipt.sourceDeleted = false;
          receipt.cleanupError = publicError(cleanupError).error;
        }
        // The durable success receipt already exists. A metadata-write failure must
        // never replace it with an error after the source has been removed.
        try { await writeJsonAtomic(receiptPath, receipt); }
        catch (error) { receipt.receiptWarning = publicError(error).error; }
        results.push(receipt);
      } catch (error) {
        const safe = diagnose(error);
        const receipt = { schema: 1, id: eventId, status: 'error', checkedAt: new Date().toISOString(), message: safe.error, code: safe.code, retryable: safe.retryable };
        try { await writeJsonAtomic(path.join(receiptsDirectory, `${eventId}.json`), receipt); }
        catch (receiptError) { receipt.receiptWarning = publicError(receiptError).error; }
        results.push(receipt);
      }
    }
    await pruneReceipts(receiptsDirectory);
    return results;
  })();
  try { return await inboxScanPromise; } finally { inboxScanPromise = null; }
}

// One complete cycle for the button, watcher, timer and CLI. Requests made
// during a pass require a new scan; every caller waits for that follow-up pass.
export function synchronizeMobile(rootDirectory = SYNC_DIR) {
  if (shuttingDown) return Promise.reject(Object.assign(new Error('Приложение останавливается.'), { status: 503 }));
  const root = path.resolve(rootDirectory);
  const active = syncRuns.get(root);
  if (active) { active.again = true; return active.promise; }
  const run = { again: true, promise: null };
  run.promise = syncQueue.then(async () => {
    syncStatus.running = true;
    syncStatus.directory = root;
    const results = new Map();
    const summary = { exported: true, changed: false, balancesChanged: false, warnings: [], passes: 0 };
    do {
      run.again = false;
      summary.passes += 1;
      summary.warnings = [];
      for (const receipt of await scanInboxOnce(root)) {
        const previous = results.get(receipt.id);
        results.set(receipt.id, previous?.status === 'imported' && !previous.duplicate && receipt.status === 'imported'
          ? { ...receipt, duplicate: false } : receipt);
      }
      await prepareBalanceRates();
      await withWorkbookQueue(async () => {
        const workbook = await loadWorkbook();
        const attempt = async (stage, action) => {
          try { return await action(); }
          catch (error) { summary.warnings.push(`${stage}: ${publicError(error).error}`); return null; }
        };
        await attempt('Сброс', async () => {
          if (identityState(workbook).blocked) return;
          const reset = await resetState(workbook);
          if (!reset) return;
          const target = path.join(root, 'config', 'reset.json');
          const existing = await readFile(target, 'utf8').then(JSON.parse).catch(() => null);
          if (existing?.cutoff !== reset.cutoff) await writeJsonAtomic(target, reset);
          const cleanup = await cleanupResetFiles(reset, root);
          if (cleanup.failures.length) throw new InputError(`Не удалено файлов: ${cleanup.failures.length}`);
        });
        const lists = await attempt('Справочники', () => publishMobileLists(root, workbook));
        const balances = await attempt('Балансы', () => publishMobileBalances(root, workbook));
        summary.exported = Boolean(lists && balances);
        summary.balancesPublished = Boolean(balances);
        summary.changed ||= Boolean(lists?.changed);
        summary.balancesChanged ||= Boolean(balances?.changed);
        summary.path = lists?.path;
        summary.generatedAt = balances?.payload.generatedAt;
        if (balances?.payload.missingRates.length) summary.warnings.push(`Нет курсов: ${balances.payload.missingRates.join(', ')}`);
      });
    } while (run.again);
    summary.results = [...results.values()];
    summary.imported = summary.results.filter((item) => item.status === 'imported' && !item.duplicate).length;
    summary.duplicates = summary.results.filter((item) => item.status === 'imported' && item.duplicate).length;
    summary.discarded = summary.results.filter((item) => item.status === 'discarded').length;
    summary.errors = summary.results.filter((item) => item.status === 'error').length;
    summary.cleanupPending = summary.results.filter((item) => item.sourceDeleted === false).length;
    summary.warnings.push(...summary.results.filter((item) => item.receiptWarning).map((item) => item.receiptWarning));
    summary.completedAt = new Date().toISOString();
    summary.ok = !summary.errors && !summary.cleanupPending && !summary.warnings.length;
    Object.assign(syncStatus, {
      enabled: true, lastScanAt: summary.completedAt, imported: summary.imported,
      duplicates: summary.duplicates, errors: summary.errors, cleanupPending: summary.cleanupPending,
      lastError: summary.results.find((item) => item.status === 'error')?.message
        || (summary.cleanupPending ? `Ожидают удаления: ${summary.cleanupPending}` : null)
        || summary.warnings[0] || null,
    });
    return summary;
  }).catch((error) => { syncStatus.lastError = publicError(error).error; throw error; })
    .finally(() => { syncStatus.running = false; syncRuns.delete(root); });
  syncRuns.set(root, run);
  syncQueue = run.promise.catch(() => {});
  return run.promise;
}

export function startInboxImporter(rootDirectory = SYNC_DIR, intervalMs = 5000) {
  syncStatus.enabled = true;
  syncStatus.directory = rootDirectory;
  let stopped = false;
  let watcher = null;
  let debounce = null;
  const incoming = path.join(rootDirectory, 'incoming');
  const scan = () => {
    if (stopped) return;
    synchronizeMobile(rootDirectory).catch((error) => {
      if (process.env.NODE_ENV !== 'test') diagnose(error);
    });
  };
  const attachWatcher = async () => {
    if (stopped || watcher) return;
    try {
      await mkdir(incoming, { recursive: true });
      if (stopped || watcher) return;
      watcher = watch(incoming, { recursive: true }, (_event, filename) => {
        if (filename && !String(filename).toLowerCase().endsWith('.json')) return;
        clearTimeout(debounce);
        debounce = setTimeout(scan, 150);
        debounce.unref?.();
      });
      watcher.on('error', () => { watcher?.close(); watcher = null; });
      watcher.unref();
    } catch { /* Periodic scanning remains available if watching is unsupported. */ }
  };
  // Install the watcher before the initial scan, avoiding a startup gap.
  attachWatcher().then(scan);
  const timer = setInterval(() => { attachWatcher(); if (!syncRuns.has(path.resolve(rootDirectory))) scan(); }, intervalMs);
  timer.unref();
  const stop = () => { stopped = true; clearInterval(timer); clearTimeout(debounce); watcher?.close(); importerStops.delete(stop); };
  importerStops.add(stop);
  return stop;
}

function clearSheetRows(sheet, firstRow, lastColumn, keep = new Set()) {
  for (const [reference] of sheet.cells) {
    const row = Number(reference.match(/\d+$/)[0]);
    const column = columnNumber(reference.match(/^[A-Z]+/)[0]);
    if (row >= firstRow && column <= lastColumn && !keep.has(column)) sheet.getCell(row, column).value = null;
  }
}

function workbookReset(workbook) {
  const raw = clean(workbook.getWorksheet('Баланс').getCell(1, 14).value);
  if (!raw) return null;
  let value;
  try { value = JSON.parse(raw); } catch { throw Object.assign(new Error('Повреждены метаданные сброса Excel.'), { status: 409 }); }
  if (value?.schema !== 1 || !Array.isArray(value.ids) || value.ids.some((id) => typeof id !== 'string') || !Number.isFinite(Date.parse(value.cutoff))) throw Object.assign(new Error('Повреждены метаданные сброса Excel.'), { status: 409 });
  return value;
}

async function resetState(workbook) {
  const state = identityState(workbook);
  const stored = workbookReset(workbook);
  const published = await readFile(path.join(SYNC_DIR, 'config', 'reset.json'), 'utf8').then(JSON.parse).catch(() => null);
  const candidates = [stored, published, state.cutoff && { schema: 1, cutoff: state.cutoff, ids: [...state.discarded] }]
    .filter((item) => item?.schema === 1 && Array.isArray(item.ids) && item.ids.every((id) => typeof id === 'string') && Number.isFinite(Date.parse(item.cutoff)));
  if (!candidates.length) return null;
  return { schema: 1, cutoff: candidates.map((item) => item.cutoff).sort().at(-1), ids: [...new Set(candidates.flatMap((item) => item.ids))] };
}

async function isResetEvent(workbook, id, createdAt) {
  assertIdentityAvailable(identityState(workbook));
  const reset = await resetState(workbook);
  return Boolean(reset && (reset.ids.includes(id) || !Number.isFinite(Date.parse(createdAt)) || Date.parse(createdAt) <= Date.parse(reset.cutoff)));
}

async function cleanupResetFiles(reset, rootDirectory = SYNC_DIR) {
  const removed = [];
  const failures = [];
  const incoming = path.join(rootDirectory, 'incoming');
  const remove = async (file) => { try { await unlink(file); removed.push(path.relative(rootDirectory, file)); } catch (error) { if (error.code !== 'ENOENT') failures.push(path.relative(rootDirectory, file)); } };
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (entry.name !== '.stfolder') await walk(file); continue; }
      const relative = path.relative(incoming, file);
      const inQueue = relative && !relative.startsWith('..') && !path.isAbsolute(relative);
      if (inQueue && /\.(json|pending)$/i.test(entry.name)) {
        const event = await readFile(file, 'utf8').then(JSON.parse).catch(() => null);
        try { validateInboxEvent(event); } catch { continue; }
        const created = Date.parse(event.createdAt);
        if (reset.ids.includes(event?.id) || (Number.isFinite(created) ? created <= Date.parse(reset.cutoff) : (await stat(file)).mtimeMs <= Date.parse(reset.cutoff))) await remove(file);
      } else if (/\.md$/i.test(entry.name)) {
        const markdown = await readFile(file, 'utf8');
        if (!/^---\r?\nfinance_capture: true\r?\n/.test(markdown)) continue;
        const value = (key) => { try { return JSON.parse(markdown.match(new RegExp('^' + key + ': (.+)$', 'm'))?.[1] || 'null'); } catch { return null; } };
        const id = value('finance_id'), linked = value('finance_json');
        if (typeof linked !== 'string' || !linked.replaceAll('\\', '/').includes('/incoming/')) continue;
        const created = Date.parse(value('created_at'));
        if (reset.ids.includes(id) || (Number.isFinite(created) && created <= Date.parse(reset.cutoff))) await remove(file);
      }
    }
  };
  await walk(rootDirectory);
  return { removed: removed.length, failures };
}

app.post('/api/settings/clear-data', async (req, res, next) => {
  try {
    const mode = req.body?.mode;
    if (!['history', 'all'].includes(mode) || req.body.confirmation !== (mode === 'all' ? 'ПОЛНАЯ ОЧИСТКА' : 'УДАЛИТЬ ИСТОРИЮ')) throw new InputError('Подтвердите выбранную очистку.');
    if (inboxScanPromise) await inboxScanPromise;
    const payload = await mutateWorkbook(async (workbook) => {
      assertIdentityAvailable(identityState(workbook));
      const previous = await resetState(workbook);
      const reset = { schema: 1, cutoff: [previous?.cutoff, new Date().toISOString()].filter(Boolean).sort().at(-1), ids: [...new Set([...(previous?.ids || []), ...identityState(workbook).events])] };
      const operations = workbook.getWorksheet('Операции');
      clearSheetRows(operations, 5, 19, new Set([8]));
      for (let row = 5; row <= operations.rowCount; row += 1) {
        operations.getCell(row, 8).value = { formula: `IF(OR(E${row}="",F${row}=""),"",IF(F${row}="RUB",E${row},IF(G${row}="","",E${row}*G${row})))`, result: '' };
      }
      const balance = workbook.getWorksheet('Баланс');
      clearSheetRows(balance, 5, 13, new Set(mode === 'all' ? [] : [1, 2, 4, 13]));
      const { accounts: savingAccounts, movements } = savingsSheets(workbook);
      clearSheetRows(movements, 2, 6);
      if (mode === 'all') {
        clearSheetRows(savingAccounts, 2, 5);
        const opening = openingBalanceSheet(workbook);
        clearSheetRows(opening, 2, 4);
      }
      balance.getCell(1, 14).value = JSON.stringify({ ...reset, ids: [] });
      const state = identityState(workbook);
      for (const id of reset.ids) { state.events.add(id); state.discarded.add(id); }
      state.cutoff = reset.cutoff;
      saveIdentity(workbook, state);
      balance.hideColumn(14);
      return { cleared: mode, reset };
    });
    const warnings = [];
    let cleanup = { removed: 0, failures: [] };
    try { await writeJsonAtomic(path.join(SYNC_DIR, 'config', 'reset.json'), payload.result.reset); cleanup = await cleanupResetFiles(payload.result.reset); } catch (error) { warnings.push(publicError(error).error); }
    try { await exportMobileListsOnce(); } catch (error) { warnings.push(publicError(error).error); }
    res.json({ ...payload, cleanup, warnings });
  } catch (error) { next(error); }
});

app.put('/api/accounts/order', async (req, res, next) => {
  try {
    const ids = req.body?.ids;
    const payload = await mutateWorkbook(async (workbook) => {
      const active = readAccounts(workbook).filter((account) => account.active);
      if (!Array.isArray(ids) || ids.length !== active.length || new Set(ids).size !== ids.length || ids.some((id) => !active.some((account) => account.id === id))) throw new InputError('Порядок должен содержать все активные счета ровно один раз.');
      if (ids.every((id, index) => active[index].id === id)) return { skipSave: true, result: { ordered: false } };
      const sheet = workbook.getWorksheet('Баланс');
      ids.forEach((id, index) => { sheet.getCell(id, 13).value = index + 1; });
      sheet.hideColumn(13);
      return { ordered: true };
    });
    try {
      await exportMobileListsOnce();
      res.json(payload);
    } catch (error) { res.json({ ...payload, warning: `Порядок сохранён; синхронизация повторится: ${publicError(error).error}` }); }
  } catch (error) { next(error); }
});

app.get('/api/balance/currency-comparison', async (_req, res, next) => {
  try {
    const today = localIsoDate(), firstDay = `${today.slice(0, 7)}-01`;
    const refreshRates = clean(_req.query?.refresh).toLowerCase() === 'true';
    const totals = new Map();
    const workbook = await loadWorkbook();
    const selected = clean(_req.query?.ledger) === 'savings' ? readSavings(workbook) : readAccounts(workbook).filter((item) => item.active);
    for (const account of selected) totals.set(account.currency, (totals.get(account.currency) || 0) + account.calculatedBalance);
    const lookups = new Map();
    const getRate = (currency, date) => {
      const key = `${currency}:${date}`;
      if (!lookups.has(key)) lookups.set(key, fetchCbrRate(currency, date, { refresh: refreshRates }));
      return lookups.get(key);
    };
    const currentRates = new Map();
    const rateErrors = {};
    const requiredCurrencies = new Set([...totals.keys(), 'USD']);
    if (refreshRates) {
      for (const account of [...readAccounts(workbook).filter((item) => item.active), ...readSavings(workbook)]) requiredCurrencies.add(account.currency);
    }
    const currentLookups = Promise.all([...requiredCurrencies].map(async (currency) => {
      try { currentRates.set(currency, (await getRate(currency, today)).rate); }
      catch (error) { rateErrors[currency] = publicError(error).error; }
    }));
    const historicalLookups = refreshRates ? Promise.allSettled([...requiredCurrencies].map((currency) => getRate(currency, firstDay))) : Promise.resolve();
    const currencies = await Promise.all([...totals].map(async ([currency, amount]) => {
      try {
        const [first, current] = await Promise.all([getRate(currency, firstDay), getRate(currency, today)]);
        return { currency, amount, firstRate: first.rate, currentRate: current.rate, firstEffectiveDate: first.effectiveDate, currentEffectiveDate: current.effectiveDate, firstValue: amount * first.rate, currentValue: amount * current.rate, difference: amount * (current.rate - first.rate) };
      } catch (error) { return { currency, amount, error: publicError(error).error }; }
    }));
    await currentLookups;
    await historicalLookups;
    if (refreshRates) {
      try { await exportMobileBalancesOnce(SYNC_DIR); }
      catch (error) { if (process.env.NODE_ENV !== 'test') diagnose(error); }
    }
    const total = currencies.some((item) => item.error) ? null : currencies.reduce((sum, item) => ({ firstValue: sum.firstValue + item.firstValue, currentValue: sum.currentValue + item.currentValue, difference: sum.difference + item.difference }), { firstValue: 0, currentValue: 0, difference: 0 });
    const usdRate = currentRates.get('USD');
    const currentRubTotal = [...totals].every(([currency]) => currentRates.has(currency))
      ? [...totals].reduce((sum, [currency, amount]) => sum + amount * currentRates.get(currency), 0)
      : null;
    const usdTotal = currentRubTotal !== null && usdRate > 0 ? currentRubTotal / usdRate : null;
    res.json({ today, firstDay, currencies, total, rateErrors, currentRates: Object.fromEntries(currentRates), currentRubTotal, usdRate: usdRate || null, usdTotal });
  } catch (error) { next(error); }
});

app.get('/api/data', async (_req, res, next) => {
  try {
    const workbook = await loadWorkbook();
    const currencies = new Set(['USD', ...readAccounts(workbook).filter((item) => item.active).map((item) => item.currency), ...readSavings(workbook).map((item) => item.currency)]);
    await Promise.allSettled([...currencies].map((currency) => fetchCbrRate(currency, localIsoDate())));
    const data = await withWorkbookQueue(async () => {
      const latest = await loadWorkbook();
      try { await publishMobileBalances(SYNC_DIR, latest); }
      catch (error) { if (process.env.NODE_ENV !== 'test') diagnose(error); }
      return serialize(latest);
    });
    res.json(data);
  } catch (error) { next(error); }
});

app.get('/api/snapshot', async (_req, res, next) => {
  try { res.json({ revision: digest(await readFile(WORKBOOK_PATH)), asOfDate: localIsoDate() }); } catch (error) { next(error); }
});

app.get('/api/sync/status', (_req, res) => res.json(syncStatus));

app.get('/api/rates', async (req, res, next) => {
  try {
    const currency = clean(req.query.currency).toUpperCase();
    const date = clean(req.query.date);
    if (!calendarDate(date)) throw new InputError('Некорректная дата курса.');
    const refresh = clean(req.query.refresh).toLowerCase() === 'true';
    const rate = await fetchCbrRate(currency, date, { refresh });
    if (refresh && date === localIsoDate()) {
      try { await exportMobileBalancesOnce(); }
      catch (error) { if (process.env.NODE_ENV !== 'test') diagnose(error); }
    }
    res.json(rate);
  } catch (error) { next(error); }
});

app.post('/api/operations', async (req, res, next) => {
  try {
    const payload = await createOperation(req.body);
    res.status(payload.result.duplicate ? 200 : 201).json(payload);
  } catch (error) { next(error); }
});

export async function repairOpeningBalanceRatesOnce() {
  return mutateWorkbook(async (workbook) => {
    const accounts = readAccounts(workbook);
    const missing = readOpeningBalances(workbook).filter((item) => !(item.rate > 0));
    const updates = [];
    const unavailable = [];
    for (const item of missing) {
      const account = accounts.find((entry) => entry.id === item.accountId);
      if (!account || !calendarDate(item.date)) { unavailable.push(item.accountId); continue; }
      const key = `${account.currency}:${item.date}`;
      if (mutationContext.getStore().unavailableOptionalRates.has(key)) { unavailable.push(item.accountId); continue; }
      let rate;
      try { rate = (await fetchCbrRate(account.currency, item.date)).rate; }
      catch (error) { if (error instanceof PrepareRate) throw new PrepareReferenceRate(account.currency, item.date); throw error; }
      updates.push({ ...item, rate });
    }
    const result = { repaired: updates.length, unavailable };
    if (!updates.length) return { skipSave: true, result };
    const sheet = openingBalanceSheet(workbook);
    sheet.getCell(1, 4).value = 'Курс ЦБ на дату';
    for (const item of updates) sheet.getCell(item.id, 4).value = item.rate;
    return result;
  });
}

app.post('/api/operations/opening-balance/repair-rates', async (req, res, next) => {
  try { res.json(await repairOpeningBalanceRatesOnce()); } catch (error) { next(error); }
});

app.put('/api/operations/opening-balance', async (req, res, next) => {
  try {
    const accountId = rowId(req.body?.accountId);
    const amount = numberField(req.body?.amount);
    const date = req.body?.date ?? localIsoDate();
    if (!calendarDate(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))) throw new InputError('Укажите корректную дату начального баланса.');
    if (!Number.isInteger(accountId) || !Number.isFinite(amount) || amount < 0) throw new InputError('Выберите счёт и укажите неотрицательную сумму.');
    const payload = await mutateWorkbook(async (workbook) => {
      const account = readAccounts(workbook).find((item) => item.id === accountId && item.active);
      if (!account) throw new InputError('Начальный баланс можно задать только для активного обычного счёта.');
      const { rate } = await fetchCbrRate(account.currency, date);
      if (!Number.isFinite(rate) || rate <= 0 || amount * rate > 1e12) throw new InputError('Проверьте курс и рублёвый эквивалент начального баланса.');
      const sheet = openingBalanceSheet(workbook);
      sheet.getCell(1, 4).value = 'Курс ЦБ на дату';
      const rows = [];
      for (let index = 2; index <= sheet.rowCount; index += 1) if (asNumber(sheet.getCell(index, 1).value) === accountId) rows.push(index);
      const hadExisting = rows.length > 0;
      const row = rows.pop() || Math.max(2, sheet.rowCount + 1);
      rows.forEach((duplicate) => { for (let column = 1; column <= 4; column += 1) sheet.getCell(duplicate, column).value = null; });
      sheet.getCell(row, 1).value = accountId;
      sheet.getCell(row, 2).value = amount;
      sheet.getCell(row, 3).value = excelDate(date);
      sheet.getCell(row, 4).value = rate;
      return { accountId, amount, date, rate, replaced: hadExisting };
    });
    res.json(payload);
  } catch (error) { next(error); }
});

app.post('/api/savings/accounts', async (req, res, next) => {
  try {
    const name = textField(req.body?.name, 100, 'Название'), type = textField(req.body?.type, 20, 'Тип'), currency = textField(req.body?.currency, 3, 'Валюта').toUpperCase();
    const initialCapital = numberField(req.body?.initialCapital);
    if (!name || name.length > 100) throw new InputError('Укажите название счёта (до 100 символов).');
    if (!['Отложенные', 'Вклад'].includes(type)) throw new InputError('Выберите тип накопительного счёта.');
    if (!Number.isFinite(initialCapital) || initialCapital < 0) throw new InputError('Начальный капитал должен быть неотрицательным числом.');
    const payload = await mutateWorkbook((workbook) => {
      const allowed = readLists(workbook, false).currencies;
      if (!allowed.includes(currency)) throw new InputError('Валюта отсутствует в справочниках. Добавьте её на экране «Справочники».');
      const { accounts } = savingsSheets(workbook);
      const state = identityState(workbook);
      assertIdentityAvailable(state);
      const row = Math.max(1, ...state.savings, accounts.rowCount) + 1;
      if (row > 1048576) throw new InputError('Достигнут предел ID накоплений в Excel.');
      [name, type, currency, initialCapital, excelDate(localIsoDate())].forEach((value, index) => { accounts.getCell(row, index + 1).value = value; });
      return { id: row };
    });
    res.status(201).json(payload);
  } catch (error) { next(error); }
});

app.delete('/api/savings/accounts/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const payload = await mutateWorkbook((workbook) => {
      const { accounts } = savingsSheets(workbook);
      if (!Number.isInteger(id) || id < 2 || id > accounts.rowCount || !clean(accounts.getCell(id, 1).value)) throw new InputError('Накопительный счёт не найден.');
      const linked = readSavings(workbook).some((account) => account.id === id && account.movements.length);
      if (linked) throw new InputError('Нельзя удалить счёт с историей движения капитала.');
      for (let column = 1; column <= 5; column += 1) accounts.getCell(id, column).value = null;
      return { deleted: true, id };
    });
    res.json(payload);
  } catch (error) { next(error); }
});

app.post('/api/savings/accounts/:id/increase', async (req, res, next) => {
  try {
    const id = rowId(req.params.id, { min: 2, max: 1048576 }), amount = numberField(req.body?.amount, { min: -1e8 }), date = req.body?.date ?? localIsoDate(), notes = textField(req.body?.notes, 500, 'Заметка', { optional: true });
    if (!Number.isInteger(id) || !Number.isFinite(amount) || amount === 0 || !calendarDate(date)) throw new InputError('Укажите счёт, ненулевое изменение капитала и корректную дату.');
    const payload = await mutateWorkbook((workbook) => {
      const { accounts, movements } = savingsSheets(workbook);
      if (id < 2 || id > accounts.rowCount || !clean(accounts.getCell(id, 1).value)) throw new InputError('Накопительный счёт не найден.');
      const row = Math.max(2, movements.rowCount + 1);
      [id, excelDate(date), amount, 'Изменение капитала', null, notes].forEach((value, index) => { movements.getCell(row, index + 1).value = value; });
      return { id: row, accountId: id };
    });
    res.status(201).json(payload);
  } catch (error) { next(error); }
});

app.post('/api/savings/transfers', async (req, res, next) => {
  try {
    const direction = textField(req.body?.direction, 20, 'Направление'), savingId = rowId(req.body?.savingAccountId, { min: 2, max: 1048576 }), mainId = rowId(req.body?.mainAccountId);
    const savingAmount = numberField(req.body?.savingAmount, { positive: true }), mainAmount = numberField(req.body?.mainAmount, { positive: true }), date = req.body?.date ?? localIsoDate();
    if (direction !== 'from-savings' || !Number.isFinite(savingAmount) || savingAmount <= 0 || !Number.isFinite(mainAmount) || mainAmount <= 0 || !calendarDate(date)) throw new InputError('Из накоплений можно переводить только на обычный счёт. Проверьте дату и суммы.');
    const payload = await mutateWorkbook(async (workbook) => {
      const savings = readSavings(workbook).find((item) => item.id === savingId);
      const main = readAccounts(workbook).find((item) => item.id === mainId && item.active);
      if (!savings || !main) throw new InputError('Выберите действующие счета для перевода.');
      if (savings.currency === main.currency && savingAmount !== mainAmount) throw new InputError('Суммы перевода в одной валюте должны совпадать.');
      const operations = workbook.getWorksheet('Операции');
      let row = 0;
      for (let candidate = 5; candidate <= operations.rowCount; candidate += 1) if (![1,2,3,4,5,6,7,9,10,11,12,13,14,15,16,17,18,19].some((column) => clean(operations.getCell(candidate, column).value))) { row = candidate; break; }
      if (!row) { ensureOperationCapacity(workbook); row = operations.rowCount - 99; }
      const operation = { date, type: 'Перевод', amount: savingAmount, currency: savings.currency, rate: 1, accountId: null, destinationAccountId: mainId, destinationAmount: mainAmount, savingsTransfer: direction, savingsAccountId: savingId, savingsAmount: savingAmount };
      operation.rate = (await fetchCbrRate(operation.currency, operation.date)).rate;
      if (savings.currency !== main.currency) await Promise.all([savings.currency, main.currency].map((currency) => prepareReferenceRate(currency, date)));
      if (operation.amount * operation.rate > 1e12) throw new InputError('Рублёвый эквивалент превышает 1e12.');
      operation.recordedAt = new Date().toISOString();
      writeOperation(operations, row, operation);
      const { movements } = savingsSheets(workbook);
      const movementRow = Math.max(2, movements.rowCount + 1);
      [savingId, excelDate(date), -savingAmount, 'Перевод', row, 'Перевод в основной учёт'].forEach((value, index) => { movements.getCell(movementRow, index + 1).value = value; });
      ensureOperationCapacity(workbook);
      return { id: row, savingsMovementId: movementRow };
    });
    res.status(201).json(payload);
  } catch (error) { next(error); }
});

app.put('/api/operations/:id', async (req, res, next) => {
  try {
    const row = Number(req.params.id);
    if (!Number.isInteger(row) || row < 5) throw new InputError('Некорректный номер операции.');
    const payload = await mutateWorkbook(async (workbook) => {
      const sheet = workbook.getWorksheet('Операции');
      if (row > sheet.rowCount) throw new InputError('Некорректный номер операции.');
      const linkedKind = clean(sheet.getCell(row, 16).value);
      const previous = readOperations(workbook).find((item) => item.id === row && item.date && item.type);
      if (!previous) throw new InputError('Операция не найдена. Обновите данные.', 404, 'NOT_FOUND');
      object(req.body);
      const linked = linkedKind ? linkedSavingsMovement(workbook, row) : null;
      if (req.body.type !== undefined && req.body.type !== previous.type) {
        throw new InputError(`Тип операции «${previous.type}» нельзя изменить. Удалите запись и создайте новую с нужным типом.`, 400, 'OPERATION_TYPE_IMMUTABLE');
      }
      const financial = ['date', 'type', 'category', 'amount', 'currency', 'rate', 'necessity', 'accountId', 'destinationAccountId', 'destinationAmount'];
      const notesOnly = Object.hasOwn(req.body, 'notes') && financial.every((key) => req.body[key] === undefined || String(req.body[key] ?? '') === String(previous[key] ?? ''));
      if (notesOnly) {
        const notes = textField(req.body.notes, 500, 'Заметка');
        sheet.getCell(row, 11).value = notes;
        if (linkedKind === 'investment') workbook.getWorksheet('Движение накоплений').getCell(linked.movementRow, 6).value = notes;
        return { id: row };
      }
      if (linkedKind === 'from-savings') {
        const date = textField(req.body.date, 10, 'date');
        const savingId = rowId(req.body.savingsAccountId, { min: 2, max: 1048576 });
        const mainId = rowId(req.body.accountId);
        const savingAmount = numberField(req.body.amount, { positive: true });
        const mainAmount = numberField(req.body.destinationAmount, { positive: true });
        const notes = textField(req.body.notes, 500, 'Заметка', { optional: true });
        if (!calendarDate(date)) throw new InputError('Укажите корректную дату.');
        if (req.body.type !== 'Перевод') throw new InputError('Тип операции должен оставаться «Перевод».', 400, 'OPERATION_TYPE_IMMUTABLE');
        const savings = readSavings(workbook).find((item) => item.id === savingId);
        const main = readAccounts(workbook).find((item) => item.id === mainId && item.active);
        if (!savings || !main) throw new InputError('Выберите действующие счета для перевода.');
        if (req.body.currency !== undefined && textField(req.body.currency, 3, 'currency') !== savings.currency) throw new InputError('Валюта операции должна совпадать с валютой накопительного счёта.');
        if (!readLists(workbook, false).currencies.includes(savings.currency)) throw new InputError('Валюта накопительного счёта отсутствует в справочнике.');
        if (savings.currency === main.currency && savingAmount !== mainAmount) throw new InputError('Суммы перевода в одной валюте должны совпадать.');
        const operation = {
          date, type: 'Перевод', category: '', amount: savingAmount, currency: savings.currency, rate: 1, necessity: '', notes,
          sourceId: previous.sourceId, accountId: null, destinationAccountId: mainId, destinationAmount: mainAmount,
          savingsTransfer: 'from-savings', savingsAccountId: savingId, savingsAmount: savingAmount, recordedAt: previous.recordedAt,
        };
        operation.rate = previous.date === date && previous.currency === savings.currency && previous.rate > 0 && previous.rate !== 1
          ? previous.rate : (await fetchCbrRate(operation.currency, operation.date)).rate;
        if (savings.currency !== main.currency) await Promise.all([savings.currency, main.currency].map((currency) => prepareReferenceRate(currency, date)));
        if (operation.amount * operation.rate > 1e12) throw new InputError('Рублёвый эквивалент превышает 1e12.');
        writeOperation(sheet, row, operation);
        const movements = workbook.getWorksheet('Движение накоплений');
        [savingId, excelDate(date), -savingAmount, 'Перевод', row].forEach((value, index) => { movements.getCell(linked.movementRow, index + 1).value = value; });
        return { id: row };
      }
      const legacyAccount = !asNumber(sheet.getCell(row, 13).value);
      const operation = validateOperation(req.body, { requireAccount: !legacyAccount });
      validateOperationAccounts(workbook, operation, { requireAccount: !legacyAccount });
      if (linkedKind === 'investment' && operation.type !== 'Инвестиция') throw new InputError('Тип операции должен оставаться «Инвестиция».', 400, 'OPERATION_TYPE_IMMUTABLE');
      if (operation.type === 'Перевод') {
        const previous = readOperations(workbook).find((item) => item.id === row);
        operation.rate = previous?.type === 'Перевод' && previous.date === operation.date && previous.currency === operation.currency && previous.rate > 0 && previous.rate !== 1
          ? previous.rate : (await fetchCbrRate(operation.currency, operation.date)).rate;
      }
      await prepareOperationReferenceRates(workbook, operation);
      if (operation.amount * operation.rate > 1e12) throw new InputError('Рублёвый эквивалент превышает 1e12.');
      operation.sourceId ||= clean(sheet.getCell(row, 12).value);
      operation.recordedAt = previous.recordedAt;
      writeOperation(sheet, row, operation);
      if (linkedKind === 'investment') {
        const movements = workbook.getWorksheet('Движение накоплений');
        [operation.savingsAccountId, excelDate(operation.date), operation.savingsAmount, 'Инвестиция', row, operation.notes].forEach((value, index) => { movements.getCell(linked.movementRow, index + 1).value = value; });
      }
      return { id: row };
    });
    res.json(payload);
  } catch (error) { next(error); }
});

app.delete('/api/operations/:id', async (req, res, next) => {
  try {
    const row = Number(req.params.id);
    if (!Number.isInteger(row) || row < 5) throw new InputError('Некорректный номер операции.');
    const payload = await mutateWorkbook(async (workbook) => {
      const sheet = workbook.getWorksheet('Операции');
      if (row > sheet.rowCount) throw new InputError('Некорректный номер операции.');
      const linkedKind = clean(sheet.getCell(row, 16).value);
      if (linkedKind && !['investment', 'from-savings'].includes(linkedKind)) throw new InputError('Межсистемный перевод хранится в истории обоих учётов и не может быть удалён отсюда.');
      if (linkedKind === 'investment' || linkedKind === 'from-savings') {
        const accountId = asNumber(sheet.getCell(row, 17).value);
        const amount = asNumber(sheet.getCell(row, 18).value);
        const date = dateToIso(sheet.getCell(row, 1).value);
        const expectedType = linkedKind === 'investment' ? 'Инвестиция' : 'Перевод';
        const expectedMovementType = linkedKind === 'investment' ? 'Инвестиция' : 'Перевод';
        const destinationAccountId = asNumber(sheet.getCell(row, 14).value);
        const destinationAmount = asNumber(sheet.getCell(row, 15).value);
        if (clean(sheet.getCell(row, 2).value) !== expectedType || !accountId || !(amount > 0)
          || (linkedKind === 'from-savings' && (!destinationAccountId || !(destinationAmount > 0) || asNumber(sheet.getCell(row, 13).value)))) {
          throw new InputError('Связь перевода с движением накоплений повреждена; запись не удалена.', 409, 'LINKED_MOVEMENT_MISMATCH');
        }
        const { movements } = savingsSheets(workbook);
        const linkedRows = [];
        for (let movementRow = 2; movementRow <= movements.rowCount; movementRow += 1) {
          if (asNumber(movements.getCell(movementRow, 5).value) === row) linkedRows.push(movementRow);
        }
        if (linkedRows.length !== 1) throw new InputError('Не удалось однозначно найти связанное движение накоплений; запись не удалена.', 409, 'LINKED_MOVEMENT_MISMATCH');
        const movementRow = linkedRows[0];
        if (asNumber(movements.getCell(movementRow, 1).value) !== accountId
          || dateToIso(movements.getCell(movementRow, 2).value) !== date
          || asNumber(movements.getCell(movementRow, 3).value) !== (linkedKind === 'investment' ? amount : -amount)
          || clean(movements.getCell(movementRow, 4).value) !== expectedMovementType) {
          throw new InputError('Связь перевода с движением накоплений повреждена; запись не удалена.', 409, 'LINKED_MOVEMENT_MISMATCH');
        }
        for (let column = 1; column <= 6; column += 1) movements.getCell(movementRow, column).value = null;
      }
      for (const column of [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]) sheet.getCell(row, column).value = null;
      sheet.getCell(row, 8).value = { formula: `IF(OR(E${row}="",F${row}=""),"",IF(F${row}="RUB",E${row},IF(G${row}="", "",E${row}*G${row})))`, result: '' };
      return { id: row };
    });
    res.json(payload);
  } catch (error) { next(error); }
});

app.post('/api/accounts/migrate', async (req, res, next) => {
  try {
    const payload = await mutateWorkbook(async (workbook) => {
      const result = migrateAccountModel(workbook);
      return result.changed ? result : { skipSave: true, result };
    });
    try {
      const mobileLists = await exportMobileListsOnce();
      res.json({ ...payload, mobileLists: { changed: mobileLists.changed } });
    } catch (syncError) {
      res.json({ ...payload, mobileLists: { changed: false, warning: publicError(syncError).error } });
    }
  } catch (error) { next(error); }
});

app.post('/api/system/migrate-streamlined', async (_req, res, next) => {
  try {
    const payload = await mutateWorkbook(async (workbook) => {
      const result = migrateStreamlinedModel(workbook);
      return result.changed ? result : { skipSave: true, result };
    });
    res.json(payload);
  } catch (error) { next(error); }
});

app.post('/api/system/migrate-category-emojis', async (_req, res, next) => {
  try {
    const payload = await mutateWorkbook(async (workbook) => {
      const result = migrateCategoryEmojis(workbook);
      return result.changed ? result : { skipSave: true, result };
    });
    const mobileLists = await exportMobileListsOnce();
    res.json({ ...payload, mobileLists: { changed: mobileLists.changed } });
  } catch (error) { next(error); }
});

app.post('/api/system/migrate-investment-categories', async (_req, res, next) => {
  try {
    const payload = await mutateWorkbook(async (workbook) => {
      const result = ensureSystemInvestmentCategories(workbook);
      return result.changed ? result : { skipSave: true, result };
    });
    res.json(payload);
  } catch (error) { next(error); }
});

app.put('/api/lists', async (req, res, next) => {
  try {
    const lists = validateReferenceLists(req.body);
    const payload = await mutateWorkbook(async (workbook) => {
      const existingCurrencies = new Set(readLists(workbook, false).currencies.map((currency) => clean(currency).toUpperCase()));
      const addedCurrencies = lists.currencies.filter((currency) => currency !== 'RUB' && !existingCurrencies.has(currency));
      const missingAccountCurrency = [...readAccounts(workbook).filter((account) => account.active), ...readSavings(workbook)].find((account) => !lists.currencies.includes(account.currency));
      if (missingAccountCurrency) throw new InputError(`Валюта ${missingAccountCurrency.currency} используется счётом «${missingAccountCurrency.name}» и не может быть удалена.`);
      const today = new Date().toISOString().slice(0, 10);
      for (const currency of addedCurrencies) await fetchCbrRate(currency, today);
      writeReferenceLists(workbook, lists);
      return { updated: true };
    });
    try {
      const mobileLists = await exportMobileListsOnce();
      res.json({ ...payload, mobileLists: { changed: mobileLists.changed } });
    } catch (syncError) {
      res.json({ ...payload, mobileLists: { changed: false, warning: publicError(syncError).error } });
    }
  } catch (error) { next(error); }
});

app.put('/api/accounts', async (req, res, next) => {
  try {
    if (!Array.isArray(req.body?.accounts) || req.body.accounts.length > 100) throw new InputError('Не переданы счета.');
    const createdAt = localIsoDate();
    const payload = await mutateWorkbook(async (workbook) => {
      if (!hasAccountModel(workbook)) throw new InputError('Сначала выполните миграцию счетов.');
      const sheet = workbook.getWorksheet('Баланс');
      const currentAccounts = new Map(readAccounts(workbook).map((account) => [account.id, account]));
      const operations = readOperations(workbook);
      const openingIds = new Set(readOpeningBalances(workbook).map((item) => item.accountId));
      const allowedCurrencies = new Set(readLists(workbook, false).currencies);
      const reservedRows = new Set();
      const created = [];
      const linkedTo = (row) => operations.filter((operation) => operation.accountId === row || operation.destinationAccountId === row);
      for (const current of currentAccounts.values()) {
        if (!current.active && current.stored && !linkedTo(current.id).length && !openingIds.has(current.id)) {
          for (let column = 1; column <= 12; column += 1) sheet.getCell(current.id, column).value = null;
        }
      }
      for (const account of req.body.accounts) {
        object(account);
        const isNew = account.id === null || account.id === undefined || account.id === '';
        let row = isNew ? NaN : Number(account.id);
        if (isNew) {
          const state = identityState(workbook);
          assertIdentityAvailable(state);
          row = Array.from({ length: ACCOUNT_MAX_ROW - ACCOUNT_START_ROW + 1 }, (_value, index) => index + ACCOUNT_START_ROW)
            .find((candidate) => !state.accounts.has(candidate) && !currentAccounts.get(candidate)?.active && !linkedTo(candidate).length && !openingIds.has(candidate) && !reservedRows.has(candidate));
          if (!row) throw new InputError('Исчерпаны 100 ID счетов Excel. Удалённые ID не переиспользуются.');
          created.push(row);
        }
        if (!Number.isInteger(row) || row < ACCOUNT_START_ROW || row > ACCOUNT_MAX_ROW) throw new InputError('Некорректный счёт.');
        if (!isNew && !currentAccounts.get(row)?.active) throw new InputError('Счёт не найден. Обновите страницу.');
        if (reservedRows.has(row)) throw new InputError('Один счёт передан несколько раз.');
        reservedRows.add(row);
        const name = textField(account.name, 100, 'Название');
        const currency = textField(account.currency, 3, 'Валюта');
        const rate = currency === 'RUB' ? 1 : rateField(account.rate);
        const current = currentAccounts.get(row);
        const linkedOperations = linkedTo(row);
        if (!(name && currency)) throw new InputError('У каждого счёта должны быть название и валюта.');
        if (!allowedCurrencies.has(currency)) throw new InputError(`Валюта ${currency} отсутствует в справочнике.`);
        if ((linkedOperations.length || openingIds.has(row)) && current?.currency && currency !== current.currency) throw new InputError(`Нельзя менять валюту счёта «${current.name}» с операциями или начальным балансом. Создайте новый счёт.`);
        if (!(rate > 0)) throw new InputError(`Укажите курс для счёта «${name}».`);
        const openingRate = isNew ? (await fetchCbrRate(currency, createdAt)).rate : null;
        if (isNew && (!(openingRate > 0) || !Number.isFinite(openingRate))) throw new InputError('Не удалось сохранить начальный баланс 0: курс ЦБ на дату создания счёта недоступен.');
        sheet.getCell(row, 1).value = name;
        sheet.getCell(row, 2).value = currency;
        if (isNew) {
          sheet.getCell(row, 13).value = Math.max(0, ...[...currentAccounts.values()].filter((item) => item.active).map((item) => item.order)) + created.length;
          sheet.hideColumn(13);
        }
        sheet.getCell(row, 4).value = currency === 'RUB' ? null : rate;
        if (isNew) {
          const openingSheet = openingBalanceSheet(workbook);
          let openingRow = 2;
          while ([1, 2, 3, 4].some((column) => clean(openingSheet.getCell(openingRow, column).value))) openingRow += 1;
          [row, 0, excelDate(createdAt), openingRate].forEach((value, index) => { openingSheet.getCell(openingRow, index + 1).value = value; });
        }
      }
      return { updated: true, created };
    });
    try {
      const mobileLists = await exportMobileListsOnce();
      res.json({ ...payload, mobileLists: { changed: mobileLists.changed } });
    } catch (syncError) {
      res.json({ ...payload, mobileLists: { changed: false, warning: publicError(syncError).error } });
    }
  } catch (error) { next(error); }
});

app.delete('/api/accounts/:id', async (req, res, next) => {
  try {
    const row = Number(req.params.id);
    if (!Number.isInteger(row) || row < ACCOUNT_START_ROW || row > ACCOUNT_MAX_ROW) throw new InputError('Некорректный счёт.');
    const payload = await mutateWorkbook(async (workbook) => {
      if (!hasAccountModel(workbook)) throw new InputError('Сначала выполните миграцию счетов.');
      const activeAccounts = readAccounts(workbook).filter((account) => account.active);
      const account = activeAccounts.find((item) => item.id === row);
      if (!account) throw new InputError('Счёт не найден.');
      if (activeAccounts.length <= 1) throw new InputError('Нельзя удалить единственный активный счёт.');
      const linked = readOperations(workbook).some((operation) => operation.accountId === row || operation.destinationAccountId === row);
      const openingBalances = readOpeningBalances(workbook).filter((item) => item.accountId === row);
      if (openingBalances.some((item) => item.amount !== 0)) throw new InputError('Счёт с ненулевым начальным балансом нельзя удалить.');
      if (linked) throw new InputError(`Счёт «${account.name}» используется операциями и не может быть удалён.`);
      const sheet = workbook.getWorksheet('Баланс');
      for (let column = 1; column <= 13; column += 1) sheet.getCell(row, column).value = null;
      const openingSheet = workbook.getWorksheet(OPENING_BALANCE_SHEET);
      if (openingSheet) {
        for (let index = 2; index <= openingSheet.rowCount; index += 1) {
          if (asNumber(openingSheet.getCell(index, 1).value) !== row) continue;
          for (let column = 1; column <= 4; column += 1) openingSheet.getCell(index, column).value = null;
        }
      }
      return { deleted: true, id: row };
    });
    try {
      const mobileLists = await exportMobileListsOnce();
      res.json({ ...payload, mobileLists: { changed: mobileLists.changed } });
    } catch (syncError) {
      res.json({ ...payload, mobileLists: { changed: false, warning: publicError(syncError).error } });
    }
  } catch (error) { next(error); }
});

app.put('/api/balances', (_req, res) => res.status(410).json({ error: 'Экран баланса обновлён. Перезагрузите приложение.' }));

async function inspectPublishedMobileLists() {
  const file = path.join(SYNC_DIR, 'config', 'lists.json');
  let contents;
  let modifiedAt;
  try {
    const [fileContents, info] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
    contents = fileContents;
    modifiedAt = info.mtime.toISOString();
  } catch (error) {
    return { state: error.code === 'ENOENT' ? 'missing' : 'unavailable', accountCount: 0, modifiedAt: null };
  }
  let payload;
  try { payload = JSON.parse(contents); }
  catch { return { state: 'invalid', accountCount: 0, modifiedAt }; }
  const accounts = payload?.schema === 1 && Array.isArray(payload?.lists?.accounts)
    ? payload.lists.accounts
    : null;
  if (!accounts || accounts.some((account) => !Number.isSafeInteger(account?.id) || typeof account?.name !== 'string' || typeof account?.currency !== 'string')) return { state: 'invalid', accountCount: 0, modifiedAt };
  return { state: accounts.length ? 'ready' : 'no-accounts', accountCount: accounts.length, modifiedAt };
}

async function receiveRecoveryArchive(req, directory) {
  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RECOVERY_UPLOAD_BYTES) {
    req.resume();
    throw new InputError('Recovery-архив больше 256 МБ. Выберите архив меньшего размера.', 413, 'RECOVERY_TOO_LARGE');
  }
  const target = path.join(directory, 'uploaded-recovery.zip');
  let bytes = 0;
  let tooLarge = false;
  const limit = new Transform({
    transform(chunk, _encoding, callback) {
      if (tooLarge) { callback(); return; }
      bytes += chunk.length;
      if (bytes > MAX_RECOVERY_UPLOAD_BYTES) { tooLarge = true; callback(); }
      else callback(null, chunk);
    },
  });
  try {
    await pipeline(req, limit, createWriteStream(target, { flags: 'wx' }));
    if (tooLarge) throw new InputError('Recovery-архив больше 256 МБ. Выберите архив меньшего размера.', 413, 'RECOVERY_TOO_LARGE');
    if (bytes === 0) throw new InputError('Выберите ZIP-архив Finance для проверки.', 400, 'RECOVERY_EMPTY');
    return target;
  } catch (error) {
    await unlink(target).catch(() => {});
    throw error;
  }
}

async function checkedRecoveryArchive(archivePath, workspace) {
  let verified;
  try { verified = await verifyRecoveryBundle(archivePath); }
  catch { throw new InputError('Архив повреждён или создан в несовместимом формате.', 400, 'RECOVERY_INVALID'); }
  const candidate = path.join(workspace, 'recovery-validation.xlsx');
  try {
    await writeFile(candidate, verified.workbook, { flag: 'wx' });
    const workbook = await validateWorkbookFile(candidate);
    if (workbook.revision !== verified.manifest.sha256) throw new InputError('Контрольная сумма книги в архиве не совпала.', 400, 'RECOVERY_HASH_MISMATCH');
    return verified;
  } catch (error) {
    if (error instanceof InputError || ['EACCES', 'EPERM', 'EBUSY', 'ENOSPC'].includes(error?.code)) throw error;
    throw new InputError('В архиве нет корректной книги Finance.', 400, 'RECOVERY_WORKBOOK_INVALID');
  } finally { await unlink(candidate).catch(() => {}); }
}

async function withRecoveryWorkspace(req, callback) {
  const workspace = await mkdtemp(path.join(tmpdir(), 'finance-recovery-check-'));
  try {
    const archivePath = await receiveRecoveryArchive(req, workspace);
    return await callback(archivePath, workspace);
  } finally { await rm(workspace, { recursive: true, force: true }).catch((error) => diagnose(error)); }
}

app.get('/api/settings/recovery/export', async (_req, res, next) => {
  let directory;
  try {
    directory = await mkdtemp(path.join(tmpdir(), 'finance-recovery-export-'));
    const archive = await exportRecoveryBundle(WORKBOOK_PATH, directory, validateWorkbookFile);
    res.setHeader('Cache-Control', 'no-store');
    res.download(archive, path.basename(archive), async (error) => {
      await rm(directory, { recursive: true, force: true }).catch((cleanupError) => diagnose(cleanupError));
      if (error && !res.headersSent) next(error);
      else if (error) diagnose(error);
    });
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true }).catch((cleanupError) => diagnose(cleanupError));
    next(error);
  }
});

app.post('/api/settings/recovery/verify', async (req, res, next) => {
  try {
    const verified = await withRecoveryWorkspace(req, async (archivePath, workspace) => checkedRecoveryArchive(archivePath, workspace));
    res.json({ valid: true, manifest: verified.manifest, workbookBytes: verified.workbook.length });
  } catch (error) { next(error); }
});

app.post('/api/settings/recovery/rehearse', async (req, res, next) => {
  try {
    const result = await withRecoveryWorkspace(req, async (archivePath, workspace) => {
      const verified = await checkedRecoveryArchive(archivePath, workspace);
      const rehearsal = await rehearseRecoveryContents(verified, path.join(workspace, 'rehearsal'), validateWorkbookFile);
      return { ...rehearsal, workbookBytes: verified.workbook.length };
    });
    res.json({ valid: true, rehearsed: true, manifest: result.manifest, workbookBytes: result.workbookBytes });
  } catch (error) { next(error); }
});

app.get('/api/settings', async (_req, res, next) => {
  try {
    const workbookStat = await stat(WORKBOOK_PATH);
    const backups = await listBackups();
    const mobileLists = await inspectPublishedMobileLists();
    const rollbackVersion = await inspectRollbackVersion();
    res.json({
      dataDirectory: DATA_DIR,
      workbookPath: WORKBOOK_PATH,
      workbookModifiedAt: workbookStat.mtime.toISOString(),
      syncDirectory: SYNC_DIR,
      backupDirectory: BACKUP_DIR,
      backupLimit: BACKUP_LIMIT,
      backupCount: backups.length,
      latestBackup: backups[0]?.name || null,
      backups,
      receiptRetentionDays: RECEIPT_RETENTION_DAYS,
      sync: syncStatus,
      mobileLists,
      updates: {
        version: RELEASE_INFO.version,
        channel: RELEASE_INFO.channel,
        rollbackVersion,
      },
    });
  } catch (error) { next(error); }
});

async function inspectRollbackVersion() {
  const version = process.env.FINANCE_PREVIOUS_VERSION;
  const root = process.env.FINANCE_INSTALL_ROOT;
  if (process.platform !== 'win32' || !root || !version || version === process.env.FINANCE_CURRENT_VERSION) return null;
  if (version !== 'legacy' && !/^[A-Za-z0-9][A-Za-z0-9.-]{0,79}$/.test(version)) return null;
  const directory = version === 'legacy' ? path.resolve(root) : path.resolve(root, 'versions', version);
  const rootPrefix = `${path.resolve(root)}${path.sep}`;
  if (version !== 'legacy' && !directory.startsWith(rootPrefix)) return null;
  try {
    const directoryInfo = await lstat(directory);
    if (!directoryInfo.isDirectory()) return null;
    const files = await Promise.all(['server.js', 'runtime/node.exe', 'scripts/desktop-launcher.mjs'].map((relative) => lstat(path.join(directory, relative))));
    return files.every((item) => item.isFile()) ? version : null;
  } catch { return null; }
}

function launchDesktopHelper(mode, extra = []) {
  const helperPath = path.join(__dirname, 'scripts', 'desktop-launcher.mjs');
  const child = spawn(process.execPath, [helperPath, mode, ...extra], {
    cwd: __dirname,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.once('error', (error) => {
    diagnose(error);
    updateInstallPending = false;
  });
  child.unref();
}

app.get('/api/updates/check', async (_req, res) => {
  try { res.json(await updateService.check()); }
  catch (error) {
    diagnose(error);
    res.status(503).json({ error: 'Не удалось проверить обновления. Проверьте подключение к интернету и повторите попытку.', code: 'UPDATE_CHECK_FAILED', retryable: true });
  }
});

app.get('/api/updates/progress', (_req, res) => res.json(updateProgress));

app.post('/api/updates/install', async (req, res) => {
  if (process.platform !== 'win32' || !process.env.FINANCE_INSTALL_ROOT || !['beta', 'stable'].includes(RELEASE_INFO.channel)) {
    return res.status(409).json({ error: 'Установка обновлений доступна только в упакованной версии Finance для Windows.', code: 'UPDATE_INSTALL_UNAVAILABLE', retryable: false });
  }
  if (updateInstallPending) return res.status(409).json({ error: 'Установка обновления уже запущена.', code: 'UPDATE_INSTALL_PENDING', retryable: true });
  let version;
  try { version = textField(req.body?.version, 80, 'version', { optional: false }); }
  catch { return res.status(400).json({ error: 'Некорректная версия обновления.', code: 'INVALID_INPUT', retryable: false }); }
  let installerPath = null;
  updateInstallPending = true;
  updateProgress = { stage: 'downloading', received: 0, total: null };
  try {
    const downloaded = await updateService.downloadInstaller(version, { onProgress: (progress) => { updateProgress = progress; } });
    installerPath = path.join(tmpdir(), `Finance-Update-${version}-${randomUUID()}.exe`);
    await writeFile(installerPath, downloaded.bytes, { flag: 'wx', mode: 0o600 });
    updateInstallPending = true;
    updateProgress = { ...updateProgress, stage: 'launching' };
    res.status(202).json({ queued: true, version: downloaded.version });
    res.once('finish', () => {
      launchDesktopHelper('install', [installerPath]);
      const pendingTimeout = setTimeout(() => { updateInstallPending = false; }, 10 * 60 * 1000);
      pendingTimeout.unref();
    });
  } catch (error) {
    updateInstallPending = false;
    updateProgress = { ...updateProgress, stage: 'error' };
    if (installerPath) await unlink(installerPath).catch(() => {});
    diagnose(error);
    res.status(502).json({ error: 'Не удалось загрузить и проверить установщик. Приложение и ваши данные не менялись.', code: 'UPDATE_DOWNLOAD_FAILED', retryable: true });
  }
});

app.post('/api/updates/rollback', async (_req, res) => {
  const rollbackVersion = await inspectRollbackVersion();
  if (!rollbackVersion) return res.status(409).json({ error: 'Предыдущая версия Finance недоступна для отката.', code: 'ROLLBACK_UNAVAILABLE', retryable: false });
  res.status(202).json({ queued: true, version: rollbackVersion });
  res.once('finish', () => launchDesktopHelper('rollback'));
});

app.post('/api/settings/restore-backup', async (req, res, next) => {
  try {
    const backupName = clean(req.body?.backup);
    if (!backupName) throw new InputError('Выберите резервную копию.');
    const task = writeQueue.then(() => restoreBackup(backupName));
    writeQueue = task.catch(() => {});
    const result = await task;
    let mobileLists;
    let mobileBalances;
    try { mobileLists = await exportMobileListsOnce(SYNC_DIR); } catch (error) { mobileLists = { changed: false, warning: publicError(error).error }; }
    try { mobileBalances = await exportMobileBalancesOnce(SYNC_DIR); } catch (error) { mobileBalances = { changed: false, warning: publicError(error).error }; }
    res.json({ result, mobileLists, mobileBalances: { changed: Boolean(mobileBalances.changed), warning: mobileBalances.warning } });
  } catch (error) { next(error); }
});

app.post('/api/settings/open-folder', async (req, res, next) => {
  try {
    const targets = { data: DATA_DIR, workbook: path.dirname(WORKBOOK_PATH), backups: BACKUP_DIR, sync: SYNC_DIR };
    const target = targets[clean(req.body?.target)];
    if (!target) throw new InputError('Неизвестная системная папка.');
    await mkdir(target, { recursive: true });
    if (process.env.NODE_ENV !== 'test') {
      if (process.platform !== 'win32') throw new InputError('Открытие Проводника доступно только в Windows.');
      await new Promise((resolve, reject) => {
        const child = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe'), [path.normalize(target)], { detached: true, stdio: 'ignore', windowsHide: false });
        child.once('error', reject);
        child.once('spawn', () => { child.unref(); resolve(); });
      });
    }
    res.json({ opened: true, path: target });
  } catch (error) { next(error); }
});

app.post('/api/settings/export-mobile', async (_req, res, next) => {
  try {
    res.json(await synchronizeMobile());
  } catch (error) { next(error); }
});

app.post('/api/settings/publish-mobile', async (_req, res, next) => {
  try {
    const { lists, balances } = await publishMobileSnapshotOnce(SYNC_DIR);
    const warnings = [];
    if (balances?.payload?.missingRates?.length) warnings.push(`Нет курсов: ${balances.payload.missingRates.join(', ')}`);
    const listsPublished = Boolean(lists);
    const balancesPublished = Boolean(balances);
    res.json({
      listsPublished,
      listsChanged: Boolean(lists?.changed),
      balancesPublished,
      balancesChanged: Boolean(balances?.changed),
      warnings,
      ok: listsPublished && balancesPublished && warnings.length === 0,
    });
  } catch (error) { next(error); }
});

app.get('/api/diagnostics', (_req, res) => res.json(recentDiagnostics()));
app.use((error, _req, res, _next) => {
  const { status, ...payload } = diagnose(error);
  res.status(status).json(payload);
});

export function startServer(port = PORT) {
  const server = app.listen(port, '127.0.0.1', () => {
    console.log(`Финансы: http://127.0.0.1:${server.address().port}`);
    console.log(`Excel: ${WORKBOOK_PATH}`);
  });
  return server;
}

export function shutdownApplication(server) {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  for (const stop of [...importerStops]) stop();
  shutdownPromise = (async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await syncQueue;
    if (inboxScanPromise) await inboxScanPromise;
    await writeQueue;
    await cbrCacheWriteQueue;
  })();
  return shutdownPromise;
}

export async function startApplication(port = PORT, { presenceOptions = {} } = {}) {
  const applicationDirectories = new Set([
    DATA_DIR,
    path.dirname(CONFIG_PATH),
    path.dirname(WORKBOOK_PATH),
    BACKUP_DIR,
    path.dirname(CBR_CACHE_PATH),
    SYNC_DIR,
    path.join(SYNC_DIR, 'incoming'),
    path.join(SYNC_DIR, 'receipts'),
    path.join(SYNC_DIR, 'config'),
  ]);
  await Promise.all([...applicationDirectories].map((directory) => mkdir(directory, { recursive: true })));
  const workbookExists = await lstat(WORKBOOK_PATH).then(() => true, (error) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  if (!workbookExists) {
    return startFirstRunApplication({
      port,
      workbookPath: WORKBOOK_PATH,
      templatePath: path.join(__dirname, 'templates', 'finance-template.xlsx'),
      publicDirectory: path.join(__dirname, 'public'),
      dataDirectory: DATA_DIR,
      syncDirectory: SYNC_DIR,
      workbookStore,
      presenceOptions,
      onInstalled: (boundPort) => startApplication(boundPort ?? port, { presenceOptions }),
    });
  }
  const release = await acquireWorkbookLock(WORKBOOK_PATH, { purpose: 'server', timeout: 0 });
  let server;
  let descriptor;
  const browserLifecycle = process.env.FINANCE_BROWSER_LIFECYCLE === '1';
  try {
    await workbookStore.exclusive(() => validateWorkbookFile(WORKBOOK_PATH));
    if (browserLifecycle) clientPresence = createClientPresence({ ...presenceOptions, onEmpty: () => runtimeControl?.stop() });
    server = startServer(port);
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    descriptor = await publishRuntime(WORKBOOK_PATH, server.address().port);
  } catch (error) {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    clientPresence?.dispose();
    clientPresence = null;
    await release();
    throw error;
  }
  let stopPromise;
  const stop = () => stopPromise ||= (async () => {
    clientPresence?.dispose();
    clientPresence = null;
    await shutdownApplication(server);
    try { await removeRuntime(WORKBOOK_PATH, descriptor); }
    finally {
      await release();
      process.removeListener('SIGINT', signalStop);
      process.removeListener('SIGTERM', signalStop);
      runtimeControl = null;
    }
  })();
  const signalStop = () => { stop().catch((error) => { diagnose(error); process.exitCode = 1; }); };
  runtimeControl = { descriptor, stop };
  process.on('SIGINT', signalStop);
  process.on('SIGTERM', signalStop);
  startInboxImporter();
  console.log(`Syncthing inbox: ${SYNC_DIR}`);
  return { server, stop };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await startApplication().catch((error) => { console.error(diagnose(error)); process.exitCode = 1; });
}
