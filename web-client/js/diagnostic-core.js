// Minimal diagnostic collector kept on the critical path.
// Full modal/panel attaches later via deferred diagnostic.js; the button must
// never look enabled-and-inert while that load is pending or failed.
(function installDiagnosticCore(global) {
  const SAFE_CONNECTION_ATTEMPT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
  const MAX_LEASE_EPOCH = 0x7fffffff;
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
  Diagnostic._pendingInputIncidents = Array.isArray(Diagnostic._pendingInputIncidents)
    ? Diagnostic._pendingInputIncidents
    : [];

  function emptyInputTraceSnapshot() {
    return {
      schemaVersion: 3,
      traceNowMs: null,
      events: [],
      counters: {
        droppedEvents: 0,
        sampledEvents: 0,
        hashUnavailable: 0,
        droppedHashCount: 0,
        pendingHashCount: 0,
        pendingAckCount: 0,
        evictedPendingAcks: 0,
        expiredPendingAcks: 0,
        ackTimeoutCount: 0,
        incidentCallbackErrors: 0,
        mouseMoveCount: 0,
        wheelCount: 0,
      },
    };
  }

  Diagnostic._getInputTraceApi = function _getInputTraceApi() {
    return global.InputTrace && typeof global.InputTrace.create === 'function'
      ? global.InputTrace
      : null;
  };

  Diagnostic._ensureInputTrace = function _ensureInputTrace() {
    if (this._inputTrace && typeof this._inputTrace.record === 'function'
      && typeof this._inputTrace.snapshot === 'function') return this._inputTrace;
    const api = this._getInputTraceApi();
    if (!api) return null;
    try {
      this._inputTrace = api.create({
        schemaVersion: 3,
        onIncident: (reason, identity) => this._handleInputTraceIncident(reason, identity),
      });
    } catch (_error) {
      this._inputTrace = null;
    }
    return this._inputTrace;
  };

  Diagnostic._currentInput = function _currentInput() {
    return typeof Input !== 'undefined' && Input && typeof Input === 'object' ? Input
      : (global.Input && typeof global.Input === 'object' ? global.Input : null);
  };

  Diagnostic._inputTraceIdentityMatches = function _inputTraceIdentityMatches(identity = {}) {
    const input = this._currentInput();
    const webRtc = global.WebRTC && typeof global.WebRTC === 'object' ? global.WebRTC : null;
    const currentAttempt = webRtc?.currentConnectionAttemptId || null;
    const currentEpoch = Number.isSafeInteger(input?.activeControlLease?.leaseEpoch)
      && input.activeControlLease.leaseEpoch >= 0
      && input.activeControlLease.leaseEpoch <= MAX_LEASE_EPOCH
      ? input.activeControlLease.leaseEpoch : null;
    if (!currentAttempt || currentEpoch === null) return false;
    const identityAttempt = typeof identity?.connectionAttemptId === 'string'
      && SAFE_CONNECTION_ATTEMPT.test(identity.connectionAttemptId)
      ? identity.connectionAttemptId : null;
    const identityEpoch = Number.isSafeInteger(identity?.leaseEpoch)
      && identity.leaseEpoch >= 0
      && identity.leaseEpoch <= MAX_LEASE_EPOCH
      ? identity.leaseEpoch : null;
    return identityAttempt === currentAttempt && identityEpoch === currentEpoch;
  };

  Diagnostic._inputTraceIncidentCanSend = function _inputTraceIncidentCanSend(identity = {}) {
    const input = this._currentInput();
    const document = global.document;
    if (!input || input.isActive !== true || !input.activeControlLease
      || document?.hidden === true || !this._inputTraceIdentityMatches(identity)) return false;
    const webRtc = global.WebRTC && typeof global.WebRTC === 'object' ? global.WebRTC : null;
    if (typeof webRtc?.hasActiveControl === 'function') {
      try {
        if (webRtc.hasActiveControl() !== true) return false;
      } catch (_error) {
        return false;
      }
    }
    return true;
  };

  Diagnostic._handleInputTraceIncident = function _handleInputTraceIncident(reason, identity = {}) {
    if (reason !== 'input-ack-timeout' && reason !== 'input-gate-unexpected') return false;
    const safeIdentity = {
      connectionAttemptId: typeof identity?.connectionAttemptId === 'string'
        && SAFE_CONNECTION_ATTEMPT.test(identity.connectionAttemptId)
        ? identity.connectionAttemptId : null,
      leaseEpoch: Number.isSafeInteger(identity?.leaseEpoch)
        && identity.leaseEpoch >= 0
        && identity.leaseEpoch <= MAX_LEASE_EPOCH
        ? identity.leaseEpoch : null,
    };
    if (!this._inputTraceIncidentCanSend(safeIdentity)) return false;
    if (typeof this.buildConnectionDiagnostic !== 'function') {
      const exists = this._pendingInputIncidents.some((item) => (
        item.reason === reason
        && item.identity.connectionAttemptId === safeIdentity.connectionAttemptId
        && item.identity.leaseEpoch === safeIdentity.leaseEpoch
      ));
      if (!exists) this._pendingInputIncidents.push({ reason, identity: safeIdentity });
      while (this._pendingInputIncidents.length > 20) this._pendingInputIncidents.shift();
      return false;
    }
    try {
      this.autoSendFailure(reason);
      return true;
    } catch (_error) {
      return false;
    }
  };

  Diagnostic.flushPendingInputIncidents = function flushPendingInputIncidents() {
    if (!Array.isArray(this._pendingInputIncidents) || !this._pendingInputIncidents.length) return;
    const pending = this._pendingInputIncidents.splice(0, this._pendingInputIncidents.length);
    pending.forEach((item) => this._handleInputTraceIncident(item.reason, item.identity));
  };

  Diagnostic.recordInputTrace = function recordInputTrace(stage, meta = {}) {
    const trace = this._ensureInputTrace();
    if (!trace) return null;
    try {
      return trace.record(stage, meta);
    } catch (_error) {
      return null;
    }
  };

  Diagnostic.getInputTraceSnapshot = function getInputTraceSnapshot() {
    const trace = this._ensureInputTrace();
    if (!trace) return emptyInputTraceSnapshot();
    try {
      return trace.snapshot();
    } catch (_error) {
      return emptyInputTraceSnapshot();
    }
  };

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
    this.flushPendingInputIncidents();
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

  const runtimeApi = typeof createRuntimeDiagnosticBuilder === 'function'
    ? createRuntimeDiagnosticBuilder : global.createRuntimeDiagnosticBuilder;
  const currentRtc = () => typeof WebRTC !== 'undefined' ? WebRTC : global.WebRTC;
  const collector = () => typeof LatencyMonitor !== 'undefined' ? LatencyMonitor : global.LatencyMonitor;
  const monoNow = () => global.performance?.now?.() ?? (typeof performance !== 'undefined' ? performance.now() : 0);
  Diagnostic._runtimeBuilder = runtimeApi({
    nowMs: monoNow,
    getScope: () => {
      const rtc = currentRtc(); const input = Diagnostic._currentInput();
      if (typeof rtc?.latencyScope === 'function') return rtc.latencyScope();
      return rtc?.currentConnectionAttemptId && Number.isSafeInteger(input?.activeControlLease?.leaseEpoch)
        ? { connectionAttemptId: rtc.currentConnectionAttemptId, generation: rtc.connectionAttemptSequence ?? 0,
          leaseEpoch: input.activeControlLease.leaseEpoch } : null;
    },
    getBuild: () => global.__WRD_BUILD__ || globalThis.__WRD_BUILD__ || { id: null, builtAt: null },
    getInput: () => ({ inputState: Diagnostic._currentInput()?.getDiagnosticState?.() || {},
      inputTrace: Diagnostic.getInputTraceSnapshot() }),
    getStartup: () => (global.__WRD_STARTUP_SNAPSHOT__ || globalThis.__WRD_STARTUP_SNAPSHOT__)?.() || {},
    getResources: () => null,
    getLatency: context => collector()?.snapshot?.(context) || null,
    takeClosedScopeSummaries: context => collector()?.takeClosedScopeSummaries?.(context) || null,
  });
  Diagnostic.buildRuntimeDiagnostic = function buildRuntimeDiagnostic(meta = {}) { return this._runtimeBuilder(meta); };
  Diagnostic.buildConnectionDiagnostic = function buildConnectionDiagnostic(meta = {}) {
    return { type: 'connection-diagnostic', connectionAttemptId: currentRtc()?.currentConnectionAttemptId || null,
      trigger: meta.trigger || 'manual', ...this.buildRuntimeDiagnostic(meta) };
  };
  Diagnostic.getPendingDiagnostics = function getPendingDiagnostics() {
    if (this._pendingDiagnosticsMemory) return this._pendingDiagnosticsMemory;
    try { const raw = (global.localStorage || globalThis.localStorage)?.getItem('wrdPendingDiagnostics') || '[]';
      if (raw.length > 10 * 128 * 1024) return [];
      const items = JSON.parse(raw);
      return Array.isArray(items) ? items.filter(item => item && typeof item === 'object').slice(-10) : []; } catch (_) { return []; }
  };
  Diagnostic.setPendingDiagnostics = function setPendingDiagnostics(items) {
    const bounded = []; let size = 0;
    for (const item of items.slice(-10).reverse()) {
      const length = runtimeDiagnosticBytes(item);
      if (length > 128 * 1024 || size + length > 10 * 128 * 1024) continue;
      bounded.unshift(item); size += length;
    }
    this._pendingDiagnosticsMemory = bounded;
    const metricNames = typeof LATENCY_METRIC_NAMES !== 'undefined' ? LATENCY_METRIC_NAMES : [];
    try { (global.localStorage || globalThis.localStorage)?.setItem('wrdPendingDiagnostics', JSON.stringify(bounded.map(item => runtimeDiagnosticForStorage(item, metricNames)))); } catch (_) { /* storage unavailable */ }
  };
  Diagnostic.enqueuePendingDiagnostic = function enqueuePendingDiagnostic(payload, prepared = false) {
    const attempt = payload.connectionAttemptId || 'global';
    const pending = this.getPendingDiagnostics().slice();
    // Each transmitted capture owns a retry slot. Multiple failure/manual reports
    // may share an attempt; only a retransmission of the same ID is coalesced.
    const alreadyPending = payload.diagnosticId
      ? pending.some(item => item.diagnosticId === payload.diagnosticId)
      : pending.some(item => !item.diagnosticId && (item.connectionAttemptId || 'global') === attempt);
    if (!alreadyPending) pending.push(prepared ? payload : boundRuntimeDiagnostic(payload));
    this.setPendingDiagnostics(pending);
  };
  Diagnostic.pruneAutoSendCooldown = function pruneAutoSendCooldown(now = Date.now()) {
    for (const id of Object.keys(this.autoSendByAttempt)) if (now - this.autoSendByAttempt[id] >= this.autoSendCooldownMs) delete this.autoSendByAttempt[id];
  };
  Diagnostic.claimAttemptSendSlot = function claimAttemptSendSlot(attemptId, now = Date.now()) {
    const id = attemptId || 'global'; this.pruneAutoSendCooldown(now);
    if (Object.prototype.hasOwnProperty.call(this.autoSendByAttempt, id) && now - this.autoSendByAttempt[id] < this.autoSendCooldownMs) return false;
    this.autoSendByAttempt[id] = now; return true;
  };
  const validReceipt = (payload, receipt) => (
    typeof payload?.diagnosticId === 'string' && payload.diagnosticId.trim().length > 0
    && receipt?.accepted === true && receipt.diagnosticId === payload.diagnosticId
    && Array.isArray(receipt.eventIdHashes) && receipt.eventIdHashes.length <= 4
    && Array.from(receipt.eventIdHashes).every(id => typeof id === 'string' && /^[a-f0-9]{16,64}$/.test(id))
  );
  const freezePayload = value => {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(freezePayload);
      Object.freeze(value);
    }
    return value;
  };
  Diagnostic._confirmDiagnostic = function _confirmDiagnostic(payload, receipt) {
    if (!validReceipt(payload, receipt)) return false;
    const owned = new Set((payload.scopeEnded?.events || []).map(event => event.eventIdHash));
    this._runtimeBuilder.acknowledge(receipt.eventIdHashes.filter(id => owned.has(id)));
    this.setPendingDiagnostics(this.getPendingDiagnostics()
      .filter(item => item.diagnosticId !== payload.diagnosticId)
      .map(item => this._runtimeBuilder.prepareReplay(item)));
    return true;
  };
  Diagnostic._diagnosticInFlight = new Map();
  Diagnostic.sendConnectionDiagnostic = function sendConnectionDiagnostic(payload = this.buildConnectionDiagnostic(), socket = null) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return Promise.resolve(false);
    const id = payload.diagnosticId;
    if (this._diagnosticInFlight.has(id)) return this._diagnosticInFlight.get(id);
    if (this._diagnosticInFlight.size >= 10) return Promise.resolve(false);
    if (typeof id !== 'string' || !id.trim()) {
      this.enqueuePendingDiagnostic(payload);
      return Promise.resolve(false);
    }
    const deadline = monoNow() + 8000;
    let diagnosticPayload; let body;
    try {
      diagnosticPayload = freezePayload(this._runtimeBuilder.prepareReplay(boundRuntimeDiagnostic(payload)));
      body = JSON.stringify(diagnosticPayload);
      this.enqueuePendingDiagnostic(diagnosticPayload, true);
    } catch (_) { return Promise.resolve(false); }
    // Reserve before any synchronous Socket ACK can reenter this sender.
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    this._diagnosticInFlight.set(id, promise);
    const remainingMs = () => Math.max(0, deadline - monoNow());
    const socketStage = target => new Promise(done => {
      const stageStartedMs = monoNow();
      const stageDeadline = Math.min(deadline, stageStartedMs + 2000);
      const stageMs = Math.max(0, stageDeadline - stageStartedMs);
      if (!target?.connected || typeof target.timeout !== 'function' || stageMs <= 0) { done(null); return; }
      let settled = false; let timer;
      const finish = receipt => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        target.off?.('disconnect', disconnected);
        done(receipt);
      };
      const disconnected = () => finish(null);
      try {
        target.on?.('disconnect', disconnected);
        timer = setTimeout(() => finish(null), stageMs);
        // Socket.IO's timeout modifier removes its ACK-table entry on expiry.
        target.timeout(stageMs).emit('diagnostic', diagnosticPayload, (error, receipt) => {
          finish(!error && target.connected && monoNow() < stageDeadline
            && validReceipt(diagnosticPayload, receipt) ? receipt : null);
        });
      } catch (_) { finish(null); }
    });
    const deliver = async () => {
      const receipt = await socketStage(socket || currentRtc()?.socket);
      if (receipt && remainingMs() > 0) return this._confirmDiagnostic(diagnosticPayload, receipt);
      const send = global.fetch || globalThis.fetch;
      const boundedFetch = typeof fetchJsonWithin === 'function' ? fetchJsonWithin : global.fetchJsonWithin;
      if (typeof send !== 'function' || typeof boundedFetch !== 'function' || remainingMs() <= 0) return false;
      const config = typeof RuntimeConfig !== 'undefined' ? RuntimeConfig : global.RuntimeConfig;
      const auth = typeof Auth !== 'undefined' ? Auth : global.Auth;
      const base = config?.getApiBase?.() || global.location?.origin || '';
      const token = auth?.getToken?.();
      const response = await boundedFetch(`${base}/api/diagnostics`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body,
      }, { timeoutMs: remainingMs(), maxResponseBytes: 4096, fetchImpl: send });
      return response.ok && response.status >= 200 && response.status < 300
        && remainingMs() > 0
        && this._confirmDiagnostic(diagnosticPayload, response.data);
    };
    deliver().catch(() => false).then(confirmed => {
      this._diagnosticInFlight.delete(id);
      resolve(confirmed === true);
    });
    return promise;
  };
  Diagnostic.replayPendingDiagnostics = async function replayPendingDiagnostics(socket = null) {
    const target = socket || currentRtc()?.socket;
    if (!target?.connected) return 0;
    const pending = this.getPendingDiagnostics().slice(); let sent = 0;
    for (const payload of pending) {
      if (sent >= 2) break;
      if (!this.claimAttemptSendSlot(payload.connectionAttemptId || 'global')) continue;
      // Only the sender prepares this capture; queue updates always use current state.
      sent++;
      await this.sendConnectionDiagnostic(payload, target);
    }
    return sent;
  };
  Diagnostic.autoSendFailure = function autoSendFailure(reason) {
    const attempt = currentRtc()?.currentConnectionAttemptId || 'global';
    if (!this.claimAttemptSendSlot(attempt)) return;
    const payload = this.getPendingDiagnostics().find(item => (item.connectionAttemptId || 'global') === attempt && item.reason === reason)
      || this.buildConnectionDiagnostic({ trigger: 'auto-failure', reason });
    return this.sendConnectionDiagnostic(payload);
  };
  Diagnostic.flushPendingAutoSends = function flushPendingAutoSends() { /* core already captured and sent; reconnect owns replay */ };

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
