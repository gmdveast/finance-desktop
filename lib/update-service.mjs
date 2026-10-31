import { createHash } from 'node:crypto';

export const DESKTOP_REPOSITORY = 'gmdveast/finance-desktop';
const RELEASES_URL = `https://api.github.com/repos/${DESKTOP_REPOSITORY}/releases?per_page=100`;
const MAX_INSTALLER_BYTES = 250 * 1024 * 1024;
const SAFE_DOWNLOAD_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
const DEFAULT_DOWNLOAD_TIMEOUTS = Object.freeze({ request: 30000, idle: 90000, total: 10 * 60 * 1000 });

function parseVersion(value) {
  const match = String(value || '').replace(/^v/, '').match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  const prerelease = match[4]?.split('.') || [];
  if (prerelease.some((part) => !part || (/^\d+$/.test(part) && part.length > 1 && part.startsWith('0')))) return null;
  return { text: match[0], major: BigInt(match[1]), minor: BigInt(match[2]), patch: BigInt(match[3]), prerelease };
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new TypeError('Versions must use semantic versioning.');
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length ? -1 : 1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index++) {
    const av = a.prerelease[index];
    const bv = b.prerelease[index];
    if (av === undefined || bv === undefined) return av === undefined ? -1 : 1;
    if (av === bv) continue;
    const an = /^\d+$/.test(av);
    const bn = /^\d+$/.test(bv);
    if (an && bn) return BigInt(av) < BigInt(bv) ? -1 : 1;
    if (an !== bn) return an ? -1 : 1;
    return av < bv ? -1 : 1;
  }
  return 0;
}

function releaseVersion(release) {
  const version = parseVersion(release?.tag_name);
  return version?.text || null;
}

function expectedInstallerName(version) {
  return `Finance-Setup-${version}-x64.exe`;
}

function checkedAsset(release, name) {
  const asset = release.assets?.find((item) => item?.name === name);
  if (!asset || typeof asset.browser_download_url !== 'string') return null;
  const encodedTag = encodeURIComponent(release.tag_name);
  const encodedName = encodeURIComponent(name);
  const expectedUrl = `https://github.com/${DESKTOP_REPOSITORY}/releases/download/${encodedTag}/${encodedName}`;
  if (asset.browser_download_url !== expectedUrl) return null;
  return asset;
}

function availableRelease(release) {
  if (!release || release.draft || !release.published_at || typeof release.tag_name !== 'string') return null;
  const version = releaseVersion(release);
  if (!version) return null;
  const prerelease = Boolean(parseVersion(version).prerelease.length);
  if (Boolean(release.prerelease) !== prerelease) return null;
  const installerName = expectedInstallerName(version);
  const installer = checkedAsset(release, installerName);
  if (!installer) return null;
  const digest = typeof installer.digest === 'string' && /^sha256:[a-f0-9]{64}$/i.test(installer.digest)
    ? installer.digest.slice('sha256:'.length).toLowerCase()
    : null;
  const checksumName = `${installerName}.sha256`;
  const checksum = checkedAsset(release, checksumName);
  if (!digest && !checksum) return null;
  return {
    version,
    tag: release.tag_name,
    channel: prerelease ? 'beta' : 'stable',
    publishedAt: release.published_at,
    notes: typeof release.body === 'string' ? release.body.slice(0, 6000) : '',
    url: `https://github.com/${DESKTOP_REPOSITORY}/releases/tag/${encodeURIComponent(release.tag_name)}`,
    installerName,
    installerUrl: installer.browser_download_url,
    digest,
    checksumUrl: checksum?.browser_download_url || null,
  };
}

function publicRelease(release) {
  return {
    version: release.version,
    channel: release.channel,
    publishedAt: release.publishedAt,
    notes: release.notes,
    url: release.url,
    installerName: release.installerName,
  };
}

async function readLimitedBody(response, { idleTimeoutMs, totalTimeoutMs, onProgress = () => {} }) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_INSTALLER_BYTES) throw new Error('Installer is too large.');
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks = [];
  const deadline = performance.now() + totalTimeoutMs;
  let totalBytes = 0;
  onProgress({ stage: 'downloading', received: 0, total: length > 0 ? length : null });
  try {
    while (true) {
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) throw new Error('Installer download timed out.');
      let timer;
      let result;
      try {
        result = await Promise.race([
          reader.read(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Installer download timed out.')), Math.min(idleTimeoutMs, remainingMs));
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (result.done) break;
      const chunk = Buffer.from(result.value);
      totalBytes += chunk.length;
      if (totalBytes > MAX_INSTALLER_BYTES) throw new Error('Installer is too large.');
      chunks.push(chunk);
      onProgress({ stage: 'downloading', received: totalBytes, total: length > 0 ? length : null });
    }
  } catch (error) {
    try { await reader.cancel(error); } catch {}
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes);
}

export function createUpdateService({ currentVersion, channel, fetchImpl = globalThis.fetch, now = () => Date.now(), downloadTimeouts = DEFAULT_DOWNLOAD_TIMEOUTS } = {}) {
  let releasesCache = null;
  let releasesFetchedAt = 0;

  async function fetchReleases() {
    if (releasesCache && now() - releasesFetchedAt < 10 * 60 * 1000) return releasesCache;
    const response = await fetchImpl(RELEASES_URL, {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Finance-Desktop-Updater' },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Release lookup failed (${response.status}).`);
    const payload = await response.json();
    if (!Array.isArray(payload)) throw new Error('Release list is invalid.');
    releasesCache = payload.map(availableRelease).filter(Boolean);
    releasesFetchedAt = now();
    return releasesCache;
  }

  async function check() {
    const installed = parseVersion(currentVersion);
    if (!installed || !['beta', 'stable'].includes(channel)) {
      return { enabled: false, currentVersion: String(currentVersion || 'development'), channel: channel || 'development', update: null };
    }
    const releases = await fetchReleases();
    const eligible = releases
      .filter((release) => channel === 'beta' || release.channel === 'stable')
      .sort((a, b) => compareVersions(b.version, a.version));
    const latest = eligible[0] || null;
    const update = latest && compareVersions(latest.version, installed.text) > 0 ? publicRelease(latest) : null;
    return { enabled: true, currentVersion: installed.text, channel, update };
  }

  async function getInstallerRelease(version) {
    const releases = await fetchReleases();
    const release = releases.find((item) => item.version === version && (channel === 'beta' || item.channel === 'stable'));
    if (!release || compareVersions(release.version, currentVersion) <= 0) throw new Error('Requested release is unavailable.');
    return release;
  }

  async function fetchAsset(url, accept = '*/*') {
    let target = new URL(url);
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (target.protocol !== 'https:' || !SAFE_DOWNLOAD_HOSTS.has(target.hostname)) throw new Error('Unexpected release download host.');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('Release download request timed out.')), downloadTimeouts.request);
      let response;
      try {
        response = await fetchImpl(target, {
          headers: { Accept: accept, 'User-Agent': 'Finance-Desktop-Updater' },
          redirect: 'manual',
          signal: controller.signal,
        });
      } finally {
        // The request timeout only covers getting response headers. The installer body
        // has its own idle and total limits so slower connections can finish safely.
        clearTimeout(timer);
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get('location');
      if (!location || redirects === 5) throw new Error('Release download redirect is invalid.');
      target = new URL(location, target);
    }
    throw new Error('Release download redirect limit exceeded.');
  }

  async function downloadInstaller(version, { onProgress = () => {} } = {}) {
    const updateStatus = await check();
    if (!updateStatus.update || updateStatus.update.version !== version) throw new Error('Requested release is unavailable.');
    const release = await getInstallerRelease(version);
    let expectedHash = release.digest;
    if (!expectedHash) {
      const checksumResponse = await fetchAsset(release.checksumUrl, 'text/plain');
      if (!checksumResponse.ok) throw new Error('Release checksum is unavailable.');
      const checksumText = (await checksumResponse.text()).trim();
      const escapedName = release.installerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = checksumText.match(new RegExp(`^([a-f0-9]{64})\\s+\\*?${escapedName}$`, 'i'));
      if (!match) throw new Error('Release checksum is invalid.');
      expectedHash = match[1].toLowerCase();
    }
    const installerResponse = await fetchAsset(release.installerUrl);
    if (!installerResponse.ok) throw new Error(`Installer download failed (${installerResponse.status}).`);
    const bytes = await readLimitedBody(installerResponse, {
      idleTimeoutMs: downloadTimeouts.idle,
      totalTimeoutMs: downloadTimeouts.total,
      onProgress,
    });
    onProgress({ stage: 'verifying', received: bytes.length, total: bytes.length });
    if (!bytes.length || createHash('sha256').update(bytes).digest('hex') !== expectedHash) throw new Error('Installer checksum does not match.');
    return { bytes, filename: release.installerName, version: release.version, sha256: expectedHash };
  }

  return { check, downloadInstaller };
}
