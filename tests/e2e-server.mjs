import { createServer } from 'node:http';
import path from 'node:path';
import { createFixture } from './create-fixture.mjs';
import { installTestClock } from './test-clock.mjs';

installTestClock();

const testRoot = process.env.FINANCE_E2E_ROOT;
if (!testRoot) throw new Error('Isolated FINANCE_E2E_ROOT is required');
await createFixture(path.join(testRoot, 'e2e.xlsx'));

const cbrServer = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/xml; charset=windows-1251' });
  res.end('<?xml version="1.0"?><ValCurs Date="12.10.2026"><Valute><CharCode>USD</CharCode><Nominal>1</Nominal><Value>91,2500</Value></Valute><Valute><CharCode>JPY</CharCode><Nominal>100</Nominal><Value>54,0000</Value></Valute><Valute><CharCode>GEL</CharCode><Nominal>1</Nominal><Value>32,2642</Value></Valute></ValCurs>');
});
await new Promise((resolve) => cbrServer.listen(0, '127.0.0.1', resolve));

process.env.PORT = '0';
process.env.FINANCE_DATA_DIR = testRoot;
process.env.WORKBOOK_PATH = path.join(testRoot, 'e2e.xlsx');
process.env.BACKUP_DIR = path.join(testRoot, 'backups');
process.env.CBR_CACHE_PATH = path.join(testRoot, 'cbr-rates.json');
process.env.FINANCE_SYNC_DIR = path.join(testRoot, 'mobile-sync');
process.env.CBR_BASE_URL = `http://127.0.0.1:${cbrServer.address().port}/daily`;
process.env.NODE_ENV = 'test';
process.env.FINANCE_BROWSER_LIFECYCLE = '1';
const { loadWorkbook, migrateAccountModel, migrateCategoryEmojis, migrateStreamlinedModel, startApplication } = await import('../server.js');
const workbook = await loadWorkbook();
migrateAccountModel(workbook, '2026-10-14');
migrateStreamlinedModel(workbook);
migrateCategoryEmojis(workbook);
const balance = workbook.getWorksheet('Баланс');
for (const [col, value] of [[1, 'Долларовая карта'], [2, 'USD'], [4, 91.25]]) balance.getCell(5, col).value = value;
await workbook.writeFile(process.env.WORKBOOK_PATH);
const application = await startApplication(0, { presenceOptions: { leaseMs: 120_000, shutdownGraceMs: 20_000, startupGraceMs: 90_000 } });
const appServer = application.server;
appServer.on('request', (req, res) => {
  if (req.method !== 'POST' || req.url !== '/api/system/presence') return;
  res.once('finish', () => {
    if (process.connected) process.send({ type: 'presence-event', event: { body: req.body, statusCode: res.statusCode } });
  });
});
process.send({ baseURL: `http://127.0.0.1:${appServer.address().port}`, syncRoot: process.env.FINANCE_SYNC_DIR });
process.on('message', async (message) => {
  if (message !== 'stop') return;
  await application.stop();
  await new Promise((resolve) => cbrServer.close(resolve));
  process.disconnect();
});
