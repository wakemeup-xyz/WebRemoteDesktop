(function installShellGuard(global) {
  const state = {
    coreInstalled: false,
    queuedStart: false,
    startHandler: null,
    marks: [],
  };

  function nowMs() {
    if (global.performance && typeof global.performance.now === 'function') {
      return global.performance.now();
    }
    return 0;
  }

  function mark(name, detail = null) {
    state.marks.push({
      name: String(name).slice(0, 64),
      atMs: Math.round(nowMs() * 100) / 100,
      detail: detail == null ? null : detail,
    });
  }

  // Record HTML parse / shell availability immediately — never backfilled later.
  mark('html-shell');

  const CORE_DEADLINE_MS = 5000;
  const deadline = global.setTimeout(() => {
    if (!state.coreInstalled) failCore('页面资源加载超时');
  }, CORE_DEADLINE_MS);

  function setCoreControlsDisabled(disabled) {
    const nodes = global.document.querySelectorAll('[data-core-control]');
    for (let i = 0; i < nodes.length; i += 1) {
      nodes[i].disabled = disabled;
    }
  }
  // Disable controls once the body nodes exist. With deferred desktop-core,
  // installCore can run before DOMContentLoaded; never re-disable after that.
  if (global.document.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', () => {
      if (!state.coreInstalled) setCoreControlsDisabled(true);
    }, { once: true });
  } else {
    setCoreControlsDisabled(true);
  }

  function element(id) { return global.document.getElementById(id); }
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
    global.WebRTC?.syncChromeCapabilities?.();
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
    coreDeadlineMs: CORE_DEADLINE_MS,
    sessionSnapshot: () => global.DesktopSessionState?.snapshot?.() || null,
    snapshot: () => ({
      coreInstalled: state.coreInstalled,
      queuedStart: state.queuedStart,
      marks: state.marks.map((entry) => ({ ...entry })),
    }),
  };
})(typeof window !== 'undefined' ? window : globalThis);
