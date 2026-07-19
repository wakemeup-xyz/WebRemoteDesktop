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
    socket.emit('input', { ...payload, transport: 'socket' });
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
    video.addEventListener('pause', () => this.setActive(false));
    video.addEventListener('contextmenu', (event) => event.preventDefault());
    relayImage?.addEventListener('contextmenu', (event) => event.preventDefault());
    window.addEventListener('blur', () => {
      this.releasePointer('window-blur');
      this.resetKeyboard('window-blur');
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
    if (display) display.textContent = this.keyboardController?.getSnapshot().state || 'INACTIVE';
  },

  setActive(active) {
    if (!active) {
      this.releasePointer('deactivated');
      this.resetKeyboard('deactivated');
    }
    this.isActive = Boolean(active);
    if (this.isActive && this.videoElement) this.videoElement.focus();
    this.updateKeyboardUI();
  },

  resetKeyboard(reason) {
    this.lastKeyboardResetReason = reason;
    return this.keyboardController?.reset(reason) || false;
  },

  getDiagnosticState() {
    const controller = this.keyboardController?.getSnapshot() || {};
    const transport = this.keyboardTransport?.getSnapshot() || {};
    return {
      keyboardMode: controller.mode || this.keyboardMode || null,
      isActive: this.isActive,
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
    if (!this.isActive || !lease) return null;
    const data = {
      type, action, payload, timestamp: Date.now(), inputIds: [`inp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`],
      schemaVersion: 2, leaseId: lease.leaseId, leaseEpoch: lease.leaseEpoch,
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
      if (this.isActive && this._pendingMouseMove) this.sendInput('mouse', 'move', this._pendingMouseMove);
      this._pendingMouseMove = null;
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
      if (!this.isActive) return;
      const coords = this.getRelativeCoords(event, this._activePointerId === event.pointerId);
      if (coords) { this._lastPointerCoords = coords; this.queueMouseMove(coords); }
    });
    element.addEventListener('pointerdown', (event) => {
      if (!this.isActive) return;
      event.preventDefault(); element.focus();
      const coords = this.getRelativeCoords(event); if (!coords) return;
      element.setPointerCapture?.(event.pointerId);
      const button = this.getMouseButton(event.button); const clickCount = this.getPointerClickCount(event);
      if (!this.sendInput('mouse', 'down', { ...coords, button, clickCount })) return;
      this._activePointerId = event.pointerId; this._activePointerElement = element; this._pressedMouseButtons.add(button); this._lastPointerCoords = coords; this._activePointerClickCount = clickCount;
    });
    element.addEventListener('pointerup', (event) => {
      if (!this.isActive && this._pressedMouseButtons.size === 0) return;
      event.preventDefault(); const coords = this.getRelativeCoords(event, true) || this._lastPointerCoords; const button = this.getMouseButton(event.button);
      const id = coords ? this.sendInput('mouse', 'up', { ...coords, button, clickCount: this._activePointerClickCount }) : null;
      this._pressedMouseButtons.delete(button); this._pendingMouseReset ||= !id;
      if (this._pressedMouseButtons.size === 0) { if (element.hasPointerCapture?.(event.pointerId)) element.releasePointerCapture(event.pointerId); this._activePointerId = null; this._activePointerElement = null; }
    });
    element.addEventListener('pointercancel', () => this.releasePointer('pointer-cancel'));
    element.addEventListener('wheel', (event) => { if (!this.isActive) return; event.preventDefault(); const coords = this.getRelativeCoords(event); if (coords) this.sendInput('mouse', 'wheel', { ...coords, deltaX: event.deltaX, deltaY: event.deltaY }); }, { passive: false });
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
