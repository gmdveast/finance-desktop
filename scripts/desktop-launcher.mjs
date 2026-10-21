import { spawn, spawnSync } from 'node:child_process';
import { lstat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestShutdown, runtimePath } from '../lib/runtime-control.mjs';

const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installRoot = path.basename(path.dirname(appDirectory)).toLowerCase() === 'versions'
  ? path.resolve(appDirectory, '..', '..')
  : appDirectory;
const registryKey = 'HKCU\\Software\\FinanceDesktop';
const localAppData = process.env.LOCALAPPDATA;
const userDirectory = localAppData ? path.join(localAppData, 'Finance') : null;
const dataDirectory = userDirectory ? path.join(userDirectory, 'data') : null;
const workbookPath = dataDirectory ? path.join(dataDirectory, 'uchet_povsednevnyh_finansov.xlsx') : null;
const syncDirectory = userDirectory ? path.join(userDirectory, 'Finance Sync') : null;
const appUrl = 'http://127.0.0.1:4173';
const nodeExecutable = path.join(appDirectory, 'runtime', 'node.exe');

function readRegistryString(name) {
  if (process.platform !== 'win32') return null;
  const result = spawnSync('reg.exe', ['query', registryKey, '/v', name], { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) return null;
  const match = String(result.stdout || '').match(new RegExp(`^\\s*${name}\\s+REG_SZ\\s+([^\\r\\n]+)`, 'im'));
  return match?.[1]?.trim() || null;
}

function writeRegistryString(name, value) {
  if (process.platform !== 'win32' || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,79}$/.test(value)) throw new Error('Недопустимая версия для переключения.');
  const result = spawnSync('reg.exe', ['add', registryKey, '/v', name, '/t', 'REG_SZ', '/d', value, '/f'], { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error('Не удалось сохранить активную версию Finance в настройках Windows.');
}

function resolveVersionDirectory(version) {
  if (!version || version === 'legacy') return installRoot;
  if (!/^[0-9A-Za-z][0-9A-Za-z.-]{0,79}$/.test(version)) return null;
  return path.join(installRoot, 'versions', version);
}

async function hasInstalledApplication(directory) {
  if (!directory) return false;
  const directoryInfo = await lstat(directory).catch(() => null);
  if (!directoryInfo?.isDirectory()) return false;
  return Promise.all([
    lstat(path.join(directory, 'server.js')),
    lstat(path.join(directory, 'runtime', 'node.exe')),
    lstat(path.join(directory, 'scripts', 'desktop-launcher.mjs')),
  ]).then((items) => items.every((item) => item.isFile()), () => false);
}

function setStorageEnvironment() {
  if (!dataDirectory || !syncDirectory) throw new Error('Finance не смог определить локальную папку данных Windows.');
  process.env.FINANCE_DATA_DIR = dataDirectory;
  process.env.FINANCE_CONFIG_PATH = path.join(dataDirectory, 'finance.config.json');
  process.env.WORKBOOK_PATH = workbookPath;
  process.env.BACKUP_DIR = path.join(dataDirectory, 'backups');
  process.env.CBR_CACHE_PATH = path.join(dataDirectory, 'cbr-rates.json');
  process.env.FINANCE_SYNC_DIR = syncDirectory;
  process.env.PORT = '4173';
  process.env.NODE_ENV = 'production';
  process.env.FINANCE_INSTALL_ROOT = installRoot;
  process.env.FINANCE_CURRENT_VERSION = readRegistryString('CurrentVersion') || 'legacy';
  process.env.FINANCE_PREVIOUS_VERSION = readRegistryString('PreviousVersion') || '';
}

async function probeFinance() {
  let reachable = false;
  for (const route of ['/api/settings', '/api/setup/status']) {
    let response;
    try {
      response = await fetch(`${appUrl}${route}`, { signal: AbortSignal.timeout(700) });
    } catch {
      continue;
    }
    reachable = true;
    if (response.status === 404) continue;
    if (!response.ok) return { occupied: true, finance: false };
    const payload = await response.json().catch(() => null);
    if (typeof payload?.dataDirectory !== 'string') return { occupied: true, finance: false };
    const actual = path.win32.resolve(payload.dataDirectory).toLowerCase();
    const expected = path.win32.resolve(dataDirectory).toLowerCase();
    return { occupied: true, finance: true, sameData: actual === expected };
  }
  return { occupied: reachable, finance: false, sameData: false };
}

function showMessage(message) {
  if (process.platform !== 'win32') return;
  const escaped = message.replaceAll("'", "''");
  const command = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('${escaped}', 'Finance') | Out-Null`;
  const dialog = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', command], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  dialog.on('error', () => {});
  dialog.unref();
}

function openBrowser() {
  const browser = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', appUrl], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  browser.on('error', () => {});
  browser.unref();
}

const wait = (duration) => new Promise((resolve) => setTimeout(resolve, duration));

async function startFinance() {
  setStorageEnvironment();
  const beforeStart = await probeFinance();
  if (beforeStart.finance && beforeStart.sameData) {
    openBrowser();
    return;
  }
  if (beforeStart.occupied) throw new Error('Порт Finance уже занят. Закройте другое приложение Finance или повторите запуск позже.');

  const server = spawn(nodeExecutable, [path.join(appDirectory, 'server.js')], {
    cwd: appDirectory,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
  });
  let exited = false;
  server.once('error', () => { exited = true; });
  server.once('exit', () => { exited = true; });
  server.unref();

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (exited) break;
    const state = await probeFinance();
    if (state.finance && state.sameData) {
      openBrowser();
      return;
    }
    if (state.occupied) throw new Error('Порт Finance уже занят. Закройте другое приложение Finance или повторите запуск позже.');
    await wait(400);
  }
  throw new Error('Finance не запустился. Повторите попытку; если ошибка останется, обратитесь за поддержкой.');
}

async function stopFinance() {
  setStorageEnvironment();
  const stateFile = runtimePath(workbookPath);
  const runtimeExists = await lstat(stateFile).then(() => true, (error) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  if (!runtimeExists) {
    const state = await probeFinance();
    if (!state.finance || !state.sameData) return;
    throw new Error('Finance запущен без защищённого маркера управления. Не удалось безопасно остановить его.');
  }
  await requestShutdown(workbookPath);
}

async function installUpdate(installerPath) {
  if (process.platform !== 'win32') throw new Error('Установка обновления поддерживается только в Windows.');
  const resolvedInstaller = path.resolve(installerPath || '');
  const temporaryRoot = path.resolve(tmpdir()).toLowerCase();
  const resolvedLower = resolvedInstaller.toLowerCase();
  const expectedPrefix = `${temporaryRoot}${path.sep.toLowerCase()}finance-update-`;
  if (!resolvedLower.startsWith(expectedPrefix) || !resolvedLower.endsWith('.exe') || !(await lstat(resolvedInstaller).then((item) => item.isFile(), () => false))) {
    throw new Error('Загруженный установщик Finance не найден в временной папке. Проверьте обновление ещё раз.');
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const installer = spawn(resolvedInstaller, [], { detached: true, stdio: 'ignore', windowsHide: false });
  const installerExit = new Promise((resolve) => installer.once('exit', resolve));
  await new Promise((resolve, reject) => {
    installer.once('spawn', resolve);
    installer.once('error', reject);
  });
  await installerExit;
  await unlink(resolvedInstaller).catch(() => {});
}

async function rollbackFinance() {
  if (process.platform !== 'win32') throw new Error('Откат версии поддерживается только в Windows.');
  const currentVersion = readRegistryString('CurrentVersion') || 'legacy';
  const previousVersion = readRegistryString('PreviousVersion');
  const previousDirectory = resolveVersionDirectory(previousVersion);
  if (!previousVersion || previousVersion === currentVersion || !(await hasInstalledApplication(previousDirectory))) {
    throw new Error('Предыдущая версия Finance недоступна.');
  }
  setStorageEnvironment();
  await stopFinance();
  writeRegistryString('PreviousVersion', currentVersion);
  writeRegistryString('CurrentVersion', previousVersion);
  const startScript = path.join(installRoot, 'scripts', 'finance-start.vbs');
  const scriptHost = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
  const restart = spawn(scriptHost, [startScript], { detached: true, stdio: 'ignore', windowsHide: true });
  await new Promise((resolve, reject) => {
    restart.once('spawn', resolve);
    restart.once('error', reject);
  });
  restart.unref();
}

try {
  const mode = process.argv[2] || 'start';
  if (mode === 'start') await startFinance();
  else if (mode === 'stop') await stopFinance();
  else if (mode === 'install') await installUpdate(process.argv[3]);
  else if (mode === 'rollback') await rollbackFinance();
  else throw new Error('Неизвестная команда запуска Finance.');
} catch (error) {
  showMessage(error.message || 'Не удалось выполнить команду Finance.');
  process.exitCode = 1;
}
