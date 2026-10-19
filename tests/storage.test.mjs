import test from 'node:test';
import { readIdentity } from '../lib/identity-state.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createFixture } from './create-fixture.mjs';
import JSZip from 'jszip';
import { WorkbookStore, acquireWorkbookLock } from '../lib/workbook-store.mjs';
import { loadWorkbook, validateWorkbookFile, migrateAccountModel, migrateStreamlinedModel } from '../server.js';
import { authorizedShutdown, runtimePath } from '../lib/runtime-control.mjs';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'finance-storage-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'test.xlsx');
  const backupDirectory = path.join(directory, 'backups');
  await createFixture(file);
  const store = new WorkbookStore({ file, backupDirectory, validate: validateWorkbookFile, ...options });
  const update = async () => store.exclusive(async () => {
    const book = await loadWorkbook(file);
    book.getWorksheet('Баланс').getCell(5, 5).value = 42;
    return store.commit({ revision: book.revision, prepare: (target) => book.writeFile(target) });
  });
  return { directory, file, backupDirectory, store, update };
}

function worker(file, backups, stage = '') {
  const child = fork(new URL('./storage-worker.mjs', import.meta.url), [file, backups, stage], { silent: true, windowsHide: true, execArgv: [] });
  let errors = '';
  child.stderr.on('data', (data) => { errors += data; });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, errors }));
  });
  return { child, done };
}

test('commit validates candidate, backs up exact previous bytes and restores atomically', async (t) => {
  const f = await fixture(t);
  const old = await fs.readFile(f.file);
  const saved = await f.update();
  assert.deepEqual(await fs.readFile(path.join(f.backupDirectory, saved.backup)), old);
  assert.equal((await loadWorkbook(f.file)).getWorksheet('Баланс').getCell(5, 5).value, 42);
  const changed = await fs.readFile(f.file);
  const restored = await f.store.restore(saved.backup);
  assert.deepEqual(await fs.readFile(f.file), old);
  assert.deepEqual(await fs.readFile(path.join(f.backupDirectory, restored.backup)), changed);
  assert.match(restored.backup, /before_restore/);
  await assert.rejects(f.store.restore(`../${saved.backup}`));
  await fs.writeFile(path.join(f.backupDirectory, 'broken.xlsx'), 'broken');
  await assert.rejects(f.store.restore('broken.xlsx'));
  assert.deepEqual(await fs.readFile(f.file), old);
});

test('failures before replace retain readable original and remove only owned temporary files', async (t) => {
  for (const stage of ['prepared', 'backed-up', 'before-replace']) {
    await t.test(stage, async (t) => {
      const f = await fixture(t, { checkpoint: async (current) => { if (current === stage) throw new Error('Injected failure'); } });
      const before = await fs.readFile(f.file);
      const unrelated = path.join(f.directory, 'unrelated.tmp.xlsx');
      await fs.writeFile(unrelated, 'keep');
      await assert.rejects(f.update(), /Injected/);
      assert.deepEqual(await fs.readFile(f.file), before);
      assert.equal(await fs.readFile(unrelated, 'utf8'), 'keep');
      assert.equal((await fs.readdir(f.directory)).some((name) => name.startsWith(f.store.tempPrefix)), false);
      await validateWorkbookFile(f.file);
    });
  }
});

test('disk-full backup and denied replace fail without truncating workbook', async (t) => {
  for (const code of ['ENOSPC', 'EPERM']) {
    await t.test(code, async (t) => {
      const f = await fixture(t);
      f.store.io = { ...fs,
        writeFile: async (...args) => {
          if (code === 'ENOSPC' && path.dirname(args[0]) === f.backupDirectory) throw Object.assign(new Error('disk full'), { code });
          return fs.writeFile(...args);
        },
        rename: async (...args) => {
          if (code === 'EPERM' && args[1] === f.file) throw Object.assign(new Error('locked'), { code });
          return fs.rename(...args);
        },
      };
      const before = await fs.readFile(f.file);
      await assert.rejects(f.update());
      assert.deepEqual(await fs.readFile(f.file), before);
      await validateWorkbookFile(f.file);
    });
  }
});

test('revision conflict preserves external edit; Excel owner file prevents writes', async (t) => {
  const f = await fixture(t);
  let external;
  f.store.checkpoint = async (stage) => {
    if (stage !== 'prepared') return;
    const book = await loadWorkbook(f.file);
    book.getWorksheet('Баланс').getCell(5, 5).value = 99;
    await book.writeFile(f.file);
    external = await fs.readFile(f.file);
  };
  await assert.rejects(f.update(), { code: 'WORKBOOK_CHANGED' });
  assert.deepEqual(await fs.readFile(f.file), external);
  f.store.checkpoint = async () => {};
  await fs.writeFile(path.join(f.directory, '~$test.xlsx'), 'Excel owner');
  await assert.rejects(f.update(), { code: 'EXCEL_OPEN' });
  assert.deepEqual(await fs.readFile(f.file), external);
});

test('invalid or partially written candidate never replaces workbook; post-commit cleanup only warns', async (t) => {
  const f = await fixture(t);
  const before = await fs.readFile(f.file);
  const book = await loadWorkbook(f.file);
  await assert.rejects(f.store.exclusive(() => f.store.commit({ revision: book.revision, prepare: (target) => fs.writeFile(target, 'invalid XLSX') })));
  await assert.rejects(f.store.exclusive(() => f.store.commit({ revision: book.revision, prepare: async (target) => {
    await fs.writeFile(target, 'partial');
    throw Object.assign(new Error('disk full during candidate write'), { code: 'ENOSPC' });
  } })), { code: 'ENOSPC' });
  assert.deepEqual(await fs.readFile(f.file), before);
  assert.equal((await f.store.listBackups()).length, 0);
  f.store.prune = async () => { throw new Error('cleanup failed'); };
  const saved = await f.update();
  assert.equal(saved.warnings.length, 1);
  assert.equal((await loadWorkbook(f.file)).getWorksheet('Баланс').getCell(5, 5).value, 42);
});

test('kernel lock serializes competing processes and releases after owner death', { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const children = Array.from({ length: 3 }, () => worker(f.file, f.backupDirectory));
  t.after(() => children.forEach(({ child }) => { if (child.exitCode === null) child.kill(); }));
  for (const result of await Promise.all(children.map(({ done }) => done))) assert.equal(result.code, 0, result.errors);
  assert.equal((await loadWorkbook(f.file)).getWorksheet('Баланс').getCell(5, 5).value, 3);
  const release = await acquireWorkbookLock(f.file);
  try { await assert.rejects(acquireWorkbookLock(f.file, { timeout: 100 }), { code: 'WORKBOOK_BUSY' }); }
  finally { await release(); }
});

test('process crash at commit boundaries leaves old or new valid workbook and permits restart', { timeout: 30000 }, async (t) => {
  for (const stage of ['prepared', 'backed-up', 'before-replace', 'committed']) {
    await t.test(stage, async (t) => {
      const f = await fixture(t);
      const before = await fs.readFile(f.file);
      const w = worker(f.file, f.backupDirectory, stage);
      t.after(() => { if (w.child.exitCode === null) w.child.kill(); });
      const [message] = await once(w.child, 'message');
      assert.equal(message.stage, stage);
      w.child.kill('SIGKILL');
      await w.done;
      const state = readIdentity(await validateWorkbookFile(f.file));
      assert.equal(state.events.has('worker-event-1'), stage === 'committed');
      if (stage !== 'committed') assert.deepEqual(await fs.readFile(f.file), before);
      else assert.equal((await loadWorkbook(f.file)).getWorksheet('Баланс').getCell(5, 5).value, 1);
      await f.update();
      assert.equal((await fs.readdir(f.directory)).some((name) => name.startsWith(f.store.tempPrefix)), false);
      assert.equal((await loadWorkbook(f.file)).getWorksheet('Баланс').getCell(5, 5).value, 42);
    });
  }
});

test('backup pruning uses modification time across normal and restore backups, preserves foreign files', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.backupDirectory);
  const original = await fs.readFile(f.file);
  const names = [];
  for (let i = 0; i < 32; i += 1) {
    const name = `test_${i % 2 ? 'before_restore_' : ''}20260101000000_${String(i).padStart(3, '0')}.xlsx`;
    const file = path.join(f.backupDirectory, name);
    await fs.writeFile(file, original);
    await fs.utimes(file, new Date(1000 * i), new Date(1000 * i));
    names.push(name);
  }
  await fs.writeFile(path.join(f.backupDirectory, 'test_personal.xlsx'), 'keep');
  const orphan = `${f.store.tempPrefix}${randomUUID()}.tmp.xlsx`;
  await fs.writeFile(path.join(f.directory, orphan), 'incomplete');
  const saved = await f.update();
  const remaining = await fs.readdir(f.backupDirectory);
  assert.equal(remaining.length, 31);
  for (const name of names.slice(0, 3)) assert.ok(!remaining.includes(name));
  assert.ok(remaining.includes(saved.backup));
  assert.ok(remaining.includes('test_personal.xlsx'));
  assert.equal((await f.store.listBackups())[0].name, saved.backup);
  assert.ok(!(await fs.readdir(f.directory)).includes(orphan));
});

test('shutdown requires token, matching Host and non-browser request', () => {
  const descriptor = { port: 4173, token: 'a'.repeat(64) };
  const headers = { host: '127.0.0.1:4173', authorization: `Bearer ${descriptor.token}` };
  assert.ok(authorizedShutdown({ headers }, descriptor));
  for (const changed of [{ origin: 'https://example.com' }, { host: 'evil.test:4173' }, { authorization: 'Bearer bad' }, { 'sec-fetch-site': 'cross-site' }]) assert.equal(authorizedShutdown({ headers: { ...headers, ...changed } }, descriptor), false);
});

test('Windows file share lock denies replacement while preserving old workbook', { skip: process.platform !== 'win32', timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const before = await fs.readFile(f.file);
  const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$stream=[System.IO.File]::Open($env:FINANCE_LOCK_TEST_FILE,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::Read); try { [Console]::WriteLine('locked'); [Console]::ReadLine() | Out-Null } finally { $stream.Dispose() }"], {
    windowsHide: true, env: { ...process.env, FINANCE_LOCK_TEST_FILE: f.file }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = once(holder, 'exit');
  try {
    await once(holder.stdout, 'data');
    await assert.rejects(f.update(), { code: 'WORKBOOK_BUSY' });
    assert.deepEqual(await fs.readFile(f.file), before);
  } finally {
    holder.stdin.end('\n');
    await exited;
  }
  await f.update();
});

test('shutdown command drains in-flight mobile commit, receipt and cleanup; server can restart', { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const book = await loadWorkbook(f.file);
  migrateAccountModel(book);
  migrateStreamlinedModel(book);
  // This fixture is already empty; do not materialize thousands of blank cells.
  const accounts = book.getWorksheet('Баланс');
  accounts.getCell(5, 1).value = 'Test account';
  accounts.getCell(5, 2).value = 'RUB';
  accounts.getCell(5, 4).value = 1;
  await book.writeFile(f.file);
  const sync = path.join(f.directory, 'sync');
  const incoming = path.join(sync, 'incoming');
  await fs.mkdir(incoming, { recursive: true });
  const event = { schema: 1, id: 'shutdown-import-event', author: 'test', createdAt: new Date().toISOString(), operation: { date: '2026-10-14', type: 'Доход', category: 'Работа / зарплата', amount: 123, currency: 'RUB', accountId: 5 } };
  const source = path.join(incoming, `${event.id}.json`);
  await fs.writeFile(source, JSON.stringify(event));
  const cbr = createServer((_req, res) => res.end('<ValCurs Date="16.10.2026"><Valute><CharCode>USD</CharCode><Nominal>1</Nominal><Value>80</Value></Valute></ValCurs>'));
  await new Promise((resolve) => cbr.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, FINANCE_DATA_DIR: f.directory, WORKBOOK_PATH: f.file, BACKUP_DIR: f.backupDirectory, FINANCE_SYNC_DIR: sync, CBR_CACHE_PATH: path.join(f.directory, 'rates.json'), CBR_BASE_URL: `http://127.0.0.1:${cbr.address().port}/`, NODE_ENV: 'test' };
  const child = fork(new URL('./runtime-worker.mjs', import.meta.url), [], { silent: true, execArgv: [], windowsHide: true, env });
  let stderr = '';
  child.stderr.on('data', (data) => { stderr += data; });
  child.stdout.resume();
  const messages = [];
  child.on('message', (message) => messages.push(message));
  const exited = once(child, 'exit');
  let phase = 'startup';
  const helpers = [];
  const waitFor = async (stage) => {
    const until = performance.now() + 10000;
    while (!messages.some((m) => m.stage === stage)) {
      if (child.exitCode !== null || performance.now() > until) throw new Error(`Missing ${stage}: ${stderr}`);
      await delay(20);
    }
    return messages.find((m) => m.stage === stage);
  };
  try {
    const { port } = await waitFor('ready');
    phase = 'ready';
    await waitFor('writing');
    phase = 'writing';
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/system/shutdown`, { method: 'POST' })).status, 403);
    const second = fork(new URL('../server.js', import.meta.url), [], { silent: true, execArgv: [], windowsHide: true, env });
    helpers.push(second);
    second.stdout.resume(); second.stderr.resume();
    assert.equal((await once(second, 'exit'))[0], 1, 'second desktop instance must refuse same workbook');
    phase = 'second refused';
    const stop = fork(new URL('../scripts/stop-server.mjs', import.meta.url), [], { silent: true, execArgv: [], windowsHide: true, env });
    helpers.push(stop);
    stop.stdout.resume(); stop.stderr.on('data', (data) => { stderr += data; });
    const stopped = once(stop, 'exit');
    await delay(150);
    assert.equal(stop.exitCode, null, 'stop must wait until commit and sync complete');
    assert.ok(await fs.stat(runtimePath(f.file)));
    child.send('release');
    phase = 'released';
    assert.equal((await stopped)[0], 0);
    phase = 'stop command done';
    assert.equal((await exited)[0], 0, stderr);
    await assert.rejects(fs.stat(source), { code: 'ENOENT' });
    await assert.rejects(fs.stat(runtimePath(f.file)), { code: 'ENOENT' });
    const receipt = JSON.parse(await fs.readFile(path.join(sync, 'receipts', `${event.id}.json`), 'utf8'));
    assert.equal(receipt.status, 'imported');
    assert.equal(receipt.sourceDeleted, true);
    const saved = await loadWorkbook(f.file);
    assert.equal(saved.getWorksheet('Операции').getCell(receipt.excelRow, 12).value, event.id);
    assert.equal(saved.getWorksheet('Операции').getCell(receipt.excelRow, 5).value, 123);
    const release = await acquireWorkbookLock(f.file, { purpose: 'server', timeout: 0 });
    await release();
  } finally {
    t.diagnostic(`Shutdown phase: ${phase}; ${stderr}`);
    for (const helper of helpers) if (helper.exitCode === null) helper.kill();
    if (child.exitCode === null) { child.kill(); await exited; }
    await new Promise((resolve) => cbr.close(resolve));
  }
});

test('offline recovery command restores damaged current workbook with separate safety backup', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.backupDirectory);
  const original = await fs.readFile(f.file);
  await fs.writeFile(path.join(f.backupDirectory, 'recovery.xlsx'), original);
  await fs.writeFile(f.file, 'damaged-current-workbook');
  const child = fork(new URL('../scripts/restore-backup.mjs', import.meta.url), ['recovery.xlsx'], {
    silent: true, windowsHide: true, execArgv: [],
    env: { ...process.env, FINANCE_DATA_DIR: f.directory, WORKBOOK_PATH: f.file, BACKUP_DIR: f.backupDirectory, FINANCE_SYNC_DIR: path.join(f.directory, 'sync'), CBR_CACHE_PATH: path.join(f.directory, 'rates.json'), NODE_ENV: 'test' },
  });
  let stderr = '';
  child.stdout.resume(); child.stderr.on('data', (data) => { stderr += data; });
  assert.equal((await once(child, 'exit'))[0], 0, stderr);
  const recovered = await validateWorkbookFile(f.file);
  assert.equal(readIdentity(recovered).blocked, true);
  assert.equal(recovered.getWorksheet('Баланс').getCell(5, 1).value, null);
  const safety = (await fs.readdir(f.backupDirectory)).find((name) => name.includes('before_restore'));
  assert.equal(await fs.readFile(path.join(f.backupDirectory, safety), 'utf8'), 'damaged-current-workbook');
});

test('synthetic-format compatibility: isolated round-trip retains layout and unrelated OOXML parts', async (t) => {
  const f = await fixture(t);
  const sourceZip = await JSZip.loadAsync(await fs.readFile(f.file));
  sourceZip.file('customXml/synthetic-preserved.xml', '<item>synthetic-preserved-content</item>');
  const original = await sourceZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await fs.writeFile(f.file, original);
  const before = await validateWorkbookFile(f.file);
  const output = path.join(f.directory, 'roundtrip.xlsx');
  await before.writeFile(output);
  const after = await validateWorkbookFile(output);
  const rewritten = new Set([...before.paths.values(), ...before.extraDocuments.keys(), 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', '[Content_Types].xml']);
  for (const [name, entry] of Object.entries(before.zip.files)) {
    if (entry.dir || rewritten.has(name)) continue;
    assert.deepEqual(await after.zip.file(name).async('nodebuffer'), await entry.async('nodebuffer'), `OOXML part changed: ${name}`);
  }
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  for (const [name, sheet] of before.sheets) {
    const loaded = after.getWorksheet(name);
    for (const element of ['mergeCell', 'col', 'dataValidation']) {
      const attributes = (document) => Array.from(document.getElementsByTagNameNS(ns, element)).map((node) => Array.from(node.attributes).map((a) => [a.name, a.value]));
      assert.deepEqual(attributes(loaded.document), attributes(sheet.document));
    }
    for (const [ref, cell] of sheet.cells) assert.equal(loaded.cells.get(ref)?.getAttribute('s'), cell.getAttribute('s'));
  }
  assert.deepEqual(await fs.readFile(f.file), original);
});
