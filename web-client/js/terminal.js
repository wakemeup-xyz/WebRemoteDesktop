const TERMINAL_ADMIN_TOKEN_KEY = 'wrd_terminal_admin_token';

function createTerminalState(options = {}) {
  const softWarnCount = Number(options.softWarnCount || 4);
  const sessions = new Map();
  let activeSessionId = null;
  let warning = '';

  function openTab(session) {
    const normalized = {
      sessionId: session.sessionId,
      title: session.title || `Terminal ${sessions.size + 1}`,
      status: session.status || 'running',
      warning: session.warning || '',
    };
    sessions.set(normalized.sessionId, normalized);
    activeSessionId = normalized.sessionId;
    if (sessions.size > softWarnCount) {
      warning = '终端会话较多，可能影响性能';
    }
    return normalized;
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

  function updateStatus(sessionId, status) {
    const session = sessions.get(sessionId);
    if (session) {
      session.status = status;
    }
  }

  function setWarning(message) {
    warning = String(message || '');
  }

  return {
    openTab,
    closeTab,
    setActive,
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
        return state.openTab(session);
      },
      setActive(sessionId) {
        state.setActive(sessionId);
      },
      attachSession(sessionId) {
        state.setActive(sessionId);
        state.updateStatus(sessionId, 'attached');
      },
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
  softWarnSessionCount: 4,
  isVisible: false,

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
    window.addEventListener('resize', () => this.fitActiveTerminal());
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
  },

  hasAdminToken() {
    return Boolean(sessionStorage.getItem(TERMINAL_ADMIN_TOKEN_KEY));
  },

  getAdminToken() {
    return sessionStorage.getItem(TERMINAL_ADMIN_TOKEN_KEY);
  },

  setStatus(text, kind = '') {
    if (!this.elements.status) return;
    this.elements.status.textContent = text;
    this.elements.status.dataset.state = kind;
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
      this.setStatus('已授权', 'connected');
      this.connectSocket();
      this.render();
    } catch (err) {
      this.setStatus(`授权失败：${err.message}`, 'error');
    }
  },

  connectSocket() {
    if (this.socket?.connected) return;
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }

    const token = this.getAdminToken();
    if (!token || typeof io === 'undefined') return;

    this.socket = io(`${RuntimeConfig.getSocketBase()}/terminal`, {
      auth: {
        token,
        clientId: this.getBrowserSessionId(),
      },
      transports: ['websocket', 'polling'],
    });

    this.socket.on('connect', () => {
      this.setStatus('已连接', 'connected');
      this.reattachSessions();
      this.socket.emit('terminal:list', {});
    });
    this.socket.on('disconnect', () => {
      this.setStatus('断线重连中', 'warning');
      this.state.getSessions().forEach((session) => this.state.updateStatus(session.sessionId, 'detached'));
      this.render();
    });
    this.socket.on('connect_error', (err) => {
      this.setStatus(`连接失败：${err.message}`, 'error');
    });
    this.socket.on('terminal:snapshot', (payload) => {
      (payload.sessions || []).forEach((session) => this.ensureSession(session));
      this.render();
    });
    this.socket.on('terminal:created', (session) => {
      this.ensureSession(session);
      this.render();
      this.fitActiveTerminal();
    });
    this.socket.on('terminal:attached', (session) => {
      this.ensureSession(session);
      this.state.updateStatus(session.sessionId, 'attached');
      this.render();
      this.fitActiveTerminal();
    });
    this.socket.on('terminal:output', (payload) => {
      this.writeOutput(payload.sessionId, payload.data);
    });
    this.socket.on('terminal:exit', (payload) => {
      this.state.updateStatus(payload.sessionId, 'exited');
      this.writeOutput(payload.sessionId, `\r\n[process exited: ${payload.exitCode ?? ''} ${payload.signal || ''}]\r\n`);
      this.render();
    });
    this.socket.on('terminal:closed', (session) => {
      this.destroyTerm(session.sessionId);
      this.state.closeTab(session.sessionId);
      this.render();
    });
    this.socket.on('terminal:warning', (payload) => {
      this.setWarning(payload.message || '终端会话较多，可能影响性能');
    });
    this.socket.on('terminal:error', (payload) => {
      this.setStatus(payload.message || payload.code || 'Terminal error', 'error');
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
    this.socket.emit('terminal:create', {
      cols: 120,
      rows: 32,
      title: `Terminal ${this.state.sessionCount() + 1}`,
    });
  },

  reattachSessions() {
    if (!this.socket?.connected) return;
    this.state.getSessions().forEach((session) => {
      this.socket.emit('terminal:attach', {
        sessionId: session.sessionId,
        cols: 120,
        rows: 32,
      });
    });
  },

  ensureSession(session) {
    const normalized = this.state.openTab(session);
    if (!this.terms.has(normalized.sessionId)) {
      this.createTerm(normalized.sessionId);
    }
    return normalized;
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
      term.onData((data) => {
        if (this.socket?.connected) {
          this.socket.emit('terminal:input', { sessionId, data });
        }
      });
      term.onResize((size) => {
        if (this.socket?.connected) {
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
    const node = this.elements.workspace?.querySelector(`[data-session-id="${sessionId}"]`);
    node?.remove();
  },

  writeOutput(sessionId, data) {
    const term = this.terms.get(sessionId);
    if (term?.write) {
      term.write(String(data || ''));
    }
  },

  closeSession(sessionId) {
    if (this.socket?.connected) {
      this.socket.emit('terminal:close', { sessionId, reason: 'user-close' });
    }
    this.destroyTerm(sessionId);
    this.state.closeTab(sessionId);
    this.render();
  },

  activateSession(sessionId) {
    this.state.setActive(sessionId);
    this.render();
    this.fitActiveTerminal();
  },

  fitActiveTerminal() {
    const active = this.state.activeSessionId();
    const addon = active ? this.fitAddons.get(active) : null;
    if (addon?.fit) {
      try {
        addon.fit();
      } catch (err) {
        console.warn('[Terminal] fit failed:', err);
      }
    }
  },

  render() {
    const authorized = this.hasAdminToken();
    this.elements.authForm?.classList.toggle('hidden', authorized);
    this.elements.newButton?.classList.toggle('hidden', !authorized);

    if (!authorized) {
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
        button.textContent = session.title || session.sessionId;
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
    });

    this.setWarning(this.state.getWarning());
  },
};

document.addEventListener('DOMContentLoaded', () => {
  TerminalPanel.init();
});
