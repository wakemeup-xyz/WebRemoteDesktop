const COUNTER_NAMES = Object.freeze([
  'auth_success',
  'auth_rejected',
  'socket_connected',
  'socket_disconnected',
  'session_created',
  'session_attach',
  'session_detach',
  'session_closed',
  'pty_spawn_failed',
  'pty_startup_timeout',
  'pty_exited',
  'input_accepted',
  'input_rate_limited',
  'input_rejected',
  'output_bytes',
  'output_chunks',
  'output_backpressure',
]);

const LATENCY_NAMES = Object.freeze([
  'attach_ms',
  'pty_ready_ms',
  'server_input_process_ms',
]);
const TRANSPORT_NAMES = Object.freeze(['websocket', 'polling']);
const TRANSPORT_LATENCY_NAMES = Object.freeze(['socket_rtt_ms', 'input_ack_rtt_ms']);

const COUNTER_ALLOWLIST = new Set(COUNTER_NAMES);
const LATENCY_ALLOWLIST = new Set(LATENCY_NAMES);
const TRANSPORT_ALLOWLIST = new Set(TRANSPORT_NAMES);
const TRANSPORT_LATENCY_ALLOWLIST = new Set(TRANSPORT_LATENCY_NAMES);
const MAX_SAMPLES = 100;

function validNumber(value) {
  return Number.isFinite(value) && value >= 0;
}

function percentile(sorted, ratio) {
  if (sorted.length === 0) return null;
  const index = Math.max(0, Math.ceil(sorted.length * ratio) - 1);
  return sorted[index];
}

class TerminalMetrics {
  constructor() {
    this.counters = Object.fromEntries(COUNTER_NAMES.map((name) => [name, 0]));
    this.latencies = Object.fromEntries(LATENCY_NAMES.map((name) => [name, []]));
    this.transportLatencies = Object.fromEntries(
      TRANSPORT_NAMES.map((transport) => [
        transport,
        Object.fromEntries(TRANSPORT_LATENCY_NAMES.map((name) => [name, []])),
      ]),
    );
  }

  recordCounter(name, delta = 1) {
    if (!COUNTER_ALLOWLIST.has(name) || !validNumber(delta)) return false;
    const next = this.counters[name] + delta;
    if (!Number.isFinite(next)) return false;
    this.counters[name] = next;
    return true;
  }

  recordLatency(name, value) {
    if (!LATENCY_ALLOWLIST.has(name) || !validNumber(value)) return false;
    const samples = this.latencies[name];
    samples.push(value);
    if (samples.length > MAX_SAMPLES) samples.shift();
    return true;
  }

  recordTransportLatency(name, transport, value) {
    if (
      !TRANSPORT_LATENCY_ALLOWLIST.has(name)
      || !TRANSPORT_ALLOWLIST.has(transport)
      || !validNumber(value)
    ) return false;
    const samples = this.transportLatencies[transport][name];
    samples.push(value);
    if (samples.length > MAX_SAMPLES) samples.shift();
    return true;
  }

  snapshot() {
    const latencies = {};
    for (const name of LATENCY_NAMES) {
      const samples = this.latencies[name];
      const sorted = samples.slice().sort((left, right) => left - right);
      latencies[name] = {
        sampleCount: samples.length,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        last: samples.length ? samples[samples.length - 1] : null,
      };
    }
    const transports = {};
    for (const transport of TRANSPORT_NAMES) {
      const transportLatency = {};
      for (const name of TRANSPORT_LATENCY_NAMES) {
        const sorted = this.transportLatencies[transport][name]
          .slice()
          .sort((left, right) => left - right);
        const samples = this.transportLatencies[transport][name];
        transportLatency[name] = {
          sampleCount: samples.length,
          p50: percentile(sorted, 0.5),
          p95: percentile(sorted, 0.95),
          last: samples.length ? samples[samples.length - 1] : null,
        };
      }
      transports[transport] = { latencies: transportLatency };
    }
    return {
      counters: { ...this.counters },
      latencies,
      transports,
    };
  }
}

module.exports = {
  COUNTER_NAMES,
  LATENCY_NAMES,
  TRANSPORT_NAMES,
  TRANSPORT_LATENCY_NAMES,
  TerminalMetrics,
};
