import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function tokenizeJson(source, file) {
  const tokens = [];
  let offset = 0;
  while (offset < source.length) {
    if (/\s/u.test(source[offset])) { offset += 1; continue; }
    const start = offset;
    const char = source[offset];
    if ('{}[]:,'.includes(char)) {
      tokens.push({ type: char, value: char });
      offset += 1;
      continue;
    }
    if (char === '"') {
      offset += 1;
      while (offset < source.length) {
        if (source[offset] === '\\') { offset += 2; continue; }
        if (source[offset] === '"') { offset += 1; break; }
        offset += 1;
      }
      const value = source.slice(start, offset);
      try { JSON.parse(value); } catch { throw new Error(`${file}: invalid JSON string at byte ${start}.`); }
      tokens.push({ type: 'string', value });
      continue;
    }
    const literal = source.slice(offset).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u)?.[0];
    if (!literal) throw new Error(`${file}: unexpected token at byte ${offset}.`);
    tokens.push({ type: 'literal', value: literal });
    offset += literal.length;
  }
  return tokens;
}

function rejectDuplicateKeys(source, file) {
  const tokens = tokenizeJson(source, file);
  let cursor = 0;
  const take = (type) => {
    const token = tokens[cursor++];
    if (!token || (type && token.type !== type)) throw new Error(`${file}: expected ${type || 'a JSON value'} at token ${cursor}.`);
    return token;
  };
  const parseValue = () => {
    const token = tokens[cursor];
    if (!token) throw new Error(`${file}: unexpected end of JSON.`);
    if (token.type === '{') {
      take('{');
      const keys = new Set();
      if (tokens[cursor]?.type === '}') { take('}'); return; }
      while (true) {
        const key = JSON.parse(take('string').value);
        if (keys.has(key)) throw new Error(`${file}: duplicate key ${JSON.stringify(key)}.`);
        keys.add(key);
        take(':');
        parseValue();
        const separator = take();
        if (separator.type === '}') return;
        if (separator.type !== ',') throw new Error(`${file}: expected ',' or '}' at token ${cursor}.`);
      }
    }
    if (token.type === '[') {
      take('[');
      if (tokens[cursor]?.type === ']') { take(']'); return; }
      while (true) {
        parseValue();
        const separator = take();
        if (separator.type === ']') return;
        if (separator.type !== ',') throw new Error(`${file}: expected ',' or ']' at token ${cursor}.`);
      }
    }
    if (token.type === 'string') { take('string'); return; }
    if (token.type === 'literal') { take('literal'); return; }
    throw new Error(`${file}: unexpected ${token.type} at token ${cursor + 1}.`);
  };
  parseValue();
  if (cursor !== tokens.length) throw new Error(`${file}: trailing data after JSON value.`);
}

function readCatalog(locale) {
  const filename = path.join(root, 'public', 'locales', `${locale}.json`);
  const source = readFileSync(filename, 'utf8');
  rejectDuplicateKeys(source, `public/locales/${locale}.json`);
  return JSON.parse(source);
}

const catalogs = { ru: readCatalog('ru'), en: readCatalog('en') };
const requiredSections = ['messages', 'fragments', 'plurals'];
for (const section of requiredSections) {
  const ru = catalogs.ru[section];
  const en = catalogs.en[section];
  if (!ru || typeof ru !== 'object' || Array.isArray(ru) || !en || typeof en !== 'object' || Array.isArray(en)) {
    throw new Error(`Locale section "${section}" must be an object in both catalogs.`);
  }
  const ruKeys = Object.keys(ru).sort();
  const enKeys = Object.keys(en).sort();
  if (JSON.stringify(ruKeys) !== JSON.stringify(enKeys)) {
    const missing = ruKeys.filter((key) => !Object.hasOwn(en, key));
    const extra = enKeys.filter((key) => !Object.hasOwn(ru, key));
    throw new Error(`Locale section "${section}" differs. Missing in en: ${missing.join(', ') || 'none'}; extra in en: ${extra.join(', ') || 'none'}.`);
  }
}

for (const locale of ['ru', 'en']) {
  const catalog = catalogs[locale];
  for (const section of ['messages', 'fragments']) {
    for (const [key, value] of Object.entries(catalog[section])) {
      if (!key || typeof value !== 'string') throw new Error(`${locale}.${section} must map non-empty string keys to string values.`);
    }
  }
  for (const [key, forms] of Object.entries(catalog.plurals)) {
    if (!forms || typeof forms !== 'object' || Array.isArray(forms) || typeof forms.other !== 'string') {
      throw new Error(`${locale}.plurals.${key} must define an "other" form.`);
    }
    if (Object.values(forms).some((value) => typeof value !== 'string')) throw new Error(`${locale}.plurals.${key} forms must be strings.`);
  }
}

for (const code of Object.keys(catalogs.en.errors || {})) {
  if (typeof catalogs.en.errors[code] !== 'string' || !code) throw new Error(`en.errors.${code} must be a non-empty code and string translation.`);
}

const en = catalogs.en;
const translate = (source) => {
  if (Object.hasOwn(en.messages, source)) return en.messages[source];
  let value = source;
  for (const [from, to] of Object.entries(en.fragments).sort((a, b) => b[0].length - a[0].length)) {
    if (from) value = value.split(from).join(to);
  }
  return value;
};
const missingDirectTranslations = [];
for (const file of ['public/app.js', 'public/setup.js']) {
  const source = readFileSync(path.join(root, file), 'utf8');
  const directTranslateCall = /\btranslate\(\s*(['"])((?:\\.|(?!\1).)*)\1/gu;
  for (const match of source.matchAll(directTranslateCall)) {
    const key = match[2].replace(/\\(['"\\])/gu, '$1');
    if (/[А-Яа-яЁё]/u.test(key) && translate(key) === key && key !== 'Русский') {
      const line = source.slice(0, match.index).split('\n').length;
      missingDirectTranslations.push(`${file}:${line}: ${JSON.stringify(key)}`);
    }
  }
}
if (missingDirectTranslations.length) throw new Error(`Missing English translations for direct translate() calls:\n${missingDirectTranslations.join('\n')}`);

process.stdout.write(`Locale catalogs valid: ${Object.keys(catalogs.ru.messages).length} messages, ${Object.keys(catalogs.ru.fragments).length} fragments, ${Object.keys(catalogs.ru.plurals).length} plural groups.\n`);
