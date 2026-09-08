const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');

const DIAG_MAX_AGE_DAYS = 7;
const DIAG_MAX_PER_VIEWER = 3;
const DIAG_MAX_TOTAL = 50;

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
  'no-active-control', 'inactive', 'viewport-unsupported', 'media-gate', 'manual-disconnect',
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
  copyInteger('at', 10 * 60 * 1000);
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
  if (typeof event.connectionAttemptId === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(event.connectionAttemptId)) {
    clean.connectionAttemptId = event.connectionAttemptId;
  }
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

function getDiagDir() {
  // Prefer a stable absolute path so operators/agents can find uploads without
  // chasing macOS per-user os.tmpdir() folders. Override with WRD_DIAG_DIR.
  const override = String(process.env.WRD_DIAG_DIR || '').trim();
  if (override) return path.resolve(override);
  return path.join('/tmp', 'wrd-diag');
}

function persistDiagnostic(filename, report) {
  const dir = getDiagDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(report, null, 2), 'utf8');
}

function cleanupDiagLogs(logger = console) {
  const dir = getDiagDir();
  try {
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const filePath = path.join(dir, name);
        const stat = fs.statSync(filePath);
        return { name, filePath, mtimeMs: stat.mtimeMs };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs);

    const now = Date.now();
    const maxAgeMs = DIAG_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    for (const file of files) {
      if (now - file.mtimeMs > maxAgeMs) {
        fs.unlinkSync(file.filePath);
      }
    }

    const remaining = fs.readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const filePath = path.join(dir, name);
        const stat = fs.statSync(filePath);
        const viewerId = name.replace(/^.+_/, '').replace('.json', '');
        return { name, filePath, viewerId, mtimeMs: stat.mtimeMs };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs);

    const viewerCounts = {};
    for (const file of remaining) {
      viewerCounts[file.viewerId] = (viewerCounts[file.viewerId] || 0) + 1;
      if (viewerCounts[file.viewerId] > DIAG_MAX_PER_VIEWER) {
        fs.unlinkSync(file.filePath);
        viewerCounts[file.viewerId] -= 1;
      }
    }

    const finalFiles = fs.readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const filePath = path.join(dir, name);
        return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs);

    while (finalFiles.length > DIAG_MAX_TOTAL) {
      const oldest = finalFiles.shift();
      fs.unlinkSync(oldest.filePath);
    }
  } catch (error) {
    logger.error?.('[DIAGNOSTIC] cleanup failed:', error.message);
  }
}

function loadRecentDiagnostics(limit = 50, options = {}) {
  const dir = getDiagDir();
  if (!fs.existsSync(dir)) {
    return [];
  }
  const logger = options.logger || console;

  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) => {
      const filePath = path.join(dir, name);
      try {
        return [{
          name,
          filePath,
          mtimeMs: fs.statSync(filePath).mtimeMs,
        }];
      } catch (error) {
        logger.warn?.(`[DIAGNOSTIC] Skip unreadable file ${name}: ${error.message}`);
        return [];
      }
    })
    .sort((a, b) => {
      if (b.mtimeMs !== a.mtimeMs) {
        return b.mtimeMs - a.mtimeMs;
      }
      return b.name.localeCompare(a.name);
    })
    .slice(0, Math.max(0, Number(limit) || 0))
    .flatMap((entry) => {
      try {
        return [JSON.parse(fs.readFileSync(entry.filePath, 'utf8'))];
      } catch (error) {
        logger.warn?.(`[DIAGNOSTIC] Skip malformed file ${entry.name}: ${error.message}`);
        return [];
      }
    });
}

function dedupeDiagnosticsByAttempt(items = []) {
  const deduped = [];
  const seenAttemptIds = new Set();

  items.forEach((item, index) => {
    const rawAttemptId = String(item?.connectionAttemptId || '').trim();
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
  return {
    domain: 'viewer',
    event: 'diagnostic_uploaded',
    message: 'Viewer uploaded diagnostic bundle',
    correlation: {
      browserSessionId: report.browserSessionId || null,
      connectionAttemptId: report.connectionAttemptId || null,
      viewerId: report.viewerId || null,
      socketId: options.socketId || null,
    },
    meta,
  };
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
  if (config.enableDiagPersist) {
    try {
      cleanupDiagLogs(logger);
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `${ts}_${viewerId}.json`;
      persistDiagnostic(filename, report);
      persisted = true;
      logger.log?.(`[DIAGNOSTIC] Saved → ${path.join(getDiagDir(), filename)}`);
    } catch (error) {
      logger.error?.('[DIAGNOSTIC] Failed to write log file:', error.message);
    }
  }

  return {
    accepted: true,
    connectionAttemptId,
    report,
    summaryEvent: buildDiagnosticSummaryEvent(report, { persisted, socketId }),
  };
}

module.exports = {
  redactDiagnosticPayload,
  getDiagDir,
  persistDiagnostic,
  cleanupDiagLogs,
  loadRecentDiagnostics,
  dedupeDiagnosticsByAttempt,
  buildConnectionSummary,
  buildDiagnosticSummaryEvent,
  ingestDiagnosticPayload,
};
