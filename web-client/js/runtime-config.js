const RuntimeConfig = {
  normalizeBase(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    return raw.replace(/\/+$/, '');
  },

  getApiBase() {
    const injected = this.normalizeBase(window.__WRD_API_BASE__);
    if (injected) return injected;

    const stored = this.normalizeBase(localStorage.getItem('wrdApiBase'));
    if (stored) return stored;

    return this.normalizeBase(window.location.origin);
  },

  getSocketBase() {
    return this.getApiBase();
  },

  url(path) {
    const normalizedPath = String(path || '').startsWith('/')
      ? String(path || '')
      : `/${path || ''}`;
    return `${this.getApiBase()}${normalizedPath}`;
  },
};
