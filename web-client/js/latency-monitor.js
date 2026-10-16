// A passive, bounded observer. Control delivery never depends on this collector.
const LATENCY_METRIC_NAMES = Object.freeze([
  'frontendDispatchMs', 'inputAckRttMs', 'hostAdapterAwaitMs', 'hostQueueMs', 'hostApplyMs',
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
    if (rows.length > 256) { rows.shift(); inc('dropped'); }
    while (totalSamples() > 4096 || sampleBytes() > 589824) {
      const oldest = [...metrics.values()].filter(r => r.length).reduce((a, b) => a[0].at <= b[0].at ? a : b);
      oldest.shift(); inc('dropped');
    }
    enforceMetadataBudget();
    return true;
  };
  let serial = 0;
  const api = {
    init() {},
    setScope(next) {
      if (next !== null && (!next || !validId(next.connectionAttemptId) || !Number.isSafeInteger(next.generation) || next.generation < 0 || !Number.isSafeInteger(next.leaseEpoch) || next.leaseEpoch < 0)) return;
      const t = clock(); if (t === null || sameScope(scope, next)) return;
      expire(t);
      for (const record of pending.values()) inc('cancelled');
      pending.clear();
      if (scope) { closed.push({ endedAtMs: t, snapshot: api.snapshot({ nowMs: t, scope }) }); trimClosed(t); }
      scope = copyScope(next); outcomes = blankOutcomes(); metrics = new Map(LATENCY_METRIC_NAMES.map(k => [k, []]));
      stopSyncTimers();
      tombstones.clear(); lastPaint = freshAt = sync = lastSync = null;
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
    recordStage(name, value, context = {}) {
      const t = clock(context.atMs); if (t === null) return false; expire(t);
      if (!sameScope(scope, context.scope === undefined ? scope : context.scope)) return false;
      if (name === 'freshFrameAgeMs') { if (!valid(value) || value > t || !mediaActive) return false; freshAt = t - value; return true; }
      return push(name, value, t, context.sampleKey);
    },
    setMediaState(active, context = {}) {
      const t = clock(context.nowMs); if (t === null) return; expire(t);
      if (!sameScope(scope, context.scope === undefined ? scope : context.scope)) return;
      mediaActive = active === true; lastPaint = freshAt = null;
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
