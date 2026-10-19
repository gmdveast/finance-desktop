export function resetFinancialRows(workbook, account = {}) {
  // Clear existing cells without materializing thousands of absent blank cells.
  const clear = (sheet, row, column) => {
    const letters = String.fromCharCode(64 + column);
    if (sheet.cells.has(`${letters}${row}`)) sheet.getCell(row, column).value = null;
  };
  const operations = workbook.getWorksheet('Операции');
  const balances = workbook.getWorksheet('Баланс');
  const operationEndRow = Math.max(operations.rowCount, 604);
  balances.getCell(1, 14).value = null;

  for (let row = 5; row <= operationEndRow; row += 1) {
    for (const column of [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]) clear(operations, row, column);
  }
  operations.getCell(operationEndRow, 8).value = {
    formula: `IF(OR(E${operationEndRow}="",F${operationEndRow}=""),"",IF(F${operationEndRow}="RUB",E${operationEndRow},IF(G${operationEndRow}="", "",E${operationEndRow}*G${operationEndRow})))`,
    result: '',
  };
  for (let row = 5; row <= Math.max(balances.rowCount, 200); row += 1) {
    for (let column = 1; column <= 14; column += 1) clear(balances, row, column);
  }

  for (const name of ['Накопления', 'Движение накоплений', 'Начальные балансы']) {
    const sheet = workbook.getWorksheet(name);
    if (sheet) for (let row = 2; row <= sheet.rowCount; row += 1) {
      for (let column = 1; column <= 8; column += 1) clear(sheet, row, column);
    }
  }

  if (account === null) return;
  const row = account.row || 5;
  balances.getCell(row, 1).value = account.name || 'Тестовый основной счёт';
  balances.getCell(row, 2).value = account.currency || 'RUB';
  balances.getCell(row, 4).value = account.rate ?? 1;
  balances.getCell(row, 5).value = 0;
  balances.getCell(row, 11).value = 0;
}
