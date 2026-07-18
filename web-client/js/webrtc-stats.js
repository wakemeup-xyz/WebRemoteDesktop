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
    const framesReceived = nonNegativeDelta(previous?.framesReceived, current?.framesReceived);
    const framesDecoded = nonNegativeDelta(previous?.framesDecoded, current?.framesDecoded);
    const packetsLost = nonNegativeDelta(previous?.packetsLost, current?.packetsLost);
    const bytesReceived = nonNegativeDelta(previous?.bytesReceived, current?.bytesReceived);
    const jitterDelay = nonNegativeDelta(previous?.jitterBufferDelay, current?.jitterBufferDelay);
    const jitterCount = nonNegativeDelta(
      previous?.jitterBufferEmittedCount,
      current?.jitterBufferEmittedCount,
    );
    return {
      elapsedMs,
      fps: elapsedMs > 0 ? Math.round((framesDecoded * 1000 / elapsedMs) * 10) / 10 : 0,
      framesReceived,
      framesDecoded,
      packetsLost,
      bytesReceived,
      jitterBufferMs: jitterCount > 0 ? Math.round((jitterDelay / jitterCount * 1000) * 10) / 10 : 0,
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
    };
    const interval = previous
      ? deriveIntervalMediaStats(previous, current)
      : {
          elapsedMs: 0,
          fps: Number(inbound.framesPerSecond || 0),
          framesReceived: 0,
          framesDecoded: 0,
          packetsLost: 0,
          bytesReceived: 0,
          jitterBufferMs: current.jitterBufferEmittedCount > 0
            ? Math.round((current.jitterBufferDelay / current.jitterBufferEmittedCount * 1000) * 10) / 10
            : 0,
        };
    const rttMs = Number.isFinite(Number(selected.pair?.currentRoundTripTime))
      ? Math.round(Number(selected.pair.currentRoundTripTime) * 1000)
      : 0;
    const localType = String(selected.local?.candidateType || selected.pair?.localCandidateType || '');
    return {
      ...interval,
      interval: true,
      sampledAt,
      fps: Number(inbound.framesPerSecond || interval.fps || 0),
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
