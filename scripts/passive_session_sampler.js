/* Acceptance observer after ordinary guarded connection; sends no business input.
 * Normal connection/grant/reset safety behavior belongs to the application. */
(() => {
  if (window.__wrdPassiveSampler) return;
  const finite = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
  const oneOf = (v, values) => values.includes(v) ? v : 'unknown';
  const identities = new WeakMap();
  const pathIdentities = new Map(); // Raw stats IDs stay in this disposable browser only.
  const opaquePath = ids => {
    if (!ids.every(id => typeof id === 'string' && id.length > 0 && id.length <= 256)) return null;
    const key = JSON.stringify(ids);
    if (!pathIdentities.has(key)) {
      if (pathIdentities.size >= 1024) return null;
      pathIdentities.set(key, `path-${pathIdentities.size + 1}`);
    }
    return pathIdentities.get(key);
  };
  let identity = 0, video = null, callback = null, stopped = false;
  let callbacks = 0, lastFrameAt = null, maxFrameGapMs = 0, statsPending = null;
  let relayImage = null, relayLoadCallbacks = 0, lastRelayLoadAt = null, maxRelayLoadGapMs = 0;
  // Fixed, run-local diagnostics. No socket IDs, packet data or error messages.
  const LIMIT = 999999999, TIME_LIMIT = 43320000;
  const began = performance.now();
  const integer = (value, max = LIMIT) => Number.isFinite(value) && value >= 0 ? Math.min(max, Math.round(value)) : null;
  const anchor = value => Number.isFinite(value) && value >= 0 && value <= 9999999999999 ? Math.round(value) : null;
  const anchors = { browserWallEpochMs: anchor(Date.now()),
    browserTimeOriginEpochMs: anchor(performance.timeOrigin), browserAnchorNowMs: anchor(began) };
  const kinds = ['sd','mc','ec','se','re','rx','tx','sc','mo','ra','rr','rf','ep','eo','ef','eu','bind',
    'vis','net','focus','hide','show','freeze','resume','preclose','cap'];
  const counters = Object.fromEntries(kinds.map(k => [k, 0]));
  const events = [], labels = new WeakMap(), bindings = {s:null,m:null,e:null};
  const bindingCounts = {s:0,m:0,e:0}, boundAtMs = {s:null,m:null,e:null};
  let sequence = 0, droppedEvents = 0, cursor = 0, bindingChanges = 0;
  let firstDisconnectEvent = null, coverageStatus = 'partial', coverageFailure = 'none';
  let missingReferences = 0, observerTimer = null, observedTransport = 'unknown';
  const lag = {lastMs:null,maxMs:0,count:0,missedIntervals:0,buckets:[0,0,0,0]};
  const state = {visibility:'unknown',online:null,focus:null,socketState:'unavailable',
    pingReceivedAtMs:null,pongCreatedAtMs:null,flushAtMs:null,lag};
  const elapsed = () => { const value = Math.max(0, performance.now()-began);
    return value <= TIME_LIMIT ? integer(value,TIME_LIMIT) : null; };
  const current = prefix => {
    const socket = typeof WebRTC === 'undefined' ? null : WebRTC?.socket;
    return prefix === 's' ? socket : prefix === 'm' ? socket?.io : socket?.io?.engine;
  };
  const capacity = () => {
    coverageStatus = 'capacity'; coverageFailure = 'schema-capacity';
    if (!counters.cap && sequence < LIMIT) {
      const event = {t:elapsed(),n:++sequence,k:'cap'};
      if (event.t !== null) { if (events.length === 128) { events.shift(); droppedEvents = Math.min(LIMIT, droppedEvents+1); }
        events.push(event); counters.cap = 1; }
    }
  };
  const record = (k, fields = {}) => {
    if (stopped) return;
    const t = elapsed();
    if (t === null || performance.now() - began > TIME_LIMIT || sequence >= LIMIT-1 || counters[k] >= LIMIT) {
      capacity(); return;
    }
    const event = {t,n:++sequence,k,...fields};
    if (JSON.stringify(event).length > 192) { capacity(); return; }
    counters[k]++;
    if (['sd','mc','ec','se','re'].includes(k) && firstDisconnectEvent === null) firstDisconnectEvent = {...event};
    if (events.length === 128) { events.shift(); droppedEvents = Math.min(LIMIT, droppedEvents+1); }
    events.push(event);
    if (k === 'rx' && fields.p === 'ping') state.pingReceivedAtMs = t;
    if (k === 'tx' && fields.p === 'pong') state.pongCreatedAtMs = t;
    if (k === 'ef') state.flushAtMs = t;
  };
  const reasons = {'io server disconnect':'server','io client disconnect':'client','ping timeout':'ping',
    'transport close':'transport-close','transport error':'transport-error','parse error':'parse','forced close':'forced'};
  const reason = (value, prefix) => typeof value === 'string'
    && (prefix === 's' || !['io server disconnect','io client disconnect'].includes(value))
    && Object.prototype.hasOwnProperty.call(reasons,value) ? reasons[value] : 'unknown';
  const detach = binding => {
    if (binding) for (const [name, fn] of binding.listeners) binding.object.off?.(name, fn);
  };
  const bind = (prefix, object) => {
    if (bindings[prefix]?.object === object) return;
    detach(bindings[prefix]); bindings[prefix] = null;
    if (!object || typeof object.on !== 'function' || typeof object.off !== 'function') return;
    if (bindingChanges >= 64 || elapsed() === null) { capacity(); return; }
    bindingChanges++;
    if (!labels.has(object)) labels.set(object, prefix + (++bindingCounts[prefix]));
    const label = labels.get(object), listeners = [];
    bindings[prefix] = {object,listeners}; boundAtMs[prefix] = elapsed();
    const observe = (name, k, project, rebind = false) => {
      const fn = (...args) => {
        if (stopped) return;
        // An emitter may have copied this callback before our exact off(). Keep
        // terminal evidence from the enrolled object, even after product mutation.
        record(k,{o:label,c:current(prefix) === object,...(project ? project(...args) : {})});
        if (rebind) scan();
      };
      object.on(name,fn); listeners.push([name,fn]);
    };
    record('bind',{o:label,c:current(prefix) === object});
    if (prefix === 's') {
      observe('disconnect','sd',value => ({r:reason(value,prefix)}));
      observe('connect_error','se',error => ({r:error?.type === 'TransportError' ? 'transport-error':'unknown'}));
      observe('connect','sc',null,true);
    } else if (prefix === 'm') {
      observe('open','mo',null,true);
      observe('close','mc',value => ({r:reason(value,prefix)}));
      observe('reconnect_attempt','ra');
      // One microtask reads existing references after the Manager assigns engine.
      const retry = () => { if (!stopped && current('m') === object) Promise.resolve().then(() => { if (!stopped) scan(); }); };
      object.on('reconnect_attempt',retry); listeners.push(['reconnect_attempt',retry]);
      observe('reconnect','rr',null,true);
      observe('reconnect_error','re',error => ({r:error?.type === 'TransportError' ? 'transport-error':'unknown'}));
      observe('reconnect_failed','rf');
    } else {
      observe('close','ec',(value,details) => {
        const fields = {r:reason(value,prefix)};
        try {
          if (value === 'transport close' && details !== null && typeof details === 'object'
              && details.description === 'websocket connection closed') {
            const context = details.context;
            if (context !== null && typeof context === 'object') {
              const code = context.code, wasClean = context.wasClean;
              if (Number.isInteger(code) && code >= 1000 && code <= 4999 && typeof wasClean === 'boolean') {
                fields.ws = {code,wasClean};
              }
            }
          }
        } catch (_) { /* Missing or unreadable native metadata remains absent. */ }
        return fields;
      });
      observe('packet','rx',packet => ({p:oneOf(packet?.type,['ping','pong'])}));
      observe('packetCreate','tx',packet => ({p:oneOf(packet?.type,['ping','pong'])}));
      for (const [name,k] of [['ping','ep'],['pong','eo'],['flush','ef'],['upgrade','eu']]) observe(name,k);
    }
  };
  const scan = () => {
    if (stopped) return;
    for (const prefix of ['s','m','e']) bind(prefix,current(prefix));
    observedTransport = oneOf(current('e')?.transport?.name,['websocket','polling']);
    state.socketState = !current('s') ? 'unavailable' : current('s').connected === true ? 'connected':'state-observed-disconnected';
    if (Object.values(bindings).some(value => !value)) missingReferences = Math.min(LIMIT, missingReferences+1);
  };
  const domListeners = [];
  const dom = (target,name,fn) => { if (target?.addEventListener && target?.removeEventListener) {
    target.addEventListener(name,fn); domListeners.push([target,name,fn]); } };
  const visibility = () => { state.visibility = oneOf(document.visibilityState,['visible','hidden','prerender']); record('vis',{v:state.visibility}); };
  const online = () => { state.online = typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean' ? navigator.onLine:null; record('net',{v:state.online}); };
  const focus = value => { state.focus = value; record('focus',{v:value}); };
  visibility(); online();
  try { const value = typeof document.hasFocus === 'function' ? document.hasFocus():null;
    focus(typeof value === 'boolean' ? value:null); } catch (_) { focus(null); }
  dom(document,'visibilitychange',visibility);
  dom(window,'online',online); dom(window,'offline',online);
  dom(window,'focus',() => focus(true)); dom(window,'blur',() => focus(false));
  for (const [name,k,target] of [['pagehide','hide',window],['pageshow','show',window],
    ['freeze','freeze',document],['resume','resume',document]]) dom(target,name,() => record(k));
  let expected = performance.now()+1000;
  const schedule = () => {
    observerTimer = setTimeout(() => {
      if (stopped) return;
      const now = performance.now(); if (elapsed() === null) capacity();
      const delay = Math.max(0,now-expected), missed = Math.floor(delay/1000);
      lag.lastMs = integer(delay); lag.maxMs = Math.max(lag.maxMs,lag.lastMs);
      lag.count = Math.min(LIMIT,lag.count+1); lag.missedIntervals = Math.min(LIMIT,lag.missedIntervals+missed);
      const bucket = delay < 100 ? 0 : delay < 500 ? 1 : delay < 1000 ? 2 : 3;
      lag.buckets[bucket] = Math.min(LIMIT,lag.buckets[bucket]+1);
      expected += (missed+1)*1000;
      scan(); schedule();
    },Math.max(0,expected-performance.now()));
  };
  const snapshot = () => {
    if (!stopped) scan();
    return JSON.parse(JSON.stringify({schemaVersion:1,anchors,
      attribution:{firstDisconnectEvent,cause:'unknown'},counters,state,
      coverage:{status:coverageStatus,failure:coverageFailure,observedFromMs:0,boundAtMs,
        bindingChanges:Math.min(LIMIT,bindingChanges),missingReferences,
        transport:observedTransport},
      droppedEvents,events}));
  };
  const drain = () => {
    const available = events.filter(event => event.n > cursor), tail = available.slice(0,16);
    const gap = available.length && available[0].n > cursor+1 ? available[0].n-cursor-1 : 0;
    if (tail.length) cursor = tail[tail.length-1].n;
    return JSON.parse(JSON.stringify({schemaVersion:1,events:tail,cursor,gap,
      truncated:available.length > tail.length,droppedEvents,coverageStatus,
      firstDisconnectEvent,cause:'unknown'}));
  };
  scan(); schedule();
  const relayLoaded = () => {
    if (stopped) return;
    const now = performance.now();
    if (lastRelayLoadAt !== null) maxRelayLoadGapMs = Math.max(maxRelayLoadGapMs, now - lastRelayLoadAt);
    lastRelayLoadAt = now; relayLoadCallbacks += 1;
  };
  const attach = () => {
    const nextRelay = document.getElementById('relayImage');
    if (nextRelay !== relayImage) {
      relayImage?.removeEventListener?.('load', relayLoaded);
      relayImage = nextRelay;
      relayImage?.addEventListener?.('load', relayLoaded);
    }
    const next = document.getElementById('remoteVideo');
    if (next === video || !next?.requestVideoFrameCallback) return;
    if (callback !== null) video?.cancelVideoFrameCallback?.(callback);
    video = next;
    const observed = next;
    const frame = now => {
      if (stopped || video !== observed) return;
      if (lastFrameAt !== null) maxFrameGapMs = Math.max(maxFrameGapMs, now - lastFrameAt);
      lastFrameAt = now; callbacks += 1;
      callback = observed.requestVideoFrameCallback(frame);
    };
    callback = observed.requestVideoFrameCallback(frame);
  };
  const metricNames = ['inputAckRttMs', 'inputToPostApplyFrameMs', 'inputToVisibleEffectMs',
    'hostQueueMs', 'hostApplyMs', 'hostAdapterAwaitMs', 'paintIntervalMs', 'freshFrameAgeMs',
    'candidateRttMs', 'jitterBufferMs', 'decodeMs', 'encoderMs', 'relayFrameAckRttMs'];
  const statsFor = async pc => {
    if (!pc?.getStats) return { status: 'unavailable' };
    if (statsPending) return { status: 'pending' };
    const pending = Promise.resolve().then(() => pc.getStats());
    statsPending = pending;
    pending.finally(() => { if (statsPending === pending) statsPending = null; }).catch(() => {});
    let timer;
    try {
      const stats = await Promise.race([pending,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('stats-deadline')), 800); })]);
      let pair = null, pairId = null, inbound = null;
      for (const row of stats.values()) {
        if (row.type === 'transport' && row.selectedCandidatePairId) {
          pairId = row.selectedCandidatePairId; pair = stats.get(pairId);
        }
        if (row.type === 'inbound-rtp' && (row.kind === 'video' || row.mediaType === 'video')) inbound = row;
      }
      const local = pair && stats.get(pair.localCandidateId);
      const remote = pair && stats.get(pair.remoteCandidateId);
      const codec = inbound && stats.get(inbound.codecId);
      return { status: pair && local && remote ? 'observed' : 'unavailable',
        pathIdentity: pair && local && remote ? opaquePath([pairId, pair.localCandidateId, pair.remoteCandidateId]) : null,
        localType: oneOf(local?.candidateType, ['host', 'srflx', 'prflx', 'relay']),
        remoteType: oneOf(remote?.candidateType, ['host', 'srflx', 'prflx', 'relay']),
        protocol: oneOf(local?.protocol, ['udp', 'tcp']),
        remoteProtocol: oneOf(remote?.protocol, ['udp', 'tcp']),
        relayProtocol: oneOf(local?.relayProtocol, ['udp', 'tcp', 'tls']),
        rttMs: finite(pair?.currentRoundTripTime) === null ? null : pair.currentRoundTripTime * 1000,
        bytesReceived: finite(inbound?.bytesReceived), framesDecoded: finite(inbound?.framesDecoded),
        framesDropped: finite(inbound?.framesDropped),
        codec: oneOf(String(codec?.mimeType || '').toLowerCase(), ['video/h264', 'video/vp8', 'video/vp9', 'video/av1']) };
    } catch (_) { return { status: 'unavailable' }; }
    finally { clearTimeout(timer); }
  };
  const bool = value => typeof value === 'boolean' ? value : null;
  const boundedTime = value => finite(value) !== null && value <= 9999999999999 ? value : null;
  const gateEnums = {
    uiPhase:['idle','signaling','media-pending','connected','media-stalled','disconnected'],
    desiredMediaState:['active','suspended'], mediaRuntimePhase:['active','suspending','suspended','resuming'],
    keyboardControllerState:['INACTIVE','READY','BLOCKED','RESET_REQUIRED'],
    keyboardTransportState:['ready','blocked','reacquire-required','revoked'],
    surfaceState:['settled','pending','uncertain'],
    desktopWriteRecoveryState:['none','reacquire-required','reconciled'],
    recoveryState:['idle','waiting','recovered','failed'],
  };
  const gateBooleans = ['allowed','inputActive','hasInputLease','viewportSupported','hasPaintedFrame',
    'currentAttemptReady','hasActiveControl','socketConnected','manualDisconnect','superseded',
    'mouseResetPending','draftComposing','draftPending','draftUncertain','firstFrameTimerHandlePresent'];
  const gateReasons = new Set(['no-active-control','inactive','viewport-unsupported','manual-disconnect',
    'media-not-ready-for-attempt','media-gate',
    ...['active','suspending','suspended','resuming','unknown'].map(v => `runtime-phase:${v}`),
    ...['active','suspended','unknown'].map(v => `media-state:${v}`),
    'keyboard-transport-blocked','keyboard-transport-reacquire-required','keyboard-transport-revoked',
    'keyboard-reset-pending','keyboard-blocked','surface-pending','surface-uncertain','mouse-reset-pending',
    'desktop-write-reacquire-required','draft-composing','draft-pending','draft-uncertain',
    'recovery-waiting','recovery-failed','unknown']);
  const emptyGate = status => ({status, ...Object.fromEntries(gateBooleans.map(k => [k,null])),
    ...Object.fromEntries(Object.keys(gateEnums).map(k => [k,'unknown'])), blockedReasons:[]});
  const owner = () => {
    const client = typeof WebRTC === 'undefined' ? null : WebRTC;
    return {client,pc:client?.pc,input:typeof Input === 'undefined' ? null : Input,
      socket:client?.socket,buildId:window.__WRD_BUILD__?.id,scope:{...client?.latencyScope?.()}};
  };
  const stillOwner = captured => {
    let next;
    try { next = owner(); } catch (_) { return false; }
    return ['client','pc','input','socket','buildId'].every(k => captured[k] === next[k])
      && ['connectionAttemptId','generation','leaseEpoch'].every(k => captured.scope[k] === next.scope[k]);
  };
  const markNames = ['start-click','bootstrap-start','bootstrap-ready','bootstrap-degraded',
    'signal-connected','first-frame','active'];
  const startupMarks = () => {
    const result = Object.fromEntries(markNames.map(k => [k,null]));
    try {
      const marks = typeof StartupTelemetry === 'undefined' ? null : StartupTelemetry.snapshot?.()?.marks;
      if (Array.isArray(marks) && marks.length <= 1024) for (const mark of marks) {
        if (mark && typeof mark.name === 'string' && Object.prototype.hasOwnProperty.call(result,mark.name) && result[mark.name] === null) {
          result[mark.name] = boundedTime(mark.atMs);
        }
      }
    } catch (_) { /* Missing marks stay null; no arbitrary details cross. */ }
    return result;
  };
  const projectGate = captured => {
    if (!stillOwner(captured)) return emptyGate('scope-changed');
    const {client,input,socket} = captured;
    if (!client || !input || typeof input.getEffectiveInputGate !== 'function') return emptyGate('unavailable');
    try {
      const controller = input.keyboardController?.getSnapshot?.();
      const transport = input.keyboardTransport?.getSnapshot?.();
      const draft = input.mobileTextInputAdapter?.getSnapshot?.();
      const media = client.mediaActivityRuntime?.snapshot?.();
      // Read the effective verdict once after the other reconciling getters.
      // Both the compatibility boolean and the projection use this result.
      const effective = input.getEffectiveInputGate();
      const value = emptyGate('observed');
      const nullablePresence = (object,key) => key in object ? Boolean(object[key]) : null;
      Object.assign(value, {
        allowed:bool(effective?.allowed), inputActive:bool(input.isActive),
        hasInputLease:nullablePresence(input,'activeControlLease'), viewportSupported:bool(input._viewportInputSupported),
        uiPhase:client.uiPhase, hasPaintedFrame:bool(client.hasPaintedFrame),
        currentAttemptReady:'currentConnectionAttemptId' in client
          ? !client.currentConnectionAttemptId || client._mediaReadyConnectionAttemptId === client.currentConnectionAttemptId : null,
        hasActiveControl:bool(client.hasActiveControl?.()), socketConnected:bool(socket?.connected),
        manualDisconnect:bool(client.manualDisconnect), superseded:bool(client._superseded),
        desiredMediaState:media?.desiredState, mediaRuntimePhase:client.mediaActivityRuntime?.phase,
        keyboardControllerState:controller?.state, keyboardTransportState:transport?.state,
        surfaceState:input._mobileSurfaceState, mouseResetPending:nullablePresence(input,'_pendingMouseReset'),
        desktopWriteRecoveryState:'_desktopWriteRecovery' in input
          ? input._desktopWriteRecovery === null ? 'none' : input._desktopWriteRecovery?.state : 'unknown',
        draftComposing:bool(draft?.composing), draftPending:bool(draft?.hasPending),
        draftUncertain:bool(draft?.deliveryUncertain), recoveryState:input._recoveryCycle?.state,
        firstFrameTimerHandlePresent:Object.prototype.hasOwnProperty.call(client,'_firstFrameTimer')
          ? client._firstFrameTimer !== null : null,
      });
      for (const [key,values] of Object.entries(gateEnums)) value[key] = oneOf(value[key],values);
      // Inspect at most 32 entries. Any malformed/over-limit list is unknown.
      const reasons = effective?.blockedReasons;
      if (!Array.isArray(reasons) || reasons.length > 32) value.blockedReasons = ['unknown'];
      else for (const reason of reasons) {
        const safe = typeof reason === 'string' && gateReasons.has(reason) ? reason : 'unknown';
        if (!value.blockedReasons.includes(safe)) value.blockedReasons.push(safe);
      }
      if (!stillOwner(captured)) return emptyGate('scope-changed');
      return JSON.stringify(value).length <= 4096 ? value : emptyGate('unavailable');
    } catch (_) { return emptyGate(stillOwner(captured) ? 'unavailable' : 'scope-changed'); }
  };
  const evidenceSnapshot = (captured = owner()) => {
    let inputGate = projectGate(captured);
    const marks = startupMarks();
    // Snapshot/getter reconciliation may have changed the owner during capture.
    if (!stillOwner(captured)) inputGate = emptyGate('scope-changed');
    return {browserNowMs:boundedTime(performance.now()),inputGate,startupMarks:marks};
  };
  window.__wrdPassiveSampler = {
    async sample() {
      if (!stopped) { attach(); scan(); }
      const captured = owner();
      const {client,pc,scope,buildId} = captured;
      if (pc && !identities.has(pc)) identities.set(pc, ++identity);
      let snapshot = null;
      try { snapshot = typeof LatencyMonitor === 'undefined' ? null : LatencyMonitor.snapshot(); } catch (_) {}
      const metrics = {};
      for (const name of metricNames) {
        const row = snapshot?.metrics?.[name];
        metrics[name] = row ? { available: row.available === true, count: finite(row.count),
          last: finite(row.last), p95: finite(row.p95), lastSampleAgeMs: finite(row.lastSampleAgeMs) } : null;
      }
      const transport = await statsFor(pc);
      const mediaPhase = oneOf(client?.getMediaAppliedPhase?.(), ['active','paused','resuming','suspending','suspended']);
      const evidence = evidenceSnapshot(captured);
      const scopeStable = stillOwner(captured);
      const now = evidence.browserNowMs;
      return { schemaVersion: 1, browserNowMs: now, scopeStable,
        socketConnected: client?.socket?.connected === true,
        pcIdentity: pc ? identities.get(pc) : null,
        pcState: oneOf(pc?.connectionState, ['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed']),
        transport: scopeStable ? transport : { status: 'scope-changed' },
        attempt: typeof scope?.connectionAttemptId === 'string' ? scope.connectionAttemptId : null,
        generation: finite(scope?.generation), leaseEpoch: finite(scope?.leaseEpoch),
        mediaPhase,
        inputAllowed: evidence.inputGate.allowed === true,
        inputGate:evidence.inputGate, startupMarks:evidence.startupMarks,
        callbacks, lastFrameAtMs: lastFrameAt,
        frameAgeMs: lastFrameAt === null ? null : Math.max(0, now - lastFrameAt),
        maxFrameGapMs, width: finite(video?.videoWidth), height: finite(video?.videoHeight),
        relayFrameSeq: finite(client?._lastRenderedRelayFrame?.frameSeq),
        tunnelRelayActive: client?.tunnelRelayActive === true,
        relayLoadCallbacks, lastRelayLoadAtMs: lastRelayLoadAt,
        relayLoadAgeMs: lastRelayLoadAt === null ? null : Math.max(0, now - lastRelayLoadAt),
        maxRelayLoadGapMs, relayEvidenceKind: 'image-load-event-not-optical-presentation',
        buildId: typeof buildId === 'string' ? buildId : null,
        metrics, diagnostics:drain() };
    },
    evidenceSnapshot,
    diagnosticSnapshot: snapshot,
    finalize() {
      if (!stopped) { scan(); record('preclose'); }
      const final = snapshot(); this.stop(); return final;
    },
    stop() {
      if (stopped) return snapshot();
      stopped = true; clearTimeout(observerTimer);
      for (const binding of Object.values(bindings)) detach(binding);
      for (const [target,name,fn] of domListeners) target.removeEventListener(name,fn);
      if (callback !== null) video?.cancelVideoFrameCallback?.(callback);
      relayImage?.removeEventListener?.('load', relayLoaded);
      return snapshot();
    },
  };
})();
