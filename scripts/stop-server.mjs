import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestShutdown } from '../lib/runtime-control.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDirectory = path.resolve(process.env.FINANCE_DATA_DIR || path.join(root, 'local-data'));
const workbook = process.env.WORKBOOK_PATH ? path.resolve(process.env.WORKBOOK_PATH) : path.join(dataDirectory, 'uchet_povsednevnyh_finansov.xlsx');
try {
  await requestShutdown(workbook);
  console.log('Сервер остановлен после завершения операций.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
