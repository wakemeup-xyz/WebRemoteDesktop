const Input = {
  socket: null,
  videoElement: null,
  isActive: false,
  _listenersBound: false,
  _pressedKeys: new Map(),
  _pendingMouseMove: null,
  _mouseMoveScheduled: false,
  _keyReleaseTimer: null,
  _keyStaleMs: 3000,
  keyboardMode: null,

  init() {
    this.videoElement = document.getElementById('remoteVideo');
    if (!this.videoElement) {
      console.error('Input: remoteVideo element not found');
      return;
    }

    // 使用 WebRTC 的 socket 实例（共享连接）
    if (typeof WebRTC !== 'undefined' && WebRTC.socket) {
      this.socket = WebRTC.socket;
      console.log('Input: Using shared WebRTC socket, connected=', this.socket.connected);
    } else {
      console.error('Input: WebRTC socket not available');
      this.updateKeyDisplayRaw('未连接');
      return;
    }

    // 防止重复绑定事件监听器
    if (!this._listenersBound) {
      this.setupEventListeners();
      this.setupActionButtons();
      this.setupKeyboardMode();
      this._listenersBound = true;
    }

    // 如果视频已经在播放，立即激活输入（playing 事件可能已错过）
    if (this.videoElement.readyState >= 3 && !this.videoElement.paused) {
      console.log('Input: Video already playing, activating immediately');
      this.isActive = true;
      this.videoElement.focus();
    }

    console.log('Input initialized, isActive=', this.isActive);
    this.updateKeyDisplayRaw('就绪');
  },

  setupEventListeners() {
    const video = this.videoElement;

    // 使 video 元素可接收焦点
    video.setAttribute('tabindex', '0');
    video.style.outline = 'none';

    // 鼠标事件绑定到 video 和 relayImage（tunnel 模式用 <img> 展示画面）
    this.bindMouseEvents(video);
    const relayImage = document.getElementById('relayImage');
    if (relayImage) {
      relayImage.setAttribute('tabindex', '0');
      relayImage.style.outline = 'none';
      this.bindMouseEvents(relayImage);
    }

    // 键盘事件绑定到 document
    document.addEventListener('keydown', (e) => {
      if (this.shouldIgnoreKeyboardEvent(e)) return;

      const normalized = this.normalizeKeyboardEvent(e);
      const status = !this.isActive ? '未激活' : (!this.socket || !this.socket.connected ? '未连接' : '发送中');
      const mods = normalized.modifiers;
      const modStr = [];
      if (mods.meta) modStr.push('Cmd');
      if (mods.ctrl) modStr.push('Ctrl');
      if (mods.alt) modStr.push('Opt');
      if (mods.shift) modStr.push('Shift');
      const isModKey = ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key);
      const label = (!isModKey && modStr.length > 0) ? `${modStr.join('+')}+${normalized.key}` : normalized.key;
      this.updateKeyDisplayRaw(`${status}: ↓${label}`);
      console.log(`[KEYBOARD] keydown: key=${e.key}, code=${e.code}, keyCode=${e.keyCode}, mode=${this.keyboardMode}, normalized=${normalized.key}/${normalized.code}, isActive=${this.isActive}, socketConnected=${this.socket?.connected}`);

      if (!this.isActive) {
        console.warn('[KEYBOARD] Ignored: isActive=false');
        return;
      }
      e.preventDefault();

      const keyId = this.getKeyId(normalized);
      if (e.repeat || this._pressedKeys.has(keyId)) {
        return;
      }
      this._pressedKeys.set(keyId, {
        key: normalized.key,
        code: normalized.code,
        keyCode: normalized.keyCode,
        modifiers: mods,
        pressedAt: Date.now()
      });
      this.scheduleKeyWatchdog();

      this.sendInput('keyboard', 'keydown', {
        key: normalized.key,
        code: normalized.code,
        keyCode: normalized.keyCode,
        modifiers: mods
      });
    });

    document.addEventListener('keyup', (e) => {
      if (this.shouldIgnoreKeyboardEvent(e)) return;

      if (!this.isActive) return;
      e.preventDefault();
      const normalized = this.normalizeKeyboardEvent(e);
      this._pressedKeys.delete(this.getKeyId(normalized));
      this.scheduleKeyWatchdog();
      this.sendInput('keyboard', 'keyup', {
        key: normalized.key,
        code: normalized.code,
        keyCode: normalized.keyCode,
        modifiers: normalized.modifiers
      });
    });

    // 点击获得焦点（不再发送冗余 click 事件，mousedown+mouseup 已构成完整点击）
    video.addEventListener('click', (e) => {
      video.focus();
    });
    if (relayImage) {
      relayImage.addEventListener('click', (e) => {
        relayImage.focus();
      });
    }

    // 双击事件
    video.addEventListener('dblclick', (e) => {
      if (!this.isActive) return;
      e.preventDefault();
      video.focus();
      const coords = this.getRelativeCoords(e);
      this.sendInput('mouse', 'dblclick', coords);
    });
    if (relayImage) {
      relayImage.addEventListener('dblclick', (e) => {
        if (!this.isActive) return;
        e.preventDefault();
        relayImage.focus();
        const coords = this.getRelativeCoords(e);
        this.sendInput('mouse', 'dblclick', coords);
      });
    }

    // 视频开始播放时激活输入
    video.addEventListener('playing', () => {
      console.log('Input: Video playing, activating input');
      this.isActive = true;
      video.focus();
    });

    video.addEventListener('pause', () => {
      this.releaseAllKeys();
      this.isActive = false;
    });

    // 防止右键菜单
    video.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    });
    if (relayImage) {
      relayImage.addEventListener('contextmenu', (e) => {
        e.preventDefault();
      });
    }

    window.addEventListener('blur', () => {
      this.releaseAllKeys();
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.releaseAllKeys();
      }
    });
  },

  shouldIgnoreKeyboardEvent(e) {
    const target = e.target;
    if (!target) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
  },

  getKeyId(e) {
    return e.code || e.key || String(e.keyCode || e.which || '');
  },

  detectDefaultKeyboardMode() {
    const platform = `${navigator.platform || ''} ${navigator.userAgent || ''}`.toLowerCase();
    return platform.includes('win') ? 'windows' : 'mac';
  },

  setupKeyboardMode() {
    const saved = localStorage.getItem('wrd_keyboard_mode');
    this.keyboardMode = saved || this.detectDefaultKeyboardMode();
    this.updateKeyboardModeButton();

    const modeBtn = document.getElementById('keyboardModeBtn');
    if (modeBtn) {
      modeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        this.keyboardMode = this.keyboardMode === 'windows' ? 'mac' : 'windows';
        localStorage.setItem('wrd_keyboard_mode', this.keyboardMode);
        this.updateKeyboardModeButton();
        this.releaseAllKeys();
      });
    }
  },

  updateKeyboardModeButton() {
    const modeBtn = document.getElementById('keyboardModeBtn');
    if (!modeBtn) return;
    modeBtn.textContent = this.keyboardMode === 'windows' ? '键盘：Win(Ctrl→⌘)' : '键盘：Mac';
    modeBtn.title = this.keyboardMode === 'windows'
      ? 'Windows 访问模式：Ctrl 会映射为 macOS Command'
      : 'Mac 直通模式：按键修饰符保持原样';
  },

  normalizeKeyboardEvent(e) {
    const modifiers = this.getModifiers(e);
    let key = e.key;
    let code = e.code;
    let keyCode = e.keyCode || e.which;

    if (this.keyboardMode === 'windows') {
      if (modifiers.ctrl) {
        modifiers.meta = 1;
        modifiers.ctrl = 0;
      }

      if (code === 'ControlLeft' || code === 'ControlRight' || key === 'Control') {
        key = 'Meta';
        code = code === 'ControlRight' ? 'MetaRight' : 'MetaLeft';
        keyCode = code === 'MetaRight' ? 92 : 91;
        modifiers.meta = actionModifierValue(e, 'ctrl');
        modifiers.ctrl = 0;
      }
    }

    return { key, code, keyCode, modifiers };

    function actionModifierValue(event, modifier) {
      if (modifier === 'ctrl') return event.ctrlKey ? 1 : 0;
      return 0;
    }
  },

  queueMouseMove(coords) {
    this._pendingMouseMove = coords;
    if (this._mouseMoveScheduled) return;

    this._mouseMoveScheduled = true;
    requestAnimationFrame(() => {
      this._mouseMoveScheduled = false;
      if (!this.isActive || !this._pendingMouseMove) return;
      this.sendInput('mouse', 'move', this._pendingMouseMove);
      this._pendingMouseMove = null;
    });
  },

  getRelativeCoords(e) {
    // Use the event target element for coordinate calculation (supports both <video> and <img>)
    const el = e.currentTarget || this.videoElement;
    const rect = el.getBoundingClientRect();

    // <video> uses videoWidth/videoHeight, <img> uses naturalWidth/naturalHeight
    const videoWidth = el.videoWidth || el.naturalWidth || rect.width;
    const videoHeight = el.videoHeight || el.naturalHeight || rect.height;
    const videoRatio = videoWidth / videoHeight;
    const rectRatio = rect.width / rect.height;

    let contentWidth, contentHeight, offsetX, offsetY;
    if (rectRatio > videoRatio) {
      contentHeight = rect.height;
      contentWidth = contentHeight * videoRatio;
      offsetX = (rect.width - contentWidth) / 2;
      offsetY = 0;
    } else {
      contentWidth = rect.width;
      contentHeight = contentWidth / videoRatio;
      offsetX = 0;
      offsetY = (rect.height - contentHeight) / 2;
    }

    const rawRelX = (e.clientX - rect.left - offsetX) / contentWidth;
    const rawRelY = (e.clientY - rect.top - offsetY) / contentHeight;
    const relX = Math.max(0, Math.min(1, rawRelX));
    const relY = Math.max(0, Math.min(1, rawRelY));

    return { relX, relY };
  },

  getMouseButton(button) {
    const buttons = ['left', 'middle', 'right'];
    return buttons[button] || 'left';
  },

  getModifiers(e) {
    return {
      ctrl: e.ctrlKey ? 1 : 0,
      shift: e.shiftKey ? 1 : 0,
      alt: e.altKey ? 1 : 0,
      meta: e.metaKey ? 1 : 0
    };
  },

  isModifierKey(payload) {
    return ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(payload?.key) ||
      ['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'CapsLock'].includes(payload?.code);
  },

  scheduleKeyWatchdog() {
    if (this._keyReleaseTimer) {
      clearTimeout(this._keyReleaseTimer);
      this._keyReleaseTimer = null;
    }

    if (this._pressedKeys.size === 0) {
      return;
    }

    this._keyReleaseTimer = setTimeout(() => {
      const now = Date.now();
      const stuckKeys = Array.from(this._pressedKeys.entries())
        .filter(([, pressed]) => now - (pressed.pressedAt || now) >= this._keyStaleMs);
      if (!stuckKeys.length) {
        this.scheduleKeyWatchdog();
        return;
      }
      console.warn('[KEYBOARD] Watchdog releasing stuck keys:', stuckKeys.map(([, pressed]) => pressed));
      stuckKeys.reverse().forEach(([keyId, pressed]) => {
        this.sendInput('keyboard', 'keyup', {
          key: pressed.key,
          code: pressed.code,
          keyCode: pressed.keyCode,
          modifiers: { ctrl: 0, shift: 0, alt: 0, meta: 0 }
        });
        this._pressedKeys.delete(keyId);
      });
      this.sendKeyboardReset('watchdog');
      this.updateKeyDisplayRaw('已释放卡住的按键');
      this.scheduleKeyWatchdog();
    }, this._keyStaleMs);
  },

  sendInput(type, action, payload) {
    const data = {
      type,
      action,
      payload,
      timestamp: Date.now()
    };

    // Generate inputId for latency tracking
    const inputId = `inp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    data.inputIds = [inputId];

    // Record input send time for latency measurement
    if (typeof LatencyMonitor !== 'undefined') {
      LatencyMonitor.recordInputSend(inputId);
    }

    if (typeof WebRTC !== 'undefined' && WebRTC.sendInput && WebRTC.sendInput(data)) {
      if (type === 'keyboard' || action !== 'move') {
        console.log(`[SEND:dc] ${type} ${action}`, payload);
      }
      return;
    }

    if (!this.socket || !this.socket.connected) {
      console.warn('Input: Socket not connected');
      return;
    }

    this.socket.emit('input', {
      ...data,
      transport: 'socket'
    });

    if (type === 'keyboard' || action !== 'move') {
      console.log(`[SEND:socket] ${type} ${action}`, payload);
    }
  },

  updateKeyDisplay(payload, action) {
    const display = document.getElementById('keyInputDisplay');
    if (!display) return;

    const key = payload.key || '';
    const mods = payload.modifiers || {};
    const modStr = [];
    if (mods.meta) modStr.push('Cmd');
    if (mods.ctrl) modStr.push('Ctrl');
    if (mods.alt) modStr.push('Opt');
    if (mods.shift) modStr.push('Shift');

    let text = '';
    if (modStr.length > 0) {
      text = `${modStr.join('+')}+${key}`;
    } else {
      text = key;
    }

    display.textContent = `${action === 'keydown' ? '↓' : '↑'} ${text}`;
    display.style.opacity = '1';

    clearTimeout(this._keyDisplayTimer);
    this._keyDisplayTimer = setTimeout(() => {
      display.style.opacity = '0.5';
      display.textContent = '-';
    }, 1500);
  },

  updateKeyDisplayRaw(text) {
    const display = document.getElementById('keyInputDisplay');
    if (!display) return;
    display.textContent = text;
    display.style.opacity = '1';
  },

  setActive(active) {
    if (!active) {
      this.releaseAllKeys();
    }
    this.isActive = active;
    if (active && this.videoElement) {
      this.videoElement.focus();
      this.sendKeyboardReset('activated');
    }
    console.log('Input setActive:', active);
    this.updateKeyDisplayRaw(active ? '已激活' : '已暂停');
  },

  releaseAllKeys() {
    if (this._keyReleaseTimer) {
      clearTimeout(this._keyReleaseTimer);
      this._keyReleaseTimer = null;
    }

    if (this._pressedKeys.size === 0) {
      this.sendKeyboardReset('release-empty');
      return;
    }

    const pressed = Array.from(this._pressedKeys.values()).reverse();
    this._pressedKeys.clear();
    pressed.forEach((payload) => {
      this.sendInput('keyboard', 'keyup', {
        key: payload.key,
        code: payload.code,
        keyCode: payload.keyCode,
        modifiers: { ctrl: 0, shift: 0, alt: 0, meta: 0 }
      });
    });
    this.sendKeyboardReset('release-all');
  },

  sendKeyboardReset(reason) {
    this.sendInput('keyboard', 'reset', {
      reason,
      modifiers: { ctrl: 0, shift: 0, alt: 0, meta: 0 }
    });
  },

  sendKey(key, code, keyCode, modifiers = {}) {
    const modMap = {
      meta:  { key: 'Meta',    code: 'MetaLeft',    keyCode: 55 },
      ctrl:  { key: 'Control', code: 'ControlLeft', keyCode: 59 },
      shift: { key: 'Shift',   code: 'ShiftLeft',   keyCode: 56 },
      alt:   { key: 'Alt',     code: 'AltLeft',     keyCode: 58 },
    };

    // 1. Press modifiers (no flags on their own keydown)
    for (const [mod, pressed] of Object.entries(modifiers)) {
      if (pressed && modMap[mod]) {
        this.sendInput('keyboard', 'keydown', {
          key: modMap[mod].key,
          code: modMap[mod].code,
          keyCode: modMap[mod].keyCode,
          modifiers: {}
        });
      }
    }

    // 2. Press main key with modifiers
    this.sendInput('keyboard', 'keydown', { key, code, keyCode, modifiers });

    // 3. Release main key with modifiers
    setTimeout(() => {
      this.sendInput('keyboard', 'keyup', { key, code, keyCode, modifiers });

      // 4. Release modifiers
      setTimeout(() => {
        for (const [mod, pressed] of Object.entries(modifiers)) {
          if (pressed && modMap[mod]) {
            this.sendInput('keyboard', 'keyup', {
              key: modMap[mod].key,
              code: modMap[mod].code,
              keyCode: modMap[mod].keyCode,
              modifiers: {}
            });
          }
        }
      }, 30);
    }, 30);
  },

  bindMouseEvents(el) {
    el.addEventListener('mousemove', (e) => {
      if (!this.isActive) return;
      const coords = this.getRelativeCoords(e);
      this.queueMouseMove(coords);
    });

    el.addEventListener('mousedown', (e) => {
      if (!this.isActive) return;
      e.preventDefault();
      el.focus();
      const coords = this.getRelativeCoords(e);
      this.sendInput('mouse', 'down', {
        ...coords,
        button: this.getMouseButton(e.button)
      });
    });

    el.addEventListener('mouseup', (e) => {
      if (!this.isActive) return;
      e.preventDefault();
      const coords = this.getRelativeCoords(e);
      this.sendInput('mouse', 'up', {
        ...coords,
        button: this.getMouseButton(e.button)
      });
    });

    el.addEventListener('wheel', (e) => {
      if (!this.isActive) return;
      e.preventDefault();
      const coords = this.getRelativeCoords(e);
      this.sendInput('mouse', 'wheel', {
        ...coords,
        deltaX: e.deltaX,
        deltaY: e.deltaY
      });
    }, { passive: false });
  },

  setupActionButtons() {
    const actions = {
      enter:     { key: 'Enter',      code: 'Enter',      keyCode: 36 },
      up:        { key: 'ArrowUp',    code: 'ArrowUp',    keyCode: 126 },
      down:      { key: 'ArrowDown',  code: 'ArrowDown',  keyCode: 125 },
      left:      { key: 'ArrowLeft',  code: 'ArrowLeft',  keyCode: 123 },
      right:     { key: 'ArrowRight', code: 'ArrowRight', keyCode: 124 },
      copy:      { key: 'c',          code: 'KeyC',       keyCode: 8,  modifiers: { meta: 1 } },
      paste:     { key: 'v',          code: 'KeyV',       keyCode: 9,  modifiers: { meta: 1 } },
      cut:       { key: 'x',          code: 'KeyX',       keyCode: 7,  modifiers: { meta: 1 } },
      undo:      { key: 'z',          code: 'KeyZ',       keyCode: 6,  modifiers: { meta: 1 } },
      selectAll: { key: 'a',          code: 'KeyA',       keyCode: 0,  modifiers: { meta: 1 } },
      save:      { key: 's',          code: 'KeyS',       keyCode: 1,  modifiers: { meta: 1 } },
      find:      { key: 'f',          code: 'KeyF',       keyCode: 3,  modifiers: { meta: 1 } },
      closeTab:  { key: 'w',          code: 'KeyW',       keyCode: 13, modifiers: { meta: 1 } },
    };

    document.querySelectorAll('.action-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const action = btn.dataset.action;
        const cfg = actions[action];
        if (!cfg) return;

        console.log(`Action button: ${action}`);
        const mods = cfg.modifiers || {};
        this.sendKey(cfg.key, cfg.code, cfg.keyCode, {
          ctrl: mods.ctrl || 0,
          shift: mods.shift || 0,
          alt: mods.alt || 0,
          meta: mods.meta || 0,
        });
      });
    });
  }
};

// Input.init() 现在由 webrtc.js 在连接成功后调用
