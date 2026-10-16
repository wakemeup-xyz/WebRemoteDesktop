// A deadline bounds a caller's wait, not the browser's underlying script execution.
function createAssetLoader({ document, setTimer = setTimeout, clearTimer = clearTimeout, request } = {}) {
  const resources = new Map();

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
      const timer = setTimer(() => reject(Object.assign(new Error('Asset load timed out'), { code: 'asset-timeout' })), timeoutMs);
      resource.pending.then(() => { clearTimer(timer); resolve(); }, (error) => { clearTimer(timer); reject(error); });
    });
  }

  return { load, status(url) { return resources.get(url)?.state || 'idle'; } };
}

if (typeof globalThis !== 'undefined') globalThis.createAssetLoader = createAssetLoader;
if (typeof module !== 'undefined' && module.exports) module.exports = { createAssetLoader };
