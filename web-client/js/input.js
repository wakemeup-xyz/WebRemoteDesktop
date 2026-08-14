const Input = {
  socket: null,
  videoElement: null,
  isActive: false,
  _listenersBound: false,
  keyboardMode: null,
  keyboardTransport: null,
  keyboardController: null,
  activeControlLease: null,
  lastKeyboardResetReason: null,
  modifierMask: 0,
  _pendingMouseMove: null,
  _mouseMoveScheduled: false,
  _pendingWheel: null,
  _wheelScheduled: false,
  _activePointerId: null,
  _activePointerElement: null,
  _pressedMouseButtons: new Set(),
  _pendingMouseReset: false,
  _lastPointerCoords: null,
  _activePointerClickCount: 1,
  _lastPointerClickAt: null,
  _lastPointerClickButton: null,
  _lastPointerClickClientX: null,
  _lastPointerClickClientY: null,
  _pointerDoubleClickWindowMs: 500,
  _pointerDoubleClickDistancePx: 6,

  init() {
    this.videoElement = document.getElementById('remoteVideo');
    if (!this.videoElement) return;
    this.socket = typeof WebRTC !== 'undefined' ? WebRTC.socket : null;
    this.initKeyboardController();
    if (!this._listenersBound) {
      this.setupEventListeners();
      this.setupActionButtons();
      this.setupKeyboardMode();
      this.setupTextInput();
      this._listenersBound = true;
    }
  },

  initKeyboardController() {
    if (this.keyboardController) return this.keyboardController;
    if (typeof KeyboardTransport === 'undefined' || typeof RemoteKeyboardController === 'undefined') return null;
    this.keyboardTransport = KeyboardTransport.create({
      sendDataChannel: (payload) => this.sendKeyboardDataChannel(payload),
      sendSocket: (payload) => this.sendKeyboardSocket(payload),
    });
    this.keyboardController = RemoteKeyboardController.create({
      transport: this.keyboardTransport,
      mode: this.keyboardMode || this.detectDefaultKeyboardMode(),
      onStateChange: () => this.updateKeyboardUI(),
    });
    if (typeof WebRTC === 'undefined' || WebRTC.inputChannel?.readyState !== 'open') {
      this.keyboardTransport.markAdapterUnavailable('dataChannel');
    }
    return this.keyboardController;
  },

  setKeyboardDataChannelAvailable(available) {
    this.initKeyboardController();
    if (!this.keyboardTransport) return;
    if (available) this.keyboardTransport.markAdapterAvailable('dataChannel');
    else this.keyboardTransport.markAdapterUnavailable('dataChannel');
    this.updateKeyboardUI();
  },

  sendKeyboardDataChannel(payload) {
    if (typeof WebRTC === 'undefined' || typeof WebRTC.sendInput !== 'function') return false;
    const accepted = WebRTC.sendInput(payload);
    if (accepted) this.recordLatency(payload);
    return accepted;
  },

  sendKeyboardSocket(payload) {
    const socket = (typeof WebRTC !== 'undefined' && WebRTC.socket) || this.socket;
    if (!socket || !socket.connected) return false;
    socket.emit('input', payload);
    this.recordLatency(payload);
    return true;
  },

  recordLatency(payload) {
    const inputId = Array.isArray(payload?.inputIds) ? payload.inputIds[0] : null;
    if (inputId && typeof LatencyMonitor !== 'undefined' && typeof LatencyMonitor.recordInputSend === 'function') {
      LatencyMonitor.recordInputSend(inputId);
    }
  },

  setControlLease(lease) {
    this.initKeyboardController();
    this.activeControlLease = lease && typeof lease.leaseId === 'string' && Number.isInteger(lease.leaseEpoch)
      ? { leaseId: lease.leaseId, leaseEpoch: lease.leaseEpoch }
      : null;
    if (this.keyboardController) this.keyboardController.setLease(lease || null);
    this.updateKeyboardUI();
  },

  acceptKeyboardAck(ack) {
    if (!this.keyboardTransport) return { status: 'stale' };
    const result = this.keyboardTransport.acceptAck(ack);
    this.modifierMask = Number.isInteger(ack?.modifierMask) ? ack.modifierMask : this.modifierMask;
    this.updateKeyboardUI();
    return result;
  },

  setupEventListeners() {
    const video = this.videoElement;
    video.setAttribute('tabindex', '0');
    video.style.outline = 'none';
    this.bindMouseEvents(video);
    const relayImage = document.getElementById('relayImage');
    if (relayImage) {
      relayImage.setAttribute('tabindex', '0');
      relayImage.style.outline = 'none';
      this.bindMouseEvents(relayImage);
    }
    document.addEventListener('keydown', (event) => this.keyboardController?.handleDomEvent(event));
    document.addEventListener('keyup', (event) => this.keyboardController?.handleDomEvent(event));
    video.addEventListener('click', () => video.focus());
    relayImage?.addEventListener('click', () => relayImage.focus());
    video.addEventListener('playing', () => { if (this.isActive) video.focus(); });
    // A transient <video> pause must not override the media/control input gate.
    // While media is applied-active and lease is live, desktop input stays enabled.
    video.addEventListener('pause', () => {
      if (typeof WebRTC !== 'undefined' && typeof WebRTC.syncDesktopInputGate === 'function') {
        WebRTC.syncDesktopInputGate();
        return;
      }
      this.setActive(false);
    });
    video.addEventListener('contextmenu', (event) => event.preventDefault());
    relayImage?.addEventListener('contextmenu', (event) => event.preventDefault());
    window.addEventListener('blur', () => {
      this.releasePointer('window-blur');
      // Do not sendReset when DC is already down — that expires the lease and
      // leaves RESET_REQUIRED until the next control-grant (which we no longer
      // fire on a live PC).
      const dcOpen = typeof WebRTC !== 'undefined' && WebRTC.inputChannel?.readyState === 'open';
      if (dcOpen) this.resetKeyboard('window-blur');
      else this.parkKeyboard('window-blur');
    });
  },

  detectDefaultKeyboardMode() {
    const platform = `${navigator.platform || ''} ${navigator.userAgent || ''}`.toLowerCase();
    return platform.includes('win') ? 'windows' : 'mac';
  },

  setupKeyboardMode() {
    const saved = localStorage.getItem('wrd_keyboard_mode');
    this.keyboardMode = saved || this.detectDefaultKeyboardMode();
    this.keyboardController?.setMode(this.keyboardMode);
    this.updateKeyboardModeButton();
    const button = document.getElementById('keyboardModeBtn');
    button?.addEventListener('click', (event) => {
      event.preventDefault();
      this.keyboardMode = this.keyboardMode === 'windows' ? 'mac' : 'windows';
      localStorage.setItem('wrd_keyboard_mode', this.keyboardMode);
      this.keyboardController?.setMode(this.keyboardMode);
      this.updateKeyboardModeButton();
    });
  },

  updateKeyboardModeButton() {
    const button = document.getElementById('keyboardModeBtn');
    if (button) button.textContent = this.keyboardMode === 'windows' ? '键盘：Win(Ctrl->Cmd)' : '键盘：Mac';
  },

  updateKeyboardUI() {
    const display = document.getElementById('keyInputDisplay');
    if (!display) return;
    const raw = this.keyboardController?.getSnapshot().state || 'INACTIVE';
    const labels = {
      INACTIVE: '键盘：未激活',
      READY: '键盘：就绪',
      BLOCKED: '键盘：阻塞',
      RESET_REQUIRED: '键盘：需复位',
      'reacquire-required': '键盘：需重获控制',
      revoked: '键盘：已撤销',
      blocked: '键盘：阻塞',
      ready: '键盘：就绪',
    };
    display.textContent = labels[raw] || `键盘：${raw}`;
    display.dataset.state = raw;
  },

  setActive(active, meta = {}) {
    const want = Boolean(active);
    // Desktop writes remain gated by WebRTC.canEnableDesktopInput when available.
    let next = want;
    if (want && typeof WebRTC !== 'undefined' && typeof WebRTC.canEnableDesktopInput === 'function') {
      next = Boolean(WebRTC.canEnableDesktopInput());
    }
    const wasActive = this.isActive;
    if (!next && wasActive) {
      const reason = meta.reason || 'deactivated';
      this.releasePointer(reason);
      // resetKeyboard:true  → always
      // resetKeyboard:false → never (caller already reset, or media-gate only)
      // undefined           → only when no control lease remains
      const shouldResetKeyboard = meta.resetKeyboard === true
        || (meta.resetKeyboard !== false && !this.activeControlLease);
      if (shouldResetKeyboard) this.resetKeyboard(reason);
    }
    this.isActive = next;
    if (this.isActive && this.videoElement) this.videoElement.focus();
    this.updateKeyboardUI();
  },

  resetKeyboard(reason) {
    this.lastKeyboardResetReason = reason;
    return this.keyboardController?.reset(reason) || false;
  },

  parkKeyboard(reason) {
    this.lastKeyboardResetReason = reason;
    if (this.keyboardController && typeof this.keyboardController.park === 'function') {
      this.keyboardController.park(reason);
      this.updateKeyboardUI();
      return true;
    }
    return false;
  },

  getDiagnosticState() {
    const controller = this.keyboardController?.getSnapshot() || {};
    const transport = this.keyboardTransport?.getSnapshot() || {};
    const gate = (typeof WebRTC !== 'undefined' && typeof WebRTC.getDesktopInputGateSnapshot === 'function')
      ? WebRTC.getDesktopInputGateSnapshot()
      : null;
    return {
      keyboardMode: controller.mode || this.keyboardMode || null,
      isActive: this.isActive,
      hasLease: Boolean(this.activeControlLease),
      leaseEpoch: this.activeControlLease?.leaseEpoch || 0,
      gate,
      keyboard: {
        leaseState: controller.state || 'INACTIVE',
        epoch: transport.epoch || 0,
        lastSent: transport.lastSent || 0,
        lastApplied: transport.lastApplied || 0,
        pendingCount: transport.pendingCount || 0,
        pressedCount: controller.pressedKeyCount || 0,
        modifierMask: this.modifierMask || 0,
        adapter: transport.adapter || null,
        lastResetReason: this.lastKeyboardResetReason || null,
      },
      pressedMouseButtonCount: this._pressedMouseButtons.size,
      pendingMouseReset: this._pendingMouseReset,
    };
  },

  sendInput(type, action, payload) {
    const lease = this.activeControlLease;
    if (!lease) return null;
    // Mouse/DOM keyboard path requires the media gate (isActive). Toolbar commands
    // like showDock only need the control lease so they keep working across brief
    // 0-FPS / media-ready gaps on full-relay.
    // Mouse up/reset are safety releases: they must still flow when the gate flips
    // mid-gesture, otherwise Host keeps a pressed button and every move becomes a drag.
    const isMouseSafetyRelease = type === 'mouse' && (action === 'up' || action === 'reset');
    if (type !== 'command' && !isMouseSafetyRelease && !this.isActive) return null;
    // Keep the v2 desktop-write envelope lean: lease + type/action/payload + inputIds.
    // Do not attach free-form metadata here; transport is added only for the path used.
    const data = {
      type,
      action,
      payload,
      inputIds: [`inp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`],
      schemaVersion: 2,
      leaseId: lease.leaseId,
      leaseEpoch: lease.leaseEpoch,
    };
    if (typeof WebRTC !== 'undefined' && WebRTC.sendInput?.(data)) {
      this.recordLatency(data);
      return data.inputIds[0];
    }
    const socket = (typeof WebRTC !== 'undefined' && WebRTC.socket) || this.socket;
    if (socket?.connected) {
      socket.emit('input', { ...data, transport: 'socket' });
      this.recordLatency(data);
      return data.inputIds[0];
    }
    return null;
  },

  queueMouseMove(coords) {
    this._pendingMouseMove = coords;
    if (this._mouseMoveScheduled) return;
    this._mouseMoveScheduled = true;
    requestAnimationFrame(() => {
      this._mouseMoveScheduled = false;
      const pending = this._pendingMouseMove;
      this._pendingMouseMove = null;
      if (!pending) return;
      // buttons===0 while we still track a local press: local desync — force reset.
      if (Number(pending.buttons) === 0 && this._pressedMouseButtons.size > 0) {
        this.releasePointer('move-buttons-clear');
      }
      if (this.isActive) this.sendInput('mouse', 'move', pending);
    });
  },

  getRelativeCoords(event, allowOutside = false) {
    const element = event.currentTarget || this.videoElement;
    const rect = element.getBoundingClientRect();
    const result = InputGeometry.mapClientPoint({ clientX: event.clientX, clientY: event.clientY, rect,
      sourceWidth: element.videoWidth || element.naturalWidth || rect.width, sourceHeight: element.videoHeight || element.naturalHeight || rect.height,
      objectFit: getComputedStyle(element).objectFit || 'contain' });
    return result.inside || allowOutside ? { relX: result.relX, relY: result.relY } : null;
  },

  getMouseButton(button) { return ['left', 'middle', 'right'][button] || 'left'; },

  getPointerClickCount(event) {
    const at = Number.isFinite(Number(event.timeStamp)) ? Number(event.timeStamp) : Date.now();
    const x = Number(event.clientX || 0); const y = Number(event.clientY || 0);
    const double = this._lastPointerClickButton === event.button && at - this._lastPointerClickAt <= this._pointerDoubleClickWindowMs
      && Math.hypot(x - this._lastPointerClickClientX, y - this._lastPointerClickClientY) <= this._pointerDoubleClickDistancePx;
    this._lastPointerClickAt = at; this._lastPointerClickButton = event.button; this._lastPointerClickClientX = x; this._lastPointerClickClientY = y;
    return Number(event.detail) >= 2 || double ? 2 : 1;
  },

  releasePointer(reason = 'pointer-release') {
    const element = this._activePointerElement; const pointerId = this._activePointerId;
    if (element?.hasPointerCapture?.(pointerId)) element.releasePointerCapture(pointerId);
    const needsReset = this._pressedMouseButtons.size > 0 || this._pendingMouseReset;
    this._pressedMouseButtons.clear(); this._activePointerId = null; this._activePointerElement = null; this._pendingMouseMove = null;
    if (!needsReset) return null;
    const inputId = this.sendInput('mouse', 'reset', { reason });
    this._pendingMouseReset = !inputId;
    return inputId;
  },

  bindMouseEvents(element) {
    element.addEventListener('pointermove', (event) => {
      if (!this.isActive && this._pressedMouseButtons.size === 0) return;
      const coords = this.getRelativeCoords(event, this._activePointerId === event.pointerId);
      if (coords) {
        this._lastPointerCoords = coords;
        this.queueMouseMove({
          ...coords,
          // Host uses buttons===0 on move to clear a stuck pressed button when the
          // matching up was lost (DC drop / gate flip mid-gesture).
          buttons: Number.isFinite(Number(event.buttons)) ? Number(event.buttons) : 0,
        });
      }
    });
    element.addEventListener('pointerdown', (event) => {
      if (!this.isActive) return;
      event.preventDefault(); element.focus();
      const coords = this.getRelativeCoords(event); if (!coords) return;
      element.setPointerCapture?.(event.pointerId);
      const button = this.getMouseButton(event.button); const clickCount = this.getPointerClickCount(event);
      if (!this.sendInput('mouse', 'down', { ...coords, button, clickCount, buttons: Number(event.buttons) || 0 })) return;
      this._activePointerId = event.pointerId; this._activePointerElement = element; this._pressedMouseButtons.add(button); this._lastPointerCoords = coords; this._activePointerClickCount = clickCount;
    });
    element.addEventListener('pointerup', (event) => {
      if (!this.isActive && this._pressedMouseButtons.size === 0) return;
      event.preventDefault(); const coords = this.getRelativeCoords(event, true) || this._lastPointerCoords; const button = this.getMouseButton(event.button);
      // up/reset bypass isActive so a mid-gesture gate flip cannot leave Host dragging.
      const id = coords
        ? this.sendInput('mouse', 'up', {
          ...coords,
          button,
          clickCount: this._activePointerClickCount,
          buttons: Number.isFinite(Number(event.buttons)) ? Number(event.buttons) : 0,
        })
        : null;
      this._pressedMouseButtons.delete(button);
      if (!id) {
        this._pendingMouseReset = true;
        this.sendInput('mouse', 'reset', { reason: 'pointer-up-failed' });
      } else {
        this._pendingMouseReset = false;
      }
      if (this._pressedMouseButtons.size === 0) { if (element.hasPointerCapture?.(event.pointerId)) element.releasePointerCapture(event.pointerId); this._activePointerId = null; this._activePointerElement = null; }
    });
    element.addEventListener('pointercancel', () => this.releasePointer('pointer-cancel'));
    element.addEventListener('lostpointercapture', () => {
      if (this._pressedMouseButtons.size > 0 || this._pendingMouseReset) {
        this.releasePointer('lost-pointer-capture');
      }
    });
    element.addEventListener('wheel', (event) => {
      if (!this.isActive) return;
      event.preventDefault();
      const coords = this.getRelativeCoords(event);
      if (!coords) return;
      this.queueWheel({
        ...coords,
        deltaX: Number(event.deltaX) || 0,
        deltaY: Number(event.deltaY) || 0,
      });
    }, { passive: false });
  },

  queueWheel(payload) {
    if (!this._pendingWheel) {
      this._pendingWheel = {
        relX: payload.relX,
        relY: payload.relY,
        deltaX: 0,
        deltaY: 0,
      };
    }
    this._pendingWheel.relX = payload.relX;
    this._pendingWheel.relY = payload.relY;
    this._pendingWheel.deltaX += Number(payload.deltaX) || 0;
    this._pendingWheel.deltaY += Number(payload.deltaY) || 0;
    if (this._wheelScheduled) return;
    this._wheelScheduled = true;
    const flush = () => {
      this._wheelScheduled = false;
      const wheel = this._pendingWheel;
      this._pendingWheel = null;
      if (!wheel || !this.isActive) return;
      if (wheel.deltaX === 0 && wheel.deltaY === 0) return;
      this.sendInput('mouse', 'wheel', wheel);
    };
    // rAF batches to the next frame; an extra microtask keeps same-tick callers
    // (and test doubles that invoke rAF synchronously) able to merge first.
    requestAnimationFrame(() => {
      Promise.resolve().then(flush);
    });
  },

  setupActionButtons() {
    const actions = {
      enter: { code: 'Enter' }, up: { code: 'ArrowUp' }, down: { code: 'ArrowDown' }, left: { code: 'ArrowLeft' }, right: { code: 'ArrowRight' },
      copy: { code: 'KeyC', modifiers: { meta: true } }, paste: { code: 'KeyV', modifiers: { meta: true } }, cut: { code: 'KeyX', modifiers: { meta: true } },
      undo: { code: 'KeyZ', modifiers: { meta: true } }, selectAll: { code: 'KeyA', modifiers: { meta: true } }, save: { code: 'KeyS', modifiers: { meta: true } },
      find: { code: 'KeyF', modifiers: { meta: true } }, screenshot: { code: 'KeyA', modifiers: { meta: true, shift: true } }, switchInputMethod: { code: 'Space', modifiers: { ctrl: true } },
    };
    document.querySelectorAll('.action-btn').forEach((button) => button.addEventListener('click', (event) => {
      event.preventDefault(); const action = button.dataset.action;
      if (action === 'showDock') { this.sendInput('command', 'showDock', {}); return; }
      const chord = actions[action]; if (chord) this.keyboardController?.sendChord(chord);
    }));
  },

  setupTextInput() {
    const modal = document.getElementById('textInputModal');
    const button = document.getElementById('textInputBtn');
    const input = document.getElementById('remoteTextInput');
    const submit = document.getElementById('textInputSubmitBtn');
    const cancel = document.getElementById('textInputCancelBtn');
    const close = () => { modal?.classList?.add('hidden'); if (input) input.value = ''; };
    const commit = () => {
      const text = Array.from(input?.value || '').slice(0, 4096).join('');
      if (text && this.keyboardController?.sendText(text)) close();
    };
    button?.addEventListener('click', (event) => { event.preventDefault(); modal?.classList?.remove('hidden'); input?.focus(); });
    submit?.addEventListener('click', (event) => { event.preventDefault(); commit(); });
    cancel?.addEventListener('click', (event) => { event.preventDefault(); close(); });
    input?.addEventListener('compositionend', () => commit());
  },
};

document.addEventListener('DOMContentLoaded', () => {
  const video = document.getElementById('remoteVideo');
  if (!video) return;
  Input.videoElement = video;
  Input.init();
});
