import { readIdentity, saveIdentity } from '../lib/identity-state.mjs';
import { WorkbookStore } from '../lib/workbook-store.mjs';
import { loadWorkbook, validateWorkbookFile } from '../server.js';

const [file, backupDirectory, stopAt = ''] = process.argv.slice(2);
const store = new WorkbookStore({ file, backupDirectory, validate: validateWorkbookFile, checkpoint: async (stage) => {
  if (stage === stopAt) {
    process.send({ stage });
    await new Promise((resolve) => process.once('message', resolve));
  }
} });
await store.exclusive(async () => {
  const book = await loadWorkbook(file);
  const cell = book.getWorksheet('Баланс').getCell(5, 5);
  cell.value = (Number(cell.value) || 0) + 1;
  const state = readIdentity(book);
  state.events.add(`worker-event-${cell.value}`);
  saveIdentity(book, state);
  await store.commit({ revision: book.revision, prepare: (target) => book.writeFile(target) });
});
process.disconnect();
