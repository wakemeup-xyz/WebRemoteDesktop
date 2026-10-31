'use strict';

// A bounded, read-only aggregation of runtime evidence.  This module never
// reads process state or starts timers; callers feed it already-sanitized
// diagnostic snapshots.  Missing stages remain null so ACK/decoder counters
// are never presented as visible-effect evidence.

const MAX_COUNT = 999999999;
const MAX_SAMPLES = 256;
const MAX_MISSING = 32;
const LOG_RECEIPT_STATES = ['empty', 'received', 'unknown', 'truncated', 'failed'];
const TRACE_LOSS_FIELDS = ['droppedEvents', 'droppedHashCount', 'evictedPendingAcks', 'expiredPendingAcks', 'ackTimeoutCount'];
const CORRELATION_STAGES = ['ack', 'hostApply', 'capture', 'encode', 'rtp', 'decode', 'present'];

function boundedCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(MAX_COUNT, value) : null;
}

function boundedNumber(value, maximum = MAX_COUNT) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(maximum, value) : null;
}

function sampleStats(samples) {
  const observed = samples.filter(value => boundedNumber(value) !== null).map(Number);
  if (!observed.length) return { available: false, count: 0, last: null, p50: null, p95: null, max: null };
  const values = observed.slice().sort((a, b) => a - b);
  const pick = fraction => values[Math.min(values.length - 1, Math.floor(values.length * fraction))];
  return { available: true, count: values.length, last: observed.at(-1), p50: pick(.5), p95: pick(.95), max: values.at(-1) };
}

function metricCount(metrics, name) {
  return boundedCount(metrics?.[name]?.count);
}

function collectMetricValues(metrics, name) {
  const value = metrics?.[name];
  if (!value || typeof value !== 'object') return [];
  return [value.last, value.p50, value.p95].filter(item => boundedNumber(item) !== null);
}

function firstCount(...values) {
  for (const value of values) {
    const result = boundedCount(value);
    if (result !== null) return result;
  }
  return null;
}

function ratio(numerator, denominator) {
  if (numerator === null || denominator === null || denominator <= 0) return null;
  return Math.max(0, Math.min(1, numerator / denominator));
}

function recordMissing(missing, name) {
  if (!missing.includes(name) && missing.length < MAX_MISSING) missing.push(name);
}

function projectLogReceipt(report, metadataOnly) {
  const raw = report.logReceipt && typeof report.logReceipt === 'object' ? report.logReceipt : {};
  const reported = firstCount(raw.reported, report.reportedLogCount,
    Array.isArray(report.logs) ? report.logs.length : null);
  const retained = firstCount(raw.retained, report.retainedLogCount,
    Array.isArray(report.logs) ? report.logs.length : null);
  const redacted = firstCount(raw.redacted, report.redactedLogCount);
  const dropped = firstCount(raw.dropped, report.truncation?.dropped);
  let state = LOG_RECEIPT_STATES.includes(raw.state) ? raw.state : null;
  if (!state) {
    if (reported === null) state = 'unknown';
    else if (dropped !== null && dropped > 0) state = 'truncated';
    else if (reported === 0) state = 'empty';
    else state = metadataOnly ? 'received' : 'received';
  }
  return { state, reported, retained, redacted, dropped };
}

function projectInputTraceLoss(report) {
  const counters = report.inputTraceLoss && typeof report.inputTraceLoss === 'object'
    ? report.inputTraceLoss : (report.inputTrace?.counters || {});
  return Object.fromEntries(TRACE_LOSS_FIELDS.map(key => [key, boundedCount(counters[key])]));
}

function projectCorrelation(report, metrics, outcomes) {
  const available = name => metricCount(metrics, name) > 0;
  const correlation = {
    scopeAvailable: Boolean(report.latency?.scope && typeof report.latency.scope === 'object'),
    stages: {
      ack: available('inputAckRttMs') || boundedCount(outcomes.acked) > 0,
      hostApply: available('hostApplyMs') || available('hostAdapterAwaitMs'),
      capture: available('capturePrepareMs') || available('captureGrabMs'),
      encode: available('encoderMs') || available('encodeTotalMs'),
      rtp: available('rtpApiAwaitMs') || available('relayFrameAckRttMs'),
      decode: available('inputToFrameNoticeMs') || available('inputToPostApplyFrameMs'),
      present: available('inputToVisibleEffectMs'),
    },
  };
  correlation.complete = correlation.scopeAvailable
    && CORRELATION_STAGES.every(stage => correlation.stages[stage]);
  return correlation;
}

function projectDiagnostic(report = {}) {
  const latency = report.latency && typeof report.latency === 'object' ? report.latency : {};
  const metrics = latency.metrics && typeof latency.metrics === 'object' ? latency.metrics : {};
  const outcomes = latency.outcomes && typeof latency.outcomes === 'object' ? latency.outcomes : {};
  const logs = Array.isArray(report.logs) ? report.logs.length : null;
  const metadataOnly = report.schemaVersion === 3 || report.logContentPolicy === 'metadata-only';
  // Schema 3 has always discarded console content. Its historical logCount=0
  // only describes retention, and cannot prove an empty client log buffer.
  const logCount = metadataOnly ? boundedCount(report.reportedLogCount) : firstCount(report.logCount, logs);
  const retainedLogCount = metadataOnly ? firstCount(report.retainedLogCount, logs, report.logCount) : logCount;
  const redactedLogCount = metadataOnly ? boundedCount(report.redactedLogCount) : null;
  const inputTraceEventCount = firstCount(Array.isArray(report.inputTrace?.events) ? report.inputTrace.events.length : null,
    report.inputTraceEventCount);
  const summaryGapCount = firstCount(
    report.summaryGapCount,
    report.summaryGaps?.count,
    report.coverage?.summaryGapCount,
  );
  const ringDropCount = firstCount(
    report.ringDropped,
    report.heartbeat?.ringDropped,
    report.runtime?.heartbeat?.ringDropped,
  );
  const logReceipt = projectLogReceipt(report, metadataOnly);
  const inputTraceLoss = projectInputTraceLoss(report);
  const sent = firstCount(outcomes.sent, report.inputTrace?.counters?.sent);
  const visible = metricCount(metrics, 'inputToVisibleEffectMs');
  const visibleCoverage = ratio(visible, sent);
  const fps = [];
  const dropped = [];
  const droppedIntervalDelta = [];
  const summary = report.traceSummary;
  const interval = summary?.mediaInterval;
  const elapsedMs = boundedNumber(interval?.elapsedMs, 60000);
  const sampleAgeMs = boundedNumber(interval?.sampleAgeMs, 5000);
  if (metadataOnly && interval?.schemaVersion === 1 && interval.kind === 'webrtc-inbound-interval'
      && elapsedMs !== null && elapsedMs > 0 && interval.elapsedMs <= 60000
      && sampleAgeMs !== null && interval.sampleAgeMs <= 5000) {
    const value = boundedNumber(summary.derivedFps, 240);
    if (interval.fpsObserved === true && value !== null) fps.push(value);
    const delta = boundedCount(summary.framesDroppedDelta);
    if (interval.droppedFramesObserved === true && delta !== null) droppedIntervalDelta.push(delta);
  }
  for (const item of !metadataOnly && Array.isArray(report.events) ? report.events.slice(-MAX_SAMPLES) : []) {
    if (!item || typeof item !== 'object') continue;
    for (const key of ['fps', 'derivedFps', 'decodeFps']) {
      const value = boundedNumber(item[key], 240);
      if (value !== null) { fps.push(value); break; }
    }
    for (const key of ['dropped', 'droppedFrames', 'framesDropped']) {
      const value = boundedCount(item[key]);
      if (value !== null) { dropped.push(value); break; }
    }
  }
  const resources = report.resources && typeof report.resources === 'object' ? report.resources : {};
  const rss = boundedNumber(resources.currentRssMiB ?? resources.rssMiB, 1048576);
  const cpu = boundedNumber(resources.processCpuPercent ?? resources.cpuPercent, 1000);
  return {
    logCount,
    retainedLogCount,
    redactedLogCount,
    inputTraceEventCount,
    metadataOnly,
    summaryGapCount,
    ringDropCount,
    logReceipt,
    inputTraceLoss,
    correlation: projectCorrelation(report, metrics, outcomes),
    fps,
    dropped,
    droppedIntervalDelta,
    rssMiB: rss,
    cpuPercent: cpu,
    visibleEffect: {
      samples: visible,
      sent,
      coverage: visibleCoverage,
      // This is intentionally independent of ACK coverage.
      metricAvailable: visible !== null,
    },
    latency: {
      captureMs: sampleStats(collectMetricValues(metrics, 'capturePrepareMs')),
      encodeMs: sampleStats(collectMetricValues(metrics, 'encoderMs')),
      inputToVisibleEffectMs: sampleStats(collectMetricValues(metrics, 'inputToVisibleEffectMs')),
    },
  };
}

function createRuntimeEvidenceRecorder(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const maxReports = Math.max(1, Math.min(MAX_SAMPLES, Number(options.maxReports) || MAX_SAMPLES));
  let startedAt = null;
  let endedAt = null;
  let reports = [];
  let resourceSamples = [];
  let heartbeat = { samples: 0, ringDropped: 0 };
  let summaryCoverage = { observed: false, droppedSummaryCount: 0, gaps: [] };

  function start() { if (startedAt === null) startedAt = now(); endedAt = null; }
  function observeDiagnostic(report) {
    if (startedAt === null) start();
    const projected = projectDiagnostic(report);
    reports.push(projected);
    if (reports.length > maxReports) reports.shift();
    observeResource({ rssMiB: projected.rssMiB, cpuPercent: projected.cpuPercent });
    return projected;
  }
  function observeHeartbeat(data = {}) {
    if (startedAt === null) start();
    const value = boundedCount(data.ringDropped);
    heartbeat.samples = Math.min(MAX_COUNT, heartbeat.samples + 1);
    if (value !== null) heartbeat.ringDropped = Math.min(MAX_COUNT, heartbeat.ringDropped + value);
  }
  function observeSummaryCoverage(coverage = {}) {
    summaryCoverage.observed = true;
    const dropped = boundedCount(coverage.droppedSummaryCount);
    if (dropped !== null) summaryCoverage.droppedSummaryCount = dropped;
    if (Array.isArray(coverage.gaps)) {
      summaryCoverage.gaps = coverage.gaps.slice(-MAX_MISSING).map(gap => ({
        reason: typeof gap?.reason === 'string' ? gap.reason.slice(0, 48) : 'unknown',
        count: boundedCount(gap?.count) ?? 0,
      }));
    }
  }
  function observeRuntime(runtime = {}) {
    if (startedAt === null) start();
    observeResource({
      rssMiB: boundedNumber(runtime.currentRssMiB, 1048576),
      cpuPercent: boundedNumber(runtime.processCpuPercent, 10000),
    });
  }
  function observeResource(sample) {
    resourceSamples.push(sample);
    if (resourceSamples.length > maxReports) resourceSamples.shift();
  }
  function stop() { if (startedAt !== null && endedAt === null) endedAt = now(); }
  function snapshot() {
    const missing = [];
    const projected = reports.slice();
    const sum = key => projected.reduce((total, row) => total + (row[key] ?? 0), 0);
    const sumKnown = key => projected.some(row => row[key] !== null) ? sum(key) : null;
    const fps = projected.flatMap(row => row.fps);
    const dropped = projected.flatMap(row => row.dropped);
    const droppedIntervalDelta = projected.flatMap(row => row.droppedIntervalDelta);
    const visibleRows = projected.map(row => row.visibleEffect).filter(row => row.metricAvailable);
    const visibleSamples = visibleRows.reduce((total, row) => total + (row.samples ?? 0), 0);
    const sent = visibleRows.reduce((total, row) => total + (row.sent ?? 0), 0);
    const visibleCoverage = ratio(visibleSamples, sent);
    const logReceipts = Object.fromEntries(LOG_RECEIPT_STATES.map(state => [state, 0]));
    projected.forEach(row => { if (logReceipts[row.logReceipt?.state] !== undefined) logReceipts[row.logReceipt.state]++; });
    const inputTraceLoss = Object.fromEntries(TRACE_LOSS_FIELDS.map(key => [key,
      projected.reduce((total, row) => total + (row.inputTraceLoss?.[key] ?? 0), 0)]));
    const correlationStages = Object.fromEntries(CORRELATION_STAGES.map(stage => [stage,
      projected.filter(row => row.correlation?.stages?.[stage] === true).length]));
    const correlationReports = projected.filter(row => row.correlation).length;
    const rss = sampleStats(resourceSamples.map(row => row.rssMiB));
    const cpu = sampleStats(resourceSamples.map(row => row.cpuPercent));
    if (!projected.length) recordMissing(missing, 'diagnostics');
    if (projected.every(row => row.logCount === null)) recordMissing(missing, 'logCount');
    if (!summaryCoverage.observed && projected.every(row => row.summaryGapCount === null)) recordMissing(missing, 'summaryGapCount');
    if (!heartbeat.samples) recordMissing(missing, 'ringDropped');
    if (!fps.length) recordMissing(missing, 'fps');
    if (projected.some(row => row.metadataOnly)) {
      if (!droppedIntervalDelta.length) recordMissing(missing, 'droppedFramesIntervalDelta');
    } else if (!dropped.length) recordMissing(missing, 'droppedFrames');
    if (!rss.available) recordMissing(missing, 'rssMiB');
    if (!cpu.available) recordMissing(missing, 'cpuPercent');
    if (!visibleRows.length || visibleCoverage === null) recordMissing(missing, 'inputToVisibleEffectMs');
    return {
      schemaVersion: 1,
      window: { startedAt, endedAt, reportCount: projected.length },
      diagnostics: {
        logCount: { total: sumKnown('logCount'), reportsWithLogs: projected.filter(row => (row.logCount ?? 0) > 0).length,
          zeroLogReports: projected.filter(row => row.logCount === 0).length,
          unknownReports: projected.filter(row => row.logCount === null).length },
        retainedLogCount: sumKnown('retainedLogCount'),
        redactedLogCount: sumKnown('redactedLogCount'),
        logReceiptStates: logReceipts,
        inputTraceEventCount: sumKnown('inputTraceEventCount'),
        inputTraceLoss,
        metadataOnlyReports: projected.filter(row => row.metadataOnly).length,
        summaryGapCount: summaryCoverage.droppedSummaryCount + sum('summaryGapCount'),
        summaryGaps: summaryCoverage.gaps.slice(),
        ringDropCount: heartbeat.ringDropped + sum('ringDropCount'),
      },
      resources: { rssMiB: rss, cpuPercent: cpu },
      media: { fps: sampleStats(fps), droppedFrames: sampleStats(dropped),
        droppedFramesScope: 'legacy-event-counter-unspecified',
        droppedFramesIntervalDelta: sampleStats(droppedIntervalDelta),
        droppedFramesIntervalDeltaScope: 'webrtc-inbound-interval' },
      visibleEffect: { sent: sent || null, samples: visibleSamples || null, coverage: visibleCoverage },
      correlation: { reports: correlationReports, stages: correlationStages,
        completeReports: projected.filter(row => row.correlation?.complete === true).length },
      coverage: { complete: missing.length === 0, missing },
    };
  }
  function receipt() {
    return snapshot();
  }
  return { start, stop, observeDiagnostic, observeHeartbeat, observeRuntime, observeSummaryCoverage, snapshot, receipt };
}

module.exports = { createRuntimeEvidenceRecorder, projectDiagnostic, sampleStats };
