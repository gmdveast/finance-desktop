import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { compareVersions, createUpdateService, DESKTOP_REPOSITORY } from '../lib/update-service.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const release = (version, { digest = null, includeChecksum = false, notes = '' } = {}) => {
  const tag = `v${version}`;
  const installer = `Finance-Setup-${version}-x64.exe`;
  const asset = (name, assetDigest) => ({
    name,
    digest: assetDigest,
    browser_download_url: `https://github.com/${DESKTOP_REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`,
  });
  const assets = [asset(installer, digest ? `sha256:${digest}` : null)];
  if (includeChecksum) assets.push(asset(`${installer}.sha256`, null));
  return {
    tag_name: tag,
    prerelease: version.includes('-'),
    draft: false,
    published_at: '2026-10-20T10:00:00Z',
    body: notes,
    assets,
  };
};

function releaseFetch(releases, installerBytes = Buffer.from('verified installer'), checksumText = '') {
  const responses = [];
  return async (url) => {
    const target = String(url);
    if (target.startsWith(`https://api.github.com/repos/${DESKTOP_REPOSITORY}/releases`)) {
      return new Response(JSON.stringify(releases), { headers: { 'content-type': 'application/json' } });
    }
    if (target.endsWith('.exe')) return new Response(installerBytes, { headers: { 'content-length': String(installerBytes.length) } });
    if (target.endsWith('.exe.sha256')) return new Response(checksumText, { headers: { 'content-type': 'text/plain' } });
    responses.push(target);
    return new Response('not found', { status: 404 });
  };
}

test('semantic versions order stable above prerelease and compare prerelease identifiers correctly', () => {
  assert.equal(compareVersions('1.2.0-beta.2', '1.2.0-beta.10'), -1);
  assert.equal(compareVersions('1.2.0-beta.10', '1.2.0'), -1);
  assert.equal(compareVersions('1.2.0', '1.1.9'), 1);
});

test('beta channel sees beta and stable releases and chooses the newest compatible version', async () => {
  const releases = [
    release('1.5.0-beta.9', { digest: 'a'.repeat(64) }),
    release('1.4.0', { digest: 'b'.repeat(64) }),
    release('1.3.0-beta.20', { digest: 'c'.repeat(64) }),
  ];
  const service = createUpdateService({ currentVersion: '1.3.0-beta.2', channel: 'beta', fetchImpl: releaseFetch(releases) });
  assert.deepEqual((await service.check()).update, {
    version: '1.5.0-beta.9', channel: 'beta', publishedAt: '2026-10-20T10:00:00Z', notes: '',
    url: 'https://github.com/gmdveast/finance-desktop/releases/tag/v1.5.0-beta.9',
    installerName: 'Finance-Setup-1.5.0-beta.9-x64.exe',
  });
});

test('stable channel skips beta releases even when they have a higher version', async () => {
  const releases = [
    release('2.0.0-beta.1', { digest: 'a'.repeat(64) }),
    release('1.9.0', { digest: 'b'.repeat(64) }),
  ];
  const service = createUpdateService({ currentVersion: '1.8.0', channel: 'stable', fetchImpl: releaseFetch(releases) });
  assert.equal((await service.check()).update.version, '1.9.0');
});

test('development builds do not contact GitHub', async () => {
  let called = false;
  const service = createUpdateService({ currentVersion: '1.0.0', channel: 'development', fetchImpl: async () => { called = true; } });
  assert.equal((await service.check()).enabled, false);
  assert.equal(called, false);
});

test('installer bytes must match the published SHA-256 digest', async () => {
  const bytes = Buffer.from('verified installer');
  const releases = [release('1.0.1', { digest: hash(bytes) })];
  const service = createUpdateService({ currentVersion: '1.0.0', channel: 'stable', fetchImpl: releaseFetch(releases, bytes) });
  const downloaded = await service.downloadInstaller('1.0.1');
  assert.equal(downloaded.sha256, hash(bytes));
  assert.deepEqual(downloaded.bytes, bytes);

  const tampered = createUpdateService({ currentVersion: '1.0.0', channel: 'stable', fetchImpl: releaseFetch(releases, Buffer.from('tampered')) });
  await assert.rejects(tampered.downloadInstaller('1.0.1'), /checksum does not match/);
});

test('installer body may outlast the response-header timeout and is still verified', async () => {
  const bytes = Buffer.from('a deliberately delayed installer body');
  const releases = [release('1.0.1', { digest: hash(bytes) })];
  const fetchImpl = async (url) => {
    if (String(url).startsWith(`https://api.github.com/repos/${DESKTOP_REPOSITORY}/releases`)) {
      return new Response(JSON.stringify(releases), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 8));
        setTimeout(() => {
          controller.enqueue(bytes.subarray(8));
          controller.close();
        }, 40);
      },
    }), { headers: { 'content-length': String(bytes.length) } });
  };
  const service = createUpdateService({
    currentVersion: '1.0.0',
    channel: 'stable',
    fetchImpl,
    downloadTimeouts: { request: 10, idle: 100, total: 200 },
  });

  assert.deepEqual((await service.downloadInstaller('1.0.1')).bytes, bytes);
});

test('installer download fails when the response body stops making progress', async () => {
  const bytes = Buffer.from('installer body');
  const releases = [release('1.0.1', { digest: hash(bytes) })];
  const fetchImpl = async (url) => {
    if (String(url).startsWith(`https://api.github.com/repos/${DESKTOP_REPOSITORY}/releases`)) {
      return new Response(JSON.stringify(releases), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(new ReadableStream({ start() {} }), { headers: { 'content-length': String(bytes.length) } });
  };
  const service = createUpdateService({
    currentVersion: '1.0.0',
    channel: 'stable',
    fetchImpl,
    downloadTimeouts: { request: 100, idle: 10, total: 100 },
  });

  await assert.rejects(service.downloadInstaller('1.0.1'), /download timed out/);
});

test('checksum sidecar fallback validates its filename and hash before returning bytes', async () => {
  const bytes = Buffer.from('installer body');
  const version = '1.0.1';
  const name = `Finance-Setup-${version}-x64.exe`;
  const releases = [release(version, { includeChecksum: true })];
  const service = createUpdateService({
    currentVersion: '1.0.0',
    channel: 'stable',
    fetchImpl: releaseFetch(releases, bytes, `${hash(bytes)}  ${name}\n`),
  });
  assert.deepEqual((await service.downloadInstaller(version)).bytes, bytes);
});

test('releases without a valid downloadable installer are not offered', async () => {
  const invalid = release('1.0.1');
  invalid.assets[0].browser_download_url = 'https://example.invalid/installer.exe';
  const service = createUpdateService({ currentVersion: '1.0.0', channel: 'stable', fetchImpl: releaseFetch([invalid]) });
  assert.equal((await service.check()).update, null);
});
