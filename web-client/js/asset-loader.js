// One fixed same-origin query per page, including body parsing, with no reload or
// script substitution. Unknown results never claim that a build was retired.
function createManifestVersionCheck({
  build = globalThis.__WRD_BUILD__, fetchImpl = globalThis.fetch,
  timeoutMs = 8000, setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  let checked = null;
  return function check() {
    if (checked) return checked;
    if (!/^[a-f0-9]{16}$/.test(build?.id || '') || typeof fetchImpl !== 'function') return Promise.resolve(false);
    const fetchJson = typeof fetchJsonWithin === 'function' ? fetchJsonWithin : require('./bounded-request').fetchJsonWithin;
    checked = fetchJson('/asset-manifest.json', { cache: 'no-store', credentials: 'same-origin' }, {
      timeoutMs: Math.max(1, Math.min(8000, Number(timeoutMs) || 8000)), fetchImpl, setTimer, clearTimer,
    }).then(({ ok, data }) => {
      if (!ok || data?.schemaVersion !== 2 || !Array.isArray(data.retainedReleases) || data.retainedReleases.length > 2) return false;
      const releases = [data, ...data.retainedReleases];
      if (!releases.every((release) => /^[a-f0-9]{16}$/.test(release?.buildId || '')
        && Number.isSafeInteger(release.builtAt) && release.builtAt >= 0
        && release.assets && typeof release.assets === 'object' && !Array.isArray(release.assets)
        && Object.values(release.assets).length > 0 && Object.values(release.assets).length <= 32
        && Object.values(release.assets).every((value) => /^assets\/[a-z0-9-]+\.[a-f0-9]{16}\.(js|css)$/.test(value)))) return false;
      return !releases.some((release) => release.buildId === build.id);
    }).catch(() => false);
    return checked;
  };
}

let sharedManifestVersionCheck = null;

// A deadline bounds a caller's wait, not the browser's underlying script execution.
function createAssetLoader({ document, setTimer = setTimeout, clearTimer = clearTimeout, request,
  versionCheck, onRefreshRequired = () => {},
} = {}) {
  const resources = new Map();
  let retired = false;
  const refreshError = () => Object.assign(new Error('页面版本已淘汰，请先保存未完成草稿再刷新页面'), { code: 'refresh-required' });
  function failed() {
    const check = versionCheck || (sharedManifestVersionCheck ||= createManifestVersionCheck());
    Promise.resolve().then(check).then((isRetired) => {
      if (!isRetired || retired) return;
      retired = true;
      onRefreshRequired(refreshError());
    }).catch(() => {});
  }

  function append({ url, kind }) {
    return new Promise((resolve, reject) => {
      const node = document.createElement(kind === 'style' ? 'link' : 'script');
      if (kind === 'style') {
        node.rel = 'stylesheet';
        node.href = url;
      } else {
        node.src = url;
        node.async = true;
      }
      node.onload = () => resolve();
      node.onerror = () => reject(new Error('Asset network error'));
      (kind === 'style' ? document.head : document.body || document.head).appendChild(node);
      // Never remove an unknown pending script: removal does not cancel execution.
    });
  }

  function load({ url, kind, timeoutMs = 5000 } = {}) {
    if (!url || !['style', 'script'].includes(kind)) return Promise.reject(new Error('Invalid asset'));
    if (retired) return Promise.reject(refreshError());
    let resource = resources.get(url);
    if (resource && resource.kind !== kind) return Promise.reject(new Error('Asset kind mismatch'));
    if (!resource || resource.state === 'error') {
      resource = { kind, state: 'loading', pending: null };
      resources.set(url, resource);
      // Cache before starting the request, including synchronous adapter errors.
      resource.pending = Promise.resolve().then(() => request ? request({ url, kind }, append) : append({ url, kind })).then(() => {
        resource.state = 'loaded';
      }, (error) => {
        resource.state = 'error';
        throw error;
      });
    }
    if (resource.state === 'loaded') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimer(() => { failed(); reject(Object.assign(new Error('Asset load timed out'), { code: 'asset-timeout' })); }, timeoutMs);
      resource.pending.then(() => { clearTimer(timer); resolve(); }, (error) => { clearTimer(timer); failed(); reject(error); });
    });
  }

  return { load, status(url) { return resources.get(url)?.state || 'idle'; },
    getRefreshError() { return retired ? refreshError() : null; } };
}

if (typeof globalThis !== 'undefined') globalThis.createAssetLoader = createAssetLoader;
if (typeof module !== 'undefined' && module.exports) module.exports = { createAssetLoader, createManifestVersionCheck };
