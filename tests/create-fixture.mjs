import JSZip from 'jszip';
import { writeFile } from 'node:fs/promises';

// Synthetic OOXML fixture: no production workbook, shared strings or personal metadata.
// Each test server gets a fresh copy generated from this explicit schema.
export async function createFixture(file, { historyRows = 0 } = {}) {
  const preparedRows = Math.max(600, historyRows + 100);
  const zip = new JSZip();
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const xml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const cell = (ref, value) => `<c r="${ref}" t="inlineStr"><is><t>${xml(value)}</t></is></c>`;
  const formula = (ref, text) => `<c r="${ref}"><f>${xml(text)}</f></c>`;
  const row = (r, text) => `<row r="${r}">${text}</row>`;
  const sheet = (rows, end, extra = '') => `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${ns}" xmlns:r="${rel}"><dimension ref="A1:${end}"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><sheetData>${rows}</sheetData>${extra}</worksheet>`;
  const names = ['Операции', 'Баланс', 'Сводка', 'Списки'];
  const operationHeaders = ['Дата','Тип','Категория','Описание','Сумма','Валюта','Курс','В рублях','Способ оплаты','Необходимость','Заметка'];
  const operationRows = row(1, cell('A1', 'Операции')) + row(4, operationHeaders.map((value, i) => cell(`${String.fromCharCode(65 + i)}4`, value)).join(''))
    + Array.from({ length: preparedRows }, (_, i) => {
      const r = i + 5;
      const seed = i < historyRows ? cell(`A${r}`, '2026-10-14') + cell(`B${r}`, 'Доход') + cell(`C${r}`, 'Работа / зарплата') + cell(`E${r}`, '1') + cell(`F${r}`, 'RUB') + cell(`G${r}`, '1') + cell(`M${r}`, '5') : '';
      return row(r, seed + formula(`H${r}`, `IF(OR(E${r}="",F${r}=""),"",IF(F${r}="RUB",E${r},IF(G${r}="","",E${r}*G${r})))`));
    }).join('');
  const validations = [['B','J',4],['C','A',22],['F','D',4],['I','F',4],['J','H',3]].map(([target, source, end]) => `<dataValidation type="list" allowBlank="1" sqref="${target}5:${target}604"><formula1>Списки!$${source}$2:$${source}$${end}</formula1></dataValidation>`).join('');
  zip.file('xl/worksheets/sheet1.xml', sheet(operationRows, 'R604', `<dataValidations count="5">${validations}</dataValidations><tableParts count="1"><tablePart r:id="rId1"/></tableParts>`));
  zip.file('xl/worksheets/_rels/sheet1.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/table" Target="../tables/table1.xml"/></Relationships>`);
  zip.file('xl/tables/table1.xml', `<table xmlns="${ns}" id="1" name="Operations" displayName="Operations" ref="A4:K604" totalsRowShown="0"><autoFilter ref="A4:K604"/><tableColumns count="11">${operationHeaders.map((name, i) => `<tableColumn id="${i + 1}" name="${xml(name)}"/>`).join('')}</tableColumns><tableStyleInfo name="TableStyleMedium2" showRowStripes="1"/></table>`);
  zip.file('xl/worksheets/sheet2.xml', sheet(row(1, cell('A1', 'Баланс')) + row(4, cell('A4', 'Счёт') + cell('B4', 'Валюта')) + row(14, ''), 'N14'));
  zip.file('xl/worksheets/sheet3.xml', sheet(row(2, '<c r="B2"><v>46296</v></c>') + row(5, formula('B5', 'SUM(Операции!$H$5:$H$604)')), 'B28'));
  const expenses = ['Жильё и аренда','Коммунальные услуги','Продукты','Кафе и доставка','Транспорт','Связь и интернет','Здоровье и аптека','Спорт и зал','Бытовые покупки','Одежда и личное','Подписки и сервисы','Виза и документы','Путешествия','Развлечения','Подарки и помощь','Комиссии и обмен валюты','Прочее'];
  const categories = [...expenses.map((name) => [name, 'Расход']), ...['Работа / зарплата','Фриланс / подработки','Возврат / компенсация','Прочие доходы'].map((name) => [name, 'Доход'])];
  const lists = categories.map(([name, type], i) => {
    const r = i + 2;
    let text = cell(`A${r}`, name) + cell(`B${r}`, type);
    for (const [col, values] of [['D',['RUB','USD','GEL']],['F',['Карта','Наличные','Перевод']],['H',['Обязательная','Гибкая']],['J',['Доход','Расход','Перевод']]]) {
      if (values[i]) text += cell(`${col}${r}`, values[i]);
    }
    return row(r, text);
  }).join('');
  zip.file('xl/worksheets/sheet4.xml', sheet(lists, 'J22'));
  zip.file('xl/workbook.xml', `<workbook xmlns="${ns}" xmlns:r="${rel}"><bookViews><workbookView/></bookViews><sheets>${names.map((name, i) => `<sheet name="${name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${rel}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`);
  zip.file('_rels/.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file('[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/tables/table1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/></Types>`);
  if (preparedRows !== 600) {
    for (const name of ['xl/worksheets/sheet1.xml', 'xl/tables/table1.xml', 'xl/worksheets/sheet3.xml']) {
      zip.file(name, (await zip.file(name).async('string')).replace(/(:\$?[A-Z]+\$?)604\b/g, (_, prefix) => prefix + (preparedRows + 4)));
    }
  }
  await writeFile(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}
