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
    if (this._panelDisposed) return;
    if (this._panelInitError) throw this._panelInitError;
    if (this._panelInitialized) return;
    this._panelInitialized = true;
    try {
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
      this._latencyPanelInterval = setInterval(updateLatencyPanel, 2000);
      console.log('[Diagnostic] Log collector initialized');
    } catch (error) {
      this._panelInitError = error;
      throw error;
    }
  },

  dispose() {
    this._panelDisposed = true;
    if (this._latencyPanelInterval != null) clearInterval(this._latencyPanelInterval);
    this._latencyPanelInterval = null;
    if (this._panelDomReady && typeof document.removeEventListener === 'function') {
      document.removeEventListener('DOMContentLoaded', this._panelDomReady);
    }
    this._panelDomReady = null;
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

  async sendLogs(meta = {}) {
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
    payload.logs = this.logs.slice(-120);
    payload.logReceipt = {
      state: payload.logs.length ? 'valid' : 'empty',
      reported: payload.logs.length,
      retained: 0,
      redacted: payload.logs.length,
      dropped: Number.isSafeInteger(payload.truncation?.dropped) ? payload.truncation.dropped : 0,
    };
    payload.network = payload.network || this.getNetworkSnapshot();
    payload.keyboardMode = payload.inputState?.keyboardMode || null;
    payload.terminal = terminalState || payload.terminal;
    payload.inputChannelTimeline = this.getInputChannelTimeline();

    const sent = await this.sendConnectionDiagnostic(payload);
    if (sent) {
      console.log('[Diagnostic] Logs sent');
      alert('服务端已确认保存诊断（按保留策略清理）');
    } else {
      console.error('[Diagnostic] Failed to send logs; queued for retry');
      alert('未获服务端保存确认，请稍后重试');
    }
    return sent;
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
    // _lastPaintStats is canonical interval telemetry. Keep all legacy names at
    // this diagnostic schema boundary so consumers cannot mix paint totals with
    // a current sampling interval.
    const mediaStats = {
      receivedDelta: Number(lastStats.receivedDelta || 0),
      decodedDelta: Number(lastStats.decodedDelta || 0),
      derivedFps: Number(lastStats.derivedFps || 0),
      bytesDelta: Number(lastStats.bytesDelta || 0),
      framesDroppedDelta: Number(lastStats.framesDroppedDelta || 0),
      packetsReceivedDelta: Number(lastStats.packetsReceivedDelta || 0),
      nackCountDelta: Number(lastStats.nackCountDelta || 0),
      pliCountDelta: Number(lastStats.pliCountDelta || 0),
      firCountDelta: Number(lastStats.firCountDelta || 0),
      freezeDelta: Number(lastStats.freezeDelta || 0),
    };

    return {
      type: 'connection-diagnostic',
      ...this.buildRuntimeDiagnostic({ reason: meta.reason || basePayload.traceSummary?.reason || null }),
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
      traceSummary: {
        ...(basePayload.traceSummary || snapshot.traceSummary || {}),
        controlHeartbeat: sanitizeControlHeartbeat(typeof WebRTC !== 'undefined'
          ? WebRTC.getControlHeartbeatSnapshot?.() : null),
        diagnosticAdmission: (typeof WebRTC !== 'undefined' && typeof sanitizeDiagnosticAdmission === 'function')
          ? sanitizeDiagnosticAdmission(WebRTC._hostDiagnosticAdmission)
          : null,
        trigger: meta.trigger || basePayload.traceSummary?.trigger || 'manual',
        reason: meta.reason || basePayload.traceSummary?.reason || null,
        uiPhase: (typeof WebRTC !== 'undefined' && WebRTC.uiPhase) || null,
        hasPaintedFrame: typeof WebRTC !== 'undefined' ? WebRTC.hasPaintedFrame === true : false,
        frameTrace: (typeof WebRTC !== 'undefined' && typeof WebRTC.getFrameTraceDiagnostics === 'function')
          ? WebRTC.getFrameTraceDiagnostics()
          : null,
        userPreference: session.userPreference || null,
        pathCap: session.pathCap || null,
        sessionPresentation: session.width
          ? { width: session.width, height: session.height, label: session.label, capped: session.capped }
          : null,
        explicitOverride1080: session.explicitOverride1080 === true
          || (typeof WebRTC !== 'undefined' && WebRTC._explicitOverride1080 === true),
        paintObservation: (typeof WebRTC !== 'undefined' && WebRTC._lastPaintObservation)
          ? WebRTC._lastPaintObservation
          : null,
        videoWidth: Number(lastStats.videoWidth || videoEl?.videoWidth || 0),
        videoHeight: Number(lastStats.videoHeight || videoEl?.videoHeight || 0),
        readyState: Number(videoEl?.readyState || 0),
        mediaInterval: (typeof WebRTC !== 'undefined' && typeof WebRTC.getDiagnosticMediaInterval === 'function')
          ? WebRTC.getDiagnosticMediaInterval() : null,
        ...mediaStats,
        jitterBufferMs: typeof lastStats.jitterBufferMs === 'number'
          && Number.isFinite(lastStats.jitterBufferMs) && lastStats.jitterBufferMs >= 0
          ? lastStats.jitterBufferMs : null,
        // Compatibility aliases for the versioned diagnostic payload only.
        framesReceived: mediaStats.receivedDelta,
        framesDecoded: mediaStats.decodedDelta,
        fps: mediaStats.derivedFps,
        bytesReceived: mediaStats.bytesDelta,
        framesDropped: mediaStats.framesDroppedDelta,
        packetsReceived: mediaStats.packetsReceivedDelta,
        nackCount: mediaStats.nackCountDelta,
        pliCount: mediaStats.pliCountDelta,
        firCount: mediaStats.firCountDelta,
        freezeCount: mediaStats.freezeDelta,
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

  });

  global.Diagnostic = Diagnostic;

  // Safe for deferred load after DOMContentLoaded already fired.
  if (!global.__WRD_DEFERRED_MANAGED__) {
    if (document.readyState === 'loading') {
      if (!Diagnostic._panelDomReady) {
        Diagnostic._panelDomReady = () => {
          Diagnostic._panelDomReady = null;
          Diagnostic.init();
        };
        document.addEventListener('DOMContentLoaded', Diagnostic._panelDomReady, { once: true });
      }
    } else {
      Diagnostic.init();
    }
  }
}(typeof window !== 'undefined' ? window : globalThis));

// Classic-script / test harness binding (IIFE also assigns window.Diagnostic).
var Diagnostic = (typeof window !== 'undefined' ? window : globalThis).Diagnostic;

function updateLatencyPanel() {
  if (typeof LatencyMonitor === 'undefined') return;
  const stats = LatencyMonitor.getStats();
  const maxScale = 500; // ms, for bar width scaling

  function setBar(id, value, warn, danger, available = typeof value === 'number' && Number.isFinite(value)) {
    const bar = document.getElementById('bar' + id);
    const val = document.getElementById('val' + id);
    if (!bar || !val) return;
    const w = available ? Math.min(100, (Number(value) / maxScale) * 100) : 0;
    bar.style.width = w + '%';
    bar.className = '';
    if (available && value > danger) bar.classList.add('danger');
    else if (available && value > warn) bar.classList.add('warning');
    val.textContent = available ? `${Number(value).toFixed(0)}ms` : '未测量';
  }

  const phase = (name) => stats[name] || { p50: null, available: false };
  const render = (key, id, warn, danger) => { const item = phase(key); setBar(id, item.p50, warn, danger, item.available === true); };
  render('capture', 'Capture', 50, 100);
  render('encode', 'Encode', 100, 200);
  render('executeTime', 'Execute', 20, 50);
  render('network', 'Network', 100, 300);
  render('playout', 'Playout', 200, 400);
  const metrics = LatencyMonitor.snapshot?.().metrics || {};
  setBar('Input', metrics.inputAckRttMs?.p50, 300, 800, metrics.inputAckRttMs?.available === true);
  setBar('Fresh', metrics.freshFrameAgeMs?.last, 300, 800, metrics.freshFrameAgeMs?.available === true);
  render('visualFeedback', 'Notice', 300, 800);
  const visible = metrics.inputToVisibleEffectMs;
  setBar('Visible', visible?.p50, 300, 800, visible?.available === true);

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

// The Diagnostic instance owns the panel interval through init/dispose.
