const { toNodeIceServers, loadNodeDataChannel } = require('./terminal/webrtc-gateway');
const { getTurnStatus } = require('./config');

function createTurnSelfTestRunner(options = {}) {
  const loadNdc = options.loadNodeDataChannel || loadNodeDataChannel;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();

  async function runAllocate({
    urls = [],
    username = '',
    credential = '',
    timeoutMs = 10000,
    PeerConnectionImpl,
  } = {}) {
    const startedAt = now();
    const PC = PeerConnectionImpl || loadNdc()?.PeerConnection || null;
    if (!PC) {
      return {
        ok: false,
        code: 'node-datachannel-missing',
        relayCandidateCount: 0,
        reason: 'missing-runtime',
        durationMs: Math.max(0, now() - startedAt),
        urlsTried: [],
      };
    }
    if (!urls.length || !username || !credential) {
      return {
        ok: false,
        code: 'turn-not-configured',
        relayCandidateCount: 0,
        reason: 'missing-config',
        durationMs: Math.max(0, now() - startedAt),
        urlsTried: [],
      };
    }

    const iceServers = toNodeIceServers(urls, username, credential);
    const pc = new PC(`turn-selftest-${startedAt}`, {
      iceServers,
      iceTransportPolicy: 'relay',
    });
    let relayCandidateCount = 0;
    let reason = 'complete';

    try {
      const done = new Promise((resolve) => {
        const timer = setTimeout(() => {
          reason = 'timeout';
          resolve();
        }, Math.max(1000, Number(timeoutMs) || 10000));

        pc.onLocalCandidate?.((candidate) => {
          if (String(candidate || '').includes(' typ relay ')) {
            relayCandidateCount += 1;
          }
        });
        pc.onGatheringStateChange?.((state) => {
          if (state === 'complete') {
            clearTimeout(timer);
            resolve();
          }
        });
        pc.onStateChange?.((state) => {
          if (state === 'failed' || state === 'closed') {
            reason = state;
            clearTimeout(timer);
            resolve();
          }
        });
      });

      pc.createDataChannel?.('turn-selftest');
      // node-datachannel starts gathering after createDataChannel + local description callbacks.
      // Some builds only need createDataChannel; keep both patterns.
      if (typeof pc.setLocalDescription === 'function' && typeof pc.createOffer === 'function') {
        pc.setLocalDescription(pc.createOffer());
      }

      await done;
    } catch (error) {
      try { pc.close?.(); } catch (_err) { /* ignore */ }
      return {
        ok: false,
        code: 'turn-allocate-error',
        relayCandidateCount: 0,
        reason: error instanceof Error ? error.message : String(error),
        durationMs: Math.max(0, now() - startedAt),
        urlsTried: urls,
      };
    }

    try { pc.close?.(); } catch (_err) { /* ignore */ }

    return {
      ok: relayCandidateCount > 0,
      code: relayCandidateCount > 0 ? 'turn-allocate-ok' : 'turn-allocate-failed',
      relayCandidateCount,
      reason,
      durationMs: Math.max(0, now() - startedAt),
      urlsTried: urls,
    };
  }

  async function runFromConfig(config = {}, opts = {}) {
    const turnServerId = String(opts.turnServerId || '').trim();
    const turnState = getTurnStatus(config, { turnServerId });
    if (!turnState.turnConfigured) {
      return {
        ok: false,
        code: turnState.turnMisconfigured ? 'turn-config-partial' : 'turn-config-missing',
        turnConfigured: false,
        turnMisconfigured: Boolean(turnState.turnMisconfigured),
        turnSource: turnState.turnSource || config.turnSource || 'none',
        turnFingerprint: turnState.turnFingerprint || config.turnFingerprint || '',
        turnServerId: turnState.selectedTurnServerId || turnServerId || '',
        relayCandidateCount: 0,
        reason: turnState.turnStatus || 'missing',
        durationMs: 0,
        urlsTried: [],
      };
    }

    const allocate = await runAllocate({
      urls: turnState.turnUrls || config.turnUrls,
      username: turnState.turnUsername || config.turnUsername,
      credential: turnState.turnCredential || config.turnCredential,
      timeoutMs: opts.timeoutMs,
      PeerConnectionImpl: opts.PeerConnectionImpl,
    });

    return {
      ok: allocate.ok,
      code: allocate.code,
      turnConfigured: true,
      turnMisconfigured: false,
      turnSource: turnState.turnSource || config.turnSource || 'none',
      turnFingerprint: turnState.turnFingerprint || config.turnFingerprint || '',
      turnServerId: turnState.selectedTurnServerId || turnServerId || '',
      relayCandidateCount: allocate.relayCandidateCount,
      reason: allocate.reason,
      durationMs: allocate.durationMs,
      urlsTried: allocate.urlsTried,
      // Never echo credentials.
    };
  }

  return {
    runAllocate,
    runFromConfig,
  };
}

module.exports = {
  createTurnSelfTestRunner,
};
