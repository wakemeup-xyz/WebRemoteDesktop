const Input = {
  socket: null,
  videoElement: null,
  isActive: false,
  _listenersBound: false,
  _pressedKeys: new Map(),
  _pendingMouseMove: null,
  _mouseMoveScheduled: false,
  _keyReleaseTimer: null,
  _keyStaleMs: 8000,
  keyboardMode: null,
  _keyboardDebugEntries: [],
  _keyboardDebugMax: 80,

  init() {
    this.videoElement = document.getElementById('remoteVideo');
    if (!this.videoElement) {
      console.error('Input: remoteVideo element not found');
      return;
    }

    // 防止重复绑定事件监听器
    if (!this._listenersBound) {
      this.setupEventListeners();
      this.setupActionButtons();
      this.setupKeyboardMode();
      this._listenersBound = true;
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
      const mods = this.getEventModifiers(e);
      const modStr = [];
      if (mods.meta) modStr.push('Cmd');
      if (mods.ctrl) modStr.push('Ctrl');
      if (mods.alt) modStr.push('Opt');
      if (mods.shift) modStr.push('Shift');
      const isModKey = ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key);
      const label = (!isModKey && modStr.length > 0) ? `${modStr.join('+')}+${normalized.key}` : normalized.key;
      this.updateKeyDisplayRaw(`${status}: ↓${label}`);

      if (!this.isActive) {
        console.warn(`[KEYBOARD] Ignored keydown: keyId=${this.getKeyId(normalized)} key=${e.key} code=${e.code} (isActive=false)`);
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

      const downId = this.sendInput('keyboard', 'keydown', {
        key: normalized.key,
        code: normalized.code,
        keyCode: normalized.keyCode,
        modifiers: mods
      });
      this.recordKeyboardDebug('keydown', e, normalized, mods, downId);
      console.log(`[KEYBOARD] keydown: keyId=${keyId} inputId=${downId} key=${e.key} code=${e.code} -> normalized=${normalized.key}/${normalized.code}`);
    });

    document.addEventListener('keyup', (e) => {
      if (this.shouldIgnoreKeyboardEvent(e)) return;

      if (!this.isActive) return;
      e.preventDefault();
      const normalized = this.normalizeKeyboardEvent(e);
      const keyId = this.getKeyId(normalized);
      const stored = this._pressedKeys.get(keyId);
      const modifiers = stored?.modifiers || normalized.modifiers;
      this._pressedKeys.delete(keyId);
      this.scheduleKeyWatchdog();
      const upId = this.sendInput('keyboard', 'keyup', {
        key: normalized.key,
        code: normalized.code,
        keyCode: normalized.keyCode,
        modifiers
      });
      this.recordKeyboardDebug('keyup', e, normalized, modifiers, upId);
      console.log(`[KEYBOARD] keyup:   keyId=${keyId} inputId=${upId} key=${e.key} code=${e.code} -> normalized=${normalized.key}/${normalized.code}`);
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
    // Ignore form controls and any element inside a modal dialog.
    // Modal buttons (like "发送日志") should not leak keystrokes to the remote host.
    if (target.closest('.modal')) return true;
    const tag = target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return true;
    // Browser/IME composition keys are too unstable to mirror as remote hotkeys.
    return e.isComposing || e.key === 'Process' || e.key === 'Dead' || e.key === 'Unidentified' || e.key === 'AltGraph';
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

  recordKeyboardDebug(eventType, originalEvent, normalized, modifiers, inputId) {
    const modifierLabel = [
      modifiers.meta ? 'Meta' : '',
      modifiers.ctrl ? 'Ctrl' : '',
      modifiers.alt ? 'Alt' : '',
      modifiers.shift ? 'Shift' : ''
    ].filter(Boolean).join('+') || '-';
    const entry = [
      new Date().toLocaleTimeString(),
      eventType,
      'raw=' + originalEvent.key + '/' + originalEvent.code,
      'normalized=' + normalized.key + '/' + normalized.code,
      'mods=' + modifierLabel,
      'inputId=' + (inputId || '-')
    ].join(' | ');

    this._keyboardDebugEntries.push(entry);
    if (this._keyboardDebugEntries.length > this._keyboardDebugMax) {
      this._keyboardDebugEntries.shift();
    }
  },

  getKeyboardDebugEntries() {
    return this._keyboardDebugEntries.slice();
  },

  getEventModifiers(e) {
    if (e.type === 'keyup') {
      return this.getStoredModifiers(e);
    }
    return this.getModifiers(e);
  },

  getStoredModifiers(e) {
    const stored = this._pressedKeys.get(this.getKeyId(this.normalizeKeyboardEvent(e)));
    return stored?.modifiers || this.getModifiers(e);
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

    // Prefer DataChannel for lowest latency
    if (typeof WebRTC !== 'undefined' && WebRTC.sendInput && WebRTC.sendInput(data)) {
      if (type === 'keyboard' || action !== 'move') {
        console.log(`[SEND:dc] ${type} ${action} id=${inputId}`, payload);
      }
      return inputId;
    }

    // Fallback: try Socket.IO
    if (this.socket && this.socket.connected) {
      this.socket.emit('input', {
        ...data,
        transport: 'socket'
      });

      if (type === 'keyboard' || action !== 'move') {
        console.log(`[SEND:socket] ${type} ${action} id=${inputId}`, payload);
      }
      return inputId;
    }

    // Both failed — log and attempt recovery
    const dcState = (typeof WebRTC !== 'undefined' && WebRTC.inputChannel)
      ? WebRTC.inputChannel.readyState : 'null';
    console.warn(`Input: No transport available (dc=${dcState}, socket=disconnected) id=${inputId}`);

    // If WebRTC is connected but DataChannel is stuck, try reconnecting
    if (typeof WebRTC !== 'undefined' && WebRTC.pc
        && WebRTC.pc.connectionState === 'connected'
        && dcState !== 'open') {
      WebRTC.scheduleReconnect('dc-missing');
    }
    return inputId;
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
      this.releaseAllKeys('deactivated', true);
    }
    this.isActive = active;
    if (active && this.videoElement) {
      this.videoElement.focus();
      this.sendKeyboardReset('activated');
    }
    console.log('Input setActive:', active);
    this.updateKeyDisplayRaw(active ? '已激活' : '已暂停');
  },

  releaseAllKeys(reason = 'release-all', forceReset = false) {
    if (this._keyReleaseTimer) {
      clearTimeout(this._keyReleaseTimer);
      this._keyReleaseTimer = null;
    }

    // Skip if nothing is pressed — avoids flooding the host with no-op resets
    // on every blur/visibilitychange.
    if (this._pressedKeys.size === 0) {
      if (forceReset) {
        this.sendKeyboardReset(reason);
      }
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
    this.sendKeyboardReset(reason);
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
      this.scheduleKeyWatchdog();  // Reset watchdog on user activity
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
      showDock:  { type: 'command',  action: 'showDock' },
      screenshot: { key: 'a', code: 'KeyA', keyCode: 0, modifiers: { meta: 1, shift: 1 } },
      switchInputMethod: { type: 'command', action: 'switchInputMethod' },
    };

    document.querySelectorAll('.action-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const action = btn.dataset.action;
        const cfg = actions[action];
        if (!cfg) return;

        console.log(`Action button: ${action}`);

        if (cfg.type === 'command') {
          this.sendInput(cfg.type, cfg.action, {});
          return;
        }

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

document.addEventListener('DOMContentLoaded', () => {
  const video = document.getElementById('remoteVideo');
  if (!video) return;
  Input.videoElement = video;
  if (!Input._listenersBound) {
    Input.setupEventListeners();
    Input.setupActionButtons();
    Input.setupKeyboardMode();
    Input._listenersBound = true;
  }
});

// Input.init() 现在由 webrtc.js 在连接成功后调用
