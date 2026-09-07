(function attachInputTrace(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = { InputTrace: api };
  root.InputTrace = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createInputTraceApi(root) {
  const MAX_EVENTS = 256;
  const MAX_PENDING_HASHES = 64;
  const MAX_PENDING_ACKS = 256;
  const MAX_ACK_WAIT_MS = 3000;
  const MAX_ACK_RETENTION_MS = 10000;
  const MAX_JSON_BYTES = 64 * 1024;
  const MAX_INPUT_IDS = 64;
  const MAX_ID_LENGTH = 96;
  const MAX_REASON_LENGTH = 64;
  const MAX_RELATIVE_TIME_MS = 10 * 60 * 1000;

  const STAGES = new Set([
    'dom-received', 'gate', 'transport-send', 'ack', 'ack-timeout', 'lifecycle', 'recovery',
  ]);
  const INPUT_TYPES = new Set(['keyboard', 'pointer', 'text', 'control', 'mouse', 'command']);
  const ACTIONS = new Set([
    'key', 'text', 'chord', 'batch', 'down', 'up', 'move', 'wheel', 'reset', 'click', 'ack',
    'focus', 'blur', 'visibility', 'pause', 'resume', 'active', 'inactive', 'recovery',
    'retry', 'discard', 'composition', 'beforeinput', 'input', 'showDock',
  ]);
  const PHASES = new Set([
    'down', 'up', 'move', 'wheel', 'beforeinput', 'input', 'compositionstart', 'compositionupdate',
    'compositionend', 'focus', 'blur', 'hidden', 'visible', 'send', 'accept', 'reject',
  ]);
  const TRANSPORTS = new Set(['datachannel', 'socket', 'none']);
  const FOCUS_KINDS = new Set(['desktop', 'mobile-text', 'local-editor', 'terminal', 'other']);
  const VISIBILITIES = new Set(['visible', 'hidden']);
  const STATES = new Set([
    'idle', 'waiting', 'recovered', 'failed', 'active', 'inactive', 'visible', 'hidden', 'pending',
    'uncertain', 'settled', 'ready', 'blocked', 'revoked', 'reacquire-required', 'paused', 'resumed',
    'reset', 'loading', 'closed',
  ]);
  const SOURCES = new Set(['auto', 'user', 'lifecycle', 'recovery', 'transport', 'manual']);
  const STATUSES = new Set([
    'applied', 'duplicate', 'stale', 'late', 'timeout', 'rejected', 'sequence-gap', 'resync-required',
    'stale-lease', 'invalid-input', 'unsupported-code', 'execution-failed', 'unordered', 'unknown',
    'accepted', 'failed', 'pending', 'ready', 'blocked', 'reacquire-required', 'revoked',
  ]);
  const REASONS = new Set([
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
    'batch-failed', 'reacquire-required', 'reset', 'active', 'inactive', 'focus', 'blur', 'pause',
    'resume', 'draft', 'composition', 'retry', 'discard', 'surface-restore', 'input-gate-unexpected',
    'control-lost', 'disconnect', 'unbind', 'validate-reentry', 'map-reentry', 'nested-reset',
    'outer-reset', 'test-reset', 'input-recovery-timeout', 'down-ack-timeout', 'up-ack-timeout',
    'connection-attempt-changed',
    'datachannel-open', 'datachannel-close', 'datachannel-error', 'manual-pause', 'page-hidden',
    'surface-ack-timeout',
  ]);
  const HEX_HASH = /^[0-9a-f]{16}$/;
  const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;

  function finiteNumber(value, min, max) {
    const number = Number(value);
    return Number.isFinite(number) && number >= min && number <= max ? number : null;
  }

  function integer(value, min, max) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= min && number <= max ? number : null;
  }

  function safeId(value) {
    if (typeof value !== 'string' || value.length < 1 || value.length > MAX_ID_LENGTH) return null;
    return SAFE_ID.test(value) ? value : null;
  }

  function safeEnum(value, allowed) {
    if (typeof value !== 'string') return null;
    return allowed.has(value) ? value : null;
  }

  function safeReason(value) {
    if (typeof value !== 'string' || value.length < 1 || value.length > MAX_REASON_LENGTH) return null;
    if (REASONS.has(value)) return value;
    if (/^media-state:(active|suspended|unknown)$/.test(value)) return value;
    if (/^runtime-phase:(active|suspending|suspended|resuming)$/.test(value)) return value;
    if (/^keyboard-reset-ack-(applied|duplicate|stale|late|rejected|execution-failed|invalid-input|stale-lease)$/.test(value)) {
      return value;
    }
    if (/^ack-(applied|duplicate|stale|late|rejected|execution-failed|invalid-input|stale-lease|unsupported-code|sequence-gap|resync-required)$/.test(value)) {
      return value;
    }
    return null;
  }

  function safeStatus(value) {
    if (typeof value !== 'string') return null;
    return STATUSES.has(value) ? value : null;
  }

  function currentTime(now) {
    try {
      const value = Number(now());
      return Number.isFinite(value) ? value : 0;
    } catch (_error) {
      return 0;
    }
  }

  function byteLength(value) {
    try {
      const Encoder = root?.TextEncoder || (typeof TextEncoder !== 'undefined' ? TextEncoder : null);
      if (Encoder) return new Encoder().encode(value).length;
    } catch (_error) {
      // Fall back to a conservative UTF-16 bound below.
    }
    return String(value).length;
  }

  function defaultHashInputIds(ids) {
    let cryptoObject = null;
    try {
      cryptoObject = root?.crypto || (typeof crypto !== 'undefined' ? crypto : null);
    } catch (_error) {
      cryptoObject = null;
    }
    if (!cryptoObject?.subtle || typeof cryptoObject.subtle.digest !== 'function') return null;
    try {
      const Encoder = root?.TextEncoder || (typeof TextEncoder !== 'undefined' ? TextEncoder : null);
      if (!Encoder) return null;
      const bytes = new Encoder().encode(ids.join('\x1f'));
      return Promise.resolve(cryptoObject.subtle.digest('SHA-256', bytes)).then((digest) => {
        let bytesView;
        try {
          bytesView = new Uint8Array(digest);
        } catch (_error) {
          return null;
        }
        let hex = '';
        for (const byte of bytesView) hex += byte.toString(16).padStart(2, '0');
        return hex.slice(0, 16);
      });
    } catch (_error) {
      return null;
    }
  }

  function create(options) {
    const config = options || {};
    const now = typeof config.now === 'function'
      ? config.now
      : () => (typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now() : Date.now());
    const setTimeoutFn = typeof config.setTimeoutFn === 'function'
      ? config.setTimeoutFn
      : (typeof setTimeout === 'function' ? setTimeout : () => null);
    const clearTimeoutFn = typeof config.clearTimeoutFn === 'function'
      ? config.clearTimeoutFn
      : (typeof clearTimeout === 'function' ? clearTimeout : () => {});
    const hashInputIds = Object.prototype.hasOwnProperty.call(config, 'hashInputIds')
      ? config.hashInputIds
      : defaultHashInputIds;
    const onIncident = typeof config.onIncident === 'function' ? config.onIncident : () => {};

    const events = [];
    const pendingHashes = new Map();
    const ackRecords = new Map();
    const counters = {
      droppedEvents: 0,
      sampledEvents: 0,
      hashUnavailable: 0,
      droppedHashCount: 0,
      pendingHashCount: 0,
      pendingAckCount: 0,
      evictedPendingAcks: 0,
      expiredPendingAcks: 0,
      ackTimeoutCount: 0,
      incidentCallbackErrors: 0,
      mouseMoveCount: 0,
      wheelCount: 0,
    };
    let eventSequence = 0;
    let hashSequence = 0;
    let traceOrigin = null;
    let deadlineTimer = null;

    function safeNow() {
      return currentTime(now);
    }

    function relativeTime() {
      const current = safeNow();
      if (traceOrigin === null) traceOrigin = current;
      return Math.max(0, Math.min(MAX_RELATIVE_TIME_MS, Math.round(current - traceOrigin)));
    }

    function publicCounters() {
      return {
        ...counters,
        pendingHashCount: pendingHashes.size,
        pendingAckCount: [...ackRecords.values()].filter((record) => !record.timedOut).length,
      };
    }

    function publicEvent(event) {
      const copy = {};
      for (const key of [
        'eventId', 'stage', 'at', 'inputType', 'action', 'phase', 'transport', 'accepted', 'reason',
        'status', 'seq', 'appliedSeq', 'leaseEpoch', 'connectionAttemptId', 'inputIdHash', 'inputIdCount',
        'clientRttMs', 'focusKind', 'visibility', 'state', 'source', 'generation', 'gateAllowed',
        'surfaceState', 'recoveryState', 'pendingMouseReset', 'desktopWriteRecoveryState',
      ]) {
        if (Object.prototype.hasOwnProperty.call(event, key)) copy[key] = event[key];
      }
      return copy;
    }

    function snapshotObject() {
      return {
        schemaVersion: 1,
        events: events.map(publicEvent),
        counters: publicCounters(),
      };
    }

    function removeHashJobsForEvent(event) {
      // A ring eviction only removes the public event. The digest promise is
      // still in flight and must retain its bounded concurrency slot until it
      // settles; queueHash() will discard the result when the event is gone.
      void event;
    }

    function trimToBounds() {
      while (events.length > MAX_EVENTS) {
        removeHashJobsForEvent(events.shift());
        counters.droppedEvents += 1;
      }
      let serialized;
      try {
        serialized = JSON.stringify(snapshotObject());
      } catch (_error) {
        serialized = '';
      }
      while (byteLength(serialized) > MAX_JSON_BYTES && events.length) {
        removeHashJobsForEvent(events.shift());
        counters.droppedEvents += 1;
        try {
          serialized = JSON.stringify(snapshotObject());
        } catch (_error) {
          serialized = '';
        }
      }
    }

    function append(event) {
      events.push(event);
      trimToBounds();
      return event;
    }

    function queueHash(event, inputIds) {
      if (!inputIds.length) return;
      if (typeof hashInputIds !== 'function' || pendingHashes.size >= MAX_PENDING_HASHES) {
        if (pendingHashes.size >= MAX_PENDING_HASHES) counters.droppedHashCount += 1;
        if (typeof hashInputIds !== 'function') counters.hashUnavailable += 1;
        return;
      }
      const jobId = ++hashSequence;
      pendingHashes.set(jobId, { event });
      counters.pendingHashCount = pendingHashes.size;
      let result;
      try {
        result = hashInputIds(inputIds.slice());
      } catch (_error) {
        result = null;
      }
      Promise.resolve(result).then((hash) => {
        const job = pendingHashes.get(jobId);
        if (!job) return;
        pendingHashes.delete(jobId);
        counters.pendingHashCount = pendingHashes.size;
        if (!events.includes(job.event)) return;
        if (typeof hash === 'string' && HEX_HASH.test(hash.slice(0, 16).toLowerCase())) {
          job.event.inputIdHash = hash.slice(0, 16).toLowerCase();
        } else {
          counters.hashUnavailable += 1;
        }
      }, () => {
        const job = pendingHashes.get(jobId);
        if (!job) return;
        pendingHashes.delete(jobId);
        counters.pendingHashCount = pendingHashes.size;
        if (events.includes(job.event)) counters.hashUnavailable += 1;
      });
    }

    function safeInputIds(value) {
      if (!Array.isArray(value)) return [];
      return value.slice(0, MAX_INPUT_IDS).map(safeId).filter(Boolean);
    }

    function isHighFrequency(inputType, action) {
      return action === 'move' || action === 'wheel'
        || (inputType === 'pointer' && (action === 'pointermove' || action === 'pointerwheel'));
    }

    function normalizeEvent(stage, meta, assignedEventId = null) {
      const source = meta && typeof meta === 'object' ? meta : {};
      const event = {
        stage,
        at: relativeTime(),
      };
      const eventId = assignedEventId || integer(source.eventId, 1, Number.MAX_SAFE_INTEGER);
      if (eventId !== null) event.eventId = eventId;
      const inputType = safeEnum(source.inputType, INPUT_TYPES);
      if (inputType) event.inputType = inputType;
      const action = safeEnum(source.action, ACTIONS);
      if (action) event.action = action;
      const phase = safeEnum(source.phase, PHASES);
      if (phase) event.phase = phase;
      const transport = safeEnum(source.transport, TRANSPORTS);
      if (transport) event.transport = transport;
      if (typeof source.accepted === 'boolean') event.accepted = source.accepted;
      const reason = safeReason(source.reason);
      if (reason) event.reason = reason;
      const status = safeStatus(source.status);
      if (status) event.status = status;
      const seq = integer(source.seq, 0, 0x7fffffff);
      if (seq !== null) event.seq = seq;
      const appliedSeq = integer(source.appliedSeq, 0, 0x7fffffff);
      if (appliedSeq !== null) event.appliedSeq = appliedSeq;
      const leaseEpoch = integer(source.leaseEpoch, 0, 0x7fffffff);
      if (leaseEpoch !== null) event.leaseEpoch = leaseEpoch;
      const connectionAttemptId = safeId(source.connectionAttemptId);
      if (connectionAttemptId) event.connectionAttemptId = connectionAttemptId;
      const clientRttMs = finiteNumber(source.clientRttMs, 0, MAX_ACK_RETENTION_MS);
      if (clientRttMs !== null) event.clientRttMs = Math.round(clientRttMs * 100) / 100;
      const focusKind = safeEnum(source.focusKind, FOCUS_KINDS);
      if (focusKind) event.focusKind = focusKind;
      const visibility = safeEnum(source.visibility, VISIBILITIES);
      if (visibility) event.visibility = visibility;
      const state = safeEnum(source.state, STATES);
      if (state) event.state = state;
      const sourceName = safeEnum(source.source, SOURCES);
      if (sourceName) event.source = sourceName;
      const generation = integer(source.generation, 0, 0x7fffffff);
      if (generation !== null) event.generation = generation;
      if (typeof source.gateAllowed === 'boolean') event.gateAllowed = source.gateAllowed;
      const surfaceState = safeEnum(source.surfaceState, STATES);
      if (surfaceState) event.surfaceState = surfaceState;
      const recoveryState = safeEnum(source.recoveryState, STATES);
      if (recoveryState) event.recoveryState = recoveryState;
      const desktopWriteRecoveryState = safeEnum(source.desktopWriteRecoveryState, STATES);
      if (desktopWriteRecoveryState) event.desktopWriteRecoveryState = desktopWriteRecoveryState;
      if (typeof source.pendingMouseReset === 'boolean') event.pendingMouseReset = source.pendingMouseReset;
      const inputIdCount = integer(source.inputIdCount, 0, MAX_INPUT_IDS);
      if (inputIdCount !== null) event.inputIdCount = inputIdCount;
      return event;
    }

    function pendingAckCount() {
      return [...ackRecords.values()].filter((record) => !record.timedOut).length;
    }

    function invokeIncident(record, reason = 'input-ack-timeout') {
      if (record.incidentEligible !== true) return;
      try {
        onIncident(reason, {
          connectionAttemptId: record.connectionAttemptId || null,
          leaseEpoch: record.leaseEpoch ?? null,
        });
      } catch (_error) {
        counters.incidentCallbackErrors += 1;
      }
    }

    function scheduleDeadlineTimer() {
      if (deadlineTimer !== null) {
        try { clearTimeoutFn(deadlineTimer); } catch (_error) { /* noop */ }
        deadlineTimer = null;
      }
      let due = null;
      for (const record of ackRecords.values()) {
        const candidate = record.timedOut ? record.expiresAt : record.deadline;
        if (due === null || candidate < due) due = candidate;
      }
      if (due === null) return;
      try {
        deadlineTimer = setTimeoutFn(() => {
          deadlineTimer = null;
          processDeadlines();
        }, Math.max(0, due - safeNow()));
        // Node's Timeout exposes unref(); keeping an offline unit-test process
        // alive for a diagnostic deadline would be an observable side effect.
        deadlineTimer?.unref?.();
      } catch (_error) {
        deadlineTimer = null;
      }
    }

    function processDeadlines() {
      const current = safeNow();
      for (const [inputId, record] of ackRecords) {
        if (!record.timedOut && current >= record.deadline) {
          record.timedOut = true;
          counters.ackTimeoutCount += 1;
          const timeoutEvent = normalizeEvent('ack-timeout', {
            eventId: record.eventId,
            inputType: record.inputType,
            action: record.action,
            accepted: false,
            status: 'timeout',
            seq: record.seq,
            leaseEpoch: record.leaseEpoch,
            connectionAttemptId: record.connectionAttemptId,
            inputIdCount: 1,
          });
          timeoutEvent.inputIdCount = 1;
          append(timeoutEvent);
          invokeIncident(record);
        }
        if (current >= record.expiresAt) {
          ackRecords.delete(inputId);
          counters.expiredPendingAcks += 1;
        }
      }
      counters.pendingAckCount = pendingAckCount();
      scheduleDeadlineTimer();
    }

    function addAckWaiter(event, source, inputIds) {
      if (source.accepted !== true || !inputIds.length || isHighFrequency(source.inputType, source.action)
        || source.reliable === false) return;
      const createdAt = safeNow();
      const record = {
        eventId: event.eventId || null,
        inputType: event.inputType || null,
        action: event.action || null,
        seq: event.seq ?? null,
        leaseEpoch: event.leaseEpoch ?? null,
        connectionAttemptId: event.connectionAttemptId || null,
        createdAt,
        deadline: createdAt + Math.min(MAX_ACK_WAIT_MS, Math.max(0, Number(source.ackTimeoutMs) || MAX_ACK_WAIT_MS)),
        expiresAt: createdAt + MAX_ACK_RETENTION_MS,
        timedOut: false,
        incidentEligible: source.incidentEligible !== false && source.action !== 'reset',
      };
      inputIds.forEach((inputId) => ackRecords.set(inputId, record));
      while (ackRecords.size > MAX_PENDING_ACKS) {
        const oldest = ackRecords.keys().next().value;
        ackRecords.delete(oldest);
        counters.evictedPendingAcks += 1;
      }
      counters.pendingAckCount = pendingAckCount();
      scheduleDeadlineTimer();
    }

    function findAckRecords(inputIds, event) {
      const found = [];
      const seen = new Set();
      inputIds.forEach((inputId) => {
        const record = ackRecords.get(inputId);
        const sameType = record?.inputType === (event?.inputType || null);
        const sameEpoch = (record?.leaseEpoch ?? null) === (event?.leaseEpoch ?? null);
        const sameAttempt = (record?.connectionAttemptId || null) === (event?.connectionAttemptId || null);
        if (record && sameType && sameEpoch && sameAttempt && !seen.has(record)) {
          found.push(record);
          seen.add(record);
        }
      });
      return found;
    }

    function addHashToEvent(event, inputIds) {
      if (!inputIds.length) return;
      event.inputIdCount = inputIds.length;
      event.inputIdHash = null;
      queueHash(event, inputIds);
    }

    function record(stage, meta = {}) {
      try {
        if (!STAGES.has(stage)) return null;
        const source = meta && typeof meta === 'object' ? meta : {};
        const inputType = safeEnum(source.inputType, INPUT_TYPES);
        const action = safeEnum(source.action, ACTIONS);
        if (isHighFrequency(inputType, action)) {
          counters.sampledEvents += 1;
          if (action === 'move') counters.mouseMoveCount += 1;
          if (action === 'wheel') counters.wheelCount += 1;
          return integer(source.eventId, 1, Number.MAX_SAFE_INTEGER);
        }

        let eventId = integer(source.eventId, 1, Number.MAX_SAFE_INTEGER);
        if (stage === 'dom-received') eventId = ++eventSequence;
        const event = normalizeEvent(stage, source, eventId);
        const inputIds = safeInputIds(source.inputIds);
        if (inputIds.length) addHashToEvent(event, inputIds);
        const matchingAcks = stage === 'ack' ? findAckRecords(inputIds, event) : [];
        if (matchingAcks.length && event.eventId === undefined) {
          event.eventId = matchingAcks[0].eventId || undefined;
        }
        append(event);

        if (stage === 'transport-send') addAckWaiter(event, source, inputIds);
        if (stage === 'ack') {
          const matching = matchingAcks;
          const late = matching.some((item) => item.timedOut);
          const actualStatus = safeStatus(source.status) || 'unknown';
          event.status = actualStatus;
          event.accepted = typeof source.accepted === 'boolean' ? source.accepted
            : actualStatus === 'applied' || actualStatus === 'duplicate';
          if (late) event.reason = 'late-ack';
          const current = safeNow();
          if (matching.length) {
            const rtt = matching.reduce((smallest, item) => Math.min(smallest, current - item.createdAt), Infinity);
            if (Number.isFinite(rtt)) event.clientRttMs = Math.max(0, Math.min(MAX_ACK_RETENTION_MS, Math.round(rtt * 100) / 100));
            matching.forEach((item) => {
              for (const [inputId, candidate] of ackRecords) if (candidate === item) ackRecords.delete(inputId);
            });
          }
          counters.pendingAckCount = pendingAckCount();
          scheduleDeadlineTimer();
        }
        if (stage === 'gate' && source.accepted === false
          && source.unexpected === true && source.incidentEligible === true) {
          invokeIncident({
            incidentEligible: true,
            connectionAttemptId: event.connectionAttemptId || null,
            leaseEpoch: event.leaseEpoch ?? null,
          }, 'input-gate-unexpected');
        }
        return stage === 'dom-received' ? event.eventId : (event.eventId || null);
      } catch (_error) {
        return null;
      }
    }

    function snapshot() {
      try {
        trimToBounds();
        const result = snapshotObject();
        // Return a detached structure so consumers cannot mutate the ring or
        // expose internal correlation state through object references.
        return JSON.parse(JSON.stringify(result));
      } catch (_error) {
        return { schemaVersion: 1, events: [], counters: publicCounters() };
      }
    }

    function dispose() {
      if (deadlineTimer !== null) {
        try { clearTimeoutFn(deadlineTimer); } catch (_error) { /* noop */ }
        deadlineTimer = null;
      }
      pendingHashes.clear();
      ackRecords.clear();
      counters.pendingHashCount = 0;
      counters.pendingAckCount = 0;
    }

    return { record, snapshot, dispose };
  }

  return { create };
}));
