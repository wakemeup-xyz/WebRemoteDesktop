const Input = {
  socket: null,
  videoElement: null,
  isActive: false,
  
  init() {
    this.videoElement = document.getElementById('remoteVideo');
    if (!this.videoElement) return;

    // 使用 WebRTC 的 socket 实例（共享连接）
    if (typeof WebRTC !== 'undefined' && WebRTC.socket) {
      this.socket = WebRTC.socket;
      console.log('Input: Using shared WebRTC socket');
    } else {
      console.error('Input: WebRTC socket not available');
      return;
    }

    this.setupEventListeners();
    this.setupActionButtons();

    // 如果视频已经在播放，立即激活输入（playing 事件可能已错过）
    if (this.videoElement.readyState >= 3 && !this.videoElement.paused) {
      console.log('Input: Video already playing, activating immediately');
      this.isActive = true;
      this.videoElement.focus();
    }

    console.log('Input initialized');
  },
  
  setupEventListeners() {
    const video = this.videoElement;

    // 使 video 元素可接收焦点
    video.setAttribute('tabindex', '0');
    video.style.outline = 'none';

    // 鼠标事件绑定到 video 元素
    video.addEventListener('mousemove', (e) => {
      if (!this.isActive) return;
      const coords = this.getRelativeCoords(e);
      this.sendInput('mouse', 'move', coords);
    });

    video.addEventListener('mousedown', (e) => {
      if (!this.isActive) return;
      e.preventDefault();
      video.focus();
      const coords = this.getRelativeCoords(e);
      this.sendInput('mouse', 'down', {
        ...coords,
        button: this.getMouseButton(e.button)
      });
    });

    video.addEventListener('mouseup', (e) => {
      if (!this.isActive) return;
      e.preventDefault();
      const coords = this.getRelativeCoords(e);
      this.sendInput('mouse', 'up', {
        ...coords,
        button: this.getMouseButton(e.button)
      });
    });

    // 滚轮事件
    video.addEventListener('wheel', (e) => {
      if (!this.isActive) return;
      e.preventDefault();
      const coords = this.getRelativeCoords(e);
      this.sendInput('mouse', 'wheel', {
        ...coords,
        deltaX: e.deltaX,
        deltaY: e.deltaY
      });
    }, { passive: false });

    // 键盘事件绑定到 document
    document.addEventListener('keydown', (e) => {
      if (!this.isActive) return;
      e.preventDefault();
      this.sendInput('keyboard', 'keydown', {
        key: e.key,
        code: e.code,
        keyCode: e.keyCode || e.which,
        modifiers: this.getModifiers(e)
      });
    });

    document.addEventListener('keyup', (e) => {
      if (!this.isActive) return;
      e.preventDefault();
      this.sendInput('keyboard', 'keyup', {
        key: e.key,
        code: e.code,
        keyCode: e.keyCode || e.which,
        modifiers: this.getModifiers(e)
      });
    });

    // 点击视频获得焦点并发送点击事件
    video.addEventListener('click', (e) => {
      video.focus();
      if (!this.isActive) return;
      const coords = this.getRelativeCoords(e);
      this.sendInput('mouse', 'click', {
        ...coords,
        button: this.getMouseButton(e.button)
      });
    });

    // 双击事件
    video.addEventListener('dblclick', (e) => {
      if (!this.isActive) return;
      e.preventDefault();
      video.focus();
      const coords = this.getRelativeCoords(e);
      this.sendInput('mouse', 'dblclick', coords);
    });

    // 视频开始播放时激活输入
    video.addEventListener('playing', () => {
      console.log('Input: Video playing, activating input');
      this.isActive = true;
      video.focus();
    });

    video.addEventListener('pause', () => {
      this.isActive = false;
    });

    // 防止右键菜单
    video.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    });
  },
  
  getRelativeCoords(e) {
    const video = this.videoElement;
    const rect = video.getBoundingClientRect();

    const videoWidth = video.videoWidth || rect.width;
    const videoHeight = video.videoHeight || rect.height;
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

    console.log(
      `MOUSE DIAGNOSTIC: client=(${e.clientX},${e.clientY}) ` +
      `rect=(${rect.left.toFixed(0)},${rect.top.toFixed(0)},${rect.width.toFixed(0)},${rect.height.toFixed(0)}) ` +
      `video=(${videoWidth},${videoHeight}) ` +
      `offset=(${offsetX.toFixed(1)},${offsetY.toFixed(1)}) ` +
      `rawRel=(${rawRelX.toFixed(3)},${rawRelY.toFixed(3)}) ` +
      `clampedRel=(${relX.toFixed(3)},${relY.toFixed(3)})`
    );

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
  
  sendInput(type, action, payload) {
    if (!this.socket || !this.socket.connected) {
      console.warn('Input: Socket not connected');
      return;
    }

    this.socket.emit('input', {
      type,
      action,
      payload,
      timestamp: Date.now()
    });

    // Update on-screen key input display
    if (type === 'keyboard') {
      this.updateKeyDisplay(payload, action);
    }
  },

  updateKeyDisplay(payload, action) {
    const display = document.getElementById('keyInputDisplay');
    if (!display) return;

    const key = payload.key || '';
    const code = payload.code || '';
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
  
  setActive(active) {
    this.isActive = active;
    if (active && this.videoElement) {
      this.videoElement.focus();
    }
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

  setupActionButtons() {
    const actions = {
      enter:  { key: 'Enter',      code: 'Enter',      keyCode: 36 },
      up:     { key: 'ArrowUp',    code: 'ArrowUp',    keyCode: 126 },
      down:   { key: 'ArrowDown',  code: 'ArrowDown',  keyCode: 125 },
      left:   { key: 'ArrowLeft',  code: 'ArrowLeft',  keyCode: 123 },
      right:  { key: 'ArrowRight', code: 'ArrowRight', keyCode: 124 },
      copy:   { key: 'c',          code: 'KeyC',       keyCode: 8,  modifiers: { meta: 1 } },
      paste:  { key: 'v',          code: 'KeyV',       keyCode: 9,  modifiers: { meta: 1 } },
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

// Input.init() 现在由 webrtc.js 在视频连接成功后调用
