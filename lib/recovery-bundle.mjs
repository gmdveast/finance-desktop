import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { acquireWorkbookLock, digest } from './workbook-store.mjs';

export async function exportRecoveryBundle(workbook, directory, validate) {
  const release = await acquireWorkbookLock(workbook);
  let bytes;
  try {
    const info = await fs.lstat(workbook);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw new Error('Expected ordinary workbook file');
    const book = await validate(workbook);
    bytes = await fs.readFile(workbook);
    if (book.revision !== digest(bytes)) throw new Error('Workbook changed during backup');
  } finally { await release(); }
  const zip = new JSZip();
  zip.file('workbook.xlsx', bytes);
  zip.file('manifest.json', JSON.stringify({ schema: 1, createdAt: new Date().toISOString(), sha256: digest(bytes), bytes: bytes.length }, null, 2));
  await fs.mkdir(directory, { recursive: true });
  const target = path.join(directory, `finance-recovery-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.zip`);
  const temporary = `${target}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx');
    try { await handle.writeFile(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })); await handle.sync(); }
    finally { await handle.close(); }
    await verifyRecoveryBundle(temporary);
    await fs.rename(temporary, target);
    return target;
  } finally { await fs.unlink(temporary).catch(() => {}); }
}

export async function verifyRecoveryBundle(file) {
  const archive = await JSZip.loadAsync(await fs.readFile(file), { checkCRC32: true });
  const manifest = JSON.parse(await archive.file('manifest.json')?.async('string'));
  const workbook = await archive.file('workbook.xlsx')?.async('nodebuffer');
  if (manifest.schema !== 1 || !workbook || workbook.length !== manifest.bytes || digest(workbook) !== manifest.sha256) throw new Error('Recovery bundle integrity check failed');
  return { manifest, workbook };
}

export async function rehearseRecovery(file, directory, validate) {
  const { manifest, workbook } = await verifyRecoveryBundle(file);
  // A new directory is mandatory: never overwrite a live or previously recovered book.
  await fs.mkdir(directory);
  const target = path.join(directory, 'workbook.xlsx');
  await fs.writeFile(target, workbook, { flag: 'wx' });
  await validate(target);
  return { target, sha256: manifest.sha256 };
}
