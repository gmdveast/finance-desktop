import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixture } from '../tests/create-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.test-data/manual-mobile');
await fs.mkdir(root, { recursive: true });
process.env.FINANCE_DATA_DIR = root;
process.env.WORKBOOK_PATH = path.join(root, 'synthetic.xlsx');
process.env.BACKUP_DIR = path.join(root, 'backups');
process.env.FINANCE_SYNC_DIR = path.join(root, 'sync');
process.env.CBR_CACHE_PATH = path.join(root, 'rates.json');
const exists = await fs.stat(process.env.WORKBOOK_PATH).then(() => true, () => false);
if (!exists) await createFixture(process.env.WORKBOOK_PATH);
const api = await import('../server.js');
if (!exists) {
  const book = await api.loadWorkbook();
  api.migrateAccountModel(book); api.migrateStreamlinedModel(book);
  for (const [column, value] of [[1, 'Тестовый RUB'], [2, 'RUB'], [4, 1]]) book.getWorksheet('Баланс').getCell(5, column).value = value;
  await book.writeFile(process.env.WORKBOOK_PATH);
}
const { server } = await api.startApplication(0);
console.log(`TEST ONLY: http://127.0.0.1:${server.address().port}`);
console.log(`Syncthing test folder: ${process.env.FINANCE_SYNC_DIR}`);
console.log('Stop this test server with Ctrl+C. Restarting keeps the synthetic test history.');
