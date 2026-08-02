(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TurnSelfTest = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function isTurnServer(server) {
    if (!server) return false;
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return urls.some((url) => /^turns?:/i.test(String(url || '')));
  }

  function extractTurnServers(iceServers) {
    return (Array.isArray(iceServers) ? iceServers : []).filter(isTurnServer);
  }

  function shortFingerprint(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    return text.length <= 12 ? text : text.slice(0, 12);
  }

  function classifyConfig({ turnConfigured, turnMisconfigured, turnServers }) {
    if (turnMisconfigured) {
      return { code: 'turn-config-partial', ok: false, detail: 'TURN URLs present but username/credential incomplete' };
    }
    if (!turnConfigured && (!turnServers || turnServers.length === 0)) {
      return { code: 'turn-config-missing', ok: false, detail: 'TURN is not configured' };
    }
    if (turnConfigured || (turnServers && turnServers.length > 0)) {
      return { code: 'turn-config-ok', ok: true, detail: 'TURN config present' };
    }
    return { code: 'turn-config-missing', ok: false, detail: 'TURN is not configured' };
  }

  function classifyFingerprint({ viewerFingerprint, hostFingerprint, hostTurnReady }) {
    if (!viewerFingerprint) {
      return { code: 'turn-fingerprint-missing', ok: false, detail: 'Viewer fingerprint unavailable' };
    }
    if (hostTurnReady === false) {
      return {
        code: 'turn-host-not-ready',
        ok: false,
        detail: 'Host has not reported turnReady',
      };
    }
    if (!hostFingerprint) {
      return {
        code: 'turn-host-fingerprint-missing',
        ok: false,
        detail: 'Host fingerprint unavailable (Host may be offline or pre-upgrade)',
      };
    }
    if (viewerFingerprint !== hostFingerprint) {
      return {
        code: 'turn-fingerprint-mismatch',
        ok: false,
        detail: `Viewer ${shortFingerprint(viewerFingerprint)} != Host ${shortFingerprint(hostFingerprint)}`,
      };
    }
    return {
      code: 'turn-fingerprint-ok',
      ok: true,
      detail: `matched ${shortFingerprint(viewerFingerprint)}`,
    };
  }

  function classifyAllocate({ relayCandidateCount, timedOut, error }) {
    if (error) {
      return { code: 'turn-allocate-error', ok: false, detail: String(error.message || error) };
    }
    if (Number(relayCandidateCount) > 0) {
      return {
        code: 'turn-allocate-ok',
        ok: true,
        detail: `relay candidates=${relayCandidateCount}${timedOut ? ' (gather timed out after candidates)' : ''}`,
      };
    }
    return {
      code: 'turn-allocate-failed',
      ok: false,
      detail: timedOut ? 'ICE gathering timed out with no relay candidate' : 'No relay candidate gathered',
    };
  }

  function summarize(steps) {
    const list = Array.isArray(steps) ? steps : [];
    const failed = list.find((step) => step && step.ok === false);
    return {
      ok: !failed && list.length > 0,
      failedCode: failed ? failed.code : null,
      steps: list,
      message: failed
        ? `FAIL ${failed.code}: ${failed.detail || ''}`
        : (list.length ? 'PASS all TURN self-test steps' : 'No steps run'),
    };
  }

  function candidateTypeFromSdp(candidate) {
    const text = String(candidate?.candidate || candidate || '');
    const match = text.match(/\styp\s+(\w+)/i);
    return match ? match[1].toLowerCase() : '';
  }

  async function gatherRelayCandidates({
    iceServers,
    timeoutMs = 8000,
    RTCPeerConnectionImpl,
  } = {}) {
    const PC = RTCPeerConnectionImpl
      || (typeof RTCPeerConnection !== 'undefined' ? RTCPeerConnection : null);
    if (!PC) {
      return { relayCandidateCount: 0, candidates: [], timedOut: false, error: new Error('RTCPeerConnection unavailable') };
    }

    const turnServers = extractTurnServers(iceServers);
    if (!turnServers.length) {
      return { relayCandidateCount: 0, candidates: [], timedOut: false, error: new Error('No TURN iceServers') };
    }

    const pc = new PC({
      iceServers: turnServers,
      iceTransportPolicy: 'relay',
    });
    const candidates = [];
    let timedOut = false;

    try {
      pc.createDataChannel('turn-selftest');

      const gatherPromise = new Promise((resolve) => {
        const timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, timeoutMs);

        const finish = () => {
          clearTimeout(timer);
          resolve();
        };

        pc.addEventListener('icecandidate', (event) => {
          if (!event.candidate) {
            finish();
            return;
          }
          candidates.push(event.candidate);
        });
        pc.addEventListener('icegatheringstatechange', () => {
          if (pc.iceGatheringState === 'complete') finish();
        });
        if (pc.iceGatheringState === 'complete') finish();
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await gatherPromise;
    } catch (error) {
      try { pc.close(); } catch (_err) { /* ignore */ }
      return { relayCandidateCount: 0, candidates: [], timedOut: false, error };
    }

    try { pc.close(); } catch (_err) { /* ignore */ }

    const relayCandidateCount = candidates.filter((item) => candidateTypeFromSdp(item) === 'relay').length;
    return { relayCandidateCount, candidates, timedOut, error: null };
  }

  async function runServerProbe(options = {}) {
    const {
      apiBase = '',
      token = '',
      timeoutMs = 10000,
      turnServerId = '',
      fetchImpl = (typeof fetch !== 'undefined' ? fetch : null),
    } = options;
    if (!fetchImpl) {
      return {
        ok: false,
        code: 'turn-server-probe-unavailable',
        detail: 'fetch unavailable',
      };
    }
    try {
      const payload = { timeoutMs };
      const selectedId = String(turnServerId || '').trim();
      if (selectedId) payload.turnServerId = selectedId;
      const response = await fetchImpl(`${apiBase}/api/turn-selftest`, {
        method: 'POST',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok && !body?.code) {
        return {
          ok: false,
          code: 'turn-server-probe-http',
          detail: `HTTP ${response.status}`,
          body,
        };
      }
      return {
        ok: Boolean(body.ok),
        code: body.code || (body.ok ? 'turn-allocate-ok' : 'turn-allocate-failed'),
        detail: [
          body.reason || '',
          body.relayCandidateCount != null ? `relay=${body.relayCandidateCount}` : '',
          body.durationMs != null ? `${body.durationMs}ms` : '',
          body.fingerprintMatch === true ? 'fp-match' : (body.fingerprintMatch === false ? 'fp-mismatch' : ''),
        ].filter(Boolean).join(' · '),
        body,
      };
    } catch (error) {
      return {
        ok: false,
        code: 'turn-server-probe-error',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function run(options = {}) {
    const {
      iceServers = [],
      turnConfigured = false,
      turnMisconfigured = false,
      turnFingerprint = '',
      hostTurnReady = null,
      hostTurnFingerprint = '',
      timeoutMs = 8000,
      RTCPeerConnectionImpl,
      skipAllocate = false,
      includeServerProbe = false,
      serverProbe = null,
    } = options;

    const turnServers = extractTurnServers(iceServers);
    const steps = [];

    const configStep = classifyConfig({ turnConfigured, turnMisconfigured, turnServers });
    steps.push({ step: 'config', ...configStep });

    if (!configStep.ok) {
      return summarize(steps);
    }

    const fingerprintStep = classifyFingerprint({
      viewerFingerprint: turnFingerprint,
      hostFingerprint: hostTurnFingerprint,
      hostTurnReady,
    });
    steps.push({ step: 'fingerprint', ...fingerprintStep });

    // Always attempt browser Allocate when config is present; fingerprint mismatch
    // is reported but should not hide connectivity evidence.
    if (!skipAllocate) {
      const allocateRaw = await gatherRelayCandidates({
        iceServers: turnServers,
        timeoutMs,
        RTCPeerConnectionImpl,
      });
      const allocateStep = classifyAllocate(allocateRaw);
      steps.push({
        step: 'allocate',
        ...allocateStep,
        relayCandidateCount: allocateRaw.relayCandidateCount,
        timedOut: allocateRaw.timedOut,
      });
    }

    if (includeServerProbe) {
      const probe = typeof serverProbe === 'function'
        ? await serverProbe()
        : await runServerProbe(options.serverProbeOptions || {});
      steps.push({
        step: 'server',
        ok: Boolean(probe?.ok),
        code: probe?.code || 'turn-server-probe-unknown',
        detail: probe?.detail || '',
        relayCandidateCount: probe?.body?.relayCandidateCount,
      });
    }

    return summarize(steps);
  }

  return {
    classifyAllocate,
    classifyConfig,
    classifyFingerprint,
    extractTurnServers,
    gatherRelayCandidates,
    run,
    runServerProbe,
    shortFingerprint,
    summarize,
  };
}));
