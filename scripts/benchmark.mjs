import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createFixture } from '../tests/create-fixture.mjs';

const results = [];
for (const [historyRows, queueSize] of [[1000, 10], [5000, 25]]) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'finance-load-'));
  let server;
  try {
    process.env.FINANCE_DATA_DIR = directory;
    process.env.WORKBOOK_PATH = path.join(directory, 'synthetic.xlsx');
    process.env.BACKUP_DIR = path.join(directory, 'backups');
    process.env.FINANCE_SYNC_DIR = path.join(directory, 'sync');
    process.env.CBR_CACHE_PATH = path.join(directory, 'rates.json');
    process.env.NODE_ENV = 'test';
    // Offline benchmark: never use the public CBR service.
    process.env.CBR_BASE_URL = 'http://127.0.0.1:1/unavailable';
    const date = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    await fs.writeFile(process.env.CBR_CACHE_PATH, JSON.stringify({ schema: 1, rates: { [`USD:${date}`]: { rate: 80, effectiveDate: date, requestedDate: date } } }));
    await createFixture(process.env.WORKBOOK_PATH, { historyRows });
    const api = await import(`../server.js?benchmark=${historyRows}`);
    const book = await api.loadWorkbook();
    api.migrateAccountModel(book); api.migrateStreamlinedModel(book);
    for (const [col, value] of [[1, 'Synthetic'], [2, 'RUB'], [4, 1]]) book.getWorksheet('Баланс').getCell(5, col).value = value;
    await book.writeFile(process.env.WORKBOOK_PATH);
    server = api.startServer(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const startRead = performance.now();
    const data = await (await fetch(`${url}/api/data`)).json();
    const readMs = performance.now() - startRead;
    assert.equal(data.operations.length, historyRows);
    const incoming = path.join(process.env.FINANCE_SYNC_DIR, 'incoming');
    await fs.mkdir(incoming, { recursive: true });
    for (let i = 0; i < queueSize; i++) await fs.writeFile(path.join(incoming, `load-event-${i}.json`), JSON.stringify({ schema: 1, id: `load-event-${i}`, author: 'benchmark', createdAt: new Date().toISOString(), operation: { date, type: 'Доход', category: 'Работа / зарплата', currency: 'RUB', amount: 1, accountId: 5 } }));
    const startSync = performance.now();
    const sync = await api.synchronizeMobile();
    const syncMs = performance.now() - startSync;
    assert.equal(sync.imported, queueSize); assert.equal(sync.errors, 0);
    assert.equal((await fs.readdir(incoming)).length, 0);
    const reread = await (await fetch(`${url}/api/data`)).json();
    assert.equal(reread.operations.length, historyRows + queueSize);
    assert.ok((await fs.readdir(process.env.BACKUP_DIR)).length <= 30);
    const startRepeat = performance.now();
    await api.synchronizeMobile();
    results.push({ historyRows, queueSize, readMs: Math.round(readMs), syncMs: Math.round(syncMs), msPerEvent: Math.round(syncMs / queueSize), emptySyncMs: Math.round(performance.now() - startRepeat), rssMiB: Math.round(process.memoryUsage().rss / 1048576), peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024) });
    console.log('Scenario completed:', JSON.stringify(results.at(-1)));
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
}
const report = { at: new Date().toISOString(), node: process.version, platform: `${os.platform()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0].model, results };
await fs.writeFile(new URL('../docs/LOAD-RESULTS.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
