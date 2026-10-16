/* Acceptance-only passive sampler. Never sends input or changes application state. */
(() => {
  if (window.__wrdPassiveSampler) return;
  const finite = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
  const oneOf = (v, values) => values.includes(v) ? v : 'unknown';
  const identities = new WeakMap();
  let identity = 0, video = null, callback = null, stopped = false;
  let callbacks = 0, lastFrameAt = null, maxFrameGapMs = 0, statsPending = null;
  const attach = () => {
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
      let pair = null, inbound = null;
      for (const row of stats.values()) {
        if (row.type === 'transport' && row.selectedCandidatePairId) pair = stats.get(row.selectedCandidatePairId);
        if (row.type === 'inbound-rtp' && (row.kind === 'video' || row.mediaType === 'video')) inbound = row;
      }
      const local = pair && stats.get(pair.localCandidateId);
      const remote = pair && stats.get(pair.remoteCandidateId);
      const codec = inbound && stats.get(inbound.codecId);
      return { status: pair ? 'observed' : 'unavailable',
        localType: oneOf(local?.candidateType, ['host', 'srflx', 'prflx', 'relay']),
        remoteType: oneOf(remote?.candidateType, ['host', 'srflx', 'prflx', 'relay']),
        protocol: oneOf(local?.protocol, ['udp', 'tcp']),
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
      const scope = client?.latencyScope?.();
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
      return { schemaVersion: 1, browserNowMs: performance.now(),
        socketConnected: client?.socket?.connected === true,
        pcIdentity: pc ? identities.get(pc) : null,
        pcState: oneOf(pc?.connectionState, ['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed']),
        transport: client?.pc === sampledPc ? transport : { status: 'scope-changed' },
        attempt: typeof scope?.connectionAttemptId === 'string' ? scope.connectionAttemptId : null,
        generation: finite(scope?.generation), leaseEpoch: finite(scope?.leaseEpoch),
        mediaPhase: oneOf(client?.getMediaAppliedPhase?.(), ['active', 'paused', 'resuming', 'suspending', 'suspended']),
        inputAllowed: typeof Input !== 'undefined' && Input.getEffectiveInputGate?.().allowed === true,
        callbacks, frameAgeMs: lastFrameAt === null ? null : Math.max(0, performance.now() - lastFrameAt),
        maxFrameGapMs, width: finite(video?.videoWidth), height: finite(video?.videoHeight),
        relayFrameSeq: finite(client?._lastRenderedRelayFrame?.frameSeq),
        buildId: typeof window.__WRD_BUILD__?.id === 'string' ? window.__WRD_BUILD__.id : null,
        metrics };
    },
    stop() { stopped = true; if (callback !== null) video?.cancelVideoFrameCallback?.(callback); },
  };
})();
