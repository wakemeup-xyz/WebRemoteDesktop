const MEDIA_RESUME_FRAME_TIMEOUT_MS = {
  tunnel: 2500,
  relay: 12000,
  auto: 8000,
  stun: 8000,
  lan: 6000,
  default: 8000,
};

const PAINT_ISSUE_COPY = {
  'media-pending-3s': {
    text: '链路已通，正在等待第一帧。',
    severity: 'warning',
  },
  'media-pending-8s': {
    text: '第一帧仍未到达，请点击「刷新画面」。',
    severity: 'warning',
  },
  'media-stalled': {
    text: '外网中继正在追帧，画面可能短暂发黑。若反复出现，请改用 720p 或手动切换「隧道中继」。',
    severity: 'warning',
  },
  'explicit-1080': {
    text: '外网中继上 1080p 容易卡顿，建议改回 720p 或改用隧道中继。',
    severity: 'warning',
  },
  'media-stalled-6s': {
    text: '当前中继出画不稳定，请手动切换「隧道中继」。',
    severity: 'danger',
  },
};

const WebRTC = {
  pc: null,
  socket: null,
  controlState: { state: 'FREE', controller: false, lease: null, hostOnline: false },
  _controlHeartbeatTimer: null,
  _controlRequestId: 0,
  _controlLifecycleBound: false,
  remoteStream: null,
  statsTimer: null,
  _statsSampler: null,
  _statsPc: null,
  _videoFrameCallbackId: null,
  _videoFrameElement: null,
  offerInProgress: false,
  _offerEpoch: 0,
  videoTransceiver: null,
  reconnectTimer: null,
  manualDisconnect: false,
  _superseded: false,
  _refreshing: false,
  _refreshReason: null,
  inputChannel: null,
  inputMoveChannel: null,
  serverConfig: null,
  networkMode: localStorage.getItem('wrdNetworkMode') || 'auto',
  selectedTurnServerId: localStorage.getItem('wrdTurnServerId') || '',
  recommendationState: null,
  useRelayFallback: false,
  tunnelRelayActive: false,
  tunnelFrameCount: 0,
  tunnelStartedAt: 0,
  tunnelLastObjectUrl: '',
  tunnelPendingObjectUrl: '',
  tunnelLastFrameId: 0,
  currentResolution: (() => {
    // Prefer panel default (720p checked) over hard-coded 540p so connection-sync
    // does not start from the wrong presentation contract.
    try {
      if (typeof document !== 'undefined') {
        const selected = document.querySelector('input[name="resolution"]:checked');
        const width = parseInt(selected?.dataset?.width, 10);
        const height = parseInt(selected?.dataset?.height, 10);
        if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
          return { width, height, label: `${width}x${height}` };
        }
      }
    } catch (_err) { /* non-DOM test env */ }
    return { width: 1280, height: 720, label: '1280x720' };
  })(),
  _explicitOverride1080: false,
  linkQualityController: null,
  mediaActivityController: null,
  mediaActivityLifecycle: null,
  mediaActivityRuntime: null,
  _mediaResumeFramePending: false,
  _mediaResumeBaseline: null,
  _mediaResumeFrameTimer: null,
  _mediaResumeArmPending: false,
  _mediaResumeSoftRecoverUsed: false,
  _mediaIntent: null,
  _mediaRequestRetryUsed: false,
  _mediaResumeRefreshFallbackUsed: false,
  _mediaFailureHandledKey: null,
  _mediaReadyConnectionAttemptId: null,
  _lastInboundFramesDecoded: 0,
  _lastInboundFramesDecodedAt: 0,
  _videoFrameSeq: 0,
  uiPhase: 'signaling',
  hasPaintedFrame: false,
  _paintDecodedBaseline: 0,
  _stallSince: null,
  _paintPending3sTimer: null,
  _paintPending8sTimer: null,
  _paintStalled3sTimer: null,
  _paintStalled6sTimer: null,
  _paintIssueKind: null,
  _lastPaintStats: null,
  _keyframeRequested: false,
  _keyframeEmitted: false,
  _hostCaptureFps: 0,
  adaptiveMediaEnabled: true,
  // When false, adaptive path may still change fps/bitrate, but never width/height.
  // Default OFF so user-chosen resolution is stable (esp. on high-RTT TURN).
  adaptiveResolutionEnabled: localStorage.getItem('wrdAdaptiveResolution') === '1',
  noMediaTicks: 0,
  lastCandidateType: '',
  _autoFailCount: 0,
  _iceRestartAttempts: 0,
  _reconnectAttempt: 0,
  _relayHardRefreshCount: 0,
  _rebuildingDc: false,
  _noRelayReceiveCount: 0,
  _inputDcDegraded: false,
  _tunnelLockUntil: 0,
  _lastRefreshAt: 0,
  _dcKeepaliveTimer: null,
  currentConnectionAttemptId: '',
  connectionAttemptSequence: 0,
  selectedCandidatePair: null,
  candidateSummary: {
    local: { host: 0, srflx: 0, relay: 0, prflx: 0, other: 0 },
    remote: { host: 0, srflx: 0, relay: 0, prflx: 0, other: 0 },
    samples: { local: [], remote: [] }
  },
  portSearchController: null,
  _portSearchGeneration: 0,
  _portSearchRoundTimer: null,
  _portSearchRetryTimer: null,
  _portSearchRefreshOwned: false,
  PORT_SEARCH_ROUND_MS: 10000,
  PORT_SEARCH_RETRY_DELAY_MS: 250,

  config: {
    iceServers: []
  },

  networkModes: {
    lan: {
      label: '本地直连',
      shortLabel: '本地',
      state: '最低延迟',
      hint: '访问电脑和这台 Mac 在同一局域网时使用。失败时切换到自动穿透或外网中继。'
    },
    auto: {
      label: '自动穿透',
      shortLabel: '自动',
      state: '推荐',
      hint: '默认模式。优先低延迟直连；失败时只提示手动切换外网中继或隧道中继，不会自动改写你选中的模式。'
    },
    stun: {
      label: '外网直连',
      shortLabel: '直连',
      state: '看网络',
      hint: '适合外网但 UDP 未被限制的环境。失败时会尝试 ICE 恢复，并提示你手动切换到更稳的模式。'
    },
    relay: {
      label: '外网中继',
      shortLabel: '中继',
      state: '最稳',
      hint: '适合公司网、校园网、跨运营商、蜂窝热点或 ICE 失败场景。强制走 TURN，延迟通常明显高于直连。本机或同网访问请优先用本地直连/自动穿透。需要服务端配置 TURN；若 TURN 不可用，只会提示手动改用隧道中继。'
    },
    tunnel: {
      label: '隧道中继',
      shortLabel: '隧道',
      state: '兜底',
      hint: '最终兜底模式。视频经 Cloudflare/Socket.IO 转发 JPEG，默认从 540p 起推，FPS 较低但不依赖 UDP。本机访问请优先用本地直连/自动穿透。'
    }
  },

  // Network advisor auto-collapse (right-edge tab).
  _networkAdvisorBound: false,
  _networkAdvisorCollapseTimer: null,
  _networkAdvisorHover: false,
  _networkAdvisorPinned: false,
  _networkAdvisorSeverity: '',
  NETWORK_ADVISOR_COLLAPSE_MS: {
    '': 4500,
    warning: 8000,
    danger: 14000,
  },
  // After the pointer leaves the card, dock quickly — do not reuse the long idle timer.
  NETWORK_ADVISOR_LEAVE_COLLAPSE_MS: 280,
  _networkAdvisorLastSignature: '',
  // Remote-desktop users alt-tab constantly. The original 750ms page-hidden delay
  // suspended capture ~2s after connect and left Host at FPS=0 while ICE stayed up
  // ("can't connect"). Keep intentional suspend, but require a sustained hide.
  PAGE_HIDDEN_SUSPEND_DELAY_MS: 300000,

  initializeMediaActivity() {
    if (this.mediaActivityController) {
      return this.mediaActivityController.snapshot();
    }

    if (typeof MediaActivityController === 'undefined') {
      return { state: 'active', reasons: [], generation: 0 };
    }

    this.mediaActivityController = MediaActivityController.create({
      onChange: (snapshot) => this.applyMediaActivity(snapshot),
    });
    if (typeof MediaActivityLifecycle !== 'undefined') {
      this.mediaActivityLifecycle = MediaActivityLifecycle.create({
        setReason: (reason, enabled) => this.setMediaActivityReason(reason, enabled),
        hiddenDelayMs: this.PAGE_HIDDEN_SUSPEND_DELAY_MS,
      });
      this.mediaActivityLifecycle.start();
    }
    if (typeof MediaActivityRuntime !== 'undefined' && !this.mediaActivityRuntime) {
      this.mediaActivityRuntime = MediaActivityRuntime.create({
        requestTimeoutMs: this.networkMode === 'tunnel' ? 2500 : this.networkMode === 'relay' ? 4000 : 1500,
        onPhaseChange: (_runtimeSnapshot, meta) => {
          if (meta?.reason === 'request-timeout') {
            this.handleMediaRequestFailure('request-timeout');
          }
        },
      });
    }
    return this.mediaActivityController.snapshot();
  },

  /**
   * If the page is actually visible, drop transient hide reasons and re-assert
   * active media. Used after PC connect / control grant / visibility restore so
   * a brief alt-tab or a stuck suspend cannot leave a black but "connected" session.
   */
  ensureMediaActiveIfVisible(reason = 'visible-ensure') {
    if (typeof document !== 'undefined' && document.hidden) {
      return false;
    }
    this.initializeMediaActivity();
    let changed = false;
    if (this.mediaActivityController?.hasReason?.('page-hidden')) {
      this.setMediaActivityReason('page-hidden', false);
      changed = true;
    }
    if (this.mediaActivityController?.hasReason?.('page-hide')) {
      this.setMediaActivityReason('page-hide', false);
      changed = true;
    }
    const snap = this.getMediaActivitySnapshot();
    if (snap.state === 'active') {
      const phase = this.getMediaAppliedPhase();
      // Always re-assert after clearing a hide reason, or when runtime is not yet active.
      if (changed || phase !== 'active' || this._mediaIntent?.state !== 'active') {
        this.replayMediaActivityIntent(reason);
      }
    }
    this.syncDesktopInputGate();
    return changed || snap.state === 'active';
  },

  setMediaActivityReason(reason, enabled) {
    this.initializeMediaActivity();
    if (!this.mediaActivityController) {
      return this.getMediaActivitySnapshot();
    }
    return this.mediaActivityController.setReason(reason, enabled);
  },

  getMediaActivitySnapshot() {
    this.initializeMediaActivity();
    return this.mediaActivityController
      ? this.mediaActivityController.snapshot()
      : { state: 'active', reasons: [], generation: 0 };
  },

  getMediaAppliedPhase() {
    return this.mediaActivityRuntime?.phase || 'active';
  },

  isMediaHealthSuppressed() {
    return Boolean(this.mediaActivityRuntime?.isHealthSuppressed?.());
  },

  canEnableDesktopInput() {
    return this.hasActiveControl()
      && !this.manualDisconnect
      && Boolean(this.mediaActivityRuntime?.canEnableDesktopInput?.() ?? true)
      && this.getMediaActivitySnapshot().state === 'active'
      && (!this.currentConnectionAttemptId
        || this._mediaReadyConnectionAttemptId === this.currentConnectionAttemptId);
  },

  getDesktopInputGateSnapshot() {
    const mediaSnap = this.getMediaActivitySnapshot();
    const runtimePhase = this.mediaActivityRuntime?.phase || null;
    const reasons = [];
    if (!this.hasActiveControl()) reasons.push('no-active-control');
    if (this.manualDisconnect) reasons.push('manual-disconnect');
    if (!(this.mediaActivityRuntime?.canEnableDesktopInput?.() ?? true)) {
      reasons.push(`runtime-phase:${runtimePhase || 'unknown'}`);
    }
    if (mediaSnap?.state !== 'active') reasons.push(`media-state:${mediaSnap?.state || 'unknown'}`);
    if (this.currentConnectionAttemptId
      && this._mediaReadyConnectionAttemptId !== this.currentConnectionAttemptId) {
      reasons.push('media-not-ready-for-attempt');
    }
    return {
      enabled: this.canEnableDesktopInput(),
      hasActiveControl: this.hasActiveControl(),
      manualDisconnect: Boolean(this.manualDisconnect),
      mediaState: mediaSnap?.state || null,
      runtimePhase,
      currentConnectionAttemptId: this.currentConnectionAttemptId || null,
      mediaReadyConnectionAttemptId: this._mediaReadyConnectionAttemptId || null,
      inputIsActive: (typeof Input !== 'undefined') ? Boolean(Input.isActive) : null,
      blockedReasons: reasons,
    };
  },

  applyMediaActivity(snapshot = this.getMediaActivitySnapshot()) {
    this.initializeMediaActivity();
    if (!this.mediaActivityRuntime && typeof MediaActivityRuntime !== 'undefined') {
      this.mediaActivityRuntime = MediaActivityRuntime.create({
        requestTimeoutMs: this.networkMode === 'tunnel' ? 2500 : this.networkMode === 'relay' ? 4000 : 1500,
        onPhaseChange: (_runtimeSnapshot, meta) => {
          if (meta?.reason === 'request-timeout') {
            this.handleMediaRequestFailure('request-timeout');
          }
        },
      });
    }
    const desired = snapshot?.state === 'suspended' ? 'suspended' : 'active';
    const generation = Number(snapshot?.generation) || 0;
    if (generation < 1) return snapshot;
    if (this._mediaIntent?.generation !== generation) {
      this._mediaRequestRetryUsed = false;
      this._mediaResumeRefreshFallbackUsed = false;
      this._mediaResumeSoftRecoverUsed = false;
    }
    this._mediaIntent = {
      state: desired,
      reasons: Array.isArray(snapshot?.reasons) ? snapshot.reasons.slice(0, 8) : [],
      generation,
    };

    // Immediate local gates on suspend.
    if (desired === 'suspended') {
      if (typeof Input !== 'undefined') {
        // Keep lease; only release pointer + keys. Do not open a keyboard reset
        // barrier that blocks typing after a brief hide/resume cycle.
        Input.setActive(false, { resetKeyboard: false, reason: 'media-suspended' });
        Input.resetKeyboard?.('media-suspended');
      }
      if (this.isPortSearchActive()) this.stopPortSearch('media-suspended');
      this.noMediaTicks = 0;
      this._mediaResumeFramePending = false;
      this._mediaResumeBaseline = null;
      this._mediaResumeArmPending = false;
      this.clearMediaResumeFallback();
    }

    const runtime = this.mediaActivityRuntime;
    if (runtime) {
      runtime.beginDesired(desired, {
        generation,
        connectionAttemptId: this.currentConnectionAttemptId || null,
      });
    }

    // Capture resume baseline before the request so post-ack unlock needs a
    // frame after this moment (decoded delta or video frame callback).
    if (desired === 'active') {
      this.captureMediaResumeBaseline(generation);
    }

    this.sendMediaActivityRequest(desired, this._mediaIntent);
    this.syncDesktopInputGate();
    return snapshot;
  },

  replayMediaActivityIntent(_reason = 'replay') {
    const snapshot = this._mediaIntent;
    if (!snapshot || !Number.isSafeInteger(snapshot.generation) || snapshot.generation < 1) return false;
    if (!this.activeLeaseEnvelope() || !this.socket?.connected) return false;

    const runtime = this.mediaActivityRuntime;
    if (runtime) {
      runtime.beginDesired(snapshot.state, {
        generation: snapshot.generation,
        connectionAttemptId: this.currentConnectionAttemptId || null,
      });
    }
    if (snapshot.state === 'active') {
      this.captureMediaResumeBaseline(snapshot.generation);
    }
    const sent = this.sendMediaActivityRequest(snapshot.state, snapshot);
    this.syncDesktopInputGate();
    return sent;
  },

  clearMediaResumeFallback() {
    if (this._mediaResumeFrameTimer) {
      clearTimeout(this._mediaResumeFrameTimer);
      this._mediaResumeFrameTimer = null;
    }
  },

  isWebRtcMediaPathConnected() {
    const pc = this.pc;
    if (!pc) return false;
    return pc.connectionState === 'connected'
      || pc.iceConnectionState === 'connected'
      || pc.iceConnectionState === 'completed';
  },

  mediaResumeTimeoutMs() {
    if (this.networkMode === 'tunnel' || this.tunnelRelayActive) {
      return MEDIA_RESUME_FRAME_TIMEOUT_MS.tunnel;
    }
    return MEDIA_RESUME_FRAME_TIMEOUT_MS[this.networkMode]
      || MEDIA_RESUME_FRAME_TIMEOUT_MS.default;
  },

  ensureMediaResumeFallbackArmed(reason = 'ack') {
    if (this.getMediaAppliedPhase() !== 'resuming' || this._mediaIntent?.state !== 'active') {
      this._mediaResumeArmPending = false;
      return false;
    }
    if (this.networkMode === 'tunnel' || this.tunnelRelayActive) {
      this._mediaResumeArmPending = false;
      this.armMediaResumeFallback();
      return true;
    }
    if (this.isWebRtcMediaPathConnected()) {
      this._mediaResumeArmPending = false;
      this.armMediaResumeFallback();
      return true;
    }
    this._mediaResumeArmPending = true;
    return false;
  },

  recoverTunnelMediaOnCurrentAttempt(reason = 'tunnel-soft-recover') {
    // Tunnel media recovery must not invent a new connectionAttemptId. A full
    // refresh() rebinds attempt authority and would orphan the in-flight Host
    // ack / generation that armMediaResumeFallback was waiting for.
    if (this.networkMode !== 'tunnel' && !this.tunnelRelayActive) return false;
    if (!this.activeLeaseEnvelope() || !this.socket?.connected) return false;
    if (this.manualDisconnect) return false;
    this.clearMediaResumeFallback();
    if (this._mediaIntent?.state === 'active') {
      this.captureMediaResumeBaseline(this._mediaIntent.generation);
    }
    if (!this.tunnelRelayActive && this.getMediaActivitySnapshot().state === 'active') {
      this.startTunnelRelay();
    }
    return this.replayMediaActivityIntent(reason);
  },

  armMediaResumeFallback() {
    this.clearMediaResumeFallback();
    if (this._mediaResumeRefreshFallbackUsed || this._mediaIntent?.state !== 'active') return;
    if (this.getMediaAppliedPhase() !== 'resuming') return;
    const timeoutMs = this.mediaResumeTimeoutMs();
    this._mediaResumeFrameTimer = setTimeout(() => {
      this._mediaResumeFrameTimer = null;
      this.onMediaResumeFrameTimeout();
    }, timeoutMs);
  },

  onMediaResumeFrameTimeout() {
    if (this.getMediaAppliedPhase() !== 'resuming' || this._mediaResumeRefreshFallbackUsed) return;
    if (this.networkMode === 'tunnel' || this.tunnelRelayActive) {
      this._mediaResumeRefreshFallbackUsed = true;
      this.recoverTunnelMediaOnCurrentAttempt('fresh-frame-timeout');
      return;
    }
    if (!this._mediaResumeSoftRecoverUsed) {
      this._mediaResumeSoftRecoverUsed = true;
      try {
        if (this.pc && typeof this.pc.restartIce === 'function' && this.isWebRtcMediaPathConnected()) {
          this.pc.restartIce();
        }
      } catch (err) {
        console.warn('[MEDIA] fresh-frame soft restartIce failed:', err?.message || err);
      }
      this.replayMediaActivityIntent('fresh-frame-soft');
      // Spec: re-arm while still resuming so the hard path can fire next.
      if (this.getMediaAppliedPhase() === 'resuming') {
        this._mediaResumeArmPending = false;
        this.armMediaResumeFallback();
      }
      return;
    }
    this._mediaResumeRefreshFallbackUsed = true;
    this.refresh({ reason: 'fresh-frame-timeout' });
  },

  handleMediaRequestFailure(reason = 'media-request-failed') {
    this.syncDesktopInputGate();
    const snapshot = this._mediaIntent;
    if (!snapshot || this.manualDisconnect) return false;
    if (!this.activeLeaseEnvelope() || !this.socket?.connected) return false;

    // Cancel any armed fresh-frame timer before retry/refresh so a stale timer
    // cannot fire a second refresh after this failure path.
    this._mediaResumeArmPending = false;
    this.clearMediaResumeFallback();

    if (snapshot.state === 'active' && reason === 'request-timeout') {
      if (this._mediaResumeRefreshFallbackUsed) return false;
      this._mediaResumeRefreshFallbackUsed = true;
      if (this.networkMode === 'tunnel' || this.tunnelRelayActive) {
        return this.recoverTunnelMediaOnCurrentAttempt(reason);
      }
      this.refresh({ reason: 'media-request-failed' });
      return true;
    }
    if (!this._mediaRequestRetryUsed) {
      this._mediaRequestRetryUsed = true;
      // Late WebRTC offers can leave Host on a stale attempt after tunnel switch.
      // Re-assert the current attempt before the single bounded replay.
      if (reason === 'wrong-attempt' || reason === 'applied-false') {
        this.bindCurrentConnectionAttempt();
      }
      if (
        (reason === 'wrong-attempt' || reason === 'applied-false')
        && (this.networkMode === 'tunnel' || this.tunnelRelayActive)
      ) {
        return this.recoverTunnelMediaOnCurrentAttempt(reason);
      }
      return this.replayMediaActivityIntent(reason);
    }
    // A closed PC cannot be recovered by refresh(); only one bounded replay.
    if (reason === 'closed') {
      return false;
    }
    if (snapshot.state === 'active' && !this._mediaResumeRefreshFallbackUsed) {
      this._mediaResumeRefreshFallbackUsed = true;
      if (this.networkMode === 'tunnel' || this.tunnelRelayActive) {
        return this.recoverTunnelMediaOnCurrentAttempt(reason);
      }
      this.refresh({ reason: 'media-request-failed' });
      return true;
    }
    return false;
  },

  captureMediaResumeBaseline(generation) {
    this._mediaResumeBaseline = {
      connectionAttemptId: this.currentConnectionAttemptId || null,
      generation: Number(generation) || 0,
      framesDecoded: Number(this._lastInboundFramesDecoded) || 0,
      videoFrameSeq: Number(this._videoFrameSeq) || 0,
      pc: this.pc || null,
    };
  },

  sendMediaActivityRequest(desired, snapshot) {
    const lease = this.activeLeaseEnvelope();
    if (!lease || !this.socket?.connected) return false;
    if (!this.currentConnectionAttemptId) {
      this.currentConnectionAttemptId = `wrd-${Date.now()}`;
    }
    const payload = {
      schemaVersion: 1,
      state: desired,
      reasons: Array.isArray(snapshot?.reasons) ? snapshot.reasons.slice(0, 8) : [],
      generation: Number(snapshot?.generation) || 1,
      connectionAttemptId: this.currentConnectionAttemptId,
      leaseId: lease.leaseId,
      leaseEpoch: lease.leaseEpoch,
    };

    // networkMode selects one adapter: WebRTC contract or tunnel relay control.
    if (this.networkMode === 'tunnel' || this.tunnelRelayActive) {
      // Re-assert attempt authority before media control so a late WebRTC offer
      // cannot leave Host on a stale attempt across the first suspend/resume.
      this.bindCurrentConnectionAttempt();
      // Keep main's resuming gate, but wait for Host applied ack (never synthetic).
      return this.emitRelayStreamControl({
        enabled: desired === 'active',
        // A resume request must restart the host stream before a fresh frame can
        // advance the runtime from resuming to active. Ordinary tunnel starts do
        // not get this exception.
        allowResuming: desired === 'active',
        mediaControl: {
          schemaVersion: 2,
          mediaControlSchemaVersion: 1,
          state: desired,
          generation: payload.generation,
          connectionAttemptId: payload.connectionAttemptId,
        },
      });
    }

    this.socket.emit('media-activity-change', payload);
    return true;
  },

  handleMediaActivityAck(data = {}) {
    if (!this.mediaActivityRuntime) return;
    const result = this.mediaActivityRuntime.applyAck({
      state: data.state,
      generation: data.generation,
      connectionAttemptId: data.connectionAttemptId,
      applied: data.applied === true,
      keyframeRequested: data.keyframeRequested === true,
    });
    if (data.applied !== true) {
      // Do not spend the current intent's recovery budget on a late ack.
      if (result.reason !== 'not-applied') return;
      const failureKey = [
        'applied-false',
        data.connectionAttemptId || this.currentConnectionAttemptId || '',
        Number.isSafeInteger(data.generation) ? data.generation : '',
        data.state || '',
      ].join('|');
      // Signal dual-routes tunnel Host acks on relay-stream-control-ack and
      // media-activity-ack. Apply the failure path only once per generation.
      if (this._mediaFailureHandledKey === failureKey) return;
      this._mediaFailureHandledKey = failureKey;
      this.handleMediaRequestFailure(data.reason === 'closed' ? 'closed' : 'applied-false');
      return;
    }
    if (!result.accepted) return;
    this._mediaFailureHandledKey = null;
    if (result.phase === 'resuming') {
      this._mediaResumeFramePending = true;
      if (!this._mediaResumeBaseline) {
        this.captureMediaResumeBaseline(data.generation);
      }
      this.ensureMediaResumeFallbackArmed('media-ack');
      // A tunnel relay frame may finish rendering just before its Host ACK reaches
      // this socket. Consume that post-baseline frame after the matching ACK rather
      // than waiting indefinitely for a visually identical JPEG to load again.
      const renderedRelayFrame = this._lastRenderedRelayFrame;
      if (renderedRelayFrame) {
        this.observeFreshResumeFrame({
          source: 'relay-frame',
          frameSeq: renderedRelayFrame.frameSeq,
          connectionAttemptId: renderedRelayFrame.connectionAttemptId,
        });
      }
    }
    if (result.phase === 'suspended') {
      this._mediaResumeFramePending = false;
      this._mediaResumeBaseline = null;
      this._mediaResumeArmPending = false;
      this.clearMediaResumeFallback();
    }
    this.syncDesktopInputGate();
  },

  observeFreshResumeFrame({
    source = 'unknown',
    framesDecoded = null,
    frameSeq = null,
    connectionAttemptId = null,
    pc = null,
  } = {}) {
    if (!this._mediaResumeFramePending || !this.mediaActivityRuntime) return false;
    if (this.getMediaAppliedPhase() !== 'resuming') return false;
    if (!this.hasActiveControl()) return false;

    const baseline = this._mediaResumeBaseline;
    if (!baseline) return false;

    const attemptId = connectionAttemptId || this.currentConnectionAttemptId || null;
    if (baseline.connectionAttemptId && attemptId && attemptId !== baseline.connectionAttemptId) {
      return false;
    }
    if (baseline.pc && pc && baseline.pc !== pc) {
      return false;
    }
    if (baseline.pc && this.pc && baseline.pc !== this.pc && !pc) {
      return false;
    }

    let isFresh = false;
    if (source === 'stats' || framesDecoded != null) {
      const decoded = Number(framesDecoded);
      if (Number.isFinite(decoded) && decoded > Number(baseline.framesDecoded || 0)) {
        isFresh = true;
      }
    }
    if (source === 'video-callback' || frameSeq != null) {
      const seq = Number(frameSeq);
      if (Number.isFinite(seq) && seq > Number(baseline.videoFrameSeq || 0)) {
        isFresh = true;
      }
    }
    if (!isFresh) return false;

    const result = this.mediaActivityRuntime.noteRenderedFrame({
      connectionAttemptId: attemptId,
      afterResume: true,
    });
    if (!result.accepted) return false;
    this.markMediaAttemptReady(attemptId);
    this._mediaResumeFramePending = false;
    this._mediaResumeBaseline = null;
    this._mediaResumeArmPending = false;
    this.clearMediaResumeFallback();
    this.noMediaTicks = 0;
    this.syncDesktopInputGate();
    return true;
  },

  noteMediaRenderedFrame(meta = {}) {
    // Prefer explicit source metadata. Bare calls (tests/legacy) still require
    // a post-baseline video-callback sequence when a baseline exists.
    if (meta && (meta.source || meta.frameSeq != null || meta.framesDecoded != null)) {
      if (meta.source === 'video-callback' || meta.source === 'relay-frame') {
        this.markMediaAttemptReady(meta.connectionAttemptId || this.currentConnectionAttemptId || null);
      }
      return this.observeFreshResumeFrame(meta);
    }
    this._videoFrameSeq = (Number(this._videoFrameSeq) || 0) + 1;
    this.markMediaAttemptReady(this.currentConnectionAttemptId || null);
    return this.observeFreshResumeFrame({
      source: 'video-callback',
      frameSeq: this._videoFrameSeq,
      connectionAttemptId: this.currentConnectionAttemptId || null,
      pc: this.pc || null,
    });
  },

  markMediaAttemptReady(attemptId = this.currentConnectionAttemptId || null) {
    // Media readiness is independent of control ownership. Frames that arrive
    // while the viewer is readonly still prove this attempt has painted; a later
    // control-grant can enable input without waiting for another frame — critical
    // on full-relay paths that regularly sit at 0 FPS for multi-second gaps.
    if (!attemptId || attemptId !== this.currentConnectionAttemptId) return false;
    this._mediaReadyConnectionAttemptId = attemptId;
    this.clearFirstFrameDeadline();
    if (this.hasPaintedFrame && this.uiPhase !== 'disconnected') {
      this.setUiPhase('connected', { reason: 'media-ready' });
    }
    this.syncDesktopInputGate();
    if (typeof StartupTelemetry !== 'undefined' && StartupTelemetry?.mark) {
      const names = new Set(
        (StartupTelemetry.snapshot?.().marks || []).map((mark) => mark.name),
      );
      if (!names.has('first-frame')) StartupTelemetry.mark('first-frame');
      if (!names.has('active')) StartupTelemetry.mark('active');
    }
    return true;
  },

  syncDesktopInputGate() {
    if (typeof Input === 'undefined') return;
    const enable = this.canEnableDesktopInput();
    Input.setActive(enable);
  },

  hasTurnConfigured() {
    return this.getTurnServers().length > 0;
  },

  getPublicEntryUrl() {
    return String(
      this.serverConfig?.publicEntry?.formalEntryUrl
      || this.serverConfig?.publicEntryUrl
      || window.location.origin
      || ''
    ).trim();
  },

  createConnectionAttemptId() {
    return `wrd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  },

  beginConnectionAttempt(trigger = 'viewer-open') {
    this.connectionAttemptSequence = (Number(this.connectionAttemptSequence) || 0) + 1;
    this.currentConnectionAttemptId = this.createConnectionAttemptId();
    this._mediaReadyConnectionAttemptId = null;
    this._mediaFailureHandledKey = null;
    this._mediaRequestRetryUsed = false;
    this._mediaResumeSoftRecoverUsed = false;
    this._mediaResumeArmPending = false;
    this.clearMediaResumeFallback();
    this.hasPaintedFrame = false;
    this._paintDecodedBaseline = Number(this._lastInboundFramesDecoded) || 0;
    this._stallSince = null;
    this.clearPaintIssueTimers();
    this.setUiPhase('signaling', { reason: trigger });

    const inheritHardRefresh = trigger === 'refresh' && this._refreshReason === 'fresh-frame-timeout';
    if (inheritHardRefresh) {
      this._mediaResumeRefreshFallbackUsed = true;
    } else {
      this._mediaResumeRefreshFallbackUsed = false;
    }

    if (trigger === 'viewer-open' || trigger === 'manual-mode-switch') {
      this._explicitOverride1080 = false;
      this._reconnectAttempt = 0;
      this._relayHardRefreshCount = 0;
      this._mediaResumeSoftRecoverUsed = false;
      this._mediaResumeRefreshFallbackUsed = false;
      this._inputDcDegraded = false;
    }

    if (typeof ConnectionTrace !== 'undefined' && typeof ConnectionTrace.start === 'function') {
      ConnectionTrace.start({
        trigger,
        mode: this.networkMode,
        entrypoint: this.getPublicEntryUrl(),
        connectionAttemptId: this.currentConnectionAttemptId,
      });
    }
    this.bindCurrentConnectionAttempt();
    this.syncDesktopInputGate();
    return this.currentConnectionAttemptId;
  },

  clearFailureRecommendation() {
    this.recommendationState = null;
  },

  setFailureRecommendation(failureCode, severity = 'warning') {
    const nextSuggestedMode = {
      'direct-failed-suggest-relay': 'relay',
      'direct-failed-suggest-tunnel': 'tunnel',
      'relay-unavailable-no-turn': 'tunnel',
      'relay-failed-suggest-tunnel': 'tunnel',
    }[failureCode] || null;

    this.recommendationState = {
      failureCode,
      nextSuggestedMode,
      severity,
    };
    return this.recommendationState;
  },

  getRecommendationMessage() {
    const recommendation = this.recommendationState;
    const label = recommendation?.nextSuggestedMode
      ? (this.networkModes[recommendation.nextSuggestedMode]?.label || recommendation.nextSuggestedMode)
      : '';

    switch (recommendation?.failureCode) {
      case 'direct-failed-suggest-relay':
        return `当前保持“${this.networkModes[this.networkMode]?.label || this.networkMode}”；建议下一步手动切换到“${label}”。`;
      case 'direct-failed-suggest-tunnel':
        return `当前保持“${this.networkModes[this.networkMode]?.label || this.networkMode}”；若固定入口可打开但媒体仍失败，建议手动切换到“${label}”。`;
      case 'relay-unavailable-no-turn':
        return `当前选择的是“${this.networkModes.relay.label}”，但 TURN 不可用，所以该模式暂时不可用。建议手动切换到“${label}”。`;
      case 'relay-failed-suggest-tunnel':
        return `外网中继未能建立稳定媒体链路。建议手动切换到“${label}”。`;
      default:
        return '';
    }
  },

  getDefaultNetworkGuidance() {
    if (this.networkMode === 'relay' && !this.hasTurnConfigured()) {
      return this.serverConfig?.turnStatus === 'misconfigured'
        ? 'TURN 配置不完整，当前无法建立真实外网中继。'
        : '当前未配置 TURN，外网中继暂时不可用。';
    }
    if (this.networkMode === 'relay' && !this.isPublicOrigin()) {
      return '当前页面在本机打开。外网中继会强制走 TURN，RTT 通常到数百毫秒且更容易卡顿/黑屏；同机访问请优先用“本地直连”或“自动穿透”。';
    }
    if (this.networkMode === 'tunnel' && !this.isPublicOrigin()) {
      return '当前页面在本机打开。隧道中继是禁 UDP 外网的 Socket.IO 兜底；同机访问请优先用“本地直连”或“自动穿透”。';
    }
    if (this.networkMode === 'auto' && !this.hasTurnConfigured()) {
      return '当前为 STUN-only 自动模式。系统会保持你的选择不变；若直连失败，请按建议手动改用“隧道中继”。';
    }
    return '';
  },

  buildTurnStatusText() {
    const entry = this.getPublicEntryUrl();
    const prefix = entry ? `固定入口：${entry}` : '固定入口：未提供';
    const source = this.serverConfig?.turnSource || 'none';
    const selectedId = this.selectedTurnServerId
      || this.serverConfig?.selectedTurnServerId
      || '';
    const selectedMeta = (this.serverConfig?.turnServers || [])
      .find((server) => server.id === selectedId);
    const nodeLabel = selectedMeta?.label || selectedMeta?.remark || selectedId || '-';
    const fp = (typeof TurnSelfTest !== 'undefined' && TurnSelfTest.shortFingerprint)
      ? TurnSelfTest.shortFingerprint(this.serverConfig?.turnFingerprint)
      : String(this.serverConfig?.turnFingerprint || '').slice(0, 12);
    const hostReady = this.serverConfig?.hostTurnReady;
    const hostFp = (typeof TurnSelfTest !== 'undefined' && TurnSelfTest.shortFingerprint)
      ? TurnSelfTest.shortFingerprint(this.serverConfig?.hostTurnFingerprint)
      : String(this.serverConfig?.hostTurnFingerprint || '').slice(0, 12);
    const hostTurnServerId = this.serverConfig?.hostTurnServerId || '';
    const hostPart = hostReady
      ? `Host ready · 节点 ${hostTurnServerId || '-'} · fp ${hostFp || '-'}`
      : (this.serverConfig?.hostTurnFingerprint
        ? `Host fp ${hostFp}`
        : 'Host TURN 未上报');

    if (this.serverConfig?.turnConfigured) {
      const urls = (this.serverConfig.turnUrls || []).join(', ');
      return `${prefix}。TURN 已配置 · 节点 ${nodeLabel}${selectedId ? `(${selectedId})` : ''}（source=${source}${fp ? ` · fp ${fp}` : ''}）：${urls || '已启用'}。${hostPart}。失败时请手动切换外网中继，不会自动改写模式。`;
    }
    if (this.serverConfig?.turnStatus === 'misconfigured') {
      return `${prefix}。TURN 配置不完整（source=${source}），当前无法使用外网中继；页面只会给出建议，不会自动改写你选中的模式。`;
    }
    return `${prefix}。TURN 未配置，当前无法使用外网中继；页面只会给出建议，不会自动改写你选中的模式。`;
  },

  async runTurnSelfTest({ skipAllocate = false } = {}) {
    const resultEl = document.getElementById('networkTurnTestResult');
    const setResult = (text, severity = '') => {
      if (!resultEl) return;
      resultEl.textContent = text;
      resultEl.dataset.severity = severity || '';
    };

    if (typeof TurnSelfTest === 'undefined' || typeof TurnSelfTest.run !== 'function') {
      setResult('TURN 自检模块未加载。', 'danger');
      return null;
    }

    setResult('正在刷新配置并测试 TURN…');
    await this.loadServerConfig({ turnServerId: this.selectedTurnServerId });
    this.updateNetworkUI('', '');

    const apiBase = (typeof RuntimeConfig !== 'undefined')
      ? RuntimeConfig.getApiBase()
      : '';
    const token = (typeof Auth !== 'undefined' && Auth.getToken)
      ? Auth.getToken()
      : '';
    const summary = await TurnSelfTest.run({
      iceServers: this.serverConfig?.iceServers || [],
      turnConfigured: Boolean(this.serverConfig?.turnConfigured),
      turnMisconfigured: Boolean(this.serverConfig?.turnMisconfigured),
      turnFingerprint: this.serverConfig?.turnFingerprint || '',
      hostTurnReady: this.serverConfig?.hostTurnReady,
      hostTurnFingerprint: this.serverConfig?.hostTurnFingerprint || '',
      turnServerId: this.selectedTurnServerId || this.serverConfig?.selectedTurnServerId || '',
      skipAllocate,
      includeServerProbe: true,
      serverProbeOptions: {
        apiBase,
        token,
        timeoutMs: 10000,
        turnServerId: this.selectedTurnServerId || this.serverConfig?.selectedTurnServerId || '',
      },
      timeoutMs: 8000,
    });
    this.lastTurnSelfTest = summary;

    const lines = (summary.steps || []).map((step) => {
      const mark = step.ok ? 'PASS' : 'FAIL';
      return `${mark} ${step.step}: ${step.code}${step.detail ? ` — ${step.detail}` : ''}`;
    });
    lines.push(summary.message);
    setResult(lines.join('\n'), summary.ok ? 'ok' : 'danger');
    return summary;
  },

  enterUnavailableRelayState(message) {
    this.markRefreshSettled('unavailable-relay');
    this.offerInProgress = false;
    this._offerEpoch += 1;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this._dcTimeout) {
      clearTimeout(this._dcTimeout);
      this._dcTimeout = null;
    }
    if (this._disconnectedTimer) {
      clearTimeout(this._disconnectedTimer);
      this._disconnectedTimer = null;
    }
    if (this._iceDisconnectedTimer) {
      clearTimeout(this._iceDisconnectedTimer);
      this._iceDisconnectedTimer = null;
    }
    if (this._dcReconnectTimer) {
      clearTimeout(this._dcReconnectTimer);
      this._dcReconnectTimer = null;
    }
    this.stopMediaTelemetry();
    if (this._latencySyncInterval) {
      clearInterval(this._latencySyncInterval);
      this._latencySyncInterval = null;
    }
    this.stopTunnelRelay();
    if (this.pc) {
      this.pc.oniceconnectionstatechange = null;
      this.pc.onconnectionstatechange = null;
      this.pc.onsignalingstatechange = null;
      this.pc.onicegatheringstatechange = null;
      this.pc.onicecandidate = null;
      this.pc.ontrack = null;
      this.pc.close();
      this.pc = null;
    }
    this.remoteStream = null;
    this.selectedCandidatePair = null;
    this.resetCandidateSummary();
    this.lastCandidateType = '';
    this.noMediaTicks = 0;
    this._noRelayReceiveCount = 0;
    this._iceRestartAttempts = 0;
    this.inputChannel = null;
    this.inputMoveChannel = null;
    if (typeof Input !== 'undefined') {
      Input.setActive(false);
    }
    const videoElement = document.getElementById('remoteVideo');
    if (videoElement) {
      videoElement.srcObject = null;
      videoElement.classList.remove('connected');
    }
    document.body.classList.remove('stream-connected');
    const candidateEl = document.getElementById('candidateDisplay');
    if (candidateEl) {
      candidateEl.textContent = '-';
    }
    const latencyEl = document.getElementById('latencyDisplay');
    if (latencyEl) {
      latencyEl.textContent = '- ms';
    }
    const fpsEl = document.getElementById('fpsDisplay');
    if (fpsEl) {
      fpsEl.textContent = '- FPS';
    }
    const resolutionEl = document.getElementById('resolutionDisplay');
    if (resolutionEl) {
      resolutionEl.textContent = '-';
    }
    document.getElementById('loading')?.classList.remove('hidden');
    document.getElementById('loading')?.classList.remove('is-connecting');
    this.setUiPhase('disconnected', { reason: 'relay-unavailable' });
    updateLoadingText('TURN 未配置，外网中继不可用。请手动切换到其他网络模式。');
    this.updateNetworkUI(
      message || '外网中继当前不可用，请手动切换到“隧道中继”或其他可用模式。',
      'warning'
    );
  },

  linkQualityPathForMode(mode = this.networkMode) {
    return mode === 'relay' ? 'relay' : 'direct';
  },

  ensureLinkQualityController() {
    const qualityLock = this.adaptiveResolutionEnabled !== true;
    if (!this.linkQualityController && typeof LinkQualityController !== 'undefined') {
      this.linkQualityController = LinkQualityController.create({
        path: this.linkQualityPathForMode(),
        qualityLock,
      });
    } else if (this.linkQualityController && typeof this.linkQualityController.setQualityLock === 'function') {
      this.linkQualityController.setQualityLock(qualityLock);
    } else if (this.linkQualityController) {
      this.linkQualityController.qualityLock = qualityLock;
    }
    return this.linkQualityController;
  },

  /**
   * Keep adaptive path (direct vs TURN relay) aligned with networkMode.
   * Relay uses lower start bitrate and ignores structural 300–600ms RTT as critical.
   */
  syncLinkQualityPath({ applyProfile = false, reason = 'path-sync' } = {}) {
    const controller = this.ensureLinkQualityController();
    if (!controller) return null;
    const path = this.linkQualityPathForMode();
    const changed = typeof controller.setPath === 'function'
      ? controller.setPath(path, { resetProfile: true })
      : { changed: false, path, profile: controller.currentProfile };
    if (applyProfile && (changed?.changed || reason === 'connection-sync')) {
      const profileName = controller.currentProfile;
      const profile = typeof LinkQualityController !== 'undefined'
        ? LinkQualityController.profiles?.[profileName]
        : null;
      if (profile) {
        this.applyMediaProfile(profile, reason);
      }
    }
    return changed;
  },

  getUserPreference() {
    const cur = this.currentResolution || { width: 1280, height: 720 };
    return (typeof PresentationBudget !== 'undefined'
      ? PresentationBudget.nearestPresentationRung(cur.width, cur.height)
      : { width: 1280, height: 720, label: '1280x720' });
  },

  getSessionPresentation() {
    const pref = this.getUserPreference();
    // Tunnel JPEG keeps its own size path and must not use the WebRTC cap contract.
    if (this.networkMode === 'tunnel') {
      return {
        ...pref,
        capped: false,
        pathCap: pref,
        userPreference: pref,
        explicitOverride1080: this._explicitOverride1080 === true,
      };
    }
    const budget = typeof PresentationBudget !== 'undefined'
      ? PresentationBudget.computeSessionPresentation({
        userPreference: pref,
        networkMode: this.networkMode,
        lastCandidateType: this.lastCandidateType,
        explicitOverride1080: this._explicitOverride1080 === true,
      })
      : {
        width: 1280,
        height: 720,
        label: '1280x720',
        capped: false,
        pathCap: { width: 1280, height: 720 },
        userPreference: pref,
        explicitOverride1080: false,
      };
    return budget;
  },

  shouldHideLoading({ hasPaintedFrame } = {}) {
    return hasPaintedFrame === true;
  },

  hidePaintLoading() {
    const el = document.getElementById('loading');
    if (el) {
      el.classList.add('hidden');
      el.classList.remove('is-connecting');
    }
    document.body.classList.add('stream-connected');
    const videoEl = document.getElementById('remoteVideo');
    if (videoEl) videoEl.classList.add('connected');
    this.hideReconnectHud();
  },

  setUiPhase(phase, { reason } = {}) {
    const allowed = ['signaling', 'media-pending', 'connected', 'media-stalled', 'disconnected'];
    if (!allowed.includes(phase)) return this.uiPhase;
    if (this.uiPhase === 'disconnected' && phase !== 'signaling' && phase !== 'disconnected') {
      return this.uiPhase;
    }
    const previous = this.uiPhase;
    this.uiPhase = phase;
    if (phase === 'signaling') {
      updateConnectionStatus('connecting');
    } else {
      updateConnectionStatus(phase);
    }
    if (phase === 'connected' && this.shouldHideLoading({ hasPaintedFrame: this.hasPaintedFrame })) {
      this.hidePaintLoading();
    }
    if (this.hasPaintedFrame
      || phase === 'connected'
      || (phase === 'media-pending' && this.isPeerMediaConnected())) {
      this.clearFirstFrameDeadline();
    }
    if (previous !== phase) {
      if (phase !== 'media-pending') this.clearPaintPendingCopyTimers();
      if (phase !== 'media-stalled') this.clearPaintStalledCopyTimer();
      if (phase !== 'media-pending' && phase !== 'media-stalled') {
        this._paintIssueKind = null;
      }
      if (phase === 'media-pending') this.schedulePaintPendingCopyTimers();
      if (phase === 'media-stalled') {
        this.announcePaintIssue('media-stalled');
        this.schedulePaintStalledCopyTimer();
        this.schedulePaintStalledAutoSend();
      }
      console.log('[PAINT-GATE] uiPhase=%s reason=%s painted=%s', phase, reason || '', this.hasPaintedFrame);
    }
    return this.uiPhase;
  },

  clearPaintPendingCopyTimers() {
    if (this._paintPending3sTimer) {
      clearTimeout(this._paintPending3sTimer);
      this._paintPending3sTimer = null;
    }
    if (this._paintPending8sTimer) {
      clearTimeout(this._paintPending8sTimer);
      this._paintPending8sTimer = null;
    }
  },

  clearPaintStalledCopyTimer() {
    if (this._paintStalled3sTimer) {
      clearTimeout(this._paintStalled3sTimer);
      this._paintStalled3sTimer = null;
    }
    if (this._paintStalled6sTimer) {
      clearTimeout(this._paintStalled6sTimer);
      this._paintStalled6sTimer = null;
    }
  },

  clearPaintIssueTimers() {
    this.clearPaintPendingCopyTimers();
    this.clearPaintStalledCopyTimer();
    this._paintIssueKind = null;
  },

  schedulePaintPendingCopyTimers() {
    if (!this._paintPending3sTimer) {
      this._paintPending3sTimer = setTimeout(() => {
        this._paintPending3sTimer = null;
        if (this.uiPhase !== 'media-pending') return;
        this.announcePaintIssue('media-pending-3s');
      }, 3000);
    }
    if (!this._paintPending8sTimer) {
      this._paintPending8sTimer = setTimeout(() => {
        this._paintPending8sTimer = null;
        if (this.uiPhase !== 'media-pending') return;
        this.announcePaintIssue('media-pending-8s');
        this.autoSendPaintFailure('paint-pending-timeout');
      }, 8000);
    }
  },

  schedulePaintStalledCopyTimer() {
    if (this.networkMode !== 'relay' || this._paintStalled6sTimer) return;
    this._paintStalled6sTimer = setTimeout(() => {
      this._paintStalled6sTimer = null;
      if (this.uiPhase !== 'media-stalled') return;
      this.announcePaintIssue('media-stalled-6s');
    }, 6000);
  },

  schedulePaintStalledAutoSend() {
    if (this._paintStalled3sTimer) return;
    this._paintStalled3sTimer = setTimeout(() => {
      this._paintStalled3sTimer = null;
      if (this.uiPhase !== 'media-stalled') return;
      this.autoSendPaintFailure('media-stalled');
    }, 3000);
  },

  autoSendPaintFailure(reason) {
    if (typeof Diagnostic !== 'undefined' && typeof Diagnostic.autoSendFailure === 'function') {
      Diagnostic.autoSendFailure(reason);
    }
  },

  announcePaintIssue(kind) {
    if (kind === 'media-stalled' && this.networkMode !== 'relay') return;
    if (kind === 'media-stalled-6s' && this.networkMode !== 'relay') return;
    if (kind === 'explicit-1080' && (this.networkMode !== 'relay' || this._explicitOverride1080 !== true)) {
      return;
    }
    if (kind === 'media-stalled-6s') {
      this.setFailureRecommendation('relay-failed-suggest-tunnel', 'danger');
    }
    const copy = PAINT_ISSUE_COPY[kind];
    if (!copy) return;
    this._paintIssueKind = kind;
    this.updateNetworkUI(copy.text, copy.severity);
  },

  shouldPreservePaintIssueAdvisor() {
    return this.uiPhase === 'media-pending'
      || this.uiPhase === 'media-stalled'
      || Boolean(this._paintIssueKind);
  },

  isPeerMediaConnected() {
    const pcState = this.pc?.connectionState;
    const iceState = this.pc?.iceConnectionState;
    return pcState === 'connected'
      || iceState === 'connected'
      || iceState === 'completed';
  },

  notePaintStats(stats = {}) {
    const videoWidth = Number(stats.videoWidth || 0);
    const framesDecoded = Number(stats.framesDecoded || 0);
    const framesReceived = Number(stats.framesReceived || 0);
    const fps = Number(stats.fps || 0);
    const baseline = Number(this._paintDecodedBaseline) || 0;
    this._lastPaintStats = {
      videoWidth,
      videoHeight: Number(stats.videoHeight || 0),
      framesDecoded,
      framesReceived,
      fps,
      jitterBufferMs: Number(stats.jitterBufferMs || 0),
      bytesReceived: Number(stats.bytesReceived || 0),
    };

    if (!this.hasPaintedFrame) {
      if (videoWidth > 0 && framesDecoded > baseline) {
        this.hasPaintedFrame = true;
        this._stallSince = null;
        this.markMediaAttemptReady(this.currentConnectionAttemptId || null);
        this.setUiPhase('connected', { reason: stats.source || 'paint-growth' });
        return this.uiPhase;
      }
      if (this.isPeerMediaConnected()) {
        this.setUiPhase('media-pending', { reason: stats.source || 'awaiting-paint' });
      }
      return this.uiPhase;
    }

    if (fps === 0 && framesReceived > 0) {
      if (!this._stallSince) this._stallSince = Date.now();
      if (Date.now() - this._stallSince >= 1000) {
        this.setUiPhase('media-stalled', { reason: stats.source || 'zero-fps' });
      }
      return this.uiPhase;
    }

    this._stallSince = null;
    this.setUiPhase('connected', { reason: stats.source || 'paint-resume' });
    return this.uiPhase;
  },

  applyPaintFallback() {
    if (this.hasPaintedFrame) return this.uiPhase;
    if (this.uiPhase === 'disconnected') return this.uiPhase;
    this.setUiPhase('media-pending', { reason: 'paint-fallback-8s' });
    return this.uiPhase;
  },

  markRemoteTrack({ readyState, paused } = {}) {
    if (this.shouldHideLoading({
      readyState,
      paused,
      hasPaintedFrame: this.hasPaintedFrame,
    })) {
      this.setUiPhase('connected', { reason: 'remote-track' });
      return this.uiPhase;
    }
    if (this.isPeerMediaConnected() || paused === false || Number(readyState) >= 0) {
      this.setUiPhase('media-pending', { reason: 'remote-track' });
    }
    return this.uiPhase;
  },

  qualityFloorsForResolution(width, height) {
    const w = Number(width) || 0;
    const h = Number(height) || 0;
    const pixels = Math.max(1, w * h);
    if (pixels >= 1920 * 1080) return { minBitrateKbps: 2500, minFps: 12, targetFps: 20 };
    if (pixels >= 1280 * 720) return { minBitrateKbps: 1800, minFps: 12, targetFps: 20 };
    if (pixels >= 960 * 540) return { minBitrateKbps: 1200, minFps: 12, targetFps: 18 };
    return { minBitrateKbps: 900, minFps: 10, targetFps: 15 };
  },

  requestKeyframe(reason = 'media-stalled') {
    const now = Date.now();
    if (this._lastKeyframeRequestAt && now - this._lastKeyframeRequestAt < 1000) {
      return false;
    }
    const lease = this.activeLeaseEnvelope();
    if (!lease || !this.socket?.connected) return false;
    this._lastKeyframeRequestAt = now;
    this._keyframeRequested = true;
    this._keyframeEmitted = false;
    this.socket.emit('request-keyframe', {
      ...lease,
      schemaVersion: 2,
      reason: String(reason || 'media-stalled').slice(0, 80),
    });
    console.warn(`[MEDIA] request-keyframe reason=${reason}`);
    return true;
  },

  handleReceiverStats(stats) {
    if (this.isMediaHealthSuppressed()) return;
    const controller = this.ensureLinkQualityController();
    if (!controller || !this.adaptiveMediaEnabled) return;
    // Tunnel JPEG has its own backpressure/profile path; WebRTC adaptive stays off.
    if (this.networkMode === 'tunnel') return;

    // Relay was previously excluded entirely, which left high/2500kbps on ~400ms
    // TURN paths. Use relay-aware thresholds instead of skipping adaptation.
    if (typeof controller.setPath === 'function') {
      controller.setPath(this.linkQualityPathForMode(), { resetProfile: false });
    }
    if (typeof controller.setQualityLock === 'function') {
      controller.setQualityLock(this.adaptiveResolutionEnabled !== true);
    } else if (controller) {
      controller.qualityLock = this.adaptiveResolutionEnabled !== true;
    }

    const result = controller.observe({
      ...stats,
      selectedCandidatePair: this.selectedCandidatePair,
    });
    if (!result || result.action === 'hold') return;

    if (result.shouldRequestKeyframe || result.action === 'recover') {
      const inboundStillFlowing = Number(stats.framesReceived || 0) > 0
        && Number(stats.fps || 0) === 0;
      if (!(this.networkMode === 'relay' && inboundStillFlowing)) {
        this.requestKeyframe(result.reason || 'media-stalled');
      }
    }

    if (result.profileConfig) {
      this.applyMediaProfile(result.profileConfig, result.reason);
    }

    if (result.shouldRestartIce) {
      this.proactiveIceRestart(result.reason);
    }
  },

  configureVideoReceiver(receiver) {
    if (!receiver?.track || receiver.track.kind !== 'video') return;
    const isRelay = this.networkMode === 'relay'
      || this.lastCandidateType === 'relay';

    // Relay 160ms absorbs a VBV-capped IDR (~50KB) without the 400ms first-paint stall.
    if (typeof receiver.playoutDelayHint !== 'undefined') {
      try {
        receiver.playoutDelayHint = isRelay ? 0.16 : 0;
        console.log('[LATENCY] Set playoutDelayHint =', isRelay ? '0.16s (relay)' : '0s (direct)');
      } catch (error) {
        console.warn('[LATENCY] Unable to set playoutDelayHint:', error?.message || error);
      }
    }

    if (typeof receiver.jitterBufferTarget !== 'undefined') {
      try {
        receiver.jitterBufferTarget = isRelay ? 160 : 1;
        console.log('[LATENCY] Set jitterBufferTarget =', isRelay ? '160ms (relay)' : '1ms (direct)');
      } catch (error) {
        console.warn('[LATENCY] Unable to set jitterBufferTarget:', error?.message || error);
      }
    }
  },

  syncMediaProfile() {
    const controller = this.ensureLinkQualityController();
    if (!controller) return;
    // Align path before first profile push so relay starts at low, not high.
    if (typeof controller.setPath === 'function') {
      controller.setPath(this.linkQualityPathForMode(), { resetProfile: true });
    }
    const profileName = controller.currentProfile;
    const profile = typeof LinkQualityController !== 'undefined'
      ? LinkQualityController.profiles?.[profileName]
      : null;
    if (!profile) return;
    if (this.pc && this._profileSyncedPc === this.pc) return;
    this._profileSyncedPc = this.pc || null;
    this.applyMediaProfile(profile, 'connection-sync');
  },

  applyMediaProfile(profile, reason) {
    const lease = this.activeLeaseEnvelope();
    if (!profile || !lease) return false;
    const allowResolutionChange = this.adaptiveResolutionEnabled === true;
    const session = allowResolutionChange ? null : this.getSessionPresentation();
    const width = allowResolutionChange
      ? Number(profile.width) || Number(this.currentResolution?.width) || 960
      : Number(session?.width) || Number(this.currentResolution?.width) || Number(profile.width) || 960;
    const height = allowResolutionChange
      ? Number(profile.height) || Number(this.currentResolution?.height) || 540
      : Number(session?.height) || Number(this.currentResolution?.height) || Number(profile.height) || 540;
    // When resolution is locked high, do not starve the encoder with survival bitrates
    // designed for 360p — that creates encode backlog and multi-second jitter spikes.
    let bitrateKbps = Number(profile.bitrateKbps) || 900;
    let targetFps = Number(profile.fps) || 15;
    if (!allowResolutionChange) {
      const floors = this.qualityFloorsForResolution(width, height);
      bitrateKbps = Math.max(bitrateKbps, floors.minBitrateKbps);
      // Prefer target fps on connection-sync; never below min floor when adapting down.
      if (reason === 'connection-sync' || reason === 'path-sync') {
        targetFps = Math.max(targetFps, floors.targetFps);
      } else {
        targetFps = Math.max(targetFps, floors.minFps);
      }
    }
    if (allowResolutionChange) {
      this.currentResolution = {
        width,
        height,
        label: `${width}x${height}`,
      };
    }
    console.warn(
      `[MEDIA] applying profile ${profile.name} size=${width}x${height}`
      + ` fps=${targetFps} bitrate=${bitrateKbps}kbps`
      + ` adaptiveRes=${allowResolutionChange ? 'on' : 'off'} reason=${reason}`,
    );
    if (this.socket && this.socket.connected) {
      this.socket.emit('media-profile-change', {
        ...lease,
        profile: profile.name,
        width,
        height,
        targetFps,
        videoBitrateKbps: bitrateKbps,
        reason,
        mediaPolicy: 'strict-stun',
        adaptiveResolution: allowResolutionChange,
        continuityAction: 'none',
      });
    }
    if (typeof ConnectionTrace !== 'undefined' && typeof ConnectionTrace.record === 'function') {
      ConnectionTrace.record('media-profile-change', {
        profile: profile.name,
        reason,
        width,
        height,
        targetFps,
        videoBitrateKbps: bitrateKbps,
        adaptiveResolution: allowResolutionChange,
      });
    }
    return true;
  },

  setAdaptiveResolutionEnabled(enabled, { persist = true } = {}) {
    this.adaptiveResolutionEnabled = Boolean(enabled);
    if (persist) {
      localStorage.setItem('wrdAdaptiveResolution', this.adaptiveResolutionEnabled ? '1' : '0');
    }
    const checkbox = document.getElementById('adaptiveResolutionToggle');
    if (checkbox) checkbox.checked = this.adaptiveResolutionEnabled;
    return this.adaptiveResolutionEnabled;
  },

  proactiveIceRestart(reason) {
    if (!this.pc || typeof this.pc.restartIce !== 'function') return;
    const why = String(reason || '');
    // On forced TURN, the selected pair is already relay↔relay. restartIce+offer
    // tears the only working path during encoder warmup / brief 0-FPS gaps and
    // recreates media-stalled (see 2026-08-01 full-relay hold samples).
    if (this.networkMode === 'relay' && (why.includes('rtt') || why.includes('stall') || why === 'media-stalled')) {
      console.warn(`[RECOVERY] skip ICE restart on relay path reason=${reason}`);
      return;
    }
    if (this._iceRestartAttempts >= 1) return;
    this._iceRestartAttempts += 1;
    if (this.linkQualityController?.markIceRestartAttempted) {
      this.linkQualityController.markIceRestartAttempted();
    }
    console.warn(`[RECOVERY] proactive ICE restart reason=${reason}`);
    if (typeof ConnectionTrace !== 'undefined' && typeof ConnectionTrace.record === 'function') {
      ConnectionTrace.record('ice-restart', { reason, proactive: true });
    }
    this.pc.restartIce();
    this.createOffer();
  },

  isPublicOrigin() {
    let hostname = String(window.location?.hostname || '').toLowerCase();
    if (!hostname) {
      const origin = String(window.location?.origin || '').toLowerCase();
      const match = origin.match(/^[a-z]+:\/\/([^/:?#]+)/);
      hostname = match ? match[1] : '';
    }
    if (!hostname) {
      return false;
    }
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      return false;
    }
    if (hostname.endsWith('.local')) {
      return false;
    }
    return true;
  },

  enforceSupportedNetworkMode(preferredMode = this.networkMode) {
    this.networkMode = preferredMode;
    localStorage.setItem('wrdNetworkMode', preferredMode);
    // Keep adaptive ceilings/thresholds aligned as soon as mode is chosen.
    this.syncLinkQualityPath({ applyProfile: false, reason: 'mode-change' });
    if (preferredMode === 'relay' && !this.hasTurnConfigured()) {
      console.warn('[NETWORK] Relay mode requested without TURN; keeping relay selection and surfacing guidance');
      this.setFailureRecommendation('relay-unavailable-no-turn', 'warning');
      return {
        effectiveMode: preferredMode,
        changed: false,
        unavailable: true,
        reason: this.serverConfig?.turnStatus === 'misconfigured'
          ? 'TURN 配置不完整，外网中继当前不可用。请手动改用“隧道中继”或补全 TURN 用户名/凭证。'
          : '当前未配置 TURN，外网中继当前不可用。请手动改用“隧道中继”。',
      };
    }
    return { effectiveMode: preferredMode, changed: false, unavailable: false, reason: '' };
  },
  
  async init({ bootstrapSnapshot = null, trigger = 'viewer-open', reuseSocket = false } = {}) {
    const token = Auth.getToken();
    if (!token) {
      console.error('No token available');
      if (typeof Auth.logout === 'function') Auth.logout();
      return;
    }
    this.manualDisconnect = false;
    if (bootstrapSnapshot) {
      this.applyBootstrapSnapshot(bootstrapSnapshot);
    } else {
      await this.loadServerConfig();
    }
    this.clearFailureRecommendation();
    const modeState = this.enforceSupportedNetworkMode(this.networkMode);
    this.beginConnectionAttempt(trigger);
    this.beginFirstFrameDeadline(this.currentConnectionAttemptId, 8000);
    this.configureNetworkControls();
    this.updateNetworkUI(modeState.changed ? modeState.reason : '网络模式已就绪', modeState.changed ? 'warning' : '');
    // reuseSocket: startViewer may already have opened signaling while bootstrap loads.
    this._deferPeerUntilConfig = false;
    this.createSignalingSocket(!reuseSocket);
    this.bindControlLifecycle();
    if (this.networkMode !== 'tunnel') this.createPeerConnection();
  },

  applyBootstrapSnapshot(snapshot = null) {
    if (!snapshot || typeof snapshot !== 'object') {
      throw new Error('bootstrap snapshot required');
    }
    const webrtc = snapshot.webrtc && typeof snapshot.webrtc === 'object'
      ? snapshot.webrtc
      : snapshot;
    this.serverConfig = {
      ...webrtc,
      iceServers: Array.isArray(webrtc.iceServers) ? webrtc.iceServers : [],
    };
    if (snapshot.host && typeof snapshot.host === 'object') {
      this.applyHostCapabilities(snapshot.host.capabilities || {});
    }
    const selectedId = this.setSelectedTurnServerId(
      this.serverConfig.selectedTurnServerId || this.selectedTurnServerId || '',
      { persist: true },
    );
    if (selectedId && !this.serverConfig.selectedTurnServerId) {
      this.serverConfig.selectedTurnServerId = selectedId;
    }
    this.populateTurnServerSelect();
    return this.serverConfig;
  },

  isCurrentAttemptMediaReady(attemptId = this.currentConnectionAttemptId || null) {
    return Boolean(
      attemptId
      && this._mediaReadyConnectionAttemptId
      && this._mediaReadyConnectionAttemptId === attemptId,
    );
  },

  clearFirstFrameDeadline() {
    if (this._firstFrameTimer) {
      clearTimeout(this._firstFrameTimer);
      this._firstFrameTimer = null;
    }
  },

  beginFirstFrameDeadline(attemptId, timeoutMs = 8000) {
    this.clearFirstFrameDeadline();
    const expectedAttemptId = attemptId || this.currentConnectionAttemptId;
    if (this.hasPaintedFrame
      || this.isCurrentAttemptMediaReady(expectedAttemptId)
      || (this.uiPhase === 'media-pending' && this.isPeerMediaConnected())) {
      return;
    }
    this._firstFrameTimer = setTimeout(() => {
      if (expectedAttemptId !== this.currentConnectionAttemptId) return;
      if (this.hasPaintedFrame) return;
      if (this.isCurrentAttemptMediaReady(expectedAttemptId)) return;
      if (this.uiPhase === 'media-pending' && this.isPeerMediaConnected()) return;
      if (this.uiPhase === 'connected' || this.uiPhase === 'media-stalled') return;
      this.endConnectingWithFailure('first-frame-timeout');
    }, timeoutMs);
  },

  endConnectingWithFailure(reason = 'first-frame-timeout') {
    this.clearFirstFrameDeadline();
    document.getElementById('loading')?.classList.remove('is-connecting');
    this.setUiPhase('disconnected', { reason });
    const startBtn = document.getElementById('startBtn');
    if (startBtn) startBtn.style.display = '';
    if (reason === 'first-frame-timeout') {
      this.setFailureRecommendation('direct-failed-suggest-relay', 'error');
      updateLoadingText('首帧超时，请检查网络模式后重试');
      this.updateNetworkUI(this.getRecommendationMessage() || '首帧超时', 'error');
      return;
    }
    updateLoadingText(String(reason || '连接失败，请重试'));
  },

  enterBootstrapFailure(error) {
    this.clearFirstFrameDeadline();
    document.getElementById('loading')?.classList.remove('is-connecting');
    this.setUiPhase('disconnected', { reason: 'bootstrap-failure' });
    const startBtn = document.getElementById('startBtn');
    if (startBtn) startBtn.style.display = '';
    const message = error?.message || '启动配置加载失败';
    updateLoadingText(`启动失败：${message}`);
    this.updateNetworkUI(message, 'error');
  },

  async startViewer(controller = null) {
    const startBtn = document.getElementById('startBtn');
    if (startBtn) startBtn.style.display = 'none';
    document.getElementById('loading')?.classList.add('is-connecting');
    updateLoadingText('正在连接...');
    if (typeof StartupTelemetry !== 'undefined' && StartupTelemetry?.mark) {
      StartupTelemetry.mark('start-click');
      StartupTelemetry.mark('bootstrap-start');
    }
    try {
      if (typeof Auth !== 'undefined' && !Auth.isLoggedIn()) {
        return Auth.logout();
      }
      if (!controller) {
        await this.init({ trigger: 'start-button' });
        return;
      }
      // Open signaling immediately; ICE/config can arrive in parallel via bootstrap.
      // Defer PeerConnection until applyBootstrapSnapshot so we do not gather with empty ICE.
      this.manualDisconnect = false;
      this._deferPeerUntilConfig = true;
      this.createSignalingSocket(true);
      const bootstrapSnapshot = await controller.load({
        mode: this.networkMode,
        turnServerId: this.selectedTurnServerId,
      });
      if (typeof StartupTelemetry !== 'undefined' && StartupTelemetry?.mark) {
        if (bootstrapSnapshot?.degraded) {
          StartupTelemetry.mark('bootstrap-degraded');
        } else {
          StartupTelemetry.mark('bootstrap-ready');
        }
      }
      await this.init({ bootstrapSnapshot, trigger: 'start-button', reuseSocket: true });
    } catch (error) {
      this._deferPeerUntilConfig = false;
      if (controller && controller.getSnapshot && controller.getSnapshot().state === 'auth-required') {
        return Auth.logout();
      }
      this.enterBootstrapFailure(error);
    }
  },

  createStartHandler(controller = null) {
    let inflightStart = null;
    const self = this;
    return function startOnce() {
      if (inflightStart) return inflightStart;
      inflightStart = self.startViewer(controller).finally(() => { inflightStart = null; });
      return inflightStart;
    };
  },

  createSignalingSocket(forceRecreate = false) {
    if (this._superseded) {
      return null;
    }
    if (this.socket && !forceRecreate) {
      return this.socket;
    }
    if (this.socket) {
      this.socket.disconnect();
    }
    const token = Auth.getToken();
    if (!token) {
      console.error('No token available');
      return null;
    }
    const socketBase = (typeof RuntimeConfig !== 'undefined')
      ? RuntimeConfig.getSocketBase()
      : window.location.origin;
    const socketOptions = this.buildSignalingSocketOptions({
      token,
      reconnection: !this._superseded,
    });
    this.socket = io(socketBase, socketOptions);
    this.setupSocketListeners();
    return this.socket;
  },

  signalingConnectBudgetMs: 5000,

  resolveSignalingTransports({ allowPolling = true } = {}) {
    // Websocket-first keeps formal cold path fast; polling remains a fallback when WS is blocked.
    if (allowPolling === false) return ['websocket'];
    return ['websocket', 'polling'];
  },

  buildSignalingSocketOptions({ token, reconnection = true, allowPolling = true } = {}) {
    const transports = this.resolveSignalingTransports({ allowPolling });
    const timeout = Number(this.signalingConnectBudgetMs) > 0
      ? Number(this.signalingConnectBudgetMs)
      : 5000;
    return {
      auth: { token, role: 'viewer', inputProtocolVersion: 2 },
      reconnection: Boolean(reconnection),
      // Prefer WebSocket; keep polling as bounded fallback for proxy/firewall paths.
      transports,
      // When the first transport fails hard, continue through the list (WS → polling).
      tryAllTransports: true,
      // Bound dual-transport failure so Start does not silently hang past 5s budgets.
      timeout,
    };
  },

  /**
   * Pure helper for transport-fallback policy tests.
   * models: websocket attempt first; on hard WS failure, polling may succeed;
   * if every listed transport fails, exit within the connect budget.
   */
  evaluateSignalingTransportPlan(events = [], {
    transports = null,
    budgetMs = null,
  } = {}) {
    const list = Array.isArray(transports) && transports.length
      ? transports.slice()
      : this.resolveSignalingTransports();
    const rawBudget = budgetMs == null || budgetMs === ''
      ? this.signalingConnectBudgetMs
      : budgetMs;
    const budget = Number.isFinite(Number(rawBudget)) && Number(rawBudget) > 0
      ? Number(rawBudget)
      : 5000;
    let used = null;
    let connectedAt = null;
    let failedAt = null;
    for (const event of events) {
      const at = Number(event?.atMs);
      const transport = String(event?.transport || '');
      const type = String(event?.type || '');
      if (!Number.isFinite(at) || at < 0) continue;
      if (type === 'connect' && list.includes(transport)) {
        used = transport;
        connectedAt = at;
        break;
      }
      if (type === 'transport-error' || type === 'connect_error') {
        failedAt = at;
      }
    }
    if (used != null) {
      return {
        ok: true,
        transport: used,
        withinBudget: connectedAt <= budget,
        elapsedMs: connectedAt,
        exhausted: false,
      };
    }
    const elapsed = failedAt == null ? budget : Math.min(budget, failedAt);
    return {
      ok: false,
      transport: null,
      withinBudget: elapsed <= budget,
      elapsedMs: elapsed,
      exhausted: true,
    };
  },

  applyHostCapabilities(capabilities = null) {
    if (!this.serverConfig || typeof this.serverConfig !== 'object') {
      this.serverConfig = {};
    }
    if (!capabilities || typeof capabilities !== 'object') {
      return this.serverConfig;
    }
    if (Object.prototype.hasOwnProperty.call(capabilities, 'turnReady')) {
      this.serverConfig.hostTurnReady = Boolean(capabilities.turnReady);
    }
    if (Object.prototype.hasOwnProperty.call(capabilities, 'turnFingerprint')) {
      this.serverConfig.hostTurnFingerprint = String(capabilities.turnFingerprint || '');
    }
    if (Object.prototype.hasOwnProperty.call(capabilities, 'supportsSessionTurn')) {
      this.serverConfig.hostSupportsSessionTurn = Boolean(capabilities.supportsSessionTurn);
    }
    if (Object.prototype.hasOwnProperty.call(capabilities, 'supportsMultiTurn')) {
      this.serverConfig.hostSupportsMultiTurn = Boolean(capabilities.supportsMultiTurn);
    }
    if (Object.prototype.hasOwnProperty.call(capabilities, 'turnServerId')) {
      this.serverConfig.hostTurnServerId = String(capabilities.turnServerId || '');
    }
    if (Object.prototype.hasOwnProperty.call(capabilities, 'defaultTurnServerId')) {
      this.serverConfig.hostDefaultTurnServerId = String(capabilities.defaultTurnServerId || '');
    }
    if (Object.prototype.hasOwnProperty.call(capabilities, 'turnServerIds')) {
      this.serverConfig.hostTurnServerIds = Array.isArray(capabilities.turnServerIds)
        ? capabilities.turnServerIds.slice()
        : [];
    }
    const turnStatus = document.getElementById('networkTurnStatus');
    if (turnStatus) {
      turnStatus.textContent = this.buildTurnStatusText();
    }
    return this.serverConfig;
  },

  listTurnServerOptions() {
    const servers = Array.isArray(this.serverConfig?.turnServers)
      ? this.serverConfig.turnServers
      : [];
    return servers.filter((server) => server && server.id);
  },

  resolveSelectedTurnServerId(preferredId = this.selectedTurnServerId) {
    const servers = this.listTurnServerOptions();
    const preferred = String(preferredId || '').trim();
    if (preferred && servers.some((server) => server.id === preferred && server.configured !== false)) {
      return preferred;
    }
    const defaultId = String(
      this.serverConfig?.defaultTurnServerId
      || this.serverConfig?.selectedTurnServerId
      || '',
    ).trim();
    if (defaultId && servers.some((server) => server.id === defaultId)) {
      return defaultId;
    }
    const preferredServer = servers.find((server) => server.preferred && server.configured !== false);
    if (preferredServer?.id) return preferredServer.id;
    const firstConfigured = servers.find((server) => server.configured !== false);
    return firstConfigured?.id || servers[0]?.id || '';
  },

  setSelectedTurnServerId(turnServerId, { persist = true } = {}) {
    const next = this.resolveSelectedTurnServerId(turnServerId);
    this.selectedTurnServerId = next;
    if (persist) {
      if (next) localStorage.setItem('wrdTurnServerId', next);
      else localStorage.removeItem('wrdTurnServerId');
    }
    return next;
  },

  populateTurnServerSelect() {
    const select = document.getElementById('turnServerSelect');
    if (!select || typeof document.createElement !== 'function') return;
    const servers = this.listTurnServerOptions();
    const selectedId = this.resolveSelectedTurnServerId(this.selectedTurnServerId);
    select.innerHTML = '';
    if (!servers.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = '未配置';
      select.appendChild(option);
      select.disabled = true;
      select.value = '';
      return;
    }
    select.disabled = servers.length <= 1;
    for (const server of servers) {
      const option = document.createElement('option');
      option.value = server.id;
      const label = server.label || server.remark || server.host || server.id;
      const host = server.host ? ` (${server.host})` : '';
      const suffix = server.preferred || server.isDefault ? '（推荐）' : '';
      option.textContent = `${label}${host}${suffix}`;
      select.appendChild(option);
    }
    select.value = selectedId || servers[0].id;
  },

  async loadServerConfig({ turnServerId } = {}) {
    try {
      const token = Auth.getToken();
      const apiBase = (typeof RuntimeConfig !== 'undefined')
        ? RuntimeConfig.getApiBase()
        : '';
      const requestedId = String(
        turnServerId != null ? turnServerId : (this.selectedTurnServerId || ''),
      ).trim();
      const query = requestedId
        ? `?turnServerId=${encodeURIComponent(requestedId)}`
        : '';
      const response = await fetch(`${apiBase}/api/webrtc-config${query}`, {
        cache: 'no-store',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      this.serverConfig = await response.json();
      const resolvedId = this.setSelectedTurnServerId(
        this.serverConfig.selectedTurnServerId || requestedId || this.selectedTurnServerId,
        { persist: true },
      );
      if (
        resolvedId
        && this.serverConfig.selectedTurnServerId
        && resolvedId !== this.serverConfig.selectedTurnServerId
      ) {
        // localStorage id may be stale relative to default; reload once for matching iceServers.
        const retry = await fetch(
          `${apiBase}/api/webrtc-config?turnServerId=${encodeURIComponent(resolvedId)}`,
          {
            cache: 'no-store',
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          },
        );
        if (retry.ok) {
          this.serverConfig = await retry.json();
        }
      }
      this.populateTurnServerSelect();
      console.log('[NETWORK] Loaded WebRTC config:', {
        stunUrls: this.serverConfig.stunUrls,
        turnConfigured: this.serverConfig.turnConfigured,
        turnSource: this.serverConfig.turnSource,
        turnFingerprint: this.serverConfig.turnFingerprint,
        hostTurnReady: this.serverConfig.hostTurnReady,
        turnUrls: this.serverConfig.turnUrls,
        selectedTurnServerId: this.selectedTurnServerId,
        turnServers: (this.serverConfig.turnServers || []).map((server) => server.id),
      });
    } catch (err) {
      console.warn('[NETWORK] Failed to load WebRTC config, using built-in STUN only:', err);
      this.serverConfig = {
        stunUrls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'],
        turnConfigured: false,
        turnMisconfigured: false,
        turnStatus: 'missing',
        turnSource: 'none',
        turnFingerprint: '',
        hostTurnReady: false,
        hostTurnFingerprint: '',
        turnUrls: [],
        turnServers: [],
        selectedTurnServerId: '',
        defaultTurnServerId: '',
        iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }]
      };
      this.populateTurnServerSelect();
    }
  },

  getStunServers() {
    const defaultUrls = [
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302',
      'stun:stun2.l.google.com:19302',
      'stun:stun.cloudflare.com:3478',
    ];
    const stunUrls = this.serverConfig?.stunUrls?.length
      ? this.serverConfig.stunUrls
      : defaultUrls;
    const deduped = [...new Set((stunUrls || [])
      .map((url) => String(url || '').trim())
      .filter(Boolean))];
    return deduped.length ? [{ urls: deduped }] : [];
  },

  getTurnServers() {
    if (!this.serverConfig?.turnConfigured) {
      return [];
    }
    return (this.serverConfig.iceServers || []).filter((server) => {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      return urls.some((url) => String(url).startsWith('turn:') || String(url).startsWith('turns:'));
    });
  },

  buildPeerConfig() {
    const turnServers = this.getTurnServers();
    let iceServers = [];
    let iceTransportPolicy = 'all';

    if (this.networkMode === 'lan') {
      iceServers = [];
    } else if (this.networkMode === 'stun') {
      iceServers = this.getStunServers();
    } else if (this.networkMode === 'relay') {
      iceServers = turnServers;
      iceTransportPolicy = 'relay';
    } else {
      // Strict STUN policy: never silently force-relay while networkMode stays auto/stun.
      // useRelayFallback is retained only as diagnostic residue and must not change ICE.
      iceServers = [...this.getStunServers(), ...turnServers];
    }

    return {
      iceServers,
      iceTransportPolicy,
      iceCandidatePoolSize: this.networkMode === 'lan' ? 0 : 4,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    };
  },

  resetCandidateSummary() {
    this.candidateSummary = {
      local: { host: 0, srflx: 0, relay: 0, prflx: 0, other: 0 },
      remote: { host: 0, srflx: 0, relay: 0, prflx: 0, other: 0 },
      samples: { local: [], remote: [] }
    };
  },

  parseCandidate(candidateLike) {
    const candidateString = typeof candidateLike === 'string'
      ? candidateLike
      : candidateLike?.candidate || '';
    if (!candidateString) {
      return null;
    }
    const raw = candidateString.startsWith('candidate:')
      ? candidateString.slice(10)
      : candidateString;
    const parts = raw.trim().split(/\s+/);
    if (parts.length < 8) {
      return null;
    }
    const typeIndex = parts.indexOf('typ');
    const candidateType = typeIndex >= 0 && parts[typeIndex + 1] ? parts[typeIndex + 1] : 'other';
    return {
      type: candidateType,
      protocol: (parts[2] || '').toLowerCase(),
      address: `${parts[4] || '?'}:${parts[5] || '?'}`,
    };
  },

  detectAddressFamily(address = '') {
    const host = String(address).replace(/^\[/, '').split(']')[0].split(':')[0];
    if (String(address).includes(':') && !/^\d+\.\d+\.\d+\.\d+/.test(String(address))) {
      return 'ipv6';
    }
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      return 'ipv4';
    }
    return address ? 'hostname' : '';
  },

  classifyCandidateHealth(snapshot = this.collectNetworkSnapshot()) {
    const summary = snapshot.candidateSummary || {};
    const local = summary.local || {};
    const remote = summary.remote || {};
    const hasRelay = Number(local.relay || 0) > 0 || Number(remote.relay || 0) > 0;
    const hasSrflx = Number(local.srflx || 0) > 0 || Number(remote.srflx || 0) > 0;
    const hasRemote = ['host', 'srflx', 'relay', 'prflx'].some((type) => Number(remote[type] || 0) > 0);
    if (!snapshot.turnConfigured && !hasRelay && hasSrflx) {
      return hasRemote ? 'stun-no-turn-no-relay' : 'stun-local-only-no-turn';
    }
    if (hasRelay) {
      return 'relay-candidate-present';
    }
    if (!hasSrflx && !hasRemote) {
      return 'no-usable-candidates';
    }
    return 'candidate-check-needed';
  },

  addCandidateSample(direction, candidateLike) {
    const parsed = this.parseCandidate(candidateLike);
    if (!parsed) {
      return;
    }
    const bucket = ['host', 'srflx', 'relay', 'prflx'].includes(parsed.type) ? parsed.type : 'other';
    const summary = this.candidateSummary?.[direction];
    const samples = this.candidateSummary?.samples?.[direction];
    if (!summary || !samples) {
      return;
    }
    summary[bucket] = (summary[bucket] || 0) + 1;
    if (samples.length < 6) {
      samples.push(parsed);
    }
  },

  collectNetworkSnapshot() {
    return {
      networkMode: this.networkMode || null,
      useRelayFallback: Boolean(this.useRelayFallback),
      tunnelRelayActive: Boolean(this.tunnelRelayActive),
      tunnelLockUntil: Number(this._tunnelLockUntil || 0),
      autoFailCount: Number(this._autoFailCount || 0),
      iceRestartAttempts: Number(this._iceRestartAttempts || 0),
      noMediaTicks: Number(this.noMediaTicks || 0),
      lastCandidateType: this.lastCandidateType || '',
      turnConfigured: Boolean(this.serverConfig?.turnConfigured),
      turnStatus: this.serverConfig?.turnStatus || 'unknown',
      turnSource: this.serverConfig?.turnSource || 'none',
      turnFingerprint: this.serverConfig?.turnFingerprint || '',
      hostTurnReady: Boolean(this.serverConfig?.hostTurnReady),
      hostTurnFingerprint: this.serverConfig?.hostTurnFingerprint || '',
      turnSelfTest: this.lastTurnSelfTest
        ? {
          ok: Boolean(this.lastTurnSelfTest.ok),
          failedCode: this.lastTurnSelfTest.failedCode || null,
          message: this.lastTurnSelfTest.message || '',
          steps: (this.lastTurnSelfTest.steps || []).map((step) => ({
            step: step.step,
            ok: Boolean(step.ok),
            code: step.code,
            detail: step.detail || '',
            relayCandidateCount: step.relayCandidateCount,
          })),
        }
        : null,
      selectedCandidatePair: this.selectedCandidatePair,
      candidateSummary: this.candidateSummary,
      stunPortSearch: this.portSearchController?.snapshot() || null,
      pc: this.pc ? {
        connectionState: this.pc.connectionState || null,
        iceConnectionState: this.pc.iceConnectionState || null,
        iceGatheringState: this.pc.iceGatheringState || null,
        signalingState: this.pc.signalingState || null,
      } : null,
    };
  },

  ensurePortSearchController() {
    if (this.portSearchController) {
      return this.portSearchController;
    }
    const factory = (typeof StunPortSearchController !== 'undefined' && StunPortSearchController)
      || (typeof window !== 'undefined' && window.StunPortSearchController)
      || null;
    if (!factory || typeof factory.create !== 'function') {
      return null;
    }
    this.portSearchController = factory.create();
    return this.portSearchController;
  },

  isPortSearchActive() {
    const snap = this.portSearchController?.snapshot?.();
    return Boolean(snap && snap.status === 'searching');
  },

  clearPortSearchTimers() {
    if (this._portSearchRoundTimer) {
      clearTimeout(this._portSearchRoundTimer);
      this._portSearchRoundTimer = null;
    }
    if (this._portSearchRetryTimer) {
      clearTimeout(this._portSearchRetryTimer);
      this._portSearchRetryTimer = null;
    }
  },

  extractCandidatePort(candidateLike) {
    if (candidateLike && candidateLike.port != null) {
      const structured = Number(candidateLike.port);
      if (Number.isInteger(structured) && structured >= 1 && structured <= 65535) {
        return structured;
      }
    }
    const candidateString = typeof candidateLike === 'string'
      ? candidateLike
      : candidateLike?.candidate || '';
    if (!candidateString) {
      return null;
    }
    const raw = candidateString.startsWith('candidate:')
      ? candidateString.slice(10)
      : candidateString;
    const parts = raw.trim().split(/\s+/);
    if (parts.length < 6) {
      return null;
    }
    const port = Number(parts[5]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return null;
    }
    return port;
  },

  canStartPortSearch() {
    return ['auto', 'stun'].includes(this.networkMode)
      && Boolean(this.socket?.connected)
      && Boolean(this.controlState?.hostOnline)
      && this.controlState?.state === 'ACTIVE'
      && this.controlState?.controller === true
      && Boolean(this.activeLeaseEnvelope())
      && !this.manualDisconnect
      && this.getMediaActivitySnapshot().state === 'active';
  },

  portSearchGateReason() {
    if (!['auto', 'stun'].includes(this.networkMode)) return '当前模式不支持';
    if (!this.socket?.connected) return '信令未连接';
    if (!this.controlState?.hostOnline) return 'Host 离线';
    if (this.manualDisconnect) return '已手动断开';
    if (this.getMediaActivitySnapshot().state !== 'active') return '媒体已暂停';
    if (this.controlState?.state === 'GRANTING' || this.controlState?.state === 'REVOKING') {
      return '控制权正在切换';
    }
    if (!(this.controlState?.state === 'ACTIVE' && this.controlState?.controller === true && this.activeLeaseEnvelope())) {
      return '需要控制权';
    }
    return null;
  },

  renderPortSearchStatus() {
    const btn = document.getElementById('portSearchBtn');
    const candidateEl = document.getElementById('candidateDisplay');
    const snap = this.portSearchController?.snapshot?.() || null;
    const searching = snap?.status === 'searching';
    const toolsState = this._operatorToolsState || 'loading'; // loading | ready | failed
    const canStart = this.canStartPortSearch();
    const gateReason = searching ? null : this.portSearchGateReason();

    if (btn) {
      if (!btn.dataset.wrdPortSearchLabel) {
        btn.dataset.wrdPortSearchLabel = '搜索端口';
      }
      // Deferred STUN tool must never look enabled-and-inert.
      if (toolsState === 'loading') {
        btn.textContent = btn.dataset.wrdPortSearchLabel;
        btn.disabled = true;
        btn.setAttribute('aria-busy', 'true');
        btn.dataset.wrdOperatorState = 'loading';
        btn.title = '端口搜索组件加载中…';
      } else if (toolsState === 'failed') {
        btn.textContent = '端口工具重试';
        btn.disabled = false;
        if (typeof btn.removeAttribute === 'function') btn.removeAttribute('aria-busy');
        btn.dataset.wrdOperatorState = 'failed';
        btn.title = '端口搜索组件加载失败，点击重试';
      } else {
        btn.textContent = searching ? '停止搜索' : btn.dataset.wrdPortSearchLabel;
        btn.disabled = searching ? false : !canStart;
        if (typeof btn.removeAttribute === 'function') btn.removeAttribute('aria-busy');
        btn.dataset.wrdOperatorState = 'ready';
        if (gateReason) btn.title = gateReason;
        else if (!searching) btn.title = '搜索可用 STUN 端口';
      }
    }

    if (!candidateEl || !snap) {
      return;
    }

    const viewerPort = (snap.current?.viewerPorts || snap.viewerPorts || [])[0];
    const hostPort = (snap.current?.hostPorts || snap.hostPorts || [])[0];
    const viewerText = viewerPort ? `Viewer UDP ${viewerPort}` : 'Viewer UDP 分配中';
    const hostText = hostPort ? `Host UDP ${hostPort}` : 'Host UDP 分配中';
    const uniqueCount = Number(snap.uniquePortCount || 0);

    if (snap.status === 'searching') {
      candidateEl.textContent = `端口搜索 ${snap.attempt}/${snap.limit} · ${viewerText} · ${hostText} · 唯一端口 ${uniqueCount}`;
    } else if (snap.status === 'succeeded') {
      candidateEl.textContent = `端口搜索成功 第${snap.attempt}轮 · ${viewerText} · ${hostText} · 唯一端口 ${uniqueCount}`;
    } else if (snap.status === 'exhausted') {
      candidateEl.textContent = `端口搜索失败：已尝试 ${snap.limit} 轮`;
    }
  },

  startPortSearch() {
    // Strict no-op unless the current ACTIVE controller holds a lease.
    // Must not create controllers, arm timers, close PC, refresh, or acquire control.
    if (!this.canStartPortSearch()) {
      const reason = this.portSearchGateReason();
      if (reason === '当前模式不支持') {
        this.updateNetworkUI('端口搜索仅在“自动穿透”或“外网直连”模式下可用，请先手动切换到直连模式。', 'warning');
      } else if (reason === '信令未连接') {
        this.updateNetworkUI('信令未连接，无法开始端口搜索。', 'warning');
      } else if (reason === 'Host 离线') {
        this.updateNetworkUI('Host 未上线，无法开始端口搜索。', 'warning');
      } else if (reason === '需要控制权') {
        this.updateNetworkUI('请先请求控制后再搜索端口。', 'warning');
      } else if (reason === '控制权正在切换') {
        this.updateNetworkUI('控制权正在切换，暂不可搜索端口。', 'warning');
      } else if (reason === '媒体已暂停') {
        this.updateNetworkUI('媒体已暂停，暂不可搜索端口。', 'warning');
      } else if (reason) {
        this.updateNetworkUI(`无法开始端口搜索：${reason}`, 'warning');
      }
      this.renderPortSearchStatus();
      return false;
    }

    const controller = this.ensurePortSearchController();
    if (!controller) {
      console.warn('[PORT-SEARCH] StunPortSearchController unavailable');
      this.updateNetworkUI('端口搜索组件尚未就绪，请稍后重试或点击“端口工具重试”。', 'warning');
      this.renderPortSearchStatus();
      return false;
    }

    this.clearPortSearchTimers();
    controller.start();
    const attempt = controller.beginAttempt('manual');
    if (!attempt.accepted) {
      this.renderPortSearchStatus();
      return false;
    }

    this._portSearchGeneration += 1;
    this.renderPortSearchStatus();
    this._portSearchRefreshOwned = true;
    try {
      this.refresh();
    } finally {
      this._portSearchRefreshOwned = false;
    }
    this.armPortSearchDeadline();
    return true;
  },

  stopPortSearch(reason = 'user') {
    if (this.portSearchController) {
      const snap = this.portSearchController.snapshot();
      if (snap.status === 'searching') {
        this.portSearchController.stop(reason);
      }
    }
    this.clearPortSearchTimers();
    this._portSearchGeneration += 1;
    this.renderPortSearchStatus();
  },

  recordPortSearchCandidate(side, candidateLike) {
    if (!this.isPortSearchActive() || !this.portSearchController) {
      return;
    }
    const port = this.extractCandidatePort(candidateLike);
    if (port == null) {
      return;
    }
    if (this.portSearchController.recordPort(side, port)) {
      this.renderPortSearchStatus();
    }
  },

  armPortSearchDeadline() {
    if (!this.isPortSearchActive()) {
      return;
    }
    if (this._portSearchRoundTimer) {
      clearTimeout(this._portSearchRoundTimer);
      this._portSearchRoundTimer = null;
    }
    const generation = this._portSearchGeneration;
    const pc = this.pc;
    const deadlineMs = Number(this.PORT_SEARCH_ROUND_MS) || 10000;
    this._portSearchRoundTimer = setTimeout(() => {
      this._portSearchRoundTimer = null;
      if (generation !== this._portSearchGeneration) {
        return;
      }
      if (pc && this.pc && pc !== this.pc) {
        return;
      }
      if (!this.isPortSearchActive()) {
        return;
      }
      this.schedulePortSearchRetry('timeout');
    }, deadlineMs);
  },

  schedulePortSearchRetry(reason) {
    if (!this.isPortSearchActive() || this.manualDisconnect) {
      return;
    }
    if (this._portSearchRetryTimer) {
      return;
    }
    if (this._portSearchRoundTimer) {
      clearTimeout(this._portSearchRoundTimer);
      this._portSearchRoundTimer = null;
    }

    const controller = this.portSearchController;
    if (!controller) {
      return;
    }

    const failed = controller.failAttempt(reason || 'retry');
    if (!failed.accepted || failed.status === 'exhausted') {
      this._portSearchGeneration += 1;
      this.renderPortSearchStatus();
      this.updateNetworkUI('端口搜索已达上限，未自动切换 TURN 或媒体隧道。', 'danger');
      if (typeof Diagnostic !== 'undefined' && typeof Diagnostic.autoSendFailure === 'function') {
        Diagnostic.autoSendFailure('stun-port-search-exhausted');
      }
      return;
    }

    const generation = this._portSearchGeneration;
    const delayMs = Number(this.PORT_SEARCH_RETRY_DELAY_MS) || 250;
    this._portSearchRetryTimer = setTimeout(() => {
      this._portSearchRetryTimer = null;
      if (generation !== this._portSearchGeneration) {
        return;
      }
      if (!this.isPortSearchActive() || this.manualDisconnect) {
        return;
      }
      const next = controller.beginAttempt(reason || 'retry');
      if (!next.accepted) {
        this._portSearchGeneration += 1;
        this.renderPortSearchStatus();
        this.updateNetworkUI('端口搜索已达上限，未自动切换 TURN 或媒体隧道。', 'danger');
        return;
      }
      this._portSearchGeneration += 1;
      this.renderPortSearchStatus();
      this._portSearchRefreshOwned = true;
      try {
        this.refresh();
      } finally {
        this._portSearchRefreshOwned = false;
      }
      this.armPortSearchDeadline();
    }, delayMs);
  },

  handlePortSearchMedia(stats) {
    if (!this.isPortSearchActive() || !this.portSearchController) {
      return;
    }
    const snap = this.portSearchController.observeMedia(stats || {});
    if (snap.status === 'succeeded') {
      this.clearPortSearchTimers();
      this._portSearchGeneration += 1;
      this.renderPortSearchStatus();
      console.log('[PORT-SEARCH] succeeded at attempt', snap.attempt);
      return;
    }
    if (this.isPortSearchActive()) {
      this.renderPortSearchStatus();
    }
  },
  
  setupSocketListeners() {
    this.socket.on('connect', async () => {
      console.log('[OFFER-DBG] Socket connect: offerInProgress=%s pc=%s pcState=%s',
        this.offerInProgress, !!this.pc, this.pc?.connectionState);
      if (typeof StartupTelemetry !== 'undefined' && StartupTelemetry?.mark) {
        StartupTelemetry.mark('signal-connected');
      }
      if (this.uiPhase === 'disconnected' || this.uiPhase === 'signaling') {
        this.setUiPhase('signaling', { reason: 'signal-connected' });
      }
      if (typeof Diagnostic !== 'undefined' && typeof Diagnostic.replayPendingDiagnostics === 'function') {
        await Diagnostic.replayPendingDiagnostics(this.socket);
      }
      // Reset offerInProgress on reconnect to prevent stuck state
      if (this.offerInProgress) {
        console.warn('[OFFER-DBG] Resetting stuck offerInProgress on reconnect');
        this.offerInProgress = false;
      }
      // While startViewer awaits bootstrap, keep PC deferred so ICE servers are applied first.
      if (!this._deferPeerUntilConfig
        && (!this.pc || ['failed', 'closed'].includes(this.pc.connectionState))) {
        this.createPeerConnection();
        console.log('[OFFER-DBG] Created new PC on reconnect, pcState=%s', this.pc?.connectionState);
      }
      this.renderPortSearchStatus();
      this.bindCurrentConnectionAttempt();
      this.replayMediaActivityIntent('socket-connect');
    });

    this.socket.on('connected', (data) => {
      console.log('[OFFER-DBG] Connected event: hostOnline=%s offerInProgress=%s pc=%s pcState=%s',
        data.hostOnline, this.offerInProgress, !!this.pc, this.pc?.connectionState);

      this.controlState.hostOnline = Boolean(data.hostOnline);
      this.applyHostCapabilities(data.hostCapabilities);
      this.renderPortSearchStatus();
      if (data.hostOnline) {
        this.requestControl({ allowTakeover: false });
      } else {
        updateLoadingText('等待Host上线...');
      }
    });

    this.socket.on('host-status', (data) => {
      console.log('[OFFER-DBG] host-status event: online=%s offerInProgress=%s pc=%s',
        data.online, this.offerInProgress, !!this.pc);
      if (data.online) {
        this.controlState.hostOnline = true;
        this.applyHostCapabilities(data.hostCapabilities);
        this.renderPortSearchStatus();
        updateLoadingText('Host已上线，正在连接...');
        if (!this._deferPeerUntilConfig
          && (!this.pc || ['failed', 'closed'].includes(this.pc.connectionState))) {
          this.createPeerConnection();
        }
        // Force a new offer if the previous one is stuck
        if (this.offerInProgress) {
          console.warn('[NETWORK] Host came online but offerInProgress=true; forcing new offer');
          this.offerInProgress = false;
        }
        if (!this._deferPeerUntilConfig) {
          this.requestControl({ allowTakeover: false });
        }
      } else {
        this.controlState.hostOnline = false;
        this.applyHostCapabilities({ turnReady: false, turnFingerprint: '', supportsSessionTurn: false });
        if (this.isPortSearchActive()) {
          this.stopPortSearch('host-offline');
        } else {
          this.renderPortSearchStatus();
        }
        this.freezeControl('host-offline');
        this.setUiPhase('disconnected', { reason: 'host-offline' });
        updateLoadingText('Host已离线');
      }
    });

    this.socket.on('host-capabilities', (data) => {
      this.applyHostCapabilities(data);
    });

    this.socket.on('answer', async (data) => {
      console.log('Received answer');
      if (!this.pc || this.pc.signalingState !== 'have-local-offer') {
        console.warn('[NETWORK] Ignoring stale answer: pc=%s, signalingState=%s',
          !!this.pc, this.pc?.signalingState);
        return;
      }
      try {
        await this.pc.setRemoteDescription(new RTCSessionDescription(data.answer));
      } catch (err) {
        console.error('Failed to set remote description:', err);
      }
    });

    this.socket.on('ice-candidate', async (data) => {
      if (!this.pc || this.pc.signalingState === 'closed') {
        console.warn('[NETWORK] Ignoring ICE candidate: no active PC');
        return;
      }
      try {
        this.recordPortSearchCandidate('host', data.candidate);
        this.addCandidateSample('remote', data.candidate);
        await this.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (err) {
        console.error('Failed to add ICE candidate:', err);
      }
    });

    this.socket.on('input-ack', (data) => {
      if (typeof Input !== 'undefined' && typeof Input.acceptKeyboardAck === 'function') {
        Input.acceptKeyboardAck(data);
      }
      if (typeof LatencyMonitor !== 'undefined') {
        LatencyMonitor.onInputAck(data);
      }
    });

    this.socket.on('viewer-superseded', (data) => {
      this.handleViewerSuperseded(data || {});
    });

    this.socket.on('disconnect', (reason) => {
      console.log('Signaling disconnected', reason || '');
      if (this._superseded) {
        return;
      }
      if (reason === 'io server disconnect') {
        this.handleViewerSuperseded({ reason: 'server-kick', bySocketId: null });
        return;
      }
      this.setUiPhase('disconnected', { reason: 'signal-disconnect' });
      document.getElementById('remoteVideo')?.classList.remove('connected');
      this.freezeControl('signal-disconnect');
      if (this.isPortSearchActive()) {
        this.stopPortSearch('signal-disconnect');
      } else {
        this.renderPortSearchStatus();
      }
      if (this.networkMode === 'tunnel' && !this.manualDisconnect && !this._superseded) {
        this.scheduleReconnect('signal-disconnected');
      }
    });

    this.socket.on('relay-frame', (data) => {
      this.handleRelayFrame(data);
    });
    this.socket.on('control-state', (data) => this.handleControlState(data));
    this.socket.on('control-grant', (data) => this.handleControlGrant(data));
    this.socket.on('control-acquire-result', (data) => this.handleControlAcquireResult(data));
    this.socket.on('control-revoked', () => this.freezeControl('control-revoked'));
    this.socket.on('control-transition-failed', () => this.freezeControl('control-transition-failed'));
    this.socket.on('control-heartbeat-rejected', () => this.freezeControl('control-heartbeat-rejected'));
    this.socket.on('media-activity-ack', (data) => this.handleMediaActivityAck(data));
    this.socket.on('relay-stream-control-ack', (data) => this.handleMediaActivityAck(data));
    this.socket.on('relay-stream-control-rejected', (data) => {
      this.handleMediaRequestFailure(data?.reason || 'relay-stream-control-rejected');
    });
    this.socket.on('media-activity-rejected', (data) => {
      this.handleMediaRequestFailure(data?.reason || 'media-activity-rejected');
    });
  },

  hasActiveControl() {
    return Boolean(this.controlState?.controller && this.controlState?.state === 'ACTIVE' && this.controlState?.lease);
  },

  rebindActiveKeyboardLease(reason = 'rebind') {
    if (!this.hasActiveControl()) return false;
    const lease = this.controlState.lease;
    if (!lease || typeof Input === 'undefined') return false;
    Input.setControlLease(lease);
    Input.setKeyboardDataChannelAvailable?.(this.inputChannel?.readyState === 'open');
    Input.updateKeyboardUI?.();
    return true;
  },

  activeLeaseEnvelope() {
    if (!this.hasActiveControl()) return null;
    const lease = this.controlState.lease;
    return { schemaVersion: 2, leaseId: lease.leaseId, leaseEpoch: lease.leaseEpoch };
  },

  requestControl({ allowTakeover = true } = {}) {
    if (!this.socket?.connected || !this.controlState.hostOnline) return false;
    if (this.isControlResetBlocked() || this.controlState.state === 'GRANTING' || this.controlState.state === 'REVOKING') {
      // Do not paint a sticky "切换中" that ignores later acquire-result.
      this.updateControlUI();
      return false;
    }
    // Automatic paths must not silently steal an existing ACTIVE controller.
    if (this.controlState.state === 'ACTIVE' && !this.controlState.controller && !allowTakeover) {
      return false;
    }
    const requestId = `control-${Date.now()}-${++this._controlRequestId}`;
    const takeover = this.controlState.state === 'ACTIVE' && !this.controlState.controller && allowTakeover;
    this._controlAcquireRequestId = requestId;
    this.socket.emit('control-acquire', { requestId, takeover });
    // Optimistic label only; handleControlAcquireResult / control-state own the truth.
    this.updateControlUI('控制权正在切换');
    return true;
  },

  handleControlAcquireResult(data = {}) {
    if (data.requestId && this._controlAcquireRequestId && data.requestId !== this._controlAcquireRequestId) {
      return;
    }
    const state = data.state || this.controlState.state;
    this.controlState = {
      ...this.controlState,
      state,
      reason: data.reason || this.controlState.reason || null,
      controllerViewerId: Object.prototype.hasOwnProperty.call(data, 'controllerViewerId')
        ? data.controllerViewerId
        : this.controlState.controllerViewerId,
      pendingViewerId: Object.prototype.hasOwnProperty.call(data, 'pendingViewerId')
        ? data.pendingViewerId
        : this.controlState.pendingViewerId,
    };
    // Rejected/occupied paths never get control-grant; clear sticky switching copy.
    if (state === 'GRANTING' || state === 'REVOKING') {
      this.updateControlUI();
      return;
    }
    if (data.reason && state !== 'ACTIVE') {
      const reasonText = {
        'occupied': '控制权正忙（可能在 Host 复位），请稍后再试',
        'host-offline': 'Host 离线，无法获取控制权',
        'host-protocol-too-old': 'Host 协议过旧，无法获取控制权',
        'legacy-input-disabled': '旧版输入协议已禁用',
        'reset-in-progress': 'Host 正在复位输入，请稍后再请求控制',
        'reset-blocked': 'Host 输入复位未确认，控制已安全锁定',
      }[data.reason];
      this.updateControlUI(reasonText || null);
      return;
    }
    this.updateControlUI();
  },

  handleControlState(data = {}) {
    this.controlState = { ...this.controlState, ...data, lease: data.controller ? this.controlState.lease : null };
    // During GRANTING/REVOKING, controller is false for everyone — do not treat as
    // permanent readonly freeze (that raced with acquire and left sticky UI).
    const transitioning = data.state === 'GRANTING' || data.state === 'REVOKING';
    if (!data.controller && !transitioning) {
      this.freezeControl(data.reason || 'control-readonly', false);
    } else if (!data.controller && transitioning) {
      this.controlState = { ...this.controlState, controller: false, lease: null };
      this.stopControlHeartbeat();
      if (typeof Input !== 'undefined') {
        Input.setActive(false);
        Input.setControlLease(null);
      }
    }
    if (this.isPortSearchActive() && !this.canStartPortSearch()) {
      this.stopPortSearch('control-lost');
      this.updateNetworkUI('端口搜索已停止：控制权已失效', 'warning');
    } else {
      this.renderPortSearchStatus();
    }
    this.updateControlUI();
  },

  handleControlGrant(data = {}) {
    if (!data.controller || typeof data.leaseId !== 'string' || !Number.isInteger(data.leaseEpoch)) {
      this.freezeControl('invalid-control-grant');
      return;
    }
    this.controlState = { ...this.controlState, state: 'ACTIVE', controller: true, lease: { leaseId: data.leaseId, leaseEpoch: data.leaseEpoch } };
    if (typeof Input !== 'undefined') {
      Input.init();
      Input.setControlLease(this.controlState.lease);
    }
    this.startControlHeartbeat();
    this.updateControlUI();
    this.bindCurrentConnectionAttempt();
    // Enable input immediately when this attempt already painted; do not wait for
    // the next decoded frame (relay regularly has multi-second 0-FPS gaps).
    this.syncDesktopInputGate();
    // Control grant is the first moment Host will accept media-activity writes.
    // Clear any stale page-hidden suspend and push active while the tab is visible.
    this.ensureMediaActiveIfVisible('control-grant');
    if (this.networkMode === 'tunnel') {
      if (this.getMediaActivitySnapshot().state === 'active') this.startTunnelRelay();
      this.replayMediaActivityIntent('control-regrant');
    } else {
      const pcState = this.pc?.connectionState;
      const dcOpen = this.inputChannel?.readyState === 'open';
      const live = pcState === 'connected' && (dcOpen || this._refreshing);
      if (!live) {
        if (!this.pc || ['failed', 'closed', 'disconnected'].includes(pcState)) {
          this.createPeerConnection();
        }
        this.createOffer();
      }
      this.replayMediaActivityIntent('control-regrant');
    }
  },

  freezeControl(reason, reset = true) {
    this.stopControlHeartbeat();
    // Do not clear _mediaReadyConnectionAttemptId here. Control ownership and
    // "has this attempt painted" are independent; clearing readiness on every
    // revoke/visibility freeze left re-grant blocked until the next frame, which
    // may not arrive for seconds on full-relay survival profiles.
    if (typeof Input !== 'undefined') {
      // Reset keyboard while lease is still present so the envelope can send.
      if (reset) Input.resetKeyboard?.(reason || 'control-lost');
      Input.releasePointer?.(reason || 'control-lost');
      Input.setControlLease(null);
      Input.setActive(false, { resetKeyboard: false, reason: reason || 'control-lost' });
    }
    this.controlState = { ...this.controlState, controller: false, lease: null };
    if (this.isPortSearchActive()) {
      this.stopPortSearch(reason === 'host-offline' ? 'host-offline' : 'control-lost');
    } else {
      this.renderPortSearchStatus();
    }
    this.updateControlUI();
  },

  startControlHeartbeat() {
    this.stopControlHeartbeat();
    this._controlHeartbeatTimer = setInterval(() => {
      const lease = this.controlState.lease;
      if (this.hasActiveControl() && this.socket?.connected) {
        this.socket.emit('control-heartbeat', { leaseId: lease.leaseId, leaseEpoch: lease.leaseEpoch });
      }
    }, 3000);
  },

  stopControlHeartbeat() {
    if (this._controlHeartbeatTimer) clearInterval(this._controlHeartbeatTimer);
    this._controlHeartbeatTimer = null;
  },

  // DataChannel application-layer keepalive.
  // Sends a small ping every 15 seconds to:
  //   1. Prevent SCTP association from timing out on idle relay paths.
  //   2. Maintain Chrome's "open RTCDataChannel" exemption from intensive
  //      background-tab throttling (Chrome 88+) and Energy Saver freeze
  //      (Chrome 133+). Without an active DataChannel, Chrome may freeze the
  //      tab after 5 minutes in the background.
  startDcKeepalive() {
    this.stopDcKeepalive();
    this._dcKeepaliveTimer = setInterval(() => {
      const ch = this.inputChannel;
      if (ch && ch.readyState === 'open') {
        try {
          ch.send(JSON.stringify({ type: 'dc_keepalive' }));
        } catch (_) {
          // Ignore: if the channel is closing the send will throw; onclose
          // will handle recovery. Do not call stopDcKeepalive here — the
          // interval must keep running until onclose fires to avoid a race
          // where stop is called before the channel close is fully processed.
        }
      }
    }, 15000);
  },

  stopDcKeepalive() {
    if (this._dcKeepaliveTimer) { clearInterval(this._dcKeepaliveTimer); }
    this._dcKeepaliveTimer = null;
  },

  releaseControl(reason) {
    const wasActive = this.hasActiveControl();
    if (typeof Input !== 'undefined') Input.resetKeyboard?.(reason);
    if (wasActive && this.socket?.connected) this.socket.emit('control-release', { reason });
    this.freezeControl(reason, false);
  },

  bindControlLifecycle() {
    if (this._controlLifecycleBound) return;
    this._controlLifecycleBound = true;
    // visibility-hidden is a keyboard/pointer reset reason, not a control release.
    // Releasing the lease on every tab hide made "请求控制" appear to work while
    // subsequent clicks silently no-oped until the user noticed readonly UI.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (typeof Input !== 'undefined') {
          Input.releasePointer?.('visibility-hidden');
          if (this.inputChannel?.readyState === 'open') {
            Input.resetKeyboard?.('visibility-hidden');
          } else {
            Input.parkKeyboard?.('visibility-hidden');
          }
        }
        return;
      }
      if (this._refreshing || this.manualDisconnect) {
        if (this.hasActiveControl()) this.syncDesktopInputGate();
        this.ensureMediaActiveIfVisible('visibility-visible');
        this.rebindActiveKeyboardLease('visibility-visible');
        return;
      }
      if (this.pc?.connectionState === 'connected' && this.inputChannel?.readyState !== 'open') {
        if (this.pc.sctp?.state === 'connected') {
          Promise.resolve(this.rebuildDataChannels('dc-dead-on-resume')).then((ok) => {
            if (!ok && !this._refreshing) this.refresh({ reason: 'dc-dead-on-resume' });
            this.rebindActiveKeyboardLease('visibility-visible');
          });
        } else {
          this.refresh({ reason: 'dc-dead-on-resume' });
          this.rebindActiveKeyboardLease('visibility-visible');
        }
        return;
      }
      if (this.hasActiveControl()) this.syncDesktopInputGate();
      // Returning to the tab must not leave Host suspended with a black frame.
      this.ensureMediaActiveIfVisible('visibility-visible');
      this.rebindActiveKeyboardLease('visibility-visible');
    });
    window.addEventListener?.('beforeunload', () => this.releaseControl('viewer-disconnect'));
  },

  isControlResetBlocked() {
    const reason = this.controlState?.reason;
    return this.controlState?.state === 'REVOKING'
      && (reason === 'reset-blocked'
        || reason === 'reset-failed'
        || reason === 'transition-timeout'
        || reason === 'execution-failed'
        || reason === 'transition-failed');
  },

  updateControlUI(status) {
    const transitioning = this.controlState.state === 'GRANTING' || this.controlState.state === 'REVOKING';
    const resetBlocked = this.isControlResetBlocked();
    if (!status && !this.controlState.controller) {
      if (resetBlocked) status = 'Host 输入复位未确认，控制已安全锁定';
      else if (transitioning) status = '控制权正在切换';
      else status = '只读';
    }
    const label = status
      || (this.hasActiveControl()
        ? '已控制'
        : (this.controlState.state === 'FREE' ? '只读' : (resetBlocked ? 'Host 输入复位未确认，控制已安全锁定' : '控制权正在切换')));
    const statusEl = document.getElementById('controlStatus');
    const button = document.getElementById('requestControlBtn');
    if (statusEl) statusEl.textContent = label;
    if (button) {
      button.hidden = this.hasActiveControl() || transitioning || resetBlocked;
      button.disabled = transitioning || resetBlocked;
      button.textContent = this.controlState.state === 'ACTIVE' && !this.controlState.controller ? '请求接管' : '请求控制';
      const dataset = button.dataset || (button.dataset = {});
      if (!dataset.controlBound) {
        dataset.controlBound = 'true';
        button.addEventListener('click', (event) => { event.preventDefault(); this.requestControl(); });
      }
    }
  },

  STABLE_RECOVERY_RESET_MS: 5000,
  armStableRecoveryReset() {
    if (this._stableResetTimer) clearTimeout(this._stableResetTimer);
    this._stableResetTimer = setTimeout(() => {
      this._stableResetTimer = null;
      if (this.pc?.connectionState !== 'connected') return;
      this._reconnectAttempt = 0;
      this._relayHardRefreshCount = 0;
      this._mediaResumeSoftRecoverUsed = false;
      this._mediaResumeRefreshFallbackUsed = false;
    }, this.STABLE_RECOVERY_RESET_MS);
    this._stableResetTimer.unref?.();
  },

  onPeerConnected() {
    if (this._refreshing) {
      if (this.inputChannel?.readyState === 'open') {
        this.markRefreshSettled('pc-connected');
      } else {
        const waitTimer = setTimeout(() => {
          this.markRefreshSettled('pc-connected-dc-wait');
        }, 2000);
        waitTimer.unref?.();
      }
    }
    // Cancel any pending disconnected-recovery timers
    if (this._disconnectedTimer) {
      clearTimeout(this._disconnectedTimer);
      this._disconnectedTimer = null;
      console.log('[RECOVERY] PC recovered from disconnected, canceling scheduled reconnect');
    }
    if (this._iceDisconnectedTimer) {
      clearTimeout(this._iceDisconnectedTimer);
      this._iceDisconnectedTimer = null;
      console.log('[RECOVERY] ICE recovered from disconnected, canceling scheduled reconnect');
    }
    console.log('WebRTC connected, initializing input...');
    // Start stats ASAP — before any other init that could throw
    this.startStats();
    this.startVideoFrameTracking();
    this.syncMediaProfile();
    this.clearFailureRecommendation();
    this.updateNetworkUI('媒体链路已连接');
    this._autoFailCount = 0;
    this._iceRestartAttempts = 0;
    this._inputDcDegraded = false;
    if (this._mediaResumeArmPending) {
      this.ensureMediaResumeFallbackArmed('pc-connected');
    }
    // Connected + visible ⇒ do not stay black due to a stuck page-hidden suspend.
    this.ensureMediaActiveIfVisible('pc-connected');
    if (this.isPortSearchActive()) {
      this.armPortSearchDeadline();
    }

    // Safety net: peer is up, but painted frames are still required for 已连接.
    if (!this.hasPaintedFrame) {
      this.setUiPhase('media-pending', { reason: 'pc-connected' });
      updateLoadingText('正在等待第一帧');
    }
    // Stop tunnel relay if it was running (auto fallback case)
    if (this.tunnelRelayActive) {
      console.log('[NETWORK] WebRTC connected, stopping tunnel relay');
      this.stopTunnelRelay();
    }
    if (typeof Input !== 'undefined') {
      Input.init();
      this.syncDesktopInputGate();
    }
    // Start latency clock sync after connection is stable
    setTimeout(() => {
      if (typeof LatencyMonitor !== 'undefined') {
        LatencyMonitor.requestClockSync();
        // Re-sync every 30 seconds
        if (!this._latencySyncInterval) {
          this._latencySyncInterval = setInterval(() => {
            if (typeof LatencyMonitor !== 'undefined') {
              LatencyMonitor.requestClockSync();
            }
          }, 30000);
        }
      }
    }, 2000);
    this.armStableRecoveryReset();
  },

  createPeerConnection() {
    if (this.networkMode === 'tunnel') {
      return;
    }
    if (this.networkMode === 'relay' && !this.hasTurnConfigured()) {
      this.setFailureRecommendation('relay-unavailable-no-turn', 'warning');
      this.enterUnavailableRelayState('外网中继当前不可用，请手动切换到“隧道中继”或补全 TURN 配置。');
      return;
    }
    this.config = this.buildPeerConfig();
    this.resetCandidateSummary();
    this.noMediaTicks = 0;
    this._noRelayReceiveCount = 0;
    this.lastCandidateType = '';
    this.selectedCandidatePair = null;
    if (this._dcTimeout) { clearTimeout(this._dcTimeout); this._dcTimeout = null; }
    this.pc = new RTCPeerConnection(this.config);
    this.videoTransceiver = null;
    this.inputChannel = null;
    this.inputMoveChannel = null;

    console.log('Creating RTCPeerConnection with config:', this.config);
    this.updateNetworkUI('正在建立媒体链路...');
    this.createInputChannel();

    this.pc.onicecandidate = (event) => {
      console.log('Viewer ICE candidate:', event.candidate);
      if (event.candidate) {
        this.recordPortSearchCandidate('viewer', event.candidate);
        this.addCandidateSample('local', event.candidate);
        this.socket.emit('ice-candidate', {
          target: 'host',
          candidate: event.candidate
        });
      }
    };

    this.pc.onicegatheringstatechange = () => {
      console.log('Viewer ICE gathering state:', this.pc.iceGatheringState);
    };

    this.pc.oniceconnectionstatechange = () => {
      console.log('Viewer ICE connection state:', this.pc.iceConnectionState);
      if (this.pc.iceConnectionState === 'connected' || this.pc.iceConnectionState === 'completed') {
        if (this._mediaResumeArmPending) {
          this.ensureMediaResumeFallbackArmed('ice-connected');
        }
      } else if (this._refreshing) {
        return;
      } else if (this.pc.iceConnectionState === 'disconnected') {
        // Disconnected is often temporary; wait 5s for auto-recovery before forcing reconnect
        if (this._iceDisconnectedTimer) return;
        console.warn('[RECOVERY] ICE disconnected, waiting 5s for auto-recovery...');
        this._iceDisconnectedTimer = setTimeout(() => {
          this._iceDisconnectedTimer = null;
          if (this.pc && this.pc.iceConnectionState === 'connected') {
            console.log('[RECOVERY] ICE recovered, skipping reconnect');
            return;
          }
          this.scheduleReconnect('ice-disconnected');
        }, 5000);
      } else if (['failed', 'closed'].includes(this.pc.iceConnectionState)) {
        this.scheduleReconnect(`ice-${this.pc.iceConnectionState}`);
      }
    };

    this.pc.onconnectionstatechange = () => {
      console.log('Viewer Connection state:', this.pc.connectionState);
      if (this.pc.connectionState === 'connected') {
        this.onPeerConnected();
      } else if (this._refreshing) {
        return;
      } else if (['failed', 'disconnected', 'closed'].includes(this.pc.connectionState)) {
        if (this._stableResetTimer) {
          clearTimeout(this._stableResetTimer);
          this._stableResetTimer = null;
        }
        this.stopMediaTelemetry();
        if (typeof Input !== 'undefined') {
          Input.setActive(false);
        }
        if (this._latencySyncInterval) {
          clearInterval(this._latencySyncInterval);
          this._latencySyncInterval = null;
        }
        this.updateNetworkUI('媒体链路失败，请按浮窗建议切换网络模式', 'danger');
        if (this.pc.connectionState === 'disconnected') {
          if (this._disconnectedTimer) return;
          console.warn('[RECOVERY] PC disconnected, waiting 5s for auto-recovery...');
          this._disconnectedTimer = setTimeout(() => {
            this._disconnectedTimer = null;
            if (this.pc && this.pc.connectionState === 'connected') {
              console.log('[RECOVERY] PC recovered, skipping reconnect');
              return;
            }
            this.scheduleReconnect('pc-disconnected');
          }, 5000);
        } else {
          this.scheduleReconnect(`pc-${this.pc.connectionState}`);
        }
      }
    };

    this.pc.onsignalingstatechange = () => {
      console.log('Viewer Signaling state:', this.pc.signalingState);
    };

    this.pc.ontrack = (event) => {
      console.log('Received remote track:', event.track.kind, 'streams:', event.streams.length);
      this.remoteStream = event.streams[0];

      const videoElement = document.getElementById('remoteVideo');
      videoElement.srcObject = this.remoteStream;

      // Reduce jitter buffer aggressively for remote desktop (Chrome/Edge only)
      const receivers = this.pc.getReceivers ? this.pc.getReceivers() : [];
      receivers.forEach(receiver => {
        this.configureVideoReceiver(receiver);
      });

      videoElement.muted = true;
      videoElement.play().then(() => {
        console.log('Video playback started (promise)');
      }).catch(err => {
        console.error('Video play failed:', err);
      });

      const tryPaintGate = () => {
        if (videoElement.videoWidth > 0 && videoElement.videoHeight > 0 && videoElement.readyState >= 2) {
          this.notePaintStats({
            framesDecoded: this._lastInboundFramesDecoded || 0,
            framesReceived: 0,
            fps: 0,
            videoWidth: videoElement.videoWidth,
            videoHeight: videoElement.videoHeight,
            source: 'video-element',
          });
        }
      };

      this.markRemoteTrack({
        readyState: videoElement.readyState,
        paused: videoElement.paused,
      });

      if (videoElement.readyState >= 1) {
        tryPaintGate();
      } else {
        videoElement.onloadedmetadata = () => {
          console.log('Video metadata loaded:', videoElement.videoWidth, 'x', videoElement.videoHeight);
          tryPaintGate();
        };
      }

      videoElement.onplaying = () => {
        console.log('Video is now playing');
        tryPaintGate();
      };

      this.remoteStream.getTracks().forEach(track => {
        console.log('Track:', track.kind, 'enabled:', track.enabled, 'state:', track.readyState);
      });

      // Ask Host for an IDR ASAP so formal cold first-frame is not stuck on an inter-frame.
      if (event.track?.kind === 'video') {
        this.requestKeyframe('ontrack-first-video');
        setTimeout(() => this.requestKeyframe('ontrack-first-video-retry'), 700);
      }

      // Last-resort fallback: stay media-pending unless a decoded frame actually landed.
      setTimeout(() => {
        const video = document.getElementById('remoteVideo');
        console.warn('[LOADING] Fallback timeout: readyState=%s paused=%s size=%sx%s painted=%s',
          video ? video.readyState : 'no-video',
          video ? video.paused : 'no-video',
          video ? video.videoWidth : 0,
          video ? video.videoHeight : 0,
          this.hasPaintedFrame);
        this.applyPaintFallback();
      }, 8000);
    };
  },

  createInputChannel() {
    if (!this.pc || this.inputChannel) {
      return;
    }

    const inputChannel = this.pc.createDataChannel('input', {
      ordered: true
    });
    this.inputChannel = inputChannel;
    inputChannel.bufferedAmountLowThreshold = 32 * 1024;
    this.inputMoveChannel = this.pc.createDataChannel('input-move', {
      ordered: false,
      maxRetransmits: 0
    });
    this.inputMoveChannel.bufferedAmountLowThreshold = 4 * 1024;

    // Timeout detection: check PC state before forcing reconnect.
    // If ICE/DTLS is still in progress, extend timeout instead of cascading.
    this._dcTimeoutExtensions = 0;
    const checkDcTimeout = () => {
      if (this.inputChannel && this.inputChannel.readyState !== 'open') {
        const pcState = this.pc ? this.pc.connectionState : 'closed';
        const iceState = this.pc ? this.pc.iceConnectionState : 'closed';
        console.warn('[INPUT-DC] DataChannel stuck state=%s pc=%s ice=%s ext=%d',
          this.inputChannel.readyState, pcState, iceState, this._dcTimeoutExtensions);
        if ((pcState === 'connecting' || iceState === 'checking') && this._dcTimeoutExtensions < 2) {
          this._dcTimeoutExtensions += 1;
          this._dcTimeout = setTimeout(checkDcTimeout, 10000);
          return;
        }
        this.noteDataChannelFault('dc-stuck');
      }
    };
    this._dcTimeout = setTimeout(checkDcTimeout, 10000);

    inputChannel.onopen = () => {
      if (this.inputChannel !== inputChannel) return;
      if (this._refreshing) this.markRefreshSettled('dc-open');
      console.log('[INPUT-DC] DataChannel open');
      if (this._dcTimeout) { clearTimeout(this._dcTimeout); this._dcTimeout = null; }
      this._inputDcDegraded = false;
      if (typeof Input !== 'undefined') Input.setKeyboardDataChannelAvailable?.(true);
      if (typeof Input !== 'undefined') Input.updateKeyboardUI?.();
      this.rebindActiveKeyboardLease('dc-open');
      // Start keepalive to prevent SCTP idle timeout and maintain Chrome's
      // "open DataChannel" exemption from background tab intensive throttling.
      this.startDcKeepalive();
    };
    inputChannel.onclose = () => {
      if (this.inputChannel !== inputChannel) return;
      const sctpState = this.pc && this.pc.sctp ? this.pc.sctp.state : 'no-sctp';
      console.log('[INPUT-DC] DataChannel closed, sctp=%s pc=%s ice=%s',
        sctpState,
        this.pc ? this.pc.connectionState : 'no-pc',
        this.pc ? this.pc.iceConnectionState : 'no-pc');
      if (this._dcTimeout) { clearTimeout(this._dcTimeout); this._dcTimeout = null; }
      this.stopDcKeepalive();
      if (typeof Input !== 'undefined') Input.setKeyboardDataChannelAvailable?.(false);
      // Defer reconnect to avoid cascading on brief DC hiccups
      if (!this._refreshing && !this.manualDisconnect && this.pc &&
          this.pc.connectionState === 'connected') {
        if (this._dcReconnectTimer) return;
        console.warn('[INPUT-DC] Unexpected close while PC connected, will reconnect in 3s if not recovered');
        this._dcReconnectTimer = setTimeout(() => {
          this._dcReconnectTimer = null;
          if (this.manualDisconnect || !this.pc || this.pc.connectionState !== 'connected') return;
          this.noteDataChannelFault('dc-closed');
        }, 3000);
      }
    };
    inputChannel.onerror = (event) => {
      if (this.inputChannel !== inputChannel) return;
      console.warn('[INPUT-DC] DataChannel error:', event);
      if (typeof Input !== 'undefined') Input.setKeyboardDataChannelAvailable?.(false);
      // Error typically precedes close; defer reconnect to avoid cascading
      if (!this._refreshing && !this.manualDisconnect && this.pc &&
          this.pc.connectionState === 'connected') {
        if (this._dcReconnectTimer) return;
        this._dcReconnectTimer = setTimeout(() => {
          this._dcReconnectTimer = null;
          if (this.manualDisconnect || !this.pc || this.pc.connectionState !== 'connected') return;
          this.noteDataChannelFault('dc-error');
        }, 3000);
      }
    };
    inputChannel.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        // Latency measurement messages
        if (data.type === 'frame_timing') {
          if (typeof LatencyMonitor !== 'undefined') {
            LatencyMonitor.onFrameTiming(data);
          }
          return;
        }
        if (data.type === 'clock_sync_resp') {
          if (typeof LatencyMonitor !== 'undefined') {
            LatencyMonitor.handleClockSyncResponse(data);
          }
          return;
        }
        if (data.type === 'input_ack') {
          if (typeof Input !== 'undefined' && typeof Input.acceptKeyboardAck === 'function') {
            Input.acceptKeyboardAck(data);
          }
          if (typeof LatencyMonitor !== 'undefined') {
            LatencyMonitor.onInputAck(data);
          }
          return;
        }
        // Host capture fps is not playback fps; keep it off the status-bar counter.
        if (data.type === 'capture_stats') {
          if (data.fps !== undefined) {
            this._hostCaptureFps = Number(data.fps) || 0;
          }
          return;
        }
      } catch (e) {
        // Silently ignore non-JSON or unexpected messages
      }
    };
    this.inputMoveChannel.onopen = () => {
      console.log('[INPUT-DC] Move DataChannel open');
    };
    this.inputMoveChannel.onclose = () => {
      console.log('[INPUT-DC] Move DataChannel closed');
    };
    this.inputMoveChannel.onerror = (event) => {
      console.warn('[INPUT-DC] Move DataChannel error:', event);
    };
  },

  sendInput(data) {
    const isMouseMove = data.type === 'mouse' && data.action === 'move';
    const channel = isMouseMove && this.inputMoveChannel?.readyState === 'open'
      ? this.inputMoveChannel
      : this.inputChannel;

    if (!channel || channel.readyState !== 'open') {
      return false;
    }

    if (isMouseMove && channel.bufferedAmount > 4 * 1024) {
      return true;
    }

    if (!isMouseMove && channel.bufferedAmount > 512 * 1024) {
      console.warn('[INPUT-DC] Buffered amount too high, falling back to Socket.IO:', channel.bufferedAmount);
      return false;
    }

    channel.send(JSON.stringify({
      ...data,
      transport: 'datachannel'
    }));
    return true;
  },

  startTunnelRelay() {
    if (!this.hasActiveControl()) {
      this.requestControl({ allowTakeover: false });
      return;
    }
    if (!this.canStartTunnelRelay()) {
      return;
    }
    if (!this.socket || !this.socket.connected) {
      return;
    }
    if (this.pc) {
      // Closing the old WebRTC transport is intentional when tunnel takes
      // ownership. Its closed callbacks must not schedule a later refresh
      // that tears down the newly started relay producer.
      this.pc.oniceconnectionstatechange = null;
      this.pc.onconnectionstatechange = null;
      this.pc.onsignalingstatechange = null;
      this.pc.onicegatheringstatechange = null;
      this.pc.onicecandidate = null;
      this.pc.ontrack = null;
      this.pc.close();
      this.pc = null;
    }
    this.stopMediaTelemetry();
    this._tunnelLockUntil = Date.now() + 30000;
    this.tunnelRelayActive = true;
    this.tunnelFrameCount = 0;
    // Host start() restarts its sequence from zero. A prior producer must not
    // cause the new stream's first frame to be discarded as stale.
    this.tunnelLastFrameId = 0;
    this._lastRenderedRelayFrame = null;
    this.tunnelStartedAt = performance.now();
    document.body.classList.add('tunnel-relay-active');
    document.getElementById('loading')?.classList.remove('hidden');
    document.getElementById('loading')?.classList.add('is-connecting');
    updateLoadingText('正在启动隧道中继...');
    this.setUiPhase('signaling', { reason: 'tunnel-start' });
    this.updateNetworkUI('隧道中继正在启动。该模式走 Cloudflare/Socket.IO，不依赖 WebRTC UDP。', 'warning');
    this.emitRelayStreamControl();
  },

  getTunnelRelayRequestSize() {
    // Cap at medium profile dimensions. Host never starts tunnel at "high";
    // adaptive ACK feedback can step up later if the path is healthy.
    const width = Math.min(Number(this.currentResolution?.width) || 960, 960);
    const height = Math.min(Number(this.currentResolution?.height) || 540, 540);
    return {
      width: Math.max(320, width),
      height: Math.max(180, height),
      fps: 6,
    };
  },

  canStartTunnelRelay({ allowResuming = false } = {}) {
    if (this.getMediaActivitySnapshot().state !== 'active') return false;
    const phase = this.getMediaAppliedPhase();
    return phase === 'active' || (allowResuming && phase === 'resuming');
  },

  emitRelayStreamControl({ enabled = true, allowResuming = false, mediaControl = null } = {}) {
    if (enabled && !this.canStartTunnelRelay({ allowResuming })) return false;
    const lease = this.activeLeaseEnvelope();
    if (!lease || !this.socket?.connected) return false;
    const { width, height, fps } = this.getTunnelRelayRequestSize();
    const payload = {
      ...lease,
      enabled,
      width,
      height,
      fps,
    };
    if (!mediaControl && enabled) this.bindCurrentConnectionAttempt();
    if (mediaControl && typeof mediaControl === 'object') {
      payload.schemaVersion = mediaControl.schemaVersion === 2 ? 2 : payload.schemaVersion;
      payload.mediaControlSchemaVersion = 1;
      payload.state = mediaControl.state === 'active' ? 'active' : 'suspended';
      payload.generation = Number(mediaControl.generation) || 0;
      payload.connectionAttemptId = mediaControl.connectionAttemptId
        || this.currentConnectionAttemptId
        || null;
    }
    this.socket?.emit('relay-stream-control', payload);
    return true;
  },

  bindCurrentConnectionAttempt() {
    const lease = this.activeLeaseEnvelope();
    if (!lease || !this.socket?.connected || !this.currentConnectionAttemptId) return false;
    if (!Number.isSafeInteger(this.connectionAttemptSequence) || this.connectionAttemptSequence < 1) {
      return false;
    }
    this.socket.emit('connection-attempt-bind', {
      schemaVersion: 1,
      connectionAttemptId: this.currentConnectionAttemptId,
      connectionAttemptSequence: this.connectionAttemptSequence,
      leaseId: lease.leaseId,
      leaseEpoch: lease.leaseEpoch,
      networkMode: this.networkMode || undefined,
    });
    return true;
  },

  stopTunnelRelay() {
    const lease = this.activeLeaseEnvelope();
    if (lease && this.socket?.connected && this.tunnelRelayActive) this.socket.emit('relay-stream-control', { ...lease, enabled: false });
    this.tunnelRelayActive = false;
    document.body?.classList?.remove?.('tunnel-relay-active');
    const relayImage = document.getElementById('relayImage');
    if (relayImage) {
      relayImage.classList?.add?.('hidden');
      if (typeof relayImage.removeAttribute === 'function') {
        relayImage.removeAttribute('src');
      } else {
        try { relayImage.src = ''; } catch (_) {}
      }
    }
if (this.tunnelLastObjectUrl) {
      URL.revokeObjectURL(this.tunnelLastObjectUrl);
      this.tunnelLastObjectUrl = '';
    }
    if (this.tunnelPendingObjectUrl) {
      URL.revokeObjectURL(this.tunnelPendingObjectUrl);
      this.tunnelPendingObjectUrl = '';
    }
  },

  handleRelayFrame(data) {
    if (!this.tunnelRelayActive) {
      return;
    }
    if (this.isMediaHealthSuppressed() && this.getMediaAppliedPhase() === 'suspended') {
      // Intentional suspension: drop late frames without reviving FPS/health.
      return;
    }
    const relayImage = document.getElementById('relayImage');
    if (!relayImage || !data?.data) {
      return;
    }
    relayImage.decoding = 'async';
    relayImage.loading = 'eager';
    if ('fetchPriority' in relayImage) {
      relayImage.fetchPriority = 'high';
    }
    const frameId = Number(data.frameId || 0);
    if (frameId && frameId <= this.tunnelLastFrameId) {
      return;
    }
    this.tunnelLastFrameId = frameId || this.tunnelLastFrameId + 1;

    const ackLoadedFrame = (objectUrl = '') => {
      if (objectUrl) {
        if (this.tunnelLastObjectUrl) {
          URL.revokeObjectURL(this.tunnelLastObjectUrl);
        }
        this.tunnelLastObjectUrl = objectUrl;
        this.tunnelPendingObjectUrl = '';
      }
      const frameSeq = (Number(this._videoFrameSeq) || 0) + 1;
      this._videoFrameSeq = frameSeq;
      this.markMediaAttemptReady(this.currentConnectionAttemptId || null);
      this._lastRenderedRelayFrame = {
        frameId: frameId || this.tunnelLastFrameId,
        frameSeq,
        connectionAttemptId: this.currentConnectionAttemptId || null,
      };
      if (this._mediaResumeFramePending) {
        this.observeFreshResumeFrame({
          source: 'relay-frame',
          frameSeq,
          connectionAttemptId: this.currentConnectionAttemptId || null,
        });
      }
      const lease = this.activeLeaseEnvelope();
      if (lease && this.socket?.connected) {
        this.socket.emit('relay-frame-ack', {
          ...lease,
          frameId: frameId || this.tunnelLastFrameId,
          renderedAt: Date.now(),
          latencyMs: data.timestamp ? Math.max(0, Date.now() - Number(data.timestamp)) : 0
        });
      }
    };

    // Revoke any previous pending load before accepting a newer generation frame.
    if (relayImage.onload) {
      relayImage.onload = null;
    }
    if (this.tunnelPendingObjectUrl) {
      URL.revokeObjectURL(this.tunnelPendingObjectUrl);
      this.tunnelPendingObjectUrl = '';
    }

    if (typeof data.data === 'string') {
      relayImage.onload = () => ackLoadedFrame();
      relayImage.src = `data:${data.mime || 'image/jpeg'};base64,${data.data}`;
    } else {
      const blob = data.data instanceof Blob
        ? data.data
        : new Blob([data.data], { type: data.mime || 'image/jpeg' });
      this.tunnelPendingObjectUrl = URL.createObjectURL(blob);
      const objectUrl = this.tunnelPendingObjectUrl;
      relayImage.onload = () => ackLoadedFrame(objectUrl);
      relayImage.src = this.tunnelPendingObjectUrl;
    }
    // Keep the media element box mounted; only toggle visibility class.
    relayImage.classList.remove('hidden');
    document.getElementById('loading')?.classList.add('hidden');
    document.getElementById('loading')?.classList.remove('is-connecting');
    document.body.classList.add('stream-connected');
    this.hasPaintedFrame = true;
    this.setUiPhase('connected', { reason: 'tunnel-frame' });
    const latencyEl = document.getElementById('latencyDisplay');
    const latency = data.timestamp ? Math.max(0, Date.now() - Number(data.timestamp)) : 0;
    if (latencyEl) {
      latencyEl.textContent = latency ? `${latency} ms` : '- ms';
    }
    const candidateEl = document.getElementById('candidateDisplay');
    if (candidateEl) {
      candidateEl.textContent = '链路 tunnel';
    }
    if (data.width && data.height) {
      // Source resolution may adapt; viewport size stays stable via CSS contain.
      document.getElementById('resolutionDisplay').textContent = `tunnel (${data.width}x${data.height})`;
    }
    if (!this.isMediaHealthSuppressed()) {
      this.tunnelFrameCount += 1;
      const elapsed = Math.max(1, (performance.now() - this.tunnelStartedAt) / 1000);
      document.getElementById('fpsDisplay').textContent = `${Math.round(this.tunnelFrameCount / elapsed)} FPS`;
    }
    this.clearFailureRecommendation();
    this.updateNetworkUI(`隧道中继已连接。当前经 Cloudflare/Socket.IO 转发，延迟约 ${latency || '-'} ms。`, 'warning');
  },
  
  async createOffer() {
    console.log('[OFFER-DBG] createOffer called: networkMode=%s pc=%s offerInProgress=%s',
      this.networkMode, !!this.pc, this.offerInProgress);
    if (!this.hasActiveControl()) {
      this.requestControl({ allowTakeover: false });
      return;
    }
    if (this.networkMode === 'tunnel') {
      console.log('[OFFER-DBG] createOffer: tunnel mode, starting relay');
      this.startTunnelRelay();
      return;
    }
    if (this.networkMode === 'relay' && !this.hasTurnConfigured()) {
      this.setFailureRecommendation('relay-unavailable-no-turn', 'warning');
      this.enterUnavailableRelayState('外网中继当前不可用，请手动切换到“隧道中继”或补全 TURN 配置。');
      return;
    }
    if (!this.pc || this.offerInProgress) {
      console.warn('[OFFER-DBG] createOffer blocked: pc=%s offerInProgress=%s',
        !!this.pc, this.offerInProgress);
      return;
    }
    this.offerInProgress = true;
    this._offerEpoch += 1;
    const epoch = this._offerEpoch;

    try {
      if (epoch !== this._offerEpoch) return;
      const existingVideoTransceiver = this.pc.getTransceivers().find((transceiver) => {
        return transceiver.receiver?.track?.kind === 'video' || transceiver.mid === '0';
      });
      this.videoTransceiver = existingVideoTransceiver || this.videoTransceiver;
      if (!this.videoTransceiver) {
        this.videoTransceiver = this.pc.addTransceiver('video', { direction: 'recvonly' });
        this.preferH264(this.videoTransceiver);
      }

      const offer = await this.pc.createOffer();
      if (epoch !== this._offerEpoch) return;
      await this.pc.setLocalDescription(offer);
      if (this.networkMode === 'relay') {
        await this.waitForIceGatheringComplete(8000);
      }
      if (epoch !== this._offerEpoch) return;

      if (!this.currentConnectionAttemptId) {
        this.currentConnectionAttemptId = this.createConnectionAttemptId();
      }
      console.log('[OFFER-DBG] Emitting offer: socketConnected=%s epoch=%d', this.socket.connected, epoch);
      const session = this.getSessionPresentation();
      this.socket.emit('offer', {
        offer: this.pc.localDescription,
        epoch,
        schemaVersion: 2,
        networkMode: this.networkMode,
        iceMode: this.networkMode,
        turnServerId: this.selectedTurnServerId || this.serverConfig?.selectedTurnServerId || undefined,
        leaseId: this.controlState.lease.leaseId,
        leaseEpoch: this.controlState.lease.leaseEpoch,
        connectionAttemptId: this.currentConnectionAttemptId,
        connectionAttemptSequence: Number(this.connectionAttemptSequence) || 1,
        width: session.width,
        height: session.height,
      });
      console.log('Offer sent (epoch=%d attempt=%s)', epoch, this.currentConnectionAttemptId);
    } catch (err) {
      console.error('Failed to create offer:', err);
      this.scheduleReconnect('offer-error');
    } finally {
      if (epoch === this._offerEpoch) {
        this.offerInProgress = false;
      }
    }
  },

  waitForIceGatheringComplete(timeoutMs) {
    if (!this.pc || this.pc.iceGatheringState === 'complete') {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pc?.removeEventListener('icegatheringstatechange', onStateChange);
        console.warn(`[NETWORK] ICE gathering wait timed out after ${timeoutMs}ms`);
        resolve();
      }, timeoutMs);

      const onStateChange = () => {
        if (!this.pc || this.pc.iceGatheringState === 'complete') {
          clearTimeout(timer);
          this.pc?.removeEventListener('icegatheringstatechange', onStateChange);
          resolve();
        }
      };

      this.pc.addEventListener('icegatheringstatechange', onStateChange);
    });
  },

  preferH264(transceiver) {
    if (!transceiver || typeof transceiver.setCodecPreferences !== 'function') {
      return;
    }
    if (!window.RTCRtpReceiver || typeof RTCRtpReceiver.getCapabilities !== 'function') {
      return;
    }

    const capabilities = RTCRtpReceiver.getCapabilities('video');
    if (!capabilities || !Array.isArray(capabilities.codecs)) {
      return;
    }

    const codecs = capabilities.codecs;
    const h264 = codecs.filter((codec) => codec.mimeType.toLowerCase() === 'video/h264');
    if (!h264.length) {
      console.warn('[LATENCY] Browser has no H.264 receive capability; keeping default codec order');
      return;
    }

    const rtx = codecs.filter((codec) => codec.mimeType.toLowerCase() === 'video/rtx');
    const rest = codecs.filter((codec) => codec.mimeType.toLowerCase() !== 'video/h264' && codec.mimeType.toLowerCase() !== 'video/rtx');
    transceiver.setCodecPreferences([...h264, ...rtx, ...rest]);
    console.log('[LATENCY] Preferred H.264 for video offer:', h264.map((codec) => codec.sdpFmtpLine || codec.mimeType));
  },
  
  async requestResolution(width, height) {
    const lease = this.activeLeaseEnvelope();
    if (!lease || !this.socket?.connected) return false;
    this.currentResolution = { width, height, label: `${width}x${height}` };
    this._explicitOverride1080 = Number(width) >= 1920 && Number(height) >= 1080;
    if (this.networkMode === 'relay' && this._explicitOverride1080) {
      this.announcePaintIssue('explicit-1080');
    }
    const session = this.getSessionPresentation();
    this.socket.emit('resolution-change', { ...lease, width: session.width, height: session.height });
    if (this.networkMode === 'tunnel' && this.tunnelRelayActive) {
      this.startTunnelRelay();
    }
    return true;
  },

  bindSettingsModal(modal, options = {}) {
    if (!modal) {
      return { open() {}, close() {} };
    }
    const closeBtn = options.closeBtn || null;
    const root = options.root || (typeof document !== 'undefined' ? document : null);
    const close = () => {
      modal.classList.add('hidden');
    };
    const open = () => {
      modal.classList.remove('hidden');
      const title = typeof modal.querySelector === 'function' ? modal.querySelector('h3') : null;
      const focusEl = title || closeBtn;
      if (focusEl && typeof focusEl.focus === 'function') {
        focusEl.focus();
      }
    };
    const onKeydown = (event) => {
      if (!event || event.key !== 'Escape') return;
      if (modal.classList.contains('hidden')) return;
      if (typeof event.preventDefault === 'function') event.preventDefault();
      if (typeof event.stopPropagation === 'function') event.stopPropagation();
      if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
      close();
    };
    if (closeBtn && !closeBtn.dataset?.bound) {
      if (closeBtn.dataset) closeBtn.dataset.bound = '1';
      closeBtn.addEventListener('click', close);
    }
    if (!modal.dataset?.bound) {
      if (modal.dataset) modal.dataset.bound = '1';
      modal.addEventListener('click', (event) => {
        if (event.target === modal) close();
      });
      root?.addEventListener?.('keydown', onKeydown, true);
    }
    return { open, close };
  },

  configureNetworkControls() {
    const modeBtn = document.getElementById('networkModeBtn');
    const modal = document.getElementById('networkModal');
    const applyBtn = document.getElementById('applyNetworkMode');
    const closeBtn = document.getElementById('closeNetworkMode');
    const testBtn = document.getElementById('testTurnBtn');
    const turnStatus = document.getElementById('networkTurnStatus');

    if (modeBtn && !modeBtn.dataset.bound) {
      modeBtn.dataset.bound = '1';
      modeBtn.addEventListener('click', () => {
        this.syncNetworkModal();
        this._networkModalApi?.open();
      });
    }

    if (modal && !this._networkModalApi) {
      this._networkModalApi = this.bindSettingsModal(modal, { closeBtn });
    }

    if (applyBtn && !applyBtn.dataset.bound) {
      applyBtn.dataset.bound = '1';
      applyBtn.addEventListener('click', () => {
        const selected = document.querySelector('input[name="networkMode"]:checked');
        const turnSelect = document.getElementById('turnServerSelect');
        const nextTurnId = turnSelect ? String(turnSelect.value || '').trim() : this.selectedTurnServerId;
        const hostSupportsMulti = this.serverConfig?.hostSupportsMultiTurn;
        const hostIds = Array.isArray(this.serverConfig?.hostTurnServerIds)
          ? this.serverConfig.hostTurnServerIds
          : [];
        if (
          nextTurnId
          && hostSupportsMulti === false
          && hostIds.length
          && !hostIds.includes(nextTurnId)
        ) {
          const resultEl = document.getElementById('networkTurnTestResult');
          if (resultEl) {
            resultEl.textContent = `当前 Host 仅装载有限 TURN 节点，无法切换到「${nextTurnId}」。请重启 Host 以加载完整 turn.json，或改回默认节点。`;
            resultEl.dataset.severity = 'danger';
          }
          const fallback = this.resolveSelectedTurnServerId(
            this.serverConfig?.defaultTurnServerId || hostIds[0] || '',
          );
          this.setSelectedTurnServerId(fallback);
          this.populateTurnServerSelect();
          return;
        }
        this.setSelectedTurnServerId(nextTurnId);
        const apply = () => {
          if (selected) {
            this.setNetworkMode(selected.value);
          } else if (this.socket && this.socket.connected) {
            this.beginConnectionAttempt('manual-turn-switch');
            this.refresh({ reason: 'manual-turn-switch' });
          }
          modal?.classList.add('hidden');
        };
        this.loadServerConfig({ turnServerId: this.selectedTurnServerId })
          .catch(() => {})
          .finally(apply);
      });
    }

    if (testBtn && !testBtn.dataset.bound) {
      testBtn.dataset.bound = '1';
      testBtn.addEventListener('click', () => {
        this.runTurnSelfTest().catch((err) => {
          console.warn('[NETWORK] TURN self-test failed:', err);
          const resultEl = document.getElementById('networkTurnTestResult');
          if (resultEl) {
            resultEl.textContent = `测试异常：${err?.message || err}`;
            resultEl.dataset.severity = 'danger';
          }
        });
      });
    }

    if (turnStatus) {
      turnStatus.textContent = this.buildTurnStatusText();
    }
    this.syncNetworkModal();
  },

  syncNetworkModal() {
    const selected = document.querySelector(`input[name="networkMode"][value="${this.networkMode}"]`);
    if (selected) {
      selected.checked = true;
    }
    this.populateTurnServerSelect();
  },

  setNetworkMode(mode) {
    if (!this.networkModes[mode]) {
      return;
    }
    if (this.isPortSearchActive()) {
      this.stopPortSearch('mode-switch');
    }
    this.clearFailureRecommendation();
    if (mode !== 'tunnel') {
      this._tunnelLockUntil = 0;
    }
    const modeState = this.enforceSupportedNetworkMode(mode);
    this.beginConnectionAttempt('manual-mode-switch');
    this.useRelayFallback = false;
    this._autoFailCount = 0;
    this.updateNetworkUI(
      modeState.reason || '网络模式已切换，正在重连...',
      modeState.changed ? 'warning' : ''
    );
    if (modeState.unavailable) {
      this.enterUnavailableRelayState(modeState.reason);
      this.renderPortSearchStatus();
      return;
    }
    if (this.socket && this.socket.connected) {
      this.refresh({ reason: 'manual-mode-switch' });
    }
    this.renderPortSearchStatus();
  },

  bindNetworkAdvisor() {
    if (this._networkAdvisorBound) return;
    const advisor = document.getElementById('networkAdvisor');
    const handle = document.getElementById('networkAdvisorHandle');
    if (!advisor) return;
    this._networkAdvisorBound = true;

    advisor.addEventListener('mouseenter', () => {
      this._networkAdvisorHover = true;
      this.clearNetworkAdvisorCollapseTimer();
      this.expandNetworkAdvisor({ reschedule: false });
    });
    advisor.addEventListener('mouseleave', () => {
      this._networkAdvisorHover = false;
      this._networkAdvisorPinned = false;
      // Leave = dock soon. Idle timer only applies after content updates while expanded.
      this.scheduleNetworkAdvisorCollapse({ delayMs: this.NETWORK_ADVISOR_LEAVE_COLLAPSE_MS });
    });
    advisor.addEventListener('focusin', () => {
      this.clearNetworkAdvisorCollapseTimer();
      this.expandNetworkAdvisor({ reschedule: false });
    });
    advisor.addEventListener('focusout', () => {
      setTimeout(() => {
        if (advisor.contains(document.activeElement)) return;
        this.scheduleNetworkAdvisorCollapse({ delayMs: this.NETWORK_ADVISOR_LEAVE_COLLAPSE_MS });
      }, 0);
    });
    handle?.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (advisor.classList.contains('collapsed')) {
        this._networkAdvisorPinned = true;
        this.clearNetworkAdvisorCollapseTimer();
        this.expandNetworkAdvisor({ reschedule: false });
      } else {
        this._networkAdvisorPinned = false;
        this.collapseNetworkAdvisor();
      }
    });
  },

  clearNetworkAdvisorCollapseTimer() {
    if (this._networkAdvisorCollapseTimer) {
      clearTimeout(this._networkAdvisorCollapseTimer);
      this._networkAdvisorCollapseTimer = null;
    }
  },

  expandNetworkAdvisor({ reschedule = true } = {}) {
    const advisor = document.getElementById('networkAdvisor');
    if (!advisor) return;
    this.clearNetworkAdvisorCollapseTimer();
    advisor.classList.remove('collapsed');
    advisor.setAttribute('aria-expanded', 'true');
    const handle = document.getElementById('networkAdvisorHandle');
    if (handle) handle.setAttribute('aria-label', '收起网络状态');
    if (reschedule) this.scheduleNetworkAdvisorCollapse();
  },

  collapseNetworkAdvisor() {
    const advisor = document.getElementById('networkAdvisor');
    if (!advisor || !advisor.classList.contains('visible')) return;
    if (this._networkAdvisorHover || this._networkAdvisorPinned) return;
    if (advisor.contains(document.activeElement)) return;
    this.clearNetworkAdvisorCollapseTimer();
    advisor.classList.add('collapsed');
    advisor.setAttribute('aria-expanded', 'false');
    const handle = document.getElementById('networkAdvisorHandle');
    if (handle) handle.setAttribute('aria-label', '展开网络状态');
  },

  scheduleNetworkAdvisorCollapse(options = {}) {
    const advisor = document.getElementById('networkAdvisor');
    if (!advisor || !advisor.classList.contains('visible')) return;
    if (this._networkAdvisorHover || this._networkAdvisorPinned) return;
    this.clearNetworkAdvisorCollapseTimer();
    const severity = this._networkAdvisorSeverity || '';
    const delay = Number.isFinite(options.delayMs)
      ? options.delayMs
      : (this.NETWORK_ADVISOR_COLLAPSE_MS[severity]
        ?? this.NETWORK_ADVISOR_COLLAPSE_MS['']
        ?? 4500);
    this._networkAdvisorCollapseTimer = setTimeout(() => {
      this._networkAdvisorCollapseTimer = null;
      this.collapseNetworkAdvisor();
    }, Math.max(0, delay));
  },

  updateNetworkUI(message, severity = '') {
    this.bindNetworkAdvisor();
    const mode = this.networkModes[this.networkMode] || this.networkModes.auto;
    const modeBtn = document.getElementById('networkModeBtn');
    const advisor = document.getElementById('networkAdvisor');
    const title = document.getElementById('networkAdvisorTitle');
    const state = document.getElementById('networkAdvisorState');
    const text = document.getElementById('networkAdvisorText');
    const handleLabel = document.getElementById('networkAdvisorHandleLabel');
    const turnStatus = document.getElementById('networkTurnStatus');

    if (modeBtn) {
      modeBtn.textContent = `网络：${mode.label}`;
    }
    if (turnStatus) {
      turnStatus.textContent = this.buildTurnStatusText();
    }
    if (handleLabel) {
      handleLabel.textContent = mode.shortLabel || mode.label || '网络';
    }
    if (!advisor || !title || !state || !text) {
      return;
    }

    const recommendation = this.recommendationState;
    const genericMessage = message === '网络模式已就绪' || message === '网络模式已切换，正在重连...';
    const baseMessage = (!message || genericMessage)
      ? (this.getDefaultNetworkGuidance() || message || mode.hint)
      : message;
    const detail = [
      this.getPublicEntryUrl() ? `固定入口：${this.getPublicEntryUrl()}。` : '',
      baseMessage,
      this.getRecommendationMessage(),
    ].filter(Boolean).join(' ');
    const effectiveSeverity = severity || recommendation?.severity || (this.networkMode === 'relay' && !this.hasTurnConfigured() ? 'warning' : '');
    const stateLabel = recommendation?.nextSuggestedMode
      ? `建议：${this.networkModes[recommendation.nextSuggestedMode]?.label || recommendation.nextSuggestedMode}`
      : mode.state;
    const signature = [
      this.networkMode,
      effectiveSeverity || '',
      stateLabel,
      detail || '',
      recommendation?.nextSuggestedMode || '',
    ].join('|');

    // Stats ticks rewrite RTT every second. Only expand when the story changes;
    // otherwise keep the docked tab and quietly refresh copy.
    const firstShow = !advisor.classList.contains('visible');
    const meaningfulChange = signature !== this._networkAdvisorLastSignature;
    const severityRank = { '': 0, warning: 1, danger: 2 };
    const severityUp = (severityRank[effectiveSeverity] || 0)
      > (severityRank[this._networkAdvisorSeverity] || 0);
    this._networkAdvisorLastSignature = signature;
    this._networkAdvisorSeverity = effectiveSeverity;

    title.textContent = `网络模式：${mode.label}`;
    state.textContent = stateLabel;
    text.textContent = detail || mode.hint;
    advisor.classList.toggle('warning', effectiveSeverity === 'warning');
    advisor.classList.toggle('danger', effectiveSeverity === 'danger');
    state.classList.toggle('recommended', Boolean(recommendation?.nextSuggestedMode));
    advisor.classList.add('visible');

    const narrow = typeof matchMedia === 'function' && matchMedia('(max-width: 768px)').matches;
    const shouldExpand = (firstShow
      || severityUp
      || (meaningfulChange && (effectiveSeverity === 'warning' || effectiveSeverity === 'danger'
        || genericMessage || !message
        || /失败|不可用|切换|重连|建议|耗尽|超时|中断/.test(String(baseMessage || '')))))
      && !(narrow && (effectiveSeverity === 'info' || effectiveSeverity === ''));

    if (shouldExpand) {
      this._networkAdvisorPinned = false;
      this.expandNetworkAdvisor({ reschedule: true });
    } else if (narrow && (effectiveSeverity === 'info' || effectiveSeverity === '')) {
      this.collapseNetworkAdvisor();
    } else if (!advisor.classList.contains('collapsed') && !this._networkAdvisorHover && !this._networkAdvisorPinned) {
      // Content refreshed while expanded — arm idle collapse only if not already running.
      if (!this._networkAdvisorCollapseTimer) {
        this.scheduleNetworkAdvisorCollapse();
      }
    }
  },
  
  startStats() {
    if (!this.pc || typeof WebRtcStats === 'undefined') return;
    if (this._statsSampler && this._statsPc !== this.pc) {
      this._statsSampler.stop();
      this._statsSampler = null;
      this._statsPc = null;
    }
    if (!this._statsSampler) {
      const pc = this.pc;
      this._statsPc = pc;
      this.syncLinkQualityPath({ applyProfile: false, reason: 'stats-start' });
      this.ensureLinkQualityController()?.beginConnection?.();
      this._statsSampler = WebRtcStats.createWebRtcStatsSampler({
        getStats: () => pc.getStats(),
        intervalMs: 1000,
        onSample: (snapshot) => this.processStatsSnapshot(snapshot),
        onError: (error) => console.warn('[STATS] getStats failed:', error?.message || error),
      });
    }
    this._statsSampler.start();
  },

  stopVideoFrameTracking() {
    const video = this._videoFrameElement;
    if (video && this._videoFrameCallbackId != null
        && typeof video.cancelVideoFrameCallback === 'function') {
      video.cancelVideoFrameCallback(this._videoFrameCallbackId);
    }
    this._videoFrameCallbackId = null;
    this._videoFrameElement = null;
  },

  startVideoFrameTracking() {
    this.stopVideoFrameTracking();
    const video = document.getElementById('remoteVideo');
    if (!video || typeof video.requestVideoFrameCallback !== 'function') return;
    this._videoFrameElement = video;
    const onFrame = (now, metadata) => {
      if (this._videoFrameElement !== video) return;
      this._videoFrameSeq = (Number(this._videoFrameSeq) || 0) + 1;
      this.markMediaAttemptReady(this.currentConnectionAttemptId || null);
      if (typeof LatencyMonitor !== 'undefined') {
        LatencyMonitor.onVideoFrame(now, metadata);
      }
      if (this._mediaResumeFramePending) {
        this.observeFreshResumeFrame({
          source: 'video-callback',
          frameSeq: this._videoFrameSeq,
          connectionAttemptId: this.currentConnectionAttemptId || null,
          pc: this.pc || null,
        });
      }
      this._videoFrameCallbackId = video.requestVideoFrameCallback(onFrame);
    };
    this._videoFrameCallbackId = video.requestVideoFrameCallback(onFrame);
  },

  stopMediaTelemetry() {
    if (this._statsSampler) this._statsSampler.stop();
    this._statsSampler = null;
    this._statsPc = null;
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    this.stopVideoFrameTracking();
  },

  processStatsSnapshot(stats = {}) {
      const fps = Number(stats.fps || 0);
      const latencyMs = Number(stats.rttMs || 0);
      const jitterBufferDelay = Number(stats.jitterBufferMs || 0);
      const framesReceived = Number(stats.framesReceived || 0);
      const framesDecoded = Number(stats.framesDecoded || 0);
      const packetsLost = Number(stats.packetsLost || 0);
      const bytesReceived = Number(stats.bytesReceived || 0);
      const codec = String(stats.codec || '');
      const selectedCandidateType = String(stats.selectedCandidateType || '');
      if (Number.isFinite(framesDecoded)) {
        const prevDecoded = Number(this._lastInboundFramesDecoded) || 0;
        // Health timestamp only advances on real frame growth; flat/frozen stats age out.
        if (framesDecoded > prevDecoded) {
          this._lastInboundFramesDecoded = framesDecoded;
          this._lastInboundFramesDecodedAt = Date.now();
        } else {
          this._lastInboundFramesDecoded = framesDecoded;
        }
      }
      this.selectedCandidatePair = stats.selectedCandidatePair || {
        localType: '', remoteType: '', protocol: '', localAddress: '', remoteAddress: '',
        localAddressFamily: '', remoteAddressFamily: '', rttMs: 0,
      };

      const fpsEl = document.getElementById('fpsDisplay');
      if (fpsEl) fpsEl.textContent = `${Math.round(fps)} FPS`;
      const latencyEl = document.getElementById('latencyDisplay');
      if (latencyEl) {
        if (latencyMs > 0 && jitterBufferDelay > 0) {
          latencyEl.textContent = `RTT ${Math.round(latencyMs)} · 缓冲 ${Math.round(jitterBufferDelay)} ms`;
          latencyEl.title = `网络 RTT ${Math.round(latencyMs)} ms；播放缓冲 ${Math.round(jitterBufferDelay)} ms`;
        } else if (latencyMs > 0) {
          latencyEl.textContent = `RTT ${Math.round(latencyMs)} ms`;
          latencyEl.title = `网络 RTT ${Math.round(latencyMs)} ms`;
        } else {
          latencyEl.textContent = '- ms';
          latencyEl.title = '';
        }
      }
      const candidateEl = document.getElementById('candidateDisplay');
      const portSearchStatus = this.portSearchController?.snapshot?.()?.status || null;
      const portSearchOwnsDisplay = portSearchStatus === 'searching'
        || portSearchStatus === 'succeeded'
        || portSearchStatus === 'exhausted';
      if (candidateEl && !portSearchOwnsDisplay) {
        const linkLabel = selectedCandidateType === 'relay' ? 'TURN中继' : selectedCandidateType === 'srflx' || selectedCandidateType === 'prflx' ? 'STUN直连' : selectedCandidateType === 'host' ? '本地直连' : selectedCandidateType || '-';
        candidateEl.textContent = `当前链路：${linkLabel}${latencyMs > 0 ? ` · ${latencyMs} ms` : ''}`;
      }
      this.lastCandidateType = selectedCandidateType || '';
      this.handlePortSearchMedia({
        selectedCandidateType,
        framesDecoded,
        fps,
      });

      if (this.isMediaHealthSuppressed()) {
        this.noMediaTicks = 0;
      } else if (framesReceived === 0 && framesDecoded === 0 && !selectedCandidateType) {
        this.noMediaTicks += 1;
      } else {
        this.noMediaTicks = 0;
      }

      // Resume unlock requires framesDecoded delta past baseline, not cumulative > 0.
      if (this._mediaResumeFramePending) {
        this.observeFreshResumeFrame({
          source: 'stats',
          framesDecoded,
          connectionAttemptId: this.currentConnectionAttemptId || null,
          pc: this.pc || null,
        });
      }

      if (this.isMediaHealthSuppressed()) {
        // Intentional suspension must not trigger degraded quality recovery.
      } else if (selectedCandidateType === 'relay') {
        if (!this.shouldPreservePaintIssueAdvisor()) {
          this.clearFailureRecommendation();
          this.updateNetworkUI(`当前通过 TURN 中继传输。RTT ${latencyMs || '-'} ms，适合受限外网但延迟会高于本地直连。`);
        }

        // TURN channel dead detection: ICE stays "completed" via STUN consent probes
        // even after the TURN data channel silently times out (~26s without traffic).
        // If bytesReceived has been 0 for 20 consecutive 1s samples while relay is the
        // selected path, the channel is dead — trigger a full reconnect to recover.
        if (!this.isMediaHealthSuppressed()
            && this.pc?.iceConnectionState === 'completed'
            && bytesReceived === 0) {
          this._noRelayReceiveCount = (this._noRelayReceiveCount || 0) + 1;
          if (this._noRelayReceiveCount >= 20) {
            this._noRelayReceiveCount = 0;
            console.warn('[TURN] channel appears dead (20s no bytes on relay), triggering refresh');
            this.refresh({ reason: 'turn-channel-dead' });
          }
        } else {
          this._noRelayReceiveCount = 0;
        }
      } else if (selectedCandidateType === 'host') {
        if (!this.shouldPreservePaintIssueAdvisor()) {
          this.clearFailureRecommendation();
          this.updateNetworkUI(`当前为本地/直连链路。RTT ${latencyMs || '-'} ms，这是最低延迟路径。`);
        }
      } else if (selectedCandidateType === 'srflx' || selectedCandidateType === 'prflx') {
        if (!this.shouldPreservePaintIssueAdvisor()) {
          this.clearFailureRecommendation();
          this.updateNetworkUI(`当前为外网穿透直连。RTT ${latencyMs || '-'} ms；若画面不稳定可切换外网中继。`);
        }
      } else if (this.noMediaTicks >= 3) {
        const hasTurn = this.hasTurnConfigured();
        this.setFailureRecommendation(
          this.networkMode === 'relay'
            ? 'relay-failed-suggest-tunnel'
            : hasTurn
              ? 'direct-failed-suggest-relay'
              : 'direct-failed-suggest-tunnel',
          'danger'
        );
        this.updateNetworkUI(
          this.networkMode === 'relay'
            ? '外网中继仍未生成媒体链路。建议切换到“隧道中继”，它不依赖 UDP/TURN。'
            : hasTurn
            ? '已连续多次 0 FPS 且未选出媒体链路。可先试“外网中继”，仍失败则切换“隧道中继”。'
            : '已连续多次 0 FPS 且未选出媒体链路。当前没有 TURN，受限外网无法可靠投屏。',
          'danger'
        );
      }

      console.log(`[STATS] FPS=${fps.toFixed(1)}, RTT=${latencyMs}ms, Jitter=${jitterBufferDelay}ms, ` +
                  `Codec=${codec || 'unknown'}, Candidate=${selectedCandidateType || 'unknown'}, ` +
                  `Recv=${framesReceived}, Decoded=${framesDecoded}, Lost=${packetsLost}, ` +
                  `IntervalBytes=${(bytesReceived/1024).toFixed(1)}KiB`);
      if (this.selectedCandidatePair?.localType || this.selectedCandidatePair?.remoteType) {
        console.log('[NETWORK] Selected candidate pair:', this.selectedCandidatePair);
      }

      if (typeof LatencyMonitor !== 'undefined' && typeof LatencyMonitor.onMediaStats === 'function') {
        LatencyMonitor.onMediaStats(stats);
      }

      this.handleReceiverStats({
        interval: true,
        fps,
        rttMs: latencyMs,
        jitterBufferMs: Number(jitterBufferDelay) || 0,
        framesReceived,
        framesDecoded,
        packetsLost,
        bytesReceived,
        codec,
        selectedCandidateType,
      });

      if (this.socket && this.socket.connected) {
        this.socket.emit('viewer-stats', {
          fps,
          rttMs: latencyMs,
          jitterBufferMs: Number(jitterBufferDelay) || 0,
          framesReceived,
          framesDecoded,
          packetsLost,
          bytesReceived,
          codec,
          selectedCandidateType
        });
      }

      const videoEl = document.getElementById('remoteVideo');
      this.notePaintStats({
        ...stats,
        fps,
        framesReceived,
        framesDecoded,
        videoWidth: Number(stats.videoWidth || videoEl?.videoWidth || 0),
        videoHeight: Number(stats.videoHeight || videoEl?.videoHeight || 0),
        source: 'stats',
      });
  },

  captureLastFrameHold(videoElement) {
    const video = videoElement || document.getElementById('remoteVideo');
    const canvas = document.getElementById('lastFrameHold');
    if (!video || !canvas || video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
      return false;
    }
    try {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return false;
      ctx.drawImage(video, 0, 0);
      canvas.classList.remove('hidden');
      return true;
    } catch (_) {
      return false;
    }
  },

  showReconnectHud(text) {
    const hud = document.getElementById('reconnectHud');
    const label = document.getElementById('reconnectHudText');
    if (label && text) label.textContent = text;
    hud?.classList.remove('hidden');
  },

  hideReconnectHud() {
    document.getElementById('reconnectHud')?.classList.add('hidden');
    document.getElementById('lastFrameHold')?.classList.add('hidden');
  },

  RECOVERY_REFRESH_COOLDOWN_MS: 3000,
  isForcedRefreshReason(reason) {
    return reason == null
      || reason === 'manual'
      || reason === 'manual-mode-switch'
      || reason === 'manual-turn-switch';
  },
  canBeginRefresh(reason) {
    if (this.isForcedRefreshReason(reason)) return true;
    if (Date.now() - (this._lastRefreshAt || 0) < this.RECOVERY_REFRESH_COOLDOWN_MS) {
      console.warn('[RECOVERY] Suppressing refresh reason=%s', reason);
      return false;
    }
    return true;
  },

  markRefreshSettled(_reason) {
    if (this._refreshSettleTimer) {
      clearTimeout(this._refreshSettleTimer);
      this._refreshSettleTimer = null;
    }
    this._refreshing = false;
    this.hideReconnectHud();
  },

  async refresh(options = {}) {
    let reason = null;
    if (typeof options === 'string') {
      reason = options;
    } else if (options && typeof options === 'object') {
      reason = options.reason || null;
    }
    if (!this.canBeginRefresh(reason)) return;
    if (this._superseded) {
      return;
    }
    this._refreshReason = reason || null;
    if (this._refreshReason === 'fresh-frame-timeout' && this.networkMode === 'relay') {
      this._relayHardRefreshCount = (Number(this._relayHardRefreshCount) || 0) + 1;
    }
    console.log('Refreshing WebRTC connection...', this._refreshReason || '');
    if (!this._portSearchRefreshOwned && this.isPortSearchActive()) {
      this.stopPortSearch('manual-refresh');
    } else if (!this._portSearchRefreshOwned && this.portSearchController) {
      // Normal refresh should release sticky success/exhausted candidate text.
      const portSearchStatus = this.portSearchController.snapshot?.()?.status;
      if (portSearchStatus === 'succeeded' || portSearchStatus === 'exhausted' || portSearchStatus === 'stopped') {
        this.portSearchController = null;
        this.renderPortSearchStatus();
      }
    }
    this._refreshing = true;
    if (this._refreshSettleTimer) {
      clearTimeout(this._refreshSettleTimer);
      this._refreshSettleTimer = null;
    }
    this._refreshSettleTimer = setTimeout(() => {
      this.markRefreshSettled('timeout');
    }, 8000);
    this._refreshSettleTimer.unref?.();
    this._lastRefreshAt = Date.now();
    this.manualDisconnect = false;
    this.offerInProgress = false;
    this._offerEpoch += 1;
    this.beginConnectionAttempt('refresh');
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this._dcTimeout) {
      clearTimeout(this._dcTimeout);
      this._dcTimeout = null;
    }
    if (this._disconnectedTimer) {
      clearTimeout(this._disconnectedTimer);
      this._disconnectedTimer = null;
    }
    if (this._iceDisconnectedTimer) {
      clearTimeout(this._iceDisconnectedTimer);
      this._iceDisconnectedTimer = null;
    }
    if (this._dcReconnectTimer) {
      clearTimeout(this._dcReconnectTimer);
      this._dcReconnectTimer = null;
    }
    if (this._stableResetTimer) {
      clearTimeout(this._stableResetTimer);
      this._stableResetTimer = null;
    }
    this.stopDcKeepalive();
    const videoElement = document.getElementById('remoteVideo');
    const heldLastFrame = this.captureLastFrameHold(videoElement);
    if (heldLastFrame) {
      this.showReconnectHud('正在重新连接…');
    } else {
      videoElement?.classList.remove('connected');
      document.body.classList.remove('stream-connected');
      document.getElementById('loading')?.classList.remove('hidden');
      document.getElementById('loading')?.classList.add('is-connecting');
      updateLoadingText('正在重新连接...');
    }
    this.stopTunnelRelay();

    if (this.pc) {
      // Remove event handlers BEFORE closing to prevent spurious reconnect scheduling
      this.pc.oniceconnectionstatechange = null;
      this.pc.onconnectionstatechange = null;
      this.pc.onsignalingstatechange = null;
      this.pc.onicegatheringstatechange = null;
      this.pc.onicecandidate = null;
      this.pc.ontrack = null;
      this.pc.close();
      this.pc = null;
    }
    // Explicitly clear DataChannel references
    this.inputChannel = null;
    this.inputMoveChannel = null;
    this._iceRestartAttempts = 0;
    this.stopMediaTelemetry();
    if (typeof Input !== 'undefined') Input.setActive(false);

    if (this.networkMode === 'relay' && !this.hasTurnConfigured()) {
      this.setFailureRecommendation('relay-unavailable-no-turn', 'warning');
      this.enterUnavailableRelayState('外网中继当前不可用，请手动切换到“隧道中继”或补全 TURN 配置。');
    } else if (this.networkMode === 'tunnel') {
      if (!this.socket || !this.socket.connected) {
        this.createSignalingSocket(true);
      }
      if (this.socket?.connected) {
        this.startTunnelRelay();
        // A media-resume refresh creates a new attempt. Re-issue the in-flight
        // intent on that attempt so Host ack/generation tracking stays coherent.
        this.replayMediaActivityIntent('refresh-tunnel');
      }
    } else {
      this.createPeerConnection();
      this.createOffer();
      this.replayMediaActivityIntent('refresh-webrtc');
    }
  },

  isInboundVideoHealthy(maxAgeMs = 5000) {
    const at = Number(this._lastInboundFramesDecodedAt) || 0;
    const frames = Number(this._lastInboundFramesDecoded) || 0;
    // Unknown (no growth sample) is not healthy — avoids suppressing DC recovery on freeze.
    if (frames <= 0 || !at) return false;
    return (Date.now() - at) <= maxAgeMs;
  },

  shouldReconnectForDataChannelFault(reason) {
    if (this.manualDisconnect || this._refreshing) return false;
    if (this.pc && this.pc.connectionState === 'connected' && this.isInboundVideoHealthy()) {
      return false;
    }
    return true;
  },

  async rebuildDataChannels(reason) {
    if (this._rebuildingDc) return false;
    if (!this.pc || this.pc.connectionState !== 'connected') return false;
    if (this.pc.sctp?.state !== 'connected') {
      // SCTP association already dead — need full reconnect
      this.scheduleReconnect(reason);
      return false;
    }
    this._rebuildingDc = true;
    console.warn('[INPUT-DC] Rebuilding DataChannels (no re-offer) reason=%s', reason);
    try {
      // Drop stale references so onclose callbacks on old channels don't re-trigger.
      // Un-negotiated DataChannels can be created on an existing PC without re-offer;
      // the host receives them via @pc.on("datachannel") and does NOT need to rebuild
      // ScreenCaptureTrack. Calling createOffer() here would cause host full teardown.
      this.stopDcKeepalive();
      this.inputChannel = null;
      this.inputMoveChannel = null;
      this.createInputChannel();
    } catch (err) {
      console.warn('[INPUT-DC] rebuildDataChannels failed:', err?.message || err);
      this.scheduleReconnect(reason);
      return false;
    } finally {
      this._rebuildingDc = false;
    }
    return true;
  },

  noteDataChannelFault(reason) {
    // In relay mode with a healthy PC, only rebuild the DataChannel — do NOT tear
    // down the video relay. A full refresh is only needed when the PC itself fails.
    if (this.networkMode === 'relay'
        && this.pc?.connectionState === 'connected'
        && !this._rebuildingDc) {
      this.rebuildDataChannels(reason);
      return true;
    }
    if (!this.shouldReconnectForDataChannelFault(reason)) {
      this._inputDcDegraded = true;
      console.warn('[INPUT-DC] degraded reason=%s video-healthy=true skip-reconnect', reason);
      if (typeof Input !== 'undefined') Input.setKeyboardDataChannelAvailable?.(false);
      return false;
    }
    this.scheduleReconnect(reason);
    return true;
  },

  scheduleReconnect(reason) {
    if (this._superseded) {
      return;
    }
    if (this.isMediaHealthSuppressed()) {
      return;
    }
    if (this.manualDisconnect || this.reconnectTimer || this._refreshing) {
      return;
    }
    // Prevent rapid reconnect storm: brief PC connect resets _reconnectAttempt to 0,
    // which would loop at 1500ms forever. Suppress if a refresh fired within 3s.
    if (Date.now() - (this._lastRefreshAt || 0) < 3000) {
      console.warn('[RECOVERY] Suppressing rapid reconnect — last refresh was <3s ago reason=%s', reason);
      return;
    }
    if (this.isPortSearchActive()) {
      if (this._portSearchRetryTimer || this._portSearchRefreshOwned) {
        return;
      }
      console.warn(`[PORT-SEARCH] Routing reconnect to port-search retry after ${reason}`);
      this.schedulePortSearchRetry(reason);
      return;
    }
    console.warn(`[RECOVERY] Scheduling WebRTC reconnect after ${reason}`);
    if (typeof Diagnostic !== 'undefined' && typeof Diagnostic.autoSendFailure === 'function') {
      Diagnostic.autoSendFailure(reason);
    }
    this.setUiPhase('disconnected', { reason });
    this._autoFailCount += 1;

    const hasTurn = this.hasTurnConfigured();
    const canRestartIce = this.pc
      && typeof this.pc.restartIce === 'function'
      && !this.tunnelRelayActive
      && this.networkMode !== 'tunnel'
      && this._iceRestartAttempts < 1
      && ['ice-failed', 'ice-disconnected', 'pc-failed'].includes(reason);

    if (canRestartIce) {
      this._iceRestartAttempts += 1;
      console.warn('[RECOVERY] Trying ICE restart before full refresh');
      updateLoadingText('媒体链路异常，正在尝试 ICE 重启...');
      try {
        this.pc.restartIce();
      } catch (err) {
        console.warn('[RECOVERY] restartIce failed, will fall back to full refresh', err);
      }
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (this.manualDisconnect || !this.socket || !this.socket.connected) {
          return;
        }
        this.refresh({ reason: 'reconnect:ice-restart-timeout' });
      }, 1500);
      return;
    }

    if (this.networkMode === 'auto' && hasTurn && this._autoFailCount < 2) {
      this.setFailureRecommendation('direct-failed-suggest-relay', 'warning');
      this.updateNetworkUI('自动穿透失败；Strict STUN 默认不自动切 TURN，可手动选择外网中继。', 'warning');
      updateLoadingText('直连异常，正在尝试恢复...');
    } else if (this.networkMode === 'auto' && this._autoFailCount >= 2) {
      console.warn('[RECOVERY] Strict STUN auto exhausted (failCount=%d), not using tunnel', this._autoFailCount);
      this.useRelayFallback = false;
      this.setFailureRecommendation(hasTurn ? 'direct-failed-suggest-relay' : 'direct-failed-suggest-tunnel', 'danger');
      this.updateNetworkUI('Strict STUN 直连失败，未自动切换 TURN 或媒体隧道。', 'danger');
      updateLoadingText('直连失败，诊断日志已发送。');
      document.getElementById('loading').classList.remove('hidden');
      document.getElementById('loading').classList.remove('is-connecting');
      document.body.classList.remove('stream-connected');
      if (typeof Diagnostic !== 'undefined' && typeof Diagnostic.autoSendFailure === 'function') {
        Diagnostic.autoSendFailure('strict-stun-exhausted');
      }
      return;
    } else if (this.networkMode === 'stun' && this._autoFailCount >= 2) {
      console.warn('[RECOVERY] Strict STUN mode exhausted (failCount=%d), not using tunnel', this._autoFailCount);
      this.setFailureRecommendation(hasTurn ? 'direct-failed-suggest-relay' : 'direct-failed-suggest-tunnel', 'danger');
      this.updateNetworkUI('外网直连失败，未自动切换 TURN 或媒体隧道。', 'danger');
      updateLoadingText('直连失败，诊断日志已发送。');
      document.getElementById('loading').classList.remove('hidden');
      document.getElementById('loading').classList.remove('is-connecting');
      document.body.classList.remove('stream-connected');
      if (typeof Diagnostic !== 'undefined' && typeof Diagnostic.autoSendFailure === 'function') {
        Diagnostic.autoSendFailure('strict-stun-exhausted');
      }
      return;
    } else if (this.networkMode === 'relay' && !this.getTurnServers().length) {
      this.setFailureRecommendation('relay-unavailable-no-turn', 'danger');
      this.updateNetworkUI('外网中继无 TURN 配置，建议切换到隧道中继。', 'danger');
      updateLoadingText('TURN 未配置，无法中继…');
      document.getElementById('loading').classList.remove('hidden');
      document.getElementById('loading').classList.remove('is-connecting');
      document.body.classList.remove('stream-connected');
      return;
    } else {
      updateLoadingText('连接中断，正在自动重连...');
    }
    document.getElementById('loading').classList.remove('hidden');
    document.getElementById('loading').classList.add('is-connecting');
    document.body.classList.remove('stream-connected');

    if (this.networkMode === 'relay' && (Number(this._relayHardRefreshCount) || 0) >= 5) {
      console.warn('[RECOVERY] relay-reconnect-exhausted');
      if (typeof Diagnostic !== 'undefined' && typeof Diagnostic.autoSendFailure === 'function') {
        Diagnostic.autoSendFailure('relay-reconnect-exhausted');
      }
      this.updateNetworkUI('外网中继多次重连失败，请手动刷新或切换隧道中继。', 'danger');
      updateLoadingText('中继重连已停止，请手动重试');
      document.getElementById('loading')?.classList.remove('hidden');
      document.getElementById('loading')?.classList.remove('is-connecting');
      return;
    }

    const attempt = Number(this._reconnectAttempt) || 0;
    const delay = Math.min(1500 * (2 ** attempt), 15000);
    this._reconnectAttempt = attempt + 1;
    console.warn('[RECOVERY] Scheduling WebRTC reconnect after %s in %sms', reason, delay);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.manualDisconnect) {
        return;
      }
      if (this.networkMode !== 'tunnel' && (!this.socket || !this.socket.connected)) {
        return;
      }
      this.refresh({ reason: `reconnect:${reason}` });
    }, delay);
  },

  disconnect() {
    this.markRefreshSettled('disconnect');
    this.stopPortSearch('disconnect');
    this.manualDisconnect = true;
    this.offerInProgress = false;
    this._offerEpoch += 1;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this._disconnectedTimer) {
      clearTimeout(this._disconnectedTimer);
      this._disconnectedTimer = null;
    }
    if (this._iceDisconnectedTimer) {
      clearTimeout(this._iceDisconnectedTimer);
      this._iceDisconnectedTimer = null;
    }
    if (this._dcReconnectTimer) {
      clearTimeout(this._dcReconnectTimer);
      this._dcReconnectTimer = null;
    }
    if (this._stableResetTimer) {
      clearTimeout(this._stableResetTimer);
      this._stableResetTimer = null;
    }
    this.releaseControl('viewer-disconnect');
    this.stopMediaTelemetry();
    this.stopTunnelRelay();
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    document.getElementById('remoteVideo').classList.remove('connected');
    document.body.classList.remove('stream-connected');
    document.getElementById('loading')?.classList.remove('is-connecting');
    Auth.logout();
  },

  handleViewerSuperseded(payload = {}) {
    if (this._superseded) {
      return;
    }
    console.warn('[VIEWER] superseded', payload?.reason || 'unknown', payload?.bySocketId || '');
    this._superseded = true;
    this.manualDisconnect = true;
    this.offerInProgress = false;
    this._offerEpoch += 1;

    try {
      if (this.socket?.io && typeof this.socket.io.reconnection === 'function') {
        this.socket.io.reconnection(false);
      }
    } catch (_err) {
      // Ignore manager API gaps in tests / older clients.
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this._dcTimeout) {
      clearTimeout(this._dcTimeout);
      this._dcTimeout = null;
    }
    if (this._disconnectedTimer) {
      clearTimeout(this._disconnectedTimer);
      this._disconnectedTimer = null;
    }
    if (this._iceDisconnectedTimer) {
      clearTimeout(this._iceDisconnectedTimer);
      this._iceDisconnectedTimer = null;
    }
    if (this._dcReconnectTimer) {
      clearTimeout(this._dcReconnectTimer);
      this._dcReconnectTimer = null;
    }
    this.clearMediaResumeFallback();
    this.clearPortSearchTimers();
    this.stopPortSearch('viewer-superseded');
    this.stopControlHeartbeat();
    this.stopMediaTelemetry();
    this.stopTunnelRelay();
    if (this._latencySyncInterval) {
      clearInterval(this._latencySyncInterval);
      this._latencySyncInterval = null;
    }

    if (this.pc) {
      this.pc.oniceconnectionstatechange = null;
      this.pc.onconnectionstatechange = null;
      this.pc.onsignalingstatechange = null;
      this.pc.onicegatheringstatechange = null;
      this.pc.onicecandidate = null;
      this.pc.ontrack = null;
      try {
        this.pc.close();
      } catch (_err) {}
      this.pc = null;
    }
    this.inputChannel = null;
    this.inputMoveChannel = null;
    this.remoteStream = null;

    // Local freeze only — do not emit control-release on a dying/dead socket.
    try {
      this.freezeControl('viewer-superseded', true);
    } catch (_err) {}

    const videoElement = document.getElementById('remoteVideo');
    if (videoElement) {
      videoElement.srcObject = null;
      videoElement.classList.remove('connected');
    }
    document.body?.classList?.remove('stream-connected');
    document.getElementById('loading')?.classList?.add('hidden');
    document.getElementById('loading')?.classList?.remove('is-connecting');
    this.setUiPhase('disconnected', { reason: 'viewer-superseded' });

    if (this.socket) {
      try {
        if (this.socket.connected) {
          this.socket.disconnect();
        }
      } catch (_err) {}
      this.socket = null;
    }

    this.showSupersededUI(payload);
  },

  showSupersededUI(_payload = {}) {
    const overlay = document.getElementById('viewerSupersededOverlay');
    if (overlay) {
      overlay.classList.remove('hidden');
      overlay.hidden = false;
    }
  },

  hideSupersededUI() {
    const overlay = document.getElementById('viewerSupersededOverlay');
    if (overlay) {
      overlay.classList.add('hidden');
      overlay.hidden = true;
    }
  },

  reclaimDesktopSession() {
    this.hideSupersededUI();
    this._superseded = false;
    this.manualDisconnect = false;
    this._reconnectAttempt = 0;
    this._autoFailCount = 0;
    this.offerInProgress = false;
    this._offerEpoch += 1;
    this.beginConnectionAttempt('reclaim');
    document.getElementById('loading')?.classList?.remove('hidden');
    document.getElementById('loading')?.classList?.add('is-connecting');
    updateLoadingText('正在重新连接桌面…');
    this.createSignalingSocket(true);
    if (this.networkMode !== 'tunnel') {
      this.createPeerConnection();
    }
  }
};

if (typeof globalThis !== 'undefined') {
  globalThis.WebRTC = WebRTC;
}

function updateConnectionStatus(status) {
  const statusEl = document.getElementById('connectionStatus');
  statusEl.className = 'status ' + status;
  
  const statusText = {
    connecting: '连接中',
    'media-pending': '正在出画',
    connected: '已连接',
    'media-stalled': '画面卡顿',
    disconnected: '已断开',
  };
  statusEl.textContent = statusText[status] || status;
}

function updateLoadingText(text) {
  const loadingText = document.getElementById('loadingText');
  if (loadingText) {
    loadingText.textContent = text;
  }
}

function bootViewerShell() {
  if (window.__WRD_VIEWER_BOOTED__) return;
  window.__WRD_VIEWER_BOOTED__ = true;
  WebRTC.initializeMediaActivity();
  if (typeof StartupTelemetry !== 'undefined') {
    // Import ShellGuard marks with original performance timestamps only.
    const shellSnap = window.__WRD_SHELL__?.snapshot?.();
    if (shellSnap?.marks?.length && typeof StartupTelemetry.importMarks === 'function') {
      StartupTelemetry.importMarks(shellSnap.marks);
    }
    if (typeof performance !== 'undefined' && performance.getEntriesByType
      && typeof StartupTelemetry.recordResources === 'function') {
      StartupTelemetry.recordResources(performance.getEntriesByType('resource') || []);
    }
  }

  const ViewerBootstrap = (typeof createViewerBootstrap === 'function')
    ? createViewerBootstrap({
      timeoutMs: 3000,
      async fetchSnapshot({ turnServerId, signal }) {
        const apiBase = (typeof RuntimeConfig !== 'undefined')
          ? RuntimeConfig.getApiBase()
          : '';
        const query = turnServerId ? `?turnServerId=${encodeURIComponent(turnServerId)}` : '';
        const response = await fetch(`${apiBase}/api/viewer-bootstrap${query}`, {
          cache: 'no-store',
          signal,
          headers: { Authorization: `Bearer ${Auth.getToken()}` },
        });
        if (!response.ok) {
          const error = new Error(`Viewer bootstrap HTTP ${response.status}`);
          error.status = response.status;
          throw error;
        }
        return response.json();
      },
      fallbackFactory({ mode, error }) {
        return {
          schemaVersion: 1,
          degraded: true,
          degradedReason: error?.code || 'bootstrap-unavailable',
          host: { online: null, capabilities: {} },
          webrtc: {
            stunUrls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'],
            iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
            turnConfigured: false,
            turnStatus: 'unavailable',
            selectedTurnServerId: '',
          },
          mode,
        };
      },
    })
    : null;

  // Align preload key with startViewer (mode + selected TURN) so Start reuses the inflight fetch.
  if (ViewerBootstrap) {
    ViewerBootstrap.load({
      mode: WebRTC.networkMode,
      turnServerId: WebRTC.selectedTurnServerId || '',
    }).catch(() => {});
  } else {
    WebRTC.loadServerConfig().then(() => {
      WebRTC.configureNetworkControls();
      WebRTC.updateNetworkUI('请根据访问环境选择网络模式。');
    }).catch(() => {});
  }

  const startHandler = WebRTC.createStartHandler(ViewerBootstrap);
  if (window.__WRD_SHELL__ && typeof window.__WRD_SHELL__.installCore === 'function') {
    window.__WRD_SHELL__.installCore(startHandler);
  }
  // Bind network mode controls immediately after core is interactive,
  // regardless of bootstrap path. configureNetworkControls is idempotent
  // (guarded by dataset.bound), so the init() call later is a no-op.
  WebRTC.configureNetworkControls();
  WebRTC.updateNetworkUI('请根据访问环境选择网络模式。');
  if (typeof StartupTelemetry !== 'undefined' && typeof StartupTelemetry.importMarks === 'function') {
    const shellSnapAfter = window.__WRD_SHELL__?.snapshot?.();
    if (shellSnapAfter?.marks?.length) {
      StartupTelemetry.importMarks(shellSnapAfter.marks);
    }
  }

  // Non-critical operator tools: load after core-interactive without blocking Start.
  // Diagnostic + port-search stay disabled until this succeeds or fails with retry.
  WebRTC._operatorToolsState = WebRTC._operatorToolsState || 'loading';
  WebRTC._retryOperatorTools = null;
  (function loadDeferredDesktop(attempt = 0) {
    const src = window.__WRD_ASSETS__ && window.__WRD_ASSETS__.desktopDeferredJs;
    function markOperatorToolsReady() {
      WebRTC._operatorToolsState = 'ready';
      WebRTC._retryOperatorTools = null;
      WebRTC.renderPortSearchStatus?.();
    }
    function markOperatorToolsFailed() {
      WebRTC._operatorToolsState = 'failed';
      WebRTC._retryOperatorTools = () => {
        WebRTC._operatorToolsState = 'loading';
        WebRTC.renderPortSearchStatus?.();
        loadDeferredDesktop(attempt + 1);
      };
      WebRTC.renderPortSearchStatus?.();
    }

    if (!src) {
      // Source mode already includes full scripts on the page.
      if (typeof Diagnostic !== 'undefined' && Diagnostic.panelState === 'loading'
        && typeof Diagnostic.init === 'function' && Diagnostic.openPanel) {
        Diagnostic.markDeferredReady?.();
      }
      markOperatorToolsReady();
      return;
    }
    if (document.querySelector('script[data-wrd-deferred-desktop="loading"]')) return;

    WebRTC._operatorToolsState = 'loading';
    WebRTC.renderPortSearchStatus?.();
    if (typeof Diagnostic !== 'undefined' && typeof Diagnostic.markDeferredLoading === 'function') {
      Diagnostic.markDeferredLoading();
    }

    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.dataset.wrdDeferredDesktop = 'loading';
    script.onload = () => {
      script.dataset.wrdDeferredDesktop = 'ready';
      markOperatorToolsReady();
    };
    script.onerror = () => {
      script.dataset.wrdDeferredDesktop = 'failed';
      script.remove();
      console.warn('[viewer] deferred desktop tools failed to load');
      markOperatorToolsFailed();
      if (typeof Diagnostic !== 'undefined' && typeof Diagnostic.markDeferredFailed === 'function') {
        Diagnostic.markDeferredFailed(() => {
          if (typeof Diagnostic.markDeferredLoading === 'function') {
            Diagnostic.markDeferredLoading();
          }
          if (typeof WebRTC._retryOperatorTools === 'function') {
            WebRTC._retryOperatorTools();
          } else {
            loadDeferredDesktop(attempt + 1);
          }
        });
      }
    };
    document.head.appendChild(script);
  }());

  const TerminalLoader = (typeof createTerminalLoader === 'function')
    ? createTerminalLoader({
      assets: window.__WRD_ASSETS__ || null,
      document,
      timeoutMs: 5000,
    })
    : null;

  function setTerminalLoadFailure(error) {
    const warning = document.getElementById('terminalWarning');
    const retry = document.getElementById('terminalLoadRetryBtn');
    if (warning) {
      warning.textContent = error?.message || 'Terminal 资源加载失败';
      warning.classList.remove('hidden');
    }
    if (retry) retry.hidden = false;
  }

  async function openTerminal({ retry = false } = {}) {
    if (!TerminalLoader) {
      if (typeof TerminalPanel !== 'undefined' && TerminalPanel?.init) {
        TerminalPanel.init();
        TerminalPanel.showTerminal();
      }
      return;
    }
    try {
      const panel = retry ? await TerminalLoader.retry() : await TerminalLoader.load();
      document.getElementById('terminalWarning')?.classList.add('hidden');
      const retryButton = document.getElementById('terminalLoadRetryBtn');
      if (retryButton) retryButton.hidden = true;
      panel.showTerminal();
    } catch (error) {
      setTerminalLoadFailure(error);
    }
  }

  document.getElementById('terminalTabBtn')?.addEventListener('click', () => openTerminal());
  document.getElementById('terminalLoadRetryBtn')?.addEventListener('click', () => openTerminal({ retry: true }));

  const refreshBtn = document.getElementById('refreshBtn');
  if (refreshBtn) {
    let lastRefreshTime = 0;
    refreshBtn.addEventListener('click', () => {
      const now = Date.now();
      if (now - lastRefreshTime < 5000) {
        console.log('[REFRESH] Debounced: too soon since last refresh');
        return;
      }
      lastRefreshTime = now;
      WebRTC.refresh({ reason: 'manual' });
    });
  }

  const portSearchBtn = document.getElementById('portSearchBtn');
  if (portSearchBtn) {
    portSearchBtn.addEventListener('click', () => {
      if (WebRTC._operatorToolsState === 'failed' && typeof WebRTC._retryOperatorTools === 'function') {
        WebRTC._retryOperatorTools();
        return;
      }
      if (WebRTC._operatorToolsState !== 'ready') {
        WebRTC.updateNetworkUI?.('端口搜索组件加载中…', 'warning');
        return;
      }
      if (WebRTC.isPortSearchActive()) {
        WebRTC.stopPortSearch('user');
      } else {
        WebRTC.startPortSearch();
      }
    });
    // Tests and source mode often already have StunPortSearchController; default ready then.
    if (typeof StunPortSearchController !== 'undefined' || window.StunPortSearchController) {
      WebRTC._operatorToolsState = WebRTC._operatorToolsState || 'ready';
    } else {
      WebRTC._operatorToolsState = WebRTC._operatorToolsState || 'loading';
    }
    WebRTC.renderPortSearchStatus();
  }

  // Resolution modal
  const resolutionBtn = document.getElementById('resolutionBtn');
  const resolutionModal = document.getElementById('resolutionModal');
  const applyResolution = document.getElementById('applyResolution');
  const closeResolution = document.getElementById('closeResolution');
  const adaptiveToggle = document.getElementById('adaptiveResolutionToggle');

  if (adaptiveToggle && !adaptiveToggle.dataset.bound) {
    adaptiveToggle.dataset.bound = '1';

    adaptiveToggle.checked = WebRTC.adaptiveResolutionEnabled === true;
    adaptiveToggle.addEventListener('change', () => {
      WebRTC.setAdaptiveResolutionEnabled(adaptiveToggle.checked);
    });
  }
  if (resolutionModal) {
    WebRTC._resolutionModalApi = WebRTC._resolutionModalApi
      || WebRTC.bindSettingsModal(resolutionModal, { closeBtn: closeResolution });
  }
  if (resolutionBtn && resolutionModal) {
    resolutionBtn.addEventListener('click', () => {
      if (adaptiveToggle) adaptiveToggle.checked = WebRTC.adaptiveResolutionEnabled === true;
      WebRTC._resolutionModalApi.open();
    });
  }
  if (applyResolution && resolutionModal) {
    applyResolution.addEventListener('click', async () => {
      if (adaptiveToggle) {
        WebRTC.setAdaptiveResolutionEnabled(adaptiveToggle.checked);
      }
      const selected = document.querySelector('input[name="resolution"]:checked');
      if (selected) {
        const width = parseInt(selected.dataset.width, 10);
        const height = parseInt(selected.dataset.height, 10);
        const changed = await WebRTC.requestResolution(width, height);
        if (!changed) return;
        document.getElementById('resolutionDisplay').textContent = `${width}x${height}`;
        WebRTC._resolutionModalApi.close();
      }
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootViewerShell, { once: true });
} else {
  bootViewerShell();
}
