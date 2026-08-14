const ChromeLayout = {
  init() {
    const statusEl = typeof document !== 'undefined' ? document.getElementById('statusBar') : null;
    return this.observeStatusBar(statusEl);
  },
  syncChromeTop(px, rootEl) {
    const height = Number(px);
    if (!Number.isFinite(height) || height <= 0) return;
    const root = rootEl || (typeof document !== 'undefined' ? document.documentElement : null);
    root?.style?.setProperty('--chrome-top', `${Math.round(height)}px`);
  },
  observeStatusBar(statusEl, rootEl) {
    if (!statusEl || typeof ResizeObserver === 'undefined') return () => {};
    const apply = () => this.syncChromeTop(statusEl.offsetHeight, rootEl);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(statusEl);
    return () => ro.disconnect();
  },
};

if (typeof globalThis !== 'undefined') globalThis.ChromeLayout = ChromeLayout;
if (typeof module !== 'undefined' && module.exports) module.exports = { ChromeLayout };
