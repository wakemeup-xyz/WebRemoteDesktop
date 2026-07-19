const TERMINAL_ADMIN_TOKEN_KEY = 'wrd_terminal_admin_token';
const LAST_ACTIVE_SESSION_KEY = 'wrd_terminal_last_active_session_id';
const TERMINAL_COMPOSER_DEFAULT_HINT = 'Shift+Enter 换行 · Enter 发送';
const TERMINAL_COMPOSER_RAW_HINT = '当前程序未启用 bracketed paste，多行将按原始换行提交';
const TERMINAL_MODE_SEQUENCE_MAX_LENGTH = 256;
const TERMINAL_INPUT_MAX_BYTES = 64 * 1024;
const TERMINAL_COMPOSER_INPUT_LIMIT_ERROR = '终端输入超过 64 KiB UTF-8 限制，请缩短后重试';
const PROCESS_STATUSES = new Set(['starting', 'running', 'exited', 'failed', 'closed']);
const TERMINAL_ERROR_MESSAGES = Object.freeze({
  pty_starting: '终端正在启动',
  pty_exited: '终端进程已退出',
  pty_spawn_failed: '终端启动失败',
  pty_startup_timeout: '终端启动超时',
  pty_cleanup_failed: '终端进程清理失败，请重试',
  terminal_input_rate_limited: '终端输入过快，请稍后重试',
});
const TERMINAL_WARNING_MESSAGES = Object.freeze({
  terminal_output_backpressure: '终端输出拥塞，已断开当前观察连接',
});

function getTerminalComposerApi() {
  return (typeof window !== 'undefined' && window.TerminalComposer)
    || (typeof globalThis !== 'undefined' && globalThis.TerminalComposer)
    || null;
}

function createFallbackTerminalDraftStore() {
  return {
    get() {
      return '';
    },
    set() {},
    delete() {},
    clear() {},
  };
}

function normalizeProcessStatus(value, fallback = 'running') {
  return PROCESS_STATUSES.has(value) ? value : fallback;
}

function processStatusLabel(status) {
  if (status === 'starting') return '启动中';
  if (status === 'exited') return '已退出';
  if (status === 'failed') return '启动失败';
  return '';
}

function createLatencySeries(maxSamples = 20) {
  const samples = [];

  function summarize() {
    if (!samples.length) {
      return { last: null, min: null, max: null, p50: null, sampleCount: 0 };
    }
    const sorted = samples.slice().sort((a, b) => a - b);
    return {
      last: samples.at(-1),
      min: sorted[0],
      max: sorted.at(-1),
      p50: sorted[Math.floor(sorted.length / 2)],
      sampleCount: samples.length,
    };
  }

  return {
    record(value) {
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0) {
        return summarize();
      }
      samples.push(Math.round(number));
      if (samples.length > maxSamples) {
        samples.shift();
      }
      return summarize();
    },
    snapshot() {
      return summarize();
    },
    clear() {
      samples.length = 0;
    },
  };
}

function createTerminalState(options = {}) {
  const softWarnCount = Number(options.softWarnCount || 4);
  const sessions = new Map();
  let activeSessionId = null;
  let warning = '';

  function normalizeSession(session = {}, fallbackIndex = sessions.size + 1) {
    const previous = sessions.get(session.sessionId) || {};
    return {
      ...previous,
      ...session,
      sessionId: session.sessionId,
      title: session.title || previous.title || `Terminal ${fallbackIndex}`,
      status: session.status || previous.status || 'running',
      processStatus: normalizeProcessStatus(
        session.processStatus,
        normalizeProcessStatus(previous.processStatus, 'running'),
      ),
      warning: session.warning || previous.warning || '',
      observerCount: Number(session.observerCount ?? previous.observerCount ?? 0),
      activePresenterClientId: session.activePresenterClientId ?? previous.activePresenterClientId ?? null,
    };
  }

  function upsertSession(session, options = {}) {
    const normalized = normalizeSession(session);
    sessions.set(normalized.sessionId, normalized);
    if (options.activate || !activeSessionId) {
      activeSessionId = normalized.sessionId;
    }
    if (sessions.size > softWarnCount) {
      warning = '终端会话较多，可能影响性能';
    }
    return normalized;
  }

  function replaceSessions(nextSessions = []) {
    const seen = new Set();
    nextSessions.forEach((session, index) => {
      const normalized = normalizeSession(session, index + 1);
      sessions.set(normalized.sessionId, normalized);
      seen.add(normalized.sessionId);
    });
    Array.from(sessions.keys()).forEach((sessionId) => {
      if (!seen.has(sessionId)) {
        sessions.delete(sessionId);
      }
    });
    if (activeSessionId && !sessions.has(activeSessionId)) {
      activeSessionId = sessions.size ? Array.from(sessions.keys()).at(0) : null;
    }
    if (!activeSessionId && sessions.size) {
      activeSessionId = Array.from(sessions.keys()).at(0);
    }
    warning = sessions.size > softWarnCount ? '终端会话较多，可能影响性能' : '';
  }

  function closeTab(sessionId) {
    sessions.delete(sessionId);
    if (activeSessionId === sessionId) {
      activeSessionId = sessions.size ? Array.from(sessions.keys()).at(-1) : null;
    }
    if (sessions.size <= softWarnCount) {
      warning = '';
    }
  }

  function setActive(sessionId) {
    if (sessions.has(sessionId)) {
      activeSessionId = sessionId;
    }
  }

  function updateSession(sessionId, patch = {}) {
    const session = sessions.get(sessionId);
    if (session) {
      Object.assign(session, patch);
    }
  }

  function updateStatus(sessionId, status) {
    updateSession(sessionId, { status });
  }

  function setWarning(message) {
    warning = String(message || '');
  }

  return {
    upsertSession,
    replaceSessions,
    closeTab,
    setActive,
    updateSession,
    updateStatus,
    setWarning,
    activeSessionId: () => activeSessionId,
    sessionCount: () => sessions.size,
    getWarning: () => warning,
    getSessions: () => Array.from(sessions.values()),
    getSession: (sessionId) => sessions.get(sessionId) || null,
  };
}

const TerminalUI = {
  create(options = {}) {
    const state = createTerminalState(options);
    return {
      openTab(sessionOrId) {
        const session = typeof sessionOrId === 'string'
          ? { sessionId: sessionOrId }
          : sessionOrId;
        return state.upsertSession(session, { activate: true });
      },
      setActive(sessionId) {
        state.setActive(sessionId);
      },
      attachSession(sessionId) {
        state.setActive(sessionId);
        state.updateStatus(sessionId, 'attached');
      },
      replaceSessions: state.replaceSessions,
      updateStatus: state.updateStatus,
      closeTab: state.closeTab,
      activeSessionId: state.activeSessionId,
      sessionCount: state.sessionCount,
      getWarning: state.getWarning,
      getSessions: state.getSessions,
      getSession: state.getSession,
    };
  },
};

const TerminalPanel = {
  socket: null,
  state: createTerminalState(),
  terms: new Map(),
  fitAddons: new Map(),
  attachedSessionIds: new Set(),
  pendingAttachSessionIds: new Set(),
  pendingCloseSessionIds: new Set(),
  focusTimer: null,
  fitTimer: null,
  softWarnSessionCount: 4,
  isVisible: false,
  pendingCreateRequestId: null,
  socketAuthToken: null,
  socketState: 'idle',
  socketStatusBaseText: '',
  socketStatusKind: '',
  transportName: 'unknown',
  preferredTransport: localStorage.getItem('wrdTerminalTransport') || 'socketio',
  webrtcCapability: { available: false, reason: 'unknown' },
  webrtcPc: null,
  webrtcDc: null,
  webrtcReady: false,
  webrtcOutputReady: false,
  webrtcState: 'idle',
  terminalSocketLatency: createLatencySeries(),
  terminalInputAckLatency: createLatencySeries(),
  terminalServerProcessLatency: createLatencySeries(),
  latencyProbeTimer: null,
  pendingLatencyProbes: new Map(),
  pendingInputAcks: new Map(),
  pendingComposerInputIdsBySession: new Map(),
  composerPreflightError: null,
  echoControllersBySession: new Map(),
  alternateScreenSessionIds: new Set(),
  bracketedPasteSessionIds: new Set(),
  terminalModeTailsBySession: new Map(),
  composerDrafts: (getTerminalComposerApi()?.createTerminalDraftStore?.() || createFallbackTerminalDraftStore()),
  renderedComposerSessionId: null,
  poolCapacity: null,
  allowPolling: false,
  bootstrapAuthToken: null,
  bootstrapPromise: null,
  transportLatency: new Map(),
  aliasedEvents: new Map(),

  init() {
    this.cacheElements();
    if (!this.elements.root) return;
    this.bindEvents();
    if (this.elements.transportSelect) {
      this.elements.transportSelect.value = this.preferredTransport === 'webrtc-turn'
        ? 'webrtc-turn'
        : 'socketio';
    }
    this.render();
  },

  cacheElements() {
    this.elements = {
      root: document.getElementById('terminalPanel'),
      desktopPanel: document.getElementById('desktopPanel'),
      terminalPanel: document.getElementById('terminalPanel'),
      desktopTab: document.getElementById('desktopTabBtn'),
      terminalTab: document.getElementById('terminalTabBtn'),
      authForm: document.getElementById('terminalAuthForm'),
      authPassword: document.getElementById('terminalAdminPassword'),
      authButton: document.getElementById('terminalAuthBtn'),
      newButton: document.getElementById('terminalNewBtn'),
      sessionTabs: document.getElementById('terminalSessionTabs'),
      status: document.getElementById('terminalStatus'),
      warning: document.getElementById('terminalWarning'),
      workspace: document.getElementById('terminalWorkspace'),
      composer: document.getElementById('terminalComposer'),
      composerSubmit: document.getElementById('terminalComposerSubmit'),
      composerHint: document.getElementById('terminalComposerHint'),
      transportSelect: document.getElementById('terminalTransportSelect'),
      transportStatus: document.getElementById('terminalTransportStatus'),
      transportTestBtn: document.getElementById('terminalTransportTestBtn'),
    };
  },

  bindEvents() {
    this.elements.desktopTab?.addEventListener('click', () => this.showDesktop());
    this.elements.terminalTab?.addEventListener('click', () => this.showTerminal());
    this.elements.authForm?.addEventListener('submit', (event) => {
      event.preventDefault();
      this.authorize();
    });
    this.elements.newButton?.addEventListener('click', () => this.createSession());
    this.elements.composer?.addEventListener('input', () => this.handleComposerInput());
    this.elements.composer?.addEventListener('keydown', (event) => this.handleComposerKeydown(event));
    this.elements.composerSubmit?.addEventListener('click', () => this.submitComposer());
    this.elements.transportSelect?.addEventListener('change', (event) => {
      this.setPreferredTransport(event.target.value);
    });
    this.elements.transportTestBtn?.addEventListener('click', () => {
      this.testPreferredTransport().catch((err) => {
        this.setTransportStatus(`传输测试失败：${err?.message || err}`, 'error');
      });
    });
    window.addEventListener('resize', () => {
      this.fitActiveTerminal();
      this.scheduleFitActiveTerminal();
    });
  },

  showDesktop() {
    this.isVisible = false;
    if (typeof WebRTC !== 'undefined') {
      WebRTC.setMediaActivityReason?.('terminal-active', false);
    }
    document.body.classList.remove('terminal-active');
    this.elements.desktopPanel?.classList.remove('hidden');
    this.elements.terminalPanel?.classList.add('hidden');
    this.elements.desktopTab?.classList.add('active');
    this.elements.terminalTab?.classList.remove('active');
  },

  showTerminal() {
    this.isVisible = true;
    if (typeof WebRTC !== 'undefined') {
      WebRTC.setMediaActivityReason?.('terminal-active', true);
    }
    document.body.classList.add('terminal-active');
    this.elements.desktopPanel?.classList.add('hidden');
    this.elements.terminalPanel?.classList.remove('hidden');
    this.elements.desktopTab?.classList.remove('active');
    this.elements.terminalTab?.classList.add('active');
    if (this.hasAdminToken()) {
      this.connectSocket();
    }
    this.render();
    this.fitActiveTerminal();
    this.scheduleFitActiveTerminal();
    this.focusActiveTerminal();
    this.scheduleFocusActiveTerminal();
  },

  hasAdminToken() {
    return Boolean(sessionStorage.getItem(TERMINAL_ADMIN_TOKEN_KEY));
  },

  getAdminToken() {
    return sessionStorage.getItem(TERMINAL_ADMIN_TOKEN_KEY);
  },

  clearAdminToken() {
    sessionStorage.removeItem(TERMINAL_ADMIN_TOKEN_KEY);
  },

  isAuthFailure(errorLike) {
    const message = String(errorLike?.message || errorLike || '').toLowerCase();
    return (
      message.includes('jwt expired')
      || message.includes('unauthorized')
      || message.includes('invalid token')
      || message.includes('authentication required')
    );
  },

  setStatus(text, kind = '') {
    this.socketStatusBaseText = String(text || '');
    this.socketStatusKind = kind;
    this.refreshStatus();
  },

  refreshStatus() {
    if (!this.elements.status) return;
    const extras = [];
    const socketLatency = this.terminalSocketLatency.snapshot();
    const inputAckLatency = this.terminalInputAckLatency.snapshot();
    const serverProcessLatency = this.terminalServerProcessLatency.snapshot();
    if (this.transportName && this.transportName !== 'unknown' && this.socketState === 'connected') {
      extras.push(this.transportName);
    }
    if (Number.isFinite(socketLatency.p50)) {
      extras.push(`RTT ${socketLatency.p50}ms`);
    }
    if (Number.isFinite(inputAckLatency.p50)) {
      extras.push(`输入 ${inputAckLatency.p50}ms`);
    }
    if (Number.isFinite(serverProcessLatency.p50)) {
      extras.push(`服务端 ${serverProcessLatency.p50}ms`);
    }
    this.elements.status.textContent = extras.length
      ? `${this.socketStatusBaseText} · ${extras.join(' · ')}`
      : this.socketStatusBaseText;
    this.elements.status.dataset.state = this.socketStatusKind;
  },

  setWarning(text) {
    this.state.setWarning(text);
    if (this.elements.warning) {
      this.elements.warning.textContent = text;
      this.elements.warning.classList.toggle('hidden', !text);
    }
  },

  async authorize() {
    const password = this.elements.authPassword?.value || '';
    if (!password) {
      this.setStatus('请输入 admin 密码', 'warning');
      return;
    }

    try {
      const response = await fetch(RuntimeConfig.url('/api/auth/login/admin'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.error || `HTTP ${response.status}`);
      }
      sessionStorage.setItem(TERMINAL_ADMIN_TOKEN_KEY, body.token);
      this.elements.authPassword.value = '';
      this.releaseTerminalControlFocus();
      this.setStatus('已授权', 'connected');
      await this.connectSocket();
      this.render();
    } catch (err) {
      this.setStatus(`授权失败：${err.message}`, 'error');
    }
  },

  connectSocket() {
    const token = this.getAdminToken();
    if (!token || typeof io === 'undefined') return;
    if (typeof fetch === 'function' && this.bootstrapAuthToken !== token) {
      return this.ensureTerminalBootstrap(token).then(() => {
        if (this.getAdminToken() === token) this.connectSocket();
      });
    }
    const canReuseSocket = this.socket
      && this.socket.connected
      && this.socketAuthToken === token
      && this.socketState !== 'error';
    if (canReuseSocket) return;
    this.destroySocket();

    const transports = this.allowPolling ? ['websocket', 'polling'] : ['websocket'];
    this.socket = io(`${RuntimeConfig.getSocketBase()}/terminal`, {
      auth: {
        token,
        clientId: this.getBrowserSessionId(),
      },
      transports,
      rememberUpgrade: true,
    });
    this.socketAuthToken = token;
    this.socketState = 'connecting';

    this.socket.on('connect', () => {
      this.resetEchoControllers('reconnect');
      this.socketState = 'connected';
      if (this.preferredTransport !== 'webrtc-turn') {
        this.setTransportName(this.socket.io?.engine?.transport?.name || 'websocket');
      }
      this.attachedSessionIds.clear();
      this.pendingAttachSessionIds.clear();
      this.pendingCloseSessionIds.clear();
      this.setStatus('共享控制台已连接', 'connected');
      this.startLatencyProbeLoop();
      if (typeof this.socket.io?.engine?.on === 'function') {
        this.socket.io.engine.on('upgrade', (transport) => {
          if (this.preferredTransport !== 'webrtc-turn') {
            this.setTransportName(transport?.name || this.transportName || 'unknown');
          }
          this.refreshStatus();
        });
      }
      this.socket.emit('terminal:list', {});
      if (this.preferredTransport === 'webrtc-turn') {
        this.startWebRtcTransport().catch((err) => {
          this.setTransportStatus(`TURN DataChannel 建立失败：${err?.message || err}`, 'error');
        });
      } else {
        this.setTransportStatus('使用 Socket.IO 传输', 'connected');
      }
      this.render();
    });
    this.socket.on('disconnect', () => {
      this.resetEchoControllers('disconnect');
      this.socketState = 'disconnected';
      this.stopWebRtcTransport('socket-disconnect');
      this.stopLatencyProbeLoop();
      this.pendingInputAcks.clear();
      this.pendingComposerInputIdsBySession.clear();
      this.composerPreflightError = null;
      this.attachedSessionIds.clear();
      this.pendingAttachSessionIds.clear();
      this.pendingCreateRequestId = null;
      this.setStatus('断线重连中', 'warning');
      this.state.getSessions().forEach((session) => this.state.updateStatus(session.sessionId, 'detached'));
      this.render();
    });
    this.socket.on('connect_error', (err) => {
      this.socketState = 'error';
      if (this.isAuthFailure(err)) {
        this.clearAdminToken();
        this.destroySocket();
        this.setStatus('授权已过期，请重新授权', 'warning');
        this.render();
        return;
      }
      this.setStatus(`连接失败：${err.message}`, 'error');
      this.refreshComposer();
    });
    const applyPoolSnapshot = (payload) => this.dispatchAliasedEvent(
      'snapshot', payload, () => this.applyPoolSnapshot(payload),
    );
    const handleSessionCreated = (session) => this.dispatchAliasedEvent(
      'created', session, () => this.handleSessionCreated(session),
    );
    const handleSessionAttached = (session) => this.dispatchAliasedEvent(
      'attached', session, () => this.attachSessionState(session),
    );
    const handleSessionClosed = (session) => this.dispatchAliasedEvent(
      'closed', session, () => this.handleSessionClosed(session),
    );

    this.socket.on('terminal:pool_snapshot', applyPoolSnapshot);
    this.socket.on('terminal:snapshot', applyPoolSnapshot);
    this.socket.on('terminal:session_created', handleSessionCreated);
    this.socket.on('terminal:created', handleSessionCreated);
    this.socket.on('terminal:session_attached', handleSessionAttached);
    this.socket.on('terminal:attached', handleSessionAttached);
    this.socket.on('terminal:output', (payload, acknowledge) => {
      try {
        // While TURN DC output is preferred and healthy, suppress Socket.IO output
        // to avoid double-writing the same PTY bytes.
        if (this.shouldPreferWebRtcOutput(payload.sessionId)) {
          return;
        }
        const session = this.state.getSession(payload.sessionId);
        if (session?.processStatus === 'starting') {
          this.state.updateSession(payload.sessionId, { processStatus: 'running' });
          this.render();
        }
        this.writeOutput(payload.sessionId, payload.data);
      } finally {
        if (typeof acknowledge === 'function') acknowledge();
      }
    });
    this.socket.on('terminal:input_ack', (payload) => {
      this.handleInputAck(payload);
    });
    this.socket.on('terminal:webrtc_capability', (payload = {}) => {
      this.webrtcCapability = {
        available: payload.available === true,
        reason: payload.reason || (payload.available ? 'ready' : 'unavailable'),
        iceTransportPolicy: payload.iceTransportPolicy || 'relay',
      };
      if (this.elements.transportSelect) {
        const webrtcOption = this.elements.transportSelect.querySelector('option[value="webrtc-turn"]');
        if (webrtcOption) {
          webrtcOption.disabled = !this.webrtcCapability.available;
        }
      }
      if (!this.webrtcCapability.available && this.preferredTransport === 'webrtc-turn') {
        this.setTransportStatus(`TURN DataChannel 不可用：${this.webrtcCapability.reason}`, 'error');
      }
    });
    this.socket.on('terminal:webrtc_ice', async (payload = {}) => {
      if (!this.webrtcPc || !payload?.candidate) return;
      try {
        await this.webrtcPc.addIceCandidate({
          candidate: payload.candidate,
          sdpMid: payload.mid || '0',
        });
      } catch (error) {
        console.warn('[terminal] addIceCandidate failed', error);
      }
    });
    this.socket.on('terminal:pong', (payload) => {
      this.handleLatencyPong(payload);
    });
    this.socket.on('terminal:replay', (payload) => {
      this.writeReplay(payload.sessionId, payload.replay);
    });
    this.socket.on('terminal:exit', (payload) => {
      this.state.updateSession(payload.sessionId, {
        processStatus: normalizeProcessStatus(
          payload.processStatus,
          payload.errorCode ? 'failed' : 'exited',
        ),
      });
      this.writeOutput(payload.sessionId, `\r\n[process exited: ${payload.exitCode ?? ''} ${payload.signal || ''}]\r\n`);
      this.render();
    });
    this.socket.on('terminal:session_closed', handleSessionClosed);
    this.socket.on('terminal:closed', handleSessionClosed);
    this.socket.on('terminal:presence', (payload) => {
      this.updatePresence(payload);
    });
    this.socket.on('terminal:warning', (payload) => {
      const warning = (
        TERMINAL_WARNING_MESSAGES[payload.code]
        || payload.message
        || '终端会话较多，可能影响性能'
      );
      if (payload.code === 'terminal_output_backpressure' && payload.sessionId) {
        this.attachedSessionIds.delete(payload.sessionId);
        this.pendingAttachSessionIds.delete(payload.sessionId);
        this.state.updateSession(payload.sessionId, {
          status: 'detached',
          warning,
        });
      }
      this.setWarning(warning);
      this.render();
    });
    this.socket.on('terminal:error', (payload) => {
      if (payload.sessionId && ['pty_spawn_failed', 'pty_startup_timeout'].includes(payload.code)) {
        this.state.updateSession(payload.sessionId, { processStatus: 'failed' });
        this.render();
      }
      if (
        payload.sessionId
        && payload.code === 'pty_exited'
      ) {
        this.state.updateSession(payload.sessionId, { processStatus: 'exited' });
        this.render();
      }
      if (
        payload.sessionId
        && ['pty_cleanup_failed', 'terminal_close_failed'].includes(payload.code)
      ) {
        this.pendingCloseSessionIds.delete(payload.sessionId);
        if (payload.code === 'pty_cleanup_failed') {
          this.ensureSession({
            sessionId: payload.sessionId,
            processStatus: 'closed',
          });
        }
        this.render();
      }
      this.handleTerminalError(payload);
    });
    return this.socket;
  },

  getBrowserSessionId() {
    const key = 'wrd_browser_session_id';
    let id = sessionStorage.getItem(key);
    if (!id) {
      id = `browser_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      sessionStorage.setItem(key, id);
    }
    return id;
  },

  makeInputId(sessionId) {
    return `${sessionId || 'term'}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  },

  emitTerminalInput(sessionId, data, options = {}) {
    if (!this.socket?.connected || !sessionId) {
      return null;
    }
    if (this.state.getSession(sessionId)?.processStatus && this.state.getSession(sessionId)?.processStatus !== 'running') {
      return null;
    }
    const inputId = this.makeInputId(sessionId);
    const clientSentAt = Date.now();
    this.pendingInputAcks.set(inputId, {
      sessionId,
      clientSentAt,
      ...options.pendingAckMeta,
    });
    if (options.optimisticEcho) {
      this.applyOptimisticLocalEcho(sessionId, data);
    }

    if (this.preferredTransport === 'webrtc-turn' && this.webrtcReady && this.webrtcDc?.readyState === 'open') {
      try {
        this.webrtcDc.send(JSON.stringify({
          t: 'in',
          sid: sessionId,
          data,
          inputId,
          clientSentAt,
        }));
        return { inputId, clientSentAt, path: 'webrtc-turn' };
      } catch (error) {
        this.setTransportStatus(`TURN DataChannel 发送失败：${error?.message || error}`, 'error');
        // Explicit policy: do not silently fall back to socketio.
        return null;
      }
    }

    this.socket.emit('terminal:input', {
      sessionId,
      data,
      inputId,
      clientSentAt,
    });
    return { inputId, clientSentAt, path: 'socketio' };
  },

  setPreferredTransport(mode) {
    const next = mode === 'webrtc-turn' ? 'webrtc-turn' : 'socketio';
    this.preferredTransport = next;
    localStorage.setItem('wrdTerminalTransport', next);
    if (this.elements.transportSelect) {
      this.elements.transportSelect.value = next;
    }
    if (next === 'webrtc-turn') {
      this.startWebRtcTransport().catch((err) => {
        this.setTransportStatus(`TURN DataChannel 不可用：${err?.message || err}`, 'error');
      });
    } else {
      this.stopWebRtcTransport('switch-to-socketio');
      this.setTransportName(this.socket?.io?.engine?.transport?.name || 'websocket');
      this.setTransportStatus('使用 Socket.IO 传输', 'connected');
    }
    this.refreshStatus();
  },

  setTransportStatus(text, kind = '') {
    if (this.elements.transportStatus) {
      this.elements.transportStatus.textContent = text;
      this.elements.transportStatus.dataset.state = kind || '';
    }
  },

  stopWebRtcTransport(reason = 'stop') {
    this.webrtcReady = false;
    this.webrtcOutputReady = false;
    this.webrtcState = 'idle';
    try { this.webrtcDc?.close?.(); } catch (_err) { /* ignore */ }
    try { this.webrtcPc?.close?.(); } catch (_err) { /* ignore */ }
    this.webrtcDc = null;
    this.webrtcPc = null;
    if (this.socket?.connected) {
      this.socket.emit('terminal:webrtc_close', { reason });
    }
  },

  shouldPreferWebRtcOutput(sessionId) {
    if (this.preferredTransport !== 'webrtc-turn') return false;
    if (!this.webrtcReady || !this.webrtcOutputReady) return false;
    if (!this.webrtcDc || this.webrtcDc.readyState !== 'open') return false;
    const activeId = this.state.activeSessionId();
    if (sessionId && activeId && sessionId !== activeId) {
      // Only suppress for the active bound session; other sessions keep Socket.IO.
      return false;
    }
    return true;
  },

  async startWebRtcTransport() {
    if (!this.socket?.connected) {
      throw new Error('terminal socket not connected');
    }
    if (!this.webrtcCapability?.available) {
      throw new Error(this.webrtcCapability?.reason || 'webrtc-turn unavailable');
    }
    if (typeof RTCPeerConnection === 'undefined') {
      throw new Error('RTCPeerConnection unavailable');
    }

    this.stopWebRtcTransport('restart');
    this.webrtcState = 'connecting';
    this.setTransportStatus('正在建立 TURN DataChannel…', 'warning');

    // Reuse desktop TURN iceServers from WebRTC config when present.
    let iceServers = [];
    if (typeof WebRTC !== 'undefined') {
      if (!WebRTC.serverConfig) {
        await WebRTC.loadServerConfig?.();
      }
      iceServers = (WebRTC.serverConfig?.iceServers || []).filter((server) => {
        const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
        return urls.some((url) => /^turns?:/i.test(String(url || '')));
      });
    }
    if (!iceServers.length) {
      throw new Error('TURN iceServers unavailable');
    }

    const pc = new RTCPeerConnection({
      iceServers,
      iceTransportPolicy: 'relay',
    });
    this.webrtcPc = pc;
    const dc = pc.createDataChannel('terminal', { ordered: true });
    this.webrtcDc = dc;

    dc.onopen = () => {
      this.webrtcReady = true;
      this.webrtcOutputReady = false;
      this.webrtcState = 'connected';
      this.setTransportName('webrtc-turn');
      this.setTransportStatus('TURN DataChannel 已连接', 'connected');
      try {
        dc.send(JSON.stringify({
          t: 'bind',
          clientId: this.getBrowserSessionId(),
          sid: this.state.activeSessionId() || '',
          preferDcOutput: true,
        }));
      } catch (_err) { /* ignore */ }
      this.refreshStatus();
    };
    dc.onclose = () => {
      this.webrtcReady = false;
      this.webrtcOutputReady = false;
      this.webrtcState = 'closed';
      if (this.preferredTransport === 'webrtc-turn') {
        this.setTransportStatus('TURN DataChannel 已断开（未静默回退 Socket.IO）', 'error');
      }
      this.refreshStatus();
    };
    dc.onmessage = (event) => {
      this.handleWebRtcMessage(event.data);
    };

    pc.onicecandidate = (event) => {
      if (!event.candidate || !this.socket?.connected) return;
      this.socket.emit('terminal:webrtc_ice', {
        candidate: event.candidate.candidate,
        mid: event.candidate.sdpMid || '0',
      });
    };

    const answerWaiter = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('webrtc answer timeout')), 10000);
      const onAnswer = (payload) => {
        clearTimeout(timer);
        this.socket.off('terminal:webrtc_answer', onAnswer);
        resolve(payload);
      };
      this.socket.on('terminal:webrtc_answer', onAnswer);
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.socket.emit('terminal:webrtc_offer', {
      offer: { type: offer.type, sdp: offer.sdp },
    });
    const answer = await answerWaiter;
    await pc.setRemoteDescription({
      type: answer.type || 'answer',
      sdp: answer.sdp || answer,
    });
    return true;
  },

  handleWebRtcMessage(raw) {
    let message = raw;
    if (typeof raw === 'string') {
      try { message = JSON.parse(raw); } catch (_err) { return; }
    }
    const type = String(message?.t || '');
    if (type === 'pong') {
      // Reuse existing latency machinery with synthetic payload.
      this.handleLatencyPong({
        nonce: message.echo || null,
        clientSentAt: Number(message.echo) || null,
        serverReceivedAt: Number(message.ts) || Date.now(),
        serverSentAt: Number(message.ts) || Date.now(),
        transport: 'webrtc-turn',
      });
      return;
    }
    if (type === 'ack') {
      this.handleInputAck({
        sessionId: message.sid,
        inputId: message.inputId,
        clientSentAt: null,
        serverReceivedAt: Date.now(),
        serverSentAt: Date.now(),
        transport: 'webrtc-turn',
        serverProcessMs: message.serverProcessMs,
      });
      return;
    }
    if (type === 'out') {
      const sessionId = message.sid || this.state.activeSessionId();
      if (!sessionId) return;
      const session = this.state.getSession(sessionId);
      if (session?.processStatus === 'starting') {
        this.state.updateSession(sessionId, { processStatus: 'running' });
        this.render();
      }
      this.writeOutput(sessionId, message.data || '');
      return;
    }
    if (type === 'output_bound') {
      this.webrtcOutputReady = true;
      this.setTransportStatus('TURN DataChannel 输入/输出已绑定', 'connected');
      return;
    }
    if (type === 'output_fallback') {
      this.webrtcOutputReady = false;
      this.setTransportStatus('TURN 输出失败，已恢复 Socket.IO 输出（输入仍保持 TURN 策略）', 'warning');
      return;
    }
    if (type === 'exit') {
      const sessionId = message.sid || this.state.activeSessionId();
      if (!sessionId) return;
      this.state.updateSession(sessionId, {
        processStatus: normalizeProcessStatus(
          message.processStatus,
          message.exitCode != null ? 'exited' : 'failed',
        ),
      });
      this.writeOutput(
        sessionId,
        `\r\n[process exited: ${message.exitCode ?? ''} ${message.signal || ''}]\r\n`,
      );
      this.render();
      return;
    }
    if (type === 'error') {
      this.setTransportStatus(`TURN 传输错误：${message.code || message.message || 'unknown'}`, 'error');
      return;
    }
    if (type === 'ready' || type === 'bound') {
      this.webrtcReady = true;
      if (message.output) this.webrtcOutputReady = true;
      this.setTransportStatus('TURN DataChannel 就绪', 'connected');
    }
  },

  async testPreferredTransport() {
    if (this.preferredTransport !== 'webrtc-turn') {
      this.setTransportStatus('当前为 Socket.IO；可用延迟探针验证连接', 'connected');
      return { ok: true, transport: 'socketio' };
    }
    await this.startWebRtcTransport();
    if (!this.webrtcDc || this.webrtcDc.readyState !== 'open') {
      throw new Error('datachannel not open');
    }
    const ts = Date.now();
    this.webrtcDc.send(JSON.stringify({ t: 'ping', ts }));
    this.setTransportStatus('已发送 TURN ping', 'warning');
    return { ok: true, transport: 'webrtc-turn' };
  },

  makeCreateRequestId() {
    return `create_${Date.now()}_${Math.random().toString(16).slice(2)}`.slice(0, 128);
  },

  getTransportName() {
    return String(this.transportName || this.socket?.io?.engine?.transport?.name || 'unknown');
  },

  getTransportLatency(name = this.getTransportName()) {
    const transport = String(name || 'unknown');
    if (!this.transportLatency.has(transport)) {
      this.transportLatency.set(transport, {
        socket: createLatencySeries(),
        input: createLatencySeries(),
        server: createLatencySeries(),
      });
    }
    return this.transportLatency.get(transport);
  },

  setTransportName(name) {
    this.transportName = String(name || 'unknown');
    const latency = this.getTransportLatency(this.transportName);
    this.terminalSocketLatency = latency.socket;
    this.terminalInputAckLatency = latency.input;
    this.terminalServerProcessLatency = latency.server;
  },

  reportTransportMetric(name, value, transport = this.getTransportName()) {
    if (!this.socket?.connected || !Number.isFinite(value)) return;
    this.socket.emit('terminal:client_metrics', {
      name,
      transport: String(transport || 'unknown'),
      value: Math.max(0, value),
    });
  },

  applyBootstrap(payload = {}) {
    this.allowPolling = payload.allowPolling === true;
    if (Number.isFinite(Number(payload.softWarnSessionCount))) {
      this.softWarnSessionCount = Number(payload.softWarnSessionCount);
    }
  },

  ensureTerminalBootstrap(token) {
    if (this.bootstrapAuthToken === token) return Promise.resolve();
    if (this.bootstrapPromise) return this.bootstrapPromise;
    this.bootstrapPromise = (async () => {
      try {
        const response = await fetch(RuntimeConfig.url('/api/terminal/bootstrap'), {
          headers: { Authorization: `Bearer ${token}` },
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
        this.applyBootstrap(body);
      } catch (err) {
        this.applyBootstrap({ allowPolling: false });
      } finally {
        this.bootstrapAuthToken = token;
        this.bootstrapPromise = null;
      }
    })();
    return this.bootstrapPromise;
  },

  dispatchAliasedEvent(kind, payload = {}, apply) {
    const identity = payload.sessionId || payload.poolId || 'pool';
    const key = `${kind}:${identity}:${JSON.stringify(payload)}`;
    if (this.aliasedEvents.has(key)) return false;
    this.aliasedEvents.set(key, true);
    const timer = setTimeout(() => this.aliasedEvents.delete(key), 0);
    timer?.unref?.();
    apply();
    return true;
  },

  startLatencyProbeLoop() {
    this.stopLatencyProbeLoop();
    this.sendLatencyProbe();
    this.latencyProbeTimer = setTimeout(() => {
      this.latencyProbeTimer = null;
      if (this.socket?.connected) {
        this.startLatencyProbeLoop();
      }
    }, 5000);
    if (typeof this.latencyProbeTimer?.unref === 'function') {
      this.latencyProbeTimer.unref();
    }
  },

  stopLatencyProbeLoop() {
    if (this.latencyProbeTimer) {
      clearTimeout(this.latencyProbeTimer);
      this.latencyProbeTimer = null;
    }
    this.pendingLatencyProbes.clear();
  },

  sendLatencyProbe() {
    if (!this.socket?.connected) {
      return;
    }
    const nonce = this.makeInputId('ping');
    const clientSentAt = Date.now();
    this.pendingLatencyProbes.set(nonce, clientSentAt);
    this.socket.emit('terminal:ping', {
      nonce,
      clientSentAt,
    });
  },

  handleLatencyPong(payload = {}) {
    const nonce = typeof payload.nonce === 'string' ? payload.nonce : '';
    const sentAt = this.pendingLatencyProbes.get(nonce);
    const clientSentAt = sentAt;
    if (nonce) {
      this.pendingLatencyProbes.delete(nonce);
    }
    if (!Number.isFinite(clientSentAt)) {
      return;
    }
    const transport = payload.transport || this.getTransportName();
    const value = Math.max(0, Date.now() - clientSentAt);
    const latency = this.getTransportLatency(transport);
    latency.socket.record(value);
    this.reportTransportMetric('socket_rtt_ms', value, transport);
    this.refreshStatus();
  },

  handleInputAck(payload = {}) {
    const inputId = typeof payload.inputId === 'string' ? payload.inputId : '';
    const pending = inputId ? this.pendingInputAcks.get(inputId) : null;
    const clientSentAt = pending?.clientSentAt;
    if (inputId) {
      this.pendingInputAcks.delete(inputId);
    }
    if (pending?.composerSubmission) {
      const sessionId = pending.sessionId;
      const preflightError = this.composerPreflightError;
      this.forgetPendingComposerSubmission(sessionId, { onlyIfInputId: inputId, dropPendingAck: false });
      if (preflightError?.sessionId === sessionId) {
        this.composerPreflightError = null;
        if (this.socketStatusKind === 'error' && this.socketStatusBaseText === preflightError.message) {
          this.setStatus('共享控制台已连接', 'connected');
        }
      }
      const shouldClearDraft = this.composerDrafts.get(sessionId) === pending.composerDraftSnapshot;
      if (shouldClearDraft) {
        this.composerDrafts.set(sessionId, '');
      }
      if (sessionId === this.state.activeSessionId()) {
        this.refreshComposer({ forceValueSync: shouldClearDraft });
      }
    }
    if (!Number.isFinite(clientSentAt)) {
      return;
    }
    const transport = payload.transport || this.getTransportName();
    const value = Math.max(0, Date.now() - clientSentAt);
    const latency = this.getTransportLatency(transport);
    latency.input.record(value);
    this.reportTransportMetric('input_ack_rtt_ms', value, transport);
    const serverReceivedAt = Number(payload.serverReceivedAt);
    const serverSentAt = Number(payload.serverSentAt);
    if (Number.isFinite(serverReceivedAt) && Number.isFinite(serverSentAt)) {
      latency.server.record(Math.max(0, serverSentAt - serverReceivedAt));
    }
    this.refreshStatus();
  },

  handleTerminalError(payload = {}) {
    const inputId = typeof payload.inputId === 'string' ? payload.inputId : '';
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
    const pending = inputId ? this.pendingInputAcks.get(inputId) : null;
    if (pending?.composerSubmission && pending.sessionId === sessionId) {
      this.forgetPendingComposerSubmission(sessionId, { onlyIfInputId: inputId });
      if (sessionId === this.state.activeSessionId()) {
        this.refreshComposer();
      }
    }
    this.setStatus(
      TERMINAL_ERROR_MESSAGES[payload.code] || payload.message || payload.code || 'Terminal error',
      payload.code === 'terminal_input_rate_limited' ? 'warning' : 'error',
    );
  },

  createSession() {
    if (!this.hasAdminToken()) {
      this.setStatus('需要 admin 授权', 'warning');
      return;
    }
    this.connectSocket();
    if (!this.socket?.connected) {
      this.setStatus('正在连接终端服务', 'warning');
      return;
    }
    if (Number(this.poolCapacity?.availableSessions) === 0 && Number(this.poolCapacity?.maxSessions) > 0) {
      this.setWarning(`Terminal 会话已达到上限 (${this.poolCapacity.maxSessions})`);
      return;
    }
    this.pendingCreateRequestId = this.makeCreateRequestId();
    this.socket.emit('terminal:create_session', {
      requestId: this.pendingCreateRequestId,
      cols: 120,
      rows: 32,
      title: `Shared shell ${this.state.sessionCount() + 1}`,
    });
  },

  releaseTerminalControlFocus() {
    const controls = [
      this.elements.newButton,
      this.elements.authButton,
      this.elements.terminalTab,
    ];
    controls.forEach((element) => {
      if (typeof element?.blur === 'function') {
        element.blur();
      }
    });
  },

  ensureSession(session, options = {}) {
    const lastActiveSessionId = localStorage.getItem(LAST_ACTIVE_SESSION_KEY);
    const normalized = this.state.upsertSession(session, {
      activate: options.activate || !this.state.activeSessionId() || session.sessionId === lastActiveSessionId,
    });
    if (!this.terms.has(normalized.sessionId)) {
      this.createTerm(normalized.sessionId);
    }
    return normalized;
  },

  applyPoolSnapshot(payload = {}) {
    const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
    const liveSessionIds = new Set(sessions.map((session) => session.sessionId).filter(Boolean));
    const previousIds = new Set(this.state.getSessions().map((session) => session.sessionId));
    this.state.replaceSessions(sessions);
    this.poolCapacity = payload.capacity || null;
    sessions.forEach((session) => {
      previousIds.delete(session.sessionId);
      this.ensureSession(session);
    });
    previousIds.forEach((sessionId) => this.destroyTerm(sessionId));
    this.attachedSessionIds.forEach((sessionId) => {
      if (!liveSessionIds.has(sessionId)) {
        this.attachedSessionIds.delete(sessionId);
      }
    });
    this.pendingAttachSessionIds.forEach((sessionId) => {
      if (!liveSessionIds.has(sessionId)) {
        this.pendingAttachSessionIds.delete(sessionId);
      }
    });
    const persistedLastActive = localStorage.getItem(LAST_ACTIVE_SESSION_KEY);
    const preferredSessionId = (persistedLastActive && liveSessionIds.has(persistedLastActive) ? persistedLastActive : null)
      || payload.defaultSessionId
      || this.state.activeSessionId();
    if (preferredSessionId) {
      this.state.setActive(preferredSessionId);
      this.persistActiveSessionId(preferredSessionId);
      this.requestAttachSession(preferredSessionId);
    } else {
      this.persistActiveSessionId('');
    }
    if (Number(this.poolCapacity?.availableSessions) === 0 && Number(this.poolCapacity?.maxSessions) > 0) {
      this.state.setWarning(`Terminal 会话已达到上限 (${this.poolCapacity.maxSessions})`);
    }
    this.render();
  },

  handleSessionCreated(session) {
    const lastActiveSessionId = localStorage.getItem(LAST_ACTIVE_SESSION_KEY);
    const createdByCurrentClient = this.didCurrentClientCreateSession(session);
    if (this.state.getSession(session.sessionId) && !createdByCurrentClient) {
      return;
    }
    const shouldActivate = createdByCurrentClient
      || session.sessionId === lastActiveSessionId;
    if (createdByCurrentClient) {
      this.pendingCreateRequestId = null;
      this.pendingAttachSessionIds.delete(session.sessionId);
      this.attachedSessionIds.add(session.sessionId);
    }
    this.ensureSession(session, { activate: shouldActivate });
    if (shouldActivate) {
      this.persistActiveSessionId(session.sessionId);
    }
    this.render();
    if (this.state.activeSessionId() === session.sessionId) {
      this.releaseTerminalControlFocus();
      this.fitActiveTerminal();
      this.scheduleFitActiveTerminal();
      this.focusActiveTerminal();
      this.scheduleFocusActiveTerminal();
    }
  },

  attachSessionState(session) {
    const shouldActivate = session.sessionId === localStorage.getItem(LAST_ACTIVE_SESSION_KEY);
    this.pendingAttachSessionIds.delete(session.sessionId);
    this.attachedSessionIds.add(session.sessionId);
    this.ensureSession(session, {
      activate: shouldActivate,
    });
    this.state.updateSession(session.sessionId, {
      status: session.status || 'attached',
      processStatus: normalizeProcessStatus(
        session.processStatus,
        this.state.getSession(session.sessionId)?.processStatus || 'running',
      ),
      observerCount: Number(session.observerCount ?? this.state.getSession(session.sessionId)?.observerCount ?? 0),
      activePresenterClientId: session.activePresenterClientId ?? this.state.getSession(session.sessionId)?.activePresenterClientId ?? null,
    });
    if (shouldActivate) {
      this.persistActiveSessionId(session.sessionId);
    }
    if (this.state.activeSessionId() === session.sessionId) {
      this.announceActivePresenter(session.sessionId);
    }
    this.render();
    this.releaseTerminalControlFocus();
    this.fitActiveTerminal();
    this.scheduleFitActiveTerminal();
    this.focusActiveTerminal();
    this.scheduleFocusActiveTerminal();
  },

  handleSessionClosed(session) {
    this.pendingCloseSessionIds.delete(session.sessionId);
    this.pendingAttachSessionIds.delete(session.sessionId);
    this.attachedSessionIds.delete(session.sessionId);
    if (!this.state.getSession(session.sessionId) && !this.terms.has(session.sessionId)) {
      return;
    }
    this.destroyTerm(session.sessionId);
    this.state.closeTab(session.sessionId);
    this.syncPersistedActiveSession();
    this.render();
  },

  requestAttachSession(sessionId) {
    if (!this.socket?.connected || !sessionId) return;
    if (this.attachedSessionIds.has(sessionId) || this.pendingAttachSessionIds.has(sessionId)) {
      return;
    }
    this.pendingAttachSessionIds.add(sessionId);
    this.socket.emit('terminal:attach_session', {
      sessionId,
      cols: 120,
      rows: 32,
    });
  },

  updatePresence(payload = {}) {
    if (!payload.sessionId) return;
    this.ensureSession({ sessionId: payload.sessionId });
    this.state.updateSession(payload.sessionId, {
      observerCount: Number(payload.observerCount ?? 0),
      activePresenterClientId: payload.activePresenterClientId ?? null,
    });
    this.render();
  },

  createTerm(sessionId) {
    const container = document.createElement('div');
    container.className = 'terminal-instance hidden';
    container.dataset.sessionId = sessionId;
    this.elements.workspace?.appendChild(container);

    if (typeof Terminal !== 'undefined') {
      const term = new Terminal({
        cursorBlink: true,
        fontFamily: 'JetBrains Mono, Menlo, monospace',
        fontSize: 13,
        theme: { background: '#050508', foreground: '#f1f5f9' },
      });
      let fitAddon = null;
      if (typeof FitAddon !== 'undefined' && FitAddon.FitAddon) {
        fitAddon = new FitAddon.FitAddon();
        term.loadAddon(fitAddon);
      }
      term.open(container);
      this.getEchoController(sessionId);
      term.onData((data) => {
        this.emitTerminalInput(sessionId, data, { optimisticEcho: true });
      });
      term.onResize((size) => {
        if (
          this.socket?.connected
          && this.state.getSession(sessionId)?.processStatus === 'running'
        ) {
          this.socket.emit('terminal:resize', {
            sessionId,
            cols: size.cols,
            rows: size.rows,
          });
        }
      });
      this.terms.set(sessionId, term);
      if (fitAddon) this.fitAddons.set(sessionId, fitAddon);
    } else {
      const pre = document.createElement('pre');
      pre.className = 'terminal-fallback-output';
      container.appendChild(pre);
      this.terms.set(sessionId, {
        write(data) {
          pre.textContent += data;
          pre.scrollTop = pre.scrollHeight;
        },
        reset() {
          pre.textContent = '';
          pre.scrollTop = 0;
        },
        dispose() {
          container.remove();
        },
      });
    }
  },

  destroyTerm(sessionId) {
    const term = this.terms.get(sessionId);
    if (term?.dispose) term.dispose();
    this.terms.delete(sessionId);
    this.fitAddons.delete(sessionId);
    this.forgetPendingComposerSubmission(sessionId);
    this.echoControllersBySession.get(sessionId)?.reset('destroy');
    this.echoControllersBySession.delete(sessionId);
    this.alternateScreenSessionIds.delete(sessionId);
    this.bracketedPasteSessionIds.delete(sessionId);
    this.terminalModeTailsBySession.delete(sessionId);
    this.composerDrafts.delete(sessionId);
    if (this.composerPreflightError?.sessionId === sessionId) {
      this.composerPreflightError = null;
    }
    const node = this.elements.workspace?.querySelector(`[data-session-id="${sessionId}"]`);
    node?.remove();
    this.refreshComposer();
  },

  writeOutput(sessionId, data) {
    const term = this.terms.get(sessionId);
    const text = String(data || '');
    const wasBracketedPasteEnabled = this.bracketedPasteSessionIds.has(sessionId);
    this.trackTerminalModes(sessionId, text);
    const isBracketedPasteEnabled = this.bracketedPasteSessionIds.has(sessionId);
    if (sessionId === this.state.activeSessionId() && wasBracketedPasteEnabled !== isBracketedPasteEnabled) {
      this.refreshComposer();
    }
    this.trackAlternateScreen(sessionId, text);
    const normalized = this.consumeOptimisticLocalEcho(sessionId, text);
    if (term?.write && normalized) {
      term.write(normalized);
    }
  },

  writeReplay(sessionId, replay = []) {
    const hadExistingTerm = this.terms.has(sessionId);
    this.ensureSession({ sessionId }, {
      activate: sessionId === localStorage.getItem(LAST_ACTIVE_SESSION_KEY),
    });
    this.getEchoController(sessionId).reset('replay');
    if (hadExistingTerm) {
      this.resetRenderedTerm(sessionId);
    }
    replay.forEach((entry) => this.writeOutput(sessionId, entry?.data));
    this.state.updateStatus(sessionId, 'attached');
    this.render();
  },

  closeSession(sessionId) {
    if (!this.socket?.connected) {
      this.setStatus('终端连接不可用，请稍后重试', 'warning');
      return;
    }
    if (!sessionId || this.pendingCloseSessionIds.has(sessionId)) return;
    this.pendingCloseSessionIds.add(sessionId);
    this.socket.emit('terminal:close_session', { sessionId, reason: 'user-close' });
    this.render();
  },

  activateSession(sessionId, options = {}) {
    this.state.setActive(sessionId);
    const activeSessionId = this.state.activeSessionId();
    this.persistActiveSessionId(activeSessionId || '');
    if (activeSessionId) {
      this.requestAttachSession(activeSessionId);
    }
    if (options.announce !== false) {
      this.announceActivePresenter(activeSessionId);
    }
    this.render();
    this.fitActiveTerminal();
    this.scheduleFitActiveTerminal();
    this.refreshComposer();
  },

  announceActivePresenter(sessionId) {
    if (this.socket?.connected && sessionId) {
      this.socket.emit('terminal:set_active_presenter', { sessionId });
    }
  },

  persistActiveSessionId(sessionId) {
    if (!sessionId) {
      localStorage.removeItem(LAST_ACTIVE_SESSION_KEY);
      return;
    }
    localStorage.setItem(LAST_ACTIVE_SESSION_KEY, sessionId);
  },

  getEchoController(sessionId) {
    if (!this.echoControllersBySession.has(sessionId)) {
      this.echoControllersBySession.set(sessionId, TerminalEchoController.create());
    }
    return this.echoControllersBySession.get(sessionId);
  },

  resetEchoControllers(reason) {
    this.echoControllersBySession.forEach((controller) => controller.reset(reason));
  },

  applyOptimisticLocalEcho(sessionId, data) {
    const term = this.terms.get(sessionId);
    const result = this.getEchoController(sessionId).onInput(data);
    if (!term?.write || !result.localEcho) {
      return false;
    }
    term.write(result.localEcho);
    return true;
  },

  consumeOptimisticLocalEcho(sessionId, data) {
    return this.getEchoController(sessionId).onRemoteOutput(data);
  },

  isComposerSubmissionPending(sessionId = this.state.activeSessionId()) {
    return Boolean(sessionId && this.pendingComposerInputIdsBySession.get(sessionId));
  },

  forgetPendingComposerSubmission(sessionId, options = {}) {
    if (!sessionId) {
      return;
    }
    const currentInputId = this.pendingComposerInputIdsBySession.get(sessionId);
    if (!currentInputId) {
      return;
    }
    if (options.onlyIfInputId && currentInputId !== options.onlyIfInputId) {
      return;
    }
    this.pendingComposerInputIdsBySession.delete(sessionId);
    if (options.dropPendingAck !== false) {
      this.pendingInputAcks.delete(currentInputId);
    }
  },

  trackAlternateScreen(sessionId, data) {
    const text = String(data || '');
    if (/\u001b\[\?(?:1049|1047|47)h/.test(text)) {
      this.alternateScreenSessionIds.add(sessionId);
      this.getEchoController(sessionId).setAlternateScreen(true);
    }
    if (/\u001b\[\?(?:1049|1047|47)l/.test(text)) {
      this.alternateScreenSessionIds.delete(sessionId);
      this.getEchoController(sessionId).setAlternateScreen(false);
    }
  },

  trackTerminalModes(sessionId, data) {
    const text = String(data || '');
    const previousTail = this.terminalModeTailsBySession.get(sessionId) || '';
    const combined = `${previousTail}${text}`;
    const modePattern = /\u001b\[\?([0-9;]+)([hl])/g;
    let match = modePattern.exec(combined);
    while (match) {
      const privateModes = String(match[1] || '').split(';');
      if (privateModes.includes('2004')) {
        if (match[2] === 'h') {
          this.bracketedPasteSessionIds.add(sessionId);
        } else {
          this.bracketedPasteSessionIds.delete(sessionId);
        }
      }
      match = modePattern.exec(combined);
    }
    let unfinishedSequence = '';
    const lastEscapeIndex = combined.lastIndexOf('\u001b');
    if (lastEscapeIndex !== -1) {
      const candidate = combined.slice(lastEscapeIndex);
      const isShortEnough = candidate.length <= TERMINAL_MODE_SEQUENCE_MAX_LENGTH;
      const isBarePrefix = candidate === '\u001b' || candidate === '\u001b[' || candidate === '\u001b[?';
      const isParameterPrefix = candidate.startsWith('\u001b[?') && /^[\u001b\[\?0-9;]+$/.test(candidate);
      if (isShortEnough && (isBarePrefix || isParameterPrefix)) {
        unfinishedSequence = candidate;
      }
    }
    this.terminalModeTailsBySession.set(sessionId, unfinishedSequence);
  },

  isComposerReady() {
    const activeSessionId = this.state.activeSessionId();
    return Boolean(
      this.socket?.connected
      && activeSessionId
      && this.attachedSessionIds.has(activeSessionId)
    );
  },

  refreshComposer(options = {}) {
    const composer = this.elements?.composer;
    const submit = this.elements?.composerSubmit;
    const hint = this.elements?.composerHint;
    if (!composer || !submit || !hint) {
      return;
    }
    const activeSessionId = this.state.activeSessionId() || null;
    const nextValue = activeSessionId ? this.composerDrafts.get(activeSessionId) : '';
    const composerFocused = document.activeElement === composer;
    const sameSession = this.renderedComposerSessionId === activeSessionId;
    if ((options.forceValueSync || !composerFocused || !sameSession) && composer.value !== nextValue) {
      composer.value = nextValue;
    }
    this.renderedComposerSessionId = activeSessionId;
    const enabled = this.isComposerReady();
    const pendingComposerSubmission = this.isComposerSubmissionPending(activeSessionId);
    composer.disabled = !enabled;
    submit.disabled = !enabled || pendingComposerSubmission;
    const bracketedPasteEnabled = Boolean(activeSessionId && this.bracketedPasteSessionIds.has(activeSessionId));
    hint.textContent = enabled && !bracketedPasteEnabled
      ? TERMINAL_COMPOSER_RAW_HINT
      : TERMINAL_COMPOSER_DEFAULT_HINT;
  },

  handleComposerInput() {
    const composer = this.elements?.composer;
    const activeSessionId = this.state.activeSessionId();
    if (!composer || !activeSessionId) {
      return;
    }
    const terminalComposer = getTerminalComposerApi();
    const normalized = terminalComposer?.normalizeTerminalComposerText
      ? terminalComposer.normalizeTerminalComposerText(composer.value)
      : String(composer.value || '');
    if (normalized !== composer.value) {
      composer.value = normalized;
    }
    this.composerDrafts.set(activeSessionId, normalized);
  },

  handleComposerKeydown(event) {
    const terminalComposer = getTerminalComposerApi();
    const shouldSubmit = terminalComposer?.shouldSubmitTerminalComposerKey
      ? terminalComposer.shouldSubmitTerminalComposerKey(event)
      : false;
    if (!shouldSubmit) {
      return;
    }
    event.preventDefault();
    this.submitComposer();
  },

  submitComposer() {
    if (!this.isComposerReady()) {
      return false;
    }
    const terminalComposer = getTerminalComposerApi();
    const activeSessionId = this.state.activeSessionId();
    const composer = this.elements?.composer;
    if (!terminalComposer || !activeSessionId || !composer || this.isComposerSubmissionPending(activeSessionId)) {
      return false;
    }
    const draft = terminalComposer.normalizeTerminalComposerText(composer.value);
    const payload = terminalComposer.serializeTerminalComposerInput(draft, {
      bracketedPasteEnabled: this.bracketedPasteSessionIds.has(activeSessionId),
    });
    this.composerDrafts.set(activeSessionId, draft);
    if (terminalComposer.getTerminalComposerUtf8ByteLength(payload) > TERMINAL_INPUT_MAX_BYTES) {
      this.composerPreflightError = {
        sessionId: activeSessionId,
        message: TERMINAL_COMPOSER_INPUT_LIMIT_ERROR,
      };
      this.setStatus(TERMINAL_COMPOSER_INPUT_LIMIT_ERROR, 'error');
      this.refreshComposer();
      return false;
    }
    const emitted = this.emitTerminalInput(activeSessionId, payload, {
      optimisticEcho: false,
      pendingAckMeta: {
        composerSubmission: true,
        composerDraftSnapshot: draft,
      },
    });
    if (!emitted) {
      return false;
    }
    this.pendingComposerInputIdsBySession.set(activeSessionId, emitted.inputId);
    this.refreshComposer();
    return true;
  },

  getDiagnosticState() {
    const activeSessionId = this.state.activeSessionId();
    return {
      socketState: this.socketState,
      transport: this.getTransportName(),
      socketRtt: this.terminalSocketLatency.snapshot(),
      inputAck: this.terminalInputAckLatency.snapshot(),
      serverProcess: this.terminalServerProcessLatency.snapshot(),
      activeSessionId,
      echoConfident: Boolean(activeSessionId && this.echoControllersBySession.get(activeSessionId)?.snapshot().confident),
      echoAwaitingProbe: Boolean(activeSessionId && this.echoControllersBySession.get(activeSessionId)?.snapshot().awaitingProbe),
      pendingLocalEchoBytes: Array.from(this.echoControllersBySession.values()).reduce(
        (sum, controller) => sum + Number(controller.snapshot().pendingEchoBytes || 0),
        0,
      ),
      alternateScreenActive: Boolean(activeSessionId && this.alternateScreenSessionIds.has(activeSessionId)),
    };
  },

  destroySocket() {
    if (this.socket?.disconnect) {
      this.socket.disconnect();
    }
    this.socket = null;
    this.socketState = 'idle';
    this.socketAuthToken = null;
    this.transportName = 'unknown';
    this.stopLatencyProbeLoop();
    this.pendingInputAcks.clear();
    this.pendingComposerInputIdsBySession.clear();
    this.composerPreflightError = null;
    this.pendingCreateRequestId = null;
    this.resetEchoControllers('destroy-socket');
    this.refreshComposer();
  },

  syncPersistedActiveSession() {
    this.persistActiveSessionId(this.state.activeSessionId() || '');
  },

  didCurrentClientCreateSession(session = {}) {
    return Boolean(
      typeof session.requestId === 'string'
      && this.pendingCreateRequestId
      && session.requestId === this.pendingCreateRequestId
    );
  },

  resetRenderedTerm(sessionId) {
    const term = this.terms.get(sessionId);
    if (!term) return;
    if (typeof term.reset === 'function') {
      term.reset();
      return;
    }
    if (typeof term.clear === 'function') {
      term.clear();
    }
  },

  fitActiveTerminal() {
    const active = this.state.activeSessionId();
    const addon = active ? this.fitAddons.get(active) : null;
    if (addon?.fit) {
      try {
        addon.fit();
        return true;
      } catch (err) {
        console.warn('[Terminal] fit failed:', err);
      }
    }
    return false;
  },

  scheduleFitActiveTerminal(delay = 50, remainingAttempts = 6) {
    if (this.fitTimer) {
      clearTimeout(this.fitTimer);
    }
    this.fitTimer = setTimeout(() => {
      this.fitTimer = null;
      const fitted = this.fitActiveTerminal();
      if (fitted && remainingAttempts > 1 && this.isVisible) {
        this.scheduleFitActiveTerminal(80, remainingAttempts - 1);
      }
    }, delay);
  },

  focusActiveTerminal() {
    const active = this.state.activeSessionId();
    if (!active) return false;
    if (this.state.getSession(active)?.processStatus !== 'running') return false;
    const node = this.elements.workspace?.querySelector(`[data-session-id="${active}"]`);
    const isFocusedWithinNode = () => {
      const activeElement = document.activeElement;
      return Boolean(activeElement && node?.contains?.(activeElement));
    };
    const helper = node?.querySelector?.('.xterm-helper-textarea');
    if (helper?.focus) {
      try {
        helper.focus();
        if (isFocusedWithinNode()) {
          return true;
        }
      } catch (err) {
        console.warn('[Terminal] helper focus failed:', err);
      }
    }
    const term = this.terms.get(active);
    if (term?.focus) {
      try {
        term.focus();
        if (isFocusedWithinNode()) {
          return true;
        }
      } catch (err) {
        console.warn('[Terminal] focus failed:', err);
      }
    }
    return isFocusedWithinNode();
  },

  scheduleFocusActiveTerminal(delay = 50, remainingAttempts = 6) {
    if (this.focusTimer) {
      clearTimeout(this.focusTimer);
    }
    this.focusTimer = setTimeout(() => {
      this.focusTimer = null;
      this.releaseTerminalControlFocus();
      const focused = this.focusActiveTerminal();
      if (!focused && remainingAttempts > 1 && this.isVisible) {
        this.scheduleFocusActiveTerminal(80, remainingAttempts - 1);
      }
    }, delay);
  },

  render() {
    const authorized = this.hasAdminToken();
    const connected = Boolean(this.socket?.connected);
    this.elements.authForm?.classList.toggle('hidden', authorized);
    this.elements.newButton?.classList.toggle('hidden', !authorized);
    if (this.elements.newButton) {
      const atCapacity = Number(this.poolCapacity?.availableSessions) === 0
        && Number(this.poolCapacity?.maxSessions) > 0;
      this.elements.newButton.disabled = !authorized || !connected || atCapacity;
    }

    if (!authorized && !this.socketStatusBaseText) {
      this.setStatus('需要 admin 二次授权', 'warning');
    }

    const sessions = this.state.getSessions();
    const activeId = this.state.activeSessionId();
    if (this.elements.sessionTabs) {
      this.elements.sessionTabs.innerHTML = '';
      sessions.forEach((session) => {
        const button = document.createElement('button');
        button.className = 'terminal-session-tab';
        button.classList.toggle('active', session.sessionId === activeId);
        const observerLabel = session.observerCount > 0 ? ` · ${session.observerCount}人` : '';
        const processLabel = processStatusLabel(session.processStatus);
        button.textContent = `${session.title || session.sessionId}${observerLabel}${processLabel ? ` · ${processLabel}` : ''}`;
        button.addEventListener('click', () => this.activateSession(session.sessionId));

        const close = document.createElement('span');
        close.className = 'terminal-session-close';
        close.textContent = '×';
        close.addEventListener('click', (event) => {
          event.stopPropagation();
          this.closeSession(session.sessionId);
        });
        button.appendChild(close);
        this.elements.sessionTabs.appendChild(button);
      });
    }

    this.elements.workspace?.querySelectorAll('.terminal-instance').forEach((node) => {
      node.classList.toggle('hidden', node.dataset.sessionId !== activeId);
      const session = this.state.getSession(node.dataset.sessionId);
      const writable = session?.processStatus === 'running';
      const helper = node.querySelector?.('.xterm-helper-textarea');
      if (helper) helper.disabled = !writable;
      const term = this.terms.get(node.dataset.sessionId);
      if (term?.options) term.options.disableStdin = !writable;
    });

    this.setWarning(this.state.getWarning());
    this.refreshComposer();
  },
};

document.addEventListener('DOMContentLoaded', () => {
  TerminalPanel.init();
});
