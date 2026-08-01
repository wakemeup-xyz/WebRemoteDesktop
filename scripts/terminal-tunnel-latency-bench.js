#!/usr/bin/env node
/**
 * Read-only Terminal latency bench for evaluation plan gates.
 * Measures browser-equivalent single-clock RTT via Node client local clock.
 * Does not print tokens. Does not rebuild tunnels.
 */
const { io } = require('../signal-server/node_modules/socket.io/client-dist/socket.io.js');

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[idx];
}

function summarize(values) {
  const sorted = [...values].filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!sorted.length) {
    return { sampleCount: 0, min: null, p50: null, p95: null, max: null, mean: null };
  }
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return {
    sampleCount: sorted.length,
    min: sorted[0],
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1],
    mean: Math.round(mean * 1000) / 1000,
  };
}

function round(n) {
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runBench(options = {}) {
  const baseUrl = String(options.baseUrl || '').replace(/\/$/, '');
  const token = String(options.token || '');
  const samples = Math.max(5, Number(options.samples || 30));
  const label = String(options.label || baseUrl);
  if (!baseUrl || !token) {
    return Promise.reject(new Error('baseUrl and token required'));
  }

  return new Promise((resolve, reject) => {
    const socketRtts = [];
    const inputAcks = [];
    const serverProcesses = [];
    const firstOutputs = [];
    const markerOutputs = [];
    let sessionId = null;
    let settled = false;
    let outputBuf = '';
    let pingInFlight = null;
    let inputInFlight = null;
    let sampleIndex = 0;
    let phase = 'create'; // create | warm | measure | done

    const socket = io(`${baseUrl}/terminal`, {
      auth: { token, role: 'admin', clientId: `latency-bench-${Date.now()}` },
      transports: ['websocket'],
      reconnection: false,
      timeout: 10000,
    });

    function finish(error) {
      if (settled) return;
      settled = true;
      if (sessionId) {
        try {
          socket.emit('terminal:close_session', { sessionId, reason: 'bench-close' });
        } catch (_err) {
          /* ignore */
        }
      }
      try {
        socket.close();
      } catch (_err) {
        /* ignore */
      }
      if (error) {
        reject(error);
        return;
      }
      const socketSummary = summarize(socketRtts);
      const ackSummary = summarize(inputAcks);
      const serverSummary = summarize(serverProcesses);
      const firstSummary = summarize(firstOutputs);
      const markerSummary = summarize(markerOutputs);
      resolve({
        label,
        baseUrl,
        transport: 'websocket',
        samplesRequested: samples,
        socketRttMs: socketSummary,
        inputAckRttMs: ackSummary,
        serverProcessMs: serverSummary,
        firstOutputRttMs: firstSummary,
        markerOutputRttMs: markerSummary,
        appOverheadAckMs: round(
          Number.isFinite(ackSummary.p50) && Number.isFinite(socketSummary.p50)
            ? ackSummary.p50 - socketSummary.p50
            : null,
        ),
        appOverheadFirstOutMs: round(
          Number.isFinite(firstSummary.p50) && Number.isFinite(socketSummary.p50)
            ? firstSummary.p50 - socketSummary.p50
            : null,
        ),
      });
    }

    const watchdog = setTimeout(
      () => finish(new Error(`latency bench timed out after ${sampleIndex}/${samples} samples`)),
      Math.max(120000, samples * 8000),
    );
    watchdog.unref?.();
    let readyForMeasure = false;

    function nextMeasure() {
      if (settled || !readyForMeasure) return;
      if (sampleIndex >= samples) {
        phase = 'done';
        clearTimeout(watchdog);
        finish(null);
        return;
      }
      const nonce = `p${sampleIndex}-${Date.now()}`;
      pingInFlight = { nonce, sentAt: Date.now() };
      socket.emit('terminal:ping', { nonce, clientSentAt: pingInFlight.sentAt });
    }

    function sendMarker() {
      if (!sessionId || settled) return;
      const marker = `__WRD_BENCH_${sampleIndex}_${Date.now()}__`;
      const inputId = `bench-${sampleIndex}-${Date.now()}`;
      outputBuf = '';
      inputInFlight = {
        inputId,
        marker,
        sentAt: Date.now(),
        firstOutputAt: null,
        markerAt: null,
      };
      // Use echo to keep the command short; marker still unique.
      const data = `echo ${marker}${String.fromCharCode(10)}`;
      socket.emit('terminal:input', {
        sessionId,
        inputId,
        data,
      });
    }

    function startMeasuring() {
      if (readyForMeasure || settled || !sessionId) return;
      readyForMeasure = true;
      phase = 'measure';
      setTimeout(() => nextMeasure(), 200).unref?.();
    }

    socket.on('connect', () => {
      socket.emit('terminal:create_session', {
        cols: 120,
        rows: 32,
        title: `latency-bench-${label}`.slice(0, 40),
        requestId: `bench-${Date.now()}`,
      });
    });
    socket.on('connect_error', (error) => finish(new Error(`connect failed: ${error.message}`)));

    function handleCreated(payload = {}) {
      if (sessionId || !payload.sessionId) return;
      sessionId = payload.sessionId;
      if (payload.processStatus === 'running') {
        startMeasuring();
        return;
      }
      // Fallback: start after prompt-ish delay even if running event is missed.
      setTimeout(() => startMeasuring(), 1500).unref?.();
    }
    socket.on('terminal:session_created', handleCreated);
    socket.on('terminal:created', handleCreated);

    socket.on('terminal:pong', (payload = {}) => {
      if (!pingInFlight || payload.nonce !== pingInFlight.nonce) return;
      const rtt = Date.now() - pingInFlight.sentAt;
      socketRtts.push(rtt);
      pingInFlight = null;
      sendMarker();
    });

    socket.on('terminal:input_ack', (payload = {}) => {
      if (!inputInFlight || payload.inputId !== inputInFlight.inputId) return;
      const rtt = Date.now() - inputInFlight.sentAt;
      inputAcks.push(rtt);
      const serverReceivedAt = Number(payload.serverReceivedAt);
      const serverSentAt = Number(payload.serverSentAt);
      if (Number.isFinite(serverReceivedAt) && Number.isFinite(serverSentAt)) {
        serverProcesses.push(Math.max(0, serverSentAt - serverReceivedAt));
      }
    });

    socket.on('terminal:output', (payload = {}, acknowledge) => {
      if (typeof acknowledge === 'function') {
        try {
          acknowledge();
        } catch (_err) {
          /* ignore */
        }
      }
      if (!inputInFlight || payload.sessionId !== sessionId) return;
      outputBuf += String(payload.data || '');
      if (!inputInFlight.firstOutputAt && outputBuf.length > 0) {
        inputInFlight.firstOutputAt = Date.now();
        firstOutputs.push(inputInFlight.firstOutputAt - inputInFlight.sentAt);
      }
      if (!inputInFlight.markerAt && outputBuf.includes(inputInFlight.marker)) {
        inputInFlight.markerAt = Date.now();
        markerOutputs.push(inputInFlight.markerAt - inputInFlight.sentAt);
        inputInFlight = null;
        sampleIndex += 1;
        setTimeout(() => nextMeasure(), 50).unref?.();
      }
    });

    socket.on('terminal:error', (payload = {}) => {
      if (phase === 'done' || settled) return;
      // non-fatal rate limits should not abort entire bench unless stuck
      if (payload.code === 'terminal_input_rate_limited') return;
      if (payload.sessionId && sessionId && payload.sessionId !== sessionId) return;
      if (['pty_exited', 'terminal_session_not_found'].includes(payload.code)) {
        finish(new Error(`terminal error: ${payload.code}`));
      }
    });

    socket.on('terminal:exit', (payload = {}) => {
      if (payload.sessionId === sessionId) {
        finish(new Error('session exited during bench'));
      }
    });
  });
}

function classifyNetworkTier(socketP50) {
  if (!Number.isFinite(socketP50)) return 'unknown';
  if (socketP50 <= 120) return 'A';
  if (socketP50 <= 250) return 'B';
  if (socketP50 <= 400) return 'C';
  return 'D';
}

function evaluateGates(result, layer) {
  const fails = [];
  const sp = result.serverProcessMs || {};
  const sr = result.socketRttMs || {};
  const ia = result.inputAckRttMs || {};
  const fo = result.firstOutputRttMs || {};

  if (layer === 'L0') {
    if (!(sr.p50 <= 25)) fails.push(`L0 socketRtt P50 ${sr.p50} > 25`);
    if (!(sr.p95 <= 60)) fails.push(`L0 socketRtt P95 ${sr.p95} > 60`);
    if (!(ia.p50 <= 40)) fails.push(`L0 inputAck P50 ${ia.p50} > 40`);
    if (!(ia.p95 <= 80)) fails.push(`L0 inputAck P95 ${ia.p95} > 80`);
    if (!(fo.p50 <= 50)) fails.push(`L0 firstOutput P50 ${fo.p50} > 50`);
    if (!(fo.p95 <= 100)) fails.push(`L0 firstOutput P95 ${fo.p95} > 100`);
    if (!(sp.p50 <= 10)) fails.push(`L0 serverProcess P50 ${sp.p50} > 10`);
    if (!(sp.p95 <= 30)) fails.push(`L0 serverProcess P95 ${sp.p95} > 30`);
  }

  if (layer === 'L1' || layer === 'L0') {
    // app overhead hard gates for tunnel; also useful locally
    if (!(sp.p50 <= 15)) fails.push(`serverProcess P50 ${sp.p50} > 15`);
    if (!(sp.p95 <= 40)) fails.push(`serverProcess P95 ${sp.p95} > 40`);
    if (!(result.appOverheadAckMs <= 40)) {
      fails.push(`appOverheadAckMs ${result.appOverheadAckMs} > 40`);
    }
    if (!(result.appOverheadFirstOutMs <= 80)) {
      fails.push(`appOverheadFirstOutMs ${result.appOverheadFirstOutMs} > 80`);
    }
    // Ratio gate only applies when absolute latency is meaningful; sub-20ms
    // local jitter must not fail a 3ms/1ms ratio.
    if (Number.isFinite(ia.p50) && ia.p50 >= 20 && Number.isFinite(ia.p95)) {
      const ratio = ia.p95 / ia.p50;
      if (ratio > 2.0) fails.push(`inputAck P95/P50 ${round(ratio)} > 2.0`);
    }
  }

  if (layer === 'L1') {
    const tier = classifyNetworkTier(sr.p50);
    result.networkTier = tier;
    if (tier === 'D') fails.push(`network tier D (socketRtt P50 ${sr.p50} > 400)`);
  }

  return { ok: fails.length === 0, fails, networkTier: result.networkTier || classifyNetworkTier(sr.p50) };
}

if (require.main === module) {
  const [baseUrl, token, samplesArg, label, layer] = process.argv.slice(2);
  runBench({
    baseUrl,
    token,
    samples: Number(samplesArg || 30),
    label: label || baseUrl,
  })
    .then((result) => {
      const gates = evaluateGates(result, layer || 'L1');
      const out = { ...result, gates };
      process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
      if (!gates.ok) process.exitCode = 2;
    })
    .catch((error) => {
      process.stderr.write(`terminal-tunnel-latency-bench: ${error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = { runBench, evaluateGates, classifyNetworkTier, summarize };
