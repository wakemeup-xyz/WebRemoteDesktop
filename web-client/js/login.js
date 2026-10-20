function createLoginController({ fetchJson, storage, view, navigate }) {
  let generation = 0;
  let pending = null;
  let disposed = false;

  function submit(password) {
    if (disposed) return Promise.resolve(false);
    if (pending) return pending;
    const operation = ++generation;
    const controller = new AbortController();
    const current = () => !disposed && operation === generation;
    view.setPending(true);
    view.showError(null);
    pending = Promise.resolve().then(async () => {
      if (!current()) return false;
      try {
        const base = typeof RuntimeConfig !== 'undefined' ? RuntimeConfig.getApiBase() : '';
        const response = await fetchJson(`${base}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password }),
          signal: controller.signal,
        });
        if (!current()) return false;
        if (response.ok && typeof response.data?.token === 'string' && response.data.token) {
          storage.setItem('wrd_token', response.data.token);
          navigate('viewer.html');
          return true;
        }
        const reason = response.status === 429 || response.status >= 500 ? 'server'
          : response.status === 401 && response.data?.error === 'Invalid password' ? 'invalid-password'
            : response.status === 400 && response.data?.error === 'Password required' ? 'password-required'
              : 'invalid-response';
        view.showError(reason);
        return false;
      } catch (error) {
        if (current()) view.showError(['timeout', 'network', 'invalid-response'].includes(error.code)
          ? error.code : 'network');
        return false;
      } finally {
        if (current()) { pending = null; view.setPending(false); }
      }
    });
    pending.controller = controller;
    return pending;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    generation++;
    pending?.controller.abort();
    pending = null;
  }
  return { submit, dispose };
}

function mountLogin() {
  const form = document.getElementById('loginForm');
  if (!form) return;
  const input = document.getElementById('password');
  const error = document.getElementById('error');
  const button = form.querySelector('button[type="submit"]');
  const messages = {
    'invalid-password': '密码错误', 'password-required': '请输入访问密码',
    timeout: '连接超时，请重试', network: '网络错误，请检查服务器连接',
    server: '服务暂不可用，请稍后重试', 'invalid-response': '服务器响应无效，请重试',
  };
  const view = {
    setPending(pending) { button.disabled = pending; button.textContent = pending ? '连接中…' : '连接'; },
    showError(reason) {
      error.textContent = messages[reason] || '';
      if (reason) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    },
  };
  const createController = () => createLoginController({
    fetchJson: fetchJsonWithin,
    storage: { setItem(key, value) { sessionStorage.setItem(key, value); localStorage.removeItem(key); } },
    navigate(url) { window.location.href = url; },
    view,
  });
  let controller = createController();
  form.addEventListener('submit', (event) => { event.preventDefault(); controller.submit(input.value); });
  window.addEventListener('pagehide', () => controller.dispose());
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    controller = createController();
    view.setPending(false);
    view.showError(null);
  });
}

if (typeof module !== 'undefined' && module.exports) module.exports = { createLoginController, mountLogin };
else if (typeof document !== 'undefined') mountLogin();
