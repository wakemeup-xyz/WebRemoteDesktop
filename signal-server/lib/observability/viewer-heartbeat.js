'use strict';

const { performance } = require('node:perf_hooks');
const MAX = 999999999;
const PREFIX = 'WRD_SIGNAL_HEARTBEAT ';
const REASONS = new Map([
  ['ping timeout', 'ping'], ['transport close', 'transport-close'],
  ['transport error', 'transport-error'], ['server namespace disconnect', 'server-disconnect'],
  ['client namespace disconnect', 'client-disconnect'], ['server shutting down', 'server-shutdown'],
  ['parse error', 'parse'], ['forced close', 'forced'], ['forced server close', 'forced'],
]);

// Shared by aggregate counts, ring sequence and overwrite counts; never wraps.
function incrementBoundedCount(value, coverage) {
  if (value < MAX) return value + 1;
  coverage.counterClipped = true;
  return MAX;
}

// Only fixed enums and numbers leave this module. No emitter arguments are retained.
function createViewerHeartbeatRegistry({ now = () => performance.now(), wallNow = Date.now,
  logger = console, runtimeSnapshot, onSnapshot, setIntervalFn = setInterval,
  clearIntervalFn = clearInterval, snapshotIntervalMs = 60000 } = {}) {
  const records = new Set();
  const sockets = new WeakSet();
  const engines = new WeakSet();
  let stopped = false;
  function attach(socket, isMapCurrent) {
    if (stopped || !socket || (typeof socket !== 'object' && typeof socket !== 'function') || sockets.has(socket)) return;
    sockets.add(socket);
    if (records.size === 8) records.values().next().value.finish('capacity');
    let owner = socket;
    let predicate = isMapCurrent;
    socket = null; isMapCurrent = null;
    let engine = null;
    let finalized = false;
    let terminal = null;
    let queued = false;
    let snapshotTimer = null;
    let lastSnapshotRingDropped = 0;
    let coverage = { state: 'partial', engine: false, flushScanLimited: false,
      valueInvalid: false, counterClipped: false };
    const counts = { pingCreated: 0, pingInFlush: 0, pongReceived: 0,
      messageIn: 0, messageCreated: 0, flush: 0 };
    const last = { pingCreated: null, pingInFlush: null, pongReceived: null };
    let ring = [];
    let ringDropped = 0;
    let sequence = 0;
    const removals = [];
    function read(object, key) {
      try { return object?.[key]; } catch { coverage.valueInvalid = true; return undefined; }
    }
    function isArray(value) {
      try { return Array.isArray(value); } catch { coverage.valueInvalid = true; return false; }
    }
    function number(value, max = MAX) {
      if (Number.isInteger(value) && value >= 0 && value <= max) return value;
      if (value !== null) coverage.valueInvalid = true;
      return null;
    }
    function clock(fn, max = Infinity) {
      try {
        const value = fn();
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max) return value;
      } catch { /* Invalid clocks cannot interfere with business callbacks. */ }
      coverage.valueInvalid = true;
      return null;
    }
    const started = clock(now);
    let proof = read(owner, '_wrdProofViewer') === true;
    function current() {
      try { const value = typeof predicate === 'function' ? predicate() : null;
        return typeof value === 'boolean' ? value : null;
      } catch { return null; }
    }
    function increment(key) {
      counts[key] = incrementBoundedCount(counts[key], coverage);
    }
    function elapsed(end, start) {
      if (end === null || start === null) return null;
      const difference = end - start;
      if (!Number.isFinite(difference) || difference < 0 || difference > MAX) { coverage.valueInvalid = true; return null; }
      return Math.floor(difference);
    }
    function heartbeat(key, kind) {
      increment(key);
      const at = clock(now);
      last[key] = at;
      sequence = incrementBoundedCount(sequence, coverage);
      const t = elapsed(at, started);
      if (t === null) return;
      if (ring.length === 32) {
        ring.shift();
        ringDropped = incrementBoundedCount(ringDropped, coverage);
      }
      ring.push({ t, n: sequence, k: kind });
      if (ringDropped > 0 && lastSnapshotRingDropped === 0) emitLiveSnapshot();
    }
    function packet(packet, incoming) {
      if (finalized) return;
      const type = read(packet, 'type');
      if (type === (incoming ? 'pong' : 'ping')) heartbeat(incoming ? 'pongReceived' : 'pingCreated', incoming ? 'pr' : 'pc');
      else if (type === 'message') increment(incoming ? 'messageIn' : 'messageCreated');
    }
    function flush(batch) {
      if (finalized) return;
      increment('flush');
      if (!isArray(batch)) { coverage.flushScanLimited = true; coverage.valueInvalid = true; return; }
      const length = read(batch, 'length');
      if (!Number.isSafeInteger(length) || length < 0) { coverage.flushScanLimited = true; coverage.valueInvalid = true; return; }
      if (length > 64) coverage.flushScanLimited = true;
      let found = false;
      for (let i = 0; i < Math.min(length, 64); i++) {
        try { if (batch[i]?.type === 'ping') found = true; }
        catch { coverage.flushScanLimited = true; coverage.valueInvalid = true; }
      }
      if (found) heartbeat('pingInFlush', 'pf');
    }
    function transportState() {
      const transport = read(engine, 'transport');
      const name = read(transport, 'name');
      const writable = read(transport, 'writable');
      const buffer = read(engine, 'writeBuffer');
      const state = read(engine, 'readyState');
      if (writable !== undefined && writable !== null && typeof writable !== 'boolean') coverage.valueInvalid = true;
      if (buffer !== undefined && !isArray(buffer)) coverage.valueInvalid = true;
      return {
        name: ['websocket', 'polling', 'webtransport'].includes(name) ? name : 'unknown',
        writable: typeof writable === 'boolean' ? writable : null,
        bufferLength: isArray(buffer) ? number(read(buffer, 'length'), 1000000) : null,
        state: ['opening', 'open', 'closing', 'closed'].includes(state) ? state : 'unknown',
      };
    }
    function nodeState() {
      const empty = { status: 'unavailable', ageMs: null, count: null, lastMs: null, maxMs: null, p95Ms: null, missed: null };
      if (typeof runtimeSnapshot !== 'function') return empty;
      try {
        const snapshot = runtimeSnapshot();
        const status = snapshot?.status;
        const loop = snapshot?.eventLoop;
        const milliseconds = value => number(typeof value === 'number' && Number.isFinite(value)
          && value >= 0 && value <= MAX ? Math.floor(value) : value);
        const result = { ...empty, status: ['ok', 'unavailable', 'error'].includes(status) ? status : 'unavailable',
          ageMs: milliseconds(snapshot?.ageMs ?? null) };
        for (const [target, source, max] of [['count', 'count', 120], ['lastMs', 'last', MAX],
          ['maxMs', 'max', MAX], ['p95Ms', 'p95', MAX], ['missed', 'missedSampleCount', MAX]]) {
          const value = loop?.[source] ?? null;
          result[target] = ['lastMs', 'maxMs', 'p95Ms'].includes(target)
            ? milliseconds(value) : number(value, max);
        }
        return result;
      } catch { coverage.valueInvalid = true; return { ...empty, status: 'error' }; }
    }
    function capture(source, reason) {
      return { source, reason, at: clock(now), wallMs: number(clock(wallNow, 9999999999999), 9999999999999),
        transport: transportState(), current: current() };
    }
    function terminalEvent(source, reason) {
      if (finalized) return;
      if (!terminal) terminal = capture(source, REASONS.get(reason) || 'unknown');
      if (source === 'engine') {
        terminal.source = 'engine'; terminal.reason = REASONS.get(reason) || 'unknown';
      }
      if (!queued) { queued = true; queueMicrotask(() => finish()); }
    }
    function emitLiveSnapshot() {
      if (finalized) return;
      const live = capture('live', 'online');
      const data = { v: 1, event: 'viewer-heartbeat-snapshot', wallMs: live.wallMs,
        durationMs: elapsed(live.at, started), source: live.source, reason: live.reason,
        current: live.current, proof, coverage,
        ages: { pingCreatedMs: elapsed(live.at, last.pingCreated),
          pingInFlushMs: elapsed(live.at, last.pingInFlush), pongReceivedMs: elapsed(live.at, last.pongReceived) },
        counts, transport: live.transport, node: nodeState(), ringDropped, ring };
      lastSnapshotRingDropped = ringDropped;
      try {
        const projected = JSON.stringify(data);
        if (Buffer.byteLength(projected) > 4096 || /[^\x20-\x7e]/.test(projected)) return;
        try { logger?.log?.(PREFIX + projected); } catch { /* Diagnostic-only emitter. */ }
        try { onSnapshot?.(data); } catch { /* Evidence aggregation cannot affect input. */ }
      } catch { /* Bounded serialization failure is ignored. */ }
    }
    function finish(mode) {
      if (finalized) return;
      if (!terminal) terminal = capture('shutdown', 'server-shutdown');
      if (mode === 'shutdown') { terminal.source = 'shutdown'; terminal.reason = 'server-shutdown'; }
      if (mode === 'capacity') coverage.state = 'capacity';
      terminal.current = mode === 'capacity' ? false : current();
      finalized = true;
      // Snapshot while the server's existing runtime sampler still owns its data.
      const node = nodeState();
      const data = { v: 1, event: 'viewer-heartbeat-close', wallMs: terminal.wallMs,
        durationMs: elapsed(terminal.at, started), source: terminal.source, reason: terminal.reason,
        current: terminal.current, proof, coverage,
        ages: { pingCreatedMs: elapsed(terminal.at, last.pingCreated),
          pingInFlushMs: elapsed(terminal.at, last.pingInFlush), pongReceivedMs: elapsed(terminal.at, last.pongReceived) },
        counts, transport: terminal.transport, node, ringDropped, ring };
      // Cleanup precedes serialization/logging; even a hostile logger cannot retain authority callbacks.
      if (snapshotTimer !== null) {
        try { clearIntervalFn(snapshotTimer); } catch { /* best effort */ }
        snapshotTimer = null;
      }
      for (const remove of removals) { try { remove(); } catch { /* Diagnostic-only emitter. */ } }
      removals.length = 0;
      owner = null; engine = null; predicate = null; ring = []; terminal = null;
      records.delete(record);
      const failure = '{"v":1,"event":"viewer-heartbeat-close","coverage":{"state":"capacity"}}';
      let json = failure;
      try {
        const projected = JSON.stringify(data);
        if (Buffer.byteLength(projected) <= 4096 && !/[^\x20-\x7e]/.test(projected)) json = projected;
      } catch { /* Emit only fixed metadata when serialization fails. */ }
      try { logger?.log?.(PREFIX + json); } catch { /* No raw error, retry, or additional log. */ }
      try { onSnapshot?.(data); } catch { /* Evidence aggregation cannot affect teardown. */ }
    }
    const record = { finish };
    records.add(record);
    function enroll(emitter, event, handler) {
      const on = read(emitter, 'on');
      const off = read(emitter, 'off') || read(emitter, 'removeListener');
      if (typeof on !== 'function' || typeof off !== 'function') return false;
      // Register removal first in case a custom emitter throws after enrolling.
      removals.push(() => off.call(emitter, event, handler));
      try { on.call(emitter, event, handler); return true; } catch { return false; }
    }
    engine = read(owner, 'conn');
    if (engine && (typeof engine === 'object' || typeof engine === 'function')) {
      if (engines.has(engine)) { records.delete(record); owner = null; predicate = null; engine = null; return; }
      engines.add(engine);
    }
    const engineListeners = [
      ['packetCreate', p => packet(p, false)], ['packet', p => packet(p, true)],
      ['flush', flush], ['close', reason => terminalEvent('engine', reason)],
    ];
    const enrolled = engineListeners.map(([event, handler]) => enroll(engine, event, handler));
    coverage.engine = enrolled.every(Boolean);
    const namespaceEnrolled = enroll(owner, 'disconnect', reason => terminalEvent('namespace', reason));
    if (!coverage.engine || !namespaceEnrolled) coverage.state = 'unavailable';
    if (typeof setIntervalFn === 'function' && Number.isFinite(snapshotIntervalMs)
        && snapshotIntervalMs > 0 && snapshotIntervalMs <= 3600000) {
      try {
        snapshotTimer = setIntervalFn(() => emitLiveSnapshot(), snapshotIntervalMs);
        snapshotTimer?.unref?.();
      } catch { snapshotTimer = null; }
    }
  }
  return { attach, stop() {
    if (stopped) return;
    stopped = true;
    for (const record of records) record.finish('shutdown');
    records.clear();
    runtimeSnapshot = null; logger = null; now = null; wallNow = null;
  } };
}

module.exports = { createViewerHeartbeatRegistry, incrementBoundedCount };
