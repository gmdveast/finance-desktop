import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const zip = new JSZip();
const extensions = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.css', '.html', '.svg', '.bat']);
async function addDirectory(relative) {
  for (const item of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    if (item.isSymbolicLink()) throw new Error('Source bundle refuses symbolic links');
    const name = `${relative}/${item.name}`;
    if (item.isDirectory()) await addDirectory(name);
    else if (extensions.has(path.extname(item.name)) && !item.name.startsWith('.')) zip.file(name, await fs.readFile(path.join(root, name)));
  }
}
for (const directory of ['public', 'lib', 'scripts', 'tests', 'contracts', 'examples', 'obsidian-plugin/finance-capture']) await addDirectory(directory);
for (const name of ['server.js', 'package.json', 'package-lock.json', 'README.md', 'playwright.config.js', '.gitignore', '.nvmrc', 'start-finance.bat', 'stop-finance.bat', 'finance.config.example.json']) zip.file(name, await fs.readFile(path.join(root, name)));
const files = Object.keys(zip.files).filter((name) => !zip.files[name].dir);
if (files.some((name) => /\.(?:xlsx?|xlsm)$|(?:^|\/)finance\.config\.json$|(?:^|\/)data\.json$|finance-runtime|(?:^|\/)(?:local-data|backups|mobile-sync|docs)(?:\/|$)|(?:^|\/)(?:AGENTS|PLAN)\.md$/i.test(name))) throw new Error('Private or internal file in source bundle');
await fs.mkdir(path.join(root, '.release'), { recursive: true });
const target = path.join(root, '.release', 'finance-source.zip');
await fs.writeFile(target, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
console.log(`Created ${target}: ${files.length} source files; docs, internal instructions, workbook, runtime token, local config and plugin data.json are excluded.`);
