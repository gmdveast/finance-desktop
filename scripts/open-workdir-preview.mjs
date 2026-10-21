import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expectedDataDirectory = path.resolve(
  process.env.FINANCE_DATA_DIR || path.join(projectRoot, '.test-data', 'workdir-preview', 'data'),
);
const port = Number(process.env.PORT || 4174);
const baseUrl = `http://127.0.0.1:${port}`;
const deadline = Date.now() + 30000;

function sameDirectory(actual) {
  if (typeof actual !== 'string') return false;
  const normalize = (value) => path.win32.resolve(value).replace(/[\\/]+$/u, '').toLowerCase();
  return normalize(actual) === normalize(expectedDataDirectory);
}

async function openPreviewWhenReady() {
  while (Date.now() < deadline) {
    for (const route of ['/api/settings', '/api/setup/status']) {
      try {
        const response = await fetch(`${baseUrl}${route}`, { signal: AbortSignal.timeout(750) });
        const payload = await response.json().catch(() => null);
        if (typeof payload?.dataDirectory !== 'string') continue;
        if (!sameDirectory(payload.dataDirectory)) {
          console.error(`На порту ${port} отвечает другое приложение Finance; браузер не открыт.`);
          return false;
        }

        if (process.platform === 'win32') {
          const browser = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', baseUrl], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          });
          browser.on('error', () => console.error(`Откройте приложение вручную: ${baseUrl}`));
          browser.unref();
        } else {
          console.log(`Откройте приложение: ${baseUrl}`);
        }
        return true;
      } catch {
        // The app may still be starting or may not have bound this port yet.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  console.error(`Finance не ответила на порту ${port} за 30 секунд; браузер не открыт.`);
  return false;
}

if (!await openPreviewWhenReady()) process.exitCode = 1;
