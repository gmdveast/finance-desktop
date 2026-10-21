import { createWriteStream } from 'node:fs';
import { constants as fsConstants, copyFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import express from 'express';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { acquireWorkbookLock } from './workbook-store.mjs';
import { InputError, localHttpBoundary } from './input-boundary.mjs';
import { authorizedShutdown, publishRuntime, removeRuntime } from './runtime-control.mjs';

const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

function setupError(error) {
  if (error instanceof InputError) return { status: error.status, code: error.code, error: error.message, retryable: false };
  if (error?.code === 'WORKBOOK_EXISTS') return { status: 409, code: error.code, error: 'Рабочая книга уже создана. Перезапустите Finance.', retryable: false };
  const missingSheet = String(error?.message || '').match(/отсутствует лист «(Операции|Списки|Баланс|Сводка)»/u)?.[1];
  if (missingSheet) return { status: 400, code: 'WORKBOOK_MISSING_SHEET', error: `В книге нет листа «${missingSheet}». Выберите книгу Finance с листами «Операции», «Списки», «Баланс» и «Сводка». Исходный файл не изменён.`, retryable: false };
  if (['EACCES', 'EPERM', 'ENOSPC', 'EBUSY'].includes(error?.code)) {
    return { status: 503, code: 'STORAGE_UNAVAILABLE', error: 'Не удалось сохранить книгу. Проверьте доступ к папке и свободное место.', retryable: true };
  }
  return { status: 400, code: 'WORKBOOK_INVALID', error: 'Не удалось проверить книгу. Выберите поддерживаемый файл Excel .xlsx. Исходный файл не изменён.', retryable: false };
}

export async function startFirstRunApplication({
  port,
  workbookPath,
  templatePath,
  publicDirectory,
  dataDirectory,
  syncDirectory,
  workbookStore,
  onInstalled,
}) {
  await mkdir(path.dirname(workbookPath), { recursive: true });
  const releaseServer = await acquireWorkbookLock(workbookPath, { purpose: 'server', timeout: 0 });
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => localHttpBoundary(req, res, next, {
    allowedBodyTypes: req.path === '/api/setup/import' ? ['application/octet-stream'] : [],
  }));

  let runtimeDescriptor = null;
  let server;
  let stopPromise;
  let transitionScheduled = false;
  const processListeners = new Map();

  app.post('/api/system/shutdown', (req, res) => {
    if (!runtimeDescriptor || !authorizedShutdown(req, runtimeDescriptor)) {
      return res.status(403).json({ error: 'Запрос остановки не разрешён.', code: 'FORBIDDEN_ORIGIN', retryable: false });
    }
    res.status(202).json({ stopping: true });
    setImmediate(() => stop().catch(() => { process.exitCode = 1; }));
  });

  app.get('/api/setup/status', async (_req, res) => {
    const exists = await workbookStore.io.lstat(workbookPath).then(() => true, (error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    res.json({
      needsSetup: !exists,
      maxImportBytes: MAX_IMPORT_BYTES,
      dataDirectory,
      workbookPath,
      backupDirectory: workbookStore.backupDirectory,
      syncDirectory,
    });
  });

  app.post('/api/setup/create', async (_req, res) => {
    try {
      const installation = await workbookStore.initialize({
        prepare: (target) => copyFile(templatePath, target, fsConstants.COPYFILE_EXCL),
      });
      res.status(202).json({ ready: true, warning: installation.warnings.length ? 'Книга создана; данные сохранены, но обслуживание файла завершилось с предупреждением.' : null });
      scheduleTransition();
    } catch (error) { sendError(res, error); }
  });

  app.post('/api/setup/import', async (req, res) => {
    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_IMPORT_BYTES) {
      req.resume();
      return res.status(413).json({ error: 'Файл больше 50 МБ. Выберите книгу меньшего размера.', code: 'PAYLOAD_TOO_LARGE', retryable: false });
    }
    try {
      const installation = await workbookStore.initialize({
        prepare: async (target) => {
          let size = 0;
          const limit = new Transform({
            transform(chunk, _encoding, callback) {
              size += chunk.length;
              if (size > MAX_IMPORT_BYTES) callback(new InputError('Файл больше 50 МБ. Выберите книгу меньшего размера.', 413, 'PAYLOAD_TOO_LARGE'));
              else callback(null, chunk);
            },
          });
          await pipeline(req, limit, createWriteStream(target, { flags: 'wx' }));
          if (size === 0) throw new InputError('Выберите файл Excel .xlsx.', 400, 'EMPTY_UPLOAD');
        },
      });
      res.status(202).json({ ready: true, warning: installation.warnings.length ? 'Книга сохранена; обслуживание файла завершилось с предупреждением.' : null });
      scheduleTransition();
    } catch (error) { sendError(res, error); }
  });

  app.get('/', (_req, res) => res.sendFile(path.join(publicDirectory, 'setup.html')));
  app.use(express.static(publicDirectory, { index: false }));
  app.use((_req, res) => res.status(404).json({ error: 'Страница не найдена.', code: 'NOT_FOUND', retryable: false }));
  app.use((error, _req, res, _next) => sendError(res, error));

  function sendError(res, error) {
    if (res.headersSent || res.destroyed) return;
    const safe = setupError(error);
    res.status(safe.status).json({ error: safe.error, code: safe.code, retryable: safe.retryable });
  }

  function scheduleTransition() {
    if (transitionScheduled) return;
    transitionScheduled = true;
    setTimeout(async () => {
      try {
        await stop();
        await onInstalled();
      } catch {
        // No paths, file names or workbook contents are written to diagnostics.
        console.error('Finance создал книгу, но не смог автоматически перезапустить приложение. Запустите его ещё раз.');
        process.exitCode = 1;
      }
    }, 300);
  }

  server = app.listen(port, '127.0.0.1');
  try {
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    runtimeDescriptor = await publishRuntime(workbookPath, server.address().port);
  } catch (error) {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await releaseServer();
    throw error;
  }

  async function stop() {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      try { if (runtimeDescriptor) await removeRuntime(workbookPath, runtimeDescriptor); }
      finally {
        await releaseServer();
        for (const [signal, listener] of processListeners) process.removeListener(signal, listener);
      }
    })();
    return stopPromise;
  }

  for (const signal of ['SIGINT', 'SIGTERM']) {
    const listener = () => { stop().catch(() => { process.exitCode = 1; }); };
    processListeners.set(signal, listener);
    process.on(signal, listener);
  }

  console.log(`Настройка Финансового журнала: http://127.0.0.1:${server.address().port}`);
  return { server, stop };
}
