'use strict';

const { performance } = require('node:perf_hooks');

const DISCONNECT_REASONS = new Set([
  'ping timeout', 'transport close', 'transport error', 'server namespace disconnect',
  'client namespace disconnect', 'server shutting down', 'parse error',
  'forced close', 'forced server close',
]);

function normalizeDisconnectReason(reason) {
  return typeof reason === 'string' && DISCONNECT_REASONS.has(reason) ? reason : 'other';
}

function createRuntimeObserver(options = {}) {
  const now = options.now || (() => performance.now());
  const sampleRss = options.sampleRss || (() => process.memoryUsage.rss() / (1024 * 1024));
  const samplePeakRss = options.samplePeakRss || (() => null);
  const sampleCpuSeconds = options.sampleCpuSeconds || (() => {
    const usage = process.resourceUsage();
    return (usage.userCPUTime + usage.systemCPUTime) / 1e6;
  });
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const samples = [];
  let running = false;
  let timer = null;
  let deadline = null;
  let sampledAt = null;
  let currentRssMiB = null;
  let peakRssMiB = null;
  let processCpuSeconds = null;
  let processCpuPercent = null;
  let previousCpuSeconds = null;
  let previousCpuAt = null;
  let status = 'unavailable';

  function expire(at) {
    while (samples.length && samples[0].at <= at - 60000) samples.shift();
  }
  function validRss(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  }
  function schedule() {
    timer = setTimer(tick, Math.max(0, deadline - now()));
    timer?.unref?.();
  }
  function tick() {
    if (!running) return;
    const observed = now();
    const lag = Math.max(0, observed - deadline);
    const missed = Math.floor(lag / 1000);
    expire(observed);
    samples.push({ at: observed, lag, missed });
    if (samples.length > 120) samples.shift();
    deadline += (missed + 1) * 1000;
    // Native RSS reads are cheap, cached, and independent of diagnostics calls.
    if (sampledAt === null || observed - sampledAt >= 5000) {
      try {
        currentRssMiB = validRss(sampleRss());
        peakRssMiB = validRss(samplePeakRss());
        const cpu = validRss(sampleCpuSeconds());
        if (cpu !== null && previousCpuSeconds !== null && previousCpuAt !== null && observed > previousCpuAt) {
          processCpuPercent = Math.max(0, Math.min(10000,
            ((cpu - previousCpuSeconds) / ((observed - previousCpuAt) / 1000)) * 100));
        } else {
          processCpuPercent = null;
        }
        if (cpu !== null) {
          processCpuSeconds = cpu;
          previousCpuSeconds = cpu;
          previousCpuAt = observed;
        }
        status = currentRssMiB === null ? 'unavailable' : 'ok';
      } catch {
        currentRssMiB = null;
        peakRssMiB = null;
        processCpuSeconds = null;
        processCpuPercent = null;
        status = 'unavailable';
      }
      sampledAt = observed;
    }
    if (running) schedule();
  }

  return {
    start() {
      if (running) return;
      running = true;
      deadline = now() + 1000;
      schedule();
    },
    stop() {
      running = false;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
    snapshot() {
      const at = now();
      expire(at);
      const values = samples.map((sample) => sample.lag).sort((a, b) => a - b);
      const percentile = (fraction) => values.length
        ? values[Math.max(0, Math.ceil(values.length * fraction) - 1)] : null;
      const ageMs = sampledAt === null ? null : Math.max(0, at - sampledAt);
      const fresh = ageMs !== null && ageMs <= 10000;
      return {
        available: fresh && currentRssMiB !== null,
        status,
        ageMs,
        currentRssMiB: fresh ? currentRssMiB : null,
        peakRssMiB: fresh ? peakRssMiB : null,
        processCpuSeconds: fresh ? processCpuSeconds : null,
        processCpuPercent: fresh ? processCpuPercent : null,
        memoryPressure: 'unknown',
        eventLoop: {
          count: samples.length,
          last: samples.length ? samples[samples.length - 1].lag : null,
          max: values.length ? values[values.length - 1] : null,
          p50: percentile(.5), p95: percentile(.95), p99: percentile(.99),
          missedSampleCount: samples.reduce((total, sample) => total + sample.missed, 0),
        },
      };
    },
  };
}

function bindRuntimeObserver(server, observer) {
  server.on('listening', () => observer.start());
  server.on('close', () => observer.stop());
  server.on('error', () => observer.stop());
}

module.exports = { createRuntimeObserver, normalizeDisconnectReason, bindRuntimeObserver };
