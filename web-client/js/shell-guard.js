(function installShellGuard(global) {
  const state = {
    coreInstalled: false,
    queuedStart: false,
    startHandler: null,
    marks: [],
  };
  const deadline = global.setTimeout(() => {
    if (!state.coreInstalled) failCore('页面资源加载超时');
  }, 8000);

  function setCoreControlsDisabled(disabled) {
    const nodes = global.document.querySelectorAll('[data-core-control]');
    for (let i = 0; i < nodes.length; i += 1) {
      nodes[i].disabled = disabled;
    }
  }
  if (global.document.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', () => setCoreControlsDisabled(true), { once: true });
  } else {
    setCoreControlsDisabled(true);
  }

  function element(id) { return global.document.getElementById(id); }
  function mark(name, detail = null) {
    state.marks.push({ name, at: global.performance?.now?.() || 0, detail });
  }
  function setText(text) {
    const target = element('loadingText');
    if (target) target.textContent = text;
  }
  function acknowledgeStartClick() {
    mark('start-click');
    if (state.startHandler) return state.startHandler();
    state.queuedStart = true;
    setText('正在加载必要资源…');
    return undefined;
  }
  function installCore(startHandler) {
    if (state.coreInstalled) return false;
    state.coreInstalled = true;
    state.startHandler = startHandler;
    global.clearTimeout(deadline);
    mark('core-interactive');
    setCoreControlsDisabled(false);
    if (state.queuedStart) startHandler();
    return true;
  }
  function failCore(reason) {
    mark('core-failed', reason);
    setText(reason || '页面资源加载失败');
    const retry = element('coreRetryBtn');
    if (retry) retry.hidden = false;
  }
  global.__WRD_SHELL__ = {
    mark,
    acknowledgeStartClick,
    installCore,
    failCore,
    snapshot: () => ({ ...state, marks: state.marks.slice() }),
  };
})(typeof window !== 'undefined' ? window : globalThis);
