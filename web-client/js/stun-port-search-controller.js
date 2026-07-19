(function registerStunPortSearchController(globalObject) {
  const TERMINAL_STATUSES = new Set(['succeeded', 'stopped', 'exhausted']);
  const VALID_SIDES = new Set(['viewer', 'host']);

  function isValidPort(port) {
    return Number.isInteger(port) && port >= 1 && port <= 65535;
  }

  function isStableMediaSample(stats) {
    if (!stats || typeof stats !== 'object') {
      return false;
    }
    const candidateType = stats.selectedCandidateType;
    const framesDecoded = Number(stats.framesDecoded);
    const fps = Number(stats.fps);
    return Boolean(candidateType)
      && Number.isFinite(framesDecoded)
      && framesDecoded > 0
      && Number.isFinite(fps)
      && fps > 0;
  }

  const StunPortSearchController = {
    create(options = {}) {
      const limit = Number.isInteger(options.limit) && options.limit > 0
        ? options.limit
        : 500;

      let status = 'idle';
      let attempt = 0;
      let lastReason = '';
      let stableMediaSamples = 0;
      let currentViewerPorts = [];
      let currentHostPorts = [];
      const uniquePorts = new Set();

      function isTerminal() {
        return TERMINAL_STATUSES.has(status);
      }

      function snapshot() {
        return {
          active: status === 'searching',
          status,
          attempt,
          limit,
          lastReason,
          stableMediaSamples,
          uniquePortCount: uniquePorts.size,
          uniquePorts: Array.from(uniquePorts),
          current: {
            viewerPorts: currentViewerPorts.slice(),
            hostPorts: currentHostPorts.slice(),
          },
          viewerPorts: currentViewerPorts.slice(),
          hostPorts: currentHostPorts.slice(),
        };
      }

      function start() {
        // Explicit reset entry point for a new search session.
        status = 'searching';
        attempt = 0;
        lastReason = '';
        stableMediaSamples = 0;
        currentViewerPorts = [];
        currentHostPorts = [];
        uniquePorts.clear();
        return snapshot();
      }

      function beginAttempt(reason) {
        if (isTerminal()) {
          return { attempt, accepted: false, status, ...snapshot() };
        }
        if (status !== 'searching') {
          return { attempt, accepted: false, status, ...snapshot() };
        }
        if (attempt >= limit) {
          status = 'exhausted';
          lastReason = reason || lastReason;
          return { attempt, accepted: false, status, ...snapshot() };
        }
        attempt += 1;
        lastReason = reason || '';
        stableMediaSamples = 0;
        currentViewerPorts = [];
        currentHostPorts = [];
        return { attempt, accepted: true, status, ...snapshot() };
      }

      function recordPort(side, port) {
        if (isTerminal() || status !== 'searching') {
          return false;
        }
        if (!VALID_SIDES.has(side) || !isValidPort(port)) {
          return false;
        }
        const currentList = side === 'viewer' ? currentViewerPorts : currentHostPorts;
        if (currentList.includes(port)) {
          return false;
        }
        currentList.push(port);
        uniquePorts.add(port);
        return true;
      }

      function observeMedia(stats) {
        if (isTerminal()) {
          return snapshot();
        }
        if (status !== 'searching') {
          return snapshot();
        }
        if (!isStableMediaSample(stats)) {
          stableMediaSamples = 0;
          return snapshot();
        }
        stableMediaSamples += 1;
        if (stableMediaSamples >= 3) {
          status = 'succeeded';
          lastReason = 'stable-media';
        }
        return snapshot();
      }

      function failAttempt(reason) {
        if (isTerminal() || status !== 'searching') {
          return { accepted: false, status, ...snapshot() };
        }
        lastReason = reason || lastReason;
        stableMediaSamples = 0;
        if (attempt >= limit) {
          status = 'exhausted';
          return { accepted: false, status, ...snapshot() };
        }
        return { accepted: true, status, ...snapshot() };
      }

      function stop(reason) {
        if (isTerminal()) {
          return snapshot();
        }
        status = 'stopped';
        lastReason = reason || lastReason;
        return snapshot();
      }

      return {
        start,
        beginAttempt,
        recordPort,
        observeMedia,
        failAttempt,
        stop,
        snapshot,
      };
    },
  };

  const api = { StunPortSearchController };
  globalObject.StunPortSearchController = StunPortSearchController;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
