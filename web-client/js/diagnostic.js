// Diagnostic log collector: intercepts console output and allows sending to server
const Diagnostic = {
  logs: [],
  maxLogs: 500,
  socket: null,
  lastAutoSendAt: 0,
  autoSendCooldownMs: 15000,

  init() {
    this.hijackConsole();
    this.setupUI();
    console.log('[Diagnostic] Log collector initialized');
  },

  hijackConsole() {
    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;
    const originalInfo = console.info;

    const push = (level, args) => {
      const msg = args.map(a => {
        if (typeof a === 'object') {
          try { return JSON.stringify(a); } catch (e) { return String(a); }
        }
        return String(a);
      }).join(' ');
      const entry = `[${new Date().toLocaleTimeString()}] [${level}] ${msg}`;
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

  setupUI() {
    const diagBtn = document.getElementById('diagBtn');
    const modal = document.getElementById('diagModal');
    const closeBtn = document.getElementById('closeDiagBtn');
    const sendBtn = document.getElementById('sendDiagBtn');
    const clearBtn = document.getElementById('clearDiagBtn');
    const area = document.getElementById('diagLogArea');
    const keyArea = document.getElementById('keyboardDebugArea');

    if (!diagBtn) return;

    diagBtn.addEventListener('click', () => {
      area.value = this.logs.join('\n');
      area.scrollTop = area.scrollHeight;
      if (keyArea && typeof Input !== 'undefined') {
        keyArea.value = Input.getKeyboardDebugEntries().join('\n');
        keyArea.scrollTop = keyArea.scrollHeight;
      }
      modal.classList.remove('hidden');
    });

    closeBtn.addEventListener('click', () => {
      modal.classList.add('hidden');
    });

    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.add('hidden');
    });

    clearBtn.addEventListener('click', () => {
      this.logs = [];
      area.value = '';
    });

    sendBtn.addEventListener('click', () => {
      this.sendLogs();
    });
  },

  getInputChannelTimeline() {
    return this.logs
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

    const payload = {
      type: 'diagnostic',
      timestamp: Date.now(),
      userAgent: navigator.userAgent,
      screen: `${window.screen.width}x${window.screen.height}`,
      latency: latencyStats,
      logs: this.logs.slice(-120),
      trigger: meta.trigger || 'manual',
      reason: meta.reason || null,
      network: this.getNetworkSnapshot(),
      keyboardDebug: [],
      keyboardMode: inputState?.keyboardMode || null,
      inputState: inputState ? {
        keyboardMode: inputState.keyboardMode || null,
        pendingKeys: Array.isArray(inputState.pendingKeys) ? inputState.pendingKeys.length : 0,
        lastReleaseAllReason: inputState.lastReleaseAllReason || null,
        lastKeyboardResetReason: inputState.lastKeyboardResetReason || null,
        recentInputEvents: Array.isArray(inputState.recentInputEvents) ? inputState.recentInputEvents.slice(-20) : [],
      } : null,
      inputChannelTimeline: this.getInputChannelTimeline()
    };

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

    return {
      type: 'connection-diagnostic',
      schemaVersion: 2,
      connectionAttemptId: basePayload.connectionAttemptId || snapshot.connectionAttemptId || `wrd-${Date.now()}`,
      events: redactedEvents,
      probeResults: Array.isArray(basePayload.probeResults) ? basePayload.probeResults.slice() : [],
      traceSummary: {
        ...(basePayload.traceSummary || snapshot.traceSummary || {}),
        trigger: meta.trigger || basePayload.traceSummary?.trigger || 'manual',
        reason: meta.reason || basePayload.traceSummary?.reason || null,
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
    pending.push(payload);
    this.setPendingDiagnostics(pending);
  },

  async sendConnectionDiagnostic(payload) {
    const diagnosticPayload = payload || this.buildConnectionDiagnostic();
    try {
      if (typeof WebRTC !== 'undefined' && WebRTC.socket && WebRTC.socket.connected) {
        WebRTC.socket.emit('diagnostic', diagnosticPayload);
        return true;
      }

      if (typeof fetch === 'function') {
        const response = await fetch('/api/diagnostics', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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
    const replay = pending.slice(0, 2);
    replay.forEach((payload) => {
      targetSocket.emit('diagnostic', payload);
    });
    this.setPendingDiagnostics(pending.slice(replay.length));
    return replay.length;
  },

  autoSendFailure(reason) {
    const now = Date.now();
    if (now - this.lastAutoSendAt < this.autoSendCooldownMs) {
      console.log('[Diagnostic] Skip auto send due to cooldown:', reason);
      return;
    }
    this.lastAutoSendAt = now;
    this.sendLogs({ trigger: 'auto-failure', reason });
  }
};

document.addEventListener('DOMContentLoaded', () => {
  Diagnostic.init();
});

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
