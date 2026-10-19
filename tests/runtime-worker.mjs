import fs from 'node:fs/promises';
import path from 'node:path';

// Deliberately hold the actual server at replacement, only in this test process.
const rename = fs.rename;
let held = false;
fs.rename = async (source, target) => {
  if (!held && target === path.resolve(process.env.WORKBOOK_PATH)) {
    held = true;
    process.send({ stage: 'writing' });
    await new Promise((resolve) => process.once('message', resolve));
  }
  return rename(source, target);
};
const { startApplication } = await import('../server.js');
const app = await startApplication(0);
process.send({ stage: 'ready', port: app.server.address().port });
app.server.once('close', () => {
  app.stop().then(() => process.disconnect(), (error) => { console.error(error); process.exitCode = 1; process.disconnect(); });
});
