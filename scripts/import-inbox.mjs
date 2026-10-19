import { synchronizeMobile } from '../server.js';

const result = await synchronizeMobile();
console.log(`Импортировано: ${result.imported}; уже было в Excel: ${result.duplicates}; ошибок: ${result.errors}; ожидают удаления: ${result.cleanupPending}.`);
console.log(result.changed ? 'Справочники для телефона обновлены.' : 'Справочники для телефона без изменений.');
console.log(result.balancesChanged ? 'Снимок балансов для телефона обновлён.' : 'Снимок балансов для телефона без изменений.');
for (const warning of result.warnings) console.error(warning);
if (!result.ok) process.exitCode = 1;
