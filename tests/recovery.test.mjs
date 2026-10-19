import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import JSZip from 'jszip';
import { createFixture } from './create-fixture.mjs';
import { validateWorkbookFile } from '../server.js';
import { digest } from '../lib/workbook-store.mjs';
import { exportRecoveryBundle, verifyRecoveryBundle, rehearseRecovery } from '../lib/recovery-bundle.mjs';

test('recovery bundle verifies bytes and rehearses only into a new directory', async (t) => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'finance-recovery-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const workbook = path.join(directory, 'source.xlsx');
  await createFixture(workbook);
  const original = digest(await fs.readFile(workbook));
  const bundle = await exportRecoveryBundle(workbook, path.join(directory, 'external-simulation'), validateWorkbookFile);
  assert.equal((await verifyRecoveryBundle(bundle)).manifest.sha256, original);
  const restored = await rehearseRecovery(bundle, path.join(directory, 'rehearsal'), validateWorkbookFile);
  assert.equal(digest(await fs.readFile(restored.target)), original);
  await assert.rejects(rehearseRecovery(bundle, directory, validateWorkbookFile));
  assert.equal(digest(await fs.readFile(workbook)), original);
  const zip = await JSZip.loadAsync(await fs.readFile(bundle));
  zip.file('workbook.xlsx', 'damaged');
  const corrupt = path.join(directory, 'corrupt.zip');
  await fs.writeFile(corrupt, await zip.generateAsync({ type: 'nodebuffer' }));
  await assert.rejects(verifyRecoveryBundle(corrupt));
});
