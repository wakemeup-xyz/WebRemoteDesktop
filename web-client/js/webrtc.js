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
    text: '外网中继正在追帧，画面可能短暂发黑（约 2 秒）。若 3 秒内不恢复或反复出现，请改用 720p 或手动切换「隧道中继」。',
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

const FRAME_TRACE_STAGES = [
  'grab', 'age_at_recv', 'worker_queue', 'prepare', 'build',
  'reformat', 'encode', 'packetize', 'encode_total',
];
const FRAME_TRACE_ROW_FIELDS = [
  'attemptId', 'generation', 'streamId', 'captureSeq', 'encoderTimestamp',
  'wireTimestamp', 'ssrc', 'framePts', 'idrKind', 'idrReason', 'policyDigest', 'stages',
];

// Host diagnostics use a monotonic Host clock.  This collector deliberately
// performs identity joins only: rVFC's rtpTimestamp is never subtracted from a
// Host timestamp or compared to the encoder's pre-origin timestamp.
class FrameTraceCollector {
  constructor({ now = () => performance.now(), capacity = 256, ttlMs = 30000, lateWaitMs = 2000 } = {}) {
    this.now = now;
    this.capacity = Math.min(256, Math.max(1, capacity));
    this.ttlMs = Math.min(30000, ttlMs);
    this.lateWaitMs = Math.min(2000, lateWaitMs);
    this.frames = new Map();
    this.traces = new Map();
    this.seen = new Map();
    this.matched = [];
    // Kept separately from `matched`: the Lab loss tap needs the same T3
    // join for the rVFC which just accepted it, while T3 itself owns and
    // drains the queued evidence.
    this.lastMatched = null;
    this.unaligned = false;
    this.terminalUnaligned = false;
    this.droppedTraceCount = 0;
    this.invalidBatchCount = 0;
    this.staleTraceCount = 0;
    this.conflictingTraceCount = 0;
    this.scope = null;
  }

  setScope(scope) {
    const next = scope && scope.attemptId && Number.isSafeInteger(Number(scope.generation))
      ? this.scopeIdentity(scope)
      : null;
    if (next === this.scope) return false;
    this.scope = next;
    this.frames.clear();
    this.traces.clear();
    this.seen.clear();
    this.matched = [];
    this.lastMatched = null;
    this.unaligned = false;
    this.terminalUnaligned = false;
    this.droppedTraceCount = 0;
    this.invalidBatchCount = 0;
    this.staleTraceCount = 0;
    this.conflictingTraceCount = 0;
    return true;
  }

  isInScope(value) {
    return !this.scope || this.scopeIdentity(value) === this.scope;
  }

  scopeIdentity(value) {
    return [value?.attemptId, Number(value?.generation), value?.streamId || 'video'].join('|');
  }

  identity(value) {
    return [value?.attemptId, Number(value?.generation), value?.streamId,
      value?.ssrc, Number(value?.wireTimestamp) >>> 0].join('|');
  }

  isValidTrace(trace) {
    if (!trace || typeof trace !== 'object' || Array.isArray(trace)) return false;
    const fields = Object.keys(trace).sort();
    if (fields.length !== FRAME_TRACE_ROW_FIELDS.length
        || fields.some((field, index) => field !== [...FRAME_TRACE_ROW_FIELDS].sort()[index])) return false;
    const isUInt32 = (value) => typeof value === 'number' && Number.isSafeInteger(value)
      && value >= 0 && value <= 0xFFFFFFFF;
    const nonemptyString = (value) => typeof value === 'string' && value.trim().length > 0;
    const nullableString = (value) => value === null || nonemptyString(value);
    if (!nonemptyString(trace.attemptId)
        || typeof trace.generation !== 'number' || !Number.isSafeInteger(trace.generation) || trace.generation < 0
        || !nonemptyString(trace.streamId)
        || typeof trace.captureSeq !== 'number' || !Number.isSafeInteger(trace.captureSeq) || trace.captureSeq < 0
        || !isUInt32(trace.encoderTimestamp) || !isUInt32(trace.wireTimestamp) || !isUInt32(trace.ssrc)
        || typeof trace.framePts !== 'number' || !Number.isSafeInteger(trace.framePts)
        || !nullableString(trace.idrKind) || !nullableString(trace.idrReason)
        || (trace.idrKind === null) !== (trace.idrReason === null)
        || !nonemptyString(trace.policyDigest)
        || !trace.stages || typeof trace.stages !== 'object' || Array.isArray(trace.stages)) return false;
    const stageFields = Object.keys(trace.stages).sort();
    if (stageFields.length !== FRAME_TRACE_STAGES.length
        || stageFields.some((field, index) => field !== [...FRAME_TRACE_STAGES].sort()[index])) return false;
    return FRAME_TRACE_STAGES.every((stage) => trace.stages[stage] === null
      || (typeof trace.stages[stage] === 'number' && Number.isFinite(trace.stages[stage]) && trace.stages[stage] >= 0));
  }

  rejectInvalidBatch() {
    this.invalidBatchCount += 1;
    this.failClosed();
    return 0;
  }

  failClosed() {
    this.unaligned = true;
    this.terminalUnaligned = true;
    this.frames.clear();
    this.traces.clear();
    this.matched = [];
  }

  prune(map, ttlMs = this.lateWaitMs) {
    const deadline = Number(this.now()) - ttlMs;
    for (const [id, entry] of map) {
      if (entry.at <= deadline) {
        map.delete(id);
        if (map !== this.seen) { this.unaligned = true; this.droppedTraceCount += 1; }
      }
    }
  }

  expire() {
    this.prune(this.frames);
    this.prune(this.traces);
    this.prune(this.seen, this.ttlMs);
    const lateDeadline = Number(this.now()) - this.lateWaitMs;
    for (const entry of this.frames.values()) {
      if (entry.at <= lateDeadline) this.unaligned = true;
    }
    for (const entry of this.traces.values()) {
      if (entry.at <= lateDeadline) this.unaligned = true;
    }
    const deadline = Number(this.now()) - this.lateWaitMs;
    while (this.matched.length && this.matched[0].at <= deadline) {
      this.matched.shift();
      this.unaligned = true;
    }
  }

  appendMatch(value) {
    if (this.matched.length >= Math.min(128, this.capacity)) {
      this.matched.shift(); this.droppedTraceCount += 1;
    }
    this.matched.push({ at: value.viewerClockMs, value });
    this.matched.sort((a, b) => a.at - b.at);
    this.lastMatched = value;
    return true;
  }

  matchedVisual(trace, rtpTimestamp, roi, at) {
    // This is the only browser-side conversion from a Host trace plus rVFC.
    // Keep every join identity so downstream scene validation never needs to
    // invent a timestamp or infer a generation from a marker.
    return {
      attemptId: trace.attemptId,
      generation: trace.generation,
      streamId: trace.streamId,
      captureSeq: trace.captureSeq,
      rtpTimestamp: Number(rtpTimestamp) >>> 0,
      wireTimestamp: trace.wireTimestamp,
      // aiortc applies this uint32 offset between encoder and wire clocks.
      // It is evidence of the observed mapping, never a clock for latency.
      rtpOrigin: (trace.wireTimestamp - trace.encoderTimestamp) >>> 0,
      traceStatus: 'matched',
      viewerClockMs: at,
      idrKind: trace.idrKind || null,
      roi,
      ...(trace.inputIds ? { inputIds: trace.inputIds, scope: trace.scope,
        captureFresh: trace.captureFresh, captureAfterApplied: trace.captureAfterApplied } : {}),
    };
  }

  observeVideoFrame(identity, roi, callbackAtMs) {
    if (this.terminalUnaligned) return false;
    if (typeof callbackAtMs !== 'number' || !Number.isFinite(callbackAtMs) || callbackAtMs < 0) {
      this.unaligned = true;
      return false;
    }
    const timestamp = identity?.rtpTimestamp;
    if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 0xffffffff
        || !Number.isSafeInteger(identity?.ssrc) || identity.ssrc < 0 || identity.ssrc > 0xffffffff
        || !identity.streamId) {
      this.unaligned = true;
      return false;
    }
    this.expire();
    if (!this.isInScope({ ...identity, wireTimestamp: timestamp })) return false;
    const id = this.identity({ ...identity, wireTimestamp: timestamp });
    const trace = this.traces.get(id);
    if (!trace && (this.frames.has(id) || this.seen.has(id))) return false;
    if (trace) {
      this.traces.delete(id);
      this.appendMatch(this.matchedVisual(trace.value, timestamp, roi, callbackAtMs));
      return true;
    }
    if (this.frames.size >= this.capacity) {
      this.frames.delete(this.frames.keys().next().value); this.droppedTraceCount += 1;
    }
    this.frames.set(id, { at: callbackAtMs, value: { identity, roi } });
    return false;
  }

  acceptBatch(batch) {
    if (this.terminalUnaligned) return 0;
    this.expire();
    if (!batch || batch.type !== 'frame_trace_batch' || batch.schemaVersion !== 1
        || !Array.isArray(batch.traces) || batch.traces.length > 64
        || (batch.droppedTraceCount != null
          && (!Number.isSafeInteger(batch.droppedTraceCount) || batch.droppedTraceCount < 0))) return this.rejectInvalidBatch();
    const identities = new Set();
    for (const trace of batch.traces) {
      if (trace && typeof trace.attemptId === 'string' && trace.attemptId.trim() && Number.isSafeInteger(trace.generation) && trace.generation >= 0
          && typeof trace.streamId === 'string' && trace.streamId.trim() && !this.isInScope(trace)) {
        this.staleTraceCount += 1;
        continue;
      }
      if (!this.isValidTrace(trace)) return this.rejectInvalidBatch();
      const id = this.identity(trace);
      if (identities.has(id) || this.traces.has(id) || this.seen.has(id)) {
        this.conflictingTraceCount += 1;
        this.failClosed();
        return 0;
      }
      identities.add(id);
    }

    this.droppedTraceCount += Math.max(0, Number(batch.droppedTraceCount) || 0);
    if (this.droppedTraceCount) this.unaligned = true;
    let joined = 0;
    for (const trace of batch.traces) if (this.isInScope(trace)) joined += this.joinTrace(trace);
    return joined;
  }

  joinTrace(trace) {
    const id = this.identity(trace);
    while (this.seen.size >= 2048) { this.seen.delete(this.seen.keys().next().value); this.droppedTraceCount += 1; }
    this.seen.set(id, { at: Number(this.now()) });
    const frame = this.frames.get(id);
    if (frame) {
      this.frames.delete(id);
      this.appendMatch(this.matchedVisual(trace, frame.value.identity.rtpTimestamp, frame.value.roi, frame.at));
      return 1;
    }
    if (this.traces.size >= this.capacity) {
      this.traces.delete(this.traces.keys().next().value); this.droppedTraceCount += 1;
    }
    this.traces.set(id, { at: Number(this.now()), value: trace });
    return 0;
  }

  acceptBinding(binding, scope) {
    this.expire();
    if (this.terminalUnaligned || !binding || binding.type !== 'input_frame_binding' || binding.schemaVersion !== 1) return 0;
    const fields = ['type', 'schemaVersion', 'scope', 'streamId', 'captureSeq', 'encoderTimestamp', 'wireTimestamp', 'ssrc', 'captureFresh', 'captureAfterApplied', 'inputIds'];
    if (Object.keys(binding).length !== fields.length || fields.some(k => !Object.hasOwn(binding, k))) return 0;
    if (!scope || Object.keys(binding.scope || {}).length !== 3
        || !['connectionAttemptId', 'generation', 'leaseEpoch'].every(k => binding.scope[k] === scope[k])) { this.staleTraceCount += 1; return 0; }
    const uint = value => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff;
    if (binding.captureFresh !== true || binding.captureAfterApplied !== true || binding.streamId !== 'video'
        || !Number.isSafeInteger(binding.captureSeq) || binding.captureSeq < 0
        || !['encoderTimestamp', 'wireTimestamp', 'ssrc'].every(k => uint(binding[k]))
        || !Array.isArray(binding.inputIds) || binding.inputIds.length < 1 || binding.inputIds.length > 64
        || binding.inputIds.some(id => typeof id !== 'string' || !/^[\x20-\x7e]{1,128}$/.test(id))
        || new Set(binding.inputIds).size !== binding.inputIds.length) return 0;
    const trace = { ...binding, attemptId: scope.connectionAttemptId, generation: scope.generation };
    const id = this.identity(trace);
    if (this.seen.has(id)) { this.conflictingTraceCount += 1; this.failClosed(); return 0; }
    return this.joinTrace(trace);
  }

  takeMatched() {
    this.expire();
    const matched = this.matched.map((entry) => entry.value);
    this.matched = [];
    return matched;
  }

  latestMatchedForRtp(rtpTimestamp) {
    if (this.lastMatched && this.now() - this.lastMatched.viewerClockMs >= this.lateWaitMs) this.lastMatched = null;
    const row = this.lastMatched;
    if (!row || (Number(row.rtpTimestamp) >>> 0) !== (Number(rtpTimestamp) >>> 0)) return null;
    // Callers must not be able to mutate the T3-owned join object.
    return { ...row };
  }

  takeControlledVisualEvidence() {
    // Convert only actual decoded-video marker pixels plus an already matched
    // T3 row into the strict SceneResult visual schema.  Diagnostics with an
    // absent/invalid marker never become scene evidence.
    return this.takeMatched().flatMap((row) => {
      const marker = row?.roi?.marker;
      if (!marker || row.traceStatus !== 'matched') return [];
      return [{
        marker, viewerClockMs: row.viewerClockMs, attemptId: row.attemptId,
        generation: row.generation, streamId: row.streamId,
        rtpTimestamp: row.rtpTimestamp, wireTimestamp: row.wireTimestamp,
        captureSeq: row.captureSeq, rtpOrigin: row.rtpOrigin,
        traceStatus: row.traceStatus,
        ...(row.inputIds ? { inputIds: row.inputIds, scope: row.scope,
          captureFresh: row.captureFresh, captureAfterApplied: row.captureAfterApplied } : {}),
      }];
    });
  }

  diagnostics() {
    this.expire();
    return {
      acceptanceState: this.unaligned ? 'UNALIGNED' : 'PENDING',
      pendingFrames: this.frames.size,
      pendingTraces: this.traces.size,
      seenIdentities: this.seen.size,
      matchedCount: this.matched.length,
      droppedTraceCount: this.droppedTraceCount,
      invalidBatchCount: this.invalidBatchCount,
      staleTraceCount: this.staleTraceCount,
      conflictingTraceCount: this.conflictingTraceCount,
    };
  }

  acceptanceState() {
    this.expire();
    return this.unaligned ? 'UNALIGNED' : 'PENDING';
  }
}

function controlledCrc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xEDB88320 : 0);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function decodeControlledMarkerRgba(data, width, height) {
  if (!ArrayBuffer.isView(data) || data.BYTES_PER_ELEMENT !== 1 || width !== 256 || height !== 128 || data.length !== width * height * 4) return null;
  const grid = [];
  for (let gy = 0; gy < 16; gy += 1) {
    const row = [];
    for (let gx = 0; gx < 32; gx += 1) {
      const centre = [];
      for (let y = gy * 8 + 2; y < gy * 8 + 6; y += 1) for (let x = gx * 8 + 2; x < gx * 8 + 6; x += 1) centre.push(data[(y * width + x) * 4]);
      const value = centre.sort((a, b) => a - b)[8];
      if (value > 96 && value < 160) return null;
      row.push(value >= 160 ? 1 : 0);
    }
    grid.push(row);
  }
  if (grid[0][0] !== 0 || grid[0][31] !== 1 || grid[15][0] !== 1 || grid[15][31] !== 1) return null;
  for (let x = 1; x < 31; x += 1) if (grid[0][x] !== ((x - 1) % 2) || grid[15][x] !== 0) return null;
  for (let y = 1; y < 15; y += 1) if (grid[y][0] !== 1 || grid[y][31] !== 1) return null;
  const interior = grid.slice(1, 15).flatMap((row) => row.slice(1, 31));
  const a = interior.slice(0, 192), b = interior.slice(192, 384);
  if (a.length !== 192 || a.some((value, index) => value !== b[index])) return null;
  if (interior.slice(384).some((value, index) => value !== (index % 2))) return null;
  const bytes = new Uint8Array(24);
  a.forEach((value, index) => { bytes[Math.floor(index / 8)] |= value << (7 - (index % 8)); });
  const view = new DataView(bytes.buffer);
  if (bytes[0] !== 1 || bytes[1] !== 0 || controlledCrc32(bytes.slice(0, 20)) !== view.getUint32(20)) return null;
  // JSON cannot safely transport every uint64 as a Number.  Preserve the
  // decoded nonce canonically; the Python evidence validator accepts this
  // exact decimal representation alongside in-process integer fixtures.
  return { runNonce: view.getBigUint64(2).toString(), sceneId: view.getUint16(10), tick: view.getUint32(12), actionId: view.getUint32(16) };
}

const WebRTC = {
  pc: null,
  socket: null,
  controlState: { state: 'FREE', controller: false, lease: null, hostOnline: false },
  _controlHeartbeatTimer: null,
  _controlRequestId: 0,
  _controlAcquireIntent: null,
  _controlRecoveryGeneration: 0,
  _controlUserReleased: false,
  _controlLifecycleBound: false,
  _fullscreenLifecycleBound: false,
  _fullscreenLifecycleHandler: null,
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
  _refreshDcWaitTimer: null,
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
  _mediaResumeReadyReplay: null,
  _mediaIntent: null,
  _mediaRequestRetryUsed: false,
  _mediaResumeRefreshFallbackUsed: false,
  _mediaFailureHandledKey: null,
  _mediaReadyConnectionAttemptId: null,
  _lastInboundFramesDecoded: 0,
  _lastInboundFramesDecodedAt: null,
  _videoFrameSeq: 0,
  uiPhase: 'idle',
  hasPaintedFrame: false,
  _firstFrameTimer: null,
  _paintDecodedBaseline: 0,
  _stallSince: null,
  _paintPending3sTimer: null,
  _paintPending8sTimer: null,
  _paintStalled3sTimer: null,
  _paintStalled6sTimer: null,
  _paintIssueKind: null,
  _lastPaintStats: null,
  _paintObservationWindow: null,
  _lastPaintObservation: null,
  _keyframeRequested: false,
  _keyframeEmitted: false,
  _keyframeRequestGeneration: '',
  _keyframeRequestSequence: 0,
  // Disabled unless the isolated Lab adapter explicitly arms it.  The normal
  // Viewer neither retains packet diagnostics nor calls getStats for this.
  _lossLabTrace: null,
  _hostCaptureFps: 0,
  frameTraceCollector: null,
  adaptiveMediaEnabled: true,
  // When false, adaptive path may still change fps/bitrate, but never width/height.
  // Default OFF so user-chosen resolution is stable (esp. on high-RTT TURN).
  adaptiveResolutionEnabled: localStorage.getItem('wrdAdaptiveResolution') === '1',
  noMediaTicks: 0,
  lastCandidateType: '',
  _autoFailCount: 0,
  _iceRestartAttempts: 0,
  _reconnectAttempt: 0,
  // A Socket.IO reconnect is independent from the WebRTC peer.  Keep a small
  // supervisor so a transient signaling outage cannot leave a connected-looking
  // peer with a dead control/session context forever.
  _signalRecoveryTimer: null,
  _signalRecoveryStartedAt: null,
  _signalRecoveryPending: false,
  _viewerSessionId: null,
  _viewerAdmission: null,
  _explicitAdmissionSequence: 0,
  _reclaimPromise: null,
  _pendingBootstrapConfig: null,
  SIGNAL_RECOVERY_RETRY_MS: 1500,
  // Keep the client recovery window below the server's 30s viewer grace
  // period so a reconnect can still rebind the original lease.
  SIGNAL_RECOVERY_MAX_WAIT_MS: 24000,
  _pageLifecycleRecoveryBound: false,
  _pageLifecycleHidden: false,
  _relayHardRefreshCount: 0,
  _rebuildingDc: false,
  _noRelayReceiveCount: 0,
  _inputDcDegraded: false,
  _tunnelLockUntil: 0,
  _lastRefreshAt: null,
  _lastKeyframeRequestAt: null,
  _dcKeepaliveTimer: null,
  currentConnectionAttemptId: '',
  connectionAttemptSequence: 0,
  _mediaProfileSequence: 0,
  desktopSessionState: null,
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
    const result = this.mediaActivityController.setReason(reason, enabled);
    if (typeof LatencyMonitor !== 'undefined') {
      this.syncLatencyScope();
      LatencyMonitor.setMediaState?.(result.state === 'active', { scope: this.latencyScope() });
    }
    return result;
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
      && (!this.tunnelRelayActive || (this.relayScopeMatches(this._relayExpectedScope)
        && this._relayLastLoadedAtMs != null && !this._relayFrameStale))
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
    this.checkStartupEpisode({ suspended: snapshot?.state === 'suspended' });
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
      if (this.tunnelRelayActive) this.clearRelayOrigin();
      this.clearMediaResumeProof();
      this._mediaRequestRetryUsed = false;
      this._mediaResumeRefreshFallbackUsed = false;
      this._mediaResumeSoftRecoverUsed = false;
    }
    this._mediaIntent = {
      state: desired,
      reasons: Array.isArray(snapshot?.reasons) ? snapshot.reasons.slice(0, 8) : [],
      generation,
    };
    if (desired === 'suspended') this.clearPaintPendingCopyTimers();
    else if (this.uiPhase === 'media-pending') this.schedulePaintPendingCopyTimers();

    // Immediate local gates on suspend.
    if (desired === 'suspended') {
      this.clearRelayOrigin();
      if (typeof Input !== 'undefined') {
        // Keep lease; only release pointer + keys. Do not open a keyboard reset
        // barrier that blocks typing after a brief hide/resume cycle.
        Input.setActive(false, { resetKeyboard: false, reason: 'media-suspended' });
        Input.releasePointer?.('media-suspended');
        const keyboardSnapshot = Input.keyboardController?.getSnapshot?.() || {};
        const keyboardNeedsParking = Number(keyboardSnapshot.pressedKeyCount) > 0
          || keyboardSnapshot.state === 'RESET_REQUIRED';
        if (this.inputChannel?.readyState !== 'open' && keyboardNeedsParking) {
          Input.parkKeyboard?.('media-suspended');
        }
      }
      if (this.isPortSearchActive()) this.stopPortSearch('media-suspended');
      this.noMediaTicks = 0;
      this.clearMediaResumeProof();
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
    // Terminal deliberately suspends desktop media while keeping the signaling
    // session alive. Keep the chrome capability gate and status text in sync
    // with that local reason immediately; no new video frame is expected to
    // arrive while the Terminal owns the workspace.
    this.syncChromeCapabilities();
    if (this.uiPhase !== 'disconnected' && this.uiPhase !== 'signaling') {
      if (this._mediaIntent.reasons.includes('terminal-active')) {
        updateConnectionStatus('media-paused-terminal');
      } else if (this.uiPhase) {
        updateConnectionStatus(this.uiPhase);
      }
    }
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
    const baseline = this._mediaResumeBaseline;
    this._mediaResumeFrameTimer = setTimeout(() => {
      this._mediaResumeFrameTimer = null;
      if (baseline !== this._mediaResumeBaseline || !this.mediaResumeScopeMatches(baseline)) return;
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

  clearMediaResumeProof() {
    this._mediaResumeFramePending = false;
    this._mediaResumeBaseline = null;
    this._mediaResumeEarlyFrame = null;
    this._lastRenderedRelayFrame = null;
    this._mediaResumeArmPending = false;
    this.clearMediaResumeFallback();
  },

  mediaResumeScope(generation = this._mediaIntent?.generation) {
    const lease = this.activeLeaseEnvelope();
    return {
      connectionAttemptId: this.currentConnectionAttemptId || null,
      generation: Number(generation) || 0,
      leaseId: lease?.leaseId || null,
      leaseEpoch: lease?.leaseEpoch || null,
      pc: this.pc || null,
      relayRevision: Number(this._mediaRelayRevision) || 0,
      socket: this.socket || null,
    };
  },

  mediaResumeScopeMatches(scope) {
    const current = this.mediaResumeScope();
    return Boolean(scope && Object.keys(current).every(key => scope[key] === current[key]));
  },

  captureMediaResumeBaseline(generation) {
    this.clearMediaResumeProof();
    this._mediaResumeBaseline = {
      ...this.mediaResumeScope(generation),
      videoFrameSeq: Number(this._videoFrameSeq) || 0,
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
      // An authorized active request must mount its receiver even while media
      // remains resuming. Starting the receiver is not an input-ready proof.
      if (desired === 'active' && !this.tunnelRelayActive) {
        if (!this.startTunnelRelay({ allowResuming: true, sendRequest: false })) return false;
        // Local producer identity changed; capture after that change, before send.
        this.captureMediaResumeBaseline(snapshot.generation);
      }
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

    if (this.pc) this.pc._wrdConnectionAttemptId = this.currentConnectionAttemptId;
    this.socket.emit('media-activity-change', payload);
    return true;
  },

  handleMediaActivityAck(data = {}) {
    if (data.relayControlKind === 'start') return this.handleRelayStartAck(data);
    if (this.tunnelRelayActive && data.state === 'active' && data.applied === true
      && (data.relayFrameSchemaVersion !== 1 || !this.validRelayScope(data.relayScope)
        || data.relayScope.mediaGeneration !== data.generation
        || data.relayScope.connectionAttemptId !== data.connectionAttemptId)) {
      this.updateNetworkUI('JPEG 来源尚未验证，请刷新页面并升级 Host。', 'warning');
      return;
    }
    if (!this.mediaActivityRuntime) return;
    if (!this.mediaResumeScopeMatches(this._mediaResumeBaseline)
      && data.state === 'active') return;
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
    if (this.tunnelRelayActive && result.phase === 'resuming'
      && !this.acceptRelayScope(data.relayScope)) return;
    this._mediaFailureHandledKey = null;
    if (result.phase === 'resuming') {
      this._mediaResumeFramePending = true;
      this.ensureMediaResumeFallbackArmed('media-ack');
      // Only a frame observed against this exact request baseline can be replayed.
      const earlyFrame = this._mediaResumeEarlyFrame;
      if (earlyFrame) this.observeFreshResumeFrame(earlyFrame);
    }
    if (result.phase === 'suspended') {
      this.clearRelayOrigin();
      this.clearMediaResumeProof();
    }
    this.syncDesktopInputGate();
  },

  observeFreshResumeFrame({
    source = 'unknown',
    frameSeq = null,
    connectionAttemptId = null,
    pc = null,
    generation = null,
    scope = null,
  } = {}) {
    if (!this.mediaActivityRuntime || this.getMediaAppliedPhase() !== 'resuming') return false;
    if (!this.hasActiveControl() || this._mediaIntent?.state !== 'active') return false;
    // Stats and timing notices are diagnostics, never proof that a frame painted.
    if (source !== 'video-callback' && source !== 'relay-frame') return false;
    const baseline = this._mediaResumeBaseline;
    if (!this.mediaResumeScopeMatches(baseline)) return false;
    if (scope && !this.mediaResumeScopeMatches(scope)) return false;
    const runtime = this.mediaActivityRuntime.snapshot();
    if (runtime.connectionAttemptId !== baseline.connectionAttemptId
      || runtime.desiredGeneration !== baseline.generation) return false;
    const attemptId = connectionAttemptId || this.currentConnectionAttemptId || null;
    if (attemptId !== baseline.connectionAttemptId) return false;
    if (generation != null && generation !== baseline.generation) return false;
    if (pc && pc !== baseline.pc) return false;
    const seq = Number(frameSeq);
    if (!Number.isFinite(seq) || seq <= Number(baseline.videoFrameSeq || 0)) return false;
    const frame = { source, frameSeq: seq, connectionAttemptId: attemptId,
      pc: baseline.pc, generation: baseline.generation, scope: baseline };
    if (!this._mediaResumeFramePending) {
      this._mediaResumeEarlyFrame = frame;
      return false;
    }
    const ack = runtime.lastAck;
    if (!ack?.applied || ack.state !== 'active' || ack.generation !== baseline.generation
      || ack.connectionAttemptId !== baseline.connectionAttemptId) return false;
    const result = this.mediaActivityRuntime.noteRenderedFrame({ connectionAttemptId: attemptId });
    if (!result.accepted) return false;
    this.markMediaAttemptReady(attemptId);
    this.clearMediaResumeProof();
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
    if (!attemptId || attemptId !== this.currentConnectionAttemptId || !this.startupAllowed()) return false;
    this._mediaReadyConnectionAttemptId = attemptId;
    this.ensureDesktopSessionState()?.applyMedia({ attemptId, event: 'fresh-frame', fresh: true });
    this.clearFirstFrameDeadline();
    this.checkStartupEpisode({ painted: true });
    if (['retired', 'failed'].includes(this._startupEpisode?.state)) return false;
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
    // The session records an instantaneous media state for diagnostics. A short
    // TURN zero-FPS sample can mark that state stalled while the UI remains in
    // `connected` during its chase window, so use the UI phase as the input
    // gate and fail closed for every non-connected phase.
    const phaseAllowsInput = this.uiPhase === 'connected' && this.hasPaintedFrame === true;
    const controlReady = this.hasActiveControl();
    const socketReady = this.socket?.connected === true;
    const enable = phaseAllowsInput && controlReady && socketReady && this.canEnableDesktopInput();
    Input.setActive(enable);
  },

  ensureDesktopSessionState() {
    if (this.desktopSessionState) return this.desktopSessionState;
    if (typeof DesktopSessionState !== 'undefined' && DesktopSessionState?.snapshot) {
      this.desktopSessionState = DesktopSessionState;
    } else if (typeof createDesktopSessionState === 'function') {
      this.desktopSessionState = createDesktopSessionState();
    }
    return this.desktopSessionState;
  },

  getDesktopSessionSnapshot() {
    return this.ensureDesktopSessionState()?.snapshot?.() || {
      attemptId: this.currentConnectionAttemptId || null,
      phase: this.uiPhase || 'idle',
      media: this.hasPaintedFrame ? 'live' : 'none',
      control: this.hasActiveControl() ? 'active' : 'free',
      socket: this.socket?.connected ? 'online' : 'offline',
      canInput: false,
      lastTransitionAt: Date.now(),
    };
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

  _recordInputTrace(stage, meta = {}) {
    if (typeof Diagnostic === 'undefined' || typeof Diagnostic.recordInputTrace !== 'function') return null;
    const inputTypes = new Set(['keyboard', 'pointer', 'text', 'control']);
    const actions = new Set(['active', 'inactive', 'recovery', 'retry', 'reset', 'pause', 'resume']);
    const states = new Set(['active', 'inactive', 'uncertain', 'pending', 'paused', 'resumed', 'ready', 'blocked']);
    const reasons = new Set([
      'attempt-changed', 'datachannel-available', 'datachannel-unavailable', 'transport-change',
      'recovery-timeout', 'manual', 'manual-pause', 'page-hidden', 'resume', 'reacquire-required',
    ]);
    const sources = new Set(['lifecycle', 'transport', 'recovery', 'manual', 'auto', 'user']);
    const transports = new Set(['datachannel', 'socket', 'none']);
    const inputType = inputTypes.has(meta.inputType) ? meta.inputType : 'control';
    const action = actions.has(meta.action) ? meta.action : 'recovery';
    const state = states.has(meta.state) ? meta.state : null;
    const reason = reasons.has(meta.reason) ? meta.reason : 'transport-change';
    const source = sources.has(meta.source) ? meta.source : 'lifecycle';
    const transport = transports.has(meta.transport) ? meta.transport : null;
    const safe = { inputType, action, reason, source };
    if (state) safe.state = state;
    if (transport) safe.transport = transport;
    if (typeof meta.accepted === 'boolean') safe.accepted = meta.accepted;
    if (Number.isSafeInteger(meta.generation) && meta.generation >= 0) {
      safe.generation = Math.min(meta.generation, 0x7fffffff);
    }
    if (typeof this.currentConnectionAttemptId === 'string'
      && this.currentConnectionAttemptId.length > 0) {
      safe.connectionAttemptId = this.currentConnectionAttemptId;
    }
    const leaseEpoch = typeof Input !== 'undefined' ? Input.activeControlLease?.leaseEpoch : null;
    if (Number.isSafeInteger(leaseEpoch) && leaseEpoch >= 0) safe.leaseEpoch = leaseEpoch;
    try {
      return Diagnostic.recordInputTrace(stage, safe);
    } catch (_) {
      // Input diagnostics are observational and cannot affect reconnect behavior.
      return null;
    }
  },

  latencyScope() {
    return {
      connectionAttemptId: this.currentConnectionAttemptId,
      generation: Number(this.connectionAttemptSequence) || 0,
      leaseEpoch: typeof Input !== 'undefined' ? (Input.activeControlLease?.leaseEpoch ?? 0) : 0,
    };
  },

  syncLatencyScope() {
    if (typeof LatencyMonitor !== 'undefined') LatencyMonitor.setScope?.(this.latencyScope());
  },

  captureControlledTransportSnapshot() {
    const reliable = this.inputChannel;
    const move = this.inputMoveChannel?.readyState === 'open' ? this.inputMoveChannel : reliable;
    const selected = channel => channel?.readyState === 'open'
      && channel !== this._quarantinedInputChannel ? channel : null;
    const socket = this.socket || null;
    const socketId = socket?.id;
    return {
      pc: this.pc || null,
      datachannel: { selectedMoveSendSource: selected(move),
        selectedReliableSendSource: selected(reliable), reliableAckSource: reliable || null },
      socket: { selectedSendSource: socket?.connected ? socket : null,
        reliableAckSource: socket?.connected ? socket : null, object: socket,
        id: typeof socketId === 'string' && socketId.length > 0 && socketId.length <= 128 ? socketId : null },
    };
  },

  acceptObservedInputAck(data, context = {}) {
    let controlledArrival = null;
    try {
      const viewerClockMs = performance.now();
      controlledArrival = {
        viewerClockMs, scope: this.latencyScope(),
        leaseId: typeof Input !== 'undefined' ? Input.activeControlLease?.leaseId : null,
        streamId: this.currentFrameTraceIdentity().streamId,
        transport: context.transport,
        source: context.transport === 'socket' ? context.socket : context.dataChannel,
        socketId: context.transport === 'socket' ? (context.socket?.id || null) : null,
        pc: this.pc || null,
      };
    } catch (_) { /* Raw evidence cannot affect ACK validation. */ }
    // Finish C's validation first. Timing never grants or repairs authority.
    const source = context.socket || context.dataChannel ? context : undefined;
    let metadata = null;
    try { metadata = typeof Input !== 'undefined' ? Input.peekInputAckMetadata?.(data, source) : null; } catch (_) {}
    const results = [];
    try {
      if (typeof Input !== 'undefined') {
        if (typeof Input.acceptMouseAck === 'function') results.push(Input.acceptMouseAck(data, source, { deferTrace: true }));
        if ((data?.inputType === 'keyboard' || data?.schemaVersion !== 2)
          && typeof Input.acceptKeyboardAck === 'function') results.push(Input.acceptKeyboardAck(data, source, { deferTrace: true }));
      }
      if (data?.schemaVersion === 2) {
        const positive = data.status === 'applied' || data.status === 'duplicate';
        const validated = results.some(result => result && (positive
          ? result.status === 'applied' || result.status === 'duplicate'
          : result.status !== 'stale'));
        if (!validated) {
          // Moves deliberately bypass C's reliable sequence ledger. The observer
          // may settle only its own accepted unordered submission, with the exact
          // current scope, lease, ID and actual receiving transport.
          if (typeof LatencyMonitor !== 'undefined') LatencyMonitor.onUnorderedInputAck?.(data, {
            scope: this.latencyScope(), transport: context.transport,
          });
          try {
            if (controlledArrival && typeof LatencyMonitor !== 'undefined') {
              LatencyMonitor.observeControlledAck?.(data, { ...controlledArrival,
                scope: this.latencyScope(),
                leaseId: typeof Input !== 'undefined' ? Input.activeControlLease?.leaseId : null,
                pc: this.pc || null,
                live: this.captureControlledTransportSnapshot(), verdict: 'unordered-applied' });
            }
          } catch (_) { /* Observation cannot change M1 or the early return. */ }
          return;
        }
      }
      if (typeof LatencyMonitor !== 'undefined') {
        this.syncLatencyScope();
        LatencyMonitor.onInputAck(data, { scope: this.latencyScope() });
      }
      try {
        if (controlledArrival && results.some(result => result?.status === 'applied')
            && typeof LatencyMonitor !== 'undefined') {
          LatencyMonitor.observeControlledAck?.(data, { ...controlledArrival,
            scope: this.latencyScope(),
            leaseId: typeof Input !== 'undefined' ? Input.activeControlLease?.leaseId : null,
            pc: this.pc || null,
            live: this.captureControlledTransportSnapshot(), verdict: 'reliable-applied' });
        }
      } catch (_) { /* Observation cannot change C/M1 or final tracing. */ }
    } finally {
      // Passive tracing is last, including the unordered/stale early return.
      // Observer failures cannot alter the ACK result or M1 routing.
      try {
        if (typeof Input !== 'undefined') {
          const result = results.find(item => item && item.status !== 'stale') || results[0];
          Input.recordObservedInputAck?.(data, result, metadata);
        }
      } catch (_) {}
    }
  },

  beginConnectionAttempt(trigger = 'viewer-open') {
    if (!this.startupAllowed()) return;
    if (this.startupPending()) this._startupEpisode.paint = null;
    this.cancelDataChannelWatchdog();
    this.clearRefreshDcWaitTimer();
    this.clearMediaResumeProof();
    this.connectionAttemptSequence = (Number(this.connectionAttemptSequence) || 0) + 1;
    this.currentConnectionAttemptId = this.createConnectionAttemptId();
    this.syncLatencyScope();
    this.ensureFrameTraceCollector(this.currentFrameTraceIdentity());
    this._recordInputTrace('lifecycle', {
      inputType: 'control', action: 'active', state: 'active',
      reason: 'attempt-changed', source: 'lifecycle', generation: this.connectionAttemptSequence,
    });
    if (typeof Input !== 'undefined' && typeof Input.onConnectionAttemptChanged === 'function') {
      Input.onConnectionAttemptChanged(this.currentConnectionAttemptId);
    }
    this._mediaProfileSequence = 0;
    this.ensureDesktopSessionState()?.beginAttempt(this.currentConnectionAttemptId, {
      socket: this.socket?.connected ? 'online' : 'connecting',
    });
    this._mediaReadyConnectionAttemptId = null;
    this.clearRelayOrigin();
    if (this._mediaIntent && this.mediaActivityRuntime) {
      this.mediaActivityRuntime.beginDesired(this._mediaIntent.state, {
        generation: this._mediaIntent.generation, connectionAttemptId: this.currentConnectionAttemptId,
      });
    }
    this._mediaFailureHandledKey = null;
    this._mediaRequestRetryUsed = false;
    this._mediaResumeSoftRecoverUsed = false;
    this._mediaResumeArmPending = false;
    this.clearMediaResumeFallback();
    this.hasPaintedFrame = false;
    this._lastInboundFramesDecoded = 0;
    this._lastInboundFramesDecodedAt = null;
    this._paintDecodedBaseline = 0;
    this._paintObservationWindow = null;
    this._lastPaintObservation = null;
    this._stallSince = null;
    this._keyframeRequestGeneration = '';
    this._keyframeRequestSequence = 0;
    this._lastKeyframeRequestAt = null;
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
    if (this.startupPending()) this.retireStartupEpisode('relay-unavailable', { cleanup: true });
    this.markRefreshSettled('unavailable-relay');
    this.offerInProgress = false;
    this._offerEpoch += 1;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.cancelDataChannelWatchdog();
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
      this.cancelDataChannelWatchdog();
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
      renderViewerChromeClass(el, 'hidden', true);
      renderViewerChromeClass(el, 'is-connecting', false);
    }
    renderViewerChromeClass(document.body, 'stream-connected', true);
    const videoEl = document.getElementById('remoteVideo');
    renderViewerChromeClass(videoEl, 'connected', true);
    this.hideReconnectHud();
  },

  setUiPhase(phase, { reason, attemptId } = {}) {
    if (['retired', 'failed'].includes(this._startupEpisode?.state) && phase !== 'disconnected') return this.uiPhase;
    if (phase === 'connected' && this.hasPaintedFrame !== true) {
      phase = 'media-pending';
    }
    const allowed = ['signaling', 'media-pending', 'connected', 'media-stalled', 'disconnected'];
    if (!allowed.includes(phase)) return this.uiPhase;
    if (attemptId && this.currentConnectionAttemptId && attemptId !== this.currentConnectionAttemptId) {
      return this.uiPhase;
    }
    if (this.uiPhase === 'disconnected' && phase !== 'signaling' && phase !== 'disconnected') {
      return this.uiPhase;
    }
    const previous = this.uiPhase;
    this.uiPhase = phase;
    const session = this.ensureDesktopSessionState();
    if (session) {
      if (phase === 'media-pending') session.applyMedia({ attemptId: this.currentConnectionAttemptId, state: 'pending' });
      else if (phase === 'media-stalled') session.applyMedia({ attemptId: this.currentConnectionAttemptId, state: 'stalled' });
      else if (phase === 'connected') {
        if (this.hasPaintedFrame === true) {
          session.applyMedia({
            attemptId: this.currentConnectionAttemptId,
            event: 'fresh-frame',
            fresh: true,
          });
        } else {
          session.applyMedia({
            attemptId: this.currentConnectionAttemptId,
            state: 'pending',
          });
        }
      }
      else if (phase === 'disconnected') session.applyConnection({ attemptId: this.currentConnectionAttemptId, state: 'disconnected', socket: 'offline' });
      else if (phase === 'signaling') session.applyConnection({ attemptId: this.currentConnectionAttemptId, state: 'signaling' });
    }
    const sessionPhase = session ? this.getDesktopSessionSnapshot().phase : phase;
    this.syncChromeCapabilities();
    const terminalPaused = this.getMediaActivitySnapshot()?.reasons?.includes?.('terminal-active');
    if (terminalPaused && sessionPhase !== 'signaling' && sessionPhase !== 'disconnected') {
      updateConnectionStatus('media-paused-terminal');
    } else if (sessionPhase === 'signaling') {
      updateConnectionStatus('connecting');
    } else {
      updateConnectionStatus(sessionPhase || phase);
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

  getChromeSnapshot() {
    const mediaActivity = this.getMediaActivitySnapshot();
    const terminalActive = Array.isArray(mediaActivity?.reasons)
      && mediaActivity.reasons.includes('terminal-active');
    const terminalAuthorized = typeof TerminalPanel !== 'undefined'
      && typeof TerminalPanel.hasAdminToken === 'function'
      && TerminalPanel.hasAdminToken();
    const modalOpen = typeof document !== 'undefined'
      && Boolean(document.querySelector?.('.modal:not(.hidden)'));
    const transition = this.controlState?.state === 'GRANTING'
      || this.controlState?.state === 'REVOKING'
      || this.isControlResetBlocked?.();
    const streamReady = Boolean(
      this.hasPaintedFrame
      || (this.currentConnectionAttemptId && this._mediaReadyConnectionAttemptId === this.currentConnectionAttemptId),
    );
    const transportReady = this.inputChannel?.readyState === 'open'
      || this.socket?.connected === true;
    const mobileInputSnapshot = typeof Input !== 'undefined'
      ? Input.mobileTextInputAdapter?.getSnapshot?.() : null;
    const mobileInputStatus = String(mobileInputSnapshot?.status || '').toLowerCase();
    const mobileInputBlocked = mobileInputStatus === 'blocked'
      || mobileInputStatus === 'uncertain'
      || mobileInputSnapshot?.deliveryUncertain === true;
    const mobileInputMode = mobileInputBlocked
      ? 'blocked'
      : mobileInputSnapshot?.shown
        ? 'visible'
        : (streamReady && this.hasActiveControl() && transportReady ? 'armed' : 'off');
    return {
      uiPhase: this.uiPhase,
      authVerified: typeof Auth !== 'undefined' && Auth.isVerified?.() === true,
      streamReady,
      activeControl: this.hasActiveControl(),
      controlTransition: Boolean(transition),
      terminalAuthorized,
      modalOpen,
      transportReady,
      mobileInputMode,
      // Shared writers use the same final mobile/port capability projection.
      mobileTextInputSupported: typeof Input !== 'undefined' && typeof Input.supportsMobileTextInput === 'function'
        ? Input.supportsMobileTextInput() : true,
      mobileTextInputActive: typeof Input === 'undefined' || Input.isActive !== false,
      portSearchDisabled: (this._operatorToolsState || 'loading') === 'loading'
        || (this._operatorToolsState !== 'failed'
          && !this.isPortSearchActive() && !this.canStartPortSearch()),
      terminalActive,
      mediaActivityReasons: Array.isArray(mediaActivity?.reasons)
        ? mediaActivity.reasons.slice(0, 8) : [],
      mediaPausedReason: terminalActive ? 'terminal-active' : null,
    };
  },

  syncChromeCapabilities() {
    if (typeof ChromeLayout === 'undefined' || typeof ChromeLayout.applyCapabilities !== 'function') return null;
    return ChromeLayout.applyCapabilities(this.getChromeSnapshot());
  },

  bindFullscreenLifecycle() {
    if (this._fullscreenLifecycleBound || typeof document === 'undefined') return this.unbindFullscreenLifecycle.bind(this);
    this._fullscreenLifecycleBound = true;
    this._fullscreenLifecycleHandler = () => {
      if (typeof ChromeLayout !== 'undefined' && typeof ChromeLayout.recalculate === 'function') {
        ChromeLayout.recalculate();
      }
      if (typeof Input !== 'undefined' && typeof Input.refreshGeometry === 'function') {
        Input.refreshGeometry();
      }
      this.syncChromeCapabilities();
    };
    document.addEventListener('fullscreenchange', this._fullscreenLifecycleHandler);
    return this.unbindFullscreenLifecycle.bind(this);
  },

  unbindFullscreenLifecycle() {
    if (this._fullscreenLifecycleHandler && typeof document !== 'undefined') {
      document.removeEventListener?.('fullscreenchange', this._fullscreenLifecycleHandler);
    }
    this._fullscreenLifecycleHandler = null;
    this._fullscreenLifecycleBound = false;
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
    const owner = this.captureStartupOwner();
    if (this.getMediaActivitySnapshot().state === 'suspended' || document.hidden) return;
    if (!this._paintPending3sTimer) {
      this._paintPending3sTimer = setTimeout(() => {
        if (!this.ownsStartupOwner(owner)) return;
        this._paintPending3sTimer = null;
        if (this.uiPhase !== 'media-pending'
            || this.getMediaActivitySnapshot().state === 'suspended' || document.hidden) return;
        this.announcePaintIssue('media-pending-3s');
      }, 3000);
    }
    if (!this._paintPending8sTimer) {
      this._paintPending8sTimer = setTimeout(() => {
        if (!this.ownsStartupOwner(owner)) return;
        this._paintPending8sTimer = null;
        if (this.uiPhase !== 'media-pending'
            || this.getMediaActivitySnapshot().state === 'suspended' || document.hidden) return;
        this.announcePaintIssue('media-pending-8s');
        if (!this.startupPending()) this.autoSendPaintFailure('paint-pending-timeout');
      }, 8000);
    }
  },

  schedulePaintStalledCopyTimer() {
    const owner = this.captureStartupOwner();
    if (this.networkMode !== 'relay' || this._paintStalled6sTimer) return;
    this._paintStalled6sTimer = setTimeout(() => {
      if (!this.ownsStartupOwner(owner)) return;
      this._paintStalled6sTimer = null;
      if (this.uiPhase !== 'media-stalled') return;
      this.announcePaintIssue('media-stalled-6s');
    }, 6000);
  },

  schedulePaintStalledAutoSend() {
    const owner = this.captureStartupOwner();
    if (this._paintStalled3sTimer) return;
    this._paintStalled3sTimer = setTimeout(() => {
      if (!this.ownsStartupOwner(owner)) return;
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

  paintStallThresholdMs() {
    const isRelay = this.networkMode === 'relay' || this.lastCandidateType === 'relay';
    return isRelay ? 2000 : 1000;
  },

  notePaintStats(stats = {}) {
    if (!this.startupAllowed()) return;
    const canonical = this.canonicalMediaStats(stats);
    const videoWidth = Number(stats.videoWidth || 0);
    const decodedDelta = canonical.decodedDelta;
    const receivedDelta = canonical.receivedDelta;
    const derivedFps = canonical.derivedFps;
    this._lastPaintStats = {
      videoWidth,
      videoHeight: Number(stats.videoHeight || 0),
      decodedDelta,
      receivedDelta,
      derivedFps,
      warmup: canonical.warmup,
      jitterBufferMs: canonical.jitterBufferMs,
      bytesDelta: canonical.bytesDelta,
      framesDroppedDelta: canonical.framesDroppedDelta,
      packetsReceivedDelta: canonical.packetsReceivedDelta,
      nackCountDelta: canonical.nackCountDelta,
      pliCountDelta: canonical.pliCountDelta,
      firCountDelta: canonical.firCountDelta,
      freezeDelta: canonical.freezeDelta,
    };

    // Intentional suspension and warmup are not media-health samples. Clear any
    // prior stall and leave the paint state untouched while delayed stats arrive.
    if (canonical.warmup || this.isMediaHealthSuppressed()) {
      this._stallSince = null;
      return this.uiPhase;
    }

    if (!this.hasPaintedFrame) {
      if (videoWidth > 0 && decodedDelta > 0) {
        this.hasPaintedFrame = true;
        this.ensureDesktopSessionState()?.applyMedia({
          attemptId: this.currentConnectionAttemptId,
          event: 'fresh-frame',
          fresh: true,
        });
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

    if (derivedFps === 0 && receivedDelta > 0) {
      this.ensureDesktopSessionState()?.applyMedia({ attemptId: this.currentConnectionAttemptId, state: 'stalled' });
      if (!this._stallSince) this._stallSince = Date.now();
      const stallMs = this.paintStallThresholdMs();
      if (Date.now() - this._stallSince >= stallMs) {
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
    if (this.isMediaHealthSuppressed()) return false;
    const now = performance.now();
    const generation = `${this.currentConnectionAttemptId || ''}|${Number(this.connectionAttemptSequence) || 0}`;
    if (this._keyframeRequestGeneration !== generation) {
      this._keyframeRequestGeneration = generation;
      this._lastKeyframeRequestAt = null;
    }
    if (Number.isFinite(this._lastKeyframeRequestAt) && now - this._lastKeyframeRequestAt < 1000) {
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
      connectionAttemptId: this.currentConnectionAttemptId || '',
      connectionAttemptSequence: Number(this.connectionAttemptSequence) || 0,
      generation: Number(this.connectionAttemptSequence) || 0,
      requestSequence: (Number(this._keyframeRequestSequence) || 0) + 1,
    });
    this._keyframeRequestSequence += 1;
    console.warn(`[MEDIA] request-keyframe reason=${reason}`);
    return true;
  },

  handleReceiverStats(stats) {
    if (this.isMediaHealthSuppressed()) return;
    const canonical = this.canonicalMediaStats(stats);
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
      ...canonical,
      selectedCandidatePair: this.selectedCandidatePair,
    });
    if (!result) return;

    const feedbackRequested = canonical.pliCountDelta > 0 || canonical.firCountDelta > 0;
    const applicationReason = (result.shouldRequestKeyframe || result.action === 'recover')
      ? result.reason || 'media-stalled'
      : '';
    if (applicationReason || feedbackRequested) {
      // Browser PLI/FIR counters have no stable causal attribution in aiortc;
      // retain an application reason when one is pending, otherwise record unknown.
      this.requestKeyframe(applicationReason || 'rtcp-or-unknown');
    }

    if (result.action === 'hold') return;

    if (result.profileConfig) {
      this.applyMediaProfile(result.profileConfig, result.reason);
    }

    if (result.shouldRestartIce) {
      this.proactiveIceRestart(result.reason);
    }
  },

  configureVideoReceiver(receiver, options = {}) {
    if (!receiver?.track || receiver.track.kind !== 'video') return;
    const isRelay = this.networkMode === 'relay'
      || this.lastCandidateType === 'relay';

    // Relay IDRs are ~8-20KB. Toggling 160ms↔0ms on freeze/recover made Chrome
    // rebuild a ~367ms buffer and drop ~50 assembled frames. Pin 0ms.
    const delayHint = 0;
    const jitterTarget = isRelay ? 0 : 1;
    if (typeof receiver.playoutDelayHint !== 'undefined') {
      try {
        receiver.playoutDelayHint = delayHint;
      } catch (error) {
        console.warn('[LATENCY] Unable to set playoutDelayHint:', error?.message || error);
      }
    }

    if (typeof receiver.jitterBufferTarget !== 'undefined') {
      try {
        receiver.jitterBufferTarget = jitterTarget;
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
      this._mediaProfileSequence = (Number(this._mediaProfileSequence) || 0) + 1;
      this.socket.emit('media-profile-change', {
        ...lease,
        connectionAttemptId: this.currentConnectionAttemptId,
        profileSequence: this._mediaProfileSequence,
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
  
  // Initial media supervision belongs to an explicit Start, not to individual
  // retries. Completed episodes deliberately leave established recovery alone.
  beginStartupEpisode(controller = null) {
    if (this._startupEpisode) {
      this.retireStartupEpisode('replaced', { cleanup: true });
      // Retired supersession may retain an inert config promise for reclaim. A
      // new Start cancels that dependency before asking the controller to load.
      this._startupEpisode.controller?.cancel?.();
      this._pendingBootstrapConfig = null;
    }
    const episode = { state: 'pending', controller, started: false, remaining: 72000,
      feedbackRemaining: 8000, paint: null, timer: null, lastNow: null, paused: false };
    this._startupEpisode = episode;
    this.manualDisconnect = false;
    if (!this._startupVisibilityBound) {
      this._startupVisibilityBound = true;
      document.addEventListener('visibilitychange', () => this.checkStartupEpisode());
    }
    this.renderStartupControls(false);
    return episode;
  },

  startupPending() {
    return this.networkMode !== 'tunnel' && ['pending', 'slow'].includes(this._startupEpisode?.state);
  },

  startupAllowed(episode = this._startupEpisode || null) {
    if (episode !== (this._startupEpisode || null)) return false;
    if (!episode) return true;
    if (this.startupPending()) this.checkStartupEpisode();
    return episode.state === 'pending' || episode.state === 'slow' || episode.state === 'complete';
  },

  captureStartupOwner() {
    return { episode: this._startupEpisode || null, peer: this.pc, socket: this.socket,
      attempt: this.currentConnectionAttemptId, sequence: this.connectionAttemptSequence };
  },

  ownsStartupOwner(owner) {
    // Reject stale owners before checking time: even rearming the current timer
    // is a mutation that an older producer must not perform.
    return !owner.retired && owner.peer === this.pc
      && (!this.startupPending() || owner.socket === this.socket) && owner.attempt === this.currentConnectionAttemptId
      && owner.sequence === this.connectionAttemptSequence && this.startupAllowed(owner.episode);
  },

  checkStartupEpisode({ connected = false, painted = false, suspended = null } = {}) {
    const e = this._startupEpisode;
    if (!this.startupPending() || !e.started) return;
    const now = this.signalingMonotonicNow();
    const paused = Boolean(document.hidden || (suspended == null
      ? this._mediaIntent?.state === 'suspended' || this.getMediaActivitySnapshot()?.state === 'suspended'
      : suspended));
    // Invalid time is conservative: it cannot create another active allowance.
    const elapsed = now === null || e.lastNow === null || now < e.lastNow
      ? 72000 : now - e.lastNow;
    if (!e.paused) {
      e.remaining = Math.max(0, e.remaining - elapsed);
      e.feedbackRemaining = Math.max(0, e.feedbackRemaining - elapsed);
      if (e.paint) e.paint.remaining = Math.max(0, e.paint.remaining - elapsed);
    }
    e.lastNow = now;
    e.paused = paused;
    if (e.timer != null) clearTimeout(e.timer);
    e.timer = null;
    const expired = e.remaining <= 0 || e.paint?.remaining <= 0;
    if (!paused && expired) {
      this.retireStartupEpisode(e.paint ? 'startup-paint-timeout' : 'startup-media-timeout', { cleanup: true, failure: true });
      return;
    }
    if (connected && this.pc && e.paint?.peer !== this.pc) {
      e.paint = { peer: this.pc, remaining: 12000 };
    }
    if (!expired && painted && this.uiPhase !== 'disconnected' && this.hasPaintedFrame && this.isCurrentAttemptMediaReady()) {
      e.state = 'complete';
      this.renderStartupControls(false);
      return;
    }
    if (paused) return;
    if (e.feedbackRemaining <= 0 && e.state === 'pending') {
      e.state = 'slow';
      this.showSlowStartup();
    }
    const delay = Math.min(e.remaining, e.paint?.remaining ?? Infinity,
      e.state === 'pending' ? e.feedbackRemaining : Infinity);
    e.timer = setTimeout(() => {
      if (this._startupEpisode === e) this.checkStartupEpisode();
    }, delay);
    e.timer?.unref?.();
  },

  startStartupMediaBudget() {
    const e = this._startupEpisode;
    if (!this.startupPending() || e.started || this.networkMode === 'tunnel') return;
    e.started = true;
    e.lastNow = this.signalingMonotonicNow();
    e.paused = Boolean(document.hidden || this._mediaIntent?.state === 'suspended'
      || this.getMediaActivitySnapshot()?.state === 'suspended');
    this.checkStartupEpisode();
  },

  retireStartupMediaOwner() {
    const e = this._startupEpisode;
    if (e) e.paint = null;
    for (const key of ['reconnectTimer', '_disconnectedTimer', '_iceDisconnectedTimer', '_stableResetTimer']) {
      if (this[key] != null) clearTimeout(this[key]);
      this[key] = null;
    }
    this.clearRefreshDcWaitTimer();
    this.cancelDataChannelWatchdog();
    this.clearPaintIssueTimers();
    this.clearMediaResumeProof();
    this.stopMediaTelemetry();
    this.stopVideoFrameTracking();
    this.stopDcKeepalive();
    this._offerEpoch += 1;
    this.offerInProgress = false;
    const peer = this.pc;
    this.pc = null;
    this.inputChannel = null;
    this.inputMoveChannel = null;
    this.hasPaintedFrame = false;
    this._mediaReadyConnectionAttemptId = null;
    if (peer) {
      for (const event of ['oniceconnectionstatechange', 'onconnectionstatechange',
        'onsignalingstatechange', 'onicegatheringstatechange', 'onicecandidate', 'ontrack']) peer[event] = null;
      peer.close?.();
    }
    const video = document.getElementById('remoteVideo');
    if (video) { video.onloadedmetadata = null; video.onplaying = null; video.srcObject = null; }
    this.syncDesktopInputGate();
  },

  retireStartupEpisode(reason, { cleanup = false, failure = false, retainReclaimConfig = false } = {}) {
    const e = this._startupEpisode;
    if (!e || ['retired', 'failed'].includes(e.state)) return;
    // Retire before closing producers: close/disconnect may synchronously call back.
    e.state = failure ? 'failed' : 'retired';
    e.reason = reason;
    if (e.timer != null) clearTimeout(e.timer);
    e.timer = null;
    if (!retainReclaimConfig) {
      e.controller?.cancel?.();
      this._pendingBootstrapConfig = null;
    }
    this._deferPeerUntilConfig = false;
    this.renderStartupControls(false);
    if (!cleanup) return;
    this.clearFirstFrameDeadline();
    this.clearSignalingRecovery();
    this.markRefreshSettled(reason);
    for (const key of ['reconnectTimer', '_disconnectedTimer', '_iceDisconnectedTimer', '_dcReconnectTimer', '_stableResetTimer']) {
      if (this[key] != null) clearTimeout(this[key]);
      this[key] = null;
    }
    this._cancelControlAcquireIntent();
    this.freezeControl(reason);
    this.retireStartupMediaOwner();
    const socket = this.socket;
    this.socket = null;
    socket?.disconnect?.();
    this.setUiPhase('disconnected', { reason });
    document.getElementById('loading')?.classList.remove('is-connecting');
    const start = document.getElementById('startBtn');
    if (start) start.style.display = '';
    if (reason === 'startup-cancelled') updateLoadingText('连接已取消，可以重新开始');
    if (failure) {
      updateLoadingText(reason === 'startup-paint-timeout'
        ? '媒体链路已连接，但等待画面超时，请重试' : '等待媒体连接超时，请重试');
      this.renderStartupControls(true, false);
    }
  },

  showSlowStartup() {
    document.getElementById('loading')?.classList.remove('is-connecting');
    updateLoadingText('连接较慢，仍在等待画面；可以重试或取消');
    this.renderStartupControls(true);
  },

  renderStartupControls(show, cancel = true) {
    let controls = document.getElementById('startupWaitControls');
    if (!controls && show && document.createElement) {
      controls = document.createElement('div');
      controls.id = 'startupWaitControls';
      const retry = document.createElement('button');
      retry.type = 'button'; retry.className = 'start-btn'; retry.textContent = '重试连接';
      retry.addEventListener('click', () => this.startViewer(this._startupEpisode?.controller));
      const stop = document.createElement('button');
      stop.type = 'button'; stop.className = 'start-btn'; stop.textContent = '取消连接'; stop.dataset.startupCancel = 'true';
      stop.addEventListener('click', () => this.retireStartupEpisode('startup-cancelled', { cleanup: true }));
      controls.append(retry, stop);
      document.getElementById('loading')?.append(controls);
    }
    if (controls) {
      controls.hidden = !show;
      const stop = controls.querySelector?.('[data-startup-cancel]');
      if (stop) stop.hidden = !cancel;
    }
  },

  async init({ bootstrapSnapshot = null, trigger = 'viewer-open', reuseSocket = false, episode = this._startupEpisode || null } = {}) {
    if (!this.startupAllowed(episode)) return false;
    this.startStartupMediaBudget();
    const token = Auth.getToken();
    const authGeneration = Auth.getGeneration?.();
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
    if (this._superseded || !this.startupAllowed(episode)) return false;
    if (Auth.getToken() !== token || Auth.getGeneration?.() !== authGeneration) {
      this.retireStartupEpisode('auth-changed', { cleanup: true });
      return false;
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
    if (this.networkMode !== 'tunnel') {
      this.createPeerConnection();
      this.reconcileConfiguredControlMedia();
    }
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
    if (this.startupPending() && this.networkMode !== 'tunnel') {
      this.clearFirstFrameDeadline();
      this.startStartupMediaBudget();
      return;
    }
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
    if (this.startupPending() && this.networkMode !== 'tunnel') {
      this.retireStartupEpisode(reason, { cleanup: true, failure: true });
      return;
    }
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
    this.retireStartupEpisode('bootstrap-failure', { cleanup: true });
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
    const startRequest = this._startRequest = (this._startRequest || 0) + 1;
    // Token presence is not verification. Await the initial check only; retry is explicit.
    const verified = typeof Auth !== 'undefined' && (typeof Auth.whenReady === 'function'
      ? await Auth.whenReady() : Auth.isVerified?.() === true);
    if (startRequest !== this._startRequest) return false;
    if (!verified || Auth.isVerified?.() !== true) {
      if (typeof Auth !== 'undefined' && !Auth.getToken()) return Auth.logout();
      if (typeof Auth !== 'undefined') Auth.showRetry?.(true);
      updateLoadingText('登录验证暂不可用，请重试验证');
      this.syncChromeCapabilities();
      return false;
    }
    const episode = this.beginStartupEpisode(controller);
    this.resetSignalingSession();
    this._controlUserReleased = false;
    this._cancelControlAcquireIntent();
    const authToken = Auth.getToken();
    const authGeneration = Auth.getGeneration?.();
    const startBtn = document.getElementById('startBtn');
    if (startBtn) startBtn.style.display = 'none';
    document.getElementById('loading')?.classList.add('is-connecting');
    updateLoadingText('正在连接...');
    if (typeof StartupTelemetry !== 'undefined' && StartupTelemetry?.mark) {
      StartupTelemetry.mark('start-click');
      StartupTelemetry.mark('bootstrap-start');
    }
    try {
      await this.requestExplicitViewerAdmission(episode);
      if (!this.startupAllowed(episode)) return false;
      if (Auth.isVerified?.() !== true || Auth.getToken() !== authToken
          || Auth.getGeneration?.() !== authGeneration) {
        this.retireStartupEpisode('auth-changed', { cleanup: true });
        return false;
      }
      this._superseded = false;
      this.hideSupersededUI();
      if (!controller) {
        await this.init({ trigger: 'start-button', episode });
        return;
      }
      // Open signaling immediately; ICE/config can arrive in parallel via bootstrap.
      // Defer PeerConnection until applyBootstrapSnapshot so we do not gather with empty ICE.
      this.manualDisconnect = false;
      this._deferPeerUntilConfig = true;
      this.createSignalingSocket(true);
      const pendingBootstrap = controller.load({
        mode: this.networkMode,
        turnServerId: this.selectedTurnServerId,
      }).then((snapshot) => {
        const reclaimOnly = this._startupEpisode === episode
          && episode.state === 'retired' && episode.reason === 'viewer-superseded';
        if ((!this.startupAllowed(episode) && !reclaimOnly) || Auth.isVerified?.() !== true || Auth.getToken() !== authToken
            || Auth.getGeneration?.() !== authGeneration
            || this._pendingBootstrapConfig !== pendingBootstrap) {
          throw Object.assign(new Error('superseded'), { code: 'superseded' });
        }
        // A superseded Start can only return inert config to a future explicit
        // reclaim; it cannot publish config/UI or revive its media producer.
        if (reclaimOnly) episode.reclaimConfig = { snapshot, authToken, authGeneration };
        return snapshot;
      });
      this._pendingBootstrapConfig = pendingBootstrap;
      let bootstrapSnapshot;
      try { bootstrapSnapshot = await pendingBootstrap; }
      finally {
        if (this._pendingBootstrapConfig === pendingBootstrap) {
          this._pendingBootstrapConfig = null;
          this._deferPeerUntilConfig = false;
        }
      }
      // The promise settles before this continuation; authentication may have
      // changed in another queued microtask after configuration validation.
      if (!this.startupAllowed(episode) || Auth.isVerified?.() !== true || Auth.getToken() !== authToken
          || Auth.getGeneration?.() !== authGeneration) {
        throw Object.assign(new Error('superseded'), { code: 'superseded' });
      }
      if (typeof StartupTelemetry !== 'undefined' && StartupTelemetry?.mark) {
        if (bootstrapSnapshot?.degraded) {
          StartupTelemetry.mark('bootstrap-degraded');
        } else {
          StartupTelemetry.mark('bootstrap-ready');
        }
      }
      if (this._superseded) return false;
      await this.init({ bootstrapSnapshot, trigger: 'start-button', reuseSocket: true, episode });
    } catch (error) {
      if (!this.startupAllowed(episode)) return false;
      if (!this._pendingBootstrapConfig) this._deferPeerUntilConfig = false;
      if (error?.code === 'auth-invalid' && Auth.getToken() === authToken
          && Auth.getGeneration?.() === authGeneration
          && controller?.getSnapshot?.().state === 'auth-required') {
        return Auth.logout();
      }
      if (error?.code !== 'superseded') this.enterBootstrapFailure(error);
      else if (Auth.isVerified?.() !== true || Auth.getToken() !== authToken
          || Auth.getGeneration?.() !== authGeneration) {
        this.retireStartupEpisode('auth-changed', { cleanup: true });
      }
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

  quiesceDisconnectedSocket() {
    const socket = this.socket;
    if (!socket || socket.connected) return false;
    // Retire this socket's watchdog without discarding the elapsed outage budget.
    if (this._signalRecoveryTimer != null) {
      clearTimeout(this._signalRecoveryTimer);
      this._signalRecoveryTimer = null;
    }
    // Invalidate the old listener closures before disconnecting. Socket.IO may
    // already have a reconnect callback queued; those callbacks must not
    // create a PeerConnection while init() is waiting for fresh config.
    this.socket = null;
    try {
      socket.disconnect?.();
    } catch (error) {
      console.warn('[NETWORK] Failed to quiesce disconnected signaling socket:', error);
    }
    return true;
  },

  createSignalingSocket(forceRecreate = false) {
    if (!this.startupAllowed()) return null;
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
    this.ensureSignalingSession();
    const socketOptions = this.buildSignalingSocketOptions({
      token,
      reconnection: !this._superseded,
    });
    this.socket = io(socketBase, socketOptions);
    this.setupSocketListeners();
    return this.socket;
  },

  readProofAdmission() {
    try {
      if (typeof sessionStorage === 'undefined') return null;
      const raw = sessionStorage.getItem('wrdProofAdmission');
      if (raw == null) return null;
      try { return JSON.parse(raw) || { invalid: true }; }
      catch (_error) { return { invalid: true }; }
    } catch (_error) { return null; }
  },

  readInitialAdmissionPolicy() {
    try {
      const values = new URLSearchParams(window.location.search).getAll('wrdAdmission');
      if (values.length === 0) return null;
      if (values.length === 1 && values[0] === 'vacant-only-v1') return values[0];
    } catch (_error) { /* Unreadable location is not ordinary admission. */ }
    throw Object.assign(new Error('桌面连接授权暂不可用，请手动重试'), { code: 'invalid-initial-policy' });
  },

  async requestExplicitViewerAdmission(episode = this._startupEpisode || null) {
    const initialPolicy = this.readInitialAdmissionPolicy();
    // A proof-bearing page must never upgrade itself to ordinary human takeover.
    if (this.readProofAdmission()) {
      if (initialPolicy) {
        throw Object.assign(new Error('桌面连接授权暂不可用，请手动重试'), { code: 'invalid-initial-policy' });
      }
      this._viewerAdmission = null;
      return;
    }
    const token = Auth.getToken();
    const authGeneration = Auth.getGeneration?.();
    if (!token || Auth.isVerified?.() !== true) throw new Error('请重新验证登录');
    const sequence = ++this._explicitAdmissionSequence;
    const base = typeof RuntimeConfig !== 'undefined' ? RuntimeConfig.getApiBase() : window.location.origin;
    const result = await fetchJsonWithin(`${base}/api/auth/viewer-admission`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewerSessionId: this.resolveViewerSessionId(), ...(initialPolicy ? { initialPolicy } : {}) }),
    }, { timeoutMs: 5000 });
    if (!this.startupAllowed(episode) || sequence !== this._explicitAdmissionSequence || Auth.getToken() !== token
        || Auth.getGeneration?.() !== authGeneration || Auth.isVerified?.() !== true
        || this.readInitialAdmissionPolicy() !== initialPolicy || this.readProofAdmission()) {
      throw Object.assign(new Error('superseded'), { code: 'superseded' });
    }
    if (!result.ok || typeof result.data?.admission?.ticket !== 'string') {
      throw new Error('桌面连接授权暂不可用，请手动重试');
    }
    this._viewerAdmission = { mode: 'explicit', ticket: result.data.admission.ticket };
  },

  signalingConnectBudgetMs: 5000,

  // This identity follows explicit user connections, independently of media attempts.
  resetSignalingSession() {
    this._signalingSession = { preferPolling: false, failure: null, capturedAtMs: null };
    return this._signalingSession;
  },

  ensureSignalingSession() {
    return this._signalingSession || this.resetSignalingSession();
  },

  signalingMonotonicNow() {
    try {
      const now = performance.now();
      return typeof now === 'number' && Number.isFinite(now) && now >= 0 ? now : null;
    } catch (_) { return null; }
  },

  getSignalingFailureSnapshot() {
    const session = this._signalingSession;
    if (!session?.failure) return null;
    const now = this.signalingMonotonicNow();
    const elapsed = now !== null && session.capturedAtMs !== null ? now - session.capturedAtMs : null;
    return Object.freeze({ ...session.failure,
      ageMs: typeof elapsed === 'number' && Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= 3600000 ? elapsed : null });
  },

  recordSignalingFailure(error, socket, manager, session) {
    if (this.socket !== socket || this._signalingSession !== session) return null;
    const read = getter => { try { return getter(); } catch (_) { return undefined; } };
    if (read(() => socket.io) !== manager) return null;
    const message = read(() => error?.message);
    const failureClass = message === 'timeout' ? 'timeout' : read(() => error?.type) === 'TransportError' ? 'transport-error'
      : message === 'Authentication required' ? 'auth-required' : message === 'Invalid token' ? 'auth-invalid' : 'unknown';
    const engine = read(() => manager.engine);
    const transport = read(() => engine.transport.name);
    const engineState = read(() => engine.readyState);
    const socketConnected = read(() => socket.connected);
    const socketActive = read(() => socket.active);
    let fallbackSelected = false;
    // Manager timeout emits after Manager closes, before its opening Engine closes.
    // Read only known options; an exception/unknown eligibility must leave policy alone.
    try {
      const options = manager.opts;
      const transports = options.transports;
      const names = Array.isArray(transports) ? transports.map(item => typeof item === 'string' ? item : item.prototype.name) : [];
      if (failureClass === 'timeout' && transport === 'websocket' && engineState === 'opening'
        && socketConnected === false && socketActive === true && names.includes('polling')
        && names.every(name => name === 'polling' || name === 'websocket')) {
        const nextTransports = ['polling', 'websocket'];
        options.transports = nextTransports;
        if (options.transports === nextTransports) {
          session.preferPolling = true;
          fallbackSelected = true;
        }
      }
    } catch (_) {}
    const summary = { scope: 'last-connect-error', failureClass, transport, engineState,
      managerState: read(() => manager._readyState), socketConnected, socketActive, fallbackSelected,
      connectBudgetMs: read(() => manager.opts.timeout), ageMs: 0 };
    // Shared whitelist is also used by runtime/core/full/storage/server boundaries.
    if (typeof sanitizeSignalingFailure !== 'function') return null;
    session.failure = Object.freeze(sanitizeSignalingFailure(summary));
    session.capturedAtMs = this.signalingMonotonicNow();
    return session.failure;
  },

  resolveViewerSessionId() {
    const key = 'wrd_viewer_session_id';
    const safe = (value) => /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(String(value || ''))
      ? String(value) : null;
    const inMemory = safe(this._viewerSessionId);
    if (inMemory) return inMemory;
    try {
      const storage = typeof sessionStorage !== 'undefined' ? sessionStorage : null;
      const existing = safe(storage?.getItem?.(key));
      if (existing) {
        this._viewerSessionId = existing;
        return existing;
      }
      const generated = typeof globalThis !== 'undefined' && typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `viewer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
      const value = safe(generated) || `viewer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
      storage?.setItem?.(key, value);
      this._viewerSessionId = value;
      return value;
    } catch (_error) {
      this._viewerSessionId = `viewer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
      return this._viewerSessionId;
    }
  },

  resolveSignalingTransports({ allowPolling = true } = {}) {
    // Websocket-first keeps formal cold path fast; polling remains a fallback when WS is blocked.
    if (allowPolling === false) return ['websocket'];
    return this._signalingSession?.preferPolling ? ['polling', 'websocket'] : ['websocket', 'polling'];
  },

  buildSignalingSocketOptions({ token, reconnection = true, allowPolling = true } = {}) {
    const transports = this.resolveSignalingTransports({ allowPolling });
    const proofAdmission = this.readProofAdmission();
    const timeout = Number(this.signalingConnectBudgetMs) > 0
      ? Number(this.signalingConnectBudgetMs)
      : 5000;
    return {
      auth: {
        token,
        role: 'viewer',
        inputProtocolVersion: 2,
        viewerSessionId: this.resolveViewerSessionId(),
        proofAdmission,
        ...(proofAdmission ? {} : {
          viewerAdmission: this._viewerAdmission || { mode: 'resume', generation: null },
        }),
      },
      reconnection: Boolean(reconnection),
      // Prefer WebSocket; keep polling as bounded fallback for proxy/firewall paths.
      transports,
      // When the first transport fails hard, continue through the list (WS → polling).
      tryAllTransports: true,
      // Each Engine-open attempt is bounded; namespace auth and all retries may take longer.
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
    this.serverConfig.inputFrameCorrelationVersion = capabilities.inputFrameCorrelationVersion === 1 ? 1 : null;
    if (this.serverConfig.inputFrameCorrelationVersion !== 1) this.inputFrameCollector = null;
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
    const episode = this._startupEpisode || null;
    const token = Auth.getToken();
    const authGeneration = Auth.getGeneration?.();
    const ownsConfig = () => Auth.getToken() === token && Auth.getGeneration?.() === authGeneration
      && this.startupAllowed(episode);
    try {
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
      const config = await response.json();
      if (!ownsConfig()) return;
      this.serverConfig = config;
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
          const config = await retry.json();
          if (!ownsConfig()) return;
          this.serverConfig = config;
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
      if (!ownsConfig()) return;
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

    // Reconcile the controller's own loader/retry state with the shared phase
    // and Terminal gate, including when the derived Chrome model is unchanged.
    this.syncChromeCapabilities();
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
    const socket = this.socket;
    if (!socket || typeof socket.on !== 'function') return;
    if ((this._relayPendingStart && this._relayPendingStart.socket !== socket)
      || (this._relayScopeContext && this._relayScopeContext.socket !== socket)) this.clearRelayOrigin();
    const episode = this._startupEpisode || null;
    const signalingSession = this.ensureSignalingSession();
    const signalingManager = socket.io;
    const onCurrentSocket = (event, handler) => {
      socket.on(event, (...args) => {
        if (this.socket !== socket || !this.startupAllowed(episode)) return undefined;
        return handler(...args);
      });
    };

    onCurrentSocket('connect', async () => {
      this.ensureDesktopSessionState()?.applyConnection({
        attemptId: this.currentConnectionAttemptId,
        state: 'online',
        socket: 'online',
      });
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
      if (this.socket !== socket || !this.startupAllowed(episode)) return;
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
      this.handleSignalingRecoveryConnected();
    });

    onCurrentSocket('connect_error', (error) => {
      if (this._superseded || this.manualDisconnect) return;
      if (this._signalingSession !== signalingSession) return;
      try { if (socket.io !== signalingManager) return; } catch (_) { return; }
      const failure = this.recordSignalingFailure(error, socket, signalingManager, signalingSession);
      console.warn('[RECOVERY] Signaling connect error:', failure?.failureClass || 'unknown');
      try {
        if (typeof Diagnostic !== 'undefined') {
          Promise.resolve(Diagnostic.autoSendFailure?.('signal-connect-error')).catch(() => {});
        }
      } catch (_) {}
      this.scheduleSignalingRecovery('signal-connect-error');
    });

    onCurrentSocket('connected', (data) => {
      if (!this.readProofAdmission() && data.viewerAdmission?.mode === 'resume') {
        this._viewerAdmission = { mode: 'resume', generation: data.viewerAdmission.generation };
        // Socket.IO retries the same auth object; drop the consumed ticket now.
        if (socket.auth) socket.auth.viewerAdmission = this._viewerAdmission;
      }
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

    onCurrentSocket('host-status', (data) => {
      console.log('[OFFER-DBG] host-status event: online=%s offerInProgress=%s pc=%s',
        data.online, this.offerInProgress, !!this.pc);
      if (data.online) {
        this.controlState.hostOnline = true;
        this.applyHostCapabilities(data.hostCapabilities);
        this.renderPortSearchStatus();
        if (this.startupPending()) this.setUiPhase('signaling', { reason: 'host-online' });
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
        if (this.startupPending()) this.retireStartupMediaOwner();
        this.freezeControl('host-offline');
        this.setUiPhase('disconnected', { reason: 'host-offline' });
        updateLoadingText('Host已离线');
      }
    });

    onCurrentSocket('host-capabilities', (data) => {
      this.applyHostCapabilities(data);
    });

    onCurrentSocket('answer', async (data) => {
      const answerEpisode = this._startupEpisode || null;
      console.log('Received answer');
      if (!this.pc || this.pc.signalingState !== 'have-local-offer') {
        console.warn('[NETWORK] Ignoring stale answer: pc=%s, signalingState=%s',
          !!this.pc, this.pc?.signalingState);
        return;
      }
      try {
        const peer = this.pc, socket = this.socket, attempt = this.currentConnectionAttemptId;
        const sequence = this.connectionAttemptSequence, epoch = this._offerEpoch;
        const watchdog = this._dataChannelWatchdog;
        if (this.manualDisconnect || this._superseded) return;
        await peer.setRemoteDescription(new RTCSessionDescription(data.answer));
        if (this.pc !== peer || this.socket !== socket || this.currentConnectionAttemptId !== attempt
            || this.connectionAttemptSequence !== sequence || this._offerEpoch !== epoch
            || this.manualDisconnect || this._superseded || !this.startupAllowed(answerEpisode)) return;
        this.finishDataChannelNegotiation(watchdog);
      } catch (err) {
        console.error('Failed to set remote description:', err);
      }
    });

    onCurrentSocket('ice-candidate', async (data) => {
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

    onCurrentSocket('input-ack', (data) => { this.acceptObservedInputAck(data, { transport: 'socket', socket }); });

    onCurrentSocket('viewer-admission-rejected', (data) => {
      this._viewerAdmission = null;
      this.handleViewerSuperseded(data || {});
    });

    onCurrentSocket('viewer-superseded', (data) => {
      this.handleViewerSuperseded(data || {});
    });

    onCurrentSocket('disconnect', (reason) => {
      this.clearRelayOrigin();
      this.ensureDesktopSessionState()?.applyConnection({
        attemptId: this.currentConnectionAttemptId,
        state: 'offline',
        socket: 'offline',
      });
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
      // All media modes depend on signaling for offers, lease recovery and
      // media-activity acknowledgements. Tunnel used to recover here while
      // Relay/STUN could remain stuck until a manual refresh.
      this.scheduleSignalingRecovery('signal-disconnected');
    });

    onCurrentSocket('relay-frame-feedback', (data) => this.handleRelayFrameFeedback(data));
    onCurrentSocket('relay-frame', (data) => {
      this.handleRelayFrame(data);
    });
    onCurrentSocket('control-state', (data) => this.handleControlState(data));
    onCurrentSocket('control-grant', (data) => this.handleControlGrant(data));
    onCurrentSocket('control-acquire-result', (data) => this.handleControlAcquireResult(data));
    onCurrentSocket('control-revoked', () => this.freezeControl('control-revoked'));
    onCurrentSocket('control-transition-failed', () => this.freezeControl('control-transition-failed'));
    onCurrentSocket('control-heartbeat-rejected', () => this.freezeControl('control-heartbeat-rejected'));
    onCurrentSocket('media-activity-ack', (data) => this.handleMediaActivityAck(data));
    onCurrentSocket('relay-stream-control-ack', (data) => this.handleMediaActivityAck(data));
    onCurrentSocket('relay-stream-control-rejected', (data) => {
      this.handleMediaRequestFailure(data?.reason || 'relay-stream-control-rejected');
    });
    onCurrentSocket('media-activity-rejected', (data) => {
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
    Input.requestInputRecovery?.({ source: 'auto' });
    Input.updateKeyboardUI?.();
    return true;
  },

  activeLeaseEnvelope() {
    if (!this.hasActiveControl()) return null;
    const lease = this.controlState.lease;
    return { schemaVersion: 2, leaseId: lease.leaseId, leaseEpoch: lease.leaseEpoch };
  },

  _cancelControlAcquireIntent() {
    this._controlAcquireIntent = null;
    this._controlAcquireRequestId = null;
  },

  _currentControlAcquireIntent() {
    const intent = this._controlAcquireIntent;
    return intent && intent.socket === this.socket && intent.socketId === (this.socket?.id || null)
      ? intent : null;
  },

  _rememberControlAcquireIntent() {
    let intent = this._currentControlAcquireIntent();
    if (!intent) {
      intent = { socket: this.socket, socketId: this.socket?.id || null,
        generation: (this._controlRecoveryGeneration || 0) + 1,
        remaining: 1, waiting: false, resetEpoch: null, releaseSent: false };
      this._controlRecoveryGeneration = intent.generation;
      this._controlAcquireIntent = intent;
    }
    return intent;
  },

  _resumeControlAcquireIntent() {
    const intent = this._currentControlAcquireIntent();
    if (!intent?.waiting || intent.remaining <= 0 || !this.socket?.connected
      || !this.controlState.hostOnline || this._controlUserReleased || this.manualDisconnect
      || this._superseded || this.isControlResetBlocked() || this.controlState.state !== 'FREE') return false;
    intent.waiting = false;
    intent.remaining -= 1;
    return this.requestControl({ allowTakeover: false });
  },

  requestControlRecovery(generation) {
    if (!this.hasActiveControl() || !this.socket?.connected || this._controlUserReleased
      || this.manualDisconnect || this._superseded) return false;
    const intent = this._rememberControlAcquireIntent();
    if (intent.releaseSent || intent.remaining <= 0) return false;
    intent.releaseSent = true;
    intent.waiting = true;
    intent.inputGeneration = generation;
    intent.resetEpoch = this.controlState.lease?.leaseEpoch ?? null;
    if (typeof Input !== 'undefined') {
      Input._preserveRecoveryDraft = true;
      Input._recoveryControlReacquireRequired = true;
      if (Input._recoveryCycle) Input._recoveryCycle.retryAvailable = false;
    }
    this.releaseControl('input-recovery-timeout', { preserveAcquireIntent: true });
    return true;
  },

  requestControl({ allowTakeover = true } = {}) {
    if (!this.socket?.connected || !this.controlState.hostOnline || this._superseded || this.manualDisconnect) return false;
    if (allowTakeover) {
      this._controlUserReleased = false;
      this._cancelControlAcquireIntent();
    } else if (this._controlUserReleased) return false;
    const intent = this._rememberControlAcquireIntent();
    if (this.isControlResetBlocked() || this.controlState.state === 'GRANTING' || this.controlState.state === 'REVOKING') {
      intent.waiting = true;
      intent.resetEpoch = this.controlState.leaseEpoch ?? intent.resetEpoch;
      // Do not paint a sticky "切换中" that ignores later acquire-result.
      this.updateControlUI();
      return false;
    }
    // Automatic paths must not silently steal an existing ACTIVE controller.
    if (this.controlState.state === 'ACTIVE' && !this.controlState.controller && !allowTakeover) {
      intent.waiting = true;
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
    if (data.requestId && data.requestId !== this._controlAcquireRequestId) {
      return;
    }
    const intent = this._currentControlAcquireIntent();
    if (!intent || this._controlUserReleased || this._superseded) return;
    const state = data.state || this.controlState.state;
    if (data.reason === 'reset-in-progress' || state === 'REVOKING') {
      intent.waiting = true;
      intent.resetEpoch = data.leaseEpoch ?? intent.resetEpoch;
    }
    if (data.reason === 'host-offline') this._cancelControlAcquireIntent();
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
    this.ensureDesktopSessionState()?.applyControl({
      attemptId: this.currentConnectionAttemptId,
      state: this.isControlResetBlocked() ? 'blocked' : this.controlState.state,
      blocked: this.isControlResetBlocked(),
    });
    // During GRANTING/REVOKING, controller is false for everyone — do not treat as
    // permanent readonly freeze (that raced with acquire and left sticky UI).
    const transitioning = data.state === 'GRANTING' || data.state === 'REVOKING';
    const intent = this._currentControlAcquireIntent();
    if (intent && data.state === 'REVOKING') {
      intent.waiting = true;
      intent.resetEpoch = data.leaseEpoch ?? intent.resetEpoch;
    }
    if (data.hostOnline === false) this._cancelControlAcquireIntent();
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
    if (data.state === 'FREE') this._resumeControlAcquireIntent();
  },

  handleControlGrant(data = {}) {
    if (!this.startupAllowed()) return;
    if (this._controlUserReleased || this._superseded || this.manualDisconnect) {
      if (this.socket?.connected) this.socket.emit('control-release', { reason: 'released' });
      return;
    }
    const recovering = this._currentControlAcquireIntent();
    if (recovering?.releaseSent && data.leaseEpoch <= recovering.resetEpoch) return;
    if (!data.controller || typeof data.leaseId !== 'string' || !Number.isInteger(data.leaseEpoch)) {
      this.freezeControl('invalid-control-grant');
      return;
    }
    // Keep only correlation metadata through a control freeze; it grants no
    // authority. A fresh lease needs a fresh wire attempt because media ACKs
    // carry attempt/generation, not lease identity.
    const previousLease = this._mediaControlLease || this.controlState?.lease;
    const mediaLeaseChanged = previousLease
      && (previousLease.leaseId !== data.leaseId || previousLease.leaseEpoch !== data.leaseEpoch);
    const peerLease = this.pc?._wrdControlLease;
    const differentPeerLease = peerLease && (peerLease.leaseId !== data.leaseId || peerLease.leaseEpoch !== data.leaseEpoch);
    // A new attempt cannot inherit an unleased peer's old callback owner.
    const unleasedPeerChangesAttempt = this.pc && mediaLeaseChanged && !peerLease;
    if (differentPeerLease || unleasedPeerChangesAttempt) {
      this.cancelDataChannelWatchdog();
      const oldPeer = this.pc;
      for (const event of ['oniceconnectionstatechange', 'onconnectionstatechange',
        'onsignalingstatechange', 'onicegatheringstatechange', 'onicecandidate', 'ontrack']) {
        oldPeer[event] = null;
      }
      this.pc = null;
      this.inputChannel = null;
      this.inputMoveChannel = null;
      this._offerEpoch += 1;
      this.offerInProgress = false;
      this._mediaReadyConnectionAttemptId = null;
      this.hasPaintedFrame = false;
      this.stopDcKeepalive();
      oldPeer.close();
    }
    this.controlState = { ...this.controlState, state: 'ACTIVE', controller: true, lease: { leaseId: data.leaseId, leaseEpoch: data.leaseEpoch } };
    this._mediaControlLease = { ...this.controlState.lease };
    if (mediaLeaseChanged) this.beginConnectionAttempt('control-identity-changed');
    this.ensureDesktopSessionState()?.applyControl({ attemptId: this.currentConnectionAttemptId, state: 'active' });
    if (typeof Input !== 'undefined') {
      Input.init();
      if (Input.setControlLease(this.controlState.lease) === false) {
        this.requestControlRecovery(Input._recoveryCycle?.generation);
        return;
      }
    }
    if (!this.hasActiveControl()) return;
    this._cancelControlAcquireIntent();
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
      this.reconcileConfiguredControlMedia();
      this.replayMediaActivityIntent('control-regrant');
    }
  },

  reconcileConfiguredControlMedia() {
    if (!this.startupAllowed() || this._deferPeerUntilConfig || !this.hasActiveControl()
      || this.networkMode === 'tunnel') return false;
    // WebRTC ACTIVE precedes Input's acceptance. Read its existing authority and
    // recovery state; replaying setControlLease here could clear safety state.
    if (typeof Input !== 'undefined') {
      const lease = this.controlState.lease;
      if (Input._recoveryControlReacquireRequired
        || Input.keyboardTransport?.getSnapshot?.().state === 'reacquire-required'
        || Input.activeControlLease?.leaseId !== lease.leaseId
        || Input.activeControlLease?.leaseEpoch !== lease.leaseEpoch) {
        this.requestControlRecovery(Input._recoveryCycle?.generation);
        return false;
      }
    }
    const pcState = this.pc?.connectionState;
    const live = pcState === 'connected' && (this.inputChannel?.readyState === 'open' || this._refreshing);
    if (live) return false;
    if (!this.pc || ['failed', 'closed', 'disconnected'].includes(pcState)) this.createPeerConnection();
    // A pending matching local offer already joins these two prerequisites.
    // Stable/completed peers remain eligible for ordinary regrant recovery.
    const peer = this.pc;
    if (peer?.signalingState === 'have-local-offer' && peer.localDescription?.type === 'offer'
      && peer._wrdEmittedOffer?.socket === this.socket
      && peer._wrdEmittedOffer?.attemptId === this.currentConnectionAttemptId
      && peer._wrdEmittedOffer?.attemptSequence === (Number(this.connectionAttemptSequence) || 1)
      && peer._wrdConnectionAttemptId === this.currentConnectionAttemptId
      && peer._wrdControlLease?.leaseId === this.controlState.lease.leaseId
      && peer._wrdControlLease?.leaseEpoch === this.controlState.lease.leaseEpoch) return false;
    this.createOffer();
    return true;
  },

  freezeControl(reason, reset = true) {
    this.clearRelayOrigin();
    if (['signal-disconnect', 'host-offline', 'viewer-superseded', 'control-revoked'].includes(reason)) {
      this._cancelControlAcquireIntent();
    }
    this.stopControlHeartbeat();
    // Do not clear _mediaReadyConnectionAttemptId here. Control ownership and
    // "has this attempt painted" are independent; clearing readiness on every
    // revoke/visibility freeze left re-grant blocked until the next frame, which
    // may not arrive for seconds on full-relay survival profiles.
    if (typeof Input !== 'undefined') {
      const suspended = reason === 'signal-disconnect'
        && Input.suspendControlLease?.() === true;
      // Reset keyboard while lease is still present so the envelope can send.
      if (!suspended) {
        if (reset) Input.resetKeyboard?.('control-revoked');
        if (reason !== 'input-recovery-timeout') Input.releasePointer?.(reason || 'control-lost');
        Input.setControlLease(null);
      }
      Input.setActive(false, { resetKeyboard: false, reason: reason || 'control-lost' });
    }
    this.controlState = { ...this.controlState, controller: false, lease: null };
    this.ensureDesktopSessionState()?.applyControl({
      attemptId: this.currentConnectionAttemptId,
      state: this.isControlResetBlocked() ? 'blocked' : 'free',
      blocked: this.isControlResetBlocked(),
    });
    if (this.isPortSearchActive()) {
      this.stopPortSearch(reason === 'host-offline' ? 'host-offline' : 'control-lost');
    } else {
      this.renderPortSearchStatus();
    }
    this.updateControlUI();
  },

  startControlHeartbeat() {
    this.stopControlHeartbeat();
    if (!this.hasActiveControl() || !this.socket?.connected) return;
    const heartbeat = () => {
      const lease = this.controlState.lease;
      if (this.hasActiveControl() && this.socket?.connected) {
        this.socket.emit('control-heartbeat', { leaseId: lease.leaseId, leaseEpoch: lease.leaseEpoch });
      }
    };
    heartbeat();
    this._controlHeartbeatTimer = setInterval(heartbeat, 3000);
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

  releaseControl(reason, { preserveAcquireIntent = false } = {}) {
    if (!preserveAcquireIntent) {
      this._controlUserReleased = true;
      this._cancelControlAcquireIntent();
    }
    const wasActive = this.hasActiveControl();
    if (!preserveAcquireIntent && typeof Input !== 'undefined') Input.resetKeyboard?.('deactivated');
    this.freezeControl(reason, false);
    if (wasActive && this.socket?.connected) this.socket.emit('control-release', { reason });
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
    // Visibility events cover ordinary tab switching.  pageshow/pagehide are
    // needed for bfcache, mobile browser suspension, and OS sleep where the
    // document can return visible while Socket.IO still owns a dead transport.
    if (!this._pageLifecycleRecoveryBound) {
      this._pageLifecycleRecoveryBound = true;
      window.addEventListener?.('pagehide', (event) => {
        this.handlePageLifecycle('pagehide', event);
      });
      window.addEventListener?.('pageshow', (event) => {
        this.handlePageLifecycle('pageshow', event);
      });
      window.addEventListener?.('online', () => {
        this.handlePageLifecycle('online');
      });
    }
    window.addEventListener?.('beforeunload', () => this.releaseControl('viewer-disconnect'));
  },

  handlePageLifecycle(kind = 'pageshow', _event = null) {
    if (this.manualDisconnect || this._superseded) return false;
    if (kind === 'pagehide') {
      this._pageLifecycleHidden = true;
      if (!this.socket?.connected) this.scheduleSignalingRecovery('pagehide');
      return true;
    }

    this._pageLifecycleHidden = false;
    if (kind === 'pageshow') {
      this.ensureMediaActiveIfVisible('pageshow');
      this.rebindActiveKeyboardLease('pageshow');
    }

    if (this.socket?.connected) {
      if (this._signalRecoveryPending) this.handleSignalingRecoveryConnected();
      return true;
    }

    // Prefer Socket.IO's existing manager so an in-flight backoff is reused;
    // recreate only when the socket no longer exposes connect().
    let started = false;
    try {
      if (this.socket && typeof this.socket.connect === 'function') {
        this.socket.connect();
        started = true;
      }
    } catch (error) {
      console.warn('[RECOVERY] Failed to resume signaling socket:', error);
    }
    if (!started) this.createSignalingSocket(true);
    this.scheduleSignalingRecovery(kind === 'online' ? 'network-online' : 'pageshow');
    return true;
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
    const session = this.ensureDesktopSessionState();
    if (session) {
      session.applyControl({
        attemptId: this.currentConnectionAttemptId,
        state: this.isControlResetBlocked() ? 'blocked' : this.controlState.state,
        blocked: this.isControlResetBlocked(),
      });
    }
    const sessionControl = this.getDesktopSessionSnapshot().control;
    const transitioning = this.controlState.state === 'GRANTING' || this.controlState.state === 'REVOKING';
    const resetBlocked = this.isControlResetBlocked();
    if (!status && !this.controlState.controller) {
      if (resetBlocked) status = 'Host 输入复位未确认，控制已安全锁定';
      else if (transitioning) status = '控制权正在切换';
      else status = '只读';
    }
    const label = status
      || (sessionControl === 'active' && this.hasActiveControl()
        ? '已控制'
        : (sessionControl === 'free' ? '只读' : (resetBlocked ? 'Host 输入复位未确认，控制已安全锁定' : '控制权正在切换')));
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
    this.syncChromeCapabilities();
    // Recovery controls live in a body-level overlay so they remain usable
    // while the normal chrome is hidden. Keep that overlay in sync with
    // asynchronous grant/reject transitions as well as the status bar.
    if (typeof Input !== 'undefined') Input.updateInputRecoveryUI?.();
  },

  STABLE_RECOVERY_RESET_MS: 5000,
  armStableRecoveryReset() {
    if (this._stableResetTimer) clearTimeout(this._stableResetTimer);
    const owner = this.captureStartupOwner();
    this._stableResetTimer = setTimeout(() => {
      if (!this.ownsStartupOwner(owner)) return;
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
    if (!this.startupAllowed()) return;
    this.checkStartupEpisode({ connected: true });
    if (!this.startupAllowed()) return;
    const owner = this.captureStartupOwner();
    if (this._refreshing) {
      if (this.inputChannel?.readyState === 'open') {
        this.markRefreshSettled('pc-connected');
      } else {
        this.clearRefreshDcWaitTimer();
        const waitTimer = setTimeout(() => {
          if (this._refreshDcWaitTimer !== waitTimer) return;
          this._refreshDcWaitTimer = null;
          this.markRefreshSettled('pc-connected-dc-wait');
        }, 2000);
        this._refreshDcWaitTimer = waitTimer;
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
    const visibleMediaEnsured = this.ensureMediaActiveIfVisible('pc-connected');
    // A resume sent before the new offer is installed can receive `closed`
    // from the previous Host peer. A hidden tab can still desire active media
    // during its five-minute grace period, so peer readiness must retry that
    // request without waiting for a visibility event or clearing pause reasons.
    if (!visibleMediaEnsured && this._mediaIntent?.state === 'active'
        && this.getMediaActivitySnapshot().state === 'active'
        && this.getMediaAppliedPhase() === 'resuming') {
      const generation = this._mediaIntent.generation;
      const attemptId = this.currentConnectionAttemptId;
      const ack = this.mediaActivityRuntime?.snapshot?.().lastAck;
      const acknowledged = ack?.applied === true && ack.state === 'active'
        && ack.generation === generation && ack.connectionAttemptId === attemptId;
      const prior = this._mediaResumeReadyReplay;
      const alreadyReplayed = prior?.pc === this.pc && prior.attemptId === attemptId
        && prior.generation === generation;
      if (!acknowledged && !alreadyReplayed) {
        this._mediaResumeReadyReplay = { pc: this.pc, attemptId, generation };
        this.replayMediaActivityIntent('pc-ready-resume');
      }
    }
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
      if (!this.ownsStartupOwner(owner)) return;
      if (typeof LatencyMonitor !== 'undefined') {
        LatencyMonitor.requestClockSync();
      }
    }, 2000);
    this.armStableRecoveryReset();
  },

  createPeerConnection() {
    if (!this.startupAllowed() || this._deferPeerUntilConfig) return;
    this.cancelDataChannelWatchdog();
    this.clearRefreshDcWaitTimer();
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
    const previousPeer = this.pc;
    if (previousPeer) {
      // ACKs identify attempt/generation, not PC objects. Retiring a producer
      // must advance the wire attempt before createOffer or intent replay.
      if (!previousPeer._wrdConnectionAttemptId
        || previousPeer._wrdConnectionAttemptId === this.currentConnectionAttemptId) {
        this.beginConnectionAttempt('peer-replaced');
      }
      for (const event of ['oniceconnectionstatechange', 'onconnectionstatechange',
        'onsignalingstatechange', 'onicegatheringstatechange', 'onicecandidate', 'ontrack']) {
        previousPeer[event] = null;
      }
      previousPeer.close?.();
    }
    this.clearMediaResumeProof();
    this.pc = new RTCPeerConnection(this.config);
    this.pc._wrdConnectionAttemptId = this.currentConnectionAttemptId;
    // Bind before the asynchronous offer finishes: media replay can run first.
    this.bindCurrentConnectionAttempt();
    this.pc._wrdControlLease = this.controlState?.lease ? Object.freeze({ ...this.controlState.lease }) : null;
    this.videoTransceiver = null;
    this.inputChannel = null;
    this.inputMoveChannel = null;

    console.log('Creating RTCPeerConnection with config:', this.config);
    this.updateNetworkUI('正在建立媒体链路...');
    this.createInputChannel();
    this.bindPeerCallbacks();
  },

  bindPeerCallbacks() {
    if (this._peerCallbackOwner) this._peerCallbackOwner.retired = true;
    const startupOwner = this._peerCallbackOwner = this.captureStartupOwner();
    this.pc.onicecandidate = (event) => {
      if (!this.ownsStartupOwner(startupOwner)) return;
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
      if (!this.ownsStartupOwner(startupOwner)) return;
      console.log('Viewer ICE gathering state:', this.pc.iceGatheringState);
    };

    this.pc.oniceconnectionstatechange = () => {
      if (!this.ownsStartupOwner(startupOwner)) return;
      console.log('Viewer ICE connection state:', this.pc.iceConnectionState);
      if (this.pc.iceConnectionState === 'connected' || this.pc.iceConnectionState === 'completed') {
        this.checkStartupEpisode({ connected: true });
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
          if (!this.ownsStartupOwner(startupOwner)) return;
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
      if (!this.ownsStartupOwner(startupOwner)) return;
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
            if (!this.ownsStartupOwner(startupOwner)) return;
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
      if (!this.ownsStartupOwner(startupOwner)) return;
      console.log('Viewer Signaling state:', this.pc.signalingState);
    };

    this.pc.ontrack = (event) => {
      if (!this.ownsStartupOwner(startupOwner)) return;
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

      this.markRemoteTrack({
        readyState: videoElement.readyState,
        paused: videoElement.paused,
      });

      this.bindRemoteVideoCallbacks(startupOwner);

      this.remoteStream.getTracks().forEach(track => {
        console.log('Track:', track.kind, 'enabled:', track.enabled, 'state:', track.readyState);
      });

      // First-frame warmup is admission-controlled by the canonical stats path;
      // do not schedule an extra request before that path has a health sample.

      // Last-resort fallback: stay media-pending unless a decoded frame actually landed.
      setTimeout(() => {
        if (!this.ownsStartupOwner(startupOwner)) return;
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

  bindRemoteVideoCallbacks(startupOwner, { observeCurrent = true } = {}) {
    const videoElement = document.getElementById('remoteVideo');
    if (!videoElement) return;
    const tryPaintGate = () => {
      if (!this.ownsStartupOwner(startupOwner)) return;
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

    if (observeCurrent && videoElement.readyState >= 1) {
      tryPaintGate();
    } else {
      videoElement.onloadedmetadata = () => {
        if (!this.ownsStartupOwner(startupOwner)) return;
        console.log('Video metadata loaded:', videoElement.videoWidth, 'x', videoElement.videoHeight);
        tryPaintGate();
      };
    }

    videoElement.onplaying = () => {
      if (!this.ownsStartupOwner(startupOwner)) return;
      console.log('Video is now playing');
      tryPaintGate();
    };
  },

  ownsDataChannelOwner(owner, channel = owner?.channel) {
    return !!owner && !owner.retired && this.pc === owner.peer && this.inputChannel === channel
      && this.socket === owner.socket && this.currentConnectionAttemptId === owner.attempt
      && this.connectionAttemptSequence === owner.sequence && !this.manualDisconnect && !this._superseded
      && this.startupAllowed();
  },

  cancelDataChannelWatchdog(retireChannel = true) {
    // Teardown must also fence synchronous/queued channel-close callbacks.
    // Open and unexpected connected-close only finish the phase timer.
    if (retireChannel && this._inputChannelOwner) this._inputChannelOwner.retired = true;
    const record = this._dataChannelWatchdog;
    if (record?.timer != null) clearTimeout(record.timer);
    this._dataChannelWatchdog = null;
    this._dataChannelWatchdogFailure = null;
    this._dcTimeout = null;
    if (this._dcReconnectTimer != null) clearTimeout(this._dcReconnectTimer);
    this._dcReconnectTimer = null;
  },

  dataChannelWatchdogNow(record) {
    let now;
    try { now = performance.now(); } catch (_) { now = NaN; }
    if (!Number.isFinite(now) || now < 0 || (record && now < record.lastNow)) {
      if (record) record.clockValid = false;
      return null;
    }
    if (record) { record.lastNow = now; if (!record.clockValid) return null; }
    return now;
  },

  getDataChannelWatchdogSnapshot() {
    if (this._dataChannelWatchdogFailure) return this._dataChannelWatchdogFailure;
    const record = this._dataChannelWatchdog;
    const current = record && this.ownsDataChannelOwner(record);
    const now = current ? this.dataChannelWatchdogNow(record) : null;
    const safe = (obj, key) => { try { return obj?.[key] ?? null; } catch (_) { return null; } };
    const raw = { phase: current ? record.phase : 'inactive', timedOut: current ? record.timedOut : false,
      elapsedMs: now === null ? null : now - record.startedAt,
      remainingMs: now === null ? null : Math.max(0, record.deadline - now),
      extensions: current ? record.extensions : 0,
      pcState: safe(this.pc, 'connectionState'), iceState: safe(this.pc, 'iceConnectionState'),
      signalingState: safe(this.pc, 'signalingState'), sctpState: safe(safe(this.pc, 'sctp'), 'state'),
      inputState: safe(this.inputChannel, 'readyState'), moveState: safe(this.inputMoveChannel, 'readyState'),
      socketConnected: safe(this.socket, 'connected'), localDescriptionSet: this.pc ? !!safe(this.pc, 'localDescription') : null,
      remoteDescriptionSet: this.pc ? !!safe(this.pc, 'remoteDescription') : null };
    return typeof sanitizeDataChannelWatchdog === 'function' ? sanitizeDataChannelWatchdog(raw) : null;
  },

  startDataChannelWatchdog(channel) {
    this.cancelDataChannelWatchdog();
    this._dataChannelWatchdogFailure = null;
    if (!channel || channel.readyState === 'open') return;
    const now = this.dataChannelWatchdogNow();
    const phase = this.pc.connectionState === 'connected' || this.pc.remoteDescription ? 'channel-open' : 'negotiation';
    const record = { peer: this.pc, channel, socket: this.socket, attempt: this.currentConnectionAttemptId,
      sequence: this.connectionAttemptSequence, phase, timedOut: false, extensions: 0,
      startedAt: now, lastNow: now, clockValid: now !== null, deadline: now === null ? null : now + (phase === 'negotiation' ? 30000 : 10000), timer: null };
    this._dataChannelWatchdog = record;
    this.armDataChannelWatchdog(record, phase === 'negotiation' ? 30000 : 10000);
  },

  armDataChannelWatchdog(record, delay) {
    record.timer = setTimeout(() => this.checkDataChannelWatchdog(record), delay);
    this._dcTimeout = record.timer;
  },

  checkDataChannelWatchdog(record) {
    if (this._dataChannelWatchdog !== record || !this.ownsDataChannelOwner(record) || record.timedOut) return;
    if (record.channel.readyState === 'open') { this.cancelDataChannelWatchdog(false); return; }
    const now = this.dataChannelWatchdogNow(record);
    if (now !== null && now < record.deadline) {
      if (record.timer != null) clearTimeout(record.timer);
      this.armDataChannelWatchdog(record, record.deadline - now); return;
    }
    if (record.phase === 'channel-open' && now !== null && record.extensions < 2
        && (record.peer.connectionState === 'connecting' || record.peer.iceConnectionState === 'checking')) {
      record.extensions++; record.deadline = now + 10000;
      if (record.timer != null) clearTimeout(record.timer);
      this.armDataChannelWatchdog(record, 10000); return;
    }
    record.timedOut = true;
    if (record.timer != null) clearTimeout(record.timer);
    record.timer = null; this._dcTimeout = null;
    try { this._dataChannelWatchdogFailure = this.getDataChannelWatchdogSnapshot(); } catch (_) {}
    const reason = record.phase === 'negotiation' ? 'negotiation-timeout' : 'dc-stuck';
    try { if (typeof Diagnostic !== 'undefined') Diagnostic.autoSendFailure?.(reason); } catch (_) {}
    if (record.phase === 'negotiation') this.scheduleReconnect(reason);
    else this.noteDataChannelFault(reason);
  },

  finishDataChannelNegotiation(record) {
    if (!record || this._dataChannelWatchdog !== record || !this.ownsDataChannelOwner(record)
        || record.phase !== 'negotiation' || record.timedOut) return;
    if (record.channel.readyState === 'open') { this.cancelDataChannelWatchdog(false); return; }
    const now = this.dataChannelWatchdogNow(record);
    // Unknown monotonic time cannot purchase a fresh budget. Keep the finite timer.
    if (now === null) return;
    if (now >= record.deadline) { this.checkDataChannelWatchdog(record); return; }
    if (record.timer != null) clearTimeout(record.timer);
    record.phase = 'channel-open'; record.startedAt = now; record.deadline = now + 10000;
    this.armDataChannelWatchdog(record, 10000);
  },

  createInputChannel() {
    if (!this.pc || this.inputChannel) {
      return;
    }

    const inputChannel = this.pc.createDataChannel('input', {
      ordered: true
    });
    this.inputChannel = inputChannel;
    this._quarantinedInputChannel = null;
    inputChannel.bufferedAmountLowThreshold = 32 * 1024;
    this.inputMoveChannel = this.pc.createDataChannel('input-move', {
      ordered: false,
      maxRetransmits: 0
    });
    this.inputMoveChannel.bufferedAmountLowThreshold = 4 * 1024;

    this.startDataChannelWatchdog(inputChannel);
    this.bindInputChannelCallbacks();
  },

  bindInputChannelCallbacks() {
    const inputChannel = this.inputChannel;
    if (!inputChannel) return;
    if (this._inputChannelOwner) this._inputChannelOwner.retired = true;
    const channelOwner = this._inputChannelOwner = { peer: this.pc, socket: this.socket, attempt: this.currentConnectionAttemptId, sequence: this.connectionAttemptSequence };
    inputChannel.onopen = () => {
      if (!this.ownsDataChannelOwner(channelOwner, inputChannel)) return;
      if (this._refreshing) this.markRefreshSettled('dc-open');
      console.log('[INPUT-DC] DataChannel open');
      this.cancelDataChannelWatchdog(false);
      this._inputDcDegraded = false;
      if (typeof Input !== 'undefined') Input.setKeyboardDataChannelAvailable?.(true);
      if (typeof Input !== 'undefined') Input.updateKeyboardUI?.();
      this.rebindActiveKeyboardLease('dc-open');
      // Start keepalive to prevent SCTP idle timeout and maintain Chrome's
      // "open DataChannel" exemption from background tab intensive throttling.
      this.startDcKeepalive();
    };
    inputChannel.onclose = () => {
      if (!this.ownsDataChannelOwner(channelOwner, inputChannel)) return;
      const sctpState = this.pc && this.pc.sctp ? this.pc.sctp.state : 'no-sctp';
      console.log('[INPUT-DC] DataChannel closed, sctp=%s pc=%s ice=%s',
        sctpState,
        this.pc ? this.pc.connectionState : 'no-pc',
        this.pc ? this.pc.iceConnectionState : 'no-pc');
      if (this.pc?.connectionState === 'connected') this.cancelDataChannelWatchdog(false);
      this.stopDcKeepalive();
      if (typeof Input !== 'undefined') Input.setKeyboardDataChannelAvailable?.(false);
      // Defer reconnect to avoid cascading on brief DC hiccups
      if (!this._refreshing && !this.manualDisconnect && this.pc &&
          this.pc.connectionState === 'connected') {
        if (this._dcReconnectTimer != null) return;
        console.warn('[INPUT-DC] Unexpected close while PC connected, will reconnect in 3s if not recovered');
        this.scheduleDataChannelRecovery(channelOwner, inputChannel, 'dc-closed');
      }
    };
    inputChannel.onerror = (event) => {
      if (!this.ownsDataChannelOwner(channelOwner, inputChannel)) return;
      console.warn('[INPUT-DC] DataChannel error:', event);
      if (typeof Input !== 'undefined') Input.setKeyboardDataChannelAvailable?.(false);
      // Error typically precedes close; defer reconnect to avoid cascading
      if (!this._refreshing && !this.manualDisconnect && this.pc &&
          this.pc.connectionState === 'connected') {
        if (this._dcReconnectTimer != null) return;
        this.scheduleDataChannelRecovery(channelOwner, inputChannel, 'dc-error');
      }
    };
    inputChannel.onmessage = (event) => {
      if (channelOwner.retired || (this.startupPending()
          && !this.ownsDataChannelOwner(channelOwner, inputChannel))) return;
      try {
        const data = JSON.parse(event.data);

        // Latency measurement messages
        if (data.type === 'frame_timing') {
          if (typeof LatencyMonitor !== 'undefined') {
            LatencyMonitor.onFrameTiming(data, { scope: this.latencyScope() });
          }
          return;
        }
        if (data.type === 'input_frame_binding') {
          const collector = this.ensureInputFrameCollector();
          collector?.acceptBinding(data, this.latencyScope());
          // Keep detailed marker joins opt-in. Ordinary production sessions
          // retain M2 post-apply evidence but never infer content visibility
          // from an arbitrary next frame.
          if (this._controlledSceneMarkerRoi) {
            this.ensureFrameTraceCollector().acceptBinding(data, this.latencyScope());
          }
          this.consumeInputFrameMatches();
          this.consumeControlledVisibleEffects();
          return;
        }
        if (data.type === 'frame_trace_batch') {
          this.acceptFrameTraceBatch(data);
          return;
        }
        if (data.type === 'loss_lab_host_selected_pair') {
          if (typeof this._lossLabHostPairResolve === 'function') this._lossLabHostPairResolve(data);
          return;
        }
        if (data.type === 'loss_lab_trace_flush_ack') {
          this.acceptLossLabFlushAck(data);
          return;
        }
        if (data.type === 'loss_lab_host_trace_batch') {
          this.acceptLossLabHostTraceBatch(data);
          return;
        }
        if (data.type === 'clock_sync_resp') {
          if (typeof LatencyMonitor !== 'undefined') {
            LatencyMonitor.handleClockSyncResponse(data, { scope: this.latencyScope() });
          }
          return;
        }
        if (data.type === 'input_ack') {
          this.acceptObservedInputAck(data, { transport: 'datachannel', dataChannel: inputChannel });
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
      if (channelOwner.retired) return;
      console.log('[INPUT-DC] Move DataChannel open');
    };
    this.inputMoveChannel.onclose = () => {
      if (channelOwner.retired) return;
      console.log('[INPUT-DC] Move DataChannel closed');
    };
    this.inputMoveChannel.onerror = (event) => {
      if (channelOwner.retired) return;
      console.warn('[INPUT-DC] Move DataChannel error:', event);
    };
  },

  scheduleDataChannelRecovery(owner, channel, reason, deadline = performance.now() + 3000) {
    this._dcReconnectDeadline = deadline;
    this._dcReconnectReason = reason;
    const recoveryTimer = setTimeout(() => {
      if (this._dcReconnectTimer !== recoveryTimer) return;
      this._dcReconnectTimer = null;
      if (!this.ownsDataChannelOwner(owner, channel) || this._refreshing || this.pc.connectionState !== 'connected') return;
      this.noteDataChannelFault(reason);
    }, Math.max(0, deadline - performance.now()));
    this._dcReconnectTimer = recoveryTimer;
  },

  sendInput(data) {
    const isMouseMove = data.type === 'mouse' && data.action === 'move';
    // Safety barriers must not queue behind an apparently open, stalled SCTP
    // stream. Keyboard resets already use Socket.IO for the same reason.
    if (data.type === 'mouse' && data.action === 'reset' && this.socket?.connected) return false;
    const channel = isMouseMove && this.inputMoveChannel?.readyState === 'open'
      ? this.inputMoveChannel
      : this.inputChannel;

    if (!channel || channel.readyState !== 'open'
        || channel === this._quarantinedInputChannel) {
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
    try {
      const viewerClockMs = performance.now();
      if (typeof LatencyMonitor !== 'undefined' && typeof Input !== 'undefined'
          && data.leaseId === Input.activeControlLease?.leaseId
          && data.leaseEpoch === Input.activeControlLease?.leaseEpoch) LatencyMonitor.observeControlledSend?.({
        inputId: data.inputIds?.length === 1 ? data.inputIds[0] : null,
        leaseId: data.leaseId, leaseEpoch: data.leaseEpoch,
        inputType: data.type, action: data.action, seq: data.seq ?? null,
      }, {
        viewerClockMs, scope: this.latencyScope(), streamId: this.currentFrameTraceIdentity().streamId,
        transport: 'datachannel', sendSource: channel, ackSource: this.inputChannel,
        socketId: null, pc: this.pc || null, live: this.captureControlledTransportSnapshot(),
      });
    } catch (_) { /* Observation cannot change an accepted delivery. */ }
    return true;
  },

  quarantineReliableInputChannel(reason = 'input-ack-timeout', channel = this.inputChannel) {
    if (!channel || channel !== this.inputChannel || this._quarantinedInputChannel === channel) return false;
    this._quarantinedInputChannel = channel;
    this._inputDcDegraded = true;
    console.warn('[INPUT-DC] Reliable input ACK timed out; using Socket.IO reason=%s', reason);
    if (typeof Input !== 'undefined') Input.setKeyboardDataChannelAvailable?.(false);
    return true;
  },

  validRelayScope(scope) {
    const nonce = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max && !(/[^\x20-\x7e]/.test(v));
    return Boolean(scope && typeof scope === 'object' && !Array.isArray(scope)
      && Object.keys(scope).length === 5
      && ['producerId', 'productionGeneration', 'connectionAttemptId', 'mediaGeneration', 'leaseEpoch']
        .every(key => Object.prototype.hasOwnProperty.call(scope, key))
      && nonce(scope.producerId, 64)
      && nonce(scope.connectionAttemptId, 128)
      && Number.isSafeInteger(scope.productionGeneration) && scope.productionGeneration >= 1
      && Number.isSafeInteger(scope.mediaGeneration) && scope.mediaGeneration >= 0
      && Number.isSafeInteger(scope.leaseEpoch) && scope.leaseEpoch >= 1);
  },

  clearRelayOrigin() {
    clearTimeout(this._relayFreshnessTimer);
    this._relayFreshnessTimer = null;
    this._relayFreshnessToken = (this._relayFreshnessToken || 0) + 1;
    this._relayPendingStart = null;
    this._relayAcceptedStartRequestId = null;
    this._relayExpectedScope = null;
    this._relayScopeContext = null;
    this._relayOriginDigest = null;
    this._relayOriginToken = (this._relayOriginToken || 0) + 1;
    this._relayImageRequestToken = (this._relayImageRequestToken || 0) + 1;
    this._relayLastLoadedAtMs = null;
    this._relayLoadTimes = [];
    this._relayFrameStale = false;
    this._relayFeedbackSequence = 0;
    this._relaySampleSequence = 0;
    this._relayFeedbackSummary = null;
    this._relayRttView = null;
    this.tunnelLastFrameId = 0;
    this._lastRenderedRelayFrame = null;
    const image = document.getElementById('relayImage');
    if (image) image.onload = null;
    for (const key of ['tunnelPendingObjectUrl', 'tunnelLastObjectUrl']) {
      if (this[key]) URL.revokeObjectURL(this[key]);
      this[key] = '';
    }
    // This cleanup also runs for WebRTC attempts/control loss; their RTT label
    // belongs to the WebRTC stats renderer. Reset only an active relay display.
    if (this.tunnelRelayActive) this.renderRelayFeedbackRtt();
  },

  invalidateRelayInputProof(reason) {
    this.hasPaintedFrame = false;
    this._mediaReadyConnectionAttemptId = null;
    this.ensureDesktopSessionState()?.applyMedia({ attemptId: this.currentConnectionAttemptId,
      state: 'stalled', fresh: false });
    if (typeof Input !== 'undefined') {
      const wasActive = Input.isActive;
      Input.setActive(false, { resetKeyboard: true, reason, keyboardResetReason: 'deactivated' });
      const keyboard = Input.keyboardController?.getSnapshot?.() || {};
      if (!wasActive && (keyboard.pressedKeyCount > 0 || keyboard.state === 'RESET_REQUIRED')) {
        Input.resetKeyboard?.('deactivated');
      }
    }
    this.syncDesktopInputGate();
  },

  relayScopeMatches(scope) {
    const current = this._relayExpectedScope, context = this._relayScopeContext;
    const lease = this.activeLeaseEnvelope();
    return Boolean(this.validRelayScope(scope) && current && context && lease
      && context.socket === this.socket && this.socket?.connected
      && context.leaseId === lease.leaseId && current.leaseEpoch === lease.leaseEpoch
      && current.connectionAttemptId === this.currentConnectionAttemptId
      && current.mediaGeneration === (this._mediaIntent?.generation ?? this.getMediaActivitySnapshot().generation ?? 0)
      && Object.keys(current).every(key => scope[key] === current[key]));
  },

  acceptRelayScope(scope) {
    const lease = this.activeLeaseEnvelope();
    if (!this.validRelayScope(scope) || !lease || !this.socket?.connected
      || scope.connectionAttemptId !== this.currentConnectionAttemptId || scope.leaseEpoch !== lease.leaseEpoch
      || scope.mediaGeneration !== (this._mediaIntent?.generation ?? this.getMediaActivitySnapshot().generation ?? 0)) return false;
    if (this.relayScopeMatches(scope)) return true;
    this.clearRelayOrigin();
    const origin = Object.freeze({ ...scope });
    this._relayExpectedScope = origin;
    this._relayScopeContext = { socket: this.socket, leaseId: lease.leaseId };
    const token = this._relayOriginToken, socket = this.socket;
    // SHA-256 is optional diagnostics. Media admission never awaits it.
    if (typeof crypto !== 'undefined' && crypto.subtle && typeof TextEncoder !== 'undefined') {
      const canonical = JSON.stringify([origin.producerId, origin.productionGeneration,
        origin.connectionAttemptId, origin.mediaGeneration, origin.leaseEpoch]);
      try {
        Promise.resolve(crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))).then(bytes => {
          if (token !== this._relayOriginToken || socket !== this.socket || !this.relayScopeMatches(origin)) return;
          this._relayOriginDigest = Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
        }).catch(() => {});
      } catch (_) {}
    }
    return true;
  },

  handleRelayStartAck(data) {
    const pending = this._relayPendingStart, lease = this.activeLeaseEnvelope();
    if (!pending || !lease || pending.socket !== this.socket || !this.socket?.connected
      || pending.leaseId !== lease.leaseId || pending.leaseEpoch !== lease.leaseEpoch
      || pending.attempt !== this.currentConnectionAttemptId || data.connectionAttemptId !== pending.attempt
      || data.generation !== pending.mediaGeneration || data.relayStartRequestId !== pending.requestId
      || data.applied !== true || data.state !== 'active' || data.relayFrameSchemaVersion !== 1
      || !this.validRelayScope(data.relayScope)
      || data.relayScope.connectionAttemptId !== pending.attempt
      || data.relayScope.mediaGeneration !== pending.mediaGeneration
      || data.relayScope.leaseEpoch !== pending.leaseEpoch
      || this.getMediaActivitySnapshot().state !== 'active') return false;
    if (!this.acceptRelayScope(data.relayScope)) return false;
    this._relayPendingStart = null;
    this._relayAcceptedStartRequestId = data.relayStartRequestId;
    // The ACK authenticates the producer; only its next qualified onload proves media.
    this.syncDesktopInputGate();
    return true;
  },

  noteRelayImageLoaded(origin) {
    const now = performance.now();
    this._relayLastLoadedAtMs = now;
    this._relayFrameStale = false;
    this._relayLoadTimes = (this._relayLoadTimes || []).filter(at => now - at < 5000).slice(-255);
    this._relayLoadTimes.push(now);
    const span = now - this._relayLoadTimes[0];
    document.getElementById('fpsDisplay').textContent = `${span > 0 ? Math.round((this._relayLoadTimes.length - 1) * 1000 / span) : 0} FPS`;
  },

  armRelayFreshnessTimer(origin) {
    clearTimeout(this._relayFreshnessTimer);
    this._relayFreshnessTimer = null;
    const token = this._relayFreshnessToken = (this._relayFreshnessToken || 0) + 1;
    if (!this.relayScopeMatches(origin)) return;
    const now = performance.now(), deadlines = [];
    if (this._relayLastLoadedAtMs != null && !this._relayFrameStale
      && this.getMediaActivitySnapshot().state === 'active' && !this.isMediaHealthSuppressed()) {
      deadlines.push(this._relayLastLoadedAtMs + 5000);
    }
    if (this._relayRttView && now - this._relayRttView.receivedAtMs < 5000) deadlines.push(this._relayRttView.receivedAtMs + 5000);
    if (!deadlines.length) return;
    // One current-scope timer handles both image-load age and RTT display expiry.
    // Feedback can expire its own UI sample, but cannot advance image freshness.
    this._relayFreshnessTimer = setTimeout(() => {
      if (token !== this._relayFreshnessToken) return;
      this._relayFreshnessTimer = null;
      if (!this.relayScopeMatches(origin) || !this.tunnelRelayActive) return;
      this.renderRelayFeedbackRtt();
      const age = this._relayLastLoadedAtMs == null ? null : performance.now() - this._relayLastLoadedAtMs;
      if (this.getMediaActivitySnapshot().state === 'active' && !this.isMediaHealthSuppressed()
        && age != null && age >= 5000 && !this._relayFrameStale) {
        this._relayFrameStale = true;
        this.setUiPhase('media-stalled', { reason: 'relay-frame-stale' });
        document.getElementById('fpsDisplay').textContent = '0 FPS';
        this.invalidateRelayInputProof('relay-frame-stale');
        this.updateNetworkUI(`JPEG 图像加载年龄 ${Math.round(age)} ms，等待新画面。`, 'warning');
      }
      this.armRelayFreshnessTimer(origin);
    }, Math.max(0, Math.min(...deadlines) - now));
  },

  renderRelayFeedbackRtt() {
    const el = document.getElementById('latencyDisplay');
    if (!el) return;
    const sample = this._relayRttView;
    const available = sample && performance.now() - sample.receivedAtMs < 5000;
    el.textContent = available ? `${Math.round(sample.value)} ms` : '未测量';
    el.title = 'JPEG反馈往返：TTL内且每间隔最新反馈样本，含解码、调度和回程；不代表单向或可见时延';
  },

  handleRelayFrameFeedback(data = {}) {
    const receivedAtMs = performance.now();
    if (data.relayFrameSchemaVersion !== 1 || !this.relayScopeMatches(data.relayScope)) return false;
    const counters = ['feedbackSequence', 'pendingCount', 'expiredCount', 'unmatchedAckCount', 'timeoutCount', 'coalescedCount'];
    if (!counters.every(k => Number.isSafeInteger(data[k]) && data[k] >= (k === 'feedbackSequence' ? 1 : 0))) return false;
    const ages = ['oldestPendingAgeMs', 'lastSentAgeMs', 'lastAckAgeMs'];
    if (!ages.every(k => data[k] === null || (typeof data[k] === 'number' && Number.isFinite(data[k]) && data[k] >= 0))) return false;
    if (data.feedbackSequence <= this._relayFeedbackSequence) return false;
    const sample = data.sample;
    if (sample !== null && (!sample || !Number.isSafeInteger(sample.sampleSequence) || sample.sampleSequence < 1
      || typeof sample.relayFrameAckRttMs !== 'number' || !Number.isFinite(sample.relayFrameAckRttMs)
      || sample.relayFrameAckRttMs < 0 || sample.relayFrameAckRttMs >= 2000)) return false;
    this._relayFeedbackSequence = data.feedbackSequence;
    this._relayFeedbackSummary = { relayScope: this._relayExpectedScope, receivedAtMs,
      ...Object.fromEntries([...counters, ...ages].map(k => [k, data[k]])) };
    if (sample && sample.sampleSequence > this._relaySampleSequence) {
      this._relaySampleSequence = sample.sampleSequence;
      if (this._relayOriginDigest && typeof LatencyMonitor !== 'undefined') {
        const accepted = LatencyMonitor.recordStage?.('relayFrameAckRttMs', sample.relayFrameAckRttMs,
          { scope: this.latencyScope(), atMs: receivedAtMs,
            sampleKey: `relay:${this._relayOriginDigest}:${sample.sampleSequence}` });
        if (accepted) this._relayRttView = { value: sample.relayFrameAckRttMs, receivedAtMs };
      }
    }
    this.renderRelayFeedbackRtt();
    this.armRelayFreshnessTimer(this._relayExpectedScope);
    return true;
  },

  startTunnelRelay({ allowResuming = false, sendRequest = true } = {}) {
    if (!this.hasActiveControl()) {
      this.requestControl({ allowTakeover: false });
      return false;
    }
    if (!this.canStartTunnelRelay({ allowResuming })) {
      return false;
    }
    if (!this.socket || !this.socket.connected) {
      return false;
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
      this.cancelDataChannelWatchdog();
      this.pc.close();
      this.pc = null;
    }
    this.stopMediaTelemetry();
    this.clearRelayOrigin();
    if (!sendRequest) this.invalidateRelayInputProof('relay-start');
    this._tunnelLockUntil = Date.now() + 30000;
    this.tunnelRelayActive = true;
    this._mediaRelayRevision = (Number(this._mediaRelayRevision) || 0) + 1;
    this.clearMediaResumeProof();
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
    if (sendRequest) this.emitRelayStreamControl({ allowResuming });
    return true;
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
    if (!mediaControl && enabled) {
      if (!this.bindCurrentConnectionAttempt()) return false;
      this.clearRelayOrigin();
      this.invalidateRelayInputProof('relay-start');
      const requestId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID() : `start-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${this._relayOriginToken}`;
      const mediaGeneration = this._mediaIntent?.generation ?? this.getMediaActivitySnapshot().generation ?? 0;
      payload.relayFrameSchemaVersion = 1;
      payload.relayStartRequestId = requestId;
      payload.connectionAttemptId = this.currentConnectionAttemptId;
      payload.relayMediaGeneration = mediaGeneration;
      this._relayPendingStart = { socket: this.socket, leaseId: lease.leaseId, leaseEpoch: lease.leaseEpoch,
        attempt: this.currentConnectionAttemptId, mediaGeneration, requestId };
      this.beginFirstFrameDeadline(this.currentConnectionAttemptId);
    }
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
    this.clearRelayOrigin();
    const lease = this.activeLeaseEnvelope();
    if (lease && this.socket?.connected && this.tunnelRelayActive) this.socket.emit('relay-stream-control', { ...lease, enabled: false });
    this.tunnelRelayActive = false;
    this._mediaRelayRevision = (Number(this._mediaRelayRevision) || 0) + 1;
    this.clearMediaResumeProof();
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
    if (data?.relayFrameSchemaVersion !== 1 || !this.relayScopeMatches(data.relayScope)) {
      if (data?.relayFrameSchemaVersion !== 1) this.updateNetworkUI('JPEG 来源尚未验证，请刷新页面并升级 Host。', 'warning');
      return;
    }
    const origin = this._relayExpectedScope;
    if (data?.connectionAttemptId
      && this.currentConnectionAttemptId
      && data.connectionAttemptId !== this.currentConnectionAttemptId) {
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
    if (!Number.isSafeInteger(data.frameId) || data.frameId < 1) return;
    const frameId = data.frameId;
    if (frameId <= this.tunnelLastFrameId) {
      return;
    }
    this.tunnelLastFrameId = frameId;

    const frameScope = this.mediaResumeScope();
    const imageToken = this._relayImageRequestToken = (this._relayImageRequestToken || 0) + 1;
    let loaded = false;
    const ackLoadedFrame = (objectUrl = '') => {
      if (loaded || imageToken !== this._relayImageRequestToken
        || !this.relayScopeMatches(origin) || !this.mediaResumeScopeMatches(frameScope)) {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        return;
      }
      loaded = true;
      this.noteRelayImageLoaded(origin);
      relayImage.classList.remove('hidden');
      document.getElementById('loading')?.classList.add('hidden');
      document.getElementById('loading')?.classList.remove('is-connecting');
      document.body.classList.add('stream-connected');
      this.hasPaintedFrame = true;
      this.setUiPhase('connected', { reason: 'tunnel-frame' });
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
      this.ensureDesktopSessionState()?.applyMedia({
        attemptId: this.currentConnectionAttemptId,
        event: 'fresh-frame',
        fresh: true,
      });
      this._lastRenderedRelayFrame = {
        frameId,
        frameSeq,
        connectionAttemptId: frameScope.connectionAttemptId,
        relayScope: origin,
        scope: frameScope,
      };
      this.observeFreshResumeFrame({
        scope: frameScope,
        source: 'relay-frame',
        frameSeq,
        connectionAttemptId: frameScope.connectionAttemptId,
      });
      this.armRelayFreshnessTimer(origin);
      const lease = this.activeLeaseEnvelope();
      if (lease && this.socket?.connected) {
        this.socket.emit('relay-frame-ack', {
          ...lease,
          frameId,
          relayFrameSchemaVersion: 1,
          relayScope: { ...origin }
        });
      }
      this.syncDesktopInputGate();
      this.clearFailureRecommendation();
      this.updateNetworkUI('隧道中继已连接。JPEG反馈往返包含转发、解码、调度及回程。', 'warning');
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
    // Keep the media element box mounted; only toggle visibility class. Media
    // readiness is committed by ackLoadedFrame after the image has loaded.
    relayImage.classList.remove('hidden');
    this.renderRelayFeedbackRtt();
    const candidateEl = document.getElementById('candidateDisplay');
    if (candidateEl) {
      candidateEl.textContent = '链路 tunnel';
    }
    if (data.width && data.height) {
      // Source resolution may adapt; viewport size stays stable via CSS contain.
      document.getElementById('resolutionDisplay').textContent = `tunnel (${data.width}x${data.height})`;
    }
  },
  
  async createOffer() {
    if (!this.startupAllowed() || this._deferPeerUntilConfig) return;
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
    const peer = this.pc;
    const socket = this.socket;
    if (!this.currentConnectionAttemptId) this.currentConnectionAttemptId = this.createConnectionAttemptId();
    const attemptId = this.currentConnectionAttemptId;
    const attemptSequence = Number(this.connectionAttemptSequence) || 1;
    const lease = Object.freeze({ ...this.controlState.lease });
    peer._wrdControlLease = lease;
    const startupEpisode = this._startupEpisode || null;
    const ownsOffer = () => epoch === this._offerEpoch && this.pc === peer
      && this.socket === socket && this.currentConnectionAttemptId === attemptId
      && (Number(this.connectionAttemptSequence) || 1) === attemptSequence
      && this.controlState?.lease?.leaseId === lease.leaseId
      && this.controlState?.lease?.leaseEpoch === lease.leaseEpoch && this.startupAllowed(startupEpisode);

    try {
      if (!ownsOffer()) return;
      const existingVideoTransceiver = peer.getTransceivers().find((transceiver) => {
        return transceiver.receiver?.track?.kind === 'video' || transceiver.mid === '0';
      });
      this.videoTransceiver = existingVideoTransceiver || this.videoTransceiver;
      if (!this.videoTransceiver) {
        this.videoTransceiver = peer.addTransceiver('video', { direction: 'recvonly' });
        this.preferH264(this.videoTransceiver);
      }

      const offer = await peer.createOffer();
      if (!ownsOffer()) return;
      await peer.setLocalDescription(offer);
      if (!ownsOffer()) return;
      if (this.networkMode === 'relay') {
        await this.waitForIceGatheringComplete(8000);
      }
      if (!ownsOffer()) return;

      console.log('[OFFER-DBG] Emitting offer: socketConnected=%s epoch=%d', this.socket.connected, epoch);
      const session = this.getSessionPresentation();
      socket.emit('offer', {
        offer: peer.localDescription,
        epoch,
        schemaVersion: 2,
        networkMode: this.networkMode,
        iceMode: this.networkMode,
        turnServerId: this.selectedTurnServerId || this.serverConfig?.selectedTurnServerId || undefined,
        leaseId: lease.leaseId,
        leaseEpoch: lease.leaseEpoch,
        connectionAttemptId: attemptId,
        connectionAttemptSequence: attemptSequence,
        width: session.width,
        height: session.height,
      });
      if (ownsOffer()) peer._wrdEmittedOffer = { socket, attemptId, attemptSequence };
      console.log('Offer sent (epoch=%d attempt=%s)', epoch, this.currentConnectionAttemptId);
    } catch (err) {
      if (!ownsOffer()) return;
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
    // A presentation change affects the H.264 bitrate envelope. Route it
    // through media-profile-change so Signal assigns a real profileSequence
    // and Host refreshes its session-scoped encoder policy atomically with
    // capture size. The legacy resolution-change path has no such admission.
    const controller = this.ensureLinkQualityController();
    const profileName = controller?.currentProfile || 'high';
    const selectedProfile = typeof LinkQualityController !== 'undefined'
      ? LinkQualityController.profiles?.[profileName]
      : null;
    const profile = selectedProfile ? {
      ...selectedProfile,
      // An explicit user presentation choice wins over an adaptive quality
      // profile's source dimensions. The profile still supplies its fps/rate
      // intent; applyMediaProfile owns the quality-lock floors.
      width: session.width,
      height: session.height,
    } : {
      name: profileName,
      width: session.width,
      height: session.height,
      fps: this.qualityFloorsForResolution(session.width, session.height).targetFps,
      bitrateKbps: this.qualityFloorsForResolution(session.width, session.height).minBitrateKbps,
    };
    const applied = this.applyMediaProfile(profile, 'presentation-change');
    if (!applied) return false;
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
    let returnFocus = null;
    const close = () => {
      modal.classList.add('hidden');
      modal.hidden = true;
      const target = returnFocus;
      returnFocus = null;
      if (target && typeof target.focus === 'function') target.focus();
    };
    const open = () => {
      returnFocus = root?.activeElement || null;
      modal.classList.remove('hidden');
      modal.hidden = false;
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
    } else {
      // A dead socket cannot carry a refresh request. Re-enter the normal init
      // path so it recreates signaling and continues through the connect flow.
      this.quiesceDisconnectedSocket();
      this.init({ trigger: 'manual-mode-switch' });
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

    // Network guidance is meaningful only once a connection attempt has
    // reached a session phase.  Boot-time config and mode updates must not
    // place a diagnostic card over the landing CTA.
    const advisorPhaseVisible = ['connected', 'media-stalled', 'disconnected'].includes(this.uiPhase);
    if (advisor && !advisorPhaseVisible) {
      this.clearNetworkAdvisorCollapseTimer();
      advisor.classList.remove('visible', 'collapsed', 'warning', 'danger');
      advisor.hidden = true;
      advisor.setAttribute('aria-hidden', 'true');
      advisor.setAttribute('aria-expanded', 'false');
      this._networkAdvisorLastSignature = '';
      this._networkAdvisorSeverity = '';
    }

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
    if (!advisorPhaseVisible) {
      // Keep mode/turn status synchronized above, but leave the advisor out
      // of the idle, signaling, and first-frame landing states.  The caller
      // will render the same content once a real session phase is reached.
      return;
    }

    const recommendation = this.recommendationState;
    const genericMessage = message === '网络模式已就绪' || message === '网络模式已切换，正在重连...';
    const baseMessage = (!message || genericMessage)
      ? (this.getDefaultNetworkGuidance() || message || mode.hint)
      : message;
    // Keep local URLs, candidate addresses, and transport implementation
    // names in the network/diagnostic panels.  The compact advisor speaks in
    // terms of the current path, suggested action, and reason.
    const detail = [baseMessage, this.getRecommendationMessage()].filter(Boolean).join(' ');
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
    advisor.hidden = false;
    advisor.setAttribute('aria-hidden', 'false');
    advisor.classList.add('visible');

    const narrow = typeof matchMedia === 'function' && matchMedia('(max-width: 768px)').matches;
    const meaningfulWarning = effectiveSeverity === 'warning' || effectiveSeverity === 'danger';
    const shouldExpand = ((firstShow && meaningfulWarning)
      || severityUp
      || (meaningfulChange && (effectiveSeverity === 'warning' || effectiveSeverity === 'danger'
        || genericMessage || !message
        || /失败|不可用|切换|重连|建议|耗尽|超时|中断/.test(String(baseMessage || '')))))
      && !(narrow && (effectiveSeverity === 'info' || effectiveSeverity === ''));

    if (shouldExpand) {
      this._networkAdvisorPinned = false;
      this.expandNetworkAdvisor({ reschedule: true });
    } else if (firstShow) {
      // A healthy first connected update is a compact status chip.  Only a
      // warning/danger or an explicit user interaction opens the full card.
      this.collapseNetworkAdvisor();
    } else if (narrow && (effectiveSeverity === 'info' || effectiveSeverity === '')) {
      this.collapseNetworkAdvisor();
    } else if (!advisor.classList.contains('collapsed') && !this._networkAdvisorHover && !this._networkAdvisorPinned) {
      // Content refreshed while expanded — arm idle collapse only if not already running.
      if (!this._networkAdvisorCollapseTimer) {
        this.scheduleNetworkAdvisorCollapse();
      }
    }
  },
  
  startStats({ preserveConnection = false } = {}) {
    if (!this.pc || typeof WebRtcStats === 'undefined') return;
    if (this._statsSampler && this._statsPc !== this.pc) {
      if (this._statsOwner) this._statsOwner.retired = true;
      this._statsSampler.stop();
      this._statsSampler = null;
      this._statsPc = null;
    }
    if (!this._statsSampler) {
      const pc = this.pc;
      const owner = this._statsOwner = this.captureStartupOwner();
      this._statsPc = pc;
      if (!preserveConnection) {
        this.syncLinkQualityPath({ applyProfile: false, reason: 'stats-start' });
        this.ensureLinkQualityController()?.beginConnection?.();
      }
      this._statsSampler = WebRtcStats.createWebRtcStatsSampler({
        getStats: () => pc.getStats(),
        intervalMs: 1000,
        onSample: (snapshot) => { if (this.ownsStartupOwner(owner)) this.processStatsSnapshot(snapshot); },
        onError: (error) => { if (this.ownsStartupOwner(owner)) console.warn('[STATS] getStats failed:', error?.message || error); },
      });
    }
    this._statsSampler.start();
  },

  stopVideoFrameTracking() {
    if (this._videoFrameOwner) this._videoFrameOwner.retired = true;
    const video = this._videoFrameElement;
    if (video && this._videoFrameCallbackId != null
        && typeof video.cancelVideoFrameCallback === 'function') {
      video.cancelVideoFrameCallback(this._videoFrameCallbackId);
    }
    this._videoFrameCallbackId = null;
    this._videoFrameElement = null;
    this._paintObservationWindow = null;
    this._lastPaintObservation = null;
  },

  startVideoFrameTracking() {
    this.stopVideoFrameTracking();
    const video = document.getElementById('remoteVideo');
    if (!video || typeof video.requestVideoFrameCallback !== 'function') return;
    const attemptId = this.currentConnectionAttemptId || null;
    const trackedPc = this.pc || null;
    const startupOwner = this._videoFrameOwner = this.captureStartupOwner();
    this._videoFrameElement = video;
    const onFrame = (now, metadata) => {
      if (!this.ownsStartupOwner(startupOwner) || this._videoFrameElement !== video
          || this.currentConnectionAttemptId !== attemptId
          || this.pc !== trackedPc) return;
      if (Number(video.videoWidth || 0) > 0) {
        this.hasPaintedFrame = true;
        this._stallSince = null;
      }
      this._videoFrameSeq = (Number(this._videoFrameSeq) || 0) + 1;
      if (!this.markMediaAttemptReady(attemptId)) return;
      this.ensureDesktopSessionState()?.applyMedia({
        attemptId,
        event: 'fresh-frame',
        fresh: true,
      });
      if (typeof LatencyMonitor !== 'undefined') {
        LatencyMonitor.onVideoFrame(now, metadata);
      }
      const identity = this.verifiedVideoFrameIdentity(trackedPc, video, metadata);
      if (identity) {
        if (this._frameTraceEnabled || this._controlledSceneMarkerRoi || this._lossLabTrace) {
          this.ensureFrameTraceCollector().observeVideoFrame(identity,
            { metadata, marker: this.decodeControlledMarkerFromVideo(video) }, now);
        }
        this.ensureInputFrameCollector()?.observeVideoFrame(identity, {}, now);
        this.consumeInputFrameMatches();
      }
      this.recordLossLabRvfc(metadata, video);
      this.consumeControlledVisibleEffects();
      this.observePaintFrame(now, metadata, video);
      this.observeFreshResumeFrame({
        source: 'video-callback',
        frameSeq: this._videoFrameSeq,
        connectionAttemptId: attemptId,
        pc: trackedPc,
      });
      this._videoFrameCallbackId = video.requestVideoFrameCallback(onFrame);
    };
    this._videoFrameCallbackId = video.requestVideoFrameCallback(onFrame);
  },

  currentFrameTraceIdentity() {
    return {
      attemptId: this.currentConnectionAttemptId || null,
      generation: Number(this.connectionAttemptSequence) || 0,
      streamId: 'video',
    };
  },

  configureControlledSceneMarkerRoi(roi) {
    const fields = ['x', 'y', 'width', 'height'];
    if (!roi || fields.some((field) => !Number.isSafeInteger(roi[field]))
        || roi.x <= 0 || roi.y <= 0 || roi.width !== 256 || roi.height !== 128) {
      this._controlledSceneMarkerRoi = null;
      return false;
    }
    this._controlledSceneMarkerRoi = { x: roi.x, y: roi.y, width: roi.width, height: roi.height };
    return true;
  },

  decodeControlledMarkerFromVideo(video) {
    const roi = this._controlledSceneMarkerRoi;
    const width = Number(video?.videoWidth || 0), height = Number(video?.videoHeight || 0);
    if (!roi || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
        || roi.x + roi.width > width || roi.y + roi.height > height) return null;
    try {
      const canvas = this._controlledMarkerCanvas || document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return null;
      context.drawImage(video, 0, 0, width, height);
      this._controlledMarkerCanvas = canvas;
      return decodeControlledMarkerRgba(context.getImageData(roi.x, roi.y, roi.width, roi.height).data, roi.width, roi.height);
    } catch (_error) {
      return null;
    }
  },

  verifiedVideoFrameIdentity(pc, video, metadata) {
    if (!pc || pc !== this.pc || typeof pc.getReceivers !== 'function') return null;
    const tracks = video?.srcObject?.getVideoTracks?.() || [];
    const receivers = pc.getReceivers().filter(r => r.track?.kind === 'video' && tracks.some(t => t.id === r.track.id));
    if (receivers.length !== 1) return null;
    const sources = [...new Set((receivers[0].getSynchronizationSources?.() || []).map(s => s.source))];
    if (sources.length !== 1 || !Number.isSafeInteger(sources[0])) return null;
    return { ...this.currentFrameTraceIdentity(), ssrc: sources[0], rtpTimestamp: metadata?.rtpTimestamp };
  },

  ensureInputFrameCollector() {
    if (this.serverConfig?.inputFrameCorrelationVersion !== 1 || typeof LatencyMonitor === 'undefined'
        || !LatencyMonitor.hasPendingFrameInputs?.()) { this.inputFrameCollector = null; return null; }
    const scope = this.latencyScope(), key = JSON.stringify(scope);
    if (!this.inputFrameCollector || this._inputFrameScope !== key) {
      this.inputFrameCollector = new FrameTraceCollector(); this._inputFrameScope = key;
      this.inputFrameCollector.setScope({ attemptId: scope.connectionAttemptId, generation: scope.generation, streamId: 'video' });
    }
    return this.inputFrameCollector;
  },

  consumeInputFrameMatches() {
    for (const row of this.inputFrameCollector?.takeMatched() || []) {
      if (typeof LatencyMonitor !== 'undefined') LatencyMonitor.onPostApplyFrame?.(row, { scope: this.latencyScope() });
    }
  },

  consumeControlledVisibleEffects() {
    if (!this._controlledSceneMarkerRoi || typeof LatencyMonitor === 'undefined') return;
    for (const row of this.frameTraceCollector?.takeControlledVisualEvidence() || []) {
      LatencyMonitor.onVisibleEffect?.(row, { scope: this.latencyScope() });
    }
  },

  ensureFrameTraceCollector(scope = this.currentFrameTraceIdentity()) {
    if (!this.frameTraceCollector) this.frameTraceCollector = new FrameTraceCollector();
    this.frameTraceCollector.setScope(scope);
    return this.frameTraceCollector;
  },

  acceptFrameTraceBatch(batch) {
    this._frameTraceEnabled = true;
    return this.ensureFrameTraceCollector().acceptBatch(batch);
  },

  getFrameTraceDiagnostics() {
    return this.ensureFrameTraceCollector().diagnostics();
  },

  requestLossLabHostSelectedPair() {
    const channel = this.inputChannel;
    if (!channel || channel.readyState !== 'open') return Promise.reject(new Error('Lab input channel is unavailable'));
    if (this._lossLabHostPairPromise) return this._lossLabHostPairPromise;
    this._lossLabHostPairPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this._lossLabHostPairPromise = null; reject(new Error('Host selected pair acknowledgement timed out')); }, 2000);
      this._lossLabHostPairResolve = (value) => { clearTimeout(timeout); this._lossLabHostPairPromise = null; this._lossLabHostPairResolve = null; resolve(value); };
      try { channel.send(JSON.stringify({ type: 'loss_lab_selected_pair_request', schemaVersion: 1 })); }
      catch (error) { clearTimeout(timeout); this._lossLabHostPairPromise = null; this._lossLabHostPairResolve = null; reject(error); }
    });
    return this._lossLabHostPairPromise;
  },

  beginLossLabTrace() {
    // Only an isolated Lab origin may enable detailed packet diagnostics.
    if (!/^http:\/\/(127\.0\.0\.1|\[::1\]):\d+$/.test(String(window?.location?.origin || ''))) return false;
    const epoch = Number(this._lossLabTrace?.tapEpoch || 0) + 1;
    const channel = this.inputChannel;
    if (!channel || channel.readyState !== 'open') return false;
    this._lossLabTrace = { host: [], rvfc: [], droppedHostEvents: 0, staleHostEvents: 0, tapEpoch: epoch, sourceSeq: 0,
      // `sourceWatermark` is supplied by Host after it atomically clears its
      // queue.  Only later source sequences may enter this epoch.
      flushAck: null };
    try {
      channel.send(JSON.stringify({ type: 'loss_lab_trace_begin', schemaVersion: 1, epoch }));
    } catch (_error) {
      this._lossLabTrace = null;
      return false;
    }
    return true;
  },

  _appendLossLabTrace(kind, row) {
    const trace = this._lossLabTrace;
    if (!trace || !row || typeof row !== 'object') return false;
    const entries = trace[kind];
    if (!Array.isArray(entries)) return false;
    if (entries.length >= 512) entries.shift();
    trace.sourceSeq += 1;
    entries.push({ ...row, sourceSeq: trace.sourceSeq, barrierEpoch: trace.tapEpoch });
    return true;
  },

  recordLossLabRvfc(metadata, video) {
    if (!this._lossLabTrace) return false;
    const rtpTimestamp = Number(metadata?.rtpTimestamp);
    if (!Number.isFinite(rtpTimestamp)) return false;
    const matched = this.frameTraceCollector?.latestMatchedForRtp?.(rtpTimestamp);
    // A loss paint is useful only when it is exactly the T3 frame row that
    // crossed the wire.  Never manufacture a viewer-only frame identity.
    if (!matched || matched.traceStatus !== 'matched') return false;
    return this._appendLossLabTrace('rvfc', {
      attemptId: matched.attemptId, generation: matched.generation, streamId: matched.streamId,
      captureSeq: matched.captureSeq, wireTimestamp: matched.wireTimestamp,
      rtpTimestamp: matched.rtpTimestamp, presentedFrames: Number(metadata?.presentedFrames) || 0,
      // This is intentionally a Viewer-only acceptance clock.  It is never
      // compared to Host monotonic time.
      viewerAcceptedMs: Number(performance.now()), pcId: this.pc ? `viewer-pc-${String(this.pc.__wrdLabTraceId || (this.pc.__wrdLabTraceId = Math.random().toString(36).slice(2)))}` : '',
      resolution: { width: Number(video?.videoWidth) || 0, height: Number(video?.videoHeight) || 0 },
    });
  },

  acceptLossLabHostTraceBatch(batch) {
    const trace = this._lossLabTrace;
    if (!trace || !batch || batch.type !== 'loss_lab_host_trace_batch' || batch.schemaVersion !== 1
        || !Number.isSafeInteger(batch.tapEpoch) || batch.tapEpoch !== trace.tapEpoch
        || !Array.isArray(batch.events) || batch.events.length > 64
        || !Number.isSafeInteger(batch.droppedEventCount) || batch.droppedEventCount < 0) return false;
    trace.droppedHostEvents += batch.droppedEventCount;
    for (const event of batch.events) {
      if (!event || typeof event !== 'object' || !['rtcp_feedback', 'encoder_idr', 'rtp_send', 'pc_state'].includes(event.type)
          || event.tapEpoch !== trace.tapEpoch || !Number.isSafeInteger(event.sourceSeq)
          || !Number.isSafeInteger(event.monotonicNs) || event.monotonicNs < 0) return false;
      if (!trace.flushAck || event.sourceSeq <= trace.flushAck.sourceWatermark) {
        trace.staleHostEvents += 1;
        continue;
      }
      this._appendLossLabTrace('host', event);
    }
    return true;
  },

  acceptLossLabFlushAck(ack) {
    const trace = this._lossLabTrace;
    if (!trace || !ack || ack.type !== 'loss_lab_trace_flush_ack' || ack.schemaVersion !== 1
        || ack.epoch !== trace.tapEpoch || !Number.isSafeInteger(ack.sourceWatermark)
        || ack.sourceWatermark < 0) {
      if (trace) trace.staleHostEvents += 1;
      return false;
    }
    trace.flushAck = { epoch: ack.epoch, accepted: true, sourceWatermark: ack.sourceWatermark };
    return true;
  },

  async takeLossLabTraceSnapshot() {
    const trace = this._lossLabTrace;
    if (!trace || !this.pc?.getStats) return null;
    const rows = [...(await this.pc.getStats()).values()];
    const pair = rows.find((row) => row?.type === 'candidate-pair' && (row.selected === true || row.nominated === true) && row.state === 'succeeded');
    const local = pair ? rows.find((row) => row?.id === pair.localCandidateId && row.type === 'local-candidate') : null;
    const inbound = rows.find((row) => row?.type === 'inbound-rtp' && (row.kind === 'video' || row.mediaType === 'video'));
    if (!pair || !local || local.candidateType !== 'relay' || !inbound) return null;
    if (!trace.flushAck) return null;
    const result = { host: trace.host.splice(0), rvfc: trace.rvfc.splice(0), droppedHostEvents: trace.droppedHostEvents, staleHostEvents: trace.staleHostEvents, tapEpoch: trace.tapEpoch, flushAck: trace.flushAck,
      stats: { pcId: `viewer-pc-${String(this.pc.__wrdLabTraceId || (this.pc.__wrdLabTraceId = Math.random().toString(36).slice(2)))}`,
        state: String(this.pc.connectionState || ''), selectedRelay: { address: local.address, port: local.port, protocol: local.protocol },
        inbound: { packetsReceived: Number(inbound.packetsReceived) || 0, packetsLost: Number(inbound.packetsLost) || 0,
          jitter: Number(inbound.jitter) || 0, width: Number(inbound.frameWidth) || 0, height: Number(inbound.frameHeight) || 0 } } };
    trace.droppedHostEvents = 0;
    return result;
  },

  observePaintFrame(now, metadata = {}, video) {
    const paintAt = Number(now);
    if (!Number.isFinite(paintAt)) return null;
    const rect = typeof video?.getBoundingClientRect === 'function'
      ? video.getBoundingClientRect()
      : {};
    const geometry = {
      x: Number(rect?.x ?? rect?.left ?? 0),
      y: Number(rect?.y ?? rect?.top ?? 0),
      width: Number(rect?.width ?? 0),
      height: Number(rect?.height ?? 0),
    };
    let window = this._paintObservationWindow;
    if (!window) {
      window = {
        connectionAttemptId: this.currentConnectionAttemptId || null,
        startedAt: paintAt,
        lastPaintAt: paintAt,
        intervals: [],
        maxGapMs: 0,
        firstPresentedFrames: Number(metadata.presentedFrames),
        lastPresentedFrames: Number(metadata.presentedFrames),
        video: { width: Number(video?.videoWidth || 0), height: Number(video?.videoHeight || 0) },
        geometry,
        geometryChanges: 0,
      };
      this._paintObservationWindow = window;
      return null;
    }
    const gap = Math.max(0, paintAt - window.lastPaintAt);
    window.intervals.push(gap);
    window.maxGapMs = Math.max(window.maxGapMs, gap);
    window.lastPaintAt = paintAt;
    const presentedFrames = Number(metadata.presentedFrames);
    if (Number.isFinite(presentedFrames)) window.lastPresentedFrames = presentedFrames;
    window.video = { width: Number(video?.videoWidth || 0), height: Number(video?.videoHeight || 0) };
    if (["x", "y", "width", "height"].some((key) => geometry[key] !== window.geometry[key])) {
      window.geometry = geometry;
      window.geometryChanges += 1;
    }
    if (paintAt - window.startedAt < 5000) return null;
    const intervals = window.intervals.slice().sort((a, b) => a - b);
    const percentile = (fraction) => intervals.length
      ? intervals[Math.max(0, Math.min(intervals.length - 1, Math.ceil(intervals.length * fraction) - 1))]
      : 0;
    const firstPresented = Number(window.firstPresentedFrames);
    const lastPresented = Number(window.lastPresentedFrames);
    this._lastPaintObservation = {
      connectionAttemptId: window.connectionAttemptId,
      intervalMs: {
        p50: percentile(0.5),
        p95: percentile(0.95),
        max: intervals.length ? intervals.at(-1) : 0,
      },
      maxGapMs: window.maxGapMs,
      presentedFramesDelta: Number.isFinite(firstPresented) && Number.isFinite(lastPresented)
        ? Math.max(0, lastPresented - firstPresented) : 0,
      video: window.video,
      geometry: { ...window.geometry, changes: window.geometryChanges },
    };
    console.info('[WRD_PAINT_SAMPLE]', this._lastPaintObservation);
    this._paintObservationWindow = {
      connectionAttemptId: window.connectionAttemptId,
      startedAt: paintAt,
      lastPaintAt: paintAt,
      intervals: [],
      maxGapMs: 0,
      firstPresentedFrames: lastPresented,
      lastPresentedFrames: lastPresented,
      video: window.video,
      geometry: window.geometry,
      geometryChanges: 0,
    };
    return this._lastPaintObservation;
  },

  stopMediaTelemetry() {
    if (this._statsOwner) this._statsOwner.retired = true;
    if (this._statsSampler) this._statsSampler.stop();
    this._statsSampler = null;
    this._statsPc = null;
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    this.stopVideoFrameTracking();
  },

  nullableMediaLatency(value) {
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  },

  canonicalMediaStats(stats = {}) {
      const number = (canonical, legacy) => Number(stats[canonical] ?? stats[legacy] ?? 0) || 0;
      return {
        ...stats,
        rttMs: this.nullableMediaLatency(stats.rttMs),
        jitterBufferMs: this.nullableMediaLatency(stats.jitterBufferMs),
        derivedFps: number('derivedFps', 'fps'),
        receivedDelta: number('receivedDelta', 'framesReceived'),
        decodedDelta: number('decodedDelta', 'framesDecoded'),
        packetsLostDelta: number('packetsLostDelta', 'packetsLost'),
        bytesDelta: number('bytesDelta', 'bytesReceived'),
        framesDroppedDelta: number('framesDroppedDelta', 'framesDropped'),
        packetsReceivedDelta: number('packetsReceivedDelta', 'packetsReceived'),
        nackCountDelta: number('nackCountDelta', 'nackCount'),
        pliCountDelta: number('pliCountDelta', 'pliCount'),
        firCountDelta: number('firCountDelta', 'firCount'),
        freezeDelta: number('freezeDelta', 'freezeCount'),
        warmup: stats.warmup === true,
      };
  },

  processStatsSnapshot(stats = {}) {
      const canonical = this.canonicalMediaStats(stats);
      const fps = canonical.derivedFps;
      const latencyMs = canonical.rttMs;
      const jitterBufferDelay = canonical.jitterBufferMs;
      const framesReceived = canonical.receivedDelta;
      const framesDecoded = canonical.decodedDelta;
      const packetsLost = canonical.packetsLostDelta;
      const bytesReceived = canonical.bytesDelta;
      const framesDropped = canonical.framesDroppedDelta;
      const packetsReceived = canonical.packetsReceivedDelta;
      const nackCount = canonical.nackCountDelta;
      const pliCount = canonical.pliCountDelta;
      const firCount = canonical.firCountDelta;
      const freezeCount = canonical.freezeDelta;
      const codec = String(stats.codec || '');
      const selectedCandidateType = String(stats.selectedCandidateType || '');
      if (framesDecoded > 0) {
        const totalsDecoded = Number(stats.totals?.framesDecoded);
        this._lastInboundFramesDecoded = Number.isFinite(totalsDecoded)
          ? totalsDecoded
          : Number(stats.framesDecoded ?? framesDecoded) || 0;
        // Each positive delta is progress, even when smaller than the prior interval.
        this._lastInboundFramesDecodedAt = performance.now();
      }
      this.selectedCandidatePair = stats.selectedCandidatePair ? {
        ...stats.selectedCandidatePair,
        rttMs: this.nullableMediaLatency(stats.selectedCandidatePair.rttMs),
      } : {
        localType: '', remoteType: '', protocol: '', localAddress: '', remoteAddress: '',
        localAddressFamily: '', remoteAddressFamily: '', rttMs: null,
      };

      const fpsEl = document.getElementById('fpsDisplay');
      if (fpsEl) fpsEl.textContent = `${Math.round(fps)} FPS`;
      const latencyEl = document.getElementById('latencyDisplay');
      if (latencyEl) {
        const labels = [];
        const descriptions = [];
        if (latencyMs !== null) {
          labels.push(`RTT ${Math.round(latencyMs)} ms`);
          descriptions.push(`网络 RTT ${Math.round(latencyMs)} ms`);
        }
        if (jitterBufferDelay !== null) {
          labels.push(`缓冲 ${Math.round(jitterBufferDelay)} ms`);
          descriptions.push(`播放缓冲 ${Math.round(jitterBufferDelay)} ms`);
        }
        latencyEl.textContent = labels.join(' · ') || '未测量';
        latencyEl.title = descriptions.join('；') || '未测量';
      }
      const candidateEl = document.getElementById('candidateDisplay');
      const portSearchStatus = this.portSearchController?.snapshot?.()?.status || null;
      const portSearchOwnsDisplay = portSearchStatus === 'searching'
        || portSearchStatus === 'succeeded'
        || portSearchStatus === 'exhausted';
      if (candidateEl && !portSearchOwnsDisplay) {
        const linkLabel = selectedCandidateType === 'relay' ? 'TURN中继' : selectedCandidateType === 'srflx' || selectedCandidateType === 'prflx' ? 'STUN直连' : selectedCandidateType === 'host' ? '本地直连' : selectedCandidateType || '-';
        candidateEl.textContent = `当前链路：${linkLabel}${latencyMs !== null ? ` · ${latencyMs} ms` : ''}`;
      }
      this.lastCandidateType = selectedCandidateType || '';
      if (this.networkMode === 'relay' || selectedCandidateType === 'relay') {
        if (fps === 0 && framesReceived > 0) {
          console.warn('[MEDIA] relay freeze-second: dropped=%s pli=%s freeze=%s',
            framesDropped, pliCount, freezeCount);
        }
        const receivers = this.pc?.getReceivers?.() || [];
        receivers.forEach((receiver) => this.configureVideoReceiver(receiver));
      }
      this.handlePortSearchMedia({
        selectedCandidateType,
        framesDecoded,
        fps,
      });

      if (canonical.warmup || this.isMediaHealthSuppressed()) {
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
          framesDecoded: Number(stats.totals?.framesDecoded ?? this._lastInboundFramesDecoded),
          connectionAttemptId: this.currentConnectionAttemptId || null,
          pc: this.pc || null,
        });
      }

      if (canonical.warmup || this.isMediaHealthSuppressed()) {
        // Intentional suspension must not trigger degraded quality recovery.
      } else if (selectedCandidateType === 'relay') {
        if (!this.shouldPreservePaintIssueAdvisor()) {
          this.clearFailureRecommendation();
          this.updateNetworkUI(`当前通过 TURN 中继传输。RTT ${latencyMs !== null ? latencyMs : '未测量'} ms，适合受限外网但延迟会高于本地直连。`);
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
          this.updateNetworkUI(`当前为本地/直连链路。RTT ${latencyMs !== null ? latencyMs : '未测量'} ms，这是最低延迟路径。`);
        }
      } else if (selectedCandidateType === 'srflx' || selectedCandidateType === 'prflx') {
        if (!this.shouldPreservePaintIssueAdvisor()) {
          this.clearFailureRecommendation();
          this.updateNetworkUI(`当前为外网穿透直连。RTT ${latencyMs !== null ? latencyMs : '未测量'} ms；若画面不稳定可切换外网中继。`);
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

      console.log(`[STATS] DerivedFPS=${fps.toFixed(1)}, RTT=${latencyMs !== null ? `${latencyMs}ms` : 'unavailable'}, Jitter=${jitterBufferDelay !== null ? `${jitterBufferDelay}ms` : 'unavailable'}, ` +
                  `Codec=${codec || 'unknown'}, Candidate=${selectedCandidateType || 'unknown'}, ` +
                  `RecvDelta=${framesReceived}, DecodedDelta=${framesDecoded}, LostDelta=${packetsLost}, ` +
                  `Dropped=${framesDropped}, Packets=${packetsReceived}, NACK=${nackCount}, ` +
                  `PLI=${pliCount}, FIR=${firCount}, Freeze=${freezeCount}, ` +
                  `BytesDelta=${(bytesReceived/1024).toFixed(1)}KiB`);
      if (this.selectedCandidatePair?.localType || this.selectedCandidatePair?.remoteType) {
        console.log('[NETWORK] Selected candidate pair:', this.selectedCandidatePair);
      }

      if (typeof LatencyMonitor !== 'undefined' && typeof LatencyMonitor.onMediaStats === 'function') {
        LatencyMonitor.onMediaStats({ ...stats, rttMs: latencyMs, jitterBufferMs: jitterBufferDelay });
      }

      if (!canonical.warmup && !this.isMediaHealthSuppressed()) {
        this.handleReceiverStats({
          ...canonical,
          interval: true,
          rttMs: latencyMs,
          jitterBufferMs: jitterBufferDelay,
          codec,
          selectedCandidateType,
        });
      }

      if (this.socket && this.socket.connected) {
        this.socket.emit('viewer-stats', {
          derivedFps: fps,
          browserReportedFps: Number(stats.browserReportedFps || 0),
          rttMs: latencyMs,
          jitterBufferMs: jitterBufferDelay,
          receivedDelta: framesReceived,
          decodedDelta: framesDecoded,
          packetsLostDelta: packetsLost,
          bytesDelta: bytesReceived,
          framesDroppedDelta: framesDropped,
          packetsReceivedDelta: packetsReceived,
          nackCountDelta: nackCount,
          pliCountDelta: pliCount,
          firCountDelta: firCount,
          freezeDelta: freezeCount,
          warmup: canonical.warmup,
          mediaHealthSuppressed: this.isMediaHealthSuppressed(),
          connectionAttemptId: this.currentConnectionAttemptId || '',
          connectionAttemptSequence: Number(this.connectionAttemptSequence) || 0,
          generation: Number(this.connectionAttemptSequence) || 0,
          codec,
          selectedCandidateType,
          // Host log parsing still expects the pre-canonical keys. Keep aliases
          // only at this outbound boundary and bind them to the derived deltas.
          fps,
          framesReceived,
          framesDecoded,
          packetsLost,
          bytesReceived,
          framesDropped,
          packetsReceived,
          nackCount,
          pliCount,
          firCount,
          freezeCount,
        });
      }

      const videoEl = document.getElementById('remoteVideo');
      this.notePaintStats({
        ...canonical,
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
    renderViewerChromeClass(document.getElementById('reconnectHud'), 'hidden', true);
    renderViewerChromeClass(document.getElementById('lastFrameHold'), 'hidden', true);
  },

  RECOVERY_REFRESH_COOLDOWN_MS: 3000,
  clearRefreshDcWaitTimer() {
    if (this._refreshDcWaitTimer != null) {
      clearTimeout(this._refreshDcWaitTimer);
      this._refreshDcWaitTimer = null;
    }
  },
  isForcedRefreshReason(reason) {
    return reason == null
      || reason === 'manual'
      || reason === 'manual-mode-switch'
      || reason === 'manual-turn-switch';
  },
  canBeginRefresh(reason) {
    if (this._refreshing && !this.isForcedRefreshReason(reason)) {
      console.warn('[RECOVERY] Suppressing refresh while another refresh is in progress reason=%s', reason);
      return false;
    }
    if (this.isForcedRefreshReason(reason)) return true;
    if (Number.isFinite(this._lastRefreshAt)
      && performance.now() - this._lastRefreshAt < this.RECOVERY_REFRESH_COOLDOWN_MS) {
      console.warn('[RECOVERY] Suppressing refresh reason=%s', reason);
      return false;
    }
    return true;
  },

  markRefreshSettled(_reason) {
    this.clearRefreshDcWaitTimer();
    if (this._refreshSettleTimer) {
      clearTimeout(this._refreshSettleTimer);
      this._refreshSettleTimer = null;
    }
    this._refreshing = false;
    this.hideReconnectHud();
  },

  clearSignalingRecovery() {
    if (this._signalRecoveryTimer != null) {
      clearTimeout(this._signalRecoveryTimer);
      this._signalRecoveryTimer = null;
    }
    this._signalRecoveryStartedAt = null;
    this._signalRecoveryPending = false;
  },

  transferRetainedStartupPeer() {
    // A surviving initial PC keeps its attempt and all elapsed budgets. Its
    // producers still need fresh socket ownership; mutating old owner records
    // would incorrectly authorize callbacks already queued before recovery.
    if (!this.startupPending() || this._peerCallbackOwner?.socket === this.socket) return;
    for (const owner of [this._peerCallbackOwner, this._statsOwner, this._videoFrameOwner]) {
      if (owner) owner.retired = true;
    }
    for (const key of ['_iceDisconnectedTimer', '_disconnectedTimer']) {
      if (this[key] != null) clearTimeout(this[key]);
      this[key] = null;
    }
    this.bindPeerCallbacks();
    if (this.remoteStream) this.bindRemoteVideoCallbacks(this._peerCallbackOwner, { observeCurrent: false });
    this.bindInputChannelCallbacks();
    const watchdog = this._dataChannelWatchdog;
    if (watchdog) {
      if (watchdog.timer != null) clearTimeout(watchdog.timer);
      // Copy the deadline/phase/extensions, never restart a DC allowance.
      const current = this._dataChannelWatchdog = { ...watchdog, socket: this.socket, timer: null };
      this.checkDataChannelWatchdog(current);
    }
    if (this._dcReconnectTimer != null) {
      clearTimeout(this._dcReconnectTimer);
      this.scheduleDataChannelRecovery(this._inputChannelOwner, this.inputChannel,
        this._dcReconnectReason, this._dcReconnectDeadline);
    }
    if (this._statsSampler) this._statsSampler.stop();
    this._statsSampler = null;
    this._statsPc = null;
    this.startStats({ preserveConnection: true });
    this.startVideoFrameTracking();
    this.armStableRecoveryReset();
  },

  handleSignalingRecoveryConnected() {
    if (!this.startupAllowed()) return false;
    if (!this._signalRecoveryPending || this.manualDisconnect || this._superseded) return false;
    this.clearSignalingRecovery();

    // The peer may have survived the signaling outage. Reuse it when media is
    // still moving so reconnecting the control plane does not cause a visible
    // black frame. A stale/closed peer gets a fresh attempt and offer.
    const pcState = this.pc?.connectionState;
    const peerHealthy = pcState === 'connected'
      && (this.isInboundVideoHealthy(5000) || this.hasPaintedFrame === true);
    if (!peerHealthy || !this.pc || ['failed', 'closed', 'disconnected'].includes(pcState)) {
      this.refresh({ reason: 'signal-reconnected' });
      return true;
    }

    this.transferRetainedStartupPeer();

    // The disconnect handler moves the paint gate to `disconnected`, and the
    // socket connect handler moves it to `signaling`.  When the existing peer
    // is still carrying media there may be no new frame to trigger the normal
    // paint transition, so restore the visible phase explicitly. This also
    // re-enables desktop input for the surviving painted attempt.
    this.setUiPhase(this.hasPaintedFrame ? 'connected' : 'media-pending', {
      reason: 'signal-reconnected',
    });
    this.ensureMediaActiveIfVisible('signal-reconnected');
    this.replayMediaActivityIntent('signal-reconnected');
    this.rebindActiveKeyboardLease('signal-reconnected');
    this.syncDesktopInputGate();
    return true;
  },

  scheduleSignalingRecovery(reason = 'signal-disconnected') {
    if (!this.startupAllowed()) return false;
    if (this.manualDisconnect || this._superseded) return false;
    this._signalRecoveryPending = true;
    if (this._signalRecoveryStartedAt == null) this._signalRecoveryStartedAt = performance.now();
    if (this._signalRecoveryTimer != null) return true;

    const elapsed = performance.now() - this._signalRecoveryStartedAt;
    const remaining = Math.max(0, this.SIGNAL_RECOVERY_MAX_WAIT_MS - elapsed);
    const delay = Math.min(this.SIGNAL_RECOVERY_RETRY_MS, remaining || this.SIGNAL_RECOVERY_RETRY_MS);
    const episode = this._startupEpisode || null;
    const recoverySocket = this.socket;
    const recoveryTimer = setTimeout(() => {
      // A cancelled callback may already be queued; only its own handle can
      // retire or act, never a successor socket's freshly armed watchdog.
      if (this._signalRecoveryTimer !== recoveryTimer) return;
      this._signalRecoveryTimer = null;
      if (!this.startupAllowed(episode) || this.socket !== recoverySocket) return;
      if (this.manualDisconnect || this._superseded) return;
      if (this.socket?.connected) {
        this.handleSignalingRecoveryConnected();
        return;
      }

      const waited = performance.now() - this._signalRecoveryStartedAt;
      if (waited >= this.SIGNAL_RECOVERY_MAX_WAIT_MS) {
        // Socket.IO's manager can remain attached to a dead transport after a
        // laptop sleep or proxy reset. Recreate only the signaling socket;
        // the current media context is retained until the new socket connects.
        console.warn('[RECOVERY] Recreating signaling socket after %sms reason=%s', waited, reason);
        this.createSignalingSocket(true);
        this._signalRecoveryStartedAt = performance.now();
      }
      this.scheduleSignalingRecovery(reason);
    }, delay);
    this._signalRecoveryTimer = recoveryTimer;
    this._signalRecoveryTimer?.unref?.();
    return true;
  },

  async refresh(options = {}) {
    if (!this.startupAllowed()) return;
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
    this.clearSignalingRecovery();
    this.clearRefreshDcWaitTimer();
    if (this.isForcedRefreshReason(reason)) {
      if (this._refreshSettleTimer) {
        clearTimeout(this._refreshSettleTimer);
        this._refreshSettleTimer = null;
      }
      this._rebuildingDc = false;
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
    const episode = this._startupEpisode || null;
    this._refreshSettleTimer = setTimeout(() => {
      if (!this.startupAllowed(episode)) return;
      this.markRefreshSettled('timeout');
    }, 8000);
    this._refreshSettleTimer.unref?.();
    this._lastRefreshAt = performance.now();
    this.manualDisconnect = false;
    this.offerInProgress = false;
    this._offerEpoch += 1;
    this.beginConnectionAttempt('refresh');
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.cancelDataChannelWatchdog();
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
      if (this._startupEpisode?.state === 'slow') {
        this.showSlowStartup();
      } else {
        document.getElementById('loading')?.classList.add('is-connecting');
        updateLoadingText('正在重新连接...');
      }
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
      this.cancelDataChannelWatchdog();
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
    const at = this._lastInboundFramesDecodedAt;
    const frames = Number(this._lastInboundFramesDecoded) || 0;
    // Unknown (no growth sample) is not healthy — avoids suppressing DC recovery on freeze.
    if (frames <= 0 || !Number.isFinite(at)) return false;
    return (performance.now() - at) <= maxAgeMs;
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
      this.cancelDataChannelWatchdog();
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
    if (!this.startupAllowed()) return;
    const owner = this.captureStartupOwner();
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
    if (Number.isFinite(this._lastRefreshAt) && performance.now() - this._lastRefreshAt < 3000) {
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
    this._recordInputTrace('recovery', {
      inputType: 'control', action: 'retry', state: 'pending',
      reason: 'transport-change', source: 'recovery',
    });
    console.warn(`[RECOVERY] Scheduling WebRTC reconnect after ${reason}`);
    if (typeof Diagnostic !== 'undefined' && typeof Diagnostic.autoSendFailure === 'function') {
      Diagnostic.autoSendFailure(reason);
    }
    this.setUiPhase(this.startupPending() ? 'signaling' : 'disconnected', { reason });
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
        if (!this.ownsStartupOwner(owner)) return;
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
      if (this.startupPending()) this.retireStartupEpisode('strict-stun-exhausted', { cleanup: true });
      console.warn('[RECOVERY] Strict STUN auto exhausted (failCount=%d), not using tunnel', this._autoFailCount);
      this.useRelayFallback = false;
      this.setFailureRecommendation(hasTurn ? 'direct-failed-suggest-relay' : 'direct-failed-suggest-tunnel', 'danger');
      this.updateNetworkUI('Strict STUN 直连失败，未自动切换 TURN 或媒体隧道。', 'danger');
      updateLoadingText('直连失败，已尝试提交诊断日志。');
      document.getElementById('loading').classList.remove('hidden');
      document.getElementById('loading').classList.remove('is-connecting');
      document.body.classList.remove('stream-connected');
      if (typeof Diagnostic !== 'undefined' && typeof Diagnostic.autoSendFailure === 'function') {
        Diagnostic.autoSendFailure('strict-stun-exhausted');
      }
      return;
    } else if (this.networkMode === 'stun' && this._autoFailCount >= 2) {
      if (this.startupPending()) this.retireStartupEpisode('strict-stun-exhausted', { cleanup: true });
      console.warn('[RECOVERY] Strict STUN mode exhausted (failCount=%d), not using tunnel', this._autoFailCount);
      this.setFailureRecommendation(hasTurn ? 'direct-failed-suggest-relay' : 'direct-failed-suggest-tunnel', 'danger');
      this.updateNetworkUI('外网直连失败，未自动切换 TURN 或媒体隧道。', 'danger');
      updateLoadingText('直连失败，已尝试提交诊断日志。');
      document.getElementById('loading').classList.remove('hidden');
      document.getElementById('loading').classList.remove('is-connecting');
      document.body.classList.remove('stream-connected');
      if (typeof Diagnostic !== 'undefined' && typeof Diagnostic.autoSendFailure === 'function') {
        Diagnostic.autoSendFailure('strict-stun-exhausted');
      }
      return;
    } else if (this.networkMode === 'relay' && !this.getTurnServers().length) {
      if (this.startupPending()) this.retireStartupEpisode('relay-unavailable', { cleanup: true });
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
    if (this._startupEpisode?.state !== 'slow') document.getElementById('loading').classList.add('is-connecting');
    document.body.classList.remove('stream-connected');

    if (this.networkMode === 'relay' && (Number(this._relayHardRefreshCount) || 0) >= 5) {
      if (this.startupPending()) this.retireStartupEpisode('relay-reconnect-exhausted', { cleanup: true });
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

    if (this._startupEpisode?.state === 'slow') this.showSlowStartup();
    const attempt = Number(this._reconnectAttempt) || 0;
    const delay = Math.min(1500 * (2 ** attempt), 15000);
    this._reconnectAttempt = attempt + 1;
    console.warn('[RECOVERY] Scheduling WebRTC reconnect after %s in %sms', reason, delay);

    this.reconnectTimer = setTimeout(() => {
      if (!this.ownsStartupOwner(owner)) return;
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
    this._startRequest = (this._startRequest || 0) + 1;
    this.retireStartupEpisode('manual-disconnect');
    this._signalingSession = null;
    this.markRefreshSettled('disconnect');
    this.clearSignalingRecovery();
    this.stopPortSearch('disconnect');
    this.manualDisconnect = true;
    this.cancelDataChannelWatchdog();
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
      this.cancelDataChannelWatchdog();
      this.pc.close();
      this.pc = null;
    }
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.ensureDesktopSessionState()?.applyConnection({
      attemptId: this.currentConnectionAttemptId,
      state: 'disconnected',
      socket: 'offline',
    });
    document.getElementById('remoteVideo').classList.remove('connected');
    document.body.classList.remove('stream-connected');
    document.getElementById('loading')?.classList.remove('is-connecting');
    this.setUiPhase('disconnected', { reason: 'manual-disconnect' });
    Auth.logout();
  },

  handleViewerSuperseded(payload = {}) {
    this._startRequest = (this._startRequest || 0) + 1;
    this.retireStartupEpisode('viewer-superseded', { retainReclaimConfig: true });
    if (this._superseded) {
      return;
    }
    console.warn('[VIEWER] superseded', payload?.reason || 'unknown', payload?.bySocketId || '');
    this._signalingSession = null;
    this._superseded = true;
    this.manualDisconnect = true;
    this.cancelDataChannelWatchdog();
    this.offerInProgress = false;
    this._offerEpoch += 1;
    this.clearSignalingRecovery();
    this.clearRefreshDcWaitTimer();

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
    this.cancelDataChannelWatchdog();
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
        this.cancelDataChannelWatchdog();
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
    if (this._reclaimPromise) return this._reclaimPromise;
    this._reclaimPromise = this.reclaimDesktopSessionOnce().finally(() => { this._reclaimPromise = null; });
    return this._reclaimPromise;
  },

  async reclaimDesktopSessionOnce() {
    const previousEpisode = this._startupEpisode;
    let episode;
    try {
      // Keep the old Start superseded until its configuration has settled. It
      // cannot initialize media on behalf of this newer explicit operation.
      if (this._pendingBootstrapConfig) await this._pendingBootstrapConfig;
      if (previousEpisode !== this._startupEpisode) return false;
      episode = this.beginStartupEpisode(previousEpisode?.controller);
      const retained = previousEpisode?.reclaimConfig;
      if (retained && (Auth.getToken() !== retained.authToken
          || Auth.getGeneration?.() !== retained.authGeneration || Auth.isVerified?.() !== true)) {
        this.retireStartupEpisode('stale-reclaim-config');
        return false;
      }
      await this.requestExplicitViewerAdmission(episode);
      if (!this.startupAllowed(episode)) return false;
      if (retained && (Auth.getToken() !== retained.authToken
          || Auth.getGeneration?.() !== retained.authGeneration || Auth.isVerified?.() !== true)) {
        this.retireStartupEpisode('stale-reclaim-config', { cleanup: true });
        return false;
      }
      // Only the newly authorized reclaim may consume an inert snapshot.
      if (retained) this.applyBootstrapSnapshot(retained.snapshot);
    }
    catch (error) {
      // Rejection bypasses admission's post-await guard. Before enrollment the
      // pending bootstrap belongs to previousEpisode; afterward it belongs to
      // episode. Neither failure may clean up a newer explicit Start.
      if ((episode || previousEpisode) !== this._startupEpisode
          || (episode && !this.startupAllowed(episode))) return false;
      if (error?.code !== 'superseded') this.enterBootstrapFailure(error);
      return false;
    }
    this._controlUserReleased = false;
    this._cancelControlAcquireIntent();
    this.resetSignalingSession();
    this.hideSupersededUI();
    this._superseded = false;
    this.manualDisconnect = false;
    this._reconnectAttempt = 0;
    this._autoFailCount = 0;
    this.offerInProgress = false;
    this._offerEpoch += 1;
    this.startStartupMediaBudget();
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

function renderViewerChromeClass(node, name, active) {
  if (!node?.classList || node.classList.contains?.(name) === active) return;
  if (active) node.classList.add(name);
  else node.classList.remove(name);
}

function updateConnectionStatus(status) {
  const statusEl = document.getElementById('connectionStatus');
  if (!statusEl) return;
  const className = 'status ' + status;
  if (statusEl.className !== className) statusEl.className = className;
  
  const statusText = {
    idle: '未开始',
    connecting: '连接中',
    'media-pending': '正在出画',
    connected: '已连接',
    'media-paused-terminal': 'Terminal 已暂停',
    'media-stalled': '画面卡顿',
    disconnected: '已断开',
  };
  const label = statusText[status] || status;
  if (statusEl.textContent !== label) statusEl.textContent = label;
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
  WebRTC.bindFullscreenLifecycle();
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
      getScope: () => Auth.getGeneration?.(),
      async fetchSnapshot({ turnServerId, signal }) {
        const apiBase = (typeof RuntimeConfig !== 'undefined')
          ? RuntimeConfig.getApiBase()
          : '';
        const query = turnServerId ? `?turnServerId=${encodeURIComponent(turnServerId)}` : '';
        const tokenAtStart = Auth.getToken();
        const authGeneration = Auth.getGeneration?.();
        const response = await fetch(`${apiBase}/api/viewer-bootstrap${query}`, {
          cache: 'no-store',
          signal,
          headers: { Authorization: `Bearer ${tokenAtStart}` },
        });
        let data;
        try { data = await response.json(); }
        catch { throw Object.assign(new Error('invalid-response'), { code: 'invalid-response', status: response.status }); }
        if (!response.ok) {
          // Bootstrap's existing middleware returns error-only JSON, unlike /auth/verify.
          const applicationInvalid = response.status === 401
            && ['Invalid token', 'Missing bearer token'].includes(data?.error);
          const typedInvalid = (response.status === 401 || response.status === 403)
            && data?.valid === false && ['Invalid token', 'No token provided'].includes(data.error);
          const current = tokenAtStart === Auth.getToken() && authGeneration === Auth.getGeneration?.();
          const code = !current ? 'superseded'
            : applicationInvalid || typedInvalid ? 'auth-invalid' : 'bootstrap-unavailable';
          throw Object.assign(new Error(code), { code, status: response.status });
        }
        if (tokenAtStart !== Auth.getToken() || authGeneration !== Auth.getGeneration?.()) {
          throw Object.assign(new Error('superseded'), { code: 'superseded' });
        }
        return data;
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

  // Auth.subscribe calls back immediately, so install it only after the controller
  // exists. Defer the one page warmup until Auth has verified its current scope.
  let bootstrapPreloaded = false;
  function preloadVerifiedBootstrap() {
    if (!ViewerBootstrap || bootstrapPreloaded || typeof Auth === 'undefined'
        || Auth.isVerified?.() !== true) return;
    bootstrapPreloaded = true;
    ViewerBootstrap.load({
      mode: WebRTC.networkMode,
      turnServerId: WebRTC.selectedTurnServerId || '',
    }).catch(() => {});
  }
  if (typeof Auth !== 'undefined' && typeof Auth.subscribe === 'function') {
    Auth.subscribe((check) => {
      if (check?.state === 'unauthorized') {
        WebRTC._startRequest = (WebRTC._startRequest || 0) + 1;
        WebRTC.retireStartupEpisode('auth-invalid', { cleanup: true });
      }
      window.__WRD_SHELL__?.setAuthCheck?.(check);
      WebRTC.syncChromeCapabilities();
      preloadVerifiedBootstrap();
    });
  }
  preloadVerifiedBootstrap();
  if (!ViewerBootstrap) {
    const episode = WebRTC._startupEpisode || null;
    WebRTC.loadServerConfig().then(() => {
      if (!WebRTC.startupAllowed(episode)) return;
      WebRTC.configureNetworkControls();
      WebRTC.updateNetworkUI('请根据访问环境选择网络模式。');
    }).catch(() => {});
  }

  const startHandler = WebRTC.createStartHandler(ViewerBootstrap);
  if (window.__WRD_SHELL__ && typeof window.__WRD_SHELL__.installCore === 'function') {
    window.__WRD_SHELL__.installCore(startHandler);
  }
  WebRTC.syncChromeCapabilities();
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

  // Non-critical operator tools: each operation has a deadline; requests remain cached.
  const deferredAssets = typeof createAssetLoader === 'function' ? createAssetLoader({ document,
    onRefreshRequired() {
      if (WebRTC._operatorToolsState !== 'failed') return;
      WebRTC._retryOperatorTools = refreshIncompleteModule;
      if (typeof Diagnostic !== 'undefined') Diagnostic.markDeferredFailed?.(refreshIncompleteModule);
      const button = document.getElementById('diagBtn');
      if (button) { button.textContent = '刷新诊断组件'; button.title = '页面版本已淘汰，请先保存未完成草稿，然后刷新页面'; }
    },
  }) : null;
  let deferredGeneration = 0;
  WebRTC._operatorToolsState = WebRTC._operatorToolsState || 'loading';
  WebRTC._retryOperatorTools = null;
  function refreshIncompleteModule() {
    if (window.confirm?.('模块未完成注册。刷新前请保存未完成草稿。是否刷新页面？')) window.location.reload();
  }
  (function loadDeferredDesktop() {
    const operation = ++deferredGeneration;
    const src = window.__WRD_ASSETS__ && window.__WRD_ASSETS__.desktopDeferredJs;
    function ready() {
      if (operation !== deferredGeneration) return;
      WebRTC._operatorToolsState = 'ready';
      WebRTC._retryOperatorTools = null;
      WebRTC.renderPortSearchStatus?.();
    }
    if (!src) {
      // Source mode already includes full scripts on the page.
      if (typeof Diagnostic !== 'undefined' && Diagnostic.panelState === 'loading'
        && typeof Diagnostic.init === 'function' && Diagnostic.openPanel) Diagnostic.init();
      ready();
      return;
    }
    window.__WRD_DEFERRED_MANAGED__ = true;
    WebRTC._operatorToolsState = 'loading';
    WebRTC.renderPortSearchStatus?.();
    if (typeof Diagnostic !== 'undefined') Diagnostic.markDeferredLoading?.();
    const pending = deferredAssets
      ? deferredAssets.load({ url: src, kind: 'script', timeoutMs: 5000 })
      : Promise.reject(new Error('Asset loader unavailable'));
    pending.then(() => {
      if (operation !== deferredGeneration) return;
      if (typeof Diagnostic === 'undefined' || Diagnostic._panelDisposed || typeof Diagnostic.openPanel !== 'function'
        || typeof Diagnostic.init !== 'function' || typeof LatencyMonitor === 'undefined'
        || typeof TurnSelfTest === 'undefined' || typeof StunPortSearchController === 'undefined') {
        throw Object.assign(new Error('Deferred module incomplete'), { code: 'refresh-required' });
      }
      try { Diagnostic.init(); }
      catch (error) { throw Object.assign(error, { code: 'refresh-required' }); }
      ready();
    }).catch((error) => {
      if (operation !== deferredGeneration) return;
      error = deferredAssets?.getRefreshError() || error;
      // This operation is finished. Late script registration alone cannot publish ready.
      deferredGeneration++;
      WebRTC._operatorToolsState = 'failed';
      WebRTC._retryOperatorTools = error.code === 'refresh-required' ? refreshIncompleteModule : loadDeferredDesktop;
      WebRTC.renderPortSearchStatus?.();
      if (typeof Diagnostic !== 'undefined') Diagnostic.markDeferredFailed?.(WebRTC._retryOperatorTools);
      if (error.code === 'refresh-required') {
        const button = document.getElementById('diagBtn');
        if (button) { button.textContent = '刷新诊断组件'; button.title = '请先保存未完成草稿，然后刷新页面'; }
      }
      console.warn('[viewer] deferred desktop tools unavailable');
    });
  }());

  const TerminalLoader = (typeof createTerminalLoader === 'function')
    ? createTerminalLoader({
      assets: window.__WRD_ASSETS__ || null,
      document,
      timeoutMs: 5000,
      onRefreshRequired: setTerminalLoadFailure,
    })
    : null;

  function setTerminalLoadFailure(error) {
    const warning = document.getElementById('terminalWarning');
    const retry = document.getElementById('terminalLoadRetryBtn');
    if (warning) {
      warning.textContent = error?.message || 'Terminal 资源加载失败';
      warning.classList.remove('hidden');
    }
    if (retry) {
      retry.hidden = false;
      retry.textContent = error?.code === 'refresh-required' ? '保存草稿后刷新页面' : '重试加载';
      retry.dataset.refreshRequired = error?.code === 'refresh-required' ? 'true' : 'false';
    }
  }

  let terminalOpenGeneration = 0;
  async function openTerminal({ retry = false } = {}) {
    const operation = ++terminalOpenGeneration;
    if (!TerminalLoader) {
      if (typeof TerminalPanel !== 'undefined' && TerminalPanel?.init) {
        TerminalPanel.init();
        TerminalPanel.showTerminal();
      }
      return;
    }
    try {
      const panel = retry ? await TerminalLoader.retry() : await TerminalLoader.load();
      if (operation !== terminalOpenGeneration) return;
      document.getElementById('terminalWarning')?.classList.add('hidden');
      const retryButton = document.getElementById('terminalLoadRetryBtn');
      if (retryButton) retryButton.hidden = true;
      panel.showTerminal();
    } catch (error) {
      if (operation === terminalOpenGeneration) setTerminalLoadFailure(error);
    }
  }

  document.getElementById('terminalTabBtn')?.addEventListener('click', () => openTerminal());
  document.getElementById('terminalLoadRetryBtn')?.addEventListener('click', (event) => {
    if (event.currentTarget.dataset.refreshRequired === 'true') refreshIncompleteModule();
    else openTerminal({ retry: true });
  });

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
  // The production viewer joins several classic scripts into one bundle. Defer
  // only that generated path until later declarations (ChromeLayout, UI) have
  // left their temporal dead zones; source-mode tests keep their synchronous boot.
  if (typeof window !== 'undefined' && window.__WRD_ASSETS__) {
    if (typeof queueMicrotask === 'function') {
      queueMicrotask(() => bootViewerShell());
    } else {
      Promise.resolve().then(() => bootViewerShell());
    }
  } else {
    bootViewerShell();
  }
}
