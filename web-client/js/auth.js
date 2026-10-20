const TOKEN_KEY = 'wrd_token';

const Auth = {
  _generation: 0,
  _check: null,
  _checkToken: null,
  _checkGeneration: -1,
  _pendingInit: null,
  _listeners: new Set(),
  get API_BASE() {
    if (typeof RuntimeConfig !== 'undefined') return RuntimeConfig.getApiBase();
    return window.location.origin;
  },

  getToken() {
    return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY);
  },

  setToken(token) {
    this._generation++;
    sessionStorage.setItem(TOKEN_KEY, token);
    localStorage.removeItem(TOKEN_KEY);
    this._publishCheck({ state: 'unavailable', reason: 'superseded', httpStatus: null });
  },

  isLoggedIn() { return !!this.getToken(); },

  getGeneration() { return this._generation; },

  getCheck() {
    const token = this.getToken();
    if (this._check && this._checkToken === token && this._checkGeneration === this._generation) return this._check;
    return { state: token ? 'unavailable' : 'unauthorized', reason: token ? 'superseded' : 'missing-token', httpStatus: null };
  },

  isVerified() { return this.getCheck().state === 'verified'; },

  async whenReady() {
    await this._pendingInit;
    return this.isVerified();
  },

  subscribe(listener) {
    this._listeners.add(listener);
    listener(this.getCheck());
    return () => this._listeners.delete(listener);
  },

  _publishCheck(check) {
    this._check = Object.freeze({ ...check });
    this._checkToken = this.getToken();
    this._checkGeneration = this._generation;
    this._listeners.forEach((listener) => listener(this._check));
  },

  async verifyToken() {
    const tokenAtStart = this.getToken();
    const generation = ++this._generation;
    const isCurrent = () => generation === this._generation && tokenAtStart === this.getToken();
    const result = (state, reason, httpStatus = null) => {
      const check = { state, reason, httpStatus };
      if (isCurrent()) this._publishCheck(check);
      return check;
    };
    this._publishCheck({ state: 'unavailable', reason: 'superseded', httpStatus: null });
    if (!tokenAtStart) return result('unauthorized', 'missing-token');
    try {
      const response = await fetchJsonWithin(`${this.API_BASE}/api/auth/verify`, {
        headers: { Authorization: `Bearer ${tokenAtStart}` },
      });
      if (!isCurrent()) return result('unavailable', 'superseded', response.status);
      const { status, ok, data } = response;
      if ((status === 401 || status === 403) && data?.valid === false &&
          ['Invalid token', 'No token provided'].includes(data.error)) {
        return result('unauthorized', 'invalid-token', status);
      }
      if (ok && data?.valid === true) return result('verified', 'ok', status);
      return result('unavailable', status === 429 || status >= 500 ? 'server' : 'invalid-response', status);
    } catch (error) {
      if (!isCurrent()) return result('unavailable', 'superseded');
      return result('unavailable', ['timeout', 'network', 'invalid-response'].includes(error.code)
        ? error.code : 'network');
    }
  },

  logout() {
    this._generation++;
    sessionStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_KEY);
    this._publishCheck({ state: 'unauthorized', reason: 'missing-token', httpStatus: null });
    window.location.href = 'index.html';
  },

  init() {
    const tokenAtStart = this.getToken();
    const pending = this.verifyToken();
    const generation = this._generation;
    const completion = pending.then((check) => {
      if (generation !== this._generation || tokenAtStart !== this.getToken()) return false;
      if (check.state === 'unauthorized') this.logout();
      this.showRetry(check.state === 'unavailable' && check.reason !== 'superseded');
      return check.state === 'verified';
    }).finally(() => {
      if (this._pendingInit === completion) this._pendingInit = null;
    });
    this._pendingInit = completion;
    return completion;
  },

  showRetry(visible) {
    if (typeof document === 'undefined' || !document.createElement) return;
    let notice = document.getElementById('auth-retry');
    if (!visible) { notice?.remove(); return; }
    if (notice) return;
    notice = document.createElement('div');
    notice.id = 'auth-retry';
    notice.setAttribute('role', 'alert');
    // Viewer body clips normal-flow content; keep the retry control visible above its chrome.
    notice.style.cssText = 'position:fixed;top:calc(var(--chrome-top, 0px) + 8px);left:12px;right:12px;' +
      'z-index:10000;padding:12px;background:var(--bg-primary, #222);color:var(--text-primary, #fff)';
    notice.textContent = '暂时无法验证登录，请重试。';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '重试验证';
    button.style.cssText = 'margin-left:12px;min-height:44px;padding:0 12px';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { await this.init(); } finally { button.disabled = false; }
    });
    notice.appendChild(button);
    document.body.appendChild(notice);
  },
};

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => { Auth.init(); });
}
if (typeof module !== 'undefined' && module.exports) module.exports = { Auth };
