import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createFixture } from './create-fixture.mjs';
import { acquireWorkbookLock, WorkbookStore } from '../lib/workbook-store.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function exercisePresence(server, stop, baseUrl, healthRoute) {
  const clientId = randomUUID();
  const presence = async (active) => fetch(`${baseUrl}/api/system/presence`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId, active }),
  });

  const connected = await presence(true);
  assert.equal(connected.status, 204);
  const unauthorizedShutdown = await fetch(`${baseUrl}/api/system/shutdown`, { method: 'POST', headers: { Origin: baseUrl } });
  assert.equal(unauthorizedShutdown.status, 403, 'a browser presence client must not gain shutdown authority');
  assert.equal((await fetch(`${baseUrl}${healthRoute}`)).status, 200);

  const closing = once(server, 'close');
  assert.equal((await presence(false)).status, 204);
  await wait(8);
  assert.equal((await presence(true)).status, 204, 'reopening Finance cancels the pending shutdown');
  await wait(45);
  assert.equal((await fetch(`${baseUrl}${healthRoute}`)).status, 200);

  assert.equal((await presence(false)).status, 204);
  await closing;
  await stop();
  assert.equal(server.listening, false);
}

test('normal application lifecycle accepts tab presence and drains before releasing the workbook lock', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'finance-presence-app-'));
  const workbookPath = path.join(root, 'data', 'finance-test.xlsx');
  await mkdir(path.dirname(workbookPath), { recursive: true });
  await createFixture(workbookPath);

  const env = {
    FINANCE_DATA_DIR: path.join(root, 'data'),
    FINANCE_CONFIG_PATH: path.join(root, 'data', 'finance.config.json'),
    WORKBOOK_PATH: workbookPath,
    BACKUP_DIR: path.join(root, 'backups'),
    CBR_CACHE_PATH: path.join(root, 'data', 'cbr-rates.json'),
    FINANCE_SYNC_DIR: path.join(root, 'sync'),
    FINANCE_BROWSER_LIFECYCLE: '1',
    NODE_ENV: 'test',
    PORT: '0',
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const previousCbrBase = process.env.CBR_BASE_URL;
  Object.assign(process.env, env);
  const cbr = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end('<ValCurs Date="16.10.2026"><Valute><CharCode>GEL</CharCode><Nominal>1</Nominal><Value>32.2642</Value></Valute></ValCurs>');
  });
  await new Promise((resolve) => cbr.listen(0, '127.0.0.1', resolve));
  process.env.CBR_BASE_URL = `http://127.0.0.1:${cbr.address().port}/daily`;
  let application;
  t.after(async () => {
    if (application?.server.listening) await application.stop();
    if (cbr.listening) await new Promise((resolve) => cbr.close(resolve));
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
    if (previousCbrBase === undefined) delete process.env.CBR_BASE_URL;
    else process.env.CBR_BASE_URL = previousCbrBase;
    await rm(root, { recursive: true, force: true });
  });

  const { startApplication } = await import('../server.js?presence-integration-test');
  application = await startApplication(0, { presenceOptions: { leaseMs: 1000, shutdownGraceMs: 40, startupGraceMs: 1000 } });
  const baseUrl = `http://127.0.0.1:${application.server.address().port}`;
  await exercisePresence(application.server, application.stop, baseUrl, '/api/settings');

  const release = await acquireWorkbookLock(workbookPath, { purpose: 'server', timeout: 200 });
  await release();
});

test('first-run lifecycle also stops after the final tab leaves', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'finance-presence-first-run-'));
  const workbookPath = path.join(root, 'data', 'finance-test.xlsx');
  const templatePath = path.join(root, 'template.xlsx');
  await mkdir(path.dirname(workbookPath), { recursive: true });
  await createFixture(templatePath);
  const env = { FINANCE_BROWSER_LIFECYCLE: '1', NODE_ENV: 'test' };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  let setup;
  t.after(async () => {
    if (setup?.server.listening) await setup.stop();
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
    await rm(root, { recursive: true, force: true });
  });

  const [{ startFirstRunApplication }, { WorkbookStore: Store }] = await Promise.all([
    import('../lib/first-run.mjs'),
    import('../lib/workbook-store.mjs'),
  ]);
  const workbookStore = new Store({ file: workbookPath, backupDirectory: path.join(root, 'backups'), validate: async () => ({}) });
  setup = await startFirstRunApplication({
    port: 0,
    workbookPath,
    templatePath,
    publicDirectory: path.resolve('public'),
    dataDirectory: path.dirname(workbookPath),
    syncDirectory: path.join(root, 'sync'),
    workbookStore,
    presenceOptions: { leaseMs: 1000, shutdownGraceMs: 40, startupGraceMs: 1000 },
    onInstalled: async () => {},
  });
  const baseUrl = `http://127.0.0.1:${setup.server.address().port}`;
  await exercisePresence(setup.server, setup.stop, baseUrl, '/api/setup/status');

  const release = await acquireWorkbookLock(workbookPath, { purpose: 'server', timeout: 200 });
  await release();
});
