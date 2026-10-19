import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateWorkbookFile } from '../server.js';
import { exportRecoveryBundle, verifyRecoveryBundle, rehearseRecovery } from '../lib/recovery-bundle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDirectory = path.resolve(process.env.FINANCE_DATA_DIR || path.join(root, 'local-data'));
const [command, target, directory] = process.argv.slice(2);
try {
  if (command === 'export' && target && !directory) {
    console.log(await exportRecoveryBundle(path.resolve(process.env.WORKBOOK_PATH || path.join(dataDirectory, 'uchet_povsednevnyh_finansov.xlsx')), path.resolve(target), validateWorkbookFile));
  } else if (command === 'verify' && target && !directory) {
    console.log((await verifyRecoveryBundle(path.resolve(target))).manifest);
  } else if (command === 'rehearse' && target && directory) {
    console.log(await rehearseRecovery(path.resolve(target), path.resolve(directory), validateWorkbookFile));
  } else throw new Error('Usage: npm run recovery -- export <backup-directory> | verify <bundle.zip> | rehearse <bundle.zip> <new-directory>');
} catch (error) { console.error(error.message); process.exitCode = 1; }
