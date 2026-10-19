// Stored in the same XLSX transaction as the financial changes.
const SHEET = '_FinanceState';
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const invalid = () => Object.assign(new Error('Повреждён реестр синхронизации. Требуется восстановление; импорт остановлен.'), { status: 409 });
export function readIdentity(workbook) {
  const state = { events: new Set(), discarded: new Set(), accounts: new Set(), savings: new Set(), cutoff: null, blocked: false };
  const sheet = workbook.getWorksheet(SHEET);
  if (!sheet) return state;
  if (sheet.getCell(1, 1).value !== 'finance-state-v1') throw invalid();
  const cutoff = sheet.getCell(2, 2).value;
  const blocked = sheet.getCell(3, 2).value;
  if (sheet.getCell(2, 1).value !== 'cutoff' || sheet.getCell(3, 1).value !== 'blocked'
    || (cutoff && !Number.isFinite(Date.parse(cutoff))) || ![0, 1].includes(blocked)) throw invalid();
  state.cutoff = cutoff || null;
  state.blocked = blocked === 1;
  for (let row = 4; row <= sheet.rowCount; row++) {
    const kind = sheet.getCell(row, 1).value;
    const value = sheet.getCell(row, 2).value;
    if (!['events', 'discarded', 'accounts', 'savings'].includes(kind)) throw invalid();
    if (['events', 'discarded'].includes(kind) ? typeof value !== 'string' || !value : !Number.isInteger(value) || value < (kind === 'accounts' ? 5 : 2) || value > (kind === 'accounts' ? 104 : 1048576)) throw invalid();
    state[kind].add(value);
  }
  return state;
}

export function mergeIdentity(left, right) {
  for (const key of ['events', 'discarded', 'accounts', 'savings']) for (const value of right[key]) left[key].add(value);
  left.cutoff = [left.cutoff, right.cutoff].filter(Boolean).sort().at(-1) || null;
  left.blocked ||= right.blocked;
  return left;
}

export function saveIdentity(workbook, state) {
  const existing = readIdentity(workbook);
  const sheet = workbook.getWorksheet(SHEET) || workbook.addWorksheet(SHEET);
  sheet.getCell(1, 1).value = 'finance-state-v1';
  sheet.getCell(2, 1).value = 'cutoff'; sheet.getCell(2, 2).value = state.cutoff;
  sheet.getCell(3, 1).value = 'blocked'; sheet.getCell(3, 2).value = state.blocked ? 1 : 0;
  for (const node of Array.from(workbook.workbookDoc.getElementsByTagNameNS(NS, 'sheet'))) {
    if (node.getAttribute('name') === SHEET) node.setAttribute('state', 'veryHidden');
  }
  for (const kind of ['events', 'discarded', 'accounts', 'savings']) for (const value of state[kind]) {
    if (existing[kind].has(value)) continue;
    const row = sheet.rowCount + 1;
    if (row > 1048576) throw new Error('Достигнут предел реестра Excel. Запись отменена.');
    sheet.getCell(row, 1).value = kind;
    sheet.getCell(row, 2).value = value;
  }
}

export function assertIdentityAvailable(state) {
  if (state.blocked) throw Object.assign(new Error('После восстановления реестр неполон. Импорт и выдача новых ID остановлены; сохраните очередь и восстановите достоверный реестр.'), { status: 409 });
}
