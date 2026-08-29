// Full diagnostic panel (deferred). Extends diagnostic-core collector/button shell.
(function extendDiagnosticPanel(global) {
  const Diagnostic = global.Diagnostic && typeof global.Diagnostic === 'object'
    ? global.Diagnostic
    : {
      logs: [],
      maxLogs: 500,
      autoSendByAttempt: {},
      autoSendCooldownMs: 15000,
      browserSessionId: null,
    };

  // Preserve core log buffer / hijack flags when present.
  Diagnostic.logs = Array.isArray(Diagnostic.logs) ? Diagnostic.logs : [];
  Diagnostic.maxLogs = Diagnostic.maxLogs || 500;
  Diagnostic.autoSendByAttempt = Diagnostic.autoSendByAttempt || {};
  Diagnostic.autoSendCooldownMs = Diagnostic.autoSendCooldownMs || 15000;
  Diagnostic.socket = Diagnostic.socket || null;

  Object.assign(Diagnostic, {
  init() {
    this.ensureBrowserSessionId();
    if (typeof this.hijackConsole === 'function') this.hijackConsole();
    this.setupUI();
    if (typeof this.markDeferredReady === 'function') {
      this.markDeferredReady();
    } else {
      const diagBtn = document.getElementById('diagBtn');
      if (diagBtn) {
        diagBtn.disabled = false;
        if (typeof diagBtn.removeAttribute === 'function') {
          diagBtn.removeAttribute('aria-busy');
        }
      }
    }
    if (typeof this.flushPendingAutoSends === 'function') {
      this.flushPendingAutoSends();
    }
    console.log('[Diagnostic] Log collector initialized');
  },

  ensureBrowserSessionId() {
    if (this.browserSessionId) {
      return this.browserSessionId;
    }
    const key = 'wrd_browser_session_id';
    const existing = sessionStorage.getItem(key);
    if (existing) {
      this.browserSessionId = existing;
      return existing;
    }
    const created = `browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    sessionStorage.setItem(key, created);
    this.browserSessionId = created;
    return created;
  },

  normalizeLogMessage(args = []) {
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
  },

  formatLogEntry(entry) {
    if (typeof entry === 'string') {
      return entry;
    }
    const at = entry?.at || '';
    const level = entry?.level || 'LOG';
    const message = entry?.message || '';
    return `[${at}] [${level}] ${message}`;
  },

  hijackConsole() {
    if (this._consoleHijacked) return;
    this._consoleHijacked = true;
    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;
    const originalInfo = console.info;

    const push = (level, args, channel = 'console') => {
      const entry = {
        at: new Date().toLocaleTimeString(),
        level,
        channel,
        message: this.normalizeLogMessage(args),
      };
      this.logs.push(entry);
      if (this.logs.length > this.maxLogs) {
        this.logs.shift();
      }
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
  },

  openPanel() {
    const modal = document.getElementById('diagModal');
    const area = document.getElementById('diagLogArea');
    if (!modal || !area) return;
    area.value = this.logs.map((entry) => this.formatLogEntry(entry)).join('\n');
    area.scrollTop = area.scrollHeight;
    if (this._settingsModal) {
      this._settingsModal.open();
      return;
    }
    modal.classList.remove('hidden');
    const title = typeof modal.querySelector === 'function' ? modal.querySelector('h3') : null;
    if (title && typeof title.focus === 'function') title.focus();
  },

  setupUI() {
    const diagBtn = document.getElementById('diagBtn');
    const modal = document.getElementById('diagModal');
    const closeBtn = document.getElementById('closeDiagBtn');
    const sendBtn = document.getElementById('sendDiagBtn');
    const clearBtn = document.getElementById('clearDiagBtn');
    const area = document.getElementById('diagLogArea');

    if (!diagBtn || !modal || !area) return;

    // Core shell already owns the click → openPanel/retry path.
    if (!this._diagShellBound) {
      diagBtn.addEventListener('click', () => this.openPanel());
    }

    if (typeof WebRTC !== 'undefined' && typeof WebRTC.bindSettingsModal === 'function') {
      this._settingsModal = WebRTC.bindSettingsModal(modal, { closeBtn });
    } else {
      const close = () => modal.classList.add('hidden');
      if (closeBtn) {
        closeBtn.addEventListener('click', close);
      }
      modal.addEventListener('click', (event) => {
        if (event.target === modal) close();
      });
      document.addEventListener('keydown', (event) => {
        if (!event || event.key !== 'Escape') return;
        if (modal.classList.contains('hidden')) return;
        if (typeof event.preventDefault === 'function') event.preventDefault();
        if (typeof event.stopPropagation === 'function') event.stopPropagation();
        if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
        close();
      }, true);
      this._settingsModal = {
        open() {
          modal.classList.remove('hidden');
          const title = typeof modal.querySelector === 'function' ? modal.querySelector('h3') : null;
          if (title && typeof title.focus === 'function') title.focus();
        },
        close,
      };
    }

    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        this.logs = [];
        area.value = '';
      });
    }

    if (sendBtn) {
      sendBtn.addEventListener('click', () => {
        this.sendLogs();
      });
    }
  },

  getInputChannelTimeline() {
    return this.logs
      .map((entry) => this.formatLogEntry(entry))
      .filter((line) => line.includes('[INPUT-DC]'))
      .slice(-40)
      .map((line) => {
        const match = line.match(/^\[([^\]]+)\] \[([^\]]+)\] (.*)$/);
        const message = match ? match[3] : line;
        let kind = 'info';
        if (/error/i.test(message)) kind = 'error';
        else if (/closed/i.test(message)) kind = 'close';
        else if (/open/i.test(message)) kind = 'open';
        else if (/stuck/i.test(message)) kind = 'stuck';
        return {
          at: match ? match[1] : null,
          level: match ? match[2] : null,
          kind,
          message,
        };
      });
  },

  getNetworkSnapshot() {
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    const snapshot = (
      typeof WebRTC !== 'undefined' &&
      typeof WebRTC.collectNetworkSnapshot === 'function'
    ) ? WebRTC.collectNetworkSnapshot() : {};

    const candidateHealth = (
      typeof WebRTC !== 'undefined' &&
      typeof WebRTC.classifyCandidateHealth === 'function'
    ) ? WebRTC.classifyCandidateHealth(snapshot) : this.classifyCandidateHealth(snapshot);

    return {
      ...snapshot,
      candidateHealth,
      navigator: {
        onLine: typeof navigator.onLine === 'boolean' ? navigator.onLine : null,
        platform: navigator.platform || null,
        language: navigator.language || null,
        effectiveType: connection?.effectiveType || null,
        type: connection?.type || null,
        downlink: typeof connection?.downlink === 'number' ? connection.downlink : null,
        rtt: typeof connection?.rtt === 'number' ? connection.rtt : null,
      },
    };
  },

  classifyCandidateHealth(snapshot = {}) {
    const summary = snapshot.candidateSummary || {};
    const local = summary.local || {};
    const remote = summary.remote || {};
    const hasRelay = Number(local.relay || 0) > 0 || Number(remote.relay || 0) > 0;
    const hasSrflx = Number(local.srflx || 0) > 0 || Number(remote.srflx || 0) > 0;
    const hasRemote = ['host', 'srflx', 'relay', 'prflx'].some((type) => Number(remote[type] || 0) > 0);
    if (!snapshot.turnConfigured && !hasRelay && hasSrflx) {
      return hasRemote ? 'stun-no-turn-no-relay' : 'stun-local-only-no-turn';
    }
    if (hasRelay) return 'relay-candidate-present';
    if (!hasSrflx && !hasRemote) return 'no-usable-candidates';
    return 'candidate-check-needed';
  },

  sendLogs(meta = {}) {
    const latencyStats = (typeof LatencyMonitor !== 'undefined')
      ? LatencyMonitor.getStats()
      : null;

    const inputState = (typeof Input !== 'undefined' && typeof Input.getDiagnosticState === 'function')
      ? Input.getDiagnosticState()
      : null;
    const terminalState = (typeof TerminalPanel !== 'undefined' && typeof TerminalPanel.getDiagnosticState === 'function')
      ? TerminalPanel.getDiagnosticState()
      : null;

    const payload = this.buildConnectionDiagnostic({
      trigger: meta.trigger || 'manual',
      reason: meta.reason || null,
    });
    payload.type = payload.type || 'diagnostic';
    payload.timestamp = Date.now();
    payload.userAgent = navigator.userAgent;
    payload.screen = `${window.screen.width}x${window.screen.height}`;
    payload.latency = latencyStats;
    payload.logs = this.logs.slice(-120);
    payload.network = payload.network || this.getNetworkSnapshot();
    payload.keyboardMode = inputState?.keyboardMode || null;
    payload.terminal = terminalState || payload.terminal;
    payload.inputState = inputState ? {
      keyboardMode: inputState.keyboardMode || null,
      isActive: Boolean(inputState.isActive),
      hasLease: Boolean(inputState.hasLease),
      leaseEpoch: Number(inputState.leaseEpoch || 0),
      gate: inputState.gate && typeof inputState.gate === 'object' ? { ...inputState.gate } : null,
      keyboard: inputState.keyboard ? {
        leaseState: inputState.keyboard.leaseState || null,
        epoch: Number(inputState.keyboard.epoch || 0),
        lastSent: Number(inputState.keyboard.lastSent || 0),
        lastApplied: Number(inputState.keyboard.lastApplied || 0),
        pendingCount: Number(inputState.keyboard.pendingCount || 0),
        pressedCount: Number(inputState.keyboard.pressedCount || 0),
        modifierMask: Number(inputState.keyboard.modifierMask || 0),
        adapter: inputState.keyboard.adapter || null,
        lastResetReason: inputState.keyboard.lastResetReason || null,
      } : null,
    } : null;
    payload.inputChannelTimeline = this.getInputChannelTimeline();

    // Use WebRTC socket if available, otherwise try to emit directly
    if (typeof WebRTC !== 'undefined' && WebRTC.socket && WebRTC.socket.connected) {
      WebRTC.socket.emit('diagnostic', payload);
      console.log('[Diagnostic] Logs sent via WebRTC socket');
      alert('日志已发送到服务端，请等待分析');
    } else if (typeof io !== 'undefined') {
      // Fallback: create a temporary socket connection just to send logs
      const socketBase = (typeof RuntimeConfig !== 'undefined')
        ? RuntimeConfig.getSocketBase()
        : window.location.origin;
      const tempSocket = io(socketBase, {
        auth: { token: Auth.getToken(), role: 'viewer' }
      });
      tempSocket.on('connect', () => {
        tempSocket.emit('diagnostic', payload);
        console.log('[Diagnostic] Logs sent via temporary socket');
        alert('日志已发送到服务端，请等待分析');
        setTimeout(() => tempSocket.disconnect(), 500);
      });
      tempSocket.on('connect_error', (err) => {
        console.error('[Diagnostic] Failed to send logs:', err);
        alert('发送失败，请检查网络连接');
      });
    } else {
      console.error('[Diagnostic] No socket available to send logs');
      alert('无法发送：Socket 未连接');
    }
  },

  buildConnectionDiagnostic(meta = {}) {
    const trace = (typeof ConnectionTrace !== 'undefined' && ConnectionTrace.current)
      ? ConnectionTrace.current
      : null;
    const snapshot = trace && typeof trace.snapshot === 'function'
      ? trace.snapshot()
      : {};
    const basePayload = trace && typeof trace.buildPayload === 'function'
      ? trace.buildPayload(meta)
      : snapshot;
    const redactedEvents = Array.isArray(basePayload.events)
      ? basePayload.events.map((event) => this.redactTraceEvent(event))
      : [];

    const adaptiveMedia = (typeof WebRTC !== 'undefined'
      && WebRTC.linkQualityController
      && typeof WebRTC.linkQualityController.snapshot === 'function')
      ? WebRTC.linkQualityController.snapshot()
      : { enabled: false };
    const recommendation = (typeof WebRTC !== 'undefined' && WebRTC.recommendationState)
      ? { ...WebRTC.recommendationState }
      : null;
    const entrypoint = (typeof WebRTC !== 'undefined')
      ? (
        typeof WebRTC.getPublicEntryUrl === 'function'
          ? WebRTC.getPublicEntryUrl()
          : String(
            WebRTC.serverConfig?.publicEntry?.formalEntryUrl
            || WebRTC.serverConfig?.publicEntryUrl
            || window.location.origin
            || ''
          ).trim()
      )
      : String(window.location.origin || '').trim();
    const mode = (typeof WebRTC !== 'undefined' && WebRTC.networkMode)
      ? WebRTC.networkMode
      : null;
    const connectionAttemptId = basePayload.connectionAttemptId
      || snapshot.connectionAttemptId
      || (typeof WebRTC !== 'undefined' && WebRTC.currentConnectionAttemptId)
      || `wrd-${Date.now()}`;
    const terminalState = (typeof TerminalPanel !== 'undefined' && typeof TerminalPanel.getDiagnosticState === 'function')
      ? TerminalPanel.getDiagnosticState()
      : null;
    const network = this.getNetworkSnapshot();
    const session = (typeof WebRTC !== 'undefined'
      && typeof WebRTC.getSessionPresentation === 'function')
      ? (WebRTC.getSessionPresentation() || {})
      : {};
    const lastStats = (typeof WebRTC !== 'undefined' && WebRTC._lastPaintStats)
      ? WebRTC._lastPaintStats
      : {};
    const videoEl = (typeof document !== 'undefined' && typeof document.getElementById === 'function')
      ? document.getElementById('remoteVideo')
      : null;
    const framesDecoded = lastStats.framesDecoded != null
      ? Number(lastStats.framesDecoded)
      : Number((typeof WebRTC !== 'undefined' && WebRTC._lastInboundFramesDecoded) || 0);

    return {
      type: 'connection-diagnostic',
      schemaVersion: 3,
      browserSessionId: this.ensureBrowserSessionId(),
      connectionAttemptId,
      trigger: meta.trigger || basePayload.traceSummary?.trigger || 'manual',
      reason: meta.reason || basePayload.traceSummary?.reason || null,
      entrypoint,
      mode,
      recommendation,
      terminal: terminalState,
      network,
      events: redactedEvents,
      probeResults: Array.isArray(basePayload.probeResults) ? basePayload.probeResults.slice() : [],
      adaptiveMedia,
      startup: typeof globalThis.__WRD_STARTUP_SNAPSHOT__ === 'function'
        ? globalThis.__WRD_STARTUP_SNAPSHOT__()
        : null,
      traceSummary: {
        ...(basePayload.traceSummary || snapshot.traceSummary || {}),
        trigger: meta.trigger || basePayload.traceSummary?.trigger || 'manual',
        reason: meta.reason || basePayload.traceSummary?.reason || null,
        uiPhase: (typeof WebRTC !== 'undefined' && WebRTC.uiPhase) || null,
        hasPaintedFrame: typeof WebRTC !== 'undefined' ? WebRTC.hasPaintedFrame === true : false,
        userPreference: session.userPreference || null,
        pathCap: session.pathCap || null,
        sessionPresentation: session.width
          ? { width: session.width, height: session.height, label: session.label, capped: session.capped }
          : null,
        explicitOverride1080: session.explicitOverride1080 === true
          || (typeof WebRTC !== 'undefined' && WebRTC._explicitOverride1080 === true),
        videoWidth: Number(lastStats.videoWidth || videoEl?.videoWidth || 0),
        videoHeight: Number(lastStats.videoHeight || videoEl?.videoHeight || 0),
        readyState: Number(videoEl?.readyState || 0),
        framesReceived: Number(lastStats.framesReceived || 0),
        framesDecoded,
        fps: Number(lastStats.fps || 0),
        jitterBufferMs: Number(lastStats.jitterBufferMs || 0),
        bytesReceived: Number(lastStats.bytesReceived || 0),
        keyframeRequested: typeof WebRTC !== 'undefined'
          ? Boolean(WebRTC._lastKeyframeRequestAt || WebRTC._keyframeRequested)
          : false,
        keyframeEmitted: typeof WebRTC !== 'undefined' ? WebRTC._keyframeEmitted === true : false,
      },
      redaction: {
        ...(basePayload.redaction || snapshot.redaction || {}),
      },
    };
  },

  redactTraceEvent(event) {
    if (!event || typeof event !== 'object') {
      return event;
    }
    const cloned = {
      ...event,
      data: event.data && typeof event.data === 'object' ? { ...event.data } : event.data,
    };
    if (cloned.data && typeof cloned.data === 'object') {
      Object.keys(cloned.data).forEach((key) => {
        const value = cloned.data[key];
        if (typeof value === 'string' && /token|secret|password|url/i.test(key)) {
          cloned.data[key] = key.toLowerCase().includes('url') ? '[redacted-url]' : '[redacted]';
        }
      });
    }
    return cloned;
  },

  getPendingDiagnostics() {
    try {
      return JSON.parse(localStorage.getItem('wrdPendingDiagnostics') || '[]');
    } catch (_err) {
      return [];
    }
  },

  setPendingDiagnostics(items) {
    localStorage.setItem('wrdPendingDiagnostics', JSON.stringify(items));
  },

  enqueuePendingDiagnostic(payload) {
    const pending = this.getPendingDiagnostics();
    const attemptId = String(payload?.connectionAttemptId || payload?.attemptId || '').trim() || 'global';
    // One pending payload per attempt — keep the latest failure for that attempt.
    const deduped = pending.filter((item) => {
      const id = String(item?.connectionAttemptId || item?.attemptId || '').trim() || 'global';
      return id !== attemptId;
    });
    deduped.push(payload);
    while (deduped.length > 10) deduped.shift();
    this.setPendingDiagnostics(deduped);
  },

  pruneAutoSendCooldown(now = Date.now()) {
    Object.keys(this.autoSendByAttempt).forEach((attemptId) => {
      if (now - Number(this.autoSendByAttempt[attemptId] || 0) >= this.autoSendCooldownMs) {
        delete this.autoSendByAttempt[attemptId];
      }
    });
  },

  /**
   * Unified per-attempt cooldown gate for live auto-send and pending replay.
   * Returns true once and stamps the attempt; false if still cooling down.
   */
  claimAttemptSendSlot(attemptId, now = Date.now()) {
    const id = String(attemptId || '').trim() || 'global';
    this.pruneAutoSendCooldown(now);
    const lastSentAt = Number(this.autoSendByAttempt[id] || 0);
    if (now - lastSentAt < this.autoSendCooldownMs) {
      return false;
    }
    this.autoSendByAttempt[id] = now;
    return true;
  },

  async sendConnectionDiagnostic(payload) {
    const diagnosticPayload = payload || this.buildConnectionDiagnostic();
    try {
      if (typeof WebRTC !== 'undefined' && WebRTC.socket && WebRTC.socket.connected) {
        WebRTC.socket.emit('diagnostic', diagnosticPayload);
        return true;
      }

      if (typeof fetch === 'function') {
        const apiBase = (typeof RuntimeConfig !== 'undefined' && typeof RuntimeConfig.getApiBase === 'function')
          ? RuntimeConfig.getApiBase()
          : String(window.location.origin || '').replace(/\/+$/, '');
        const token = (typeof Auth !== 'undefined' && typeof Auth.getToken === 'function')
          ? Auth.getToken()
          : '';
        const headers = { 'Content-Type': 'application/json' };
        if (token) {
          headers.Authorization = `Bearer ${token}`;
        }
        const response = await fetch(`${apiBase}/api/diagnostics`, {
          method: 'POST',
          headers,
          body: JSON.stringify(diagnosticPayload),
        });
        if (response.ok) {
          return true;
        }
      }
    } catch (_err) {
      // fall through to queue
    }

    this.enqueuePendingDiagnostic(diagnosticPayload);
    return false;
  },

  async replayPendingDiagnostics(socket = null) {
    const targetSocket = socket || (typeof WebRTC !== 'undefined' ? WebRTC.socket : null);
    if (!targetSocket || !targetSocket.connected) {
      return 0;
    }
    const pending = this.getPendingDiagnostics();
    const remaining = [];
    let sent = 0;
    for (const payload of pending) {
      if (sent >= 2) {
        remaining.push(payload);
        continue;
      }
      const attemptId = String(payload?.connectionAttemptId || payload?.attemptId || '').trim() || 'global';
      if (!this.claimAttemptSendSlot(attemptId)) {
        // Still in unified cooldown — keep for a later replay.
        remaining.push(payload);
        continue;
      }
      targetSocket.emit('diagnostic', payload);
      sent += 1;
    }
    this.setPendingDiagnostics(remaining);
    return sent;
  },

  autoSendFailure(reason) {
    const payload = this.buildConnectionDiagnostic({
      trigger: 'auto-failure',
      reason,
    });
    const attemptId = String(payload.connectionAttemptId || '').trim() || 'global';
    if (!this.claimAttemptSendSlot(attemptId)) {
      console.log('[Diagnostic] Skip auto send due to cooldown:', reason);
      // Still refresh pending slot for this attempt so a later replay has latest payload.
      this.enqueuePendingDiagnostic(payload);
      return;
    }
    this.sendConnectionDiagnostic(payload);
  },
  });

  global.Diagnostic = Diagnostic;

  // Safe for deferred load after DOMContentLoaded already fired.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      Diagnostic.init();
    });
  } else {
    Diagnostic.init();
  }
}(typeof window !== 'undefined' ? window : globalThis));

// Classic-script / test harness binding (IIFE also assigns window.Diagnostic).
var Diagnostic = (typeof window !== 'undefined' ? window : globalThis).Diagnostic;

function updateLatencyPanel() {
  if (typeof LatencyMonitor === 'undefined') return;
  const stats = LatencyMonitor.getStats();
  const maxScale = 500; // ms, for bar width scaling

  function setBar(id, value, warn, danger) {
    const bar = document.getElementById('bar' + id);
    const val = document.getElementById('val' + id);
    if (!bar || !val) return;
    const w = Math.min(100, (value / maxScale) * 100);
    bar.style.width = w + '%';
    bar.className = '';
    if (value > danger) bar.classList.add('danger');
    else if (value > warn) bar.classList.add('warning');
    val.textContent = value > 0 ? value.toFixed(0) + 'ms' : '-';
  }

  setBar('Capture', stats.capture.p50, 50, 100);
  setBar('Encode', stats.encode.p50, 100, 200);
  setBar('Execute', stats.executeTime.p50, 20, 50);
  setBar('Network', stats.network.p50, 100, 300);
  setBar('Playout', stats.playout.p50, 200, 400);
  setBar('Input', stats.inputRtt.p50, 300, 800);

  const syncEl = document.getElementById('latencySync');
  if (syncEl) {
    if (stats.sync.state === 'synced') {
      syncEl.textContent = `时钟同步: RTT=${stats.sync.rtt.toFixed(1)}ms offset=${stats.sync.offset.toFixed(1)}ms`;
      syncEl.style.color = '#4ade80';
    } else {
      syncEl.textContent = '时钟同步: 未同步';
      syncEl.style.color = 'var(--text-muted)';
    }
  }
}

// Update every 2 seconds
setInterval(updateLatencyPanel, 2000);
