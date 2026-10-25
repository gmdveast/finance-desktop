import './presence.js';
import { initializeLocale, localeCode, translate, translateError } from './i18n.js';

await initializeLocale();

const createButton = document.querySelector('#create-book');
const importButton = document.querySelector('#import-book');
const fileInput = document.querySelector('#workbook-file');
const selectedFile = document.querySelector('#selected-file');
const statusBox = document.querySelector('#status');
const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
let busy = false;

async function loadStorageLocations() {
  try {
    const response = await fetch('/api/setup/status', { cache: 'no-store' });
    const payload = await responsePayload(response);
    if (!response.ok) throw new Error(translateError(payload.code, payload.error || 'Не удалось прочитать настройки папок.', payload.retryable));
    document.querySelector('#data-location').textContent = payload.dataDirectory;
    document.querySelector('#workbook-location').textContent = payload.workbookPath;
    document.querySelector('#backup-location').textContent = payload.backupDirectory;
    document.querySelector('#sync-location').textContent = payload.syncDirectory;
    if (!payload.needsSetup) {
      createButton.disabled = true;
      importButton.disabled = true;
      setStatus('Книга уже появилась в хранилище. Перезапустите Финансовый журнал.', 'error');
    }
  } catch {
    for (const id of ['data-location', 'workbook-location', 'backup-location', 'sync-location']) {
      document.querySelector(`#${id}`).textContent = 'Путь будет показан в разделе «Настройки» после запуска.';
    }
  }
}

function setStatus(message, kind = '') {
  statusBox.textContent = translate(message);
  statusBox.className = `status ${kind}`;
}

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  selectedFile.textContent = file ? `${file.name} · ${new Intl.NumberFormat(localeCode()).format(file.size)} ${translate('байт')}` : 'Файл не выбран';
  importButton.disabled = !file || file.size === 0 || file.size > MAX_IMPORT_BYTES || busy;
  if (file?.size > MAX_IMPORT_BYTES) setStatus('Размер книги должен быть не больше 50 МБ.', 'error');
  else setStatus('');
});

async function responsePayload(response) {
  return response.json().catch(() => ({}));
}

loadStorageLocations();

async function waitForFinance() {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch('/api/data', { cache: 'no-store' });
      if (response.ok) {
        location.replace('/');
        return;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  setStatus('Книга сохранена. Закройте и снова откройте Финансовый журнал, чтобы начать работу.', 'error');
}

async function submitSetup(url, options = {}) {
  if (busy) return;
  busy = true;
  createButton.disabled = true;
  importButton.disabled = true;
  setStatus('Готовим книгу на этом компьютере…', 'busy');
  try {
    const response = await fetch(url, options);
    const payload = await responsePayload(response);
    if (!response.ok) throw new Error(translateError(payload.code, payload.error || 'Не удалось подготовить книгу. Повторите попытку.', payload.retryable));
    setStatus(payload.warning || 'Книга готова. Запускаем приложение…', payload.warning ? 'error' : 'busy');
    await waitForFinance();
  } catch (error) {
    setStatus(error.message || translate('Не удалось подготовить книгу. Повторите попытку.'), 'error');
    busy = false;
    createButton.disabled = false;
    importButton.disabled = !fileInput.files?.[0] || fileInput.files[0].size > MAX_IMPORT_BYTES;
  }
}

createButton.addEventListener('click', () => submitSetup('/api/setup/create', { method: 'POST' }));
importButton.addEventListener('click', () => {
  const file = fileInput.files?.[0];
  if (!file || file.size > MAX_IMPORT_BYTES) return;
  submitSetup('/api/setup/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
});
