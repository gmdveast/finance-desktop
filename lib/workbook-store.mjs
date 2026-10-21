import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const failure = (message, code, status = 409) => Object.assign(new Error(message), { code, status });

async function canonicalWorkbookPath(file) {
  const resolved = path.resolve(file);
  try { return await fs.realpath(resolved); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const directory = await fs.realpath(path.dirname(resolved));
    return path.join(directory, path.basename(resolved));
  }
}

// Kernel-owned locks have no stale PID files to reclaim after a crash. All writers
// on this computer must use the canonical workbook path and this protocol.
export async function acquireWorkbookLock(file, { purpose = 'write', timeout = 15000 } = {}) {
  let canonical = await canonicalWorkbookPath(file);
  if (process.platform === 'win32') canonical = canonical.toLowerCase();
  const name = `finance-${purpose}-${digest(canonical)}`;
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\${name}`
    : process.platform === 'linux' ? `\0${name}` : null;
  if (!address) throw failure('Блокировка книги поддерживается только в Windows и Linux.', 'LOCK_PLATFORM', 503);
  const started = performance.now();
  while (true) {
    const server = net.createServer((socket) => socket.destroy());
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen({ path: address, exclusive: true }, resolve);
      });
      return () => new Promise((resolve) => server.close(resolve));
    } catch (error) {
      if (!['EADDRINUSE', 'EACCES'].includes(error.code)) throw error;
      if (performance.now() - started >= timeout) throw failure('Книга занята другим процессом Finance. Повторите после завершения записи.', 'WORKBOOK_BUSY', 503);
      await delay(50);
    }
  }
}

export class WorkbookStore {
  constructor({ file, backupDirectory, validate, io = fs, checkpoint = async () => {} }) {
    this.file = path.resolve(file);
    this.backupDirectory = path.resolve(backupDirectory);
    this.base = path.basename(file, '.xlsx');
    this.validate = validate;
    this.io = io;
    this.checkpoint = checkpoint;
    this.tempPrefix = `.finance-${digest(this.file.toLowerCase()).slice(0, 16)}-`;
  }

  async exclusive(action) {
    const release = await acquireWorkbookLock(this.file);
    try {
      await this.cleanup();
      const info = await this.io.lstat(this.file);
      if (info.isSymbolicLink() || info.nlink > 1) throw failure('Книга должна быть обычным файлом, без символических или жёстких ссылок.', 'WORKBOOK_LINK');
      return await action();
    } finally { await release(); }
  }

  // Installs a first workbook only when the destination does not exist. The
  // candidate is validated and flushed beside the destination, then hard-linked
  // into place so installation cannot replace a file created by another process.
  async initialize({ prepare }) {
    await this.io.mkdir(path.dirname(this.file), { recursive: true });
    const release = await acquireWorkbookLock(this.file);
    const temporary = path.join(path.dirname(this.file), `${this.tempPrefix}${randomUUID()}.tmp.xlsx`);
    const warnings = [];
    try {
      await this.cleanup();
      const destination = await this.io.lstat(this.file).then(() => true, (error) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      });
      if (destination) throw failure('Рабочая книга уже существует. Перезапустите Finance.', 'WORKBOOK_EXISTS');
      await prepare(temporary);
      await this.validate(temporary);
      await this.flush(temporary);
      await this.checkpoint('prepared');
      await this.io.mkdir(this.backupDirectory, { recursive: true });
      try { await this.io.link(temporary, this.file); }
      catch (error) {
        if (error.code === 'EEXIST') throw failure('Рабочая книга уже существует. Перезапустите Finance.', 'WORKBOOK_EXISTS');
        throw error;
      }
      try { await this.flushDirectory(path.dirname(this.file)); }
      catch (error) { warnings.push(`Не удалось сбросить каталог установки на диск: ${error.message}`); }
      try { await this.io.unlink(temporary); }
      catch (error) { warnings.push(`Временный файл установки будет очищен при следующем запуске: ${error.message}`); }
      return { warnings };
    } finally {
      await this.io.unlink(temporary).catch(() => {});
      await release();
    }
  }

  async flush(file) {
    const handle = await this.io.open(file, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
  }

  async flushDirectory(directory) {
    // Windows does not expose portable directory fsync through Node. File flushes
    // and replace are tested; this is not a promise against hardware power loss.
    if (process.platform === 'win32') return;
    const handle = await this.io.open(directory, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }

  async cleanup() {
    for (const directory of new Set([path.dirname(this.file), this.backupDirectory])) {
      const names = await this.io.readdir(directory).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
      for (const name of names) {
        if (!name.startsWith(this.tempPrefix) || !/^[0-9a-f-]{36}\.tmp\.xlsx$/.test(name.slice(this.tempPrefix.length))) continue;
        const target = path.join(directory, name);
        const info = await this.io.lstat(target);
        if (info.isFile() && !info.isSymbolicLink()) await this.io.unlink(target);
      }
    }
  }

  async assertRevision(expected) {
    const excelOwner = path.join(path.dirname(this.file), `~$${path.basename(this.file)}`);
    if (await this.io.lstat(excelOwner).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error; })) {
      throw failure('Книга открыта в Excel. Закройте её перед сохранением.', 'EXCEL_OPEN');
    }
    const current = await this.io.readFile(this.file);
    if (!expected || digest(current) !== expected) throw failure('Книга изменена вне текущей операции. Обновите данные и повторите действие.', 'WORKBOOK_CHANGED');
    return current;
  }

  async listBackups() {
    await this.io.mkdir(this.backupDirectory, { recursive: true });
    const rows = [];
    for (const name of await this.io.readdir(this.backupDirectory)) {
      if (!name.endsWith('.xlsx') || name.startsWith('.finance-')) continue;
      const info = await this.io.lstat(path.join(this.backupDirectory, name));
      if (!info.isFile() || info.isSymbolicLink()) continue;
      rows.push({ name, size: info.size, modifiedAt: info.mtime.toISOString(), time: info.mtimeMs });
    }
    return rows.sort((a, b) => b.time - a.time || b.name.localeCompare(a.name));
  }

  async prune(protectedName) {
    const managed = (await this.listBackups()).filter(({ name }) => {
      if (!name.startsWith(`${this.base}_`)) return false;
      return /^(before_restore_)?\d{14}_\d{3}(?:_[0-9a-f-]{36})?\.xlsx$/.test(name.slice(this.base.length + 1));
    });
    const keep = new Set([protectedName, ...managed.filter((item) => item.name !== protectedName).slice(0, 29).map((item) => item.name)]);
    for (const { name } of managed) if (!keep.has(name)) await this.io.unlink(path.join(this.backupDirectory, name));
  }

  // Called only while exclusive() holds the kernel lock. Revision is the hash of
  // the exact bytes parsed by the caller, not a later stat or second read.
  async commit({ revision, prepare, restore = false }) {
    const temporary = path.join(path.dirname(this.file), `${this.tempPrefix}${randomUUID()}.tmp.xlsx`);
    const stamp = new Date().toISOString().replace(/[-:TZ]/g, '').replace('.', '_');
    const backup = `${this.base}_${restore ? 'before_restore_' : ''}${stamp}_${randomUUID()}.xlsx`;
    const backupTemp = path.join(this.backupDirectory, `${this.tempPrefix}${randomUUID()}.tmp.xlsx`);
    const backupPath = path.join(this.backupDirectory, backup);
    try {
      await prepare(temporary);
      await this.validate(temporary);
      await this.flush(temporary);
      await this.checkpoint('prepared');
      const original = await this.assertRevision(revision);
      await this.io.mkdir(this.backupDirectory, { recursive: true });
      await this.io.writeFile(backupTemp, original, { flag: 'wx' });
      await this.flush(backupTemp);
      if (digest(await this.io.readFile(backupTemp)) !== revision) throw failure('Резервная копия не прошла проверку.', 'BACKUP_INVALID', 500);
      await this.io.rename(backupTemp, backupPath);
      await this.flushDirectory(this.backupDirectory);
      await this.checkpoint('backed-up');
      await this.assertRevision(revision);
      await this.checkpoint('before-replace');
      // Never fall back to copying over the live workbook on EPERM/EBUSY.
      try { await this.io.rename(temporary, this.file); }
      catch (error) {
        if (['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw failure('Не удалось заменить книгу: файл занят или недоступен. Закройте Excel и повторите действие.', 'WORKBOOK_BUSY', 503);
        throw error;
      }
    } finally {
      await this.io.unlink(temporary).catch(() => {});
      await this.io.unlink(backupTemp).catch(() => {});
    }
    // The commit has happened. Maintenance failures must not report it as rolled back.
    const warnings = [];
    try { await this.flushDirectory(path.dirname(this.file)); } catch (error) { warnings.push(`Сброс каталога: ${error.message}`); }
    await this.checkpoint('committed');
    try { await this.prune(backup); } catch (error) { warnings.push(`Очистка резервных копий: ${error.message}`); }
    return { backup, warnings };
  }

  async restore(name, prepareRestored) {
    return this.exclusive(async () => {
      if (path.basename(name) !== name || !(await this.listBackups()).some((item) => item.name === name)) throw failure('Выбранная резервная копия не найдена.', 'BACKUP_NOT_FOUND', 400);
      const source = path.join(this.backupDirectory, name);
      const bytes = await this.io.readFile(source);
      const revision = digest(await this.io.readFile(this.file));
      return this.commit({ revision, restore: true, prepare: async (target) => {
        await this.io.writeFile(target, bytes, { flag: 'wx' });
        if (prepareRestored) await prepareRestored(target);
      } });
    });
  }
}
