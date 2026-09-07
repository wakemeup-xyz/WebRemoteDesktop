const MOBILE_SURFACE_ACK_TIMEOUT_MS = 3000;
const MOBILE_VIEWPORT_UNSUPPORTED_HINT = '可用空间不足，请收起系统键盘或旋转设备';
const INPUT_RECOVERY_TIMEOUT_MS = 3000;

const Input = {
  socket: null,
  videoElement: null,
  isActive: false,
  // This is a derived viewport capability. It never owns lease or activity
  // state and therefore must not reset a local draft when the keyboard resizes.
  _viewportInputSupported: true,
  _listenersBound: false,
  keyboardMode: null,
  keyboardTransport: null,
  keyboardController: null,
  _desktopWriteSequence: 0,
  _desktopWritePending: new Map(),
  _desktopWriteRecovery: null,
  mobileTextInputAdapter: null,
  _mobileTextTransportUnsubscribe: null,
  _mobileTextTransportOwner: null,
  _mobileTransportSnapshot: null,
  _mobileTextInputUiBound: false,
  _mobileTextInputToggleBound: false,
  _mobileTextInputModalBound: false,
  _inputRecoveryUiBound: false,
  _mobileActionButtonListeners: new WeakSet(),
  _mobileTextReturnFocus: null,
  _mobileResetPending: false,
  _mobileResetAckInFlight: false,
  _recoveryTimer: null,
  _recoveryAutoIdentity: null,
  _recoveryCycle: {
    state: 'idle',
    generation: 0,
    reason: null,
    source: null,
    mouseConfirmed: false,
    keyboardConfirmed: false,
    retryAvailable: false,
    leaseId: null,
    leaseEpoch: null,
    attemptId: null,
    mouseReset: null,
    keyboardReset: null,
    mouseRetryUsed: false,
    deadline: null,
  },
  _lastSurfaceGeometry: null,
  _surfaceGeometryByElement: new WeakMap(),
  activeControlLease: null,
  lastKeyboardResetReason: null,
  modifierMask: 0,
  _pendingMouseMove: null,
  _mouseMoveScheduled: false,
  _pendingWheel: null,
  _wheelScheduled: false,
  _activePointerId: null,
  _activePointerElement: null,
  _pointerLifecycleGeneration: 0,
  _pressedMouseButtons: new Set(),
  _pendingMouseReset: false,
  _pendingMouseResetId: null,
  _mobileSurfaceState: 'settled',
  _mobileSurfaceGeneration: 0,
  _mobileSurfaceGesture: null,
  _mobileSurfaceTimer: null,
  _touchAdapters: new Map(),
  _lastTouchAdapter: null,
  _lastPointerCoords: null,
  _activePointerClickCount: 1,
  _geometryAbortedPointerId: null,
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
    this.bindTouchAdapter(this.videoElement);
    if (!this._listenersBound) {
      this.setupEventListeners();
      this.setupActionButtons();
      this.setupKeyboardMode();
      this.setupTextInput();
      this._listenersBound = true;
    }
  },

  initKeyboardController() {
    if (this.keyboardController) {
      this._subscribeMobileTextTransport();
      return this.keyboardController;
    }
    if (typeof KeyboardTransport === 'undefined' || typeof RemoteKeyboardController === 'undefined') return null;
    this.keyboardTransport = KeyboardTransport.create({
      sendDataChannel: (payload) => this.sendKeyboardDataChannel(payload),
      sendSocket: (payload) => this.sendKeyboardSocket(payload),
      getConnectionAttemptId: () => this._currentConnectionAttemptId(),
    });
    this.keyboardController = RemoteKeyboardController.create({
      transport: this.keyboardTransport,
      mode: this.keyboardMode || this.detectDefaultKeyboardMode(),
      onStateChange: () => this.updateKeyboardUI(),
    });
    if (typeof WebRTC === 'undefined' || WebRTC.inputChannel?.readyState !== 'open') {
      this.keyboardTransport.markAdapterUnavailable('dataChannel');
    }
    this._subscribeMobileTextTransport();
    return this.keyboardController;
  },

  _subscribeMobileTextTransport() {
    const transport = this.keyboardTransport;
    if (!transport || typeof transport.subscribeState !== 'function') return;
    if (this._mobileTextTransportOwner === transport && this._mobileTextTransportUnsubscribe) return;
    this._mobileTextTransportUnsubscribe?.();
    this._mobileTextTransportUnsubscribe = null;
    this._mobileTextTransportOwner = transport;
    this._mobileTextTransportUnsubscribe = transport.subscribeState((snapshot) => {
      this._mobileTransportSnapshot = snapshot || null;
      const state = String(snapshot?.state || '').toLowerCase();
      if (this.mobileTextInputAdapter) {
        if (state === 'ready' && this._mobileResetAckInFlight) {
          this.updateMobileTextInputState(this.mobileTextInputAdapter.getSnapshot());
          return;
        }
        if (state === 'ready' && this._mobileResetPending) {
          this.mobileTextInputAdapter.onTransportState('reacquire-required');
          this.updateMobileTextInputState(this.mobileTextInputAdapter.getSnapshot());
          return;
        }
        if (state === 'ready' || state === 'blocked' || state === 'reacquire-required') {
          this.mobileTextInputAdapter.onTransportState(state);
        }
        this.updateMobileTextInputState(this.mobileTextInputAdapter.getSnapshot());
      }
    });
  },

  _syncMobileTextTransport() {
    const snapshot = this._mobileTransportSnapshot || this.keyboardTransport?.getSnapshot?.();
    if (!snapshot || !this.mobileTextInputAdapter) return;
    const state = String(snapshot.state || '').toLowerCase();
    if (state === 'ready' && this._mobileResetPending && !this._mobileResetAckInFlight) {
      this.mobileTextInputAdapter.onTransportState('reacquire-required');
    } else if (state === 'ready' || state === 'blocked' || state === 'reacquire-required' || state === 'revoked') {
      this.mobileTextInputAdapter.onTransportState(state);
    }
    this.updateMobileTextInputState(this.mobileTextInputAdapter.getSnapshot());
  },

  setKeyboardDataChannelAvailable(available) {
    this.initKeyboardController();
    if (!this.keyboardTransport) return;
    if (available) {
      this.keyboardTransport.markAdapterAvailable('dataChannel');
      this._maybeAutoRecover('datachannel-available');
    } else {
      this.mobileTextInputAdapter?.invalidateContext?.('datachannel-unavailable');
      this.keyboardTransport.markAdapterUnavailable('dataChannel');
    }
    this._syncMobileTextTransport();
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
    const nextLease = lease && typeof lease.leaseId === 'string' && Number.isInteger(lease.leaseEpoch)
      ? { leaseId: lease.leaseId, leaseEpoch: lease.leaseEpoch }
      : null;
    const previousLease = this.activeControlLease;
    const leaseChanged = previousLease?.leaseId !== nextLease?.leaseId
      || previousLease?.leaseEpoch !== nextLease?.leaseEpoch;
    if (leaseChanged) {
      this._invalidateRecoveryIdentity('lease-changed');
      this._recoveryAutoIdentity = null;
      // Clear the mobile draft before the controller changes the transport
      // identity. The old generation must never cross a lease boundary.
      this._mobileResetPending = false;
      this._mobileResetAckInFlight = false;
      this.clearMobileTextInputDock();
      this.mobileTextInputAdapter?.reset('lease-changed');
      this._resetMobileSurfaceContext();
      this._desktopWriteSequence = 0;
      this._desktopWritePending.clear();
      this._desktopWriteRecovery = null;
      this._pointerLifecycleGeneration += 1;
      this._pendingMouseMove = null;
      if (nextLease) {
        this._pendingMouseReset = false;
        this._pendingMouseResetId = null;
        this._touchAdapters.forEach((adapter) => adapter.rearm?.());
      }
    }
    this.activeControlLease = nextLease;
    if (this.keyboardController) this.keyboardController.setLease(lease || null);
    if (!nextLease) this.mobileTextInputAdapter?.onTransportState('revoked');
    this.updateKeyboardUI();
    if (nextLease) this._maybeAutoRecover('lease-rebind');
  },

  acceptKeyboardAck(ack) {
    if (!this.keyboardTransport) return { status: 'stale' };
    const ownedResetPending = this._mobileResetPending;
    const pendingReset = this.keyboardTransport.getPendingReset?.();
    const currentAttempt = this._currentConnectionAttemptId();
    // ACKs do not carry a WebRTC attempt in the v2 keyboard envelope. The
    // transport records the attempt at send time, so reject an old barrier
    // before it can clear the current lease's reset state.
    if (pendingReset && pendingReset.connectionAttemptId !== currentAttempt) {
      return { status: 'stale' };
    }
    this._mobileResetAckInFlight = ownedResetPending;
    let result;
    try {
      result = this.keyboardTransport.acceptAck(ack);
    } finally {
      this._mobileResetAckInFlight = false;
    }
    const cycle = this._recoveryCycle;
    if (cycle?.state === 'waiting') {
      const ownedFailure = this._isOwnedResetFailureAck(
        ack, pendingReset, 'keyboard', cycle.leaseEpoch,
      );
      const ownedEnvelope = this._isOwnedResetEnvelope(
        ack, pendingReset, 'keyboard', cycle.leaseEpoch,
      ) && ack.appliedSeq >= pendingReset.seq;
      if ((ownedFailure || (ownedEnvelope && !['applied', 'duplicate'].includes(ack.status)))) {
        this._markRecoveryFailure(`keyboard-reset-ack-${String(ack.status || 'rejected')}`);
      } else {
        this._handleRecoveryAck('keyboard', ack, result);
      }
    } else if (ownedResetPending && this._mobileResetPending) {
      const transportState = this.keyboardTransport.getSnapshot?.().state;
      const resetApplied = (result.status === 'applied' || result.status === 'duplicate')
        && pendingReset
        && (!Object.prototype.hasOwnProperty.call(ack || {}, 'inputType') || ack.inputType === 'keyboard')
        && Array.isArray(ack?.inputIds)
        && ack.inputIds.includes(pendingReset.inputId)
        && Number.isSafeInteger(ack?.appliedSeq)
        && ack.appliedSeq >= pendingReset.seq
        && transportState === 'ready';
      if (resetApplied) {
        this._mobileResetPending = false;
        this.mobileTextInputAdapter?.onTransportState('ready', { resetAcknowledged: true });
      } else if (transportState === 'reacquire-required' || transportState === 'revoked') {
        this._mobileResetPending = false;
        this.mobileTextInputAdapter?.onTransportState('reacquire-required');
      } else if (result.status === 'stale' || result.status === 'resync-required') {
        // A reset barrier that has not been positively acknowledged remains
        // fail-closed, even if a stale sequence or resync response arrives.
        this.mobileTextInputAdapter?.onTransportState('reacquire-required');
      }
    }
    this.modifierMask = Number.isInteger(ack?.modifierMask) ? ack.modifierMask : this.modifierMask;
    this.mobileTextInputAdapter?.refreshDeliveryState();
    this.updateKeyboardUI();
    return result;
  },

  _clearMobileSurfaceTimer() {
    if (this._mobileSurfaceTimer !== null) clearTimeout(this._mobileSurfaceTimer);
    this._mobileSurfaceTimer = null;
  },

  _scheduleMobileSurfaceTimer() {
    this._clearMobileSurfaceTimer();
    const gesture = this._mobileSurfaceGesture;
    if (!gesture || this._mobileSurfaceState !== 'pending') return;
    const deadlines = [];
    if (!gesture.downAck && gesture.downId && Number.isFinite(gesture.downDeadline)) {
      deadlines.push({ edge: 'down', id: gesture.downId, deadline: gesture.downDeadline });
    }
    if (!gesture.upAck && gesture.upId && Number.isFinite(gesture.upDeadline)) {
      deadlines.push({ edge: 'up', id: gesture.upId, deadline: gesture.upDeadline });
    }
    if (!deadlines.length) return;
    deadlines.sort((left, right) => left.deadline - right.deadline);
    const { edge, id, deadline } = deadlines[0];
    const generation = gesture.generation;
    this._mobileSurfaceTimer = setTimeout(() => {
      this._mobileSurfaceTimer = null;
      const current = this._mobileSurfaceGesture;
      if (!current || this._mobileSurfaceState !== 'pending' || current.generation !== generation) return;
      if (edge === 'down' && current.downId === id && !current.downAck) {
        this._markMobileSurfaceUncertain('down-ack-timeout');
      } else if (edge === 'up' && current.upId === id && !current.upAck) {
        this._markMobileSurfaceUncertain('up-ack-timeout');
      } else {
        this._scheduleMobileSurfaceTimer();
      }
    }, Math.max(0, deadline - Date.now()));
  },

  _resetMobileSurfaceContext({ preserveUncertainty = false } = {}) {
    const previousState = this._mobileSurfaceState;
    const keepUncertain = preserveUncertainty
      && (previousState === 'uncertain' || previousState === 'pending');
    this._clearMobileSurfaceTimer();
    this._mobileSurfaceGeneration += 1;
    this._mobileSurfaceState = keepUncertain ? 'uncertain' : 'settled';
    this._mobileSurfaceGesture = null;
    if (preserveUncertainty && keepUncertain) {
      this.mobileTextInputAdapter?.onTransportState('reacquire-required');
    } else {
      this.mobileTextInputAdapter?.refreshDeliveryState();
    }
  },

  _currentConnectionAttemptId() {
    return typeof WebRTC !== 'undefined'
      ? (WebRTC.currentConnectionAttemptId || null)
      : null;
  },

  _recoveryIdentity() {
    const lease = this.activeControlLease;
    return {
      leaseId: lease?.leaseId || null,
      leaseEpoch: Number.isInteger(lease?.leaseEpoch) ? lease.leaseEpoch : null,
      attemptId: this._currentConnectionAttemptId(),
    };
  },

  _sameRecoveryIdentity(cycle = this._recoveryCycle) {
    const identity = this._recoveryIdentity();
    return Boolean(cycle
      && cycle.leaseId === identity.leaseId
      && cycle.leaseEpoch === identity.leaseEpoch
      && cycle.attemptId === identity.attemptId);
  },

  _recoveryIdentityKey() {
    const identity = this._recoveryIdentity();
    // This key is internal only; never expose it through diagnostic state.
    return `${identity.leaseId || ''}|${identity.leaseEpoch ?? ''}|${identity.attemptId || ''}`;
  },

  _clearRecoveryTimer() {
    if (this._recoveryTimer !== null) clearTimeout(this._recoveryTimer);
    this._recoveryTimer = null;
  },

  _resetRecoveryCycle(reason = null) {
    this._clearRecoveryTimer();
    this._recoveryCycle = {
      state: 'idle',
      generation: Number(this._recoveryCycle?.generation) || 0,
      reason,
      source: null,
      mouseConfirmed: false,
      keyboardConfirmed: false,
      retryAvailable: false,
      leaseId: null,
      leaseEpoch: null,
      attemptId: null,
      mouseReset: null,
      keyboardReset: null,
      mouseRetryUsed: false,
      deadline: null,
    };
  },

  _invalidateRecoveryIdentity(reason = 'identity-changed') {
    const cycle = this._recoveryCycle;
    if (!cycle || cycle.state === 'idle') return false;
    this._resetRecoveryCycle(reason);
    this.updateKeyboardUI();
    return true;
  },

  _recoverySnapshot() {
    const cycle = this._recoveryCycle || {};
    return {
      state: ['idle', 'waiting', 'recovered', 'failed'].includes(cycle.state)
        ? cycle.state : 'idle',
      generation: Number.isSafeInteger(cycle.generation) ? cycle.generation : 0,
      reason: typeof cycle.reason === 'string' ? cycle.reason : null,
      mouseConfirmed: cycle.mouseConfirmed === true,
      keyboardConfirmed: cycle.keyboardConfirmed === true,
      retryAvailable: cycle.retryAvailable === true,
    };
  },

  _markRecoveryFailure(reason = 'recovery-failed') {
    const cycle = this._recoveryCycle;
    if (!cycle || cycle.state !== 'waiting') return false;
    this._clearRecoveryTimer();
    cycle.state = 'failed';
    cycle.reason = String(reason || 'recovery-failed');
    cycle.retryAvailable = true;
    this._mobileResetAckInFlight = false;
    this.updateKeyboardUI();
    return true;
  },

  _recoveryNeedsReset() {
    const mobile = this.mobileTextInputAdapter?.getSnapshot?.() || {};
    const keyboard = this.keyboardController?.getSnapshot?.() || {};
    const transport = this.keyboardTransport?.getSnapshot?.() || {};
    const pendingReset = this.keyboardTransport?.getPendingReset?.();
    const currentAttempt = this._currentConnectionAttemptId();
    const transportState = String(transport.state || '').toLowerCase();
    const keyboardState = String(keyboard.state || '').toLowerCase();
    // Composition belongs to the local editor. Do not spend a recovery budget
    // while the IME is still composing; the next lifecycle/active callback can
    // retry after compositionend.
    if (mobile.composing) return false;

    const surfaceUncertain = this._mobileSurfaceState === 'uncertain';
    const keyboardBarrierWaiting = transportState === 'blocked'
      && this._mobileResetPending
      && pendingReset?.connectionAttemptId === currentAttempt;
    const staleKeyboardBarrier = Boolean(
      pendingReset && pendingReset.connectionAttemptId !== currentAttempt,
    );
    const contextNeedsRecovery = !keyboardBarrierWaiting && Boolean(
      this.mobileTextInputAdapter?.needsContextRecovery?.()
      || (mobile.deliveryUncertain && !mobile.hasPending),
    );
    const transportNeedsRecovery = ['reacquire-required', 'revoked'].includes(transportState);
    const controllerNeedsRecovery = ['reset_required', 'reacquire-required', 'revoked']
      .includes(keyboardState) && !keyboardBarrierWaiting;

    // Ordinary surface ACKs, pending drafts, and an owned keyboard reset ACK
    // already in flight are not failures. Only uncertainty or a failed/expired
    // transport state can start a bounded dual-reset cycle.
    return surfaceUncertain
      || this._pendingMouseReset
      || this._desktopWriteRecovery?.state === 'reacquire-required'
      || (contextNeedsRecovery && !mobile.hasPending)
      || transportNeedsRecovery
      || staleKeyboardBarrier
      || controllerNeedsRecovery;
  },

  _canAutoRecover() {
    if (!this.activeControlLease || !this.isActive) return false;
    if (typeof document !== 'undefined' && document.hidden) return false;
    if (typeof WebRTC !== 'undefined' && typeof WebRTC.canEnableDesktopInput === 'function'
      && !WebRTC.canEnableDesktopInput()) return false;
    return true;
  },

  _isOwnedResetAck(ack, reset, inputType, leaseEpoch) {
    return Boolean(this._isOwnedResetEnvelope(ack, reset, inputType, leaseEpoch)
      && ['applied', 'duplicate'].includes(ack.status)
      && ack.appliedSeq >= reset.seq);
  },

  _isOwnedResetEnvelope(ack, reset, inputType, leaseEpoch) {
    return Boolean(reset && ack?.schemaVersion === 2
      && ack.inputType === inputType
      && ack.leaseEpoch === leaseEpoch
      && Array.isArray(ack.inputIds)
      && ack.inputIds.includes(reset.inputId)
      && Number.isSafeInteger(ack.appliedSeq));
  },

  _isOwnedResetFailureAck(ack, reset, inputType, leaseEpoch) {
    return Boolean(this._isOwnedResetEnvelope(ack, reset, inputType, leaseEpoch)
      && ack.status === 'execution-failed'
      && ack.appliedSeq === reset.seq - 1);
  },

  _captureMouseReset(inputId) {
    if (!inputId || !this.activeControlLease) return null;
    const record = this._desktopWritePending.get(inputId);
    if (!record || record.type !== 'mouse' || record.action !== 'reset') return null;
    if (record.leaseId !== this.activeControlLease.leaseId
      || record.leaseEpoch !== this.activeControlLease.leaseEpoch) return null;
    if (record.connectionAttemptId !== this._currentConnectionAttemptId()) return null;
    return {
      inputId: record.inputId,
      seq: record.seq,
      leaseEpoch: record.leaseEpoch,
      attemptId: record.connectionAttemptId,
    };
  },

  _captureKeyboardReset() {
    const reset = this.keyboardTransport?.getPendingReset?.();
    if (!reset || !this.activeControlLease) return null;
    if (reset.leaseEpoch !== this.activeControlLease.leaseEpoch) return null;
    if (reset.connectionAttemptId !== this._currentConnectionAttemptId()) return null;
    return {
      inputId: reset.inputId,
      seq: reset.seq,
      leaseEpoch: reset.leaseEpoch,
      attemptId: reset.connectionAttemptId,
    };
  },

  _finishRecoveryIfReady() {
    const cycle = this._recoveryCycle;
    if (!cycle || cycle.state !== 'waiting'
      || !cycle.mouseConfirmed || !cycle.keyboardConfirmed
      || !this._sameRecoveryIdentity(cycle)) return false;

    this._clearRecoveryTimer();
    this._pendingMouseReset = false;
    this._pendingMouseResetId = null;
    this._touchAdapters.forEach((adapter) => adapter.rearm?.());
    this._touchAdapters.forEach((adapter) => adapter.flushPending?.());
    this._mobileSurfaceState = 'settled';
    this._mobileSurfaceGesture = null;
    this._clearMobileSurfaceTimer();
    if (cycle.mouseReset?.inputId) {
      this._desktopWritePending.delete(cycle.mouseReset.inputId);
    }
    cycle.state = 'recovered';
    cycle.reason = null;
    cycle.retryAvailable = false;
    // A successful cycle closes this incident. A later blur or DataChannel
    // failure in the same lease/attempt is a new generation with fresh budget.
    this._recoveryAutoIdentity = null;
    this._mobileResetPending = false;
    this._mobileResetAckInFlight = false;
    // The transport ready edge is suppressed while the keyboard reset belongs
    // to this dual-reset cycle. Re-emit it only after both owners are confirmed
    // so mobile text input can leave blocked without confirming too early.
    this.mobileTextInputAdapter?.onTransportState('ready', { resetAcknowledged: true });
    this.updateKeyboardUI();
    return true;
  },

  _handleRecoverySequenceGap(ack) {
    const cycle = this._recoveryCycle;
    const reset = cycle?.mouseReset;
    if (!cycle || cycle.state !== 'waiting' || cycle.mouseConfirmed || !reset
      || !this._sameRecoveryIdentity(cycle)
      || ack?.schemaVersion !== 2 || ack?.inputType !== 'mouse'
      || ack?.leaseEpoch !== reset.leaseEpoch
      || !Array.isArray(ack?.inputIds) || !ack.inputIds.includes(reset.inputId)
      || ack?.status !== 'sequence-gap'
      || !Number.isSafeInteger(ack?.appliedSeq)
      || ack.appliedSeq < 0 || ack.appliedSeq > this._desktopWriteSequence
      || cycle.mouseRetryUsed) return false;

    cycle.mouseRetryUsed = true;
    this._desktopWriteSequence = ack.appliedSeq;
    this._desktopWritePending.forEach((record, inputId) => {
      if (record.seq > ack.appliedSeq) this._desktopWritePending.delete(inputId);
    });
    const newId = this.sendInput('mouse', 'reset', { reason: 'sequence-gap' });
    const newReset = this._captureMouseReset(newId);
    if (!newReset) {
      this._markRecoveryFailure('mouse-reset-retry-failed');
      return false;
    }
    cycle.mouseReset = newReset;
    this._pendingMouseReset = true;
    this._pendingMouseResetId = newId;
    this.updateKeyboardUI();
    return true;
  },

  _handleRecoveryAck(inputType, ack, transportResult) {
    const cycle = this._recoveryCycle;
    if (!cycle || cycle.state !== 'waiting' || !this._sameRecoveryIdentity(cycle)) return false;
    const reset = inputType === 'mouse' ? cycle.mouseReset : cycle.keyboardReset;
    if (!this._isOwnedResetAck(ack, reset, inputType, cycle.leaseEpoch)
      || !['applied', 'duplicate'].includes(transportResult?.status)) return false;
    if (inputType === 'mouse') cycle.mouseConfirmed = true;
    else cycle.keyboardConfirmed = true;
    this._finishRecoveryIfReady();
    return true;
  },

  requestInputRecovery({ source } = {}) {
    if (source !== 'auto' && source !== 'user') return false;
    if (!this.activeControlLease || !this._recoveryNeedsReset()) return false;
    const current = this._recoveryCycle;
    if (current?.state === 'waiting') return false;
    if (source === 'auto' && this._recoveryAutoIdentity === this._recoveryIdentityKey()) return false;
    if (source === 'auto' && !this._canAutoRecover()) return false;
    // Mark the current lease/attempt as having spent its automatic budget for
    // this incident even when a user started the cycle. A later active/visible
    // callback must not launch a second automatic cycle after timeout; an
    // explicit user retry remains allowed below.
    this._recoveryAutoIdentity = this._recoveryIdentityKey();

    this._clearRecoveryTimer();
    const identity = this._recoveryIdentity();
    const generation = (Number(current?.generation) || 0) + 1;
    this._recoveryCycle = {
      state: 'waiting',
      generation,
      reason: source === 'auto' ? 'automatic-recovery' : 'user-recovery',
      source,
      mouseConfirmed: false,
      keyboardConfirmed: false,
      retryAvailable: false,
      leaseId: identity.leaseId,
      leaseEpoch: identity.leaseEpoch,
      attemptId: identity.attemptId,
      mouseReset: null,
      keyboardReset: null,
      mouseRetryUsed: false,
      deadline: Date.now() + INPUT_RECOVERY_TIMEOUT_MS,
    };

    // Claim a reset already in flight (for example the reset emitted while a
    // pointer was parked); otherwise emit one fresh barrier for this cycle.
    const wireResetReason = source === 'auto' ? 'transport-change' : 'manual';
    const existingMouse = current?.state === 'failed' ? null : (this._pendingMouseResetId
      ? this._captureMouseReset(this._pendingMouseResetId) : null);
    const mouseId = existingMouse?.inputId
      || this.sendInput('mouse', 'reset', { reason: wireResetReason });
    this._recoveryCycle.mouseReset = existingMouse || this._captureMouseReset(mouseId);
    if (this._recoveryCycle.mouseReset) {
      this._pendingMouseReset = true;
      this._pendingMouseResetId = this._recoveryCycle.mouseReset.inputId;
    }

    const keyboardAccepted = Boolean(this.keyboardController?.reset?.(wireResetReason));
    this._recoveryCycle.keyboardReset = keyboardAccepted ? this._captureKeyboardReset() : null;
    this._mobileResetPending = Boolean(this._recoveryCycle.keyboardReset);
    if (!this._recoveryCycle.mouseReset) {
      this._markRecoveryFailure('mouse-reset-send-failed');
      return false;
    }
    if (!this._recoveryCycle.keyboardReset) {
      this._markRecoveryFailure('keyboard-reset-send-failed');
      return false;
    }

    const generationAtStart = generation;
    this._recoveryTimer = setTimeout(() => {
      if (this._recoveryCycle?.state === 'waiting'
        && this._recoveryCycle.generation === generationAtStart) {
        this._markRecoveryFailure('recovery-timeout');
      }
    }, INPUT_RECOVERY_TIMEOUT_MS);
    this.updateKeyboardUI();
    return true;
  },

  _maybeAutoRecover(reason = 'lifecycle') {
    if (!this._recoveryNeedsReset()) return false;
    return this.requestInputRecovery({ source: 'auto', reason });
  },

  onConnectionAttemptChanged(attemptId = null) {
    const currentAttempt = attemptId || null;
    if (this._recoveryCycle?.state !== 'waiting'
      || this._recoveryCycle.attemptId === currentAttempt) return false;
    this._invalidateRecoveryIdentity('attempt-changed');
    this._recoveryAutoIdentity = null;
    return true;
  },

  _markMobileSurfaceUncertain(_reason) {
    this._clearMobileSurfaceTimer();
    this._mobileSurfaceGeneration += 1;
    this._mobileSurfaceState = 'uncertain';
    this._mobileSurfaceGesture = null;
    this.mobileTextInputAdapter?.onTransportState('reacquire-required');
    this.updateMobileTextInputState(this.mobileTextInputAdapter?.getSnapshot());
  },

  _beginMobileSurfaceGesture(inputId) {
    if (!inputId || !this.activeControlLease) return false;
    this._clearMobileSurfaceTimer();
    const generation = this._mobileSurfaceGeneration + 1;
    this._mobileSurfaceGeneration = generation;
    this._mobileSurfaceState = 'pending';
    const record = this._desktopWritePending.get(inputId);
    this._mobileSurfaceGesture = {
      generation,
      leaseId: this.activeControlLease.leaseId,
      leaseEpoch: this.activeControlLease.leaseEpoch,
      downId: inputId,
      downSeq: Number.isSafeInteger(record?.seq) ? record.seq : null,
      downDeadline: Date.now() + MOBILE_SURFACE_ACK_TIMEOUT_MS,
      downAck: false,
      upId: null,
      upSeq: null,
      upDeadline: null,
      upAck: false,
      ended: false,
    };
    if (record) record.surfaceGeneration = generation;
    this._scheduleMobileSurfaceTimer();
    this.mobileTextInputAdapter?.refreshDeliveryState();
    return true;
  },

  _markMobileSurfaceGestureEnded(inputId) {
    const gesture = this._mobileSurfaceGesture;
    if (!gesture || this._mobileSurfaceState !== 'pending' || !inputId) return false;
    gesture.upId = inputId;
    const record = this._desktopWritePending.get(inputId);
    gesture.upSeq = Number.isSafeInteger(record?.seq) ? record.seq : null;
    gesture.upDeadline = Date.now() + MOBILE_SURFACE_ACK_TIMEOUT_MS;
    gesture.ended = true;
    if (record) record.surfaceGeneration = gesture.generation;
    this._scheduleMobileSurfaceTimer();
    this._settleMobileSurfaceGestureIfReady();
    return true;
  },

  _settleMobileSurfaceGestureIfReady() {
    const gesture = this._mobileSurfaceGesture;
    if (!gesture || !gesture.ended || !gesture.downAck || !gesture.upAck) return false;
    this._clearMobileSurfaceTimer();
    this._mobileSurfaceState = 'settled';
    this._mobileSurfaceGesture = null;
    this.mobileTextInputAdapter?.refreshDeliveryState();
    this.updateMobileTextInputState(this.mobileTextInputAdapter?.getSnapshot());
    return true;
  },

  _handleMobileSurfaceAck(ack) {
    if (!this._mobileSurfaceGesture) return;
    if (Object.prototype.hasOwnProperty.call(ack || {}, 'inputType')
      && ack.inputType !== 'mouse') return;
    const gesture = this._mobileSurfaceGesture;
    if (ack?.leaseEpoch !== gesture.leaseEpoch
      || (ack?.leaseId !== undefined && ack.leaseId !== gesture.leaseId)
      || this.activeControlLease?.leaseId !== gesture.leaseId
      || this.activeControlLease?.leaseEpoch !== gesture.leaseEpoch) return;
    const ackInputIds = Array.isArray(ack?.inputIds)
      ? ack.inputIds : (ack?.inputId ? [ack.inputId] : []);
    const matchesDown = ackInputIds.includes(gesture.downId);
    const matchesUp = gesture.upId !== null && ackInputIds.includes(gesture.upId);
    if (!matchesDown && !matchesUp) return;
    const now = Date.now();
    const downExpired = !gesture.downAck && Number.isFinite(gesture.downDeadline)
      && now > gesture.downDeadline;
    const upExpired = !gesture.upAck && gesture.upId !== null
      && Number.isFinite(gesture.upDeadline) && now > gesture.upDeadline;
    if (downExpired || upExpired) {
      this._markMobileSurfaceUncertain('late-ack');
      return;
    }
    const status = ack?.status;
    if (status !== 'applied' && status !== 'duplicate') {
      this._markMobileSurfaceUncertain(`ack-${String(status || 'unknown')}`);
      return;
    }
    const appliedSeq = Number.isSafeInteger(ack?.appliedSeq) ? ack.appliedSeq : null;
    if (matchesDown && (appliedSeq === null || gesture.downSeq === null || appliedSeq >= gesture.downSeq)) {
      gesture.downAck = true;
    }
    if (matchesUp && (appliedSeq === null || gesture.upSeq === null || appliedSeq >= gesture.upSeq)) {
      gesture.upAck = true;
    }
    this._scheduleMobileSurfaceTimer();
    this._settleMobileSurfaceGestureIfReady();
  },

  getMobileSurfaceContextSnapshot() {
    return { state: this._mobileSurfaceState, generation: this._mobileSurfaceGeneration };
  },

  setViewportInputSupported(supported) {
    this._viewportInputSupported = supported !== false;
    this.updateMobileTextInputState(this.mobileTextInputAdapter?.getSnapshot?.());
    return this._viewportInputSupported;
  },

  _isMobileEditingActionAllowed() {
    const snapshot = this.mobileTextInputAdapter?.getSnapshot?.();
    if (snapshot && (snapshot.composing || snapshot.hasPending || snapshot.deliveryUncertain)) return false;
    return this._viewportInputSupported
      && this._mobileSurfaceState === 'settled' && !this._pendingMouseReset;
  },

  _isDesktopInputActionAllowed() {
    return this.getEffectiveInputGate().allowed;
  },

  _isAcceptedMobileSurfaceMove(payload = null) {
    const gesture = this._mobileSurfaceGesture;
    if (this._mobileSurfaceState !== 'pending'
      || !gesture?.downId
      || gesture.ended === true
      || gesture.generation !== this._mobileSurfaceGeneration
      || this.activeControlLease?.leaseId !== gesture.leaseId
      || this.activeControlLease?.leaseEpoch !== gesture.leaseEpoch) return false;

    const trackedButtons = new Set(this._pressedMouseButtons);
    this._touchAdapters.forEach((adapter) => {
      const snapshot = adapter?.getSnapshot?.();
      if (snapshot?.activeButton) trackedButtons.add(snapshot.activeButton);
    });
    if (!trackedButtons.size) return false;
    const buttons = Number(payload?.buttons);
    if (!Number.isSafeInteger(buttons) || buttons <= 0) return false;
    const buttonMasks = { left: 1, right: 2, middle: 4 };
    return [...trackedButtons].some((button) => (buttons & (buttonMasks[button] || 0)) !== 0);
  },

  runMobileEditingAction(action, send) {
    if (!['navigation', 'context-change'].includes(action)
      || !this._isMobileEditingActionAllowed() || typeof send !== 'function') return false;
    if (this.mobileTextInputAdapter?.runExternalAction) {
      return this.mobileTextInputAdapter.runExternalAction(action, send);
    }
    let result;
    try {
      result = send();
    } catch (_) {
      return false;
    }
    return result === true;
  },

  _sendMobileSurfaceDown(payload) {
    let inputId = null;
    const accepted = this.runMobileEditingAction('context-change', () => {
      inputId = this.sendInput('mouse', 'down', payload);
      return Boolean(inputId);
    });
    if (!accepted || !this._beginMobileSurfaceGesture(inputId)) return null;
    return inputId;
  },

  _sendMobileSurfaceUp(payload) {
    const inputId = this.sendInput('mouse', 'up', payload);
    if (inputId) this._markMobileSurfaceGestureEnded(inputId);
    else if (this._mobileSurfaceState === 'pending') this._markMobileSurfaceUncertain('up-send-failed');
    return inputId;
  },

  _sendMobileSurfaceReset(payload) {
    const inputId = this.sendInput('mouse', 'reset', payload);
    if (this._mobileSurfaceState === 'pending') this._markMobileSurfaceUncertain('mouse-reset');
    return inputId;
  },

  _acceptDesktopWriteAck(ack, inputIds, protectedInputIds = null) {
    const protectedIds = protectedInputIds instanceof Set
      ? protectedInputIds
      : new Set(Array.isArray(protectedInputIds) ? protectedInputIds : []);
    const records = inputIds
      .map((inputId) => this._desktopWritePending.get(inputId))
      .filter(Boolean);
    if (!records.length) return null;
    if (Number.isInteger(ack?.leaseEpoch)
      && this.activeControlLease
      && ack.leaseEpoch !== this.activeControlLease.leaseEpoch) {
      return { status: 'stale' };
    }

    const status = ack?.status;
    if (status === 'applied' || status === 'duplicate') {
      records.forEach(({ inputId }) => {
        if (!protectedIds.has(inputId)) this._desktopWritePending.delete(inputId);
      });
      const appliedSeq = Number.isSafeInteger(ack?.appliedSeq) ? ack.appliedSeq : null;
      if (appliedSeq !== null) {
        this._desktopWritePending.forEach((record, inputId) => {
          if (record.seq <= appliedSeq && !protectedIds.has(inputId)) {
            this._desktopWritePending.delete(inputId);
          }
        });
      }
      return { status, ...(appliedSeq === null ? {} : { appliedSeq }) };
    }

    const recoverable = status === 'execution-failed' || status === 'sequence-gap';
    const terminal = recoverable || status === 'stale-lease'
      || status === 'invalid-input' || status === 'unsupported-code' || status === 'resync-required';
    if (!terminal) return { status: 'stale' };

    const appliedSeq = Number.isSafeInteger(ack?.appliedSeq) ? ack.appliedSeq : null;
    if (!recoverable || appliedSeq === null || appliedSeq > this._desktopWriteSequence) {
      // Without an authoritative applied sequence, continuing would guess about
      // native state. Require a new lease to reset Host and local ordering.
      this._desktopWritePending.clear();
      this._desktopWriteRecovery = { state: 'reacquire-required', status };
      return { status: 'reacquire-required', failedStatus: status };
    }

    // Host deliberately did not commit the failed write. Rewind only to its
    // reported applied prefix; the failure remains visible to the caller and
    // is never converted into an applied result.
    this._desktopWriteSequence = appliedSeq;
    this._desktopWritePending.forEach((record, inputId) => {
      if (record.seq > appliedSeq && !protectedIds.has(inputId)) {
        this._desktopWritePending.delete(inputId);
      }
    });
    this._desktopWriteRecovery = { state: 'reconciled', status, appliedSeq };
    return { status, recovery: 'reconciled', appliedSeq };
  },

  acceptMouseAck(ack) {
    const inputIds = Array.isArray(ack?.inputIds) ? ack.inputIds : (ack?.inputId ? [ack.inputId] : []);
    const hasInputType = Boolean(ack && Object.prototype.hasOwnProperty.call(ack, 'inputType'));
    const inputType = ack?.inputType;
    if (hasInputType && inputType !== 'mouse' && inputType !== 'command') return { status: 'stale' };
    // The fallback below is intentionally allowed to clear a non-recovery
    // mouse reset only when its actual pending record still belongs to the
    // current lease and connection attempt. A late ACK from an old attempt
    // must not wash away the local safety barrier just because it repeats the
    // same input ID.
    if (this._pendingMouseReset && inputIds.includes(this._pendingMouseResetId)) {
      const pendingReset = this._desktopWritePending.get(this._pendingMouseResetId);
      if (pendingReset && (pendingReset.type !== 'mouse' || pendingReset.action !== 'reset'
        || pendingReset.leaseId !== this.activeControlLease?.leaseId
        || pendingReset.leaseEpoch !== this.activeControlLease?.leaseEpoch
        || pendingReset.connectionAttemptId !== this._currentConnectionAttemptId())) {
        return { status: 'stale' };
      }
      if (!pendingReset && Number.isInteger(ack?.leaseEpoch)
        && ack.leaseEpoch !== this.activeControlLease?.leaseEpoch) return { status: 'stale' };
    }
    const recoveryReset = inputType === 'mouse' && this._recoveryCycle?.state === 'waiting'
      ? this._recoveryCycle.mouseReset : null;
    if (recoveryReset && inputIds.includes(recoveryReset.inputId)
      && ack?.leaseEpoch !== this._recoveryCycle.leaseEpoch) {
      return { status: 'stale' };
    }
    if (recoveryReset && inputIds.includes(recoveryReset.inputId)
      && ack?.status !== 'sequence-gap'
      && !this._isOwnedResetFailureAck(
        ack, recoveryReset, 'mouse', this._recoveryCycle.leaseEpoch,
      )
      && (!Number.isSafeInteger(ack?.appliedSeq) || ack.appliedSeq < recoveryReset.seq)) {
      // A matching reset ID with an older cumulative sequence is not an ACK
      // for this barrier. Reject before the generic ledger can clear it.
      return { status: 'stale' };
    }
    const protectedRecoveryReset = (inputType === 'mouse' || inputType === 'command')
      && this._recoveryCycle?.state === 'waiting'
      && this._sameRecoveryIdentity(this._recoveryCycle)
      ? this._recoveryCycle.mouseReset?.inputId : null;
    const desktopResult = (inputType === 'mouse' || inputType === 'command')
      ? this._acceptDesktopWriteAck(ack, inputIds, protectedRecoveryReset ? [protectedRecoveryReset] : null)
      : null;
    this._handleMobileSurfaceAck(ack);
    let recoverySequenceGapRetried = false;
    if (inputType === 'mouse' && ack?.status === 'sequence-gap') {
      recoverySequenceGapRetried = this._handleRecoverySequenceGap(ack);
    }
    if (inputType === 'mouse' && this._recoveryCycle?.state === 'waiting') {
      const reset = this._recoveryCycle.mouseReset;
      const ownedFailure = this._isOwnedResetFailureAck(
        ack, reset, 'mouse', this._recoveryCycle.leaseEpoch,
      );
      const ownedEnvelope = this._isOwnedResetEnvelope(
        ack, reset, 'mouse', this._recoveryCycle.leaseEpoch,
      ) && ack.appliedSeq >= reset.seq;
      if ((ownedFailure || (ownedEnvelope && !['applied', 'duplicate'].includes(ack.status)))
        && !recoverySequenceGapRetried) {
        this._markRecoveryFailure(`mouse-reset-ack-${String(ack.status || 'rejected')}`);
      } else if (ownedEnvelope && !recoverySequenceGapRetried) {
        this._handleRecoveryAck('mouse', ack, desktopResult);
      }
    }
    if (desktopResult && inputType === 'command') return desktopResult;
    if (desktopResult && desktopResult.status !== 'stale'
      && desktopResult.status !== 'reacquire-required') {
      if (desktopResult.status !== 'applied' && desktopResult.status !== 'duplicate') return desktopResult;
      if (!this._pendingMouseReset) return desktopResult;
    } else if (desktopResult && desktopResult.status === 'reacquire-required') {
      return desktopResult;
    } else if (hasInputType && inputType === 'mouse' && !this._pendingMouseReset) {
      return { status: 'stale' };
    }
    if (desktopResult?.status === 'stale') return desktopResult;
    if (!this._pendingMouseReset) return desktopResult || { status: 'stale' };
    if (!this._pendingMouseResetId || !inputIds.includes(this._pendingMouseResetId)) return { status: 'stale' };
    if (ack?.status !== 'applied' && ack?.status !== 'duplicate') return { status: 'stale' };
    this._pendingMouseReset = false;
    this._pendingMouseResetId = null;
    this._touchAdapters.forEach((adapter) => adapter.rearm?.());
    this._touchAdapters.forEach((adapter) => adapter.flushPending?.());
    if (this._pendingWheel) {
      const wheel = this._pendingWheel;
      this._pendingWheel = null;
      this.queueWheel(wheel);
    }
    return { status: ack.status };
  },

  setupEventListeners() {
    const video = this.videoElement;
    video.setAttribute('tabindex', '0');
    video.style.outline = 'none';
    this.bindMouseEvents(video);
    this.bindTouchAdapter(video);
    const relayImage = document.getElementById('relayImage');
    if (relayImage) {
      relayImage.setAttribute('tabindex', '0');
      relayImage.style.outline = 'none';
      this.bindMouseEvents(relayImage);
      this.bindTouchAdapter(relayImage);
    }
    const isMobileTextEvent = (event) => event?.target === document.getElementById('mobileTextInput');
    const isPhysicalModifierKey = (event) => /^(Control|Shift|Alt|Meta)(Left|Right)$/.test(event?.code || '');
    document.addEventListener('keydown', (event) => {
      if (!isMobileTextEvent(event) && this._isDesktopInputActionAllowed()) {
        if (isPhysicalModifierKey(event)) {
          this.keyboardController?.handleDomEvent(event);
          return;
        }
        this.runMobileEditingAction('context-change', () => (
          this.keyboardController?.handleDomEvent(event) === true
        ));
      }
    });
    document.addEventListener('keyup', (event) => {
      if (!isMobileTextEvent(event)) this.keyboardController?.handleDomEvent(event);
    });
    video.addEventListener('click', (event) => {
      if (!this.focusDesktopSurface(video, 'surface-user')) event.preventDefault?.();
    });
    relayImage?.addEventListener('click', (event) => {
      if (!this.focusDesktopSurface(relayImage, 'surface-user')) event.preventDefault?.();
    });
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
    window.addEventListener('focus', () => {
      // A short focus loss does not necessarily produce a visibilitychange or
      // a media frame. Reconcile a parked/uncertain surface at the focus edge,
      // while _recoveryNeedsReset keeps a healthy ACK-pending blur idempotent.
      this._maybeAutoRecover('window-focus');
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.releasePointer('visibility-hidden');
        const dcOpen = typeof WebRTC !== 'undefined' && WebRTC.inputChannel?.readyState === 'open';
        if (dcOpen) this.resetKeyboard('visibility-hidden');
        else this.parkKeyboard('visibility-hidden');
        return;
      }
      this._maybeAutoRecover('visibility-visible');
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
    if (!display) {
      this.updateMobileTextInputState(this.mobileTextInputAdapter?.getSnapshot());
      return;
    }
    const raw = this.keyboardController?.getSnapshot().state || 'INACTIVE';
    const effectiveGate = this.getEffectiveInputGate();
    // The controller can be READY while a downstream surface, draft, viewport,
    // media, or recovery veto still blocks new input. Do not present that raw
    // transport state as user-visible readiness.
    const displayState = raw === 'READY' && !effectiveGate.allowed ? 'BLOCKED' : raw;
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
    display.textContent = labels[displayState] || `键盘：${displayState}`;
    display.dataset.state = displayState;
    this.updateMobileTextInputButton();
    this.updateMobileTextInputState(this.mobileTextInputAdapter?.getSnapshot());
    this.updateMobileVirtualModifierButtons();
  },

  getEffectiveInputGate() {
    const blockedReasons = [];
    const add = (reason) => {
      if (reason && !blockedReasons.includes(reason)) blockedReasons.push(reason);
    };
    const mobile = this.mobileTextInputAdapter?.getSnapshot?.() || null;
    const controller = this.keyboardController?.getSnapshot?.() || {};
    const transport = this.keyboardTransport?.getSnapshot?.() || {};
    const cycle = this._recoveryCycle || {};

    if (!this.activeControlLease) add('no-active-control');
    if (!this.isActive) add('inactive');
    if (!this._viewportInputSupported) add('viewport-unsupported');

    if (typeof WebRTC !== 'undefined' && typeof WebRTC.getDesktopInputGateSnapshot === 'function') {
      const mediaGate = WebRTC.getDesktopInputGateSnapshot();
      if (!mediaGate?.enabled) {
        const reasons = Array.isArray(mediaGate?.blockedReasons)
          ? mediaGate.blockedReasons : [];
        if (reasons.length) reasons.forEach((reason) => add(String(reason)));
        else add('media-gate');
      }
    }

    const transportState = String(transport.state || '').toLowerCase();
    const controllerState = String(controller.state || '').toLowerCase();
    if (['blocked', 'reacquire-required', 'revoked'].includes(transportState)) {
      add(`keyboard-transport-${transportState}`);
    }
    if (controllerState === 'reset_required' || controllerState === 'reset-required') {
      add('keyboard-reset-pending');
    } else if (controllerState === 'blocked') {
      add('keyboard-blocked');
    }

    if (this._mobileSurfaceState === 'pending') add('surface-pending');
    if (this._mobileSurfaceState === 'uncertain') add('surface-uncertain');
    if (this._pendingMouseReset) add('mouse-reset-pending');
    if (this._desktopWriteRecovery?.state === 'reacquire-required') {
      add('desktop-write-reacquire-required');
    }
    if (mobile?.composing) add('draft-composing');
    if (mobile?.hasPending) add('draft-pending');
    if (mobile?.deliveryUncertain) add('draft-uncertain');
    if (cycle.state === 'waiting') add('recovery-waiting');
    if (cycle.state === 'failed') add('recovery-failed');

    return {
      allowed: blockedReasons.length === 0,
      blockedReasons,
      recovery: this._recoverySnapshot(),
    };
  },

  updateMobileVirtualModifierButtons() {
    const active = new Set(this.keyboardController?.getSnapshot().virtualModifiers || []);
    document.querySelectorAll?.('[data-mobile-modifier]').forEach((button) => {
      button.setAttribute?.('aria-pressed', String(active.has(button.dataset.mobileModifier)));
    });
  },

  supportsMobileTextInput() {
    return Number((typeof navigator !== 'undefined' && navigator.maxTouchPoints) || 0) > 0
      || (typeof window !== 'undefined' && 'ontouchstart' in window);
  },

  updateMobileTextInputButton() {
    const button = document.getElementById('mobileTextInputBtn');
    if (!button) return;
    button.hidden = !this.supportsMobileTextInput();
    button.disabled = !this.isActive;
  },

  setupInputRecoveryUi() {
    if (this._inputRecoveryUiBound) return;
    const notice = document.getElementById('inputRecoveryNotice');
    const retry = document.getElementById('inputRecoveryRetryBtn');
    const draft = document.getElementById('inputRecoveryDraftBtn');
    if (!notice && !retry && !draft) return;
    retry?.addEventListener('pointerdown', (event) => event.preventDefault?.());
    retry?.addEventListener('click', (event) => {
      event.preventDefault?.();
      event.stopPropagation?.();
      this.requestInputRecovery({ source: 'user' });
      this.updateInputRecoveryUI();
    });
    draft?.addEventListener('pointerdown', (event) => event.preventDefault?.());
    draft?.addEventListener('click', (event) => {
      event.preventDefault?.();
      event.stopPropagation?.();
      // This button only opens the local editor for inspection.  It never
      // discards or resends the retained draft and never requests control.
      const dock = document.getElementById('mobileInputDock');
      if (dock) dock.hidden = false;
      document.body?.classList?.add?.('mobile-input-visible');
      this.mobileTextInputAdapter?.show?.();
      this.updateInputRecoveryUI();
    });
    this._inputRecoveryUiBound = true;
  },

  updateInputRecoveryUI() {
    this.setupInputRecoveryUi();
    const notice = document.getElementById('inputRecoveryNotice');
    const noticeText = document.getElementById('inputRecoveryNoticeText');
    const retry = document.getElementById('inputRecoveryRetryBtn');
    const draft = document.getElementById('inputRecoveryDraftBtn');
    const gate = this.getEffectiveInputGate();
    const mobile = this.mobileTextInputAdapter?.getSnapshot?.() || {};
    const recovery = gate.recovery || {};
    const waiting = recovery.state === 'waiting';
    const failed = recovery.state === 'failed';
    const draftBlocked = Boolean(mobile.hasPending || mobile.deliveryUncertain);
    const surfaceBlocked = gate.blockedReasons.includes('surface-uncertain');
    const show = waiting || failed || draftBlocked || surfaceBlocked;
    const message = waiting
      ? '正在安全复位输入，请稍候…'
      : failed
        ? '输入恢复未确认，请点击“重试恢复”，或释放后重新获取控制。'
        : draftBlocked
          ? '本地草稿未自动发送，请打开草稿核对或放弃。'
          : surfaceBlocked
            ? '远程按键状态未确认，请重试恢复。'
            : '';
    if (notice) {
      notice.hidden = !show;
      if (noticeText) noticeText.textContent = message;
      else notice.textContent = message;
      notice.setAttribute?.('aria-busy', String(waiting));
    }
    if (retry) {
      retry.hidden = !(waiting || failed || surfaceBlocked);
      retry.disabled = waiting || (!failed && !surfaceBlocked);
    }
    if (draft) {
      draft.hidden = !draftBlocked;
      draft.disabled = !draftBlocked;
    }
  },

  updateMobileTextInputState(snapshot = null) {
    const state = snapshot || this.mobileTextInputAdapter?.getSnapshot?.();
    const status = document.getElementById('mobileInputStatus');
    const retry = document.getElementById('mobileInputRetryBtn');
    const discard = document.getElementById('mobileInputDiscardBtn');
    const viewportUnsupported = this._viewportInputSupported === false;
    if (!state) {
      if (status) {
        status.hidden = !viewportUnsupported;
        status.textContent = viewportUnsupported ? MOBILE_VIEWPORT_UNSUPPORTED_HINT : '';
      }
      if (retry) retry.hidden = true;
      if (discard) discard.hidden = true;
      this.updateInputRecoveryUI();
      return;
    }
    const labels = {
      pending: '有未发送内容',
      composing: '输入法组合中',
      blocked: '暂不可输入',
      uncertain: '输入位置或连接已变化，请核对远端后放弃本地草稿',
    };
    const hasDraft = Boolean(state.hasPending);
    const hasRecovery = Boolean(state.deliveryUncertain);
    const showStatus = viewportUnsupported || hasDraft || hasRecovery || state.status === 'composing';
    if (status) {
      const labelsForState = labels[state.status] || '';
      const label = [labelsForState, viewportUnsupported ? MOBILE_VIEWPORT_UNSUPPORTED_HINT : '']
        .filter(Boolean).join('；');
      status.hidden = !showStatus || !label;
      status.textContent = label;
    }
    if (retry) {
      retry.hidden = !hasDraft;
      retry.disabled = !state.retryable;
    }
    if (discard) {
      discard.hidden = !(hasDraft || hasRecovery);
      discard.disabled = !(hasDraft || hasRecovery);
    }
    this.updateInputRecoveryUI();
  },

  clearMobileTextInputDock() {
    this._mobileTextReturnFocus = null;
    const dock = document.getElementById('mobileInputDock');
    if (dock) dock.hidden = true;
    document.body?.classList?.remove?.('mobile-input-visible');
    document.getElementById('mobileTextInputBtn')?.setAttribute?.('aria-pressed', 'false');
  },

  focusDesktopSurface(element, reason) {
    if (!['surface-user', 'initial-ready', 'restore'].includes(reason)) return false;
    if (typeof document === 'undefined' || !this.isActive || !element?.isConnected) return false;
    if (reason === 'surface-user' && !this._isDesktopInputActionAllowed()) return false;
    const active = document.activeElement;
    const terminal = document.getElementById('terminalPanel');
    const editing = active?.matches?.('input,textarea,select,[contenteditable="true"]')
      || active?.closest?.('.modal')
      || (terminal && !terminal.hidden && !terminal.classList?.contains?.('hidden'));
    if (reason !== 'surface-user' && editing) return false;
    if (typeof element.focus !== 'function') return false;
    element.focus();
    if (reason === 'restore') this._maybeAutoRecover('surface-restore');
    return document.activeElement === element;
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
    this.updateKeyboardUI();
    if (next) this._maybeAutoRecover('active');
  },

  resetKeyboard(reason) {
    this.lastKeyboardResetReason = reason;
    this._mobileResetPending = true;
    this.clearMobileTextInputDock();
    this.mobileTextInputAdapter?.invalidateContext?.(reason);
    this._resetMobileSurfaceContext({ preserveUncertainty: true });
    this.updateMobileTextInputButton();
    const accepted = Boolean(this.keyboardController?.reset(reason));
    this._mobileResetPending = accepted && Boolean(this._captureKeyboardReset());
    if (!accepted) {
      this._mobileResetPending = false;
      this.mobileTextInputAdapter?.onTransportState('reacquire-required');
    }
    return accepted;
  },

  parkKeyboard(reason) {
    this.lastKeyboardResetReason = reason;
    this.clearMobileTextInputDock();
    this.mobileTextInputAdapter?.invalidateContext?.(reason);
    this._resetMobileSurfaceContext({ preserveUncertainty: true });
    this.updateMobileTextInputButton();
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
    const rawGate = (typeof WebRTC !== 'undefined' && typeof WebRTC.getDesktopInputGateSnapshot === 'function')
      ? WebRTC.getDesktopInputGateSnapshot()
      : null;
    const gate = rawGate ? {
      enabled: rawGate.enabled === true,
      hasActiveControl: rawGate.hasActiveControl === true,
      manualDisconnect: rawGate.manualDisconnect === true,
      mediaState: rawGate.mediaState || null,
      runtimePhase: rawGate.runtimePhase || null,
      inputIsActive: rawGate.inputIsActive == null ? null : rawGate.inputIsActive === true,
      blockedReasons: Array.isArray(rawGate.blockedReasons)
        ? rawGate.blockedReasons.slice(0, 16).map((reason) => String(reason)).filter(Boolean)
        : [],
    } : null;
    const mobile = this.mobileTextInputAdapter?.getSnapshot?.() || {};
    return {
      keyboardMode: controller.mode || this.keyboardMode || null,
      isActive: this.isActive,
      hasLease: Boolean(this.activeControlLease),
      leaseEpoch: this.activeControlLease?.leaseEpoch || 0,
      gate,
      effectiveGate: this.getEffectiveInputGate(),
      surface: {
        state: this._mobileSurfaceState,
        generation: Number(this._mobileSurfaceGeneration) || 0,
      },
      draft: {
        composing: mobile.composing === true,
        hasPending: mobile.hasPending === true,
        deliveryUncertain: mobile.deliveryUncertain === true,
        status: typeof mobile.status === 'string' ? mobile.status : 'idle',
      },
      viewport: { inputSupported: this._viewportInputSupported !== false },
      recovery: this._recoverySnapshot(),
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
      desktopWriteRecovery: this._desktopWriteRecovery
        ? { ...this._desktopWriteRecovery }
        : null,
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
    const isAcceptedGestureMove = type === 'mouse' && action === 'move'
      && this._isAcceptedMobileSurfaceMove(payload);
    if (!this._viewportInputSupported && !isMouseSafetyRelease && !isAcceptedGestureMove) return null;
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
    const reliableWrite = type !== 'mouse' || action !== 'move';
    if (reliableWrite && this._desktopWriteRecovery?.state === 'reacquire-required') return null;
    const nextSequence = reliableWrite ? this._desktopWriteSequence + 1 : null;
    if (reliableWrite) data.seq = nextSequence;
    const commitSequence = () => {
      if (!reliableWrite) return;
      this._desktopWriteSequence = nextSequence;
      this._desktopWritePending.set(data.inputIds[0], {
        inputId: data.inputIds[0],
        seq: nextSequence,
        type,
        action,
        leaseId: data.leaseId,
        leaseEpoch: data.leaseEpoch,
        connectionAttemptId: this._currentConnectionAttemptId(),
      });
    };
    if (typeof WebRTC !== 'undefined' && WebRTC.sendInput?.(data)) {
      commitSequence();
      this.recordLatency(data);
      return data.inputIds[0];
    }
    const socket = (typeof WebRTC !== 'undefined' && WebRTC.socket) || this.socket;
    if (socket?.connected) {
      socket.emit('input', data);
      commitSequence();
      this.recordLatency(data);
      return data.inputIds[0];
    }
    return null;
  },

  queueMouseMove(coords, surface = null) {
    const sourceSurface = surface || this._activePointerElement || this.videoElement;
    this._pendingMouseMove = {
      payload: { ...coords },
      surface: sourceSurface,
      signature: this.getSurfaceGeometrySignature(sourceSurface),
      generation: this._pointerLifecycleGeneration,
    };
    if (this._mouseMoveScheduled) return;
    this._mouseMoveScheduled = true;
    requestAnimationFrame(() => {
      this._mouseMoveScheduled = false;
      const pending = this._pendingMouseMove;
      this._pendingMouseMove = null;
      if (!pending) return;
      if (pending.generation !== this._pointerLifecycleGeneration) return;
      if (!this.validateQueuedMouseMoveGeometry(pending)) return;
      if (this._pendingMouseReset) return;
      // buttons===0 while we still track a local press: local desync — force reset.
      if (Number(pending.payload.buttons) === 0 && this._pressedMouseButtons.size > 0) {
        this.releasePointer('move-buttons-clear');
        return;
      }
      if (this.isActive) this.sendInput('mouse', 'move', pending.payload);
    });
  },

  getRelativeCoords(event, allowOutside = false) {
    const element = event.currentTarget || this.videoElement;
    const rect = this.refreshGeometry(element);
    const result = InputGeometry.mapClientPoint({ clientX: event.clientX, clientY: event.clientY, rect,
      sourceWidth: element.videoWidth || element.naturalWidth || rect.width, sourceHeight: element.videoHeight || element.naturalHeight || rect.height,
      objectFit: getComputedStyle(element).objectFit || 'contain' });
    return result.inside || allowOutside ? { relX: result.relX, relY: result.relY } : null;
  },

  getSurfaceGeometrySignature(surface, rect = null) {
    const box = rect || surface?.getBoundingClientRect?.();
    if (!surface || !box) return null;
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(surface) : (surface.style || {});
    const numberOr = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
    return {
      left: numberOr(box.left),
      top: numberOr(box.top),
      width: numberOr(box.width),
      height: numberOr(box.height),
      sourceWidth: numberOr(surface.videoWidth || surface.naturalWidth || box.width),
      sourceHeight: numberOr(surface.videoHeight || surface.naturalHeight || box.height),
      objectFit: String(style.objectFit || 'contain'),
      scale: String(style.scale || surface.style?.scale || 'none'),
    };
  },

  surfaceGeometryEqual(left, right) {
    if (!left || !right) return false;
    return ['left', 'top', 'width', 'height', 'sourceWidth', 'sourceHeight', 'objectFit', 'scale']
      .every((key) => left[key] === right[key]);
  },

  hasActiveSurfaceGesture(surface) {
    if (this._activePointerElement === surface) return true;
    const adapter = this._touchAdapters.get(surface);
    const snapshot = adapter?.getSnapshot?.();
    return Boolean(snapshot?.pointerCount || snapshot?.primaryActive || snapshot?.activeButton || snapshot?.wheelPending);
  },

  validateQueuedMouseMoveGeometry(pending) {
    const surface = pending?.surface;
    if (!surface?.getBoundingClientRect) return true;
    const rect = surface.getBoundingClientRect();
    const signature = this.getSurfaceGeometrySignature(surface, rect);
    if (this.surfaceGeometryEqual(pending.signature, signature)) return true;
    const remember = { element: surface, rect, signature };
    this._surfaceGeometryByElement.set(surface, remember);
    this._lastSurfaceGeometry = remember;
    if (this.hasActiveSurfaceGesture(surface)) {
      this._geometryAbortedPointerId = this._activePointerId;
      this.releasePointer('geometry-changed');
    } else {
      this._pointerLifecycleGeneration += 1;
    }
    return false;
  },

  validateGeometry(element = null) {
    const surface = element || this._lastSurfaceGeometry?.element || this.videoElement;
    if (!surface?.getBoundingClientRect) return true;
    const rect = surface.getBoundingClientRect();
    const signature = this.getSurfaceGeometrySignature(surface, rect);
    const previous = this._surfaceGeometryByElement.get(surface)
      || (this._lastSurfaceGeometry?.element === surface ? this._lastSurfaceGeometry : null);
    const remember = { element: surface, rect, signature };
    if (!previous || previous.element !== surface || !this.hasActiveSurfaceGesture(surface)
      || this.surfaceGeometryEqual(previous.signature, signature)) {
      this._surfaceGeometryByElement.set(surface, remember);
      this._lastSurfaceGeometry = remember;
      return true;
    }
    // Save the new baseline before releasing so the next pointerdown can use
    // the current geometry without being rejected a second time.
    this._surfaceGeometryByElement.set(surface, remember);
    this._lastSurfaceGeometry = remember;
    this._geometryAbortedPointerId = this._activePointerId;
    this.releasePointer('geometry-changed');
    return false;
  },

  refreshGeometry(element = null) {
    const surface = element || this.videoElement;
    if (!surface?.getBoundingClientRect) return null;
    const rect = surface.getBoundingClientRect();
    const signature = this.getSurfaceGeometrySignature(surface, rect);
    const previous = this._surfaceGeometryByElement.get(surface)
      || (this._lastSurfaceGeometry?.element === surface ? this._lastSurfaceGeometry : null);
    const changedDuringGesture = previous?.element === surface
      && this.hasActiveSurfaceGesture(surface)
      && !this.surfaceGeometryEqual(previous.signature, signature);
    const remember = { element: surface, rect, signature };
    this._surfaceGeometryByElement.set(surface, remember);
    this._lastSurfaceGeometry = remember;
    if (changedDuringGesture) {
      this._geometryAbortedPointerId = this._activePointerId;
      this.releasePointer('geometry-changed');
    }
    return rect;
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
    this._pointerLifecycleGeneration += 1;
    const wasPendingReset = this._pendingMouseReset;
    const wasSurfacePending = this._mobileSurfaceState === 'pending';
    let adapterResetIssued = false;
    this._touchAdapters.forEach((adapter) => { if (adapter.reset?.(reason)) adapterResetIssued = true; });
    const element = this._activePointerElement; const pointerId = this._activePointerId;
    if (element?.hasPointerCapture?.(pointerId)) element.releasePointerCapture(pointerId);
    const needsReset = this._pressedMouseButtons.size > 0 || this._pendingMouseReset;
    this._pressedMouseButtons.clear(); this._activePointerId = null; this._activePointerElement = null; this._pendingMouseMove = null;
    if (wasSurfacePending) this._markMobileSurfaceUncertain(reason);
    if (!needsReset || wasPendingReset || adapterResetIssued || this._pendingMouseReset) return null;
    const inputId = this._sendMobileSurfaceReset({ reason });
    this._pendingMouseReset = true;
    this._pendingMouseResetId = inputId || null;
    return inputId;
  },

  bindTouchAdapter(element) {
    if (!element || typeof TouchInputAdapter === 'undefined' || this._touchAdapters.has(element)) {
      return this._touchAdapters.get(element) || null;
    }
    let adapter;
    adapter = TouchInputAdapter.create({
      element,
      mapPoint: (event, allowOutside) => {
        const point = this.getRelativeCoords({
          currentTarget: element,
          clientX: event.clientX,
          clientY: event.clientY,
          pointerId: event.pointerId,
          timeStamp: event.timeStamp,
          button: event.button,
          buttons: event.buttons,
          pointerType: event.pointerType,
        }, allowOutside);
        if (point) this._lastTouchAdapter = adapter;
        return point;
      },
      sendMouse: (action, payload) => {
        const id = action === 'up'
          ? this._sendMobileSurfaceUp(payload)
          : action === 'reset'
            ? this._sendMobileSurfaceReset(payload)
            : this.sendInput('mouse', action, payload);
        if (action === 'reset') {
          this._pendingMouseReset = true;
          this._pendingMouseResetId = id || null;
        }
        return id;
      },
      isEnabled: () => this.isActive && !this._pendingMouseReset,
      getClickCount: (event) => this.getPointerClickCount(event),
      beforeGesture: () => this._isMobileEditingActionAllowed(),
      commitGesture: (send) => {
        let inputId = null;
        const accepted = this.runMobileEditingAction('context-change', () => {
          const result = send();
          inputId = result;
          return Boolean(result);
        });
        if (!accepted || !this._beginMobileSurfaceGesture(inputId)) return false;
        return true;
      },
      validateGeometry: () => this.validateGeometry(element),
    });
    adapter.bind();
    this._touchAdapters.set(element, adapter);
    return adapter;
  },

  bindMouseEvents(element) {
    element.addEventListener('pointermove', (event) => {
      if (event.pointerType === 'touch') return;
      if (!this.isActive && this._pressedMouseButtons.size === 0) return;
      if (!this.validateGeometry(element)) return;
      const pointerGeneration = this._pointerLifecycleGeneration;
      const coords = this.getRelativeCoords(event, this._activePointerId === event.pointerId);
      if (coords && pointerGeneration === this._pointerLifecycleGeneration) {
        this._lastPointerCoords = coords;
        this.queueMouseMove({
          ...coords,
          // Host uses buttons===0 on move to clear a stuck pressed button when the
          // matching up was lost (DC drop / gate flip mid-gesture).
          buttons: Number.isFinite(Number(event.buttons)) ? Number(event.buttons) : 0,
        }, element);
      }
    });
    element.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'touch') return;
      if (!this._isDesktopInputActionAllowed()) {
        event.preventDefault?.();
        return;
      }
      if (!this.isActive || this._pendingMouseReset) {
        event.preventDefault?.();
        return;
      }
      this._pointerLifecycleGeneration += 1;
      this._geometryAbortedPointerId = null;
      event.preventDefault();
      if (!this._isDesktopInputActionAllowed()) return;
      this.focusDesktopSurface(element, 'surface-user');
      if (!this.validateGeometry(element)) return;
      const coords = this.getRelativeCoords(event); if (!coords) return;
      element.setPointerCapture?.(event.pointerId);
      const button = this.getMouseButton(event.button); const clickCount = this.getPointerClickCount(event);
      if (!this._sendMobileSurfaceDown({ ...coords, button, clickCount, buttons: Number(event.buttons) || 0 })) return;
      this._activePointerId = event.pointerId; this._activePointerElement = element; this._pressedMouseButtons.add(button); this._lastPointerCoords = coords; this._activePointerClickCount = clickCount;
    });
    element.addEventListener('pointerup', (event) => {
      if (event.pointerType === 'touch') return;
      if (this._geometryAbortedPointerId === event.pointerId) {
        this._geometryAbortedPointerId = null;
        return;
      }
      if (!this.isActive && this._pressedMouseButtons.size === 0) return;
      if (!this.validateGeometry(element)) return;
      event.preventDefault(); const coords = this.getRelativeCoords(event, true) || this._lastPointerCoords; const button = this.getMouseButton(event.button);
      // up/reset bypass isActive so a mid-gesture gate flip cannot leave Host dragging.
      const id = coords
        ? this._sendMobileSurfaceUp({
          ...coords,
          button,
          clickCount: this._activePointerClickCount,
          buttons: Number.isFinite(Number(event.buttons)) ? Number(event.buttons) : 0,
        })
        : null;
      this._pressedMouseButtons.delete(button);
      if (!id) {
        this._pendingMouseReset = true;
        const resetId = this._sendMobileSurfaceReset({ reason: 'pointer-up-failed' });
        this._pendingMouseResetId = resetId || null;
      }
      if (this._pressedMouseButtons.size === 0) { if (element.hasPointerCapture?.(event.pointerId)) element.releasePointerCapture(event.pointerId); this._activePointerId = null; this._activePointerElement = null; }
      this._pointerLifecycleGeneration += 1;
    });
    element.addEventListener('pointercancel', (event) => {
      if (event.pointerType === 'touch') return;
      this.releasePointer('pointer-cancel');
    });
    element.addEventListener('lostpointercapture', (event) => {
      if (event.pointerType === 'touch') return;
      if (this._pressedMouseButtons.size > 0 || this._pendingMouseReset) {
        this.releasePointer('lost-pointer-capture');
      }
    });
    element.addEventListener('wheel', (event) => {
      if (event.pointerType === 'touch' || event.sourceCapabilities?.firesTouchEvents) return;
      if (!this.isActive) return;
      event.preventDefault();
      if (!this.validateGeometry(element)) return;
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
      if (!wheel || !this.isActive || this._pendingMouseReset) {
        if (wheel && this._pendingMouseReset) this._pendingWheel = wheel;
        return;
      }
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
      escape: { code: 'Escape' }, tab: { code: 'Tab' }, backspace: { code: 'Backspace' }, enter: { code: 'Enter' },
      up: { code: 'ArrowUp' }, down: { code: 'ArrowDown' }, left: { code: 'ArrowLeft' }, right: { code: 'ArrowRight' },
      copy: { code: 'KeyC', modifiers: { meta: true } }, paste: { code: 'KeyV', modifiers: { meta: true } }, cut: { code: 'KeyX', modifiers: { meta: true } },
      undo: { code: 'KeyZ', modifiers: { meta: true } }, selectAll: { code: 'KeyA', modifiers: { meta: true } }, save: { code: 'KeyS', modifiers: { meta: true } },
      find: { code: 'KeyF', modifiers: { meta: true } }, screenshot: { code: 'KeyA', modifiers: { meta: true, shift: true } }, switchInputMethod: { code: 'Space', modifiers: { ctrl: true } },
    };
    const virtualModifiers = new Set(['shift', 'ctrl', 'alt', 'meta']);
    document.querySelectorAll('.action-btn, [data-mobile-action]').forEach((button) => {
      if (this._mobileActionButtonListeners.has(button)) return;
      this._mobileActionButtonListeners.add(button);
      button.addEventListener('pointerdown', (event) => {
        const snapshot = this.mobileTextInputAdapter?.getSnapshot?.();
        if (snapshot?.shown) event.preventDefault?.();
      });
      button.addEventListener('click', (event) => {
        event.preventDefault();
        const action = button.dataset.action || button.dataset.mobileAction;
        if (virtualModifiers.has(action)) {
          const modifierName = action === 'control' ? 'ctrl' : action === 'command' ? 'meta' : action;
          const activeModifiers = this.keyboardController?.getSnapshot?.().virtualModifiers || [];
          const pressed = activeModifiers.includes(modifierName);
          if (!pressed && (button.disabled || !this.isActive || !this._isMobileEditingActionAllowed())) return;
          if (this.keyboardController?.setVirtualModifier(modifierName, !pressed)) {
            button.setAttribute?.('aria-pressed', String(!pressed));
          }
          return;
        }
        if (button.disabled) return;
        if (action === 'rightClick') {
          const adapter = this._lastTouchAdapter
            || this._touchAdapters.get(this.videoElement)
            || this._touchAdapters.get(document.getElementById('relayImage'));
          adapter?.clickButton('right');
          return;
        }
        if (action === 'showDock') { this.sendInput('command', 'showDock', {}); return; }
        const chord = actions[action];
        if (!chord) return;
        const physical = {
          shiftKey: Boolean(event.shiftKey),
          ctrlKey: Boolean(event.ctrlKey),
          altKey: Boolean(event.altKey),
          metaKey: Boolean(event.metaKey),
        };
        const modifiers = {
          shift: Boolean(chord.modifiers?.shift || physical.shiftKey),
          ctrl: Boolean(chord.modifiers?.ctrl || physical.ctrlKey),
          alt: Boolean(chord.modifiers?.alt || physical.altKey),
          meta: Boolean(chord.modifiers?.meta || physical.metaKey),
        };
        const navigation = new Set(['Backspace', 'Enter', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
        if (this.mobileTextInputAdapter && navigation.has(chord.code)) {
          this.mobileTextInputAdapter.sendControlKey(chord.code, physical);
          this.updateMobileTextInputState(this.mobileTextInputAdapter.getSnapshot());
          return;
        }
        this.runMobileEditingAction('context-change', () => this.keyboardController?.sendChord({
          code: chord.code,
          modifiers,
        }) === true);
        this.updateMobileTextInputState(this.mobileTextInputAdapter?.getSnapshot());
      });
    });
  },

  setupTextInput() {
    this.setupInputRecoveryUi();
    const modal = document.getElementById('textInputModal');
    const button = document.getElementById('textInputBtn');
    const input = document.getElementById('remoteTextInput');
    const submit = document.getElementById('textInputSubmitBtn');
    const cancel = document.getElementById('textInputCancelBtn');
    const mobileButton = document.getElementById('mobileTextInputBtn');
    const mobileDock = document.getElementById('mobileInputDock');
    const mobileInput = document.getElementById('mobileTextInput');
    const mobileRetryButton = document.getElementById('mobileInputRetryBtn');
    const mobileDiscardButton = document.getElementById('mobileInputDiscardBtn');
    let returnFocus = null;
    const isVisibleFocusable = (target) => {
      if (!target || target.isConnected === false || target.hidden || target.disabled) return false;
      for (let node = target; node; node = node.parentElement || node.parentNode) {
        const style = node.style || {};
        const ariaHidden = node.getAttribute?.('aria-hidden') === 'true';
        const inert = node.inert === true || node.hasAttribute?.('inert');
        if (node.hidden || node.disabled || node.classList?.contains?.('hidden') || ariaHidden || inert
          || style.display === 'none' || style.visibility === 'hidden') {
          return false;
        }
      }
      return typeof target.focus === 'function';
    };
    const isTextModalFlowFocus = (target) => target === modal || target === input
      || target === submit || target === cancel
      || Boolean(modal?.contains?.(target))
      || target?.closest?.('.modal') === modal;
    const isMobileFlowFocus = (target) => target === mobileInput || target === mobileButton
      || Boolean(mobileDock?.contains?.(target));
    const restoreReturnFocus = (target, wasInFlow) => {
      if (!wasInFlow || !isVisibleFocusable(target)) return false;
      target.focus();
      return document.activeElement === target;
    };
    const restoreMobileReturnFocus = (wasInMobileFlow = isMobileFlowFocus(document.activeElement)) => {
      const target = this._mobileTextReturnFocus;
      this._mobileTextReturnFocus = null;
      return restoreReturnFocus(target, wasInMobileFlow);
    };
    const close = () => {
      const wasInTextModalFlow = isTextModalFlowFocus(document.activeElement);
      modal?.classList?.add('hidden');
      if (modal) modal.hidden = true;
      if (input) input.value = '';
      const target = returnFocus;
      returnFocus = null;
      restoreReturnFocus(target, wasInTextModalFlow);
    };
    const commit = () => {
      const text = Array.from(input?.value || '').slice(0, 4096).join('');
      if (!text) return false;
      const accepted = this.runMobileEditingAction('context-change', () => (
        this.keyboardController?.sendText(text) === true
      ));
      if (accepted) close();
      return accepted;
    };
    if (!this._mobileTextInputModalBound) {
      button?.addEventListener('pointerdown', (event) => event.preventDefault?.());
      submit?.addEventListener('pointerdown', (event) => event.preventDefault?.());
      cancel?.addEventListener('pointerdown', (event) => event.preventDefault?.());
      button?.addEventListener('click', (event) => {
        event.preventDefault();
        if (!this._isMobileEditingActionAllowed()) return;
        returnFocus = document.activeElement || button;
        modal?.classList?.remove('hidden');
        if (modal) modal.hidden = false;
        input?.focus();
      });
      submit?.addEventListener('click', (event) => { event.preventDefault(); commit(); });
      cancel?.addEventListener('click', (event) => { event.preventDefault(); close(); });
      input?.addEventListener('compositionend', () => commit());
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && modal && !modal.classList.contains('hidden')) {
          event.preventDefault();
          close();
        }
      }, true);
      this._mobileTextInputModalBound = true;
    }

    if (!this.mobileTextInputAdapter && mobileInput && typeof MobileTextInput !== 'undefined') {
      this.mobileTextInputAdapter = MobileTextInput.create({
        element: mobileInput,
        sendText: (text) => this.keyboardController?.sendText(text),
        sendKey: (key, modifiers = {}) => this.keyboardController?.sendChord({
          code: key,
          modifiers: {
            shift: Boolean(modifiers.shiftKey),
            ctrl: Boolean(modifiers.ctrlKey),
            alt: Boolean(modifiers.altKey),
            meta: Boolean(modifiers.metaKey),
          },
        }),
        hasVirtualModifiers: () => (this.keyboardController?.getSnapshot()?.virtualModifiers || []).length > 0,
        releaseTrackedKey: (event) => this.keyboardController?.handleDomEvent(event) === true,
        isEnabled: () => this._viewportInputSupported
          && this.isActive && this.keyboardController?.getSnapshot().state === 'READY',
        isDeliverySettled: () => {
          const snapshot = this.keyboardTransport?.getSnapshot?.() || {};
          return snapshot.state === 'ready' && snapshot.pendingCount === 0;
        },
        isSurfaceSettled: () => this._mobileSurfaceState === 'settled',
        onStateChange: (snapshot) => this.updateMobileTextInputState(snapshot),
        refreshViewport: () => {
          if (typeof ChromeLayout !== 'undefined') ChromeLayout.recalculate?.();
        },
      });
      this.mobileTextInputAdapter.attach();
      this._syncMobileTextTransport();
    }
    if (!this._mobileTextInputUiBound) {
      mobileRetryButton?.addEventListener('pointerdown', (event) => event.preventDefault?.());
      mobileDiscardButton?.addEventListener('pointerdown', (event) => event.preventDefault?.());
      mobileRetryButton?.addEventListener('click', (event) => {
        event.preventDefault();
        this.mobileTextInputAdapter?.retryPending();
        this.updateMobileTextInputState(this.mobileTextInputAdapter?.getSnapshot());
      });
      mobileDiscardButton?.addEventListener('click', (event) => {
        event.preventDefault();
        this._resetMobileSurfaceContext();
        this.mobileTextInputAdapter?.discardPending();
        this.updateMobileTextInputState(this.mobileTextInputAdapter?.getSnapshot());
      });
      this._mobileTextInputUiBound = true;
    }
    if (mobileButton && !this._mobileTextInputToggleBound) {
      mobileButton.addEventListener('click', (event) => {
        event.preventDefault();
        if (!this.isActive) return;
        if (this.mobileTextInputAdapter?.getSnapshot().shown) {
          if (mobileDock) mobileDock.hidden = true;
          document.body?.classList?.remove?.('mobile-input-visible');
          mobileButton.setAttribute?.('aria-pressed', 'false');
          const wasInMobileFlow = isMobileFlowFocus(document.activeElement);
          this.mobileTextInputAdapter.hide();
          restoreMobileReturnFocus(wasInMobileFlow);
          return;
        }
        const active = document.activeElement;
        this._mobileTextReturnFocus = active === mobileButton ? this.videoElement : active;
        if (mobileDock) mobileDock.hidden = false;
        document.body?.classList?.add?.('mobile-input-visible');
        mobileButton.setAttribute?.('aria-pressed', 'true');
        this.mobileTextInputAdapter?.show();
      });
      this._mobileTextInputToggleBound = true;
    }
    this.updateMobileTextInputButton();
    this.updateMobileTextInputState(this.mobileTextInputAdapter?.getSnapshot());
  },
};

document.addEventListener('DOMContentLoaded', () => {
  const video = document.getElementById('remoteVideo');
  if (!video) return;
  Input.videoElement = video;
  Input.init();
});
