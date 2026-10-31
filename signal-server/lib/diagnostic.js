const { createDiagnosticStore, getDiagDir } = require('./diagnostic-store');
const { loadConfig } = require('./config');
const { sanitizeDataChannelWatchdog, sanitizeSignalingFailure, sanitizeControlHeartbeat,
  sanitizeDiagnosticAdmission } = require('../../web-client/js/runtime-diagnostic');

const { LATENCY_METRIC_NAMES } = require('../../web-client/js/latency-monitor');
const crypto = require('node:crypto');
const hashIdentity = value => typeof value === 'string' && value.length > 0
  ? crypto.createHash('sha256').update(value).digest('hex').slice(0, 32) : null;
// Reports may already contain a bounded hash from the viewer redactor. Keep
// that value stable so a single attempt can be joined across services without
// retaining the original identifier.
const identityHash = value => digestValue(value) || hashIdentity(value);
const finiteNonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const countValue = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const digestValue = value => typeof value === 'string' && /^[0-9a-f]{16,64}$/.test(value) ? value : null;
const isRuntimeDiagnostic = value => Number.parseInt(value?.schemaVersion, 10) === 3;
const OUTCOME_NAMES = ['sent', 'acked', 'rejected', 'timedOut', 'late', 'cancelled', 'dropped', 'unmatched'];
const LOG_RECEIPT_STATES = new Set(['empty', 'valid', 'unknown', 'truncated', 'failed']);
const INPUT_TRACE_LOSS_FIELDS = ['droppedEvents', 'droppedHashCount', 'evictedPendingAcks', 'expiredPendingAcks', 'ackTimeoutCount'];
const FRAME_TRACE_LOSS_FIELDS = ['droppedTraceCount', 'invalidBatchCount', 'staleTraceCount', 'conflictingTraceCount'];
const FRAME_TRACE_COVERAGE_FIELDS = ['ringDropCount', 'expiredFrameCount', 'expiredTraceCount', 'hostDroppedTraceCount'];
function redactLatency(snapshot) {
  if (!isRecord(snapshot) || snapshot.schemaVersion !== 3) return null;
  const metrics = {};
  // Shared with the producer. Never add an independent list of latency names.
  for (const name of LATENCY_METRIC_NAMES) {
    const item = snapshot.metrics?.[name];
    metrics[name] = {
      last: finiteNonnegative(item?.last), p50: finiteNonnegative(item?.p50), p95: finiteNonnegative(item?.p95),
      count: countValue(item?.count), available: item?.available === true,
      lastSampleAgeMs: finiteNonnegative(item?.lastSampleAgeMs),
    };
  }
  const rawScope = snapshot.scope;
  const scope = isRecord(rawScope) ? { attemptHash: digestValue(rawScope.attemptHash) || hashIdentity(rawScope.connectionAttemptId),
    generation: safeInteger(rawScope.generation, Number.MAX_SAFE_INTEGER), leaseEpoch: safeInteger(rawScope.leaseEpoch, Number.MAX_SAFE_INTEGER) } : null;
  return { schemaVersion: 3, windowMs: 5000, scope, metrics,
    outcomes: Object.fromEntries(OUTCOME_NAMES.map(name => [name, countValue(snapshot.outcomes?.[name])])) };
}
const STARTUP_MARKS = new Set(['html-shell', 'core-failed', 'core-interactive', 'start-click', 'bootstrap-start',
  'bootstrap-ready', 'bootstrap-degraded', 'signal-connected', 'first-frame', 'active']);
function redactStartup(value) {
  const marks = Array.isArray(value?.marks) ? value.marks : [];
  return { signalingFailure: sanitizeSignalingFailure(value?.signalingFailure), dataChannelWatchdog: sanitizeDataChannelWatchdog(value?.dataChannelWatchdog), marks: marks.filter(mark => STARTUP_MARKS.has(mark?.name)).slice(0, 64)
    .map(mark => ({ name: mark.name, atMs: finiteNonnegative(mark.atMs ?? mark.at) })),
    resources: (Array.isArray(value?.resources) ? value.resources : []).filter(resource =>
      typeof resource?.path === 'string' && /^\/?assets\/[a-z0-9-]+\.[a-f0-9]{8,64}\.(js|css)$/.test(resource.path))
      .slice(0, 10).map(resource => ({ path: resource.path, durationMs: finiteNonnegative(resource.durationMs) })) };
}
function redactBuild(value) {
  const builtAt = Number.isSafeInteger(value?.builtAt) && value.builtAt >= 0 ? value.builtAt
    : (typeof value?.builtAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value.builtAt) ? value.builtAt : null);
  return { id: digestValue(value?.id), builtAt };
}
function sanitizeLogReceipt(value, fallback = {}) {
  const source = isRecord(value) ? value : fallback;
  const state = safeEnum(source.state, LOG_RECEIPT_STATES);
  const count = key => safeInteger(source[key], Number.MAX_SAFE_INTEGER);
  const result = { state: state || 'unknown' };
  for (const key of ['reported', 'retained', 'redacted', 'dropped']) {
    const valueForKey = count(key);
    if (valueForKey !== null) result[key] = valueForKey;
  }
  const reason = safeReason(source.reason);
  if (reason !== null) result.reason = reason;
  return result;
}

function inputTraceLoss(inputTrace) {
  const counters = isRecord(inputTrace?.counters) ? inputTrace.counters
    : (isRecord(inputTrace) ? inputTrace : {});
  const result = {};
  for (const key of INPUT_TRACE_LOSS_FIELDS) {
    const value = safeInteger(counters[key], Number.MAX_SAFE_INTEGER);
    if (value !== null) result[key] = value;
  }
  return result;
}

function coverageSignal(count) {
  return { state: count === null ? 'unknown' : count > 0 ? 'nonzero' : 'observed', count };
}

function diagnosticCoverageSignals({ summaryGapCount = null, ringDropCount = null, inputTraceLoss: loss = {} } = {}) {
  const lossValues = INPUT_TRACE_LOSS_FIELDS.map(key => loss?.[key]);
  const lossKnown = lossValues.every(value => Number.isSafeInteger(value) && value >= 0);
  const lossCount = lossKnown ? lossValues.reduce((total, value) => total + value, 0) : null;
  return {
    summaryGap: coverageSignal(summaryGapCount),
    ringDrop: coverageSignal(ringDropCount),
    inputTrace: coverageSignal(lossCount),
  };
}

function sanitizeFrameTrace(value) {
  if (!isRecord(value)) return null;
  const state = safeEnum(value.acceptanceState, new Set(['PENDING', 'UNALIGNED']));
  const result = { acceptanceState: state || 'PENDING' };
  for (const key of ['pendingFrames', 'pendingTraces', 'seenIdentities', 'matchedCount', ...FRAME_TRACE_LOSS_FIELDS]) {
    const count = safeInteger(value[key], Number.MAX_SAFE_INTEGER);
    if (count !== null) result[key] = count;
  }
  for (const key of ['ringDropCount', 'expiredFrameCount', 'expiredTraceCount', 'hostDroppedTraceCount']) {
    if (!Object.hasOwn(value, key)) continue;
    const count = safeInteger(value[key], Number.MAX_SAFE_INTEGER);
    if (count !== null) result[key] = count;
  }
  if (isRecord(value.stageCoverage)) {
    const sampleCount = safeInteger(value.stageCoverage.sampleCount, Number.MAX_SAFE_INTEGER);
    const observed = {};
    for (const key of ['grab', 'age_at_recv', 'worker_queue', 'prepare', 'build',
      'reformat', 'encode', 'packetize', 'encode_total']) {
      const count = safeInteger(value.stageCoverage.observed?.[key], Number.MAX_SAFE_INTEGER);
      if (count !== null) observed[key] = count;
    }
    if (sampleCount !== null && Object.keys(observed).length) result.stageCoverage = { sampleCount, observed };
  }
  return result;
}

function redactRuntimeDiagnostic(payload) {
  // Console content is intentionally excluded from schema 3. Count the actual
  // received array first; client-supplied counters cannot establish evidence.
  const reportedLogCount = Array.isArray(payload.logs) ? payload.logs.length : null;
  const logReceipt = sanitizeLogReceipt(payload.logReceipt, {
    state: Array.isArray(payload.logs)
      ? (payload.logs.length === 0 ? 'empty' : (safeInteger(payload.truncation?.dropped, Number.MAX_SAFE_INTEGER) > 0 ? 'truncated' : 'valid'))
      : 'unknown',
    reported: reportedLogCount,
    retained: 0,
    redacted: reportedLogCount,
    dropped: safeInteger(payload.truncation?.dropped, Number.MAX_SAFE_INTEGER),
  });
  const latency = redactLatency(payload.latency);
  const inputTrace = redactInputTrace(payload.inputTrace);
  if (inputTrace) {
    inputTrace.schemaVersion = 3;
    inputTrace.traceNowMs = safeInteger(payload.inputTrace?.traceNowMs, Number.MAX_SAFE_INTEGER);
    for (const event of inputTrace.events) {
      if (event.connectionAttemptId) { event.attemptHash = hashIdentity(event.connectionAttemptId); delete event.connectionAttemptId; }
    }
  }
  const inputState = redactInputState(payload.inputState);
  const summaryGapCount = safeInteger(
    payload.summaryGapCount ?? payload.summaryGaps?.count ?? payload.coverage?.summaryGapCount,
    Number.MAX_SAFE_INTEGER,
  );
  const ringDropCount = safeInteger(
    payload.ringDropCount ?? payload.ringDropped ?? payload.heartbeat?.ringDropped,
    Number.MAX_SAFE_INTEGER,
  );
  const coverageStatus = safeEnum(payload.coverage?.status, new Set(['complete', 'partial', 'unavailable'])) || null;
  if (inputState) for (const event of inputState.recentInputEvents) {
    if (event.connectionAttemptId) { event.attemptHash = hashIdentity(event.connectionAttemptId); delete event.connectionAttemptId; }
  }
  const events = []; let dropped = countValue(payload.scopeEnded?.dropped);
  for (const event of (Array.isArray(payload.scopeEnded?.events) ? payload.scopeEnded.events : [])) {
    const snapshot = redactLatency(event?.snapshot);
    const eventIdHash = digestValue(event?.eventIdHash);
    const endedAtMs = finiteNonnegative(event?.endedAtMs);
    if (!snapshot || !eventIdHash || endedAtMs === null || events.some(item => item.eventIdHash === eventIdHash)) { dropped++; continue; }
    events.push({ eventIdHash, endedAtMs, snapshot });
    while (events.length > 4 || Buffer.byteLength(JSON.stringify(events)) > 32 * 1024) { events.shift(); dropped++; }
  }
  const captured = payload.captured || {};
  const wallTime = typeof captured.wallTime === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(captured.wallTime) ? captured.wallTime : null;
  const clean = { type: 'connection-diagnostic', schemaVersion: 3, diagnosticId: digestValue(payload.diagnosticId),
    reason: safeReason(payload.reason) || safeEnum(payload.reason, new Set(['pc-failed', 'pc-disconnected', 'ice-disconnected', 'dc-error', 'dc-stuck', 'negotiation-timeout', 'manual'])),
    trigger: safeEnum(payload.trigger, new Set(['manual', 'auto-failure'])) || 'manual',
    connectionAttemptId: hashIdentity(payload.connectionAttemptId), browserSessionId: hashIdentity(payload.browserSessionId),
    mode: safeEnum(payload.mode, new Set(['auto', 'direct', 'relay', 'tunnel', 'stun', 'turn'])),
    captured: { wallTime, monotonicMs: finiteNonnegative(captured.monotonicMs), bootIdHash: digestValue(captured.bootIdHash) },
    build: redactBuild(payload.build), latencyStatus: latency ? 'available' : 'collector-unavailable', latency,
    inputState, inputTrace, startup: redactStartup(payload.startup), resources: null,
    scopeEnded: { events, dropped }, logs: [], keyboardDebug: [], events: [], probeResults: [], inputChannelTimeline: [],
    logContentPolicy: 'metadata-only', reportedLogCount, retainedLogCount: 0, redactedLogCount: reportedLogCount,
    logReceipt,
    inputTraceLoss: inputTraceLoss(inputTrace),
    inputTraceEventCount: Array.isArray(inputTrace?.events) ? inputTrace.events.length : null,
    summaryGapCount,
    ringDropCount,
    coverageStatus,
    traceSummary: {},
  };
  for (const key of ['receivedDelta', 'decodedDelta', 'derivedFps', 'bytesDelta', 'framesDroppedDelta', 'packetsReceivedDelta',
    'nackCountDelta', 'pliCountDelta', 'firCountDelta', 'freezeDelta', 'videoWidth', 'videoHeight', 'readyState', 'jitterBufferMs']) {
    const value = finiteNonnegative(payload.traceSummary?.[key]);
    if (value !== null) clean.traceSummary[key] = value;
  }
  for (const key of ['hasPaintedFrame', 'keyframeRequested', 'keyframeEmitted', 'explicitOverride1080']) {
    const value = payload.traceSummary?.[key];
    if (typeof value === 'boolean') clean.traceSummary[key] = value;
  }
  const interval = payload.traceSummary?.mediaInterval;
  const controlHeartbeat = sanitizeControlHeartbeat(payload.traceSummary?.controlHeartbeat);
  if (controlHeartbeat) clean.traceSummary.controlHeartbeat = controlHeartbeat;
  const frameTrace = sanitizeFrameTrace(payload.traceSummary?.frameTrace);
  if (frameTrace) clean.traceSummary.frameTrace = frameTrace;
  const diagnosticAdmission = sanitizeDiagnosticAdmission(payload.traceSummary?.diagnosticAdmission);
  if (diagnosticAdmission) clean.traceSummary.diagnosticAdmission = diagnosticAdmission;
  const elapsedMs = finiteNonnegative(interval?.elapsedMs);
  const sampleAgeMs = finiteNonnegative(interval?.sampleAgeMs);
  if (interval?.schemaVersion === 1 && interval.kind === 'webrtc-inbound-interval'
      && elapsedMs !== null && elapsedMs > 0 && elapsedMs <= 60000
      && sampleAgeMs !== null && sampleAgeMs <= 5000) {
    clean.traceSummary.mediaInterval = { schemaVersion: 1, kind: 'webrtc-inbound-interval', elapsedMs, sampleAgeMs,
      fpsObserved: interval.fpsObserved === true, droppedFramesObserved: interval.droppedFramesObserved === true };
  }
  // Trim only optional context; mandatory schema/capture/build/M1 explanation remains.
  clean.truncation = { dropped: countValue(payload.truncation?.dropped) };
  while (Buffer.byteLength(JSON.stringify(clean)) > 128 * 1024 && clean.inputTrace?.events.length) {
    clean.inputTrace.events.shift(); clean.truncation.dropped++;
    clean.inputTraceEventCount = clean.inputTrace.events.length;
  }
  return clean;
}

const INPUT_TRACE_MAX_EVENTS = 256;
const INPUT_TRACE_MAX_BYTES = 64 * 1024;
const INPUT_TRACE_MAX_INPUT_IDS = 64;
const INPUT_TRACE_MAX_PENDING_HASHES = 64;
const INPUT_TRACE_MAX_PENDING_ACKS = 256;
const INPUT_TRACE_MAX_REASON_LENGTH = 64;
const INPUT_DIAGNOSTIC_MEDIA_STATES = new Set(['active', 'suspended']);
const INPUT_DIAGNOSTIC_RUNTIME_PHASES = new Set(['active', 'suspending', 'suspended', 'resuming']);
const INPUT_DIAGNOSTIC_SURFACE_STATES = new Set(['settled', 'pending', 'uncertain']);
const INPUT_DIAGNOSTIC_RECOVERY_STATES = new Set(['idle', 'waiting', 'recovered', 'failed']);
const INPUT_DIAGNOSTIC_DRAFT_STATUSES = new Set(['idle', 'pending', 'composing', 'uncertain', 'blocked']);
const INPUT_DIAGNOSTIC_KEYBOARD_STATES = new Set([
  'INACTIVE', 'READY', 'BLOCKED', 'RESET_REQUIRED', 'reacquire-required', 'revoked', 'blocked', 'ready',
]);
const INPUT_DIAGNOSTIC_ADAPTERS = new Set(['dataChannel', 'socket']);
const INPUT_DIAGNOSTIC_TRANSPORTS = new Set(['datachannel', 'socket', 'none']);
const INPUT_DIAGNOSTIC_TYPES = new Set(['keyboard', 'mouse', 'pointer', 'text', 'control', 'command']);
const INPUT_DIAGNOSTIC_ACTIONS = new Set([
  'key', 'keydown', 'keyup', 'text', 'chord', 'batch', 'down', 'up', 'move', 'wheel', 'reset', 'click', 'ack',
  'focus', 'blur', 'visibility', 'pause', 'resume', 'active', 'inactive', 'recovery', 'retry',
  'discard', 'composition', 'beforeinput', 'input', 'showDock',
]);
const INPUT_DIAGNOSTIC_EVENT_TYPES = new Set([
  'keyboard-reset', 'mouse-reset', 'input-ack', 'input-timeout', 'recovery',
]);
const INPUT_DIAGNOSTIC_PHASES = new Set([
  'down', 'up', 'move', 'wheel', 'beforeinput', 'input', 'compositionstart', 'compositionupdate',
  'compositionend', 'focus', 'blur', 'hidden', 'visible', 'send', 'accept', 'reject',
]);
const INPUT_DIAGNOSTIC_FOCUS_KINDS = new Set(['desktop', 'mobile-text', 'local-editor', 'terminal', 'other']);
const INPUT_DIAGNOSTIC_VISIBILITIES = new Set(['visible', 'hidden']);
const INPUT_DIAGNOSTIC_STATES = new Set([
  'idle', 'waiting', 'recovered', 'failed', 'active', 'inactive', 'visible', 'hidden', 'pending',
  'uncertain', 'settled', 'ready', 'blocked', 'revoked', 'reacquire-required', 'paused', 'resumed',
  'reset', 'loading', 'closed',
]);
const INPUT_DIAGNOSTIC_SOURCES = new Set(['auto', 'user', 'lifecycle', 'recovery', 'transport', 'manual']);
const INPUT_DIAGNOSTIC_STATUSES = new Set([
  'applied', 'duplicate', 'stale', 'late', 'timeout', 'rejected', 'sequence-gap', 'resync-required',
  'stale-lease', 'invalid-input', 'unsupported-code', 'execution-failed', 'unordered', 'unknown',
  'accepted', 'failed', 'pending', 'ready', 'blocked', 'reacquire-required', 'revoked',
]);
const INPUT_DIAGNOSTIC_REASONS = new Set([
  'signal-connect-error', 'no-active-control', 'inactive', 'viewport-unsupported', 'media-gate', 'manual-disconnect',
  'media-not-ready-for-attempt', 'keyboard-transport-blocked', 'keyboard-transport-reacquire-required',
  'keyboard-transport-revoked', 'keyboard-reset-pending', 'keyboard-blocked', 'surface-pending',
  'surface-uncertain', 'mouse-reset-pending', 'desktop-write-reacquire-required', 'draft-composing',
  'draft-pending', 'draft-uncertain', 'recovery-waiting', 'recovery-failed', 'surface-user',
  'initial-ready', 'restore', 'window-blur', 'window-focus', 'visibility-hidden', 'visibility-visible',
  'pointer-cancel', 'lost-pointer-capture', 'geometry-changed', 'move-buttons-clear',
  'pointer-up-failed', 'deactivated', 'datachannel-available', 'datachannel-unavailable',
  'lease-changed', 'lease-rebind', 'attempt-changed', 'transport-change', 'manual', 'sequence-gap',
  'unsupported-viewport', 'mouse-reset', 'up-send-failed', 'late-ack', 'context-invalidated',
  'input-ack-timeout', 'automatic-recovery', 'user-recovery', 'recovery-timeout',
  'mouse-reset-send-failed', 'keyboard-reset-send-failed', 'mouse-reset-retry-failed',
  'batch-failed', 'reacquire-required', 'reset', 'keyboard-reset', 'active', 'inactive', 'blocked',
  'revoked', 'ready', 'focus', 'blur', 'pause', 'resume', 'draft', 'composition', 'retry', 'discard',
  'surface-restore', 'input-gate-unexpected',
  'control-lost', 'disconnect', 'unbind', 'validate-reentry', 'map-reentry', 'nested-reset',
  'outer-reset', 'test-reset', 'input-recovery-timeout', 'down-ack-timeout', 'up-ack-timeout',
  'connection-attempt-changed', 'datachannel-open', 'datachannel-close', 'datachannel-error',
  'manual-pause', 'page-hidden', 'surface-ack-timeout',
]);
const INPUT_TRACE_COUNTERS = [
  'droppedEvents', 'sampledEvents', 'hashUnavailable', 'droppedHashCount', 'pendingHashCount',
  'pendingAckCount', 'evictedPendingAcks', 'expiredPendingAcks', 'ackTimeoutCount',
  'incidentCallbackErrors', 'mouseMoveCount', 'wheelCount',
];
const INPUT_TRACE_HASH = /^[0-9a-f]{16}$/;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeInteger(value, maximum = 0x7fffffff) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, maximum) : null;
}

function safeFinite(value, maximum = 10 * 1000) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(value, maximum) : null;
}

function safeBoolean(value) {
  return typeof value === 'boolean' ? value : null;
}

function safeEnum(value, allowed) {
  return typeof value === 'string' && allowed.has(value) ? value : null;
}

function safeReason(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > INPUT_TRACE_MAX_REASON_LENGTH) return null;
  if (INPUT_DIAGNOSTIC_REASONS.has(value)) return value;
  if (/^runtime-phase:(active|suspending|suspended|resuming)$/.test(value)) return value;
  if (/^media-state:(active|suspended|unknown)$/.test(value)) return value;
  if (/^keyboard-reset-ack-(applied|duplicate|stale|late|rejected|execution-failed|invalid-input|unsupported-code|stale-lease)$/.test(value)) return value;
  if (/^mouse-reset-ack-(applied|duplicate|stale|late|rejected|execution-failed|invalid-input|unsupported-code|stale-lease)$/.test(value)) return value;
  if (/^ack-(applied|duplicate|stale|late|rejected|execution-failed|invalid-input|stale-lease|unsupported-code|sequence-gap|resync-required)$/.test(value)) return value;
  return null;
}

function safeReasonList(value, limit = 16) {
  if (!Array.isArray(value)) return [];
  const result = [];
  value.forEach((item) => {
    const reason = safeReason(item);
    if (reason && !result.includes(reason) && result.length < limit) result.push(reason);
  });
  return result;
}

function safeTraceEvent(event) {
  if (!isRecord(event)) return {};
  const clean = {};
  const copyInteger = (key, maximum = 0x7fffffff) => {
    const value = safeInteger(event[key], maximum);
    if (value !== null) clean[key] = value;
  };
  const copyEnum = (key, allowed) => {
    const value = safeEnum(event[key], allowed);
    if (value !== null) clean[key] = value;
  };
  copyInteger('eventId', Number.MAX_SAFE_INTEGER);
  const eventType = safeEnum(event.type, INPUT_DIAGNOSTIC_EVENT_TYPES);
  if (eventType !== null) clean.type = eventType;
  copyEnum('stage', new Set(['dom-received', 'gate', 'transport-send', 'ack', 'ack-timeout', 'lifecycle', 'recovery']));
  copyInteger('at', Number.MAX_SAFE_INTEGER);
  copyEnum('inputType', INPUT_DIAGNOSTIC_TYPES);
  copyEnum('action', INPUT_DIAGNOSTIC_ACTIONS);
  copyEnum('phase', INPUT_DIAGNOSTIC_PHASES);
  copyEnum('transport', INPUT_DIAGNOSTIC_TRANSPORTS);
  ['accepted', 'gateAllowed', 'pendingMouseReset'].forEach((key) => {
    const value = safeBoolean(event[key]);
    if (value !== null) clean[key] = value;
  });
  const reason = safeReason(event.reason);
  if (reason !== null) clean.reason = reason;
  const status = safeEnum(event.status, INPUT_DIAGNOSTIC_STATUSES);
  if (status !== null) clean.status = status;
  copyInteger('seq');
  copyInteger('appliedSeq');
  copyInteger('leaseEpoch');
  const attemptHash = identityHash(event.attemptHash || event.connectionAttemptId);
  if (attemptHash) clean.attemptHash = attemptHash;
  const clientRttMs = safeFinite(event.clientRttMs);
  if (clientRttMs !== null) clean.clientRttMs = Math.round(clientRttMs * 100) / 100;
  copyEnum('focusKind', INPUT_DIAGNOSTIC_FOCUS_KINDS);
  copyEnum('visibility', INPUT_DIAGNOSTIC_VISIBILITIES);
  copyEnum('state', INPUT_DIAGNOSTIC_STATES);
  copyEnum('source', INPUT_DIAGNOSTIC_SOURCES);
  copyInteger('generation');
  copyEnum('surfaceState', INPUT_DIAGNOSTIC_STATES);
  copyEnum('recoveryState', INPUT_DIAGNOSTIC_STATES);
  copyEnum('desktopWriteRecoveryState', INPUT_DIAGNOSTIC_STATES);
  copyInteger('inputIdCount', INPUT_TRACE_MAX_INPUT_IDS);
  if (typeof event.inputIdHash === 'string' && INPUT_TRACE_HASH.test(event.inputIdHash)) {
    clean.inputIdHash = event.inputIdHash;
  }
  return clean;
}

function redactInputTrace(inputTrace) {
  if (!isRecord(inputTrace)) return null;
  const counters = {};
  INPUT_TRACE_COUNTERS.forEach((key) => {
    const maximum = key === 'pendingHashCount' ? INPUT_TRACE_MAX_PENDING_HASHES
      : key === 'pendingAckCount' ? INPUT_TRACE_MAX_PENDING_ACKS : 0x7fffffff;
    const value = safeInteger(inputTrace.counters?.[key], maximum);
    if (value !== null) counters[key] = value;
  });
  const rawEvents = Array.isArray(inputTrace.events) ? inputTrace.events : [];
  const events = rawEvents.slice(-INPUT_TRACE_MAX_EVENTS).map(safeTraceEvent);
  let receiverDroppedEvents = Math.max(0, rawEvents.length - events.length);
  const clientDroppedEvents = safeInteger(inputTrace.counters?.droppedEvents) || 0;
  const updateDroppedEvents = () => {
    const total = clientDroppedEvents + receiverDroppedEvents;
    counters.droppedEvents = Math.min(0x7fffffff, total);
  };
  if (receiverDroppedEvents > 0) updateDroppedEvents();
  const clean = {
    schemaVersion: safeInteger(inputTrace.schemaVersion, 10) || 1,
    events,
    counters,
    ...(inputTrace.schemaVersion === 3 ? { traceNowMs: safeInteger(inputTrace.traceNowMs, Number.MAX_SAFE_INTEGER), bootIdHash: digestValue(inputTrace.bootIdHash) } : {}),
  };
  const byteLength = () => Buffer.byteLength(JSON.stringify(clean), 'utf8');
  while (events.length && byteLength() > INPUT_TRACE_MAX_BYTES) {
    events.shift();
    receiverDroppedEvents += 1;
    updateDroppedEvents();
  }
  return clean;
}

function redactRecovery(value) {
  if (!isRecord(value)) return null;
  const clean = {};
  const state = safeEnum(value.state, INPUT_DIAGNOSTIC_RECOVERY_STATES);
  if (state !== null) clean.state = state;
  const generation = safeInteger(value.generation);
  if (generation !== null) clean.generation = generation;
  const reason = safeReason(value.reason);
  if (reason !== null) clean.reason = reason;
  ['mouseConfirmed', 'keyboardConfirmed', 'retryAvailable'].forEach((key) => {
    const boolean = safeBoolean(value[key]);
    if (boolean !== null) clean[key] = boolean;
  });
  return clean;
}

function redactInputGate(value) {
  if (!isRecord(value)) return null;
  const clean = {};
  ['enabled', 'hasActiveControl', 'manualDisconnect', 'inputIsActive'].forEach((key) => {
    const boolean = safeBoolean(value[key]);
    if (boolean !== null) clean[key] = boolean;
  });
  const mediaState = safeEnum(value.mediaState, INPUT_DIAGNOSTIC_MEDIA_STATES);
  if (mediaState !== null) clean.mediaState = mediaState;
  const runtimePhase = safeEnum(value.runtimePhase, INPUT_DIAGNOSTIC_RUNTIME_PHASES);
  if (runtimePhase !== null) clean.runtimePhase = runtimePhase;
  clean.blockedReasons = safeReasonList(value.blockedReasons, 16);
  return clean;
}

function redactInputState(inputState) {
  if (!isRecord(inputState)) return null;
  const clean = {};
  const keyboardMode = safeEnum(inputState.keyboardMode, new Set(['windows', 'mac']));
  if (keyboardMode !== null) clean.keyboardMode = keyboardMode;
  ['isActive', 'hasLease'].forEach((key) => {
    const boolean = safeBoolean(inputState[key]);
    clean[key] = boolean;
  });
  const leaseEpoch = safeInteger(inputState.leaseEpoch);
  clean.leaseEpoch = leaseEpoch ?? 0;

  clean.gate = isRecord(inputState.gate) ? redactInputGate(inputState.gate) : null;
  if (isRecord(inputState.effectiveGate)) {
    const effectiveGate = {
      allowed: safeBoolean(inputState.effectiveGate.allowed) === true,
      blockedReasons: safeReasonList(inputState.effectiveGate.blockedReasons, 16),
    };
    if (isRecord(inputState.effectiveGate.recovery)) {
      effectiveGate.recovery = redactRecovery(inputState.effectiveGate.recovery);
    }
    clean.effectiveGate = effectiveGate;
  }

  if (isRecord(inputState.surface)) {
    clean.surface = {
      state: safeEnum(inputState.surface.state, INPUT_DIAGNOSTIC_SURFACE_STATES) || 'settled',
      generation: safeInteger(inputState.surface.generation) || 0,
    };
  }
  if (isRecord(inputState.draft)) {
    clean.draft = {
      composing: safeBoolean(inputState.draft.composing) === true,
      hasPending: safeBoolean(inputState.draft.hasPending) === true,
      deliveryUncertain: safeBoolean(inputState.draft.deliveryUncertain) === true,
      status: safeEnum(inputState.draft.status, INPUT_DIAGNOSTIC_DRAFT_STATUSES) || 'idle',
    };
  }
  if (isRecord(inputState.viewport)) {
    clean.viewport = { inputSupported: safeBoolean(inputState.viewport.inputSupported) === true };
  }
  if (isRecord(inputState.recovery)) clean.recovery = redactRecovery(inputState.recovery);
  if (isRecord(inputState.keyboard)) {
    const keyboard = {};
    const leaseState = safeEnum(inputState.keyboard.leaseState, INPUT_DIAGNOSTIC_KEYBOARD_STATES);
    if (leaseState !== null) keyboard.leaseState = leaseState;
    ['epoch', 'lastSent', 'lastApplied'].forEach((key) => {
      const value = safeInteger(inputState.keyboard[key]);
      if (value !== null) keyboard[key] = value;
    });
    ['pendingCount', 'pressedCount'].forEach((key) => {
      const value = safeInteger(inputState.keyboard[key], 256);
      if (value !== null) keyboard[key] = value;
    });
    const modifierMask = safeInteger(inputState.keyboard.modifierMask, 0x1fffff);
    if (modifierMask !== null) keyboard.modifierMask = modifierMask;
    const adapter = safeEnum(inputState.keyboard.adapter, INPUT_DIAGNOSTIC_ADAPTERS);
    if (adapter !== null) keyboard.adapter = adapter;
    const resetReason = safeReason(inputState.keyboard.lastResetReason);
    if (resetReason !== null) keyboard.lastResetReason = resetReason;
    clean.keyboard = keyboard;
  } else {
    clean.keyboard = null;
  }

  const pendingKeys = Array.isArray(inputState.pendingKeys)
    ? Math.min(inputState.pendingKeys.length, INPUT_TRACE_MAX_INPUT_IDS)
    : safeInteger(inputState.pendingKeys, INPUT_TRACE_MAX_INPUT_IDS);
  clean.pendingKeys = pendingKeys ?? 0;
  ['lastReleaseAllReason', 'lastKeyboardResetReason'].forEach((key) => {
    const reason = safeReason(inputState[key]);
    if (reason !== null) clean[key] = reason;
  });
  clean.recentInputEvents = Array.isArray(inputState.recentInputEvents)
    ? inputState.recentInputEvents.slice(-20).map(safeTraceEvent)
    : [];
  const pressedMouseButtonCount = safeInteger(inputState.pressedMouseButtonCount, 32);
  if (pressedMouseButtonCount !== null) clean.pressedMouseButtonCount = pressedMouseButtonCount;
  const pendingMouseReset = safeBoolean(inputState.pendingMouseReset);
  if (pendingMouseReset !== null) clean.pendingMouseReset = pendingMouseReset;
  if (isRecord(inputState.desktopWriteRecovery)) {
    const desktop = {};
    const state = safeEnum(inputState.desktopWriteRecovery.state, new Set(['reacquire-required', 'reconciled']));
    if (state !== null) desktop.state = state;
    const status = safeEnum(inputState.desktopWriteRecovery.status, INPUT_DIAGNOSTIC_STATUSES);
    if (status !== null) desktop.status = status;
    const appliedSeq = safeInteger(inputState.desktopWriteRecovery.appliedSeq);
    if (appliedSeq !== null) desktop.appliedSeq = appliedSeq;
    clean.desktopWriteRecovery = desktop;
  }
  return clean;
}

function redactDiagnosticPayload(payload) {
  if (isRuntimeDiagnostic(payload)) return redactRuntimeDiagnostic(payload);
  const recentLogs = Array.isArray(payload.logs) ? payload.logs.slice(-120) : [];
  const network = payload.network && typeof payload.network === 'object'
    ? {
        ...payload.network,
        candidateSummary: payload.network.candidateSummary
          ? {
              local: payload.network.candidateSummary.local || {},
              remote: payload.network.candidateSummary.remote || {},
              samples: payload.network.candidateSummary.samples || { local: [], remote: [] },
            }
          : undefined,
      }
    : null;
  const inputState = redactInputState(payload.inputState);
  const inputTrace = redactInputTrace(payload.inputTrace);

  return {
    ...payload,
    logs: recentLogs,
    network,
    keyboardDebug: [],
    inputState,
    inputTrace,
  };
}

// Keep the public persistence API; all real filesystem operations and receipts
// live in the one diagnostic store. HTTP and Socket still share this ingress.
const diagnosticStore = () => createDiagnosticStore({ dir: getDiagDir() });
function deidentifyPersistedReport(report, viewerId = report?.viewerId) {
  let safe;
  try { safe = JSON.parse(JSON.stringify(report || {})); }
  catch (_error) { safe = { ...(report || {}) }; }
  safe.viewerHash = digestValue(safe.viewerHash) || hashIdentity(viewerId || safe.viewerId || safe.viewerHash || 'unknown');
  safe.attemptHash = digestValue(safe.attemptHash) || hashIdentity(safe.connectionAttemptId);
  safe.browserSessionHash = digestValue(safe.browserSessionHash) || hashIdentity(safe.browserSessionId);
  delete safe.viewerId;
  delete safe.connectionAttemptId;
  delete safe.browserSessionId;
  return safe;
}
function persistDiagnostic(filename, report) {
  return diagnosticStore().persistLegacy(filename, deidentifyPersistedReport(report));
}
function loadDiagnosticReceipts(now) { return diagnosticStore().loadDiagnosticReceipts(now); }
function saveDiagnosticReceipts(index) { return diagnosticStore().saveDiagnosticReceipts(index); }
function persistDiagnosticOnce(report, { viewerId = report.viewerId, receivedAt = report.receivedAt, now } = {}) {
  const safeReport = deidentifyPersistedReport(report, viewerId);
  return createDiagnosticStore({ dir: getDiagDir(), ...(now === undefined ? {} : { now: () => now }) })
    .write({ ...safeReport, receivedAt });
}
function cleanupDiagLogs(logger = console) {
  try { return diagnosticStore().cleanup(); }
  catch (error) { logger.error?.('[DIAGNOSTIC] cleanup failed:', error.message); }
}
function loadRecentDiagnostics(limit = 50) { return diagnosticStore().recent(limit); }

function dedupeDiagnosticsByAttempt(items = []) {
  const deduped = [];
  const seenAttemptIds = new Set();

  items.forEach((item, index) => {
    const rawAttemptId = String(item?.attemptHash || item?.connectionAttemptId || '').trim();
    const attemptKey = rawAttemptId || `missing-attempt-${index}`;
    if (seenAttemptIds.has(attemptKey)) {
      return;
    }
    seenAttemptIds.add(attemptKey);
    deduped.push(item);
  });

  return deduped;
}

function buildConnectionSummary(items = []) {
  const attempts = dedupeDiagnosticsByAttempt(items);
  const summary = {
    total: attempts.length,
    failures: {},
    nextSuggestions: {
      relay: 0,
      tunnel: 0,
    },
    modes: {},
    latestAttempt: attempts[0] || null,
  };

  attempts.forEach((item) => {
    const reason = String(item?.traceSummary?.reason || item?.reason || 'unknown');
    summary.failures[reason] = (summary.failures[reason] || 0) + 1;

    const nextSuggestedMode = String(item?.recommendation?.nextSuggestedMode || '').trim();
    if (nextSuggestedMode) {
      summary.nextSuggestions[nextSuggestedMode] = (summary.nextSuggestions[nextSuggestedMode] || 0) + 1;
    }

    const mode = String(item?.mode || 'unknown').trim() || 'unknown';
    summary.modes[mode] = (summary.modes[mode] || 0) + 1;
  });

  return summary;
}

function buildDiagnosticSummaryEvent(report, options = {}) {
  const persisted = Boolean(options.persisted);
  const safeInputState = redactInputState(report?.inputState);
  const safeInputTrace = redactInputTrace(report?.inputTrace);
  const meta = {
    trigger: report.trigger || 'manual',
    reason: report.reason || null,
    type: report.type || 'diagnostic',
    logCount: report.logCount || 0,
    persisted,
  };
  if (options.receiptStatus === 'write-failed') meta.receiptStatus = 'write-failed';
  if (report.logContentPolicy === 'metadata-only') {
    meta.logContentPolicy = 'metadata-only';
    for (const key of ['reportedLogCount', 'retainedLogCount', 'redactedLogCount', 'inputTraceEventCount']) {
      meta[key] = safeInteger(report[key], Number.MAX_SAFE_INTEGER);
    }
    if (isRecord(report.logReceipt)) meta.logReceipt = sanitizeLogReceipt(report.logReceipt);
    if (isRecord(report.inputTraceLoss)) meta.inputTraceLoss = inputTraceLoss(report.inputTraceLoss);
    meta.summaryGapCount = safeInteger(report.summaryGapCount, Number.MAX_SAFE_INTEGER);
    meta.ringDropCount = safeInteger(report.ringDropCount, Number.MAX_SAFE_INTEGER);
    meta.coverageSignals = diagnosticCoverageSignals({
      summaryGapCount: meta.summaryGapCount,
      ringDropCount: meta.ringDropCount,
      inputTraceLoss: meta.inputTraceLoss || {},
    });
    if (report.coverageStatus) meta.coverageStatus = report.coverageStatus;
    const frameTrace = sanitizeFrameTrace(report.traceSummary?.frameTrace);
    if (frameTrace) {
      meta.frameTrace = frameTrace;
      meta.frameTraceLoss = Object.fromEntries(FRAME_TRACE_LOSS_FIELDS.map(key => [key, frameTrace[key] ?? null]));
      meta.frameTraceCoverageLoss = Object.fromEntries(FRAME_TRACE_COVERAGE_FIELDS.map(key => [key, frameTrace[key] ?? null]));
    }
    const diagnosticAdmission = sanitizeDiagnosticAdmission(report.traceSummary?.diagnosticAdmission);
    if (diagnosticAdmission) meta.diagnosticAdmission = diagnosticAdmission;
  }
  if (safeInputState) {
    const gate = safeInputState.effectiveGate || {};
    const recovery = gate.recovery || safeInputState.recovery || {};
    const inputGate = {
      allowed: typeof gate.allowed === 'boolean' ? gate.allowed : null,
      recoveryState: recovery.state || null,
      surfaceState: safeInputState.surface?.state || null,
      pendingMouseReset: typeof safeInputState.pendingMouseReset === 'boolean'
        ? safeInputState.pendingMouseReset : null,
    };
    meta.inputGate = inputGate;
  }
  if (safeInputTrace) {
    const counters = safeInputTrace.counters || {};
    const inputTrace = {};
    ['droppedEvents', 'droppedHashCount', 'expiredPendingAcks'].forEach((key) => {
      if (Number.isSafeInteger(counters[key])) inputTrace[key] = counters[key];
    });
    meta.inputTrace = inputTrace;
  }
  const alerts = deriveDiagnosticAlerts(report, { safeInputState, safeInputTrace });
  if (alerts.length) meta.alerts = alerts;
  return {
    domain: 'viewer',
    event: 'diagnostic_uploaded',
    message: 'Viewer uploaded diagnostic bundle',
    correlation: {
      browserSessionHash: identityHash(report.browserSessionHash || report.browserSessionId),
      attemptHash: identityHash(report.attemptHash || report.connectionAttemptId),
      viewerHash: identityHash(report.viewerHash || report.viewerId),
      socketHash: identityHash(options.socketHash || options.socketId),
    },
    meta,
  };
}

function deriveDiagnosticAlerts(report = {}, { safeInputState = null, safeInputTrace = null } = {}) {
  const alerts = [];
  const reason = String(report.reason || report.traceSummary?.reason || '').trim();
  const transportReasons = new Set(['dc-error', 'dc-stuck', 'ice-disconnected', 'pc-failed', 'pc-disconnected']);
  if (transportReasons.has(reason)) alerts.push(`transport-${reason}`);
  const counters = safeInputTrace?.counters || {};
  // These counters belong to the bounded observer, not desktop delivery. A
  // lifecycle-only session can evict its trace ring without losing any input.
  if (Number(counters.expiredPendingAcks) > 0) alerts.push('input-ack-observation-expired');
  if (Number(counters.droppedEvents) >= 1000) alerts.push('input-trace-truncated');
  if (safeInputState?.pendingMouseReset === true) alerts.push('control-reset-pending');
  if (Array.isArray(report.events)) {
    const hasZeroFps = report.events.some((event) => (
      event && typeof event === 'object' && Number(event.fps) === 0
    ));
    if (hasZeroFps) alerts.push('media-zero-fps');
  }
  return [...new Set(alerts)].slice(0, 8);
}

function ingestDiagnosticPayload(options = {}) {
  const {
    role,
    viewerId,
    userAgent,
    data,
    socketId = null,
    config = loadConfig(),
    logger = console,
  } = options;

  if (role !== 'viewer') {
    return { accepted: false, error: 'viewer-only' };
  }

  if (isRuntimeDiagnostic(data) && (!isRecord(data.captured) || !digestValue(data.diagnosticId))) {
    return { accepted: false, error: 'invalid-runtime-diagnostic' };
  }
  const redacted = redactDiagnosticPayload(data || {});
  const receivedAt = new Date().toISOString();
  const connectionAttemptId = String(redacted.connectionAttemptId || '').trim() || `attempt-${Date.now()}`;
  const logs = Array.isArray(redacted.logs) ? redacted.logs : [];
  const schemaVersion = Number.parseInt(redacted.schemaVersion, 10);
  const traceSummary = redacted.traceSummary && typeof redacted.traceSummary === 'object'
    ? { ...redacted.traceSummary }
    : {
        trigger: redacted.trigger || 'manual',
        reason: redacted.reason || null,
      };
  const trigger = typeof redacted.trigger === 'string' && redacted.trigger
    ? redacted.trigger
    : traceSummary.trigger || 'manual';
  const reason = typeof redacted.reason === 'string' || redacted.reason === null
    ? redacted.reason
    : (traceSummary.reason ?? null);
  const report = {
    type: String(redacted.type || 'diagnostic'),
    schemaVersion: Number.isFinite(schemaVersion) ? schemaVersion : 1,
    receivedAt,
    viewerId,
    userAgent: redacted.userAgent || userAgent || 'unknown',
    screen: redacted.screen || 'unknown',
    browserSessionId: typeof redacted.browserSessionId === 'string' ? redacted.browserSessionId : null,
    connectionAttemptId,
    mode: typeof redacted.mode === 'string' ? redacted.mode : null,
    entrypoint: typeof redacted.entrypoint === 'string' ? redacted.entrypoint : null,
    logCount: logs.length,
    logs,
    keyboardDebug: Array.isArray(redacted.keyboardDebug) ? redacted.keyboardDebug : [],
    trigger,
    reason,
    traceSummary,
    recommendation: redacted.recommendation && typeof redacted.recommendation === 'object'
      ? { ...redacted.recommendation }
      : null,
    events: Array.isArray(redacted.events) ? redacted.events : [],
    network: redacted.network && typeof redacted.network === 'object' ? redacted.network : null,
    inputState: redacted.inputState || null,
    inputTrace: redacted.inputTrace || null,
    probeResults: Array.isArray(redacted.probeResults) ? redacted.probeResults : [],
    inputChannelTimeline: Array.isArray(redacted.inputChannelTimeline) ? redacted.inputChannelTimeline : [],
  };

  if (redacted.diagnosticId && redacted.captured) {
    for (const key of ['diagnosticId', 'captured', 'build', 'latencyStatus', 'latency', 'startup', 'resources', 'scopeEnded', 'truncation',
    'logContentPolicy', 'reportedLogCount', 'retainedLogCount', 'redactedLogCount', 'inputTraceEventCount',
    'logReceipt', 'inputTraceLoss', 'summaryGapCount', 'ringDropCount', 'coverageStatus']) report[key] = redacted[key];
  }

  if (redacted.failureCategory != null) {
    report.failureCategory = redacted.failureCategory;
  }
  if (redacted.latency != null) {
    report.latency = redacted.latency;
  }
  if (redacted.mediaPolicy != null) {
    report.mediaPolicy = redacted.mediaPolicy;
  }
  if (redacted.selectedCandidatePair && typeof redacted.selectedCandidatePair === 'object') {
    report.selectedCandidatePair = redacted.selectedCandidatePair;
  }
  if (redacted.pc && typeof redacted.pc === 'object') {
    report.pc = redacted.pc;
  }
  if (redacted.ice && typeof redacted.ice === 'object') {
    report.ice = redacted.ice;
  }
  if (redacted.candidate != null) {
    report.candidate = redacted.candidate;
  }
  if (redacted.adaptiveMedia && typeof redacted.adaptiveMedia === 'object') {
    report.adaptiveMedia = redacted.adaptiveMedia;
  }
  if (redacted.redaction && typeof redacted.redaction === 'object') {
    report.redaction = redacted.redaction;
  }

  let persisted = false;
  let duplicate = false;
  let receiptStatus = config.enableDiagPersist ? 'write-failed' : 'rejected';
  let eventIdHashes = [];
  if (config.enableDiagPersist) {
    try {
      if (report.diagnosticId) {
        ({ persisted, duplicate, eventIdHashes } = persistDiagnosticOnce(report, { viewerId, receivedAt }));
      } else {
        ({ persisted, duplicate } = diagnosticStore().write(deidentifyPersistedReport(report, viewerId)));
      }
      // A duplicate reuses the canonical accepted receipt so retries remain
      // byte-for-byte stable; the outer result.duplicate flag carries replay.
      receiptStatus = persisted ? 'accepted' : 'write-failed';
    } catch (error) {
      logger.error?.('[DIAGNOSTIC] Failed to write log file:', error.message);
      receiptStatus = 'write-failed';
    }
  }

  return {
    accepted: true,
    connectionAttemptId,
    persisted, duplicate,
    receipt: { accepted: persisted, status: receiptStatus,
      diagnosticId: persisted ? report.diagnosticId || null : null, eventIdHashes: persisted ? eventIdHashes : [] },
    report,
    summaryEvent: duplicate ? null : buildDiagnosticSummaryEvent(report, { persisted, socketId, receiptStatus }),
  };
}

module.exports = {
  redactDiagnosticPayload,
  redactLatency,
  loadDiagnosticReceipts,
  saveDiagnosticReceipts,
  persistDiagnosticOnce,
  getDiagDir,
  persistDiagnostic,
  cleanupDiagLogs,
  loadRecentDiagnostics,
  dedupeDiagnosticsByAttempt,
  buildConnectionSummary,
  buildDiagnosticSummaryEvent,
  deriveDiagnosticAlerts,
  ingestDiagnosticPayload,
};
