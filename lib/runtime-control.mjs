import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const runtimePath = (workbook) => `${workbook}.finance-runtime.json`;

export async function publishRuntime(workbook, port) {
  const descriptor = { schema: 1, pid: process.pid, port, token: randomBytes(32).toString('hex') };
  const file = runtimePath(workbook);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(descriptor), { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => {}); }
  return descriptor;
}

export function authorizedShutdown(req, descriptor) {
  if (!descriptor || req.headers.origin || req.headers['sec-fetch-site']) return false;
  if (![ `127.0.0.1:${descriptor.port}`, `localhost:${descriptor.port}` ].includes(req.headers.host)) return false;
  const supplied = Buffer.from(req.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${descriptor.token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export async function removeRuntime(workbook, descriptor) {
  const file = runtimePath(workbook);
  const current = await readFile(file, 'utf8').then(JSON.parse).catch(() => null);
  if (current?.token === descriptor.token) await unlink(file);
}

export async function requestShutdown(workbook, { timeout = 60000 } = {}) {
  const file = runtimePath(workbook);
  const descriptor = await readFile(file, 'utf8').then(JSON.parse).catch((error) => {
    if (error.code === 'ENOENT') throw new Error('Нет сведений о запущенном сервере. Старую версию сервера эта команда безопасно остановить не может.');
    throw error;
  });
  if (descriptor.schema !== 1 || !Number.isInteger(descriptor.port) || descriptor.port < 1 || descriptor.port > 65535 || !/^[a-f0-9]{64}$/.test(descriptor.token)) throw new Error('Некорректный файл состояния сервера.');
  const response = await fetch(`http://127.0.0.1:${descriptor.port}/api/system/shutdown`, {
    method: 'POST', headers: { Authorization: `Bearer ${descriptor.token}` }, signal: AbortSignal.timeout(5000), redirect: 'error',
  });
  if (response.status !== 202) throw new Error(`Сервер не подтвердил остановку (${response.status}). Принудительное завершение не выполнялось.`);
  await response.text();
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const current = await readFile(file, 'utf8').then(JSON.parse).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (!current || current.token !== descriptor.token) return;
    await delay(100);
  }
  throw new Error('Сервер ещё завершает операции. Принудительное завершение не выполнялось.');
}
