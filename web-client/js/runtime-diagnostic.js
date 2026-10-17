// Pure diagnostic producer: importing it never starts timers, DOM work or requests.
(function installRuntimeDiagnostic(global) {
  const MAX_REPORT_BYTES = 128 * 1024;
  const MAX_SCOPE_BYTES = 32 * 1024;
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const bytes = value => unescape(encodeURIComponent(JSON.stringify(value))).length;
  const randomHash = () => {
    const words = new Uint32Array(4);
    if (global.crypto?.getRandomValues) global.crypto.getRandomValues(words);
    else for (let i = 0; i < words.length; i++) words[i] = Math.floor(Math.random() * 0x100000000);
    return Array.from(words, word => word.toString(16).padStart(8, '0')).join('');
  };
  const read = (getter, fallback, ...args) => {
    try { return typeof getter === 'function' ? (getter(...args) ?? fallback) : fallback; }
    catch (_) { return fallback; }
  };
  function sanitizeDataChannelWatchdog(value) {
    const fields = ['phase', 'timedOut', 'elapsedMs', 'remainingMs', 'extensions', 'pcState', 'iceState',
      'signalingState', 'sctpState', 'inputState', 'moveState', 'socketConnected', 'localDescriptionSet', 'remoteDescriptionSet'];
    const values = {};
    for (const key of fields) { try { values[key] = value?.[key]; } catch (_) { values[key] = null; } }
    const get = key => values[key];
    const enumeration = (key, values) => values.includes(get(key)) ? get(key) : null;
    const duration = (key, max) => typeof get(key) === 'number' && Number.isFinite(get(key))
      && get(key) >= 0 && get(key) <= max ? get(key) : null;
    const boolean = key => typeof get(key) === 'boolean' ? get(key) : null;
    return { phase: enumeration('phase', ['negotiation', 'channel-open', 'inactive']) || 'inactive',
      timedOut: get('timedOut') === true, elapsedMs: duration('elapsedMs', 3600000), remainingMs: duration('remainingMs', 30000),
      extensions: Number.isInteger(get('extensions')) && get('extensions') >= 0 && get('extensions') <= 2 ? get('extensions') : 0,
      pcState: enumeration('pcState', ['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed']),
      iceState: enumeration('iceState', ['new', 'checking', 'connected', 'completed', 'failed', 'disconnected', 'closed']),
      signalingState: enumeration('signalingState', ['stable', 'have-local-offer', 'have-remote-offer', 'have-local-pranswer', 'have-remote-pranswer', 'closed']),
      sctpState: enumeration('sctpState', ['connecting', 'connected', 'closed']),
      inputState: enumeration('inputState', ['connecting', 'open', 'closing', 'closed']),
      moveState: enumeration('moveState', ['connecting', 'open', 'closing', 'closed']),
      socketConnected: boolean('socketConnected'), localDescriptionSet: boolean('localDescriptionSet'), remoteDescriptionSet: boolean('remoteDescriptionSet') };
  }
  function sanitizeSignalingFailure(value) {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return null;
    const fields = ['scope', 'failureClass', 'transport', 'engineState', 'managerState',
      'socketConnected', 'socketActive', 'fallbackSelected', 'connectBudgetMs', 'ageMs'];
    const values = {};
    for (const key of fields) { try { values[key] = value[key]; } catch (_) { values[key] = null; } }
    const enumeration = (key, allowed, fallback) => allowed.includes(values[key]) ? values[key] : fallback;
    const boolean = key => typeof values[key] === 'boolean' ? values[key] : null;
    const duration = (key, max) => typeof values[key] === 'number' && Number.isFinite(values[key])
      && values[key] >= 0 && values[key] <= max ? values[key] : null;
    return { scope: 'last-connect-error',
      failureClass: enumeration('failureClass', ['timeout', 'transport-error', 'auth-required', 'auth-invalid', 'unknown'], 'unknown'),
      transport: enumeration('transport', ['websocket', 'polling', 'unknown'], 'unknown'),
      engineState: enumeration('engineState', ['opening', 'open', 'closing', 'closed', 'unknown'], 'unknown'),
      managerState: enumeration('managerState', ['opening', 'open', 'closed', 'unknown'], 'unknown'),
      socketConnected: boolean('socketConnected'), socketActive: boolean('socketActive'), fallbackSelected: boolean('fallbackSelected'),
      connectBudgetMs: duration('connectBudgetMs', 30000), ageMs: duration('ageMs', 3600000) };
  }
  function boundRuntimeDiagnostic(payload) {
    const result = clone(payload);
    result.truncation = { dropped: Number.isSafeInteger(result.truncation?.dropped) ? result.truncation.dropped : 0 };
    const trace = result.inputTrace;
    if (Array.isArray(trace?.events)) {
      while (trace.events.length > 256 || (trace.events.length && bytes(trace) > 64 * 1024)) {
        trace.events.shift(); result.truncation.dropped++;
      }
    }
    // Required explanation and M1 snapshot survive clipping of optional context.
    for (const key of ['logs', 'events', 'probeResults', 'inputChannelTimeline']) {
      while (Array.isArray(result[key]) && result[key].length && bytes(result) > MAX_REPORT_BYTES) {
        result[key].shift(); result.truncation.dropped++;
      }
    }
    if (bytes(result) > MAX_REPORT_BYTES) {
      const trace = result.inputTrace || {};
      while (Array.isArray(trace.events) && trace.events.length && bytes(result) > MAX_REPORT_BYTES) {
        trace.events.shift(); result.truncation.dropped++;
      }
    }
    for (const key of ['network', 'terminal', 'traceSummary', 'inputState', 'inputTrace', 'startup', 'resources', 'adaptiveMedia', 'recommendation']) {
      if (bytes(result) <= MAX_REPORT_BYTES) break;
      result[key] = key === 'resources' ? null : (key === 'startup'
        ? { dataChannelWatchdog: sanitizeDataChannelWatchdog(result.startup?.dataChannelWatchdog), signalingFailure: sanitizeSignalingFailure(result.startup?.signalingFailure) } : {});
      result.truncation.dropped++;
    }
    // A malformed producer must not turn a bounded report into an unbounded write.
    if (bytes(result) > MAX_REPORT_BYTES) {
      result.latency = null; result.latencyStatus = 'collector-unavailable'; result.truncation.dropped++;
    }
    return result;
  }
  const storageIdentities = new Map();
  function storageHash(value) {
    if (!value) return null;
    if (!storageIdentities.has(value)) storageIdentities.set(value, randomHash());
    while (storageIdentities.size > 128) storageIdentities.delete(storageIdentities.keys().next().value);
    return storageIdentities.get(value);
  }
  // localStorage is also persistence: retain failure measurements, never raw IDs or UI content.
  function runtimeDiagnosticForStorage(payload, metricNames = []) {
    if (!payload.diagnosticId) return clone(payload); // Legacy entries retain their existing compatibility path.
    const safeNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    const digest = value => typeof value === 'string' && /^[a-f0-9]{16,64}$/.test(value) ? value : null;
    const latency = snapshot => snapshot ? { schemaVersion: 3, windowMs: 5000,
      scope: snapshot.scope ? { attemptHash: digest(snapshot.scope.attemptHash) || storageHash(snapshot.scope.connectionAttemptId),
        generation: safeNumber(snapshot.scope.generation), leaseEpoch: safeNumber(snapshot.scope.leaseEpoch) } : null,
      metrics: Object.fromEntries(metricNames.filter(name => snapshot.metrics?.[name]).map(name => [name, Object.fromEntries(
        ['last', 'p50', 'p95', 'count', 'available', 'lastSampleAgeMs'].map(key => [key, key === 'available' ? snapshot.metrics[name][key] === true : safeNumber(snapshot.metrics[name][key])]))])),
      outcomes: Object.fromEntries(['sent', 'acked', 'rejected', 'timedOut', 'late', 'cancelled', 'dropped', 'unmatched']
        .map(name => [name, safeNumber(snapshot.outcomes?.[name]) || 0])),
    } : null;
    const trace = payload.inputTrace || {};
    return { schemaVersion: 3, diagnosticId: digest(payload.diagnosticId), reason: payload.reason,
      trigger: payload.trigger, connectionAttemptId: storageHash(payload.connectionAttemptId),
      captured: clone(payload.captured), build: clone(payload.build), latencyStatus: payload.latencyStatus,
      latency: latency(payload.latency), inputState: {},
      inputTrace: { schemaVersion: 3, traceNowMs: safeNumber(trace.traceNowMs),
        counters: Object.fromEntries(Object.entries(trace.counters || {}).filter(([key, value]) => /^[a-zA-Z]{1,40}$/.test(key) && Number.isSafeInteger(value) && value >= 0)),
        events: (trace.events || []).slice(-256).map(event => ({ at: safeNumber(event.at), inputIdHash: digest(event.inputIdHash) })) },
      startup: { dataChannelWatchdog: sanitizeDataChannelWatchdog(payload.startup?.dataChannelWatchdog), signalingFailure: sanitizeSignalingFailure(payload.startup?.signalingFailure) }, resources: null, truncation: clone(payload.truncation || { dropped: 0 }),
      scopeEnded: { events: (payload.scopeEnded?.events || []).map(event => ({ eventIdHash: digest(event.eventIdHash), endedAtMs: event.endedAtMs, snapshot: latency(event.snapshot) })),
        dropped: payload.scopeEnded?.dropped || 0 },
    };
  }
  function createRuntimeDiagnosticBuilder({ nowMs = () => performance.now(), wallNow = () => new Date().toISOString(),
    getScope, getBuild, getInput, getStartup, getResources, getLatency, takeClosedScopeSummaries,
  } = {}) {
    const bootIdHash = randomHash();
    let events = []; let dropped = 0;
    // Only digest tombstones are retained. Ten pending reports can each reference
    // at most four events; core removes confirmed references from all of them on ACK.
    const confirmedEvents = new Map();
    const prune = now => {
      for (const [id, confirmedAt] of confirmedEvents) {
        if (now < confirmedAt || now - confirmedAt > 60000) confirmedEvents.delete(id);
      }
      while (confirmedEvents.size > 40) confirmedEvents.delete(confirmedEvents.keys().next().value);
      const fresh = events.filter(event => now >= event.endedAtMs && now - event.endedAtMs <= 60000);
      dropped += events.length - fresh.length; events = fresh;
      while (events.length > 4 || bytes({ events, confirmed: [...confirmedEvents] }) > MAX_SCOPE_BYTES) { events.shift(); dropped++; }
    };
    const build = ({ reason = null } = {}) => {
      const monotonicMs = read(nowMs, 0);
      prune(monotonicMs);
      // This is the only M1 drain. Retries transmit the captured object, never call build.
      const closed = read(takeClosedScopeSummaries, null, { nowMs: monotonicMs });
      if (closed) {
        dropped += Number.isSafeInteger(closed.dropped) && closed.dropped >= 0 ? closed.dropped : 0;
        for (const summary of (closed.summaries || [])) {
          events.push({ eventIdHash: randomHash(), endedAtMs: summary.endedAtMs, snapshot: clone(summary.snapshot) });
        }
        prune(monotonicMs);
      }
      const scope = read(getScope, null);
      const latency = read(getLatency, null, { nowMs: monotonicMs, scope });
      const input = read(getInput, {});
      const startup = read(getStartup, {});
      return boundRuntimeDiagnostic({ schemaVersion: 3, diagnosticId: randomHash(), reason,
        captured: { wallTime: read(wallNow, null), monotonicMs, bootIdHash },
        build: read(getBuild, { id: null, builtAt: null }),
        latencyStatus: latency ? 'available' : 'collector-unavailable', latency,
        inputState: input.inputState || {}, inputTrace: input.inputTrace || {},
        startup: { ...startup, dataChannelWatchdog: sanitizeDataChannelWatchdog(startup?.dataChannelWatchdog), signalingFailure: sanitizeSignalingFailure(read(() => startup?.signalingFailure, null)) }, resources: read(getResources, null),
        scopeEnded: { events: clone(events), dropped },
      });
    };
    build.prepareReplay = payload => {
      prune(read(nowMs, 0));
      const result = clone(payload);
      if (result.scopeEnded) {
        const owned = new Set(events.map(event => event.eventIdHash));
        const original = result.scopeEnded.events || [];
        result.scopeEnded.events = original.filter(event => owned.has(event.eventIdHash));
        result.scopeEnded.dropped += original.filter(event => !owned.has(event.eventIdHash) && !confirmedEvents.has(event.eventIdHash)).length;
      }
      return result;
    };
    build.acknowledge = ids => {
      const now = read(nowMs, 0);
      for (const id of (ids || [])) confirmedEvents.set(id, now);
      events = events.filter(event => !confirmedEvents.has(event.eventIdHash));
      prune(now);
    };
    return build;
  }
  const api = { sanitizeSignalingFailure, sanitizeDataChannelWatchdog, createRuntimeDiagnosticBuilder, boundRuntimeDiagnostic, runtimeDiagnosticForStorage, runtimeDiagnosticBytes: bytes };
  Object.assign(global, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
