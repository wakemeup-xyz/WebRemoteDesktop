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
  let generation = 0;
  let disposed = false;
  let initialization = null;
  const assetFactory = typeof createAssetLoader === 'function' ? createAssetLoader : require('./asset-loader').createAssetLoader;
  const loader = assetFactory({
    document, setTimer, clearTimer,
    ...(loadStyle || loadScript ? { request: ({ url, kind }, append) => {
      const adapter = kind === 'style' ? loadStyle : loadScript;
      return adapter ? adapter(url) : append({ url, kind });
    } } : {}),
  });

  function load({ force = false } = {}) {
    if (disposed) return Promise.reject(new Error('Terminal loader disposed'));
    if (state.state === 'ready') return Promise.resolve(getTerminalPanel());
    if (inflight && !force) return inflight;
    const operation = ++generation;
    state = Object.freeze({ state: 'loading', error: null });
    let timer;
    const work = Promise.resolve().then(async () => {
      if (assets?.terminalJs && assets?.terminalCss) {
        await Promise.all([
          loader.load({ url: assets.terminalCss, kind: 'style', timeoutMs }),
          loader.load({ url: assets.terminalJs, kind: 'script', timeoutMs }),
        ]);
      } else if (assets) {
        throw new Error('Terminal assets unavailable');
      }
      if (disposed || operation !== generation) throw new Error('Terminal load superseded');
      const panel = getTerminalPanel();
      if (typeof panel?.init !== 'function') {
        throw Object.assign(new Error('Terminal 模块未完成注册，请刷新页面（先保存未完成草稿）'), { code: 'refresh-required' });
      }
      if (!initialization) {
        initialization = Promise.resolve().then(() => panel.init()).catch(() => {
          throw Object.assign(new Error('Terminal 初始化未完成，请刷新页面（先保存未完成草稿）'), { code: 'refresh-required' });
        });
      }
      await initialization;
      return panel;
    });
    const current = Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimer(() => reject(Object.assign(new Error('Terminal assets timed out'), { code: 'asset-timeout' })), timeoutMs);
      }),
    ]).then((panel) => {
      if (disposed || operation !== generation) throw new Error('Terminal load superseded');
      state = Object.freeze({ state: 'ready', error: null });
      return panel;
    }).catch((error) => {
      if (!disposed && operation === generation) {
        // Invalidate callbacks from work that outlives this operation's deadline.
        generation++;
        state = Object.freeze({ state: 'failed', error, refreshRequired: error.code === 'refresh-required' });
      }
      throw error;
    }).finally(() => {
      clearTimer(timer);
      if (inflight === current) inflight = null;
    });
    inflight = current;
    return current;
  }

  return {
    load,
    retry() { return load({ force: true }); },
    dispose() { disposed = true; generation++; state = Object.freeze({ state: 'disposed', error: null }); },
    getState() { return state; },
  };
}

if (typeof globalThis !== 'undefined') globalThis.createTerminalLoader = createTerminalLoader;
if (typeof module !== 'undefined' && module.exports) module.exports = { createTerminalLoader };
