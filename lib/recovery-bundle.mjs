import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { acquireWorkbookLock, digest } from './workbook-store.mjs';

const MAX_RECOVERY_WORKBOOK_BYTES = 256 * 1024 * 1024;
const MAX_RECOVERY_MANIFEST_BYTES = 16 * 1024;

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
  const archive = await JSZip.loadAsync(await fs.readFile(file), { checkCRC32: false });
  const entries = Object.values(archive.files);
  if (entries.length !== 2 || entries.some((entry) => entry.dir)
    || !archive.file('manifest.json') || !archive.file('workbook.xlsx')) throw new Error('Recovery bundle contents are invalid');
  const manifestEntry = archive.file('manifest.json');
  const workbookEntry = archive.file('workbook.xlsx');
  const manifestSize = manifestEntry._data?.uncompressedSize;
  const workbookSize = workbookEntry._data?.uncompressedSize;
  if (!Number.isSafeInteger(manifestSize) || manifestSize < 1 || manifestSize > MAX_RECOVERY_MANIFEST_BYTES
    || !Number.isSafeInteger(workbookSize) || workbookSize < 1 || workbookSize > MAX_RECOVERY_WORKBOOK_BYTES) throw new Error('Recovery bundle is too large or invalid');
  const manifestText = await manifestEntry.async('string');
  if (Buffer.byteLength(manifestText, 'utf8') > MAX_RECOVERY_MANIFEST_BYTES) throw new Error('Recovery manifest is too large');
  const manifest = JSON.parse(manifestText);
  if (!manifest || manifest.schema !== 1 || typeof manifest.createdAt !== 'string'
    || !Number.isFinite(Date.parse(manifest.createdAt)) || !Number.isSafeInteger(manifest.bytes)
    || manifest.bytes < 1 || manifest.bytes > MAX_RECOVERY_WORKBOOK_BYTES
    || typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(manifest.sha256)) throw new Error('Recovery manifest is invalid');
  const workbook = await workbookEntry.async('nodebuffer');
  if (workbook.length !== manifest.bytes || digest(workbook) !== manifest.sha256) throw new Error('Recovery bundle integrity check failed');
  return { manifest, workbook };
}

export async function rehearseRecovery(file, directory, validate) {
  const verified = await verifyRecoveryBundle(file);
  return rehearseRecoveryContents(verified, directory, validate);
}

export async function rehearseRecoveryContents({ manifest, workbook }, directory, validate) {
  // A new directory is mandatory: never overwrite a live or previously recovered book.
  await fs.mkdir(directory);
  const target = path.join(directory, 'workbook.xlsx');
  try {
    await fs.writeFile(target, workbook, { flag: 'wx' });
    const checked = await validate(target);
    if (checked?.revision && checked.revision !== manifest.sha256) throw new Error('Rehearsal workbook revision did not match the archive');
    return { target, sha256: manifest.sha256, manifest };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}
