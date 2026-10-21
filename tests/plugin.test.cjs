const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pluginFile = path.join(__dirname, '..', 'obsidian-plugin', 'finance-capture', 'main.js');
const pluginStylesFile = path.join(__dirname, '..', 'obsidian-plugin', 'finance-capture', 'styles.css');

class FakeVault {
  constructor() {
    this.files = new Map();
    this.folders = new Set();
    this.listeners = { delete: [], rename: [], create: [], modify: [] };
    this.failMarkdownCreate = false;
    this.events = [];
  }
  getAbstractFileByPath(target) { return this.files.get(target) || (this.folders.has(target) ? { path: target, children: [] } : null); }
  async createFolder(target) { this.folders.add(target); return this.getAbstractFileByPath(target); }
  async create(target, content) {
    if (this.failMarkdownCreate && target.endsWith('.md')) throw new Error('Нет места для карточки');
    if (this.files.has(target)) throw new Error(`File exists: ${target}`);
    const file = { path: target, extension: target.split('.').pop() };
    this.files.set(target, { ...file, content });
    this.events.push(['create', file]);
    return file;
  }
  async modify(file, content) { this.files.get(file.path).content = content; this.events.push(['modify', file]); }
  async flushEvents() {
    const events = this.events.splice(0);
    for (const [event, file] of events) await Promise.all([...this.listeners[event]].map((listener) => listener(file)));
  }
  offref(ref) { this.listeners[ref.event] = this.listeners[ref.event].filter((listener) => listener !== ref.listener); }
  async rename(file, target) {
    const stored = this.files.get(file.path);
    if (!stored) throw new Error(`Missing file: ${file.path}`);
    const oldPath = file.path;
    this.files.delete(oldPath);
    const renamed = { ...stored, path: target, extension: target.split('.').pop() };
    this.files.set(target, renamed);
    file.path = target;
    file.extension = renamed.extension;
    await Promise.all(this.listeners.rename.map((listener) => listener(file, oldPath)));
  }
  async delete(file) {
    this.files.delete(file.path);
    await Promise.all(this.listeners.delete.map((listener) => listener(file)));
  }
  async cachedRead(file) { return this.files.get(file.path)?.content || ''; }
  on(event, listener) { this.listeners[event].push(listener); return { event, listener }; }
  getFiles() { return [...this.files.values()]; }
}

function loadPlugin() {
  const notices = [];
  class MarkdownRenderChild {
    constructor(containerEl) { this.containerEl = containerEl; }
  }
  class Plugin {
    constructor(app) { this.app = app; this.commands = []; this.processors = new Map(); this.data = {}; this.eventRefs = []; }
    async loadData() { return this.data; }
    async saveData(value) { this.data = JSON.parse(JSON.stringify(value)); }
    addRibbonIcon() {}
    addCommand(command) { this.commands.push(command); }
    addSettingTab() {}
    registerInterval(interval) { clearInterval(interval); }
    registerEvent(ref) { this.eventRefs.push(ref); }
    unload() { this.onunload(); this.eventRefs.forEach((ref) => this.app.vault.offref(ref)); this.eventRefs = []; }
    registerMarkdownCodeBlockProcessor(name, processor) { this.processors.set(name, processor); }
  }
  class Modal { constructor(app) { this.app = app; this.contentEl = {}; } open() {} close() {} }
  class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; } }
  class Setting {
    constructor(container) { container.settings.push(this); this.controlEl = { classList: { add() {} } }; }
    setName(name) { this.name = name; return this; }
    setDesc() { return this; }
    control(callback) {
      this.field = { options: {}, inputEl: { classList: { add() {} }, setAttribute() {} }, addOption(key, label) { this.options[key] = label; return this; }, setValue(value) { this.value = value; return this; }, onChange(fn) { this.change = fn; return this; }, setButtonText() { return this; }, setCta() { return this; }, onClick(fn) { this.click = fn; return this; } };
      this.field.buttonEl = { classList: { add() {} }, setAttribute() {} };
      this.field.setIcon = this.field.setTooltip = function () { return this; };
      callback(this.field); return this;
    }
    addDropdown(fn) { return this.control(fn); }
    addText(fn) { return this.control(fn); }
    addTextArea(fn) { return this.control(fn); }
    addButton(fn) { return this.control(fn); }
  }
  const obsidian = {
    MarkdownRenderChild,
    Modal,
    Notice: class Notice { constructor(message) { notices.push(message); } },
    Plugin,
    PluginSettingTab,
    Setting,
    normalizePath: (value) => String(value).replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\//, '').replace(/\/$/, ''),
  };
  const module = { exports: {} };
  const source = fs.readFileSync(pluginFile, 'utf8');
  const wrapper = vm.runInThisContext(`(function (require, module, exports) {${source}\n})`, { filename: pluginFile });
  wrapper((name) => {
    if (name === 'obsidian') return obsidian;
    throw new Error(`Unexpected module: ${name}`);
  }, module, module.exports);
  return { PluginClass: module.exports, notices };
}

function renderElement(tag = 'root', attributes = {}) {
  return {
    tag,
    text: attributes.text || '',
    cls: attributes.cls || '',
    children: [],
    settings: [],
    empty() { this.children = []; this.text = ''; },
    addClass(name) { this.classes ||= []; this.classes.push(name); },
    createEl(childTag, childAttributes = {}) {
      const child = renderElement(childTag, childAttributes);
      this.children.push(child);
      return child;
    },
  };
}

function renderedText(element) {
  return [element.text, ...element.children.map(renderedText)].filter(Boolean).join(' ');
}

const sampleOperation = {
  date: '2026-10-14', type: 'Расход', category: 'Продукты', amount: 420.5,
  currency: 'RUB', accountId: 5, necessity: 'Обязательная', notes: 'Молоко | хлеб\nПокупка по дороге',
};

async function saveTestOperation(plugin, operation) {
  // Explicit account fixture for lifecycle tests; production save still requires synced accounts.
  if (!plugin.captureLists.accounts.length) plugin.captureLists.accounts = [{ id: 5, name: 'Fixture', currency: 'RUB' }];
  return plugin.saveOperation(operation);
}

test('форматирует суммы с точками тысяч и сохраняет десятичную запятую', () => {
  const { PluginClass } = loadPlugin();
  assert.equal(PluginClass.formatAmountInputValue('1234'), '1.234');
  assert.equal(PluginClass.formatAmountInputValue('1234567,89'), '1.234.567,89');
  assert.equal(PluginClass.formatAmountInputValue('1234.', 4), '1.234,');
  assert.equal(PluginClass.formatAmountInputValue('1234.56'), '1.234,56');
  assert.equal(PluginClass.parseAmountInputValue('1.234.567,89'), 1234567.89);
  assert.equal(PluginClass.parseAmountInputValue('1234.56'), 1234.56);
});

test('стирание суммы не превращает неполную группу тысяч в дробную часть', () => {
  const { PluginClass } = loadPlugin();
  const input = {
    value: '',
    selectionStart: 0,
    addEventListener(name, handler) { if (name === 'input') this.handleInput = handler; },
    setSelectionRange(start) { this.selectionStart = start; },
  };
  const field = {
    inputEl: input,
    setValue(value) { input.value = value; return this; },
    onChange(handler) { this.handleChange = handler; return this; },
  };
  let savedValue = '';
  PluginClass.configureAmountInput(field, '222222222', (value) => { savedValue = value; });
  assert.equal(input.value, '222.222.222');

  for (const expected of ['22.222.222', '2.222.222', '222.222', '22.222']) {
    input.value = input.value.slice(0, -1);
    input.selectionStart = input.value.length;
    input.handleInput({ inputType: 'deleteContentBackward', data: null });
    field.handleChange(input.value);
    assert.equal(input.value, expected);
  }
  assert.equal(PluginClass.parseAmountInputValue(savedValue), 22222);

  input.value = '1234.56';
  input.selectionStart = input.value.length;
  input.handleInput({ inputType: 'insertFromPaste', data: null });
  assert.equal(input.value, '1.234,56');
});

test('audit: чужие пути и несовпадающий ID не разрешают удаление', async () => {
  const { PluginClass } = loadPlugin();
  const vault = new FakeVault();
  const plugin = new PluginClass({ vault });
  await plugin.onload();
  await vault.create('Private/important.md', '# Keep');
  const forged = 'Finance Sync/operations/forged.md';
  await vault.create(forged, '---\nfinance_capture: true\nfinance_id: "forged-event"\nfinance_json: "Private/important.md"\n---');
  plugin.settings.recordLinks[forged] = { id: 'forged-event', jsonPath: 'Private/important.md' };
  assert.equal((await plugin.listManagedCards()).length, 0);
  await vault.delete(vault.getAbstractFileByPath(forged));
  assert.ok(vault.files.has('Private/important.md'));
  assert.equal(plugin.validQueuePath('forged-event', 'Finance Sync/incoming/../forged-event.json'), false);
  assert.equal(plugin.validQueuePath('forged-event', 'Finance Sync/incoming/forged-event.md'), false);
  const saved = await saveTestOperation(plugin, sampleOperation);
  vault.files.get(saved.jsonPath).content = JSON.stringify({ schema: 1, id: 'different-event', operation: sampleOperation });
  await vault.delete(vault.getAbstractFileByPath(saved.recordPath));
  assert.ok(vault.files.has(saved.jsonPath));
  await vault.create('Finance Sync/incoming/personal.json', '{"private":true}');
  await plugin.deleteAllRecords();
  assert.ok(vault.files.has(saved.jsonPath));
  assert.ok(vault.files.has('Finance Sync/incoming/personal.json'));
  plugin.onunload();
});

test('audit: переименование при выключенном плагине восстанавливает связь без отмены', async () => {
  const { PluginClass } = loadPlugin();
  const vault = new FakeVault();
  const plugin = new PluginClass({ vault });
  await plugin.onload();
  const saved = await saveTestOperation(plugin, sampleOperation);
  const persisted = JSON.parse(JSON.stringify(plugin.data));
  plugin.onunload();
  for (const event of Object.keys(vault.listeners)) vault.listeners[event] = [];
  await vault.rename(vault.getAbstractFileByPath(saved.recordPath), 'Finance Sync/operations/offline-renamed.md');
  const reloaded = new PluginClass({ vault });
  reloaded.data = persisted;
  await reloaded.onload();
  assert.ok(vault.files.has(saved.jsonPath));
  const cards = await reloaded.listManagedCards();
  assert.equal(cards.length, 1);
  assert.equal(cards[0].id, saved.id);
  assert.equal(reloaded.settings.recordLinks[cards[0].recordPath].id, saved.id);
  await vault.delete(cards[0].file);
  assert.equal(vault.files.has(saved.jsonPath), false);
  reloaded.onunload();
});

test('мобильные формы показывают эмодзи, порядок и суммы перевода; сброс удаляет только старые данные', async () => {
  const { PluginClass } = loadPlugin();
  const vault = new FakeVault();
  await vault.create('Finance Sync/config/lists.json', JSON.stringify({ schema: 1, lists: { categories: [{ name: 'Продукты', type: 'Расход', emoji: '🥑' }], accounts: [{ id: 7, name: 'Первый', currency: 'RUB' }, { id: 5, name: 'Второй', currency: 'RUB' }, { id: 6, name: 'Доллары', currency: 'USD' }] } }));
  const plugin = new PluginClass({ vault });
  await plugin.onload();
  const panel = { settings: [], empty() { this.settings = []; }, addClass() {}, createEl() {} };
  await plugin.processors.get('finance-capture')('', panel);
  const field = (name) => panel.settings.find((setting) => setting.name === name)?.field;
  assert.equal(field('Категория').options['Продукты'], '🥑 Продукты');
  assert.equal(plugin.captureLists.accounts[0].id, 7);
  field('Тип').change('Перевод');
  assert.equal(field('Валюта'), undefined);
  assert.equal(field('Зачислено').inputEl.readOnly, true);
  field('Списано').change('123');
  assert.equal(field('Зачислено').value, '123');
  field('Счёт назначения').change('6');
  assert.equal(field('Зачислено').inputEl.readOnly, false);
  const saved = await saveTestOperation(plugin, sampleOperation);
  const queued = await vault.cachedRead(vault.getAbstractFileByPath(saved.jsonPath));
  await vault.create('Finance Sync/operations/personal.md', '# Keep');
  await vault.create('Finance Sync/config/reset.json', JSON.stringify({ schema: 1, cutoff: new Date(Date.now() + 1000).toISOString(), ids: [] }));
  await plugin.applyDataReset();
  assert.equal(vault.files.has(saved.jsonPath), false);
  assert.equal(vault.files.has(saved.recordPath), false);
  assert.equal(vault.files.has('Finance Sync/operations/personal.md'), true);
  await vault.create(saved.jsonPath, queued);
  await plugin.applyDataReset();
  assert.equal(vault.files.has(saved.jsonPath), false);
  const fresh = JSON.parse(queued); fresh.id = 'fresh'; fresh.createdAt = new Date(Date.now() + 10000).toISOString();
  await vault.create('Finance Sync/incoming/fresh.json', JSON.stringify(fresh));
  await plugin.applyDataReset();
  assert.equal(vault.files.has('Finance Sync/incoming/fresh.json'), true);
});

test('Obsidian-плагин создаёт панель и связанную read-only карточку', async (t) => {
  const { PluginClass, notices } = loadPlugin();
  const vault = new FakeVault();
  const plugin = new PluginClass({ vault });
  await plugin.onload();

  await t.test('регистрирует процессор и вставляет блок панели в заметку', () => {
    assert.equal(plugin.processors.has('finance-capture'), true);
    assert.equal(plugin.processors.has('finance-capture-manager'), true);
    const command = plugin.commands.find((item) => item.id === 'insert-finance-capture-panel');
    let inserted = '';
    command.editorCallback({ getCursor: () => ({ line: 0, ch: 0 }), replaceRange: (value) => { inserted = value; } });
    assert.equal(inserted, '```finance-capture\n```\n');
    const managerCommand = plugin.commands.find((item) => item.id === 'insert-finance-capture-manager');
    managerCommand.editorCallback({ getCursor: () => ({ line: 0, ch: 0 }), replaceRange: (value) => { inserted = value; } });
    assert.equal(inserted, '```finance-capture-manager\n```\n');
    const balancesCommand = plugin.commands.find((item) => item.id === 'insert-finance-balances-panel');
    balancesCommand.editorCallback({ getCursor: () => ({ line: 0, ch: 0 }), replaceRange: (value) => { inserted = value; } });
    assert.equal(inserted, '```finance-balances\n```\n');
    assert.equal(plugin.processors.has('finance-balances'), true);
  });

  await t.test('календарь и дата находятся в отдельных flex-элементах без встроенной иконки', () => {
    const source = fs.readFileSync(pluginFile, 'utf8');
    const styles = fs.readFileSync(pluginStylesFile, 'utf8');
    assert.match(source, /classList\.add\('finance-capture-date-input'\)/);
    assert.match(source, /setIcon\('calendar-days'\)/);
    assert.match(source, /datePicker\.showPicker\(\)/);
    assert.match(source, /field\.inputEl\.type = 'text'/);
    assert.match(source, /finance-capture-native-date-picker/);
    assert.match(styles, /background-image:\s*none\s*!important/);
    assert.match(styles, /calendar-picker-indicator\s*\{\s*display:\s*none\s*!important/);
    assert.match(styles, /flex:\s*0 0 36px/);
  });

  await t.test('читает синхронизированные справочники и откатывается к резервным', async () => {
    const listsVault = new FakeVault();
    const payload = {
      schema: 1,
      lists: {
        categories: [{ name: 'Еда с телефона', type: 'Расход', emoji: '🍜' }, { name: 'Транспорт', type: 'Расход', emoji: '🚕' }, { name: 'Премия', type: 'Доход', emoji: '🎉' }],
        currencies: ['RUB', 'JPY'],
        necessities: ['Важно', 'Можно'],
        operationTypes: ['Расход', 'Доход', 'Перевод'],
        accounts: [{ id: 5, name: 'Основная карта', currency: 'RUB', startDate: '2026-10-01' }],
      },
    };
    await listsVault.create('Finance Sync/config/lists.json', JSON.stringify(payload));
    const listsPlugin = new PluginClass({ vault: listsVault });
    await listsPlugin.onload();
    assert.deepEqual(listsPlugin.captureLists.currencies, ['RUB', 'JPY']);
    assert.deepEqual(listsPlugin.captureLists.categories.Расход, ['Еда с телефона', 'Транспорт']);
    assert.deepEqual(listsPlugin.captureLists.necessities, ['Важно', 'Можно']);
    assert.equal(listsPlugin.captureLists.categoryEmojis['Еда с телефона'], '🍜');
    assert.deepEqual(listsPlugin.captureLists.accounts, [{ id: 5, name: 'Основная карта', currency: 'RUB' }]);
    assert.ok(listsPlugin.captureLists.operationTypes.includes('Перевод'));
    const syncedCard = await saveTestOperation(listsPlugin, { ...sampleOperation, category: 'Еда с телефона', necessity: 'Важно' });
    assert.match(syncedCard.recordPath, /🍜 Еда с телефона/);
    let refreshedForms = 0;
    listsPlugin.captureFormRefreshers.add(() => { refreshedForms += 1; });
    payload.lists.currencies = ['JPY', 'RUB'];
    payload.lists.necessities = ['Можно', 'Важно'];
    payload.lists.accounts.push({ id: 6, name: 'Наличные', currency: 'RUB' });
    payload.lists.categories = [payload.lists.categories[1], payload.lists.categories[0], payload.lists.categories[2]];
    payload.lists.categories[1].emoji = '🍱';
    listsVault.files.get('Finance Sync/config/lists.json').content = JSON.stringify(payload);
    await listsPlugin.onListsFileChanged('Finance Sync/config/lists.json');
    assert.deepEqual(listsPlugin.captureLists.currencies, ['JPY', 'RUB']);
    assert.deepEqual(listsPlugin.captureLists.necessities, ['Можно', 'Важно']);
    assert.deepEqual(listsPlugin.captureLists.categories.Расход, ['Транспорт', 'Еда с телефона']);
    assert.equal(listsPlugin.captureLists.accounts.length, 2);
    assert.equal(refreshedForms, 1);
    assert.equal(listsPlugin.captureLists.categoryEmojis['Еда с телефона'], '🍱');
    assert.equal(listsVault.files.has(syncedCard.recordPath), false);
    assert.ok([...listsVault.files.keys()].some((file) => file.includes('🍱 Еда с телефона')));
    listsVault.files.get('Finance Sync/config/lists.json').content = '{broken';
    assert.equal(await listsPlugin.refreshMobileLists(), false);
    assert.ok(listsPlugin.captureLists.currencies.includes('USD'));
  });

  await t.test('переименовывает карточку с категорией со слешем и сохраняет счета', async () => {
    const listsVault = new FakeVault();
    await listsVault.createFolder('Finance Sync/operations');
    await listsVault.create('Finance Sync/config/lists.json', JSON.stringify({
      schema: 1,
      lists: {
        categories: [{ name: 'Работа / зарплата', type: 'Доход', emoji: '💼' }],
        accounts: [{ id: 5, name: 'Основной', currency: 'RUB' }],
      },
    }));
    const oldPath = 'Finance Sync/operations/1 — В очереди — 2026-10-14 — Работа - зарплата — 100 RUB.md';
    await listsVault.create(oldPath, [
      '---',
      'finance_capture: true',
      'finance_id: "legacy-category-event"',
      'finance_json: "Finance Sync/incoming/legacy-category-event.json"',
      'finance_category: "Работа / зарплата"',
      '---',
    ].join('\n'));
    const originalRename = listsVault.rename.bind(listsVault);
    listsVault.rename = async (file, target) => {
      const parent = target.slice(0, target.lastIndexOf('/'));
      if (!listsVault.getAbstractFileByPath(parent)) throw new Error('The parent object of the destination does not exist');
      return originalRename(file, target);
    };
    const { PluginClass, notices } = loadPlugin();
    const listsPlugin = new PluginClass({ vault: listsVault });
    await listsPlugin.onload();
    assert.equal(listsPlugin.captureLists.accounts.length, 1);
    assert.ok([...listsVault.files.keys()].some((file) => file.includes('💼 Работа - зарплата')));
    assert.ok(!notices.some((notice) => notice.startsWith('Справочники не приняты:')));
  });

  await t.test('оставляет принятые справочники доступными при ошибке обновления карточек', async () => {
    const listsVault = new FakeVault();
    const payload = {
      schema: 1,
      lists: { accounts: [{ id: 5, name: 'Основной', currency: 'RUB' }] },
    };
    await listsVault.create('Finance Sync/config/lists.json', JSON.stringify(payload));
    const { PluginClass, notices } = loadPlugin();
    const listsPlugin = new PluginClass({ vault: listsVault });
    await listsPlugin.onload();
    listsPlugin.syncCardCategoryEmojis = async () => { throw new Error('The parent object of the destination does not exist'); };
    payload.lists.accounts[0].name = 'Основной счёт';
    listsVault.files.get('Finance Sync/config/lists.json').content = JSON.stringify(payload);
    assert.equal(await listsPlugin.refreshMobileLists(), true);
    assert.deepEqual(listsPlugin.captureLists.accounts, [{ id: 5, name: 'Основной счёт', currency: 'RUB' }]);
    assert.ok(notices.some((notice) => notice === 'Справочники приняты, но имена карточек не обновлены.'));
    assert.ok(!notices.some((notice) => notice.startsWith('Справочники не приняты:')));
  });

  await t.test('обновляет статусы в именах существующих карточек', async () => {
    const legacyVault = new FakeVault();
    const jsonPath = 'Finance Sync/incoming/legacy-event.json';
    const legacyPath = 'Finance Sync/operations/2026-10-14 — Продукты — 100 RUB.md';
    await legacyVault.create(jsonPath, '{}');
    await legacyVault.create(legacyPath, `---\nfinance_capture: true\nfinance_id: "legacy-event"\nfinance_json: "${jsonPath}"\n---\n`);
    const legacyPlugin = new PluginClass({ vault: legacyVault });
    await legacyPlugin.onload();
    const pendingPath = legacyPath.replace('2026-10-14', '1 — В очереди — 2026-10-14');
    assert.ok(legacyVault.files.has(pendingPath));
    await legacyVault.delete(legacyVault.files.get(jsonPath));
    const archivedPath = pendingPath.replace('1 — В очереди — ', '2 — Архив — ');
    assert.equal(legacyVault.files.has(pendingPath), false);
    assert.ok(legacyVault.files.has(archivedPath));
  });

  let saved;
  await t.test('создаёт готовый JSON очереди и Markdown-карточку без временных файлов', async () => {
    saved = await saveTestOperation(plugin, sampleOperation);
    assert.equal(saved.cardCreated, true);
    assert.equal(saved.recordPath, 'Finance Sync/operations/1 — В очереди — 2026-10-14 — 🛒 Продукты — 420,5 RUB.md');
    assert.ok(vault.files.has(saved.jsonPath));
    assert.ok(vault.files.has(saved.recordPath));
    assert.equal([...vault.files.keys()].some((target) => target.endsWith('.pending')), false);
    const event = JSON.parse(vault.files.get(saved.jsonPath).content);
    assert.deepEqual(event.operation, sampleOperation);
    const card = vault.files.get(saved.recordPath).content;
    assert.match(card, /finance_capture: true/);
    assert.match(card, /finance_category: "Продукты"/);
    assert.match(card, /🛒 Продукты/);
    assert.match(card, /представление только для чтения/);
    assert.match(card, /Молоко \\| хлеб/);
    assert.match(card, /\| Счёт \| Fixture \|/);
    assert.match(card, new RegExp(event.id));
    const jsonBeforeCardEdit = vault.files.get(saved.jsonPath).content;
    vault.files.get(saved.recordPath).content += '\nРучное изменение';
    assert.equal(vault.files.get(saved.jsonPath).content, jsonBeforeCardEdit);
  });

  await t.test('переименование карточки сохраняет связь, а удаление отменяет ожидающий JSON', async () => {
    const card = vault.files.get(saved.recordPath);
    const renamedPath = 'Finance Sync/operations/покупка.md';
    await vault.rename(card, renamedPath);
    assert.ok(plugin.settings.recordLinks[renamedPath]);
    await vault.delete(vault.files.get(renamedPath));
    assert.equal(vault.files.has(saved.jsonPath), false);
    assert.equal(plugin.settings.recordLinks[renamedPath], undefined);
    assert.ok(notices.includes('Карточка удалена, ожидающая операция отменена.'));
  });

  await t.test('после импорта JSON исчезает, а карточка остаётся', async () => {
    const imported = await saveTestOperation(plugin, { ...sampleOperation, notes: 'Уже импортировано' });
    await vault.delete(vault.files.get(imported.jsonPath));
    const archivedPath = imported.recordPath.replace('1 — В очереди — ', '2 — Архив — ');
    assert.equal(vault.files.has(imported.recordPath), false);
    assert.ok(vault.files.has(archivedPath));
    assert.ok(plugin.settings.recordLinks[archivedPath]);
    const originalJson = JSON.stringify(sampleOperation);
    vault.files.get(archivedPath).content = '# Пользователь изменил карточку';
    assert.equal(JSON.stringify(sampleOperation), originalJson);
    await vault.delete(vault.files.get(archivedPath));
    assert.equal(vault.files.has(imported.jsonPath), false);
  });

  await t.test('повторно проверяет удаление JSON после обновления состояния хранилища', async () => {
    const imported = await saveTestOperation(plugin, { ...sampleOperation, notes: 'Удаление пришло раньше обновления индекса' });
    const jsonFile = vault.files.get(imported.jsonPath);
    await plugin.onVaultDelete(jsonFile);
    assert.ok(vault.files.has(imported.recordPath));
    vault.files.delete(imported.jsonPath);
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(vault.files.has(imported.recordPath), false);
    const card = (await plugin.listManagedCards()).find((item) => item.id === imported.id);
    assert.ok(card);
    assert.match(card.recordPath.split('/').pop(), /^2 /);
  });

  await t.test('позднее появление JSON и переименование pending исправляют архивный статус', async () => {
    const created = await saveTestOperation(plugin, sampleOperation);
    await vault.delete(vault.getAbstractFileByPath(created.jsonPath));
    const archived = () => vault.getFiles().find((file) => file.extension === 'md' && file.content.includes(created.id));
    assert.ok(archived().path.includes('2 — Архив'));
    const file = await vault.create(created.jsonPath, '{}');
    await Promise.all(vault.listeners.create.map((listener) => listener(file)));
    await new Promise((resolve) => setTimeout(resolve, 650));
    await plugin.cardStatusSyncQueue;
    assert.ok(archived().path.includes('1 — В очереди'));
    await vault.delete(vault.getAbstractFileByPath(created.jsonPath));
    const pending = await vault.create(created.jsonPath.replace('.json', '.pending'), '{}');
    await vault.rename(pending, created.jsonPath);
    await new Promise((resolve) => setTimeout(resolve, 650));
    await plugin.cardStatusSyncQueue;
    assert.ok(archived().path.includes('1 — В очереди'));
  });

  await t.test('отсутствие карточки при запуске не отменяет ожидающую операцию', async () => {
    const pending = await saveTestOperation(plugin, { ...sampleOperation, notes: 'Удалено офлайн' });
    vault.files.delete(pending.recordPath);
    assert.ok(vault.files.has(pending.jsonPath));
    await plugin.reconcileDeletedRecords();
    assert.equal(vault.files.has(pending.jsonPath), true);
    assert.equal(plugin.settings.recordLinks[pending.recordPath], undefined);
  });

  await t.test('сохраняет основной JSON, даже если карточку создать не удалось', async () => {
    vault.failMarkdownCreate = true;
    const queued = await saveTestOperation(plugin, { ...sampleOperation, notes: 'Без карточки' });
    assert.equal(queued.cardCreated, false);
    assert.equal(queued.recordPath, null);
    assert.ok(vault.files.has(queued.jsonPath));
    assert.ok(notices.some((message) => message.startsWith('Операция сохранена, но карточку создать не удалось:')));
  });

  await t.test('панель управления удаляет только нужный набор файлов', async () => {
    const cleanupVault = new FakeVault();
    const cleanupPlugin = new PluginClass({ vault: cleanupVault });
    await cleanupPlugin.onload();
    const archived = await saveTestOperation(cleanupPlugin, sampleOperation);
    const pending = await saveTestOperation(cleanupPlugin, sampleOperation);
    assert.match(pending.recordPath, / — [A-Za-z0-9-]{8}\.md$/);
    await cleanupVault.delete(cleanupVault.files.get(archived.jsonPath));
    const archivedPath = archived.recordPath.replace('1 — В очереди — ', '2 — Архив — ');
    assert.ok(cleanupVault.files.has(archivedPath));
    assert.ok(pending.recordPath.localeCompare(archivedPath) < 0);
    await cleanupVault.create('Finance Sync/operations/обычная заметка.md', '# Не карточка плагина');
    await cleanupVault.create('Finance Sync/receipts/receipt.json', '{}');
    await cleanupVault.create('Панель.md', '```finance-capture-manager\n```');

    assert.deepEqual(await cleanupPlugin.getCleanupSummary(), { allCards: 2, archivedCards: 1, pendingJson: 1 });
    const archivedResult = await cleanupPlugin.deleteArchivedRecords();
    assert.deepEqual(archivedResult, { deletedCards: 1 });
    assert.equal(cleanupVault.files.has(archivedPath), false);
    assert.ok(cleanupVault.files.has(pending.recordPath));
    assert.ok(cleanupVault.files.has(pending.jsonPath));

    const allResult = await cleanupPlugin.deleteAllRecords();
    assert.deepEqual(allResult, { deletedCards: 1, deletedJson: 1 });
    assert.equal(cleanupVault.files.has(pending.recordPath), false);
    assert.equal(cleanupVault.files.has(pending.jsonPath), false);
    assert.ok(cleanupVault.files.has('Finance Sync/operations/обычная заметка.md'));
    assert.ok(cleanupVault.files.has('Finance Sync/receipts/receipt.json'));
    assert.ok(cleanupVault.files.has('Панель.md'));
  });
});

test('панель общих балансов отображает синхронизированный снимок и обновляется при его изменении', async () => {
  const { PluginClass } = loadPlugin();
  const vault = new FakeVault();
  const path = 'Finance Sync/config/balances.json';
  const snapshot = {
    schema: 1,
    generatedAt: '2026-10-16T10:15:00.000Z',
    asOfDate: '2026-10-16',
    workbook: 'finance.xlsx',
    accounts: [
      { id: 5, name: 'Основная карта', currency: 'RUB', balance: 1234.5, rate: 1, rateEffectiveDate: '2026-10-16', rubAmount: 1234.5 },
      { id: 6, name: 'Валютный счёт', currency: 'USD', balance: 10, rate: 80, rateEffectiveDate: '2026-10-15', rubAmount: 800 },
    ],
    rates: { RUB: { rate: 1, effectiveDate: '2026-10-16' }, USD: { rate: 80, effectiveDate: '2026-10-15' } },
    missingRates: [],
    totalRub: 2034.5,
  };
  await vault.create(path, JSON.stringify(snapshot));
  const plugin = new PluginClass({ vault });
  await plugin.onload();
  const panel = renderElement();
  let child;
  await plugin.processors.get('finance-balances')('', panel, { addChild(value) { child = value; value.onload(); } });
  assert.match(renderedText(panel), /Основная карта/);
  assert.match(renderedText(panel), /1 234,5 RUB/);
  assert.match(renderedText(panel), /Общий итог/);
  assert.match(renderedText(panel), /2 034,5 RUB/);

  snapshot.accounts[1].balance = 11;
  snapshot.accounts[1].rubAmount = 880;
  snapshot.totalRub = 2114.5;
  snapshot.generatedAt = '2026-10-16T10:20:00.000Z';
  vault.files.get(path).content = JSON.stringify(snapshot);
  await plugin.onBalancesFileChanged(path);
  assert.match(renderedText(panel), /2 114,5 RUB/);

  snapshot.totalRub = true;
  vault.files.get(path).content = JSON.stringify(snapshot);
  await plugin.onBalancesFileChanged(path);
  assert.match(renderedText(panel), /последний корректный снимок/);
  vault.files.get(path).content = '{partial';
  await plugin.onBalancesFileChanged(path);
  assert.match(renderedText(panel), /последний корректный снимок/);
  assert.match(renderedText(panel), /2 114,5 RUB/);
  child.onunload();
  assert.equal(plugin.balancePanelRefreshers.size, 0);
});


test('identity: старый мобильный контракт принимает reset ID независимо от часов и новые счета', async () => {
  const { PluginClass } = loadPlugin();
  const vault = new FakeVault();
  await vault.create('Finance Sync/config/lists.json', JSON.stringify({ schema: 1, lists: { accounts: [{ id: 104, name: 'Новый ID', currency: 'RUB' }] } }));
  const plugin = new PluginClass({ vault });
  await plugin.onload();
  assert.equal(plugin.captureLists.accounts[0].id, 104);
  const saved = await saveTestOperation(plugin, { ...sampleOperation, accountId: 104 });
  const raw = JSON.parse(await vault.cachedRead(vault.getAbstractFileByPath(saved.jsonPath)));
  const cutoff = '2020-01-01T00:00:00.000Z';
  assert.ok(Date.parse(raw.createdAt) > Date.parse(cutoff));
  await vault.create('Finance Sync/config/reset.json', JSON.stringify({ schema: 1, cutoff, ids: [saved.id] }));
  await plugin.applyDataReset();
  assert.equal(vault.files.has(saved.jsonPath), false);
  assert.equal(vault.files.has(saved.recordPath), false);
  const fresh = await saveTestOperation(plugin, { ...sampleOperation, accountId: 104 });
  await plugin.applyDataReset();
  assert.equal(vault.files.has(fresh.jsonPath), true);
  plugin.onunload();
});


test('boundary: capture rejects invalid input before files and emits schema-compatible events', async () => {
  const { assertContract } = await import('./contract-validation.mjs');
  const { PluginClass } = loadPlugin();
  const vault = new FakeVault();
  const plugin = new PluginClass({ vault });
  await plugin.onload();
  await assert.rejects(plugin.saveOperation(sampleOperation));
  plugin.captureLists.accounts = [{ id: 5, name: 'Fixture', currency: 'RUB' }];
  const before = vault.files.size;
  for (const patch of [{ date: '2026-02-30' }, { amount: true }, { amount: 1e9 }, { notes: 'x'.repeat(501) }, { accountId: 105 }]) {
    await assert.rejects(plugin.saveOperation({ ...sampleOperation, ...patch }));
    assert.equal(vault.files.size, before);
  }
  const saved = await plugin.saveOperation(sampleOperation);
  assertContract('operation', JSON.parse(await vault.cachedRead(vault.getAbstractFileByPath(saved.jsonPath))));
  plugin.onunload();
});

test('boundary: unknown lists version does not authorize capture', async () => {
  const { PluginClass } = loadPlugin();
  const vault = new FakeVault();
  await vault.create('Finance Sync/config/lists.json', JSON.stringify({ schema: 2, lists: { accounts: [{ id: 5, name: 'Fixture', currency: 'RUB' }] } }));
  const plugin = new PluginClass({ vault });
  await plugin.onload();
  assert.equal(plugin.captureLists.accounts.length, 0);
  await assert.rejects(plugin.saveOperation(sampleOperation));
  plugin.onunload();
});

test('lifecycle: delayed partial receipts do not prove import; unload releases events', async () => {
  const { PluginClass } = loadPlugin();
  const vault = new FakeVault();
  const plugin = new PluginClass({ vault });
  await plugin.onload();
  const saved = await saveTestOperation(plugin, sampleOperation);
  await vault.delete(vault.getAbstractFileByPath(saved.jsonPath));
  const card = () => vault.getFiles().find((f) => f.extension === 'md' && f.content.includes(saved.id));
  assert.match(card().content, /Импорт не подтверждён/);
  const receipt = await vault.create(`Finance Sync/receipts/${saved.id}.json`, '{partial');
  await vault.flushEvents(); await plugin.queueCardStatusSync();
  assert.match(card().content, /Импорт не подтверждён/);
  await vault.modify(receipt, JSON.stringify({ schema: 1, id: saved.id, status: 'imported', importedAt: '2026-10-17T09:00:00Z' }));
  await vault.flushEvents(); await plugin.queueCardStatusSync();
  assert.match(card().content, /Импорт подтверждён компьютером/);
  await vault.flushEvents(); await plugin.queueCardStatusSync();
  assert.equal((card().content.match(/finance-status:start/g) || []).length, 1);
  plugin.captureFormRefreshers.add(() => {});
  plugin.unload();
  assert.equal(plugin.captureFormRefreshers.size, 0);
  assert.equal(Object.values(vault.listeners).flat().length, 0);
  await plugin.onload();
  assert.equal(vault.listeners.create.length, 1);
  plugin.unload();
});

test('lifecycle: capture panels release callbacks independently', async () => {
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass({ vault: new FakeVault() });
  await plugin.onload();
  const children = [];
  for (let i = 0; i < 30; i++) {
    await plugin.processors.get('finance-capture')('', renderElement(), { addChild(child) { children.push(child); child.onload(); } });
  }
  assert.equal(plugin.captureFormRefreshers.size, 30);
  for (const child of children.slice(0, 29)) child.onunload();
  assert.equal(plugin.captureFormRefreshers.size, 1);
  for (const refresh of plugin.captureFormRefreshers) refresh();
  children[29].onunload();
  assert.equal(plugin.captureFormRefreshers.size, 0);
  plugin.unload();
});

test('load: 1000 cards reconcile with repeated events and bounded callbacks', async () => {
  const { PluginClass } = loadPlugin();
  const vault = new FakeVault();
  const plugin = new PluginClass({ vault });
  await plugin.onload();
  const saved = await saveTestOperation(plugin, sampleOperation);
  const original = vault.files.get(saved.recordPath).content;
  vault.files.clear();
  plugin.settings.recordLinks = {};
  for (let i = 0; i < 1000; i++) {
    const id = `load-card-${i}`;
    const cardPath = `Finance Sync/operations/1 — В очереди — ${i}.md`;
    vault.files.set(cardPath, { path: cardPath, extension: 'md', content: original.replaceAll(saved.id, id) });
  }
  const started = performance.now();
  await plugin.queueCardStatusSync();
  await plugin.queueCardStatusSync();
  assert.equal(vault.getFiles().filter((f) => f.path.includes('2 — Архив')).length, 1000);
  assert.equal(Object.keys(plugin.settings.recordLinks).length, 1000);
  assert.equal(plugin.captureFormRefreshers.size, 0);
  console.log(`Card benchmark: 1000 cards, two passes ${Math.round(performance.now() - started)} ms, RSS ${Math.round(process.memoryUsage().rss / 1048576)} MiB`);
  plugin.unload();
});
