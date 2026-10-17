'use strict';

const { performance } = require('node:perf_hooks');
const { normalizeEvent } = require('./logger');

const WINDOW_MS = 60000;
const MAX_COUNT = 999999999;
const MAX_DURATION_MS = 3600000;
const MAX_TRACKERS = 256;
const ROUTE_CLASSES = Object.freeze([
  'viewer_login', 'auth_verify', 'viewer_admission', 'diagnostics', 'viewer_html', 'viewer_bootstrap',
]);
const DURATION_BINS = Object.freeze([
  [10, 'le10'], [50, 'le50'], [100, 'le100'], [500, 'le500'],
  [1000, 'le1000'], [5000, 'le5000'], [15000, 'le15000'], [Infinity, 'gt15000'],
]);

function addBoundedCount(value, amount, coverage) {
  const result = value + amount;
  if (result > MAX_COUNT) coverage.clipped = true;
  return Math.min(MAX_COUNT, result);
}

function routeClass(method, url) {
  if (typeof url !== 'string') return null;
  // Do not parse, retain or project query values, headers, identities or bodies.
  // Each comparison scans at most a fixed route length, even for giant URLs.
  const matches = pathname => url === pathname || url.startsWith(pathname + '?');
  if (method === 'POST') {
    if (matches('/api/auth/login') || matches('/api/auth/login/viewer')) return 'viewer_login';
    if (matches('/api/auth/viewer-admission')) return 'viewer_admission';
    if (matches('/api/diagnostics')) return 'diagnostics';
  }
  if (method === 'GET') {
    if (matches('/api/auth/verify')) return 'auth_verify';
    if (matches('/api/viewer-bootstrap')) return 'viewer_bootstrap';
  }
  if ((method === 'GET' || method === 'HEAD') && ['/', '/index.html', '/viewer.html'].some(matches)) return 'viewer_html';
  return null;
}

function emptyRow() {
  return {
    started: 0, completed: 0, aborted: 0, closedUnfinished: 0, untracked: 0,
    expiredUnfinished: 0, stoppedInflight: 0, inflight: 0,
    status: { '1xx': 0, '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, other: 0, s401: 0, s403: 0, s429: 0 },
    duration: { le10: 0, le50: 0, le100: 0, le500: 0, le1000: 0, le5000: 0, le15000: 0, gt15000: 0,
      count: 0, sumMs: 0, maxMs: 0, unknown: 0 },
  };
}

function createEntryObserver(options = {}) {
  const now = options.now || (() => performance.now());
  const wallNow = options.wallNow || Date.now;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const trackers = new Set();
  const cleanup = [];
  let running = false;
  let stopped = false;
  let timer = null;
  let startedAt = null;
  let endedAt = null;
  let lastTime = null;
  let generation = 0;
  let completionCoverage = true;
  let state;
  let startTime = null;
  let startGeneration = 0;
  let startWall = null;

  function reset() {
    state = {
      http: Object.fromEntries(ROUTE_CLASSES.map(category => [category, emptyRow()])),
      namespace: { accepted: 0, missing_auth: 0, invalid_auth: 0 },
      engine: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, other: 0 },
      coverage: { clipped: false, clockUnknown: false, collectionFailures: 0, loggerFailures: 0, storeFailures: 0 },
      events: 0,
    };
  }
  reset();
  const inc = (object, key, amount = 1) => { object[key] = addBoundedCount(object[key], amount, state.coverage); };
  function collectionFailure() {
    inc(state.coverage, 'collectionFailures');
    completionCoverage = false;
  }
  function sampleTime() {
    let value;
    try { value = now(); } catch { collectionFailure(); }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (lastTime !== null && value < lastTime)) {
      generation++;
      state.coverage.clockUnknown = true;
      return null;
    }
    lastTime = value;
    return value;
  }
  function wallTime() {
    try {
      const value = wallNow();
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 253402300799999) return new Date(value).toISOString();
    } catch { collectionFailure(); }
    return null;
  }
  function elapsed(start, end, born) {
    return start !== null && end !== null && born === generation && end >= start ? end - start : null;
  }
  function duration(row, tracker, at) {
    const value = elapsed(tracker.at, at, tracker.generation);
    if (value === null) { inc(row.duration, 'unknown'); return; }
    const bounded = Math.min(MAX_DURATION_MS, Math.floor(value));
    if (value > MAX_DURATION_MS) state.coverage.clipped = true;
    inc(row.duration, DURATION_BINS.find(([limit]) => value <= limit)[1]);
    inc(row.duration, 'count'); inc(row.duration, 'sumMs', bounded);
    row.duration.maxMs = Math.max(row.duration.maxMs, bounded);
  }
  function detach(tracker) {
    // Keep removal separate from finalization so a broken recorder cannot retain requests.
    trackers.delete(tracker);
    for (const [emitter, event, callback] of tracker.listeners) {
      try { emitter.removeListener(event, callback); } catch { collectionFailure(); }
    }
    tracker.listeners.length = 0;
  }
  function finalize(tracker, outcome, at) {
    if (!trackers.has(tracker)) return;
    detach(tracker);
    const row = state.http[tracker.category];
    inc(row, outcome); inc(state, 'events');
    if (outcome === 'expiredUnfinished' || outcome === 'stoppedInflight') completionCoverage = false;
    if (outcome === 'completed') {
      let status;
      try { status = tracker.response.statusCode; } catch { collectionFailure(); }
      const valid = Number.isInteger(status) && status >= 100 && status <= 599;
      inc(row.status, valid ? `${Math.floor(status / 100)}xx` : 'other');
      if (status === 401 || status === 403 || status === 429) inc(row.status, `s${status}`);
    }
    // These are terminal observation ages, including abort/unfinished close;
    // expiry and shutdown are censored and cannot establish request duration.
    if (outcome === 'completed' || outcome === 'aborted' || outcome === 'closedUnfinished') duration(row, tracker, at);
    tracker.response = null;
  }
  function observeHttp(req, res) {
    if (!running) return;
    let tracker;
    try {
      const category = routeClass(req.method, req.url);
      if (!category) return;
      inc(state.http[category], 'started'); inc(state, 'events');
      if (trackers.size >= MAX_TRACKERS) {
        inc(state.http[category], 'untracked'); completionCoverage = false; return;
      }
      const at = sampleTime();
      tracker = { category, at, generation, response: res, listeners: [] };
      trackers.add(tracker);
      for (const [emitter, event, outcome] of [[res, 'finish', 'completed'], [res, 'close', 'closedUnfinished'], [req, 'aborted', 'aborted']]) {
        const callback = () => {
          if (!running || !trackers.has(tracker)) return;
          try { finalize(tracker, outcome, sampleTime()); } catch { collectionFailure(); detach(tracker); }
        };
        // Register ownership before calling on: even a throwing custom emitter is cleaned.
        tracker.listeners.push([emitter, event, callback]); emitter.on(event, callback);
      }
    } catch {
      collectionFailure();
      if (tracker) detach(tracker);
    }
  }
  function observeNamespaceOutcome(outcome) {
    if (!running || (outcome !== 'accepted' && outcome !== 'missing_auth' && outcome !== 'invalid_auth')) return;
    inc(state.namespace, outcome); inc(state, 'events');
  }
  function observeEngineError(error) {
    if (!running) return;
    let code;
    try { code = error?.code; } catch { collectionFailure(); }
    inc(state.engine, Number.isInteger(code) && code >= 0 && code <= 5 ? String(code) : 'other');
    inc(state, 'events');
  }
  function project(at, endWall, final) {
    const interval = elapsed(startTime, at, startGeneration);
    const http = Object.fromEntries(ROUTE_CLASSES.map(category => [category, {
      ...state.http[category], status: { ...state.http[category].status }, duration: { ...state.http[category].duration },
    }]));
    for (const tracker of trackers) http[tracker.category].inflight++;
    const boundedInterval = interval === null ? null : Math.min(MAX_COUNT, Math.floor(interval));
    const clipped = state.coverage.clipped || (interval !== null && interval > MAX_COUNT);
    return {
      version: 1, vantage: 'origin',
      window: { start: startWall, end: endWall, elapsedMs: boundedInterval,
        missedWindows: interval === null ? null : Math.min(MAX_COUNT, Math.max(0, Math.floor(interval / WINDOW_MS) - 1)),
        final, empty: state.events === 0 },
      coverage: { startedAt, endedAt, completionCoverage, ...state.coverage,
        clockUnknown: state.coverage.clockUnknown || interval === null, clipped },
      http, namespace: { ...state.namespace }, engine: { ...state.engine },
    };
  }
  function flush(final = false) {
    const at = sampleTime();
    const endWall = wallTime();
    if (final) endedAt = endWall;
    for (const tracker of trackers) {
      // Clock anomalies never manufacture an age. Capacity still bounds retention.
      if (final) finalize(tracker, 'stoppedInflight', at);
      else if (tracker.at !== null && at !== null && at - tracker.at >= WINDOW_MS) finalize(tracker, 'expiredUnfinished', at);
    }
    const meta = project(at, endWall, final);
    const input = { domain: 'entry', event: 'entry_window', message: '', meta };
    reset(); startTime = at; startGeneration = generation; startWall = endWall;
    let envelope;
    try { envelope = options.structuredLogger?.info(input); } catch { inc(state.coverage, 'loggerFailures'); }
    try {
      // The real logger returns the exact redacted envelope it serialized. Build the
      // same shape independently when its sink throws or a test logger returns void.
      if (!envelope || typeof envelope !== 'object') envelope = normalizeEvent(input);
      options.recentEventStore?.append(envelope);
    } catch { inc(state.coverage, 'storeFailures'); }
  }
  function schedule() {
    timer = setTimer(() => {
      if (!running) return;
      timer = null;
      try { flush(); } catch { collectionFailure(); }
      if (running) schedule();
    }, WINDOW_MS);
    timer?.unref?.();
  }
  return {
    observeHttp, observeNamespaceOutcome, observeEngineError,
    addCleanup(callback) { cleanup.push(callback); },
    start() {
      if (running || stopped) return;
      running = true; startTime = sampleTime(); startGeneration = generation; startWall = wallTime(); startedAt = startWall;
      schedule();
    },
    stop() {
      if (stopped) return;
      stopped = true; const wasRunning = running; running = false;
      if (timer !== null) clearTimer(timer);
      timer = null;
      for (const callback of cleanup.splice(0)) { try { callback(); } catch { collectionFailure(); } }
      if (wasRunning) {
        try { flush(true); } catch { collectionFailure(); }
      }
      // Release observers even if projection/sink infrastructure failed.
      for (const tracker of trackers) detach(tracker);
    },
    snapshot() { return project(sampleTime(), wallTime(), stopped); },
  };
}

function bindEntryObserver(server, engine, observer) {
  const safe = fn => (...args) => { try { fn(...args); } catch { /* Observation cannot change server behavior. */ } };
  const listening = safe(() => observer.start());
  const stop = safe(() => observer.stop());
  const error = safe(value => observer.observeEngineError(value));
  server.on('listening', listening); server.on('close', stop); server.on('error', stop);
  engine.on('connection_error', error);
  observer.addCleanup(() => {
    server.removeListener('listening', listening); server.removeListener('close', stop); server.removeListener('error', stop);
    engine.removeListener('connection_error', error);
  });
}

module.exports = { createEntryObserver, bindEntryObserver, addBoundedCount, ROUTE_CLASSES };
