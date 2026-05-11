// Diagnostic log collector: intercepts console output and allows sending to server
const Diagnostic = {
  logs: [],
  maxLogs: 500,
  socket: null,

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

    if (!diagBtn) return;

    diagBtn.addEventListener('click', () => {
      area.value = this.logs.join('\n');
      area.scrollTop = area.scrollHeight;
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

  sendLogs() {
    const payload = {
      type: 'diagnostic',
      timestamp: Date.now(),
      userAgent: navigator.userAgent,
      screen: `${window.screen.width}x${window.screen.height}`,
      logs: this.logs.slice(-300) // send last 300 lines
    };

    // Use WebRTC socket if available, otherwise try to emit directly
    if (typeof WebRTC !== 'undefined' && WebRTC.socket && WebRTC.socket.connected) {
      WebRTC.socket.emit('diagnostic', payload);
      console.log('[Diagnostic] Logs sent via WebRTC socket');
      alert('日志已发送到服务端，请等待分析');
    } else if (typeof io !== 'undefined') {
      // Fallback: create a temporary socket connection just to send logs
      const tempSocket = io(window.location.origin, {
        auth: { token: localStorage.getItem('wrd_token'), role: 'viewer' }
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
  }
};

Diagnostic.init();
