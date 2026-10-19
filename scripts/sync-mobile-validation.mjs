import { readFile, writeFile } from 'node:fs/promises';

const file = new URL('../obsidian-plugin/finance-capture/main.js', import.meta.url);
const source = (await readFile(new URL('../lib/input-boundary.mjs', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const pure = source.split('export function localHttpBoundary')[0].replace(/^export /gm, '').trim();
const block = `// BEGIN GENERATED INPUT VALIDATION\n${pure}\n// END GENERATED INPUT VALIDATION`;
const plugin = (await readFile(file, 'utf8')).replace(/\r\n/g, '\n');
const pattern = /\/\/ BEGIN GENERATED INPUT VALIDATION[\s\S]*?\/\/ END GENERATED INPUT VALIDATION/;
if (process.argv.includes('--check')) {
  if (plugin.match(pattern)?.[0] !== block) throw new Error('Mobile validators are stale: node scripts/sync-mobile-validation.mjs');
} else {
  const updated = pattern.test(plugin) ? plugin.replace(pattern, () => block) : plugin.replace('\n', `\n\n${block}\n`);
  await writeFile(file, updated);
}
