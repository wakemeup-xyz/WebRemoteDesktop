function createTerminalLoader({
  assets,
  document,
  timeoutMs = 5000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  loadStyle,
  loadScript,
  getTerminalPanel = () => globalThis.TerminalPanel,
} = {}) {
  let state = Object.freeze({ state: 'idle', error: null });
  let inflight = null;

  function appendStyle(href) {
    return new Promise((resolve, reject) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.onload = resolve;
      link.onerror = () => reject(new Error('Terminal stylesheet failed'));
      document.head.appendChild(link);
    });
  }

  function appendScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = () => reject(new Error('Terminal script failed'));
      document.body.appendChild(script);
    });
  }

  const loadCss = loadStyle || appendStyle;
  const loadJs = loadScript || appendScript;

  function ensureInitialized() {
    const panel = getTerminalPanel();
    if (!panel?.init) throw new Error('Terminal module did not register');
    panel.init();
    state = Object.freeze({ state: 'ready', error: null });
    return panel;
  }

  function loadAssets() {
    const panel = getTerminalPanel();
    if (panel && typeof panel.init === 'function') {
      return Promise.resolve();
    }
    if (!assets?.terminalJs || !assets?.terminalCss) {
      return Promise.reject(new Error('Terminal assets unavailable'));
    }
    return Promise.all([
      loadCss(assets.terminalCss),
      loadJs(assets.terminalJs),
    ]);
  }

  function load({ force = false } = {}) {
    if (state.state === 'ready' && !force) return Promise.resolve(getTerminalPanel());
    if (inflight && !force) return inflight;
    state = Object.freeze({ state: 'loading', error: null });
    let timer;
    inflight = Promise.race([
      loadAssets(),
      new Promise((_, reject) => {
        timer = setTimer(() => reject(new Error('Terminal assets timed out')), timeoutMs);
      }),
    ]).then(() => ensureInitialized()).catch((error) => {
      state = Object.freeze({ state: 'failed', error });
      throw error;
    }).finally(() => {
      if (timer) clearTimer(timer);
      inflight = null;
    });
    return inflight;
  }

  return {
    load,
    retry() { return load({ force: true }); },
    getState() { return state; },
  };
}

if (typeof globalThis !== 'undefined') globalThis.createTerminalLoader = createTerminalLoader;
if (typeof module !== 'undefined' && module.exports) module.exports = { createTerminalLoader };
