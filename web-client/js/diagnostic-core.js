// Minimal diagnostic collector kept on the critical path.
// Full modal/panel attaches later via deferred diagnostic.js; the button must
// never look enabled-and-inert while that load is pending or failed.
(function installDiagnosticCore(global) {
  const existing = global.Diagnostic && typeof global.Diagnostic === 'object'
    ? global.Diagnostic
    : null;

  const Diagnostic = existing || {
    logs: [],
    maxLogs: 500,
    autoSendByAttempt: {},
    autoSendCooldownMs: 15000,
    browserSessionId: null,
  };

  Diagnostic.panelState = Diagnostic.panelState || 'loading'; // loading | ready | failed
  Diagnostic.panelReady = Boolean(Diagnostic.panelReady);
  Diagnostic._pendingFailureReasons = Array.isArray(Diagnostic._pendingFailureReasons)
    ? Diagnostic._pendingFailureReasons
    : [];
  Diagnostic._diagShellBound = Boolean(Diagnostic._diagShellBound);
  Diagnostic._consoleHijacked = Boolean(Diagnostic._consoleHijacked);

  Diagnostic.ensureBrowserSessionId = Diagnostic.ensureBrowserSessionId || function ensureBrowserSessionId() {
    if (this.browserSessionId) return this.browserSessionId;
    const key = 'wrd_browser_session_id';
    try {
      const existingId = global.sessionStorage?.getItem(key);
      if (existingId) {
        this.browserSessionId = existingId;
        return existingId;
      }
      const created = `browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      global.sessionStorage?.setItem(key, created);
      this.browserSessionId = created;
      return created;
    } catch (_error) {
      this.browserSessionId = `browser-${Date.now()}`;
      return this.browserSessionId;
    }
  };

  Diagnostic.normalizeLogMessage = Diagnostic.normalizeLogMessage || function normalizeLogMessage(args = []) {
    return args.map((arg) => {
      if (typeof arg === 'object') {
        try {
          return JSON.stringify(arg);
        } catch (_error) {
          return String(arg);
        }
      }
      return String(arg);
    }).join(' ');
  };

  Diagnostic.formatLogEntry = Diagnostic.formatLogEntry || function formatLogEntry(entry) {
    if (typeof entry === 'string') return entry;
    const at = entry?.at || '';
    const level = entry?.level || 'LOG';
    const message = entry?.message || '';
    return `[${at}] [${level}] ${message}`;
  };

  Diagnostic.hijackConsole = function hijackConsole() {
    if (this._consoleHijacked) return;
    this._consoleHijacked = true;
    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;
    const originalInfo = console.info;
    const self = this;

    const push = (level, args) => {
      self.logs.push({
        at: new Date().toLocaleTimeString(),
        level,
        channel: 'console',
        message: self.normalizeLogMessage(args),
      });
      if (self.logs.length > self.maxLogs) self.logs.shift();
    };

    console.log = (...args) => {
      push('LOG', args);
      originalLog.apply(console, args);
    };
    console.error = (...args) => {
      push('ERR', args);
      originalError.apply(console, args);
    };
    console.warn = (...args) => {
      push('WRN', args);
      originalWarn.apply(console, args);
    };
    console.info = (...args) => {
      push('INF', args);
      originalInfo.apply(console, args);
    };
  };

  Diagnostic._diagButton = function _diagButton() {
    return global.document?.getElementById?.('diagBtn') || null;
  };

  Diagnostic.lockDiagButton = function lockDiagButton() {
    const btn = this._diagButton();
    if (!btn) return;
    // Not a data-core-control target: ShellGuard must not enable this while deferred.
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    btn.dataset.wrdDiagState = this.panelState || 'loading';
    if (this.panelState === 'loading') {
      btn.title = '诊断组件加载中…';
      if (!btn.dataset.wrdDiagLabel) {
        btn.dataset.wrdDiagLabel = btn.textContent || '诊断日志';
      }
      btn.textContent = btn.dataset.wrdDiagLabel;
    }
  };

  Diagnostic.onDiagButtonClick = function onDiagButtonClick(event) {
    if (this.panelReady && typeof this.openPanel === 'function') {
      this.openPanel();
      return;
    }
    if (this.panelState === 'failed' && typeof this.retryDeferredLoad === 'function') {
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }
      this.retryDeferredLoad();
    }
  };

  Diagnostic.bindDiagShell = function bindDiagShell() {
    const btn = this._diagButton();
    if (!btn || this._diagShellBound) {
      this.lockDiagButton();
      return;
    }
    this._diagShellBound = true;
    this.lockDiagButton();
    btn.addEventListener('click', (event) => this.onDiagButtonClick(event));
  };

  Diagnostic.markDeferredReady = function markDeferredReady() {
    this.panelReady = true;
    this.panelState = 'ready';
    const btn = this._diagButton();
    if (btn) {
      btn.disabled = false;
      if (typeof btn.removeAttribute === 'function') {
        btn.removeAttribute('aria-busy');
      }
      btn.dataset.wrdDiagState = 'ready';
      btn.title = '';
      if (btn.dataset.wrdDiagLabel) btn.textContent = btn.dataset.wrdDiagLabel;
    }
  };

  Diagnostic.markDeferredFailed = function markDeferredFailed(retryFn) {
    this.panelReady = false;
    this.panelState = 'failed';
    this.retryDeferredLoad = typeof retryFn === 'function' ? retryFn : null;
    const btn = this._diagButton();
    if (btn) {
      // Enabled only as an explicit retry control — never as a silent no-op.
      btn.disabled = false;
      if (typeof btn.removeAttribute === 'function') {
        btn.removeAttribute('aria-busy');
      }
      btn.dataset.wrdDiagState = 'failed';
      btn.textContent = '诊断重试';
      btn.title = '诊断组件加载失败，点击重试';
    }
  };

  Diagnostic.markDeferredLoading = function markDeferredLoading() {
    this.panelReady = false;
    this.panelState = 'loading';
    this.lockDiagButton();
  };

  // Queue failures until the full panel module provides sendConnectionDiagnostic.
  Diagnostic.autoSendFailure = function autoSendFailure(reason) {
    if (typeof this.buildConnectionDiagnostic === 'function'
      && typeof this.sendConnectionDiagnostic === 'function'
      && this.panelReady) {
      // Full panel owns attempt-id extraction + unified cooldown.
      if (typeof this.claimAttemptSendSlot === 'function') {
        // Delegate to full autoSendFailure once assigned; core only queues reasons.
      }
      const payload = this.buildConnectionDiagnostic({
        trigger: 'auto-failure',
        reason,
      });
      const attemptId = String(payload.connectionAttemptId || '').trim() || 'global';
      const now = Date.now();
      if (typeof this.claimAttemptSendSlot === 'function') {
        if (!this.claimAttemptSendSlot(attemptId, now)) {
          console.log('[Diagnostic] Skip auto send due to cooldown:', reason);
          if (typeof this.enqueuePendingDiagnostic === 'function') {
            this.enqueuePendingDiagnostic(payload);
          }
          return;
        }
      } else {
        if (typeof this.pruneAutoSendCooldown === 'function') this.pruneAutoSendCooldown(now);
        const lastSentAt = Number(this.autoSendByAttempt[attemptId] || 0);
        if (now - lastSentAt < this.autoSendCooldownMs) {
          console.log('[Diagnostic] Skip auto send due to cooldown:', reason);
          return;
        }
        this.autoSendByAttempt[attemptId] = now;
      }
      this.sendConnectionDiagnostic(payload);
      return;
    }
    // Dedupe pending reason strings (core has no attempt id yet).
    const key = String(reason || 'unknown').slice(0, 128);
    this._pendingFailureReasons = (this._pendingFailureReasons || []).filter((item) => item !== key);
    this._pendingFailureReasons.push(key);
    if (this._pendingFailureReasons.length > 20) {
      this._pendingFailureReasons.shift();
    }
  };

  Diagnostic.flushPendingAutoSends = function flushPendingAutoSends() {
    if (typeof this.buildConnectionDiagnostic !== 'function'
      || typeof this.sendConnectionDiagnostic !== 'function') {
      return;
    }
    const pending = this._pendingFailureReasons.splice(0, this._pendingFailureReasons.length);
    pending.forEach((reason) => {
      try {
        // Use the full implementation path once the panel module is ready.
        const payload = this.buildConnectionDiagnostic({
          trigger: 'auto-failure',
          reason,
        });
        this.sendConnectionDiagnostic(payload);
      } catch (_error) {
        // Keep going; diagnostics must not break the desktop session.
      }
    });
  };

  Diagnostic.initCore = function initCore() {
    this.ensureBrowserSessionId();
    this.hijackConsole();
    this.bindDiagShell();
    console.log('[Diagnostic] core collector ready');
  };

  global.Diagnostic = Diagnostic;

  function boot() {
    Diagnostic.initCore();
  }

  if (global.document) {
    if (global.document.readyState === 'loading') {
      global.document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
      boot();
    }
  }
}(typeof window !== 'undefined' ? window : globalThis));
