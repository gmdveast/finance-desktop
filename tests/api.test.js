import { assertContract } from './contract-validation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { resetFinancialRows } from './workbook-fixture.mjs';
import { createFixture } from './create-fixture.mjs';
import { installTestClock } from './test-clock.mjs';

const sha256 = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

async function jsonRequest(baseUrl, route, options = {}) {
  if (options.headers?.Host) return new Promise((resolve, reject) => {
    const request = httpRequest(`${baseUrl}${route}`, options, (response) => {
      let body = ''; response.setEncoding('utf8'); response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ response: { status: response.statusCode }, payload: JSON.parse(body) }));
    });
    request.on('error', reject); request.end(options.body);
  });
  const response = await fetch(`${baseUrl}${route}`, options);
  const payload = await response.json();
  return { response, payload };
}

async function setup(t, legacy = false) {
  const restoreClock = installTestClock();
  t.after(restoreClock);
  const sandbox = await mkdtemp(path.join(tmpdir(), 'finance-workbook-test-'));
  const workbook = path.join(sandbox, 'finance-test.xlsx');
  const backups = path.join(sandbox, 'backups');
  const cbrCache = path.join(sandbox, 'cbr-rates.json');
  await createFixture(workbook);
  await mkdir(backups);

  const cbrPort = await freePort();
  const rates = { comparison: false, firstDayUnavailable: false };
  const requestedDates = [];
  const cbrServer = createServer(async (_req, res) => {
    const requestedDate = new URL(_req.url, 'http://localhost').searchParams.get('date_req');
    requestedDates.push(requestedDate);
    if (rates.gate && requestedDate === '15/03/2019') { rates.started(); await rates.gate; }
    if (rates.unavailable) { res.writeHead(503); res.end('PRIVATE_UPSTREAM'); return; }
    if (rates.firstDayUnavailable) {
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      if (requestedDate.startsWith('01/')) { res.end('<ValCurs Date="01.10.2026"></ValCurs>'); return; }
      res.end('<ValCurs Date="14.10.2026"><Valute><CharCode>USD</CharCode><Nominal>1</Nominal><Value>83.9153</Value></Valute><Valute><CharCode>GEL</CharCode><Nominal>1</Nominal><Value>32.2642</Value></Valute></ValCurs>');
      return;
    }
    if (rates.comparison) {
      const rate = requestedDates.at(-1).startsWith('01/') ? '10' : '12';
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end(`<ValCurs Date="14.10.2026"><Valute><CharCode>GEL</CharCode><Nominal>1</Nominal><Value>${rate}</Value></Valute></ValCurs>`);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/xml; charset=windows-1251' });
    res.end('<?xml version="1.0"?><ValCurs Date="12.10.2026"><Valute><CharCode>USD</CharCode><Nominal>1</Nominal><Value>83,9153</Value></Valute><Valute><CharCode>VND</CharCode><Nominal>10000</Nominal><Value>32,5000</Value></Valute><Valute><CharCode>JPY</CharCode><Nominal>100</Nominal><Value>54,0000</Value></Valute><Valute><CharCode>GEL</CharCode><Nominal>1</Nominal><Value>32,2642</Value></Valute></ValCurs>');
  });
  await new Promise((resolve) => cbrServer.listen(cbrPort, '127.0.0.1', resolve));

  const appPort = await freePort();
  process.env.FINANCE_DATA_DIR = sandbox;
  process.env.WORKBOOK_PATH = workbook;
  process.env.BACKUP_DIR = backups;
  process.env.CBR_CACHE_PATH = cbrCache;
  process.env.FINANCE_SYNC_DIR = path.join(sandbox, 'default-sync');
  process.env.CBR_BASE_URL = `http://127.0.0.1:${cbrPort}/daily`;
  process.env.NODE_ENV = 'test';
  const api = await import(`../server.js?api-test=${sandbox}`);
  const { migrateAccountModel, migrateStreamlinedModel, ensureOperationCapacity, exportMobileBalancesOnce, exportMobileListsOnce, importInboxOnce, synchronizeMobile, startInboxImporter, loadWorkbook, migrateCategoryEmojis, repairTransferRatesOnce, startServer } = api;
  const fixtureWorkbook = await loadWorkbook();
  const balance = fixtureWorkbook.getWorksheet('Баланс');
  for (const [col, value] of [[1, 'Тестовый валютный счёт'], [2, 'GEL'], [4, 32.2642]]) balance.getCell(6, col).value = value;
  if (legacy) {
    for (const [col, value] of [[3, 191.89], [6, 'Старый комментарий'], [7, 46000], [8, 191.89], [9, 46000], [10, 5], [12, -2]]) balance.getCell(6, col).value = value;
  } else {
    migrateAccountModel(fixtureWorkbook);
    migrateStreamlinedModel(fixtureWorkbook);
    for (const [col, value] of [[1, 'Наличные'], [2, 'RUB'], [4, 1]]) balance.getCell(5, col).value = value;
  }
  await fixtureWorkbook.writeFile(workbook);
  const appServer = startServer(appPort);
  await new Promise((resolve) => appServer.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${appPort}`;

  t.after(async () => {
    await new Promise((resolve) => appServer.close(resolve));
    await new Promise((resolve) => cbrServer.close(resolve));
    await rm(sandbox, { recursive: true, force: true });
  });

  return { ...api, sandbox, workbook, backups, cbrCache, baseUrl, requestedDates, rates };
}

function defineScenarios(context, scenario) {
  const { ensureOperationCapacity, exportMobileBalancesOnce, exportMobileListsOnce, importInboxOnce, synchronizeMobile, startInboxImporter, loadWorkbook, migrateCategoryEmojis, repairTransferRatesOnce, sandbox, workbook, backups, cbrCache, baseUrl, requestedDates, rates } = context;
  const send = (route, body, method = 'POST') => jsonRequest(baseUrl, route, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  scenario('отдаёт интерфейс и структуру всех листов', async () => {
    const page = await fetch(baseUrl);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Финансовый журнал/);
    const { response, payload } = await jsonRequest(baseUrl, '/api/data');
    assert.equal(response.status, 200);
    assert.equal(payload.workbook, 'finance-test.xlsx');
    assert.equal(payload.balances.length, 2);
    assert.ok(payload.lists.categories.some((item) => item.name === 'Продукты'));
    assert.ok(payload.lists.currencies.includes('USD'));
    const balanceSnapshot = JSON.parse(await readFile(path.join(process.env.FINANCE_SYNC_DIR, 'config', 'balances.json'), 'utf8'));
    assert.equal(balanceSnapshot.schema, 1);
    assert.equal(balanceSnapshot.workbook, 'finance-test.xlsx');
    assert.equal(balanceSnapshot.accounts.length, payload.accounts.length);
    assert.deepEqual(balanceSnapshot.accounts.map((account) => account.id), payload.accounts.map((account) => account.id));
    assert.deepEqual(balanceSnapshot.accounts.map((account) => account.balance), payload.accounts.map((account) => account.calculatedBalance));
    assert.equal(balanceSnapshot.totalRub, payload.accounts.reduce((sum, account) => sum + account.rubAmount, 0));
    assert.equal(balanceSnapshot.accounts.some((account) => Object.hasOwn(account, 'type')), false);
    const settings = await jsonRequest(baseUrl, '/api/settings');
    assert.equal(settings.response.status, 200);
    assert.equal(settings.payload.backupLimit, 30);
    assert.equal(settings.payload.syncDirectory, path.join(sandbox, 'default-sync'));
    assert.ok(Array.isArray(settings.payload.backups));
  });

  scenario('обновление не включается в dev-сборке и не принимает установку без упакованного приложения', async () => {
    const check = await jsonRequest(baseUrl, '/api/updates/check');
    assert.equal(check.response.status, 200);
    assert.equal(check.payload.enabled, false);
    assert.equal(check.payload.channel, 'development');
    const install = await send('/api/updates/install', { version: '1.0.1' });
    assert.equal(install.response.status, 409);
    assert.equal(install.payload.code, 'UPDATE_INSTALL_UNAVAILABLE');
    const rollback = await jsonRequest(baseUrl, '/api/updates/rollback', { method: 'POST' });
    assert.equal(rollback.response.status, 409);
    assert.equal(rollback.payload.code, 'ROLLBACK_UNAVAILABLE');
  });

  scenario('создаёт, проверяет и репетирует recovery-архив без записи в рабочую книгу', async () => {
    const originalHash = await sha256(workbook);
    const originalBackups = await readdir(backups);
    const exported = await fetch(`${baseUrl}/api/settings/recovery/export`);
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get('content-type') || '', /application\/zip/u);
    assert.match(exported.headers.get('content-disposition') || '', /attachment; filename=/u);
    const archive = Buffer.from(await exported.arrayBuffer());
    assert.ok(archive.length > 0);
    const verifyResponse = await fetch(`${baseUrl}/api/settings/recovery/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: archive,
    });
    const verified = await verifyResponse.json();
    assert.equal(verifyResponse.status, 200, JSON.stringify(verified));
    assert.equal(verified.valid, true);
    assert.equal(verified.manifest.sha256, originalHash);
    assert.equal(verified.workbookBytes > 0, true);

    const rehearseResponse = await fetch(`${baseUrl}/api/settings/recovery/rehearse`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: archive,
    });
    const rehearsed = await rehearseResponse.json();
    assert.equal(rehearseResponse.status, 200, JSON.stringify(rehearsed));
    assert.equal(rehearsed.rehearsed, true);
    assert.equal(rehearsed.manifest.sha256, originalHash);

    const invalidResponse = await fetch(`${baseUrl}/api/settings/recovery/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from('not a zip'),
    });
    const invalid = await invalidResponse.json();
    assert.equal(invalidResponse.status, 400);
    assert.equal(invalid.code, 'RECOVERY_INVALID');
    assert.equal(await sha256(workbook), originalHash);
    assert.deepEqual(await readdir(backups), originalBackups);
  });

  scenario('добавляет эмодзи существующим категориям один раз', async () => {
    const excel = await loadWorkbook();
    const first = migrateCategoryEmojis(excel);
    await excel.writeFile(workbook);
    assert.equal(typeof first.changed, 'boolean');
    const repeated = migrateCategoryEmojis(await loadWorkbook());
    assert.equal(repeated.changed, false);
    const data = (await jsonRequest(baseUrl, '/api/data')).payload;
    assert.ok(data.lists.categories.every((item) => Object.hasOwn(item, 'emoji')));
    assert.equal(data.lists.categories.find((item) => item.name === 'Продукты').emoji, '🛒');
  });

  scenario('нормализует курс ЦБ с учётом номинала', async () => {
    await jsonRequest(baseUrl, '/api/data');
    const usd = await jsonRequest(baseUrl, '/api/rates?currency=USD&date=2026-10-13');
    assert.equal(usd.response.status, 200);
    assert.equal(usd.payload.rate, 83.9153);
    assert.equal(usd.payload.effectiveDate, '2026-10-12');
    const requestsAfterFirstLookup = requestedDates.length;
    const cachedUsd = await jsonRequest(baseUrl, '/api/rates?currency=USD&date=2026-10-13');
    assert.equal(cachedUsd.payload.rate, usd.payload.rate);
    assert.equal(requestedDates.length, requestsAfterFirstLookup);
    await jsonRequest(baseUrl, '/api/data');
    assert.equal(requestedDates.length, requestsAfterFirstLookup);
    const refreshedUsd = await jsonRequest(baseUrl, '/api/rates?currency=USD&date=2026-10-13&refresh=true');
    assert.equal(refreshedUsd.payload.rate, usd.payload.rate);
    assert.equal(requestedDates.length, requestsAfterFirstLookup + 1);
    const storedCache = JSON.parse(await readFile(cbrCache, 'utf8'));
    assert.equal(storedCache.rates['USD:2026-10-13'].rate, usd.payload.rate);
    const restartedPort = await freePort();
    const { startServer: startReloadedServer } = await import(`../server.js?cache-restart=${Date.now()}`);
    const restartedServer = startReloadedServer(restartedPort);
    await new Promise((resolve) => restartedServer.once('listening', resolve));
    try {
      const callsBeforeRestartRead = requestedDates.length;
      const afterRestart = await jsonRequest(`http://127.0.0.1:${restartedPort}`, '/api/rates?currency=USD&date=2026-10-13');
      assert.equal(afterRestart.payload.rate, usd.payload.rate);
      assert.equal(requestedDates.length, callsBeforeRestartRead);
    } finally {
      await new Promise((resolve) => restartedServer.close(resolve));
    }
    const vnd = await jsonRequest(baseUrl, '/api/rates?currency=VND&date=2026-10-13');
    assert.equal(vnd.payload.rate, 0.00325);
    assert.equal(requestedDates.length, requestsAfterFirstLookup + 1, 'one bulletin caches all currencies');
    const beforeConcurrentMiss = requestedDates.length;
    const concurrentRoute = '/api/rates?currency=USD&date=2026-10-12';
    await Promise.all([jsonRequest(baseUrl, concurrentRoute), jsonRequest(baseUrl, concurrentRoute), jsonRequest(baseUrl, '/api/rates?currency=JPY&date=2026-10-12')]);
    assert.equal(requestedDates.length, beforeConcurrentMiss + 1);
  });

  scenario('мигрирует книгу на счета и настраивает активные счета', async () => {
    const migrated = await jsonRequest(baseUrl, '/api/accounts/migrate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: '2026-10-14' }),
    });
    assert.equal(migrated.response.status, 200);
    assert.equal(migrated.payload.result.changed, true);
    assert.ok(migrated.payload.data.lists.operationTypes.includes('Перевод'));
    const migratedWorkbook = await loadWorkbook(workbook);
    const migratedBalance = migratedWorkbook.getWorksheet('Баланс');
    for (const column of [3, 6, 7, 8, 9, 10, 12]) assert.equal(migratedBalance.getCell(6, column).value, null);
    assert.equal(migratedBalance.getCell(4, 3).value, null);
    assert.equal(migratedBalance.getCell(4, 7).value, null);
    assert.equal(migratedBalance.getCell(4, 12).value, null);
    const repeatedMigration = await jsonRequest(baseUrl, '/api/accounts/migrate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: '2026-10-14' }),
    });
    assert.equal(repeatedMigration.payload.result.changed, false);
    assert.equal(repeatedMigration.payload.backup, null);
    const legacyBalance = migratedWorkbook.getWorksheet('Баланс');
    legacyBalance.getCell(4, 3).value = 'Начальный остаток';
    legacyBalance.getCell(6, 3).value = 191.89;
    legacyBalance.getCell(4, 7).value = 'Дата начала учёта';
    legacyBalance.getCell(6, 7).value = 46000;
    await migratedWorkbook.writeFile(workbook);
    const streamlined = await jsonRequest(baseUrl, '/api/system/migrate-streamlined', { method: 'POST' });
    assert.equal(streamlined.response.status, 200);
    assert.equal(streamlined.payload.result.changed, true);
    const streamlinedWorkbook = await loadWorkbook(workbook);
    const streamlinedBalance = streamlinedWorkbook.getWorksheet('Баланс');
    for (const column of [3, 6, 7, 8, 9, 10, 12]) {
      assert.equal(streamlinedBalance.getCell(6, column).value, null);
      assert.ok(Array.from(streamlinedBalance.document.getElementsByTagNameNS('http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'col'))
        .some((item) => Number(item.getAttribute('min')) <= column && Number(item.getAttribute('max')) >= column && item.getAttribute('hidden') === '1'));
    }
    const repeatedStreamlined = await jsonRequest(baseUrl, '/api/system/migrate-streamlined', { method: 'POST' });
    assert.equal(repeatedStreamlined.payload.result.changed, false);
    assert.equal(repeatedStreamlined.payload.backup, null);
    const saved = await jsonRequest(baseUrl, '/api/accounts', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accounts: [{ id: null, name: 'Наличные', currency: 'RUB', rate: 1 }] }),
    });
    assert.equal(saved.response.status, 200);
    assert.deepEqual(saved.payload.result.created, [5]);
    assert.equal(saved.payload.data.accounts.find((item) => item.id === 5).calculatedBalance, 0);
    assert.equal(saved.payload.mobileLists.changed, true);
  });

  scenario('экспортирует изменения справочников для Syncthing без лишних перезаписей', async () => {
    const syncRoot = path.join(sandbox, 'mobile-lists');
    const first = await exportMobileListsOnce(syncRoot);
    assertContract('lists', first.payload);
    assert.equal(first.changed, true);
    assert.ok(first.payload.lists.currencies.includes('USD'));
    assert.deepEqual(first.payload.lists.operationTypes, ['Доход', 'Расход', 'Перевод']);
    assert.ok(first.payload.lists.accounts.some((account) => account.id === 5 && account.currency === 'RUB' && account.startDate === '0001-01-01'));
    const unchanged = await exportMobileListsOnce(syncRoot);
    assert.equal(unchanged.changed, false);

    const excel = await loadWorkbook();
    excel.getWorksheet('Списки').getCell(10, 4).value = 'JPY';
    await excel.writeFile(workbook);
    const updated = await exportMobileListsOnce(syncRoot);
    assert.equal(updated.changed, true);
    assert.ok(updated.payload.lists.currencies.includes('JPY'));
    const synced = JSON.parse(await readFile(path.join(syncRoot, 'config', 'lists.json'), 'utf8'));
    assert.ok(synced.lists.currencies.includes('JPY'));
  });

  scenario('экспортирует обычные балансы атомарным снимком и не перезаписывает неизменившиеся данные', async () => {
    const syncRoot = path.join(sandbox, 'mobile-balances');
    const first = await exportMobileBalancesOnce(syncRoot);
    assertContract('balances', first.payload);
    assert.equal(first.changed, true);
    assert.equal(first.payload.schema, 1);
    const current = (await jsonRequest(baseUrl, '/api/data')).payload;
    assert.equal(first.payload.accounts.length, current.accounts.length);
    assert.deepEqual(first.payload.accounts.map((account) => account.id), current.accounts.map((account) => account.id));
    assert.deepEqual(first.payload.accounts.map((account) => account.balance), current.accounts.map((account) => account.calculatedBalance));
    assert.ok(first.payload.accounts.every((account) => account.rate > 0));
    assert.equal(first.payload.totalRub, first.payload.accounts.reduce((sum, account) => sum + account.rubAmount, 0));
    assert.deepEqual(first.payload.missingRates, []);
    assert.equal((await readdir(path.join(syncRoot, 'config'))).some((name) => name.endsWith('.tmp')), false);

    const unchanged = await exportMobileBalancesOnce(syncRoot);
    assert.equal(unchanged.changed, false);
    assert.equal(unchanged.payload.generatedAt, first.payload.generatedAt);

    const excel = await loadWorkbook();
    const targetId = first.payload.accounts[0].id;
    excel.getWorksheet('Баланс').getCell(targetId, 1).value = 'Переименованный счёт';
    await excel.writeFile(workbook);
    const updated = await exportMobileBalancesOnce(syncRoot);
    assert.equal(updated.changed, true);
    assert.equal(updated.payload.accounts.find((account) => account.id === targetId).name, 'Переименованный счёт');
  });

  scenario('добавляет и удаляет счёт с немедленным обновлением мобильного списка', async () => {
    const created = await jsonRequest(baseUrl, '/api/accounts', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accounts: [{ id: null, name: 'Тестовый долларовый счёт', currency: 'USD', rate: 83.9153 }] }),
    });
    assert.equal(created.response.status, 200);
    const createdId = created.payload.result.created[0];
    assert.ok(created.payload.data.accounts.some((account) => account.id === createdId));
    assert.ok(created.payload.data.lists.accounts.some((account) => account.id === createdId));
    assert.equal(created.payload.mobileLists.changed, true);

    const removed = await jsonRequest(baseUrl, `/api/accounts/${createdId}`, { method: 'DELETE' });
    assert.equal(removed.response.status, 200);
    assert.ok(!removed.payload.data.accounts.some((account) => account.id === createdId));
    assert.ok(!removed.payload.data.lists.accounts.some((account) => account.id === createdId));
    assert.equal(removed.payload.mobileLists.changed, true);
    const synced = JSON.parse(await readFile(path.join(sandbox, 'default-sync', 'config', 'lists.json'), 'utf8'));
    assert.ok(!synced.lists.accounts.some((account) => account.id === createdId));
  });

  scenario('валидирует и добавляет операцию', async () => {
    const invalid = await jsonRequest(baseUrl, '/api/operations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.equal(invalid.response.status, 400);
    const beforeAccountStart = await jsonRequest(baseUrl, '/api/operations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-09-30', type: 'Расход', category: 'Продукты', amount: 10, currency: 'RUB', rate: 1, accountId: 5, notes: 'Слишком рано' }),
    });
    assert.equal(beforeAccountStart.response.status, 201);

    const created = await jsonRequest(baseUrl, '/api/operations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-10-14', type: 'Расход', category: 'Продукты', amount: 10, currency: 'RUB', rate: 1, accountId: 5, necessity: 'Обязательная', notes: 'API-тест' }),
    });
    assert.equal(created.response.status, 201);
    const operationId = created.payload.result.id;
    const data = (await jsonRequest(baseUrl, '/api/data')).payload;
    const operation = data.operations.find((item) => item.id === operationId);
    assert.equal(operation.notes, 'API-тест');
    assert.equal(operation.rubAmount, 10);
    const balanceSnapshot = JSON.parse(await readFile(path.join(process.env.FINANCE_SYNC_DIR, 'config', 'balances.json'), 'utf8'));
    assert.deepEqual(balanceSnapshot.accounts.map((account) => account.balance), data.accounts.map((account) => account.calculatedBalance));
  });

  scenario('редактирует и удаляет операцию', async () => {
    const created = await send('/api/operations', { date: '2026-10-14', type: 'Расход', category: 'Продукты', amount: 10, currency: 'RUB', accountId: 5 });
    const operationId = created.payload.result.id;
    const changeType = await jsonRequest(baseUrl, `/api/operations/${operationId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-10-14', type: 'Доход', category: 'Работа / зарплата', amount: 1500, currency: 'RUB', rate: 1, accountId: 5, necessity: '', notes: 'Исправленная запись' }),
    });
    assert.equal(changeType.response.status, 400);
    assert.equal(changeType.payload.code, 'OPERATION_TYPE_IMMUTABLE');
    const updated = await jsonRequest(baseUrl, `/api/operations/${operationId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-10-14', type: 'Расход', category: 'Продукты', amount: 15, currency: 'RUB', rate: 1, accountId: 5, necessity: 'Обязательная', notes: 'Исправленная запись' }),
    });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.payload.data.operations.find((item) => item.id === operationId).type, 'Расход');
    assert.equal(updated.payload.data.operations.find((item) => item.id === operationId).amount, 15);
    assert.equal(updated.payload.data.operations.find((item) => item.id === operationId).notes, 'Исправленная запись');
    const removed = await jsonRequest(baseUrl, `/api/operations/${operationId}`, { method: 'DELETE' });
    assert.equal(removed.response.status, 200);
    assert.ok(!removed.payload.data.operations.some((item) => item.id === operationId));
  });

  scenario('считает остаток с нуля по операциям и переводам', async () => {
    const income = await jsonRequest(baseUrl, '/api/operations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-10-13', type: 'Доход', category: 'Работа / зарплата', amount: 500, currency: 'RUB', rate: 1, accountId: 5, notes: 'Пополнение' }),
    });
    assert.equal(income.response.status, 201);
    const transfer = await jsonRequest(baseUrl, '/api/operations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-10-14', type: 'Перевод', amount: 100, currency: 'RUB', rate: 1, accountId: 5, destinationAccountId: 6, destinationAmount: 3, notes: 'Обмен' }),
    });
    assert.equal(transfer.response.status, 201);
    assert.equal(transfer.payload.data.accounts.find((item) => item.id === 5).calculatedBalance, 400);
    assert.equal(transfer.payload.data.accounts.find((item) => item.id === 6).calculatedBalance, 3);
    const futureDate = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    const future = await jsonRequest(baseUrl, '/api/operations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: futureDate, type: 'Доход', category: 'Работа / зарплата', amount: 80, currency: 'RUB', rate: 1, accountId: 5, notes: 'Будущая операция' }),
    });
    assert.equal(future.response.status, 201);
    assert.equal(future.payload.data.accounts.find((item) => item.id === 5).calculatedBalance, 400);
    await jsonRequest(baseUrl, `/api/operations/${future.payload.result.id}`, { method: 'DELETE' });
    const backupFiles = await readdir(backups);
    assert.ok(backupFiles.length === 4);
    assert.ok(backupFiles.every((name) => name.endsWith('.xlsx')));
  });

  scenario('запрещает превращать обычную операцию в инвестицию без записи и бэкапа', async () => {
    const savings = await send('/api/savings/accounts', { name: 'Investment guard', type: 'Вклад', currency: 'RUB', initialCapital: 0 });
    assert.equal(savings.response.status, 201);
    const expense = { date: '2026-10-14', type: 'Расход', category: 'Продукты', amount: 100, currency: 'RUB', rate: 1, accountId: 5, necessity: 'Обязательная' };
    const created = await send('/api/operations', expense);
    assert.equal(created.response.status, 201, JSON.stringify(created.payload));
    const beforeHash = await sha256(workbook);
    const beforeBackups = await readdir(backups);
    const rejected = await send(`/api/operations/${created.payload.result.id}`, { ...expense, type: 'Инвестиция', savingsAccountId: savings.payload.result.id, destinationAmount: 100 }, 'PUT');
    assert.equal(rejected.response.status, 400);
    assert.equal(await sha256(workbook), beforeHash);
    assert.deepEqual(await readdir(backups), beforeBackups);
    const edited = await send(`/api/operations/${created.payload.result.id}`, { notes: 'Still editable' }, 'PUT');
    assert.equal(edited.response.status, 200);
    const deleted = await jsonRequest(baseUrl, `/api/operations/${created.payload.result.id}`, { method: 'DELETE' });
    assert.equal(deleted.response.status, 200);
  });

  scenario('сравнивает RUB → GEL и USD → GEL с результатом обмена по ЦБ', async () => {
    const usd = await send('/api/accounts', { accounts: [{ name: 'USD exchange', currency: 'USD', rate: 83.9153 }] }, 'PUT');
    assert.equal(usd.response.status, 200);
    const savings = await send('/api/savings/accounts', { name: 'GEL exchange', type: 'Вклад', currency: 'GEL', initialCapital: 0 });
    assert.equal(savings.response.status, 201);
    // 100 RUB buys about 3.0994 GEL at CBR; receiving 3 GEL loses 3.2074 RUB.
    // 10 USD buys about 26.0088 GEL at CBR; receiving 27 GEL gains 31.9804 RUB.
    for (const sample of [
      { accountId: 5, currency: 'RUB', amount: 100, destinationAmount: 3, rate: 1, expected: -3.2074 },
      { accountId: usd.payload.result.created[0], currency: 'USD', amount: 10, destinationAmount: 27, rate: 80, expected: 31.9804 },
    ]) {
      for (const type of ['Перевод', 'Инвестиция']) {
        const result = await send('/api/operations', {
          ...sample, date: '2026-10-14', type,
          ...(type === 'Перевод' ? { destinationAccountId: 6 } : { savingsAccountId: savings.payload.result.id }),
        });
        assert.equal(result.response.status, 201, JSON.stringify(result.payload));
        const operation = result.payload.data.operations.find((item) => item.id === result.payload.result.id);
        assert.ok(Math.abs(operation.exchange.rubDifference - sample.expected) < 0.000001);
      }
    }
  });

  scenario('справочный курс ЦБ не блокирует инвестицию при недоступности ЦБ', async () => {
    rates.unavailable = true;
    try {
      const savings = await send('/api/savings/accounts', { name: 'Reference rate unavailable', type: 'Вклад', currency: 'USD', initialCapital: 0 });
      assert.equal(savings.response.status, 201);
      const investment = await send('/api/operations', {
        date: '2019-03-15', type: 'Инвестиция', amount: 10, currency: 'RUB', rate: 1,
        accountId: 5, savingsAccountId: savings.payload.result.id, destinationAmount: 1,
      });
      assert.equal(investment.response.status, 201, JSON.stringify(investment.payload));
      const saved = investment.payload.data.operations.find((item) => item.id === investment.payload.result.id);
      assert.equal(saved.exchange.rubDifference, null);
      assert.deepEqual(saved.exchange.referenceRates.map((rate) => rate.currency), ['RUB']);
    } finally { rates.unavailable = false; }
  });

  scenario('редактирует инвестиции и выводы с атомарным обновлением связанного движения', async () => {
    const initial = (await jsonRequest(baseUrl, '/api/data')).payload;
    const main = initial.accounts.find((item) => item.active && item.currency === 'RUB');
    assert.ok(main);
    const firstSavings = await send('/api/savings/accounts', { name: 'Edit source savings', type: 'Вклад', currency: 'RUB', initialCapital: 100 });
    const secondSavings = await send('/api/savings/accounts', { name: 'Edit destination savings', type: 'Отложенные', currency: 'RUB', initialCapital: 50 });
    assert.equal(firstSavings.response.status, 201);
    assert.equal(secondSavings.response.status, 201);
    const firstSavingsId = firstSavings.payload.result.id;
    const secondSavingsId = secondSavings.payload.result.id;
    const investment = await send('/api/operations', { date: '2026-10-14', type: 'Инвестиция', amount: 10, currency: 'RUB', rate: 1, accountId: main.id, savingsAccountId: firstSavingsId, destinationAmount: 10, notes: 'Первичный взнос' });
    const withdrawal = await send('/api/savings/transfers', { direction: 'from-savings', savingAccountId: firstSavingsId, mainAccountId: main.id, savingAmount: 3, mainAmount: 3, date: '2026-10-14' });
    assert.equal(investment.response.status, 201);
    assert.equal(withdrawal.response.status, 201);

    const beforeRejectedHash = await sha256(workbook);
    const beforeRejectedBackups = await readdir(backups);
    const mismatchedInvestment = await send(`/api/operations/${investment.payload.result.id}`, {
      date: '2026-10-14', type: 'Инвестиция', amount: 11, currency: 'RUB', rate: 1,
      accountId: main.id, savingsAccountId: firstSavingsId, destinationAmount: 10, notes: 'Не должно сохраниться',
    }, 'PUT');
    assert.equal(mismatchedInvestment.response.status, 400);
    const mismatchedWithdrawal = await send(`/api/operations/${withdrawal.payload.result.id}`, {
      date: '2026-10-14', type: 'Перевод', amount: 3, currency: 'RUB', rate: 1,
      accountId: main.id, savingsAccountId: firstSavingsId, destinationAmount: 4, notes: 'Не должно сохраниться',
    }, 'PUT');
    assert.equal(mismatchedWithdrawal.response.status, 400);
    assert.equal(await sha256(workbook), beforeRejectedHash);
    assert.deepEqual(await readdir(backups), beforeRejectedBackups);

    const editedInvestment = await send(`/api/operations/${investment.payload.result.id}`, {
      date: '2026-10-13', type: 'Инвестиция', amount: 20, currency: 'RUB', rate: 1,
      accountId: main.id, savingsAccountId: secondSavingsId, destinationAmount: 20, notes: 'Перенесено на другой вклад',
    }, 'PUT');
    assert.equal(editedInvestment.response.status, 200, JSON.stringify(editedInvestment.payload));
    const editedWithdrawal = await send(`/api/operations/${withdrawal.payload.result.id}`, {
      date: '2026-10-14', type: 'Перевод', amount: 7, currency: 'RUB', rate: 1,
      accountId: main.id, savingsAccountId: firstSavingsId, destinationAmount: 7, notes: 'Исправлен вывод',
    }, 'PUT');
    assert.equal(editedWithdrawal.response.status, 200, JSON.stringify(editedWithdrawal.payload));
    const finalData = editedWithdrawal.payload.data;
    assert.equal(finalData.accounts.find((item) => item.id === main.id).calculatedBalance, main.calculatedBalance - 13);
    assert.equal(finalData.savingsAccounts.find((item) => item.id === firstSavingsId).calculatedBalance, 93);
    assert.equal(finalData.savingsAccounts.find((item) => item.id === secondSavingsId).calculatedBalance, 70);
    const savedInvestment = finalData.operations.find((item) => item.id === investment.payload.result.id);
    const savedWithdrawal = finalData.operations.find((item) => item.id === withdrawal.payload.result.id);
    assert.equal(savedInvestment.type, 'Инвестиция');
    assert.equal(savedInvestment.savingsAccountId, secondSavingsId);
    assert.equal(savedInvestment.savingsAmount, 20);
    assert.equal(savedInvestment.category, 'Отложенные');
    assert.equal(savedWithdrawal.type, 'Перевод');
    assert.equal(savedWithdrawal.savingsAccountId, firstSavingsId);
    assert.equal(savedWithdrawal.amount, 7);
    assert.equal(savedWithdrawal.destinationAmount, 7);
    const updatedWorkbook = await loadWorkbook();
    const movements = updatedWorkbook.getWorksheet('Движение накоплений');
    const linkedMovementRows = (operationId) => Array.from({ length: Math.max(0, movements.rowCount - 1) }, (_item, index) => index + 2)
      .filter((movementRow) => Number(movements.getCell(movementRow, 5).value) === operationId);
    const investmentMovement = linkedMovementRows(investment.payload.result.id);
    const withdrawalMovement = linkedMovementRows(withdrawal.payload.result.id);
    assert.equal(investmentMovement.length, 1);
    assert.equal(withdrawalMovement.length, 1);
    assert.equal(Number(movements.getCell(investmentMovement[0], 1).value), secondSavingsId);
    assert.equal(Number(movements.getCell(investmentMovement[0], 3).value), 20);
    assert.equal(movements.getCell(investmentMovement[0], 4).value, 'Инвестиция');
    assert.equal(Number(movements.getCell(withdrawalMovement[0], 1).value), firstSavingsId);
    assert.equal(Number(movements.getCell(withdrawalMovement[0], 3).value), -7);
    assert.equal(movements.getCell(withdrawalMovement[0], 4).value, 'Перевод');
  });

  scenario('связывает инвестицию и вывод с балансами обоих учётов', async () => {
    const create = await jsonRequest(baseUrl, '/api/savings/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Тестовое накопление', type: 'Отложенные', currency: 'USD', initialCapital: 100 }) });
    assert.equal(create.response.status, 201);
    const savingsId = create.payload.result.id;
    assert.equal(create.payload.data.savingsAccounts.find((item) => item.id === savingsId).initialCapital, 100);
    const increase = await jsonRequest(baseUrl, `/api/savings/accounts/${savingsId}/increase`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: 20, date: '2026-10-14', notes: 'Проценты' }) });
    assert.equal(increase.response.status, 201);
    await jsonRequest(baseUrl, `/api/savings/accounts/${savingsId}/increase`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: -5, date: '2026-10-14' }) });
    const disabledDeposit = await send('/api/savings/transfers', { direction: 'to-savings', savingAccountId: savingsId, mainAccountId: 5, savingAmount: 9.5, mainAmount: 10, date: '2026-10-14' });
    assert.equal(disabledDeposit.response.status, 400);
    const investment = await send('/api/operations', { date: '2026-10-14', type: 'Инвестиция', amount: 10, currency: 'RUB', rate: 1, accountId: 5, savingsAccountId: savingsId, destinationAmount: 9.5, notes: 'Ручной обмен' });
    assert.equal(investment.response.status, 201, JSON.stringify(investment.payload));
    const fromSavings = await send('/api/savings/transfers', { direction: 'from-savings', savingAccountId: savingsId, mainAccountId: 5, savingAmount: 4, mainAmount: 4.25, date: '2026-10-14' });
    assert.equal(fromSavings.response.status, 201);
    const data = (await jsonRequest(baseUrl, '/api/data')).payload;
    const savings = data.savingsAccounts.find((item) => item.id === savingsId);
    assert.equal(savings.initialCapital, 100);
    assert.equal(savings.calculatedBalance, 120.5);
    assert.equal(data.accounts.find((item) => item.id === 5).calculatedBalance, -5.75);
    assert.equal(data.operations.filter((item) => item.savingsTransfer).length, 2);
    const savedInvestment = data.operations.find((item) => item.id === investment.payload.result.id);
    assert.equal(savedInvestment.type, 'Инвестиция');
    assert.equal(savedInvestment.category, 'Отложенные');
    assert.equal(savedInvestment.amount, 10);
    assert.equal(savedInvestment.savingsAmount, 9.5);
    assert.equal(savedInvestment.rate, 1);
    assert.ok(data.lists.operationTypes.includes('Инвестиция'));
    const investmentWorkbook = await loadWorkbook();
    assert.equal(investmentWorkbook.getWorksheet('Списки').getCell(5, 10).value, 'Инвестиция');
    assert.equal(investmentWorkbook.getWorksheet('Списки').getCell(23, 1).value, 'Вклад');
    assert.equal(investmentWorkbook.getWorksheet('Списки').getCell(24, 1).value, 'Отложенные');
    assert.deepEqual(data.lists.investmentCategories, ['Вклад', 'Отложенные']);
    const validationFormulas = Array.from(investmentWorkbook.getWorksheet('Операции').document.getElementsByTagNameNS('http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'formula1')).map((node) => node.textContent);
    assert.ok(validationFormulas.some((formula) => formula.includes('Списки!$J$2:$J$5')));
    assert.ok(validationFormulas.some((formula) => formula.includes('Списки!$A$2:$A$24')));
    const legacyCategoryWorkbook = await loadWorkbook();
    legacyCategoryWorkbook.getWorksheet('Списки').getCell(24, 1).value = 'Накопление';
    legacyCategoryWorkbook.getWorksheet('Операции').getCell(investment.payload.result.id, 3).value = 'Накопление';
    await legacyCategoryWorkbook.writeFile(workbook);
    const migratedCategory = await jsonRequest(baseUrl, '/api/system/migrate-investment-categories', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(migratedCategory.response.status, 200);
    assert.ok(migratedCategory.payload.backup);
    assert.equal(migratedCategory.payload.data.operations.find((item) => item.id === investment.payload.result.id).category, 'Отложенные');
    const migratedCategoryWorkbook = await loadWorkbook();
    assert.equal(migratedCategoryWorkbook.getWorksheet('Списки').getCell(24, 1).value, 'Отложенные');
    assert.equal(migratedCategoryWorkbook.getWorksheet('Операции').getCell(investment.payload.result.id, 3).value, 'Отложенные');
    const savedTransfer = data.operations.find((item) => item.id === fromSavings.payload.result.id);
    assert.equal(savedTransfer.rate, 83.9153);
    assert.equal(savedTransfer.rubAmount, 4 * 83.9153);
    const tamperedWorkbook = await loadWorkbook();
    const tamperedMovements = tamperedWorkbook.getWorksheet('Движение накоплений');
    const transferMovementRow = Array.from({ length: Math.max(0, tamperedMovements.rowCount - 1) }, (_item, index) => index + 2)
      .find((row) => Number(tamperedMovements.getCell(row, 5).value) === fromSavings.payload.result.id);
    assert.ok(transferMovementRow);
    tamperedMovements.getCell(transferMovementRow, 3).value = -5;
    await tamperedWorkbook.writeFile(workbook);
    const beforeRejectedDeleteHash = await sha256(workbook);
    const beforeRejectedDeleteBackups = await readdir(backups);
    const rejectedTransferDelete = await jsonRequest(baseUrl, `/api/operations/${fromSavings.payload.result.id}`, { method: 'DELETE' });
    assert.equal(rejectedTransferDelete.response.status, 409);
    assert.equal(rejectedTransferDelete.payload.code, 'LINKED_MOVEMENT_MISMATCH');
    assert.equal(await sha256(workbook), beforeRejectedDeleteHash);
    assert.deepEqual(await readdir(backups), beforeRejectedDeleteBackups);
    assert.ok((await jsonRequest(baseUrl, '/api/data')).payload.operations.some((item) => item.id === fromSavings.payload.result.id));
    const restoredWorkbook = await loadWorkbook();
    restoredWorkbook.getWorksheet('Движение накоплений').getCell(transferMovementRow, 3).value = -4;
    await restoredWorkbook.writeFile(workbook);
    const deletedTransfer = await jsonRequest(baseUrl, `/api/operations/${fromSavings.payload.result.id}`, { method: 'DELETE' });
    assert.equal(deletedTransfer.response.status, 200, JSON.stringify(deletedTransfer.payload));
    assert.equal(deletedTransfer.payload.data.savingsAccounts.find((item) => item.id === savingsId).calculatedBalance, 124.5);
    assert.equal(deletedTransfer.payload.data.accounts.find((item) => item.id === 5).calculatedBalance, -10);
    assert.ok(!deletedTransfer.payload.data.operations.some((item) => item.id === fromSavings.payload.result.id));
    const workbookAfterTransferDelete = await loadWorkbook();
    const transferMovements = workbookAfterTransferDelete.getWorksheet('Движение накоплений');
    assert.equal(Array.from({ length: Math.max(0, transferMovements.rowCount - 1) }, (_item, index) => index + 2).some((row) => Number(transferMovements.getCell(row, 5).value) === fromSavings.payload.result.id), false);
    const comparison = (await jsonRequest(baseUrl, '/api/balance/currency-comparison?ledger=savings')).payload;
    assert.equal(comparison.currencies.find((item) => item.currency === 'USD').amount, 124.5);
    const mobileLists = await exportMobileListsOnce(path.join(sandbox, 'mobile-no-investments'));
    assert.deepEqual(mobileLists.payload.lists.operationTypes, ['Доход', 'Расход', 'Перевод']);
    assert.equal(Object.hasOwn(mobileLists.payload.lists, 'investmentCategories'), false);
    assert.ok(!mobileLists.payload.lists.categories.some((category) => ['Вклад', 'Отложенные'].includes(category.name)));
    const deletedInvestment = await jsonRequest(baseUrl, `/api/operations/${investment.payload.result.id}`, { method: 'DELETE' });
    assert.equal(deletedInvestment.response.status, 200);
    assert.equal(deletedInvestment.payload.data.savingsAccounts.find((item) => item.id === savingsId).calculatedBalance, 115);
    assert.equal(deletedInvestment.payload.data.accounts.find((item) => item.id === 5).calculatedBalance, 0);
    assert.ok(!deletedInvestment.payload.data.operations.some((item) => item.id === investment.payload.result.id));
    const workbookAfterDelete = await loadWorkbook();
    const movementSheet = workbookAfterDelete.getWorksheet('Движение накоплений');
    assert.equal(Array.from({ length: Math.max(0, movementSheet.rowCount - 1) }, (_item, index) => index + 2).some((row) => Number(movementSheet.getCell(row, 5).value) === investment.payload.result.id), false);
    const blockedDelete = await jsonRequest(baseUrl, `/api/savings/accounts/${savingsId}`, { method: 'DELETE' });
    assert.equal(blockedDelete.response.status, 400);
  });

  scenario('импортирует Syncthing-файл ровно один раз и пишет квитанцию', async () => {
    const syncRoot = path.join(sandbox, 'mobile-sync');
    await exportMobileBalancesOnce(syncRoot);
    const balancesPath = path.join(syncRoot, 'config', 'balances.json');
    const beforeBalances = JSON.parse(await readFile(balancesPath, 'utf8'));
    const account = beforeBalances.accounts[0];
    const accountId = account.id;
    const incoming = path.join(syncRoot, 'incoming');
    await mkdir(incoming, { recursive: true });
    const event = {
      schema: 1,
      id: 'owner-phone-20261013-a81f2c',
      author: 'owner',
      createdAt: '2026-10-13T14:23:55+03:00',
      operation: { date: '2026-10-14', type: 'Доход', category: 'Работа / зарплата', amount: 100, currency: account.currency, accountId, notes: 'Syncthing-тест' },
    };
    const sourceFile = path.join(incoming, `${event.id}.json`);
    await writeFile(sourceFile, JSON.stringify(event), 'utf8');
    const first = await importInboxOnce(syncRoot);
    assert.equal(first[0].status, 'imported');
    assert.equal(first[0].duplicate, false);
    assert.equal(first[0].sourceDeleted, true);
    const afterBalances = JSON.parse(await readFile(balancesPath, 'utf8'));
    assert.equal(afterBalances.accounts.find((account) => account.id === accountId).balance, beforeBalances.accounts.find((account) => account.id === accountId).balance + 100);
    await assert.rejects(readFile(sourceFile));

    await writeFile(sourceFile, JSON.stringify(event), 'utf8');
    const repeated = await importInboxOnce(syncRoot);
    assert.equal(repeated[0].duplicate, true);
    assert.equal(repeated[0].sourceDeleted, true);
    await assert.rejects(readFile(sourceFile));
    const data = (await jsonRequest(baseUrl, '/api/data')).payload;
    assert.equal(data.operations.filter((item) => item.sourceId === event.id).length, 1);
    const receipt = JSON.parse(await readFile(path.join(syncRoot, 'receipts', `${event.id}.json`), 'utf8'));
    assertContract('receipt', receipt);
    assert.equal(receipt.status, 'imported');
    assert.equal(receipt.duplicate, true);
    assert.equal(receipt.sourceDeleted, true);
    assert.ok((await readdir(backups)).length === 1);
  });

  scenario('кнопка выполняет полный цикл, сохраняет ошибочные файлы и безопасно повторяет импорт', async () => {
    const root = process.env.FINANCE_SYNC_DIR;
    const before = (await jsonRequest(baseUrl, '/api/data')).payload;
    const account = before.accounts[0];
    const event = { schema: 1, id: 'full-sync-button-event', author: 'owner', createdAt: new Date().toISOString(), operation: { date: '2026-10-14', type: 'Доход', category: 'Работа / зарплата', amount: 13, currency: account.currency, accountId: account.id } };
    const source = path.join(root, 'incoming', `${event.id}.json`);
    const invalid = path.join(root, 'incoming', 'invalid-sync-event.json');
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, JSON.stringify(event));
    await writeFile(invalid, '{}');
    const { payload } = await jsonRequest(baseUrl, '/api/settings/export-mobile', { method: 'POST' });
    assert.equal(payload.imported, 1);
    assert.equal(payload.errors, 1);
    assert.equal(payload.ok, false);
    assert.equal(payload.balancesChanged, true);
    await assert.rejects(readFile(source));
    assert.equal(await readFile(invalid, 'utf8'), '{}');
    const snapshot = JSON.parse(await readFile(path.join(root, 'config', 'balances.json'), 'utf8'));
    assert.equal(snapshot.accounts.find((item) => item.id === account.id).balance, account.calculatedBalance + 13);
    const backupsBefore = await readdir(backups);
    await writeFile(source, JSON.stringify(event));
    const repeated = await synchronizeMobile();
    assert.equal(repeated.duplicates, 1);
    assert.deepEqual(await readdir(backups), backupsBefore);
    await rm(invalid);
  });

  scenario('ошибка удаления и публикации не отменяет импорт; повтор завершает цикл', async (t) => {
    const root = path.join(sandbox, 'sync-failure');
    const account = (await jsonRequest(baseUrl, '/api/data')).payload.accounts[0];
    const event = { schema: 1, id: 'sync-cleanup-retry-event', author: 'owner', createdAt: new Date().toISOString(), operation: { date: '2026-10-14', type: 'Доход', category: 'Работа / зарплата', amount: 7, currency: account.currency, accountId: account.id } };
    const source = path.join(root, 'incoming', `${event.id}.json`);
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, JSON.stringify(event));
    const unlinkOriginal = fsPromises.unlink;
    const renameOriginal = fsPromises.rename;
    t.mock.method(fsPromises, 'unlink', async (file) => {
      if (file === source) throw new Error('Simulated locked source');
      return unlinkOriginal(file);
    });
    t.mock.method(fsPromises, 'rename', async (from, to) => {
      if (to === path.join(root, 'config', 'balances.json')) throw new Error('Simulated publication failure');
      return renameOriginal(from, to);
    });
    syncBuiltinESMExports();
    try {
      const result = await synchronizeMobile(root);
      assert.equal(result.imported, 1);
      assert.equal(result.cleanupPending, 1);
      assert.equal(result.ok, false);
      assert.ok(result.warnings.some((message) => message.includes('Внутренняя ошибка')));
      assert.ok(result.warnings.every((message) => !message.includes('Simulated publication failure')));
      assert.equal(JSON.parse(await readFile(source, 'utf8')).id, event.id);
      assert.equal(JSON.parse(await readFile(path.join(root, 'receipts', `${event.id}.json`), 'utf8')).status, 'imported');
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    const backupsBefore = await readdir(backups);
    const retry = await synchronizeMobile(root);
    assert.equal(retry.duplicates, 1);
    assert.equal(retry.cleanupPending, 0);
    assert.equal(retry.ok, true);
    assert.equal(retry.balancesChanged, true);
    assert.deepEqual(await readdir(backups), backupsBefore);
    await assert.rejects(readFile(source));
  });

  scenario('сбой квитанции удерживает JSON, а сбой её метаданных сохраняет подтверждение успеха', async (t) => {
    const root = path.join(sandbox, 'sync-receipt-failure');
    const account = (await jsonRequest(baseUrl, '/api/data')).payload.accounts[0];
    const event = { schema: 1, id: 'sync-receipt-failure-event', author: 'owner', createdAt: new Date().toISOString(), operation: { date: '2026-10-14', type: 'Доход', category: 'Работа / зарплата', amount: 3, currency: account.currency, accountId: account.id } };
    const source = path.join(root, 'incoming', `${event.id}.json`);
    const receiptPath = path.join(root, 'receipts', `${event.id}.json`);
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, JSON.stringify(event));
    const original = fsPromises.rename;
    let failAll = true, writes = 0;
    t.mock.method(fsPromises, 'rename', async (from, to) => {
      if (to === receiptPath && (failAll || ++writes === 2)) throw new Error('Simulated receipt failure');
      return original(from, to);
    });
    syncBuiltinESMExports();
    try {
      const failed = await synchronizeMobile(root);
      assert.equal(failed.errors, 1);
      assert.equal(JSON.parse(await readFile(source, 'utf8')).id, event.id);
      const backupsBefore = await readdir(backups);
      failAll = false;
      const retried = await synchronizeMobile(root);
      assert.equal(retried.duplicates, 1);
      assert.equal(retried.errors, 0);
      assert.ok(retried.warnings.length);
      await assert.rejects(readFile(source));
      assert.equal(JSON.parse(await readFile(receiptPath, 'utf8')).status, 'imported');
      assert.deepEqual(await readdir(backups), backupsBefore);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  });

  scenario('устаревший параллельный запрос данных не перезаписывает новый мобильный баланс', async (t) => {
    const account = (await jsonRequest(baseUrl, '/api/data')).payload.accounts[0];
    const original = fsPromises.readFile;
    let entered, release, held = false;
    const reading = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    t.mock.method(fsPromises, 'readFile', async (...args) => {
      const value = await original(...args);
      if (args[0] === workbook && !held) { held = true; entered(); await gate; }
      return value;
    });
    syncBuiltinESMExports();
    let staleRequest;
    try {
      staleRequest = jsonRequest(baseUrl, '/api/data');
      await reading;
      const created = await jsonRequest(baseUrl, '/api/operations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: '2026-10-14', type: 'Доход', category: 'Работа / зарплата', amount: 5, currency: account.currency, rate: 1, accountId: account.id }) });
      assert.equal(created.response.status, 201);
      release();
      await staleRequest;
      const snapshot = JSON.parse(await readFile(path.join(process.env.FINANCE_SYNC_DIR, 'config', 'balances.json'), 'utf8'));
      assert.equal(snapshot.accounts.find((item) => item.id === account.id).balance, account.calculatedBalance + 5);
    } finally { release(); await staleRequest; t.mock.restoreAll(); syncBuiltinESMExports(); }
  });

  scenario('запрос во время цикла дожидается нового прохода и одного итогового снимка за проход', async (t) => {
    const root = path.join(sandbox, 'sync-concurrent');
    const account = (await jsonRequest(baseUrl, '/api/data')).payload.accounts[0];
    const makeEvent = (id) => ({ schema: 1, id, author: 'owner', createdAt: new Date().toISOString(), operation: { date: '2026-10-14', type: 'Доход', category: 'Работа / зарплата', amount: 2, currency: account.currency, accountId: account.id } });
    const firstPath = path.join(root, 'incoming', 'sync-concurrent-first.json');
    await mkdir(path.dirname(firstPath), { recursive: true });
    await writeFile(firstPath, JSON.stringify(makeEvent('sync-concurrent-first')));
    let release, entered;
    const gate = new Promise((resolve) => { release = resolve; });
    const reading = new Promise((resolve) => { entered = resolve; });
    const originalRead = fsPromises.readFile;
    const originalRename = fsPromises.rename;
    let held = false, publications = 0;
    t.mock.method(fsPromises, 'readFile', async (...args) => {
      if (args[0] === firstPath && !held) { held = true; entered(); await gate; }
      return originalRead(...args);
    });
    t.mock.method(fsPromises, 'rename', async (from, to) => {
      if (to === path.join(root, 'config', 'balances.json')) {
        publications += 1;
        await assert.rejects(originalRead(firstPath));
      }
      return originalRename(from, to);
    });
    syncBuiltinESMExports();
    try {
      const first = synchronizeMobile(root);
      await reading;
      await writeFile(path.join(root, 'incoming', 'sync-concurrent-second.json'), JSON.stringify(makeEvent('sync-concurrent-second')));
      const second = synchronizeMobile(root);
      assert.equal(first, second);
      release();
      const result = await second;
      assert.equal(result.passes, 2);
      assert.equal(result.imported, 2);
      assert.equal(publications, 2);
      assert.deepEqual(await readdir(path.join(root, 'incoming')), []);
    } finally { release(); t.mock.restoreAll(); syncBuiltinESMExports(); }
  });

  scenario('наблюдатель принимает переименованный JSON до страховочного таймера', async () => {
    const root = path.join(sandbox, 'sync-watcher');
    const stop = startInboxImporter(root, 60000);
    const waitFor = async (condition) => {
      const deadline = Date.now() + 10000;
      while (!(await condition())) {
        if (Date.now() > deadline) throw new Error('Watcher timeout');
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    };
    try {
      await waitFor(() => readFile(path.join(root, 'config', 'balances.json')).then(() => true, () => false));
      await synchronizeMobile(root);
      const account = (await jsonRequest(baseUrl, '/api/data')).payload.accounts[0];
      const event = { schema: 1, id: 'sync-watcher-ready-event', author: 'owner', createdAt: new Date().toISOString(), operation: { date: '2026-10-14', type: 'Доход', category: 'Работа / зарплата', amount: 1, currency: account.currency, accountId: account.id } };
      const pending = path.join(root, 'incoming', `${event.id}.pending`);
      await writeFile(pending, JSON.stringify(event));
      await new Promise((resolve) => setTimeout(resolve, 300));
      await assert.rejects(readFile(path.join(root, 'receipts', `${event.id}.json`)));
      const source = pending.replace('.pending', '.json');
      await fsPromises.rename(pending, source);
      await waitFor(() => readFile(source).then(() => false, () => true));
      assert.equal(JSON.parse(await readFile(path.join(root, 'receipts', `${event.id}.json`), 'utf8')).status, 'imported');
    } finally { stop(); await synchronizeMobile(root); }
  });

  scenario('сохраняет исторический курс мобильного перевода и не запрашивает его повторно', async () => {
    const syncRoot = path.join(sandbox, 'mobile-transfer');
    const incoming = path.join(syncRoot, 'incoming');
    await mkdir(incoming, { recursive: true });
    const event = { schema: 1, id: 'phone-transfer-rate', author: 'owner', createdAt: '2026-10-14T12:00:00+03:00',
      operation: { date: '2026-10-14', type: 'Перевод', amount: 1, currency: 'GEL', accountId: 6, destinationAccountId: 5, destinationAmount: 30 } };
    const file = path.join(incoming, `${event.id}.json`);
    await writeFile(file, JSON.stringify(event));
    assert.equal((await importInboxOnce(syncRoot))[0].status, 'imported');
    await assert.rejects(readFile(file));
    const data = (await jsonRequest(baseUrl, '/api/data')).payload;
    const operation = data.operations.find((item) => item.sourceId === event.id);
    assert.equal(operation.rate, 32.2642);
    assert.equal(operation.rubAmount, 32.2642);
    const before = requestedDates.length;
    const backupsBefore = await readdir(backups);
    await writeFile(file, JSON.stringify(event));
    assert.equal((await importInboxOnce(syncRoot))[0].duplicate, true);
    assert.equal(requestedDates.length, before);
    assert.deepEqual(await readdir(backups), backupsBefore);
    await assert.rejects(readFile(file));
    const edited = await jsonRequest(baseUrl, `/api/operations/${operation.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...operation, notes: 'Только заметка' }) });
    assert.equal(edited.payload.data.operations.find((item) => item.id === operation.id).rate, operation.rate);
    assert.equal(requestedDates.length, before);
    await jsonRequest(baseUrl, `/api/operations/${operation.id}`, { method: 'DELETE' });
  });

  scenario('исправляет старые курсы переводов с бэкапом, не меняя остатки счетов', async () => {
    const saving = await send('/api/savings/accounts', { name: 'Legacy transfer', type: 'Вклад', currency: 'USD', initialCapital: 100 });
    await send('/api/savings/transfers', { direction: 'from-savings', savingAccountId: saving.payload.result.id, mainAccountId: 5, savingAmount: 4, mainAmount: 4, date: '2026-10-14' });
    const original = (await jsonRequest(baseUrl, '/api/data')).payload;
    const transfer = original.operations.find((item) => item.savingsTransfer === 'from-savings');
    const fixture = await loadWorkbook();
    fixture.getWorksheet('Операции').getCell(transfer.id, 7).value = 1;
    await fixture.writeFile(workbook);
    const repaired = await repairTransferRatesOnce();
    assert.equal(repaired.result.repaired, 1);
    assert.ok(repaired.backup);
    assert.equal(repaired.data.operations.find((item) => item.id === transfer.id).rate, 83.9153);
    assert.deepEqual(repaired.data.accounts.map((item) => item.calculatedBalance), original.accounts.map((item) => item.calculatedBalance));
    assert.deepEqual(repaired.data.savingsAccounts.map((item) => item.calculatedBalance), original.savingsAccounts.map((item) => item.calculatedBalance));
    const requestsBefore = requestedDates.length;
    const repeated = await repairTransferRatesOnce();
    assert.equal(repeated.result.repaired, 0);
    assert.equal(repeated.backup, null);
    assert.equal(requestedDates.length, requestsBefore);
  });

  scenario('оставляет ошибочный входной файл для повторной обработки', async () => {
    const syncRoot = path.join(sandbox, 'mobile-sync-errors');
    const incoming = path.join(syncRoot, 'incoming');
    await mkdir(incoming, { recursive: true });
    const sourceFile = path.join(incoming, 'broken-event.json');
    await writeFile(sourceFile, '{"schema":1}', 'utf8');
    const result = await importInboxOnce(syncRoot);
    assert.equal(result[0].status, 'error');
    assert.equal(await readFile(sourceFile, 'utf8'), '{"schema":1}');
  });

  scenario('редактирует справочники, диапазоны Excel и мобильный экспорт', async () => {
    const invalid = await jsonRequest(baseUrl, '/api/lists', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ categories: [{ name: 'Только расход', type: 'Расход' }], currencies: ['USD'], paymentMethods: ['Карта'], necessities: ['Важно'] }),
    });
    assert.equal(invalid.response.status, 400);
    const unknownCurrency = await jsonRequest(baseUrl, '/api/lists', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        categories: [{ name: 'Продукты', type: 'Расход', emoji: '🛒' }, { name: 'Работа / зарплата', type: 'Доход', emoji: '💼' }],
        currencies: ['RUB', 'USD', 'GEL', 'ZZZ'], paymentMethods: ['Карта'], necessities: ['Важно'],
      }),
    });
    assert.equal(unknownCurrency.response.status, 400);
    assert.equal(unknownCurrency.payload.error, 'Валюта «ZZZ» отсутствует в справочнике ЦБ РФ.');
    assert.ok((await readdir(backups)).length === 0);
    const originalData = (await jsonRequest(baseUrl, '/api/data')).payload;
    const updated = await jsonRequest(baseUrl, '/api/lists', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        categories: [
          { name: 'Работа / зарплата', type: 'Доход', emoji: '💼' },
          { name: 'Новая категория', type: 'Расход', emoji: '🧪' },
          { name: 'Продукты', type: 'Расход', emoji: '🛒' },
        ],
        currencies: ['RUB', 'GEL', 'USD', 'JPY'],
        paymentMethods: ['Наличные', 'Банковская карта', 'QR-код'],
        necessities: ['Гибкая', 'Обязательная'],
      }),
    });
    assert.equal(updated.response.status, 200);
    assert.ok(updated.payload.data.lists.categories.some((item) => item.name === 'Новая категория'));
    assert.equal(updated.payload.data.lists.categories.find((item) => item.name === 'Новая категория').emoji, '🧪');
    assert.deepEqual(updated.payload.data.lists.categories.slice(0, 3).map((item) => item.name), ['Работа / зарплата', 'Новая категория', 'Продукты']);
    assert.deepEqual(updated.payload.data.lists.currencies, ['RUB', 'GEL', 'USD', 'JPY']);
    assert.deepEqual(updated.payload.data.lists.necessities, ['Гибкая', 'Обязательная']);
    assert.deepEqual(updated.payload.data.operations, originalData.operations);
    assert.ok((await readdir(backups)).length === 1);

    const synced = JSON.parse(await readFile(path.join(sandbox, 'default-sync', 'config', 'lists.json'), 'utf8'));
    assert.equal(synced.lists.paymentMethods, undefined);
    assert.equal(synced.lists.categories.find((item) => item.name === 'Новая категория').emoji, '🧪');
    assert.deepEqual(synced.lists.categories.map((item) => item.name), ['Работа / зарплата', 'Новая категория', 'Продукты']);
    assert.deepEqual(synced.lists.currencies, ['RUB', 'GEL', 'USD', 'JPY']);
    assert.deepEqual(synced.lists.necessities, ['Гибкая', 'Обязательная']);
    const excel = await loadWorkbook();
    const listSheet = excel.getWorksheet('Списки');
    assert.deepEqual([2, 3, 4].map((row) => listSheet.getCell(row, 1).value), ['Работа / зарплата', 'Новая категория', 'Продукты']);
    assert.deepEqual([2, 3, 4, 5].map((row) => listSheet.getCell(row, 4).value), ['RUB', 'GEL', 'USD', 'JPY']);
    assert.deepEqual([2, 3].map((row) => listSheet.getCell(row, 8).value), ['Гибкая', 'Обязательная']);
    const formulaRanges = Array.from(excel.getWorksheet('Операции').document.getElementsByTagNameNS('http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'formula1')).map((node) => node.textContent);
    assert.ok(formulaRanges.some((value) => value.includes('$A$2:$A$6')));
    assert.ok(formulaRanges.some((value) => value.includes('$D$2:$D$5')));
    assert.ok(formulaRanges.some((value) => value.includes('$F$2:$F$4')));
  });

  scenario('audit: заполненный лист расширяется пустыми строками без копирования денег', async () => {
    const excel = await loadWorkbook();
    const sheet = excel.getWorksheet('Операции');
    const end = sheet.rowCount;
    for (let row = 5; row <= end; row += 1) {
      sheet.getCell(row, 2).value = 'Доход';
      sheet.getCell(row, 5).value = 17;
      sheet.getCell(row, 12).value = `event-${row}`;
    }
    sheet.getCell(end, 12).value = { formula: '"event-formula"', result: 'event-formula' };
    const result = ensureOperationCapacity(excel);
    assert.equal(result.added, 100);
    assert.equal(result.available, 100);
    for (let row = end + 1; row <= result.endRow; row += 1) {
      for (const col of [1,2,3,4,5,6,7,9,10,11,12,13,14,15,16,17,18]) assert.ok(!sheet.getCell(row, col).value);
    }
    assert.equal(sheet.getCell(end, 5).value, 17);
  });

  scenario('audit: фикстура очищает скрытые поля и оба учёта', async () => {
    const excel = await loadWorkbook();
    for (const col of [16,17,18]) excel.getWorksheet('Операции').getCell(5, col).value = 'sentinel';
    for (const col of [13,14]) excel.getWorksheet('Баланс').getCell(5, col).value = 'sentinel';
    excel.getWorksheet('Баланс').getCell(1, 14).value = 'sentinel';
    resetFinancialRows(excel, null);
    for (const col of [16,17,18]) assert.ok(!excel.getWorksheet('Операции').getCell(5, col).value);
    for (const col of [13,14]) assert.ok(!excel.getWorksheet('Баланс').getCell(5, col).value);
    assert.ok(!excel.getWorksheet('Баланс').getCell(1, 14).value);
    for (const name of ['Накопления', 'Движение накоплений', 'Начальные балансы']) {
      const sheet = excel.getWorksheet(name);
      if (sheet) for (let row = 2; row <= sheet.rowCount; row += 1) for (let col = 1; col <= 8; col += 1) assert.ok(!sheet.getCell(row, col).value);
    }
  });

  scenario('audit: инвестиция и вывод требуют равные суммы в одной валюте', async () => {
    const data = (await jsonRequest(baseUrl, '/api/data')).payload;
    const main = data.accounts[0];
    const created = await jsonRequest(baseUrl, '/api/savings/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Audit same currency', type: 'Вклад', currency: main.currency, initialCapital: 0 }) });
    assert.equal(created.response.status, 201);
    const id = created.payload.result.id;
    const beforeHash = await sha256(workbook);
    const beforeBackups = await readdir(backups);
    const investmentMismatch = await send('/api/operations', { date: '2026-10-14', type: 'Инвестиция', amount: 100, currency: main.currency, rate: main.currency === 'RUB' ? 1 : main.rate, accountId: main.id, savingsAccountId: id, destinationAmount: 200 });
    assert.equal(investmentMismatch.response.status, 400);
    const disabledDeposit = await send('/api/savings/transfers', { direction: 'to-savings', savingAccountId: id, mainAccountId: main.id, mainAmount: 100, savingAmount: 200, date: '2026-10-14' });
    assert.equal(disabledDeposit.response.status, 400);
    const withdrawalMismatch = await send('/api/savings/transfers', { direction: 'from-savings', savingAccountId: id, mainAccountId: main.id, mainAmount: 200, savingAmount: 100, date: '2026-10-14' });
    assert.equal(withdrawalMismatch.response.status, 400);
    const excessPrecision = await send('/api/operations', { date: '2026-10-14', type: 'Инвестиция', amount: 0.0000001, currency: main.currency, rate: main.currency === 'RUB' ? 1 : main.rate, accountId: main.id, savingsAccountId: id, destinationAmount: 0.0000001 });
    assert.equal(excessPrecision.response.status, 400);
    assert.equal(await sha256(workbook), beforeHash);
    assert.deepEqual(await readdir(backups), beforeBackups);
    const investment = await send('/api/operations', { date: '2026-10-14', type: 'Инвестиция', amount: 12.34, currency: main.currency, rate: main.currency === 'RUB' ? 1 : main.rate, accountId: main.id, savingsAccountId: id, destinationAmount: 12.34 });
    assert.equal(investment.response.status, 201);
    assert.equal(investment.payload.data.accounts.find((item) => item.id === main.id).calculatedBalance, main.calculatedBalance - 12.34);
    assert.equal(investment.payload.data.savingsAccounts.find((item) => item.id === id).calculatedBalance, 12.34);
    const deleted = await jsonRequest(baseUrl, `/api/operations/${investment.payload.result.id}`, { method: 'DELETE' });
    assert.equal(deleted.response.status, 200);
    assert.equal(deleted.payload.data.accounts.find((item) => item.id === main.id).calculatedBalance, main.calculatedBalance);
    assert.equal(deleted.payload.data.savingsAccounts.find((item) => item.id === id).calculatedBalance, 0);
    await send(`/api/savings/accounts/${id}/increase`, { amount: 0.1, date: '2026-10-14' });
    const withdrawal = await send('/api/savings/transfers', { direction: 'from-savings', savingAccountId: id, mainAccountId: main.id, savingAmount: 0.1, mainAmount: 0.1, date: '2026-10-14' });
    assert.equal(withdrawal.response.status, 201);
    assert.equal(withdrawal.payload.data.savingsAccounts.find((item) => item.id === id).calculatedBalance, 0);
    assert.equal(withdrawal.payload.data.accounts.find((item) => item.id === main.id).calculatedBalance, main.calculatedBalance + 0.1);
  });

  scenario('добавляет 100 строк и расширяет связанные диапазоны при остатке менее 100', async () => {
    const excel = await loadWorkbook();
    const operations = excel.getWorksheet('Операции');
    const previousEndRow = operations.rowCount;
    for (let row = 5; row <= previousEndRow - 99; row += 1) {
      operations.getCell(row, 2).value = 'Расход';
      operations.getCell(row, 5).value = 1;
      operations.getCell(row, 6).value = 'RUB';
    }

    const capacity = ensureOperationCapacity(excel);
    assert.equal(capacity.expanded, true);
    assert.equal(capacity.previousEndRow, previousEndRow);
    assert.equal(capacity.endRow, previousEndRow + 100);
    assert.equal(capacity.added, 100);
    assert.equal(capacity.available, 199);
    assert.match(operations.cells.get(`H${capacity.endRow}`).getElementsByTagNameNS('http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'f')[0].textContent, new RegExp(`E${capacity.endRow}`));

    const validationRanges = Array.from(operations.document.getElementsByTagNameNS('http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'dataValidation')).map((node) => node.getAttribute('sqref'));
    assert.ok(validationRanges.some((range) => range.endsWith(`:B${capacity.endRow}`)));
    const summary = excel.getWorksheet('Сводка');
    const summaryFormulas = Array.from(summary.document.getElementsByTagNameNS('http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'f')).map((node) => node.textContent).join('\n');
    assert.match(summaryFormulas, new RegExp(`\\$${capacity.endRow}\\b`));
    assert.doesNotMatch(summaryFormulas, new RegExp(`\\$${previousEndRow}\\b`));
    const tableReferences = [...excel.extraDocuments.values()].flatMap((document) => Array.from(document.getElementsByTagName('*')).map((node) => node.getAttribute?.('ref')).filter(Boolean));
    assert.ok(tableReferences.includes(`A4:K${capacity.endRow}`));

    await excel.writeFile(workbook);
    const data = (await jsonRequest(baseUrl, '/api/data')).payload;
    assert.equal(data.operationCapacity.endRow, capacity.endRow);
    assert.equal(data.operationCapacity.available, 199);
  });

  scenario('открывает только разрешённые папки и безопасно восстанавливает бэкап', async () => {
    for (const target of ['workbook', 'backups', 'sync']) {
      const opened = await jsonRequest(baseUrl, '/api/settings/open-folder', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target }),
      });
      assert.equal(opened.response.status, 200);
      assert.equal(opened.payload.opened, true);
      assert.equal(path.isAbsolute(opened.payload.path), true);
    }
    const forbidden = await jsonRequest(baseUrl, '/api/settings/open-folder', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: '../' }),
    });
    assert.equal(forbidden.response.status, 400);

    await send('/api/operations', { date: '2026-10-14', type: 'Доход', category: 'Работа / зарплата', amount: 10, currency: 'RUB', accountId: 5 });
    const settings = await jsonRequest(baseUrl, '/api/settings');
    assert.ok(settings.payload.backups.length > 0);
    const backup = settings.payload.backups[0].name;
    const escaped = await jsonRequest(baseUrl, '/api/settings/restore-backup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ backup: `../${backup}` }),
    });
    assert.equal(escaped.response.status, 400);
    const restored = await jsonRequest(baseUrl, '/api/settings/restore-backup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ backup }),
    });
    assert.equal(restored.response.status, 200);
    assert.equal(restored.payload.result.restored, backup);
    assert.match(restored.payload.result.safetyBackup, /_before_restore_/);
    assert.ok((await readdir(backups)).includes(restored.payload.result.safetyBackup));
    assert.equal(restored.payload.result.data.workbook, 'finance-test.xlsx');
  });

  scenario('сортировка, сравнение курсов и подтверждённая очистка', async () => {
    const send = (route, body, method = 'POST') => jsonRequest(baseUrl, route, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let data = (await jsonRequest(baseUrl, '/api/data')).payload;
    const ids = data.accounts.map((account) => account.id).reverse();
    assert.equal((await send('/api/accounts/order', { ids }, 'PUT')).response.status, 200);
    assert.deepEqual((await jsonRequest(baseUrl, '/api/data')).payload.accounts.map((account) => account.id), ids);
    assert.deepEqual(JSON.parse(await readFile(path.join(process.env.FINANCE_SYNC_DIR, 'config/lists.json'), 'utf8')).lists.accounts.map((account) => account.id), ids);
    assert.equal((await send('/api/accounts/order', { ids: [...ids, ids[0]] }, 'PUT')).response.status, 400);
    const comparison = (await jsonRequest(baseUrl, '/api/balance/currency-comparison')).payload;
    assert.match(comparison.firstDay, /-01$/);
    assert.equal(comparison.total.difference, 0);
    assert.ok(comparison.usdRate > 0);
    assert.equal(comparison.usdTotal, comparison.currentRubTotal / comparison.usdRate);
    assert.equal(comparison.currencies.length, new Set(data.accounts.map((account) => account.currency)).size);
    const beforeBothLedgers = requestedDates.length;
    await jsonRequest(baseUrl, '/api/balance/currency-comparison?refresh=true');
    await jsonRequest(baseUrl, '/api/balance/currency-comparison?ledger=savings');
    assert.equal(requestedDates.length - beforeBothLedgers, 2, 'refreshing both ledgers downloads only two daily bulletins');
    rates.firstDayUnavailable = true;
    const callsBeforeRefresh = requestedDates.length;
    const currentOnlyComparison = (await jsonRequest(baseUrl, '/api/balance/currency-comparison?refresh=true')).payload;
    assert.equal(requestedDates.length - callsBeforeRefresh, 2, 'one bulletin per date, without repeated current-rate requests');
    rates.firstDayUnavailable = false;
    assert.equal(currentOnlyComparison.total, null);
    assert.ok(currentOnlyComparison.usdRate > 0);
    assert.ok(Number.isFinite(currentOnlyComparison.usdTotal));
    assert.ok(Number.isFinite(currentOnlyComparison.currentRubTotal));
    const snapshot = (await jsonRequest(baseUrl, '/api/data')).payload;
    assert.equal(snapshot.currentRates.USD, currentOnlyComparison.usdRate);
    assert.equal(snapshot.accounts.reduce((sum, account) => sum + account.rubAmount, 0), currentOnlyComparison.currentRubTotal);
    const callsBeforeCachedRead = requestedDates.length;
    await jsonRequest(baseUrl, '/api/data');
    assert.equal(requestedDates.length, callsBeforeCachedRead, 'reading history and balances reuses saved rates');
    rates.comparison = true;
    const comparisonFixture = await loadWorkbook();
    const balanceSheet = comparisonFixture.getWorksheet('Баланс');
    balanceSheet.getCell(103, 1).value = 'Валютный второй'; balanceSheet.getCell(103, 2).value = 'GEL';
    const operationsSheet = comparisonFixture.getWorksheet('Операции');
    for (const [row, amount] of [[operationsSheet.rowCount + 1, 10], [operationsSheet.rowCount + 2, 20]]) {
      operationsSheet.getCell(row, 1).value = '2020-01-01'; operationsSheet.getCell(row, 2).value = 'Доход';
      operationsSheet.getCell(row, 5).value = amount; operationsSheet.getCell(row, 6).value = 'GEL'; operationsSheet.getCell(row, 13).value = 103;
    }
    await comparisonFixture.writeFile(workbook);
    const changed = (await jsonRequest(baseUrl, '/api/balance/currency-comparison?refresh=true')).payload;
    const gel = changed.currencies.find((item) => item.currency === 'GEL');
    assert.equal(gel.firstValue, gel.amount * 10);
    assert.equal(gel.currentValue, gel.amount * 12);
    assert.equal(gel.difference, gel.amount * 2);
    assert.ok(requestedDates.some((date) => date.startsWith('01/')));
    assert.ok(gel.amount >= 30);
    rates.comparison = false;
    ids.push(103);
    assert.equal((await send('/api/settings/clear-data', { mode: 'all' })).response.status, 400);
    const incoming = path.join(process.env.FINANCE_SYNC_DIR, 'incoming');
    await mkdir(incoming, { recursive: true });
    const event = { schema: 1, id: 'old-reset-event', author: 'test', createdAt: '2020-01-01T00:00:00Z', operation: { date: '2026-10-01', type: 'Расход', category: 'Продукты', amount: 1, currency: 'RUB', accountId: ids[0], necessity: 'Обязательная' } };
    await writeFile(path.join(incoming, 'old.json'), JSON.stringify(event));
    await writeFile(path.join(process.env.FINANCE_SYNC_DIR, 'personal.md'), '# Keep me');
    const history = await send('/api/settings/clear-data', { mode: 'history', confirmation: 'УДАЛИТЬ ИСТОРИЮ' });
    assert.equal(history.response.status, 200);
    assert.equal(history.payload.data.operations.length, 0);
    assert.deepEqual(history.payload.data.accounts.map((account) => account.id), ids);
    assert.ok(history.payload.data.accounts.every((account) => account.calculatedBalance === 0));
    assert.ok(!(await readdir(incoming)).includes('old.json'));
    await writeFile(path.join(incoming, 'delayed.json'), JSON.stringify(event));
    const beforeReplay = await sha256(workbook);
    await importInboxOnce();
    assert.equal(await sha256(workbook), beforeReplay);
    assert.ok(!(await readdir(incoming)).includes('delayed.json'));
    const cleared = await send('/api/settings/clear-data', { mode: 'all', confirmation: 'ПОЛНАЯ ОЧИСТКА' });
    assert.equal(cleared.response.status, 200);
    assert.equal(cleared.payload.data.accounts.length, 0);
    assert.deepEqual(cleared.payload.data.lists.categories, history.payload.data.lists.categories);
    assert.equal(await readFile(path.join(process.env.FINANCE_SYNC_DIR, 'personal.md'), 'utf8'), '# Keep me');
    const newAccount = await send('/api/accounts', { accounts: [{ name: 'После очистки', currency: 'RUB', rate: 1 }] }, 'PUT');
    assert.equal(newAccount.response.status, 200);
    event.id = 'fresh-after-reset'; event.createdAt = new Date().toISOString(); event.operation.accountId = newAccount.payload.result.created[0];
    await writeFile(path.join(incoming, 'fresh.json'), JSON.stringify(event));
    await importInboxOnce();
    assert.equal((await jsonRequest(baseUrl, '/api/data')).payload.operations.length, 1);
    await writeFile(path.join(incoming, 'repeated-fresh.json'), JSON.stringify(event));
    const freshHash = await sha256(workbook);
    await importInboxOnce();
    assert.equal(await sha256(workbook), freshHash);
  });

  scenario('заменяет начальный баланс счёта без создания дохода или расхода', async () => {
    const before = (await jsonRequest(baseUrl, '/api/data')).payload;
    const account = before.accounts[0];
    const beforeOperations = before.operations.length;
    const first = await jsonRequest(baseUrl, '/api/operations/opening-balance', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId: account.id, amount: 123 }) });
    assert.equal(first.response.status, 200);
    const second = await jsonRequest(baseUrl, '/api/operations/opening-balance', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId: account.id, amount: 456, date: '2026-09-30' }) });
    assert.equal(second.response.status, 200);
    assert.equal(second.payload.data.openingBalances.filter((item) => item.accountId === account.id).length, 1);
    assert.equal(second.payload.data.openingBalances.find((item) => item.accountId === account.id).amount, 456);
    assert.equal(second.payload.data.openingBalances.find((item) => item.accountId === account.id).date, '2026-09-30');
    assert.equal(second.payload.data.accounts.find((item) => item.id === account.id).calculatedBalance, account.calculatedBalance + 456);
    assert.equal(second.payload.data.operations.length, beforeOperations);
    const invalid = await jsonRequest(baseUrl, '/api/operations/opening-balance', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId: 9999, amount: 1 }) });
    assert.equal(invalid.response.status, 400);
  });

  scenario('identity: удалённое событие не возвращается после перезапуска', async () => {
    const root = path.join(sandbox, 'identity-inbox');
    const source = path.join(root, 'incoming', 'deleted-event.json');
    const event = { schema: 1, id: 'deleted-event', author: 'test', createdAt: new Date().toISOString(), operation: { date: '2026-10-14', type: 'Доход', category: 'Работа / зарплата', amount: 7, currency: 'RUB', accountId: 5 } };
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, JSON.stringify(event));
    assert.equal((await importInboxOnce(root))[0].status, 'imported');
    const data = (await jsonRequest(baseUrl, '/api/data')).payload;
    await jsonRequest(baseUrl, `/api/operations/${data.operations[0].id}`, { method: 'DELETE' });
    const hash = await sha256(workbook), files = await readdir(backups);
    await writeFile(source, JSON.stringify(event));
    const restarted = await import(`../server.js?identity-restart=${sandbox}`);
    const retry = await restarted.importInboxOnce(root);
    assert.equal(retry[0].status, 'discarded');
    assert.equal(retry[0].duplicate, true);
    assert.equal(retry[0].sourceDeleted, true);
    assert.equal(await sha256(workbook), hash);
    assert.deepEqual(await readdir(backups), files);
    assert.equal((await jsonRequest(baseUrl, '/api/data')).payload.operations.length, 0);
  });

  scenario('identity: удалённые ID счетов не переиспользуются, предел явный', async () => {
    const add = () => send('/api/accounts', { accounts: [{ name: 'Новый', currency: 'RUB', rate: 1 }] }, 'PUT');
    const first = (await add()).payload.result.created[0];
    assert.equal((await jsonRequest(baseUrl, `/api/accounts/${first}`, { method: 'DELETE' })).response.status, 200);
    const second = (await add()).payload.result.created[0];
    assert.notEqual(second, first);
    const delayed = await send('/api/operations', { date: '2026-10-14', type: 'Доход', category: 'Работа / зарплата', amount: 3, currency: 'RUB', accountId: first, sourceId: 'late-deleted-account', sourceCreatedAt: new Date().toISOString() });
    assert.equal(delayed.response.status, 400);
    const queue = path.join(sandbox, 'retired-account');
    const source = path.join(queue, 'incoming', 'late-account.json');
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, JSON.stringify({ schema: 1, id: 'late-account-event', author: 'test', createdAt: new Date().toISOString(), operation: { date: '2026-10-14', type: 'Доход', category: 'Работа / зарплата', amount: 3, currency: 'RUB', accountId: first } }));
    const rejected = await importInboxOnce(queue);
    assert.equal(rejected[0].status, 'error');
    assert.ok(await readFile(source));
    assert.equal((await jsonRequest(baseUrl, '/api/data')).payload.accounts.find((item) => item.id === second).calculatedBalance, 0);
    const { readIdentity, saveIdentity } = await import('../lib/identity-state.mjs');
    const excel = await loadWorkbook();
    const state = readIdentity(excel);
    for (let id = 5; id <= 104; id++) state.accounts.add(id);
    saveIdentity(excel, state);
    await excel.writeFile(workbook);
    const hash = await sha256(workbook), files = await readdir(backups);
    assert.equal((await add()).response.status, 400);
    assert.equal(await sha256(workbook), hash);
    assert.deepEqual(await readdir(backups), files);
  });

  scenario('identity: сброс очищает оба учёта по матрице и сохраняет начальный капитал', async () => {
    await send('/api/operations/opening-balance', { accountId: 5, amount: 100 }, 'PUT');
    const saving = await send('/api/savings/accounts', { name: 'Сбережения', type: 'Вклад', currency: 'RUB', initialCapital: 200 });
    const id = saving.payload.result.id;
    await send(`/api/savings/accounts/${id}/increase`, { amount: 10, date: '2026-10-14' });
    await send('/api/operations', { date: '2026-10-14', type: 'Инвестиция', amount: 5, currency: 'RUB', rate: 1, accountId: 5, savingsAccountId: id, destinationAmount: 5 });
    const fixture = await loadWorkbook();
    fixture.getWorksheet('Операции').getCell(5, 19).value = 'Unrelated column';
    await fixture.writeFile(workbook);
    const history = await send('/api/settings/clear-data', { mode: 'history', confirmation: 'УДАЛИТЬ ИСТОРИЮ' });
    assert.equal((await loadWorkbook()).getWorksheet('Операции').getCell(5, 19).value, 'Unrelated column');
    assert.equal(history.response.status, 200);
    assert.equal(history.payload.data.accounts.find((a) => a.id === 5).calculatedBalance, 100);
    assert.equal(history.payload.data.savingsAccounts[0].calculatedBalance, 200);
    assert.deepEqual(history.payload.data.savingsAccounts[0].movements, []);
    assert.deepEqual(history.payload.data.operations, []);
    const fresh = await send('/api/operations', { date: '2026-10-14', type: 'Доход', category: 'Работа / зарплата', amount: 1, currency: 'RUB', accountId: 5, sourceId: 'fresh-reset-identity', sourceCreatedAt: new Date().toISOString() });
    assert.equal(fresh.response.status, 201);
    const duplicate = await send('/api/operations', { sourceId: 'fresh-reset-identity', sourceCreatedAt: new Date().toISOString() });
    assert.equal(duplicate.payload.result.duplicate, true);
    assert.equal(duplicate.payload.result.discarded, false);
    assert.equal(duplicate.payload.backup, null);
    const all = await send('/api/settings/clear-data', { mode: 'all', confirmation: 'ПОЛНАЯ ОЧИСТКА' });
    assert.equal(all.response.status, 200);
    assert.deepEqual(all.payload.data.accounts, []);
    assert.deepEqual(all.payload.data.savingsAccounts, []);
    assert.deepEqual(all.payload.data.openingBalances, []);
    const newMain = await send('/api/accounts', { accounts: [{ name: 'После сброса', currency: 'RUB', rate: 1 }] }, 'PUT');
    assert.ok(![5, 6].includes(newMain.payload.result.created[0]));
    const newSaving = await send('/api/savings/accounts', { name: 'После сброса', type: 'Вклад', currency: 'RUB', initialCapital: 0 });
    assert.notEqual(newSaving.payload.result.id, id);
  });

  scenario('identity: restore объединяет реестры и блокирует задержанную очередь', async () => {
    const created = await send('/api/operations', { date: '2026-10-14', type: 'Доход', category: 'Работа / зарплата', amount: 10, currency: 'RUB', accountId: 5, sourceId: 'before-restore', sourceCreatedAt: new Date().toISOString() });
    const oldBackup = created.payload.backup;
    const account = await send('/api/accounts', { accounts: [{ name: 'После бэкапа', currency: 'RUB', rate: 1 }] }, 'PUT');
    const oldId = account.payload.result.created[0];
    const restored = await send('/api/settings/restore-backup', { backup: oldBackup });
    assert.equal(restored.response.status, 200);
    assert.equal(restored.payload.result.data.operations.length, 0);
    const { readIdentity } = await import('../lib/identity-state.mjs');
    const state = readIdentity(await loadWorkbook());
    assert.ok(state.events.has('before-restore'));
    assert.ok(state.accounts.has(oldId));
    const hash = await sha256(workbook), files = await readdir(backups);
    const delayed = await send('/api/operations', { sourceId: 'unknown-old-event', sourceCreatedAt: '2020-01-01T00:00:00Z' });
    assert.equal(delayed.payload.result.discarded, true);
    assert.equal(await sha256(workbook), hash);
    assert.deepEqual(await readdir(backups), files);
    const next = await send('/api/accounts', { accounts: [{ name: 'После restore', currency: 'RUB', rate: 1 }] }, 'PUT');
    assert.notEqual(next.payload.result.created[0], oldId);
    const reset = JSON.parse(await readFile(path.join(process.env.FINANCE_SYNC_DIR, 'config/reset.json'), 'utf8'));
    assertContract('reset', reset);
    assert.equal(reset.cutoff, state.cutoff);
    assert.ok(reset.ids.includes('before-restore'));
  });

  scenario('identity: валюты начальных остатков и накоплений защищены', async () => {
    await send('/api/operations/opening-balance', { accountId: 5, amount: 0 }, 'PUT');
    const hash = await sha256(workbook);
    const edit = await send('/api/accounts', { accounts: [{ id: 5, name: 'Наличные', currency: 'USD', rate: 90 }] }, 'PUT');
    assert.equal(edit.response.status, 400);
    assert.equal(await sha256(workbook), hash);
    await send('/api/savings/accounts', { name: 'Валютные накопления', type: 'Вклад', currency: 'USD', initialCapital: 10 });
    const lists = (await jsonRequest(baseUrl, '/api/data')).payload.lists;
    const before = await sha256(workbook), files = await readdir(backups);
    const removed = await send('/api/lists', { ...lists, currencies: lists.currencies.filter((c) => c !== 'USD') }, 'PUT');
    assert.equal(removed.response.status, 400);
    assert.equal(await sha256(workbook), before);
    assert.deepEqual(await readdir(backups), files);
  });

  scenario('identity: миграция старой книги атомарна и сохраняет прежние ссылки', async () => {
    const { readIdentity } = await import('../lib/identity-state.mjs');
    const excel = await loadWorkbook();
    assert.equal(excel.getWorksheet('_FinanceState'), undefined);
    const sheet = excel.getWorksheet('Операции');
    for (const [column, value] of [[1, '2026-10-14'], [2, 'Доход'], [3, 'Работа / зарплата'], [5, 5], [6, 'RUB'], [12, 'legacy-source-event'], [13, 5]]) sheet.getCell(5, column).value = value;
    await excel.writeFile(workbook);
    const original = await readFile(workbook);
    await jsonRequest(baseUrl, '/api/data');
    assert.deepEqual(await readFile(workbook), original, 'reads never migrate');
    const deleted = await jsonRequest(baseUrl, '/api/operations/5', { method: 'DELETE' });
    assert.equal(deleted.response.status, 200);
    assert.deepEqual(await readFile(path.join(backups, deleted.payload.backup)), original);
    const state = readIdentity(await loadWorkbook());
    assert.ok(state.events.has('legacy-source-event'));
    assert.deepEqual([...state.accounts], [5, 6]);
    const repeat = await send('/api/operations', { sourceId: 'legacy-source-event' });
    assert.equal(repeat.payload.result.discarded, true);
    assert.equal(repeat.payload.backup, null);
    assert.deepEqual((await jsonRequest(baseUrl, '/api/data')).payload.accounts.map((a) => a.id), [5, 6]);
  });

  scenario('identity: неоднозначное восстановление сохраняет очередь и блокировку после рестарта', async () => {
    const created = await send('/api/accounts', { accounts: [{ name: 'Бэкап', currency: 'RUB', rate: 1 }] }, 'PUT');
    const backup = created.payload.backup;
    await writeFile(workbook, 'damaged');
    const restored = await send('/api/settings/restore-backup', { backup });
    assert.equal(restored.response.status, 200);
    assert.equal(restored.payload.result.syncBlocked, true);
    assert.ok(restored.payload.result.warnings.length);
    const root = process.env.FINANCE_SYNC_DIR;
    const source = path.join(root, 'incoming', 'ambiguous-event.json');
    await mkdir(path.dirname(source), { recursive: true });
    const event = { schema: 1, id: 'ambiguous-event', author: 'test', createdAt: '2020-01-01T00:00:00Z', operation: { date: '2026-10-14', type: 'Доход', category: 'Работа / зарплата', amount: 5, currency: 'RUB', accountId: 5 } };
    await writeFile(source, JSON.stringify(event));
    const restarted = await import(`../server.js?blocked-restart=${sandbox}`);
    const hash = await sha256(workbook), files = await readdir(backups);
    assert.equal((await restarted.importInboxOnce())[0].status, 'error');
    assert.ok(await readFile(source));
    assert.equal(await sha256(workbook), hash);
    assert.deepEqual(await readdir(backups), files);
    const add = await send('/api/accounts', { accounts: [{ name: 'Запрещён', currency: 'RUB', rate: 1 }] }, 'PUT');
    assert.equal(add.response.status, 409);
    assert.equal((await send('/api/settings/restore-backup', { backup })).payload.result.syncBlocked, true);
    await assert.rejects(readFile(path.join(root, 'config/reset.json')));
  });

  scenario('boundary: invalid calendar, amount, types and references never change Excel', async () => {
    const valid = { date: '2026-10-14', type: 'Расход', category: 'Продукты', amount: 1, currency: 'RUB', accountId: 5, notes: '' };
    const hash = await sha256(workbook), files = await readdir(backups);
    for (const patch of [{ date: '2026-02-31' }, { date: '1900-02-29' }, { amount: 1e100 }, { amount: true }, { amount: 0.0000001 }, { notes: 'x'.repeat(501) }, { category: 'unknown' }, { necessity: 'unknown' }, { accountId: true }, { notes: {} }]) {
      const result = await send('/api/operations', { ...valid, ...patch });
      assert.equal(result.response.status, 400, JSON.stringify(patch));
      assert.equal(result.payload.code, 'VALIDATION');
    }
    for (const [route, body, method] of [
      ['/api/operations/opening-balance', { accountId: 5, amount: 1, date: '2026-02-31' }, 'PUT'],
      ['/api/savings/accounts', { name: 'Bad', type: 'Вклад', currency: 'RUB', initialCapital: 1e100 }],
      ['/api/savings/transfers', { direction: 'to-savings', savingAccountId: 2, mainAccountId: 5, mainAmount: true, savingAmount: 1, date: '2026-10-14' }],
    ]) assert.equal((await send(route, body, method)).response.status, 400);
    assert.equal((await jsonRequest(baseUrl, '/api/rates?currency=USD&date=2026-02-31')).response.status, 400);
    assert.equal(await sha256(workbook), hash);
    assert.deepEqual(await readdir(backups), files);
    assert.equal((await send('/api/operations', { ...valid, date: '2024-02-29', amount: 0.000001 })).response.status, 201);
  });

  scenario('boundary: PUT cannot create empty row; legacy notes keep saved financial fields', async () => {
    const hash = await sha256(workbook), files = await readdir(backups);
    const body = { date: '2026-10-14', type: 'Доход', category: 'Работа / зарплата', amount: 1, currency: 'RUB', notes: 'Empty' };
    assert.equal((await send('/api/operations/5', body, 'PUT')).response.status, 404);
    assert.equal(await sha256(workbook), hash); assert.deepEqual(await readdir(backups), files);
    const fixture = await loadWorkbook();
    const sheet = fixture.getWorksheet('Операции');
    for (const [col, value] of [[1, '1899-01-01'], [2, 'Расход'], [3, 'Удалённая категория'], [5, 1.12345678], [6, 'USD'], [7, 77.123456789], [11, 'old']]) sheet.getCell(5, col).value = value;
    await fixture.writeFile(workbook);
    const updated = await send('/api/operations/5', { notes: 'new' }, 'PUT');
    assert.equal(updated.response.status, 200);
    const saved = (await loadWorkbook()).getWorksheet('Операции');
    for (const col of [1, 2, 3, 5, 6, 7, 13]) assert.deepEqual(saved.getCell(5, col).value, sheet.getCell(5, col).value);
    assert.equal(saved.getCell(5, 11).value, 'new');
  });

  scenario('boundary: local HTTP rejects foreign Host, Origin, form posts and malformed JSON', async () => {
    for (const headers of [{ Host: 'evil.test' }, { Origin: 'https://evil.test' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
      assert.equal((await jsonRequest(baseUrl, '/api/data', { headers })).response.status, 403);
      assert.equal((await jsonRequest(baseUrl, '/api/settings/export-mobile', { method: 'POST', headers })).response.status, 403);
    }
    assert.equal((await jsonRequest(baseUrl, '/api/data', { headers: { Origin: baseUrl, 'Sec-Fetch-Site': 'same-origin' } })).response.status, 200);
    const malformed = await jsonRequest(baseUrl, '/api/operations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{private' });
    assert.equal(malformed.response.status, 400); assert.equal(malformed.payload.code, 'INVALID_JSON');
    assert.ok(!JSON.stringify(malformed.payload).includes('private'));
    assert.equal((await jsonRequest(baseUrl, '/api/operations', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).response.status, 415);
    assert.equal((await jsonRequest(baseUrl, '/api/operations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notes: 'x'.repeat(1024 * 1024) }) })).response.status, 413);
  });

  scenario('boundary: invalid mobile timestamps, versions and oversized files are retained', async () => {
    const root = path.join(sandbox, 'boundary-mobile');
    await mkdir(path.join(root, 'incoming'), { recursive: true });
    const events = [
      { schema: 2, id: 'unknown-version', author: 'owner', createdAt: new Date().toISOString(), operation: {} },
      { schema: 1, id: 'invalid-created-at', author: 'owner', createdAt: '2026-02-31T12:00:00Z', operation: {} },
      { schema: 1, id: 'missing-created-at', author: 'owner', operation: {} },
      { schema: 1, id: 'oversized-payload', author: 'owner', createdAt: new Date().toISOString(), operation: { notes: 'x'.repeat(65536) } },
    ];
    for (const event of events) await writeFile(path.join(root, 'incoming', `${event.id}.json`), JSON.stringify(event));
    const hash = await sha256(workbook), files = await readdir(backups);
    const result = await importInboxOnce(root);
    assert.equal(result.length, 4); assert.ok(result.every((r) => r.status === 'error'));
    assert.equal((await readdir(path.join(root, 'incoming'))).length, 4);
    assert.equal(await sha256(workbook), hash); assert.deepEqual(await readdir(backups), files);
  });

  scenario('operations: receipt retention preserves unknown and failed files', async () => {
    const root = path.join(sandbox, 'receipt-retention');
    const directory = path.join(root, 'receipts');
    await mkdir(directory, { recursive: true });
    const samples = {
      'old-imported.json': { schema: 1, id: 'old-imported', status: 'imported', importedAt: '2026-01-01T00:00:00Z', author: 'fixture', checksum: 'a'.repeat(64), duplicate: false },
      'old-error.json': { schema: 1, id: 'old-error', status: 'error', checkedAt: '2026-01-01T00:00:00Z' },
      'ordinary.json': { note: 'must stay' },
      'unknown-version.json': { schema: 2, id: 'unknown-version', status: 'imported', importedAt: '2026-01-01T00:00:00Z' },
    };
    for (const [name, payload] of Object.entries(samples)) {
      const file = path.join(directory, name);
      await writeFile(file, JSON.stringify(payload));
      const old = new Date(Date.now() - 60 * 86400000);
      await fsPromises.utimes(file, old, old);
    }
    await synchronizeMobile(root);
    assert.deepEqual((await readdir(directory)).sort(), ['old-error.json', 'ordinary.json', 'unknown-version.json']);
  });

  scenario('lifecycle: slow CBR releases workbook lock and reloads concurrent edits', async () => {
    await jsonRequest(baseUrl, '/api/data');
    let release, started;
    rates.gate = new Promise((resolve) => { release = resolve; });
    const waiting = new Promise((resolve) => { rates.started = resolve; });
    const transfer = send('/api/operations', { date: '2019-03-15', type: 'Перевод', amount: 1, currency: 'GEL', accountId: 6, destinationAccountId: 5, destinationAmount: 30 });
    try {
      await waiting;
      const local = await Promise.race([
        send('/api/operations', { date: '2026-10-14', type: 'Доход', category: 'Работа / зарплата', amount: 2, currency: 'RUB', accountId: 5, notes: 'concurrent-local' }),
        new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('CBR held workbook lock')), 5000); timer.unref(); }),
      ]);
      assert.equal(local.response.status, 201);
    } finally { release(); }
    assert.equal((await transfer).response.status, 201);
    const data = (await jsonRequest(baseUrl, '/api/data')).payload;
    assert.equal(data.operations.length, 2);
    assert.equal(data.operations.filter((o) => o.notes === 'concurrent-local').length, 1);
    const snapshot = (await jsonRequest(baseUrl, '/api/snapshot')).payload;
    assert.equal(snapshot.revision, data.revision);
    assert.equal(snapshot.asOfDate, data.asOfDate);
  });

  scenario('boundary: upstream failure is retryable and redacted', async () => {
    rates.unavailable = true;
    const result = await jsonRequest(baseUrl, '/api/rates?currency=USD&date=2025-03-15');
    assert.equal(result.response.status, 502);
    assert.equal(result.payload.code, 'EXTERNAL_SERVICE');
    assert.equal(result.payload.retryable, true);
    assert.ok(!JSON.stringify(result.payload).includes('PRIVATE_UPSTREAM'));
  });

  scenario('boundary: unexpected failures are redacted and diagnostics bounded', async (t) => {
    const original = fsPromises.readFile;
    let failureCode;
    t.mock.method(fsPromises, 'readFile', async (...args) => {
      if (args[0] === workbook) throw Object.assign(new Error('private-account C:/private/workbook.xlsx amount=12345'), { code: failureCode });
      return original(...args);
    });
    syncBuiltinESMExports();
    try {
      for (let i = 0; i < 102; i++) {
        const result = await jsonRequest(baseUrl, '/api/data');
        assert.equal(result.response.status, 500);
        assert.equal(result.payload.code, 'INTERNAL_ERROR');
        assert.ok(!JSON.stringify(result.payload).includes('private'));
      }
      const diagnostics = (await jsonRequest(baseUrl, '/api/diagnostics')).payload;
      assert.equal(diagnostics.length, 100);
      assert.ok(!JSON.stringify(diagnostics).includes('private'));
      failureCode = 'EBUSY';
      const busy = await jsonRequest(baseUrl, '/api/data');
      assert.equal(busy.response.status, 503);
      assert.equal(busy.payload.retryable, true);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  });

}

const names = [];
defineScenarios({}, (name) => names.push(name));
if (process.env.FINANCE_TEST_REVERSE === '1') names.reverse();
for (const name of names) test(name, async (t) => {
  const context = await setup(t, name.startsWith('мигрирует книгу'));
  let run;
  defineScenarios(context, (candidate, body) => { if (candidate === name) run = body; });
  await run(t);
});
