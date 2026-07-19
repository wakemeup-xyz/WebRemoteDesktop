const TERMINAL_ADMIN_TOKEN_KEY = 'wrd_terminal_admin_token';
const LAST_ACTIVE_SESSION_KEY = 'wrd_terminal_last_active_session_id';
const PROCESS_STATUSES = new Set(['starting', 'running', 'exited', 'failed', 'closed']);
const TERMINAL_ERROR_MESSAGES = Object.freeze({
  pty_starting: '终端正在启动',
  pty_exited: '终端进程已退出',
  pty_spawn_failed: '终端启动失败',
  pty_startup_timeout: '终端启动超时',
});

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
  focusTimer: null,
  fitTimer: null,
  softWarnSessionCount: 4,
  isVisible: false,
  pendingCreateClientId: null,
  socketAuthToken: null,
  socketState: 'idle',
  socketStatusBaseText: '',
  socketStatusKind: '',
  transportName: 'unknown',
  terminalSocketLatency: createLatencySeries(),
  terminalInputAckLatency: createLatencySeries(),
  terminalServerProcessLatency: createLatencySeries(),
  latencyProbeTimer: null,
  pendingLatencyProbes: new Map(),
  pendingInputAcks: new Map(),
  echoControllersBySession: new Map(),
  alternateScreenSessionIds: new Set(),
  poolCapacity: null,

  init() {
    this.cacheElements();
    if (!this.elements.root) return;
    this.bindEvents();
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
    window.addEventListener('resize', () => {
      this.fitActiveTerminal();
      this.scheduleFitActiveTerminal();
    });
  },

  showDesktop() {
    this.isVisible = false;
    document.body.classList.remove('terminal-active');
    this.elements.desktopPanel?.classList.remove('hidden');
    this.elements.terminalPanel?.classList.add('hidden');
    this.elements.desktopTab?.classList.add('active');
    this.elements.terminalTab?.classList.remove('active');
  },

  showTerminal() {
    this.isVisible = true;
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
      this.connectSocket();
      this.render();
    } catch (err) {
      this.setStatus(`授权失败：${err.message}`, 'error');
    }
  },

  connectSocket() {
    const token = this.getAdminToken();
    if (!token || typeof io === 'undefined') return;
    const canReuseSocket = this.socket
      && this.socket.connected
      && this.socketAuthToken === token
      && this.socketState !== 'error';
    if (canReuseSocket) return;
    this.destroySocket();

    this.socket = io(`${RuntimeConfig.getSocketBase()}/terminal`, {
      auth: {
        token,
        clientId: this.getBrowserSessionId(),
      },
      transports: ['websocket', 'polling'],
      rememberUpgrade: true,
    });
    this.socketAuthToken = token;
    this.socketState = 'connecting';

    this.socket.on('connect', () => {
      this.resetEchoControllers('reconnect');
      this.socketState = 'connected';
      this.transportName = this.socket.io?.engine?.transport?.name || 'websocket';
      this.attachedSessionIds.clear();
      this.pendingAttachSessionIds.clear();
      this.setStatus('共享控制台已连接', 'connected');
      this.startLatencyProbeLoop();
      if (typeof this.socket.io?.engine?.on === 'function') {
        this.socket.io.engine.on('upgrade', (transport) => {
          this.transportName = String(transport?.name || this.transportName || 'unknown');
          this.refreshStatus();
        });
      }
      this.reattachSessions();
      this.socket.emit('terminal:list', {});
      this.render();
    });
    this.socket.on('disconnect', () => {
      this.resetEchoControllers('disconnect');
      this.socketState = 'disconnected';
      this.stopLatencyProbeLoop();
      this.pendingInputAcks.clear();
      this.attachedSessionIds.clear();
      this.pendingAttachSessionIds.clear();
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
    });
    const applyPoolSnapshot = (payload) => this.applyPoolSnapshot(payload);
    const handleSessionCreated = (session) => this.handleSessionCreated(session);
    const handleSessionAttached = (session) => this.attachSessionState(session);
    const handleSessionClosed = (session) => this.handleSessionClosed(session);

    this.socket.on('terminal:pool_snapshot', applyPoolSnapshot);
    this.socket.on('terminal:snapshot', applyPoolSnapshot);
    this.socket.on('terminal:session_created', handleSessionCreated);
    this.socket.on('terminal:created', handleSessionCreated);
    this.socket.on('terminal:session_attached', handleSessionAttached);
    this.socket.on('terminal:attached', handleSessionAttached);
    this.socket.on('terminal:output', (payload) => {
      const session = this.state.getSession(payload.sessionId);
      if (session?.processStatus === 'starting') {
        this.state.updateSession(payload.sessionId, { processStatus: 'running' });
        this.render();
      }
      this.writeOutput(payload.sessionId, payload.data);
    });
    this.socket.on('terminal:input_ack', (payload) => {
      this.handleInputAck(payload);
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
      this.setWarning(payload.message || '终端会话较多，可能影响性能');
    });
    this.socket.on('terminal:error', (payload) => {
      if (payload.sessionId && ['pty_spawn_failed', 'pty_startup_timeout'].includes(payload.code)) {
        this.state.updateSession(payload.sessionId, { processStatus: 'failed' });
        this.render();
      }
      this.setStatus(
        TERMINAL_ERROR_MESSAGES[payload.code] || payload.message || payload.code || 'Terminal error',
        'error',
      );
    });
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

  getTransportName() {
    return String(this.transportName || this.socket?.io?.engine?.transport?.name || 'unknown');
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
    this.transportName = String(payload.transport || this.getTransportName());
    this.terminalSocketLatency.record(Date.now() - clientSentAt);
    this.refreshStatus();
  },

  handleInputAck(payload = {}) {
    const inputId = typeof payload.inputId === 'string' ? payload.inputId : '';
    const pending = inputId ? this.pendingInputAcks.get(inputId) : null;
    const clientSentAt = pending?.clientSentAt;
    if (inputId) {
      this.pendingInputAcks.delete(inputId);
    }
    if (!Number.isFinite(clientSentAt)) {
      return;
    }
    this.transportName = String(payload.transport || this.getTransportName());
    this.terminalInputAckLatency.record(Math.max(0, Date.now() - clientSentAt));
    const serverReceivedAt = Number(payload.serverReceivedAt);
    const serverSentAt = Number(payload.serverSentAt);
    if (Number.isFinite(serverReceivedAt) && Number.isFinite(serverSentAt)) {
      this.terminalServerProcessLatency.record(Math.max(0, serverSentAt - serverReceivedAt));
    }
    this.refreshStatus();
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
    this.pendingCreateClientId = this.getBrowserSessionId();
    this.socket.emit('terminal:create_session', {
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

  reattachSessions() {
    if (!this.socket?.connected) return;
    const lastActive = localStorage.getItem(LAST_ACTIVE_SESSION_KEY);
    if (lastActive && this.state.getSession(lastActive)) {
      this.requestAttachSession(lastActive);
      return;
    }
    this.state.getSessions().forEach((session) => {
      this.requestAttachSession(session.sessionId);
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
    const shouldActivate = createdByCurrentClient
      || (!this.state.activeSessionId() && !this.pendingCreateClientId)
      || session.sessionId === lastActiveSessionId;
    if (createdByCurrentClient) {
      this.pendingCreateClientId = null;
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
    const shouldActivate = session.sessionId === localStorage.getItem(LAST_ACTIVE_SESSION_KEY)
      || Boolean(this.pendingCreateClientId);
    this.pendingAttachSessionIds.delete(session.sessionId);
    this.attachedSessionIds.add(session.sessionId);
    this.ensureSession(session, {
      activate: shouldActivate,
    });
    if (this.pendingCreateClientId) {
      this.pendingCreateClientId = null;
    }
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
    this.pendingAttachSessionIds.delete(session.sessionId);
    this.attachedSessionIds.delete(session.sessionId);
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
        if (
          this.socket?.connected
          && this.state.getSession(sessionId)?.processStatus === 'running'
        ) {
          const inputId = this.makeInputId(sessionId);
          const clientSentAt = Date.now();
          this.pendingInputAcks.set(inputId, {
            sessionId,
            clientSentAt,
          });
          this.applyOptimisticLocalEcho(sessionId, data);
          this.socket.emit('terminal:input', {
            sessionId,
            data,
            inputId,
            clientSentAt,
          });
        }
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
    this.echoControllersBySession.get(sessionId)?.reset('destroy');
    this.echoControllersBySession.delete(sessionId);
    this.alternateScreenSessionIds.delete(sessionId);
    const node = this.elements.workspace?.querySelector(`[data-session-id="${sessionId}"]`);
    node?.remove();
  },

  writeOutput(sessionId, data) {
    const term = this.terms.get(sessionId);
    this.trackAlternateScreen(sessionId, String(data || ''));
    const normalized = this.consumeOptimisticLocalEcho(sessionId, String(data || ''));
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
    if (this.socket?.connected) {
      this.socket.emit('terminal:close_session', { sessionId, reason: 'user-close' });
    }
    this.destroyTerm(sessionId);
    this.state.closeTab(sessionId);
    this.syncPersistedActiveSession();
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
    this.resetEchoControllers('destroy-socket');
  },

  syncPersistedActiveSession() {
    this.persistActiveSessionId(this.state.activeSessionId() || '');
  },

  didCurrentClientCreateSession(session = {}) {
    return Boolean(
      session.creatorClientId
      && this.pendingCreateClientId
      && session.creatorClientId === this.pendingCreateClientId
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
  },
};

document.addEventListener('DOMContentLoaded', () => {
  TerminalPanel.init();
});
