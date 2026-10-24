// A passive, bounded observer. Control delivery never depends on this collector.
const LATENCY_METRIC_NAMES = Object.freeze([
  'frontendDispatchMs', 'inputAckRttMs', 'inputAckArrivalRttMs', 'inputAckValidationMs',
  'hostAdapterAwaitMs', 'hostQueueMs', 'hostApplyMs',
  'signalForwardMs', 'signalAckForwardMs', 'inputToFrameNoticeMs',
  'inputToPostApplyFrameMs', 'inputToVisibleEffectMs', 'relayFrameAckRttMs',
  'paintIntervalMs', 'freshFrameAgeMs', 'candidateRttMs', 'jitterBufferMs', 'decodeMs',
  'recvBytes', 'elapsedMs', 'captureGrabMs', 'captureAgeAtRecvMs', 'capturePrepareMs',
  'frameConvertMs', 'imgprocQueueMs', 'imgprocBuildMs', 'encoderMs', 'packetizeMs',
  'encodeTotalMs', 'rtpApiAwaitMs',
]);
const createLatencyMonitor = (options = {}) => {
  const schedule = options.schedule || ((fn, ms) => setTimeout(fn, ms));
  const cancel = options.cancel || (id => clearTimeout(id));
  let syncTimeout = null, syncRetry = null;
  const stopSyncTimers = () => {
    if (syncTimeout !== null) cancel(syncTimeout);
    if (syncRetry !== null) cancel(syncRetry);
    syncTimeout = syncRetry = null;
  };
  const now = options.now || (() => typeof performance !== 'undefined' ? performance.now() : 0);
  const valid = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const unorderedAckStatuses = new Set(['applied', 'duplicate', 'stale-lease', 'sequence-gap',
    'resync-required', 'invalid-input', 'unsupported-code', 'execution-failed']);
  const validId = id => typeof id === 'string' && /^[\x20-\x7e]{1,128}$/.test(id);
  const sameScope = (a, b) => a === b || Boolean(a && b
    && a.connectionAttemptId === b.connectionAttemptId && a.generation === b.generation && a.leaseEpoch === b.leaseEpoch);
  const copyScope = s => s ? { connectionAttemptId: s.connectionAttemptId, generation: s.generation, leaseEpoch: s.leaseEpoch } : null;
  const blankOutcomes = () => Object.fromEntries(['sent', 'acked', 'rejected', 'timedOut', 'late', 'cancelled', 'dropped', 'unmatched'].map(k => [k, 0]));
  let scope = null, outcomes = blankOutcomes(), lastNow = -Infinity, lastPaint = null, freshAt = null, mediaActive = true;
  // M2 currently validates only the video stream. Keep one bounded high-water
  // mark per scope, including across pauses and sparse collector recreation.
  let freshCaptureSeq = -1, mediaSince = -Infinity;
  let metrics = new Map(LATENCY_METRIC_NAMES.map(k => [k, []]));
  const pending = new Map(), tombstones = new Map();
  let closed = [], closedDropped = 0, sync = null, lastSync = null;
  const inc = (key, count = 1) => { outcomes[key] = Math.min(Number.MAX_SAFE_INTEGER, outcomes[key] + count); };
  const clock = value => {
    const t = value === undefined ? now() : value;
    if (!valid(t) || t < lastNow) return null;
    lastNow = t;
    return t;
  };
  const totalSamples = () => [...metrics.values()].reduce((sum, rows) => sum + rows.length, 0);
  // Bound serialized metadata separately from engine/object heap overhead.
  const sampleBytes = () => [...metrics.values()].reduce((sum, rows) => sum + rows.reduce((n, row) => n + row.bytes, 0), 0);
  const trimClosed = t => {
    while (closed.length && (closed.length > 4 || t - closed[0].endedAtMs >= 60000 || JSON.stringify(closed).length > 32768)) {
      closed.shift(); closedDropped = Math.min(Number.MAX_SAFE_INTEGER, closedDropped + 1);
    }
  };
  // Keys may contain quotes/backslashes: use their actual JSON length. The
  // fixed record allowance exceeds all retained scalar fields, including late.
  const metadataBytes = () => sampleBytes() + [pending, tombstones].reduce((total, map) => total
    + [...map.values()].reduce((sum, record) => sum + record.metadataBytes, 0), 0)
    + JSON.stringify(closed).length + JSON.stringify(scope).length + 2048;
  const enforceMetadataBudget = () => {
    while (metadataBytes() > 1048576) {
      const populated = [...metrics.values()].filter(rows => rows.length);
      if (populated.length) {
        populated.reduce((a, b) => a[0].at <= b[0].at ? a : b).shift();
      } else if (tombstones.size) {
        tombstones.delete(tombstones.keys().next().value);
      } else if (pending.size) {
        pending.delete(pending.keys().next().value); inc('unmatched');
      } else break;
      inc('dropped');
    }
  };
  const remember = (id, record, state, t) => {
    tombstones.set(id, { ...record, state, ended: t });
    while (tombstones.size > 1024) { tombstones.delete(tombstones.keys().next().value); inc('dropped'); }
    enforceMetadataBudget();
  };
  const expire = t => {
    for (const rows of metrics.values()) while (rows.length && t - rows[0].at >= 5000) rows.shift();
    for (const [id, record] of pending) if (t - record.sent >= 10000) {
      pending.delete(id); inc('timedOut'); remember(id, record, 'timedOut', t);
    }
    for (const [id, record] of tombstones) if (t - record.ended >= 30000) tombstones.delete(id);
    if (sync && t - sync.v0 >= 2000) sync = null;
    if (lastSync && t - lastSync.at >= 60000) lastSync = null;
    trimClosed(t);
  };
  const summary = (rows, t) => {
    if (!rows.length) return { last: null, p50: null, p95: null, count: 0, available: false, lastSampleAgeMs: null };
    const values = rows.map(r => r.value).sort((a, b) => a - b);
    return { last: rows.at(-1).value, p50: values[Math.floor(values.length * .5)], p95: values[Math.min(values.length - 1, Math.floor(values.length * .95))], count: rows.length, available: true, lastSampleAgeMs: t - rows.at(-1).at };
  };
  const push = (name, value, t, key) => {
    if (!valid(value) || !metrics.has(name) || !validId(key)) return false;
    const rows = metrics.get(name);
    if (rows.some(r => r.key === key)) return false;
    rows.push({ value, at: t, key, bytes: JSON.stringify({ value, at: t, key }).length + 32 });
    rows.sort((a, b) => a.at - b.at);
    if (rows.length > 256) { rows.shift(); inc('dropped'); }
    while (totalSamples() > 4096 || sampleBytes() > 589824) {
      const oldest = [...metrics.values()].filter(r => r.length).reduce((a, b) => a[0].at <= b[0].at ? a : b);
      oldest.shift(); inc('dropped');
    }
    enforceMetadataBudget();
    return true;
  };
  // One diagnostic slot, independent of the product pending ledger and M1 clock.
  // Only fixed scalar projections are serializable; transport references stay here.
  let controlled = null;
  const controlledActions = {
    mouse: new Set(['move', 'down', 'up', 'wheel']),
    keyboard: new Set(['text']),
  };
  const controlledScopeValid = s => Boolean(s && validId(s.connectionAttemptId)
    && Number.isSafeInteger(s.generation) && s.generation >= 0
    && Number.isSafeInteger(s.leaseEpoch) && s.leaseEpoch >= 0);
  const controlledInc = name => {
    controlled.counters[name] = Math.min(Number.MAX_SAFE_INTEGER, controlled.counters[name] + 1);
  };
  const controlledFail = reason => {
    if (!controlled.error) controlled.error = reason;
    controlled.finalized = true;
    return false;
  };
  const controlledReject = reason => {
    controlledInc('invalidObservations');
    return reason ? controlledFail(reason) : false;
  };
  const controlledGuard = (fallback, fn) => {
    try { return fn(); } catch (_) {
      if (controlled) { controlledInc('invalidObservations'); controlledFail('observation-error'); }
      return fallback;
    }
  };
  const controlledTime = () => {
    const t = now();
    if (!valid(t) || (controlled && t < controlled.processingAtMs)) {
      if (controlled) controlledReject('clock-invalid');
      return null;
    }
    if (controlled) {
      controlled.processingAtMs = t;
      controlled.expired = t >= controlled.deadlineAtMs;
      if (controlled.expired) controlled.finalized = true;
    }
    return t;
  };
  const controlledEventTime = (event, t) => valid(event) && event <= t
    && event >= (controlled.send?.viewerClockMs ?? controlled.beganAtMs);
  const controlledIdentity = (current, observation = false) => {
    const fail = reason => observation ? controlledReject(reason) : controlledFail(reason);
    if (!controlledScopeValid(current.scope) || !sameScope(controlled.scope, current.scope)
        || !sameScope(scope, controlled.scope) || current.streamId !== controlled.streamId) return fail('scope-changed');
    if (current.leaseId !== controlled.leaseId) return fail('lease-changed');
    if (!current.live || (current.pc !== null && (typeof current.pc !== 'object' || !current.pc)) || current.pc !== current.live.pc) return fail('source-changed');
    if (!controlled.refs) return true;
    const r = controlled.refs, live = current.live;
    if (current.pc !== r.pc) return fail('source-changed');
    if (r.transport === 'datachannel') {
      const selected = controlled.inputType === 'mouse' && controlled.action === 'move'
        ? live.datachannel?.selectedMoveSendSource : live.datachannel?.selectedReliableSendSource;
      if (selected !== r.sendSource || live.datachannel?.reliableAckSource !== r.ackSource) return fail('source-changed');
    } else if (live.socket?.selectedSendSource !== r.sendSource
        || live.socket?.reliableAckSource !== r.ackSource
        || live.socket?.object !== r.socket || live.socket?.id !== r.socketId) return fail('source-changed');
    return true;
  };
  const controlledProjection = t => {
    const c = controlled;
    const missing = !c.send ? 'not-sent' : !c.ack ? 'ack-missing' : !c.postApply ? 'post-apply-missing' : null;
    const reason = c.error || c.terminalReason || missing || (c.expired && !c.completed ? 'expired' : 'none');
    return {
      schemaVersion: 1,
      state: reason === 'none' ? 'COMPLETE' : c.finalized ? 'INCOMPLETE' : 'PENDING', reason,
      inputId: c.inputId, leaseId: c.leaseId, scope: copyScope(c.scope), streamId: c.streamId,
      beganAtMs: c.beganAtMs, deadlineAtMs: c.deadlineAtMs,
      remainingMs: Math.max(0, c.deadlineAtMs - t), finalized: c.finalized, expired: c.expired,
      send: c.send ? { ...c.send } : null, ack: c.ack ? { ...c.ack } : null,
      postApply: c.postApply ? { ...c.postApply } : null,
      hostTiming: { ...c.hostTiming }, observationCounters: { ...c.counters },
    };
  };
  const controlledBudget = t => {
    if (JSON.stringify(controlledProjection(t)).length <= 8192) return true;
    // Drop observations on overflow, retaining only the bounded reservation/error.
    controlled.send = controlled.ack = controlled.postApply = controlled.ackKey = controlled.refs = null;
    return controlledReject('metadata-cap');
  };
  const controlledRow = viewerClockMs => ({ inputId: controlled.inputId, viewerClockMs,
    attemptId: controlled.scope.connectionAttemptId, generation: controlled.scope.generation,
    streamId: controlled.streamId });
  const observeControlledFrame = (row, context) => controlledGuard(false, () => {
    if (!controlled || !Array.isArray(row.inputIds) || !row.inputIds.includes(controlled.inputId)) return false;
    const t = controlledTime();
    if (t === null || controlled.finalized) return false;
    if (!sameScope(controlled.scope, context.scope) || !sameScope(controlled.scope, row.scope)
        || !sameScope(scope, controlled.scope) || row.streamId !== controlled.streamId) return controlledReject('scope-changed');
    if (!controlled.send) return controlledReject();
    if (!controlledEventTime(row.viewerClockMs, t)) return controlledReject('clock-invalid');
    if (row.traceStatus !== 'matched' || row.captureFresh !== true || row.captureAfterApplied !== true
        || !Number.isSafeInteger(row.captureSeq) || row.captureSeq < 0
        || ![row.rtpTimestamp, row.wireTimestamp, row.rtpOrigin].every(v => Number.isSafeInteger(v) && v >= 0 && v <= 0xffffffff)
        || t - row.viewerClockMs >= 2000) return controlledReject();
    // M2 may join before ACK. Its presentation clock remains independent of ACK arrival.
    if (controlled.postApply) return false;
    controlled.postApply = { ...controlledRow(row.viewerClockMs), captureSeq: row.captureSeq,
      rtpTimestamp: row.rtpTimestamp, wireTimestamp: row.wireTimestamp, rtpOrigin: row.rtpOrigin,
      traceStatus: 'matched', captureFresh: true, captureAfterApplied: true };
    return controlledBudget(t);
  });
  let serial = 0;
  const api = {
    init() {},
    beginControlledInputEvidence(reservation) {
      return controlledGuard(false, () => {
        if (controlled) return false;
        if (!reservation || !validId(reservation.inputId) || !validId(reservation.leaseId)
            || !controlledScopeValid(reservation.scope) || !sameScope(scope, reservation.scope)
            || reservation.streamId !== 'video' || !controlledActions[reservation.inputType]?.has(reservation.action)) return false;
        const t = controlledTime(); if (t === null) return false;
        const deadlineAtMs = t + 10000;
        if (!valid(deadlineAtMs) || deadlineAtMs <= t) return false;
        controlled = { inputId: reservation.inputId, leaseId: reservation.leaseId,
          scope: copyScope(reservation.scope), streamId: reservation.streamId,
          inputType: reservation.inputType, action: reservation.action,
          beganAtMs: t, deadlineAtMs, processingAtMs: t,
          finalized: false, expired: false, completed: false, error: null, terminalReason: null,
          send: null, ack: null, postApply: null, refs: null, ackKey: null,
          hostTiming: { hostAdapterAwaitMs: null, hostQueueMs: null, hostApplyMs: null },
          counters: { duplicateAcks: 0, invalidObservations: 0 } };
        return controlledBudget(t);
      });
    },
    observeControlledSend(meta, context) {
      return controlledGuard(false, () => {
        if (!controlled || meta?.inputId !== controlled.inputId) return false;
        const t = controlledTime(); if (t === null || controlled.finalized) return false;
        if (meta.inputType !== controlled.inputType || meta.action !== controlled.action) return controlledReject('conflicting-observation');
        if (!controlledIdentity({ ...context, leaseId: meta.leaseId }, true)) return false;
        if (meta.leaseEpoch !== controlled.scope.leaseEpoch) return controlledReject('scope-changed');
        if (!controlledEventTime(context.viewerClockMs, t)) return controlledReject('clock-invalid');
        const move = controlled.inputType === 'mouse' && controlled.action === 'move';
        if (move ? meta.seq !== null : !Number.isSafeInteger(meta.seq) || meta.seq <= 0) return controlledReject();
        if (controlled.send) return controlledReject('conflicting-observation');
        if (!['socket', 'datachannel'].includes(context.transport)
            || !context.sendSource || typeof context.sendSource !== 'object'
            || !context.ackSource || typeof context.ackSource !== 'object') return controlledReject('source-changed');
        const socket = context.transport === 'socket' ? context.live.socket : null;
        if (socket && (!validId(context.socketId) || context.socketId !== socket.id
            || socket.object !== context.sendSource || socket.object !== context.ackSource)) return controlledReject('source-changed');
        controlled.refs = { transport: context.transport, sendSource: context.sendSource,
          ackSource: context.ackSource, socket: socket?.object ?? null,
          socketId: socket?.id ?? null, pc: context.pc, seq: meta.seq };
        if (!controlledIdentity({ ...context, leaseId: meta.leaseId }, true)) return false;
        controlled.send = controlledRow(context.viewerClockMs);
        return controlledBudget(t);
      });
    },
    observeControlledAck(ack, context) {
      return controlledGuard(false, () => {
        if (!controlled || !Array.isArray(ack?.inputIds) || !ack.inputIds.includes(controlled.inputId)) return false;
        const t = controlledTime(); if (t === null || controlled.finalized) return false;
        if (!controlled.send) return controlledReject();
        if (!controlledIdentity(context, true)) return false;
        const r = controlled.refs;
        if (context.transport !== r.transport || context.source !== r.ackSource
            || (r.transport === 'socket' && context.socketId !== r.socketId)) return controlledReject('source-changed');
        if (!controlledEventTime(context.viewerClockMs, t)) return controlledReject('clock-invalid');
        const move = controlled.inputType === 'mouse' && controlled.action === 'move';
        if (ack.schemaVersion !== 2 || ack.inputIds.length !== 1 || ack.inputType !== controlled.inputType
            || ack.leaseEpoch !== controlled.scope.leaseEpoch || ack.status !== 'applied'
            || !['reliable-applied', 'unordered-applied'].includes(context.verdict)
            || (!move && ack.appliedSeq !== r.seq)) return controlledReject(controlled.ack ? 'conflicting-observation' : null);
        const timing = Object.fromEntries(['hostAdapterAwaitMs', 'hostQueueMs', 'hostApplyMs']
          .map(k => [k, valid(ack[k]) ? ack[k] : null]));
        const key = JSON.stringify({ status: ack.status, appliedSeq: move ? null : ack.appliedSeq, ...timing });
        if (controlled.ack) {
          if (controlled.ackKey !== key) return controlledReject('conflicting-observation');
          controlledInc('duplicateAcks'); return false;
        }
        // A reliable replay can arrive through the unordered observer after C
        // consumes pending state. Only the saved ACK permits duplicate handling;
        // the first ACK still requires its original action-specific authority.
        if (context.verdict !== (move ? 'unordered-applied' : 'reliable-applied')) return controlledReject();
        controlled.ack = { ...controlledRow(context.viewerClockMs), status: 'applied' };
        controlled.ackKey = key; controlled.hostTiming = timing;
        return controlledBudget(t);
      });
    },
    readControlledInputEvidence(inputId, current, options = {}) {
      return controlledGuard(null, () => {
        if (!controlled || inputId !== controlled.inputId) return null;
        const wasFinalized = controlled.finalized;
        const t = controlledTime();
        controlledIdentity(current);
        if (options.finalize === true && !wasFinalized) {
          controlled.finalized = true;
          if (['dispatch-refused', 'observation-error', 'cancelled'].includes(options.terminalReason)) controlled.terminalReason = options.terminalReason;
          controlled.completed = Boolean(!controlled.error && !controlled.terminalReason
            && controlled.send && controlled.ack && controlled.postApply && !controlled.expired);
        }
        controlledBudget(t ?? controlled.processingAtMs);
        return controlledProjection(t ?? controlled.processingAtMs);
      });
    },
    clearControlledInputEvidence(inputId) {
      controlledGuard(undefined, () => { if (controlled && inputId === controlled.inputId) controlled = null; });
    },
    setScope(next) {
      if (next !== null && (!next || !validId(next.connectionAttemptId) || !Number.isSafeInteger(next.generation) || next.generation < 0 || !Number.isSafeInteger(next.leaseEpoch) || next.leaseEpoch < 0)) return;
      controlledGuard(undefined, () => {
        if (controlled && !sameScope(controlled.scope, next)) controlledFail('scope-changed');
      });
      const t = clock(); if (t === null || sameScope(scope, next)) return;
      expire(t);
      for (const record of pending.values()) inc('cancelled');
      pending.clear();
      if (scope) { closed.push({ endedAtMs: t, snapshot: api.snapshot({ nowMs: t, scope }) }); trimClosed(t); }
      scope = copyScope(next); outcomes = blankOutcomes(); metrics = new Map(LATENCY_METRIC_NAMES.map(k => [k, []]));
      stopSyncTimers();
      tombstones.clear(); lastPaint = freshAt = sync = lastSync = null;
      freshCaptureSeq = -1; mediaSince = t;
    },
    recordInputSend(id, context = {}) {
      const t = clock(context.submittedAtMs); if (t === null) return false;
      expire(t);
      if (!sameScope(scope, context.scope === undefined ? scope : context.scope) || !validId(id) || pending.has(id) || tombstones.has(id)) return false;
      while (pending.size >= 512) {
        const oldest = pending.keys().next().value;
        remember(oldest, pending.get(oldest), 'dropped', t); pending.delete(oldest); inc('dropped'); inc('unmatched');
      }
      pending.set(id, { sent: t, notice: false, unordered: context.inputType === 'mouse' && context.action === 'move',
        transport: ['socket', 'datachannel'].includes(context.transport) ? context.transport : null,
        metadataBytes: JSON.stringify(id).length + 192 }); inc('sent');
      enforceMetadataBudget();
      if (valid(context.domAtMs) && context.domAtMs <= t) push('frontendDispatchMs', t - context.domAtMs, t, id);
      return true;
    },
    onInputAck(data = {}, context = {}) {
      const t = clock(context.nowMs); if (t === null) return; expire(t);
      if (!sameScope(scope, context.scope === undefined ? scope : context.scope)) return;
      let matched = false;
      for (const id of new Set(Array.isArray(data.inputIds) ? data.inputIds.filter(validId).slice(0, 64) : [])) {
        const record = pending.get(id);
        if (!record) {
          const old = tombstones.get(id);
          if (old && old.state === 'timedOut' && !old.late) { old.late = true; inc('late'); }
          else if (!old) inc('unmatched');
          continue;
        }
        pending.delete(id); matched = true;
        const rejected = data.status && data.status !== 'applied' && data.status !== 'unordered' && data.status !== 'duplicate';
        inc(rejected ? 'rejected' : 'acked');
        if (!rejected) push('inputAckRttMs', t - record.sent, t, id);
        // Entry time is difference data, never an input to the global clock.
        // Missing/invalid arrival or a non-positive ACK cannot manufacture a
        // zero sample, nor can a later copy enrich an already consumed pending.
        if (['applied', 'unordered', 'duplicate'].includes(data.status)
            && valid(context.arrivalAtMs) && context.arrivalAtMs >= record.sent && context.arrivalAtMs <= t) {
          push('inputAckArrivalRttMs', context.arrivalAtMs - record.sent, t, id);
          push('inputAckValidationMs', t - context.arrivalAtMs, t, id);
        }
        // A marker can be presented before the ACK callback reaches Viewer.
        // Settle that bounded candidate only after the ACK proves the input
        // was applied; keep the original rVFC clock as the sample timestamp.
        if (!rejected && valid(record.visibleEffectAtMs) && record.visibleEffectAtMs >= record.sent) {
          const delta = record.visibleEffectAtMs - record.sent;
          if (push('inputToVisibleEffectMs', delta, record.visibleEffectAtMs, id)) record.visibleEffect = true;
        }
        remember(id, record, rejected ? 'rejected' : 'acked', t);
      }
      if (matched) {
        const key = `ack:${++serial}`;
        for (const name of ['hostAdapterAwaitMs', 'hostQueueMs', 'hostApplyMs', 'signalForwardMs', 'signalAckForwardMs']) push(name, data[name], t, key);
        if (data.hostAdapterAwaitMs === undefined) push('hostAdapterAwaitMs', data.hostExecuteMs, t, key);
      }
    },
    onUnorderedInputAck(data = {}, context = {}) {
      const t = clock(context.nowMs); if (t === null) return false; expire(t);
      if (!sameScope(scope, context.scope) || data.schemaVersion !== 2 || data.inputType !== 'mouse'
        || data.leaseEpoch !== scope?.leaseEpoch || !unorderedAckStatuses.has(data.status)
        || !['socket', 'datachannel'].includes(context.transport)) return false;
      const ids = Array.isArray(data.inputIds) ? data.inputIds.filter(validId).slice(0, 64) : [];
      const matching = ids.filter(id => {
        const record = pending.get(id) || tombstones.get(id);
        return record?.unordered === true && record.transport === context.transport;
      });
      if (!matching.length) return false;
      api.onInputAck({ ...data, inputIds: matching }, { scope, nowMs: t });
      return true;
    },
    onFrameTiming(data = {}, context = {}) {
      const t = clock(context.nowMs); if (t === null) return; expire(t);
      if (!sameScope(scope, context.scope === undefined ? scope : context.scope)) return;
      for (const name of ['captureGrabMs', 'captureAgeAtRecvMs', 'capturePrepareMs', 'frameConvertMs', 'imgprocQueueMs', 'imgprocBuildMs', 'encoderMs', 'packetizeMs', 'encodeTotalMs', 'rtpApiAwaitMs']) if (data.schemaVersion === 2) push(name, data.timings?.[name], t, `frame:${serial}:${name}`);
      serial += 1;
      for (const id of new Set(Array.isArray(data.inputIds) ? data.inputIds.filter(validId).slice(0, 64) : [])) {
        const record = pending.get(id) || tombstones.get(id);
        if (record && !record.notice) { push('inputToFrameNoticeMs', t - record.sent, t, id); record.notice = true; }
      }
    },
    hasPendingFrameInputs() {
      const t = clock(); if (t === null) return false; expire(t);
      return [...pending.values(), ...tombstones.values()].some(r => !r.postApply && t - r.sent < 10000 && (!r.state || r.state === 'acked'));
    },
    onPostApplyFrame(row = {}, context = {}) {
      observeControlledFrame(row, context);
      const t = clock(context.nowMs); if (t === null) return false; expire(t);
      if (!sameScope(scope, context.scope) || !sameScope(scope, row.scope)
          || row.traceStatus !== 'matched' || !valid(row.viewerClockMs) || row.viewerClockMs > t || t - row.viewerClockMs >= 2000) return false;
      let recorded = false;
      for (const id of Array.isArray(row.inputIds) ? row.inputIds.filter(validId).slice(0, 64) : []) {
        const record = pending.get(id) || tombstones.get(id);
        if (!record || record.postApply || row.viewerClockMs < record.sent || (record.state && record.state !== 'acked')) continue;
        recorded = push('inputToPostApplyFrameMs', row.viewerClockMs - record.sent, row.viewerClockMs, id) || recorded;
        record.postApply = true;
      }
      if (recorded && mediaActive && row.viewerClockMs > mediaSince
          && row.streamId === 'video' && row.captureFresh === true && row.captureAfterApplied === true
          && Number.isSafeInteger(row.captureSeq) && row.captureSeq > freshCaptureSeq) {
        freshCaptureSeq = row.captureSeq;
        // Late metadata joins retain the actual callback clock, never join time.
        if (freshAt === null || row.viewerClockMs > freshAt) freshAt = row.viewerClockMs;
      }
      return recorded;
    },
    onVisibleEffect(row = {}, context = {}) {
      const t = clock(context.nowMs); if (t === null) return false; expire(t);
      // A visible-effect sample is stronger than M2: it requires a decoded
      // marker from the same trace identity and an already accepted ACK. The
      // marker itself is deliberately never retained in the latency snapshot.
      if (!mediaActive || !sameScope(scope, context.scope === undefined ? scope : context.scope)
          || !sameScope(scope, row.scope) || row.traceStatus !== 'matched'
          || row.streamId !== 'video' || row.captureFresh !== true || row.captureAfterApplied !== true
          || !row.marker || !valid(row.viewerClockMs) || row.viewerClockMs > t
          || t - row.viewerClockMs >= 2000 || !Array.isArray(row.inputIds)) return false;
      let recorded = false;
      for (const id of row.inputIds.filter(validId).slice(0, 64)) {
        const record = pending.get(id) || tombstones.get(id);
        if (!record || record.visibleEffect || valid(record.visibleEffectAtMs) || row.viewerClockMs < record.sent) continue;
        if (record.state === 'acked') {
          recorded = push('inputToVisibleEffectMs', row.viewerClockMs - record.sent, row.viewerClockMs, id) || recorded;
          record.visibleEffect = true;
        } else if (!record.state) {
          // Keep only the scalar presentation clock until the accepted ACK
          // arrives. Never retain marker pixels or a frame payload.
          record.visibleEffectAtMs = row.viewerClockMs;
          recorded = true;
        }
      }
      return recorded;
    },
    recordStage(name, value, context = {}) {
      const t = clock(context.atMs); if (t === null) return false; expire(t);
      if (!sameScope(scope, context.scope === undefined ? scope : context.scope)) return false;
      // Freshness requires M2 identity/provenance; a scalar cannot prove it.
      if (name === 'freshFrameAgeMs') return false;
      return push(name, value, t, context.sampleKey);
    },
    setMediaState(active, context = {}) {
      const t = clock(context.nowMs); if (t === null) return; expire(t);
      if (!sameScope(scope, context.scope === undefined ? scope : context.scope)) return;
      mediaActive = active === true; lastPaint = freshAt = null; mediaSince = t;
    },
    onVideoFrame(t) {
      const at = clock(t); if (at === null) return; expire(at);
      if (!mediaActive) return;
      if (lastPaint !== null) push('paintIntervalMs', at - lastPaint, at, `paint:${++serial}`);
      lastPaint = at;
    },
    onMediaStats(data = {}) {
      const t = clock(); if (t === null) return; expire(t);
      const key = `stats:${++serial}`;
      for (const [name, field] of [['jitterBufferMs', 'jitterBufferMs'], ['decodeMs', 'decodeMs'], ['candidateRttMs', 'rttMs'], ['recvBytes', 'bytesDelta'], ['elapsedMs', 'elapsedMs']]) push(name, data[field], t, key);
    },
    snapshot(context = {}) {
      const t = clock(context.nowMs); const at = t === null ? Math.max(0, lastNow) : t; expire(at);
      const inScope = sameScope(scope, context.scope === undefined ? scope : context.scope);
      const result = Object.fromEntries([...metrics].map(([name, rows]) => [name, summary(inScope ? rows : [], at)]));
      if (inScope && mediaActive && freshAt !== null) result.freshFrameAgeMs = { last: at - freshAt, p50: at - freshAt, p95: at - freshAt, count: 1, available: true, lastSampleAgeMs: 0 };
      return { schemaVersion: 3, windowMs: 5000, scope: copyScope(scope), metrics: result, outcomes: { ...outcomes } };
    },
    takeClosedScopeSummaries(context = {}) {
      const t = clock(context.nowMs); if (t !== null) expire(t);
      const result = { summaries: closed, dropped: closedDropped }; closed = []; closedDropped = 0; return result;
    },
    requestClockSync(send) {
      const t = clock(); if (t === null) return false; expire(t);
      if (sync) return false;
      if (scope === null) { stopSyncTimers(); return false; }
      // Retry ownership survives an absent channel or throwing send. Teardown
      // cancels both timers; importing or setting scope never starts one.
      stopSyncTimers();
      syncRetry = schedule(() => { syncRetry = null; api.requestClockSync(send); }, 30000);
      const transport = send || (typeof WebRTC !== 'undefined' && WebRTC.inputChannel?.readyState === 'open' ? message => WebRTC.inputChannel.send(JSON.stringify(message)) : null);
      if (!transport) return false;
      sync = { v0: t, scope: copyScope(scope) };
      try { transport({ type: 'clock_sync_req', v0: t }); } catch (_) { sync = null; return false; }
      syncTimeout = schedule(() => { syncTimeout = null; const at = clock(); if (at !== null) expire(at); }, 2000);
      return true;
    },
    handleClockSyncResponse(data = {}, context = {}) {
      const t = clock(context.nowMs); if (t === null) return false; expire(t);
      if (!sync || data.v0 !== sync.v0 || !sameScope(scope, context.scope === undefined ? scope : context.scope) || !sameScope(scope, sync.scope)
        || !valid(data.h0) || !valid(data.h1) || data.h1 < data.h0) return false;
      const rtt = (t - sync.v0) - (data.h1 - data.h0) * 1000;
      if (!valid(rtt)) return false;
      lastSync = { at: t, rtt, offset: (sync.v0 + t) / 2 - (data.h0 + data.h1) * 500 }; sync = null;
      if (syncTimeout !== null) cancel(syncTimeout); syncTimeout = null; return true;
    },
    getStats() {
      const snapshot = api.snapshot();
      const aliases = { capture: 'capturePrepareMs', scale: 'frameConvertMs', encode: 'encoderMs', network: null, playout: 'jitterBufferMs', inputRtt: 'inputAckRttMs', executeTime: 'hostAdapterAwaitMs', visualFeedback: 'inputToFrameNoticeMs', paint: 'paintIntervalMs' };
      return { ...Object.fromEntries(Object.entries(aliases).map(([key, name]) => [key, name ? snapshot.metrics[name] : summary([], lastNow)])), sync: lastSync ? { state: 'synced', rtt: lastSync.rtt, offset: lastSync.offset } : { state: sync ? 'syncing' : 'idle', rtt: null, offset: null } };
    },
  };
  return api;
};
const LatencyMonitor = createLatencyMonitor();
if (typeof module !== 'undefined') module.exports = { LatencyMonitor, LATENCY_METRIC_NAMES, createLatencyMonitor };
