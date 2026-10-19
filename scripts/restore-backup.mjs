import { listBackups, restoreWorkbookOffline } from '../server.js';

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--list') {
    for (const backup of await listBackups()) console.log(`${backup.name}\t${backup.modifiedAt}`);
  } else if (args.length === 1 && !args[0].startsWith('--')) {
    const result = await restoreWorkbookOffline(args[0]);
    console.log(`Восстановлено: ${result.restored}. Копия предыдущего состояния: ${result.safetyBackup}`);
    for (const warning of result.warnings) console.error(warning);
    console.log('При следующем запуске сервер обновит мобильные справочники и балансы.');
  } else {
    throw new Error('Использование: npm run restore:backup -- --list либо npm run restore:backup -- "имя_из_списка.xlsx". Перед восстановлением остановите сервер.');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
