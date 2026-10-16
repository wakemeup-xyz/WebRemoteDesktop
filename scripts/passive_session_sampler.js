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
  window.__wrdPassiveSampler = {
    async sample() {
      attach();
      const client = typeof WebRTC === 'undefined' ? null : WebRTC;
      const pc = client?.pc;
      if (pc && !identities.has(pc)) identities.set(pc, ++identity);
      const scope = { ...client?.latencyScope?.() };
      const buildId = window.__WRD_BUILD__?.id;
      let snapshot = null;
      try { snapshot = typeof LatencyMonitor === 'undefined' ? null : LatencyMonitor.snapshot(); } catch (_) {}
      const metrics = {};
      for (const name of metricNames) {
        const row = snapshot?.metrics?.[name];
        metrics[name] = row ? { available: row.available === true, count: finite(row.count),
          last: finite(row.last), p95: finite(row.p95), lastSampleAgeMs: finite(row.lastSampleAgeMs) } : null;
      }
      const sampledPc = pc;
      const transport = await statsFor(pc);
      const currentScope = client?.latencyScope?.();
      const scopeStable = client === (typeof WebRTC === 'undefined' ? null : WebRTC)
        && client?.pc === sampledPc && window.__WRD_BUILD__?.id === buildId
        && ['connectionAttemptId', 'generation', 'leaseEpoch'].every(key => scope[key] === currentScope?.[key]);
      const now = performance.now();
      return { schemaVersion: 1, browserNowMs: now, scopeStable,
        socketConnected: client?.socket?.connected === true,
        pcIdentity: pc ? identities.get(pc) : null,
        pcState: oneOf(pc?.connectionState, ['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed']),
        transport: scopeStable ? transport : { status: 'scope-changed' },
        attempt: typeof scope?.connectionAttemptId === 'string' ? scope.connectionAttemptId : null,
        generation: finite(scope?.generation), leaseEpoch: finite(scope?.leaseEpoch),
        mediaPhase: oneOf(client?.getMediaAppliedPhase?.(), ['active', 'paused', 'resuming', 'suspending', 'suspended']),
        inputAllowed: typeof Input !== 'undefined' && Input.getEffectiveInputGate?.().allowed === true,
        callbacks, lastFrameAtMs: lastFrameAt,
        frameAgeMs: lastFrameAt === null ? null : Math.max(0, now - lastFrameAt),
        maxFrameGapMs, width: finite(video?.videoWidth), height: finite(video?.videoHeight),
        relayFrameSeq: finite(client?._lastRenderedRelayFrame?.frameSeq),
        tunnelRelayActive: client?.tunnelRelayActive === true,
        relayLoadCallbacks, lastRelayLoadAtMs: lastRelayLoadAt,
        relayLoadAgeMs: lastRelayLoadAt === null ? null : Math.max(0, now - lastRelayLoadAt),
        maxRelayLoadGapMs, relayEvidenceKind: 'image-load-event-not-optical-presentation',
        buildId: typeof buildId === 'string' ? buildId : null,
        metrics };
    },
    stop() {
      stopped = true; if (callback !== null) video?.cancelVideoFrameCallback?.(callback);
      relayImage?.removeEventListener?.('load', relayLoaded);
    },
  };
})();
