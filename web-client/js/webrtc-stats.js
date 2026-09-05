const WebRtcStats = (() => {
  function reportsOf(stats) {
    if (!stats) return [];
    if (typeof stats.values === 'function') return Array.from(stats.values());
    if (typeof stats.forEach === 'function') {
      const reports = [];
      stats.forEach((report) => reports.push(report));
      return reports;
    }
    return [];
  }

  function getReport(stats, id) {
    if (!id) return null;
    if (typeof stats?.get === 'function') return stats.get(id) || null;
    return reportsOf(stats).find((report) => report.id === id) || null;
  }

  function selectActiveCandidatePair(stats) {
    const reports = reportsOf(stats);
    const transport = reports.find(
      (report) => report.type === 'transport' && report.selectedCandidatePairId,
    );
    let pair = getReport(stats, transport?.selectedCandidatePairId);
    if (!pair) {
      pair = reports.find(
        (report) => report.type === 'candidate-pair'
          && report.state === 'succeeded'
          && (report.selected === true || report.nominated === true),
      );
    }
    if (!pair) {
      pair = reports.find(
        (report) => report.type === 'candidate-pair' && report.state === 'succeeded',
      );
    }
    return {
      pair: pair || null,
      local: getReport(stats, pair?.localCandidateId),
      remote: getReport(stats, pair?.remoteCandidateId),
    };
  }

  function nonNegativeDelta(previous, current) {
    const before = Number(previous);
    const after = Number(current);
    if (!Number.isFinite(after)) return 0;
    if (!Number.isFinite(before) || after < before) return 0;
    return after - before;
  }

  function deriveIntervalMediaStats(previous, current) {
    const elapsedMs = Math.max(0, Number(current?.sampledAt || 0) - Number(previous?.sampledAt || 0));
    const receivedDelta = nonNegativeDelta(previous?.framesReceived, current?.framesReceived);
    const decodedDelta = nonNegativeDelta(previous?.framesDecoded, current?.framesDecoded);
    const packetsLostDelta = nonNegativeDelta(previous?.packetsLost, current?.packetsLost);
    const bytesDelta = nonNegativeDelta(previous?.bytesReceived, current?.bytesReceived);
    const jitterDelay = nonNegativeDelta(previous?.jitterBufferDelay, current?.jitterBufferDelay);
    const jitterCount = nonNegativeDelta(
      previous?.jitterBufferEmittedCount,
      current?.jitterBufferEmittedCount,
    );
    const framesDroppedDelta = nonNegativeDelta(previous?.framesDropped, current?.framesDropped);
    const packetsReceivedDelta = nonNegativeDelta(previous?.packetsReceived, current?.packetsReceived);
    const nackCountDelta = nonNegativeDelta(previous?.nackCount, current?.nackCount);
    const pliCountDelta = nonNegativeDelta(previous?.pliCount, current?.pliCount);
    const firCountDelta = nonNegativeDelta(previous?.firCount, current?.firCount);
    const freezeDelta = nonNegativeDelta(previous?.freezeCount, current?.freezeCount);
    return {
      elapsedMs,
      derivedFps: elapsedMs > 0 ? Math.round((decodedDelta * 1000 / elapsedMs) * 10) / 10 : 0,
      receivedDelta,
      decodedDelta,
      packetsLostDelta,
      bytesDelta,
      jitterBufferMs: jitterCount > 0 ? Math.round((jitterDelay / jitterCount * 1000) * 10) / 10 : 0,
      framesDroppedDelta,
      packetsReceivedDelta,
      nackCountDelta,
      pliCountDelta,
      firCountDelta,
      freezeDelta,
    };
  }

  function address(candidate) {
    const host = String(candidate?.address || candidate?.ip || '');
    const port = Number(candidate?.port || 0);
    if (!host || !port) return '';
    return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
  }

  function addressFamily(value) {
    if (!value) return '';
    return String(value).includes(':') ? 'ipv6' : 'ipv4';
  }

  function normalizeStats(stats, previous, sampledAt) {
    const reports = reportsOf(stats);
    const inbound = reports.find(
      (report) => report.type === 'inbound-rtp' && (report.kind === 'video' || report.mediaType === 'video'),
    ) || {};
    const selected = selectActiveCandidatePair(stats);
    const codec = getReport(stats, inbound.codecId);
    const current = {
      sampledAt,
      framesReceived: Number(inbound.framesReceived || 0),
      framesDecoded: Number(inbound.framesDecoded || 0),
      packetsLost: Number(inbound.packetsLost || 0),
      bytesReceived: Number(inbound.bytesReceived || 0),
      jitterBufferDelay: Number(inbound.jitterBufferDelay || 0),
      jitterBufferEmittedCount: Number(inbound.jitterBufferEmittedCount || 0),
      framesDropped: Number(inbound.framesDropped || 0),
      packetsReceived: Number(inbound.packetsReceived || 0),
      nackCount: Number(inbound.nackCount || 0),
      pliCount: Number(inbound.pliCount || 0),
      firCount: Number(inbound.firCount || 0),
      freezeCount: Number(inbound.freezeCount || 0),
    };
    const interval = previous
      ? deriveIntervalMediaStats(previous, current)
      : {
          elapsedMs: 0,
          derivedFps: 0,
          receivedDelta: 0,
          decodedDelta: 0,
          packetsLostDelta: 0,
          bytesDelta: 0,
          jitterBufferMs: current.jitterBufferEmittedCount > 0
            ? Math.round((current.jitterBufferDelay / current.jitterBufferEmittedCount * 1000) * 10) / 10
            : 0,
          framesDroppedDelta: 0,
          packetsReceivedDelta: 0,
          nackCountDelta: 0,
          pliCountDelta: 0,
          firCountDelta: 0,
          freezeDelta: 0,
        };
    const rttMs = Number.isFinite(Number(selected.pair?.currentRoundTripTime))
      ? Math.round(Number(selected.pair.currentRoundTripTime) * 1000)
      : 0;
    const localType = String(selected.local?.candidateType || selected.pair?.localCandidateType || '');
    return {
      ...interval,
      interval: true,
      warmup: !previous,
      sampledAt,
      browserReportedFps: Number(inbound.framesPerSecond || 0),
      rttMs,
      codec: String(codec?.mimeType || ''),
      selectedCandidateType: localType,
      selectedCandidatePair: {
        localType,
        remoteType: String(selected.remote?.candidateType || ''),
        protocol: String(selected.local?.protocol || selected.remote?.protocol || selected.pair?.protocol || ''),
        localAddress: address(selected.local),
        remoteAddress: address(selected.remote),
        localAddressFamily: addressFamily(selected.local?.address || selected.local?.ip),
        remoteAddressFamily: addressFamily(selected.remote?.address || selected.remote?.ip),
        rttMs,
      },
      totals: current,
    };
  }

  function createWebRtcStatsSampler(options = {}) {
    const getStats = options.getStats;
    const now = options.now || Date.now;
    const setTimer = options.setTimer || setInterval;
    const clearTimer = options.clearTimer || clearInterval;
    const intervalMs = Number(options.intervalMs || 1000);
    let timer = null;
    let inFlight = null;
    let previous = null;
    let latest = null;
    let generation = 0;

    function sampleNow() {
      if (inFlight) return inFlight;
      const sampleGeneration = generation;
      let statsPromise;
      try {
        statsPromise = getStats();
      } catch (error) {
        statsPromise = Promise.reject(error);
      }
      inFlight = Promise.resolve(statsPromise)
        .then((stats) => {
          if (sampleGeneration !== generation) return null;
          latest = normalizeStats(stats, previous, now());
          previous = latest.totals;
          options.onSample?.(latest);
          return latest;
        })
        .catch((error) => {
          options.onError?.(error);
          return null;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    }

    return {
      start() {
        if (timer == null) {
          void sampleNow();
          timer = setTimer(() => { void sampleNow(); }, intervalMs);
        }
        return this;
      },
      stop() {
        generation += 1;
        if (timer != null) clearTimer(timer);
        timer = null;
        previous = null;
        latest = null;
      },
      sampleNow,
      snapshot() {
        return latest;
      },
    };
  }

  return {
    createWebRtcStatsSampler,
    deriveIntervalMediaStats,
    normalizeStats,
    selectActiveCandidatePair,
  };
})();

if (typeof module !== 'undefined') {
  module.exports = { WebRtcStats };
}
