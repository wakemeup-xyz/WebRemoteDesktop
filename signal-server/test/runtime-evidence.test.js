'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntimeEvidenceRecorder, projectDiagnostic, sampleStats } = require('../lib/observability/runtime-evidence');

test('sampleStats last preserves observation order while quantiles and maximum use sorted values', () => {
  assert.deepEqual(sampleStats([8, 3, NaN, null, 2]), {
    available: true, count: 3, last: 2, p50: 3, p95: 8, max: 8,
  });
  assert.equal(sampleStats([8, -1, 0, undefined]).last, 0);
  assert.deepEqual(sampleStats([null, undefined, NaN, -1]), {
    available: false, count: 0, last: null, p50: null, p95: null, max: null,
  });
});

test('resource last follows interleaved runtime and diagnostic observation order', () => {
  const evidence = createRuntimeEvidenceRecorder();
  evidence.observeRuntime({ currentRssMiB: 100, processCpuPercent: 10 });
  evidence.observeDiagnostic({ resources: { currentRssMiB: 50, processCpuPercent: 5 } });
  let receipt = evidence.receipt();
  assert.equal(receipt.resources.rssMiB.last, 50);
  assert.equal(receipt.resources.cpuPercent.last, 5);
  assert.equal(receipt.resources.rssMiB.max, 100);
  evidence.observeRuntime({ currentRssMiB: 0, processCpuPercent: 0 });
  evidence.observeDiagnostic({});
  receipt = evidence.receipt();
  assert.equal(receipt.resources.rssMiB.last, 0);
  assert.equal(receipt.resources.cpuPercent.last, 0);
});

function observedInterval(overrides = {}) {
  return { schemaVersion: 1, kind: 'webrtc-inbound-interval', elapsedMs: 1000,
    sampleAgeMs: 100, fpsObserved: true, droppedFramesObserved: true, ...overrides };
}

test('schema3 projects measured canonical interval metadata instead of discarded or legacy events', () => {
  // Scalar-only reproduction of the production report; no console or identity data.
  const media = { derivedFps: 18, framesDroppedDelta: 0, decodedDelta: 18,
    receivedDelta: 20, hasPaintedFrame: true };
  const historical = projectDiagnostic({ schemaVersion: 3, events: [], traceSummary: media });
  assert.deepEqual(historical.fps, []);
  assert.deepEqual(historical.droppedIntervalDelta, []);
  const row = projectDiagnostic({ schemaVersion: 3, events: [{ fps: 99, dropped: 88 }],
    traceSummary: { ...media, mediaInterval: observedInterval() } });
  assert.deepEqual(row.fps, [18]);
  assert.deepEqual(row.dropped, []);
  assert.deepEqual(row.droppedIntervalDelta, [0]);
});

test('schema3 interval evidence rejects defaults, stale samples, invalid metadata and counter coercion', () => {
  for (const mediaInterval of [undefined, {}, observedInterval({ elapsedMs: 0 }),
    observedInterval({ elapsedMs: '1000' }), observedInterval({ elapsedMs: Infinity }),
    observedInterval({ sampleAgeMs: null }), observedInterval({ sampleAgeMs: -1 }),
    observedInterval({ sampleAgeMs: 5001 }), observedInterval({ kind: 'video-element' }),
    observedInterval({ fpsObserved: false, droppedFramesObserved: false })]) {
    const row = projectDiagnostic({ schemaVersion: 3, traceSummary: {
      derivedFps: 0, framesDroppedDelta: 0, hasPaintedFrame: true, mediaInterval } });
    assert.deepEqual(row.fps, []);
    assert.deepEqual(row.droppedIntervalDelta, []);
  }
  const zero = projectDiagnostic({ schemaVersion: 3, traceSummary: {
    derivedFps: 0, framesDroppedDelta: 0, mediaInterval: observedInterval() } });
  assert.deepEqual(zero.fps, [0]);
  assert.deepEqual(zero.droppedIntervalDelta, [0]);
  for (const value of [null, undefined, '', '0', true, NaN, Infinity, -1]) {
    const row = projectDiagnostic({ schemaVersion: 3, traceSummary: {
      derivedFps: value, framesDroppedDelta: value, mediaInterval: observedInterval() } });
    assert.deepEqual(row.fps, []);
    assert.deepEqual(row.droppedIntervalDelta, []);
  }
  const partial = projectDiagnostic({ schemaVersion: 3, traceSummary: {
    derivedFps: 18, framesDroppedDelta: 0, mediaInterval: observedInterval({ droppedFramesObserved: false }) } });
  assert.deepEqual(partial.fps, [18]);
  assert.deepEqual(partial.droppedIntervalDelta, []);
});

test('schema3 redactor preserves only bounded interval evidence and drops private owner data', () => {
  const { redactDiagnosticPayload } = require('../lib/diagnostic');
  const clean = redactDiagnosticPayload({ schemaVersion: 3, traceSummary: {
    derivedFps: 18, framesDroppedDelta: 0,
    mediaInterval: { ...observedInterval(), owner: 'PRIVATE_OWNER_CANARY' } } });
  assert.deepEqual(clean.traceSummary.mediaInterval, observedInterval());
  assert.equal(JSON.stringify(clean).includes('PRIVATE_OWNER_CANARY'), false);
  assert.deepEqual(projectDiagnostic(clean).fps, [18]);
  assert.deepEqual(projectDiagnostic(clean).droppedIntervalDelta, [0]);
  for (const invalid of [{ elapsedMs: 0 }, { elapsedMs: 60001 }, { sampleAgeMs: 5001 },
    { elapsedMs: null }, { sampleAgeMs: null }, { elapsedMs: '1000' }, { schemaVersion: 2 }, { kind: 'video-element' }]) {
    const report = redactDiagnosticPayload({ schemaVersion: 3, traceSummary: {
      derivedFps: 0, framesDroppedDelta: 0, mediaInterval: observedInterval(invalid) } });
    assert.equal(Object.hasOwn(report.traceSummary, 'mediaInterval'), false);
    assert.deepEqual(projectDiagnostic(report).fps, []);
    assert.deepEqual(projectDiagnostic(report).droppedIntervalDelta, []);
  }
});

test('receipt keeps interval dropped deltas separate from legacy counter values', () => {
  const evidence = createRuntimeEvidenceRecorder();
  evidence.observeDiagnostic({ events: [{ fps: 20, droppedFrames: 88 }] });
  evidence.observeDiagnostic({ schemaVersion: 3, traceSummary: {
    derivedFps: 18, framesDroppedDelta: 0, mediaInterval: observedInterval() } });
  const receipt = evidence.receipt();
  assert.equal(receipt.media.fps.last, 18);
  assert.equal(receipt.media.droppedFrames.last, 88);
  assert.equal(receipt.media.droppedFramesScope, 'legacy-event-counter-unspecified');
  assert.equal(receipt.media.droppedFramesIntervalDelta.last, 0);
  assert.equal(receipt.media.droppedFramesIntervalDeltaScope, 'webrtc-inbound-interval');
  assert.equal(receipt.coverage.missing.includes('droppedFramesIntervalDelta'), false);
  const missing = createRuntimeEvidenceRecorder();
  missing.observeDiagnostic({ schemaVersion: 3, traceSummary: { derivedFps: 0, framesDroppedDelta: 0 } });
  assert.equal(missing.receipt().media.fps.available, false);
  assert.equal(missing.receipt().media.droppedFramesIntervalDelta.available, false);
  assert.ok(missing.receipt().coverage.missing.includes('droppedFramesIntervalDelta'));
});

test('projects only explicit diagnostic evidence and keeps visible-effect coverage independent from ACKs', () => {
  const row = projectDiagnostic({
    logCount: 2,
    summaryGapCount: 3,
    ringDropped: 4,
    latency: {
      outcomes: { sent: 5, acked: 5 },
      metrics: {
        inputAckRttMs: { count: 5, p50: 4 },
        inputToVisibleEffectMs: { count: 2, p50: 72, p95: 120 },
        encoderMs: { count: 1, p50: 8 },
      },
    },
    events: [{ fps: 19, droppedFrames: 1 }],
    resources: { currentRssMiB: 412.5, processCpuPercent: 23 },
  });
  assert.deepEqual(row.visibleEffect, { samples: 2, sent: 5, coverage: .4, metricAvailable: true });
  assert.deepEqual(row.fps, [19]);
  assert.deepEqual(row.dropped, [1]);
  assert.equal(row.rssMiB, 412.5);
  assert.equal(row.cpuPercent, 23);
  assert.equal(row.latency.inputToVisibleEffectMs.available, true);
});

test('receipt reports logCount, summary gaps, ring drops and missing evidence without inventing samples', () => {
  let time = 1000;
  const evidence = createRuntimeEvidenceRecorder({ now: () => time });
  assert.equal(evidence.snapshot().coverage.complete, false);
  assert.ok(evidence.snapshot().coverage.missing.includes('logCount'));

  evidence.observeDiagnostic({
    logCount: 0,
    summaryGapCount: 2,
    latency: { outcomes: { sent: 4 }, metrics: { inputToVisibleEffectMs: { count: 1, p50: 80 } } },
    events: [{ fps: 18, dropped: 2 }],
    resources: { currentRssMiB: 400, cpuPercent: 12 },
  });
  evidence.observeHeartbeat({ ringDropped: 7 });
  evidence.observeSummaryCoverage({ droppedSummaryCount: 5, gaps: [{ reason: 'daily-capacity', count: 5 }] });
  time += 1000;
  const receipt = evidence.receipt();
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.diagnostics.logCount.total, 0);
  assert.equal(receipt.diagnostics.logCount.zeroLogReports, 1);
  assert.equal(receipt.diagnostics.summaryGapCount, 7);
  assert.equal(receipt.diagnostics.ringDropCount, 7);
  assert.equal(receipt.resources.rssMiB.last, 400);
  assert.equal(receipt.resources.cpuPercent.last, 12);
  assert.equal(receipt.media.fps.p50, 18);
  assert.equal(receipt.media.droppedFrames.p50, 2);
  assert.deepEqual(receipt.visibleEffect, { sent: 4, samples: 1, coverage: .25 });
  assert.equal(receipt.coverage.complete, true);
});

test('receipt preserves explicit production summary gap and ring-drop fields', () => {
  const row = projectDiagnostic({ schemaVersion: 3, logContentPolicy: 'metadata-only',
    reportedLogCount: 1, summaryGapCount: 3, ringDropCount: 4,
    coverage: { status: 'partial' }, inputTraceLoss: { droppedEvents: 2 } });
  assert.equal(row.summaryGapCount, 3);
  assert.equal(row.ringDropCount, 4);
  assert.deepEqual(row.inputTraceLoss.droppedEvents, 2);
  const evidence = createRuntimeEvidenceRecorder();
  evidence.observeDiagnostic({ schemaVersion: 3, logContentPolicy: 'metadata-only',
    reportedLogCount: 1, summaryGapCount: 3, ringDropCount: 4,
    coverage: { status: 'partial' }, inputTraceLoss: { droppedEvents: 2 } });
  const receipt = evidence.receipt();
  assert.equal(receipt.diagnostics.summaryGapCount, 3);
  assert.equal(receipt.diagnostics.ringDropCount, 4);
  assert.equal(receipt.coverage.complete, false);
});

test('receipt exposes observed, nonzero and unknown coverage signals without treating null as zero', () => {
  const unknown = createRuntimeEvidenceRecorder();
  unknown.observeDiagnostic({ schemaVersion: 3, reportedLogCount: 1 });
  assert.deepEqual(unknown.receipt().diagnostics.coverageSignals, {
    summaryGap: { state: 'unknown', count: null },
    ringDrop: { state: 'unknown', count: null },
    source: 'unknown',
  });

  const observed = createRuntimeEvidenceRecorder();
  observed.observeSummaryCoverage({ gapTotalCount: 0, droppedSummaryCount: 0, gaps: [] });
  observed.observeHeartbeat({ ringDropped: 0 });
  assert.deepEqual(observed.receipt().diagnostics.coverageSignals, {
    summaryGap: { state: 'observed', count: 0 },
    ringDrop: { state: 'observed', count: 0 },
    source: 'observed',
  });

  const nonzero = createRuntimeEvidenceRecorder();
  nonzero.observeSummaryCoverage({ gapTotalCount: 80, droppedSummaryCount: 0,
    gapTotalCountInWindow: 7,
    gaps: [{ reason: 'receipt-horizon', count: 80 }],
    gapsInWindow: [{ reason: 'receipt-horizon', count: 7 }] });
  nonzero.observeHeartbeat({ ringDropped: 2 });
  const nonzeroReceipt = nonzero.receipt();
  assert.deepEqual(nonzeroReceipt.diagnostics.coverageSignals, {
    summaryGap: { state: 'nonzero', count: 80 },
    ringDrop: { state: 'nonzero', count: 2 },
    source: 'observed',
  });
  assert.equal(nonzeroReceipt.diagnostics.summaryGapCount, 80);
  assert.equal(nonzeroReceipt.diagnostics.summaryGapCountInWindow, 7);
  assert.deepEqual(nonzeroReceipt.diagnostics.summaryGapsInWindow,
    [{ reason: 'receipt-horizon', count: 7 }]);
  assert.equal(nonzeroReceipt.diagnostics.ringDropCount, 2);
});

test('receipt aggregates bounded Host diagnostic admission counters', () => {
  const admission = { types: { frame_timing: { sent: 10, dropped: 3 }, capture_stats: { sent: 2, dropped: 1 } },
    reasons: { congested: 4 }, legacyDropped: { ids: 5, metadata: 6 } };
  const evidence = createRuntimeEvidenceRecorder();
  const row = projectDiagnostic({ schemaVersion: 3, traceSummary: { diagnosticAdmission: admission } });
  assert.equal(row.diagnosticAdmission.types.frame_timing.dropped, 3);
  evidence.observeDiagnostic({ schemaVersion: 3, traceSummary: { diagnosticAdmission: admission } });
  const receipt = evidence.receipt();
  assert.equal(receipt.diagnostics.diagnosticAdmission.types.frame_timing.sent, 10);
  assert.equal(receipt.diagnostics.diagnosticAdmission.types.frame_timing.dropped, 3);
  assert.equal(receipt.diagnostics.diagnosticAdmission.reasons.congested, 4);
  assert.equal(receipt.diagnostics.diagnosticAdmission.legacyDropped.metadata, 6);
  assert.equal(receipt.diagnostics.diagnosticAdmission.reports, 1);
});

test('bounded recorder evicts old reports and never retains untrusted event objects', () => {
  let time = 0;
  const evidence = createRuntimeEvidenceRecorder({ now: () => time, maxReports: 2 });
  for (let i = 0; i < 3; i++) {
    evidence.observeDiagnostic({ logCount: i, events: [{ fps: i + 1, secret: 'private-canary' }] });
    time += 1;
  }
  const receipt = evidence.receipt();
  assert.equal(receipt.window.reportCount, 2);
  assert.equal(receipt.diagnostics.logCount.total, 3);
  assert.equal(JSON.stringify(receipt).includes('private-canary'), false);
});

test('schema3 receipt separates reported console logs from redaction and structured input evidence', () => {
  const evidence = createRuntimeEvidenceRecorder();
  evidence.observeDiagnostic({ schemaVersion: 3, logCount: 0, logs: [], logContentPolicy: 'metadata-only',
    reportedLogCount: 2, retainedLogCount: 0, redactedLogCount: 2,
    inputTrace: { events: [{ stage: 'ack', secret: 'PRIVATE_TRACE_CANARY' }] } });
  const receipt = evidence.receipt();
  assert.equal(receipt.diagnostics.logCount.total, 2);
  assert.equal(receipt.diagnostics.logCount.zeroLogReports, 0);
  assert.equal(receipt.diagnostics.logCount.unknownReports, 0);
  assert.equal(receipt.diagnostics.retainedLogCount, 0);
  assert.equal(receipt.diagnostics.redactedLogCount, 2);
  assert.equal(receipt.diagnostics.inputTraceEventCount, 1);
  assert.equal(receipt.diagnostics.metadataOnlyReports, 1);
  assert.equal(receipt.coverage.missing.includes('logCount'), false);
  assert.equal(JSON.stringify(receipt).includes('PRIVATE_TRACE_CANARY'), false);
});

test('historical schema3 redacted zero cannot prove zero client logs or erase structured evidence', () => {
  const evidence = createRuntimeEvidenceRecorder();
  evidence.observeDiagnostic({ schemaVersion: 3, logCount: 0, logs: [], inputTrace: { events: [{ stage: 'ack' }] } });
  const receipt = evidence.receipt();
  assert.equal(receipt.diagnostics.logCount.total, null);
  assert.equal(receipt.diagnostics.logCount.zeroLogReports, 0);
  assert.equal(receipt.diagnostics.logCount.unknownReports, 1);
  assert.equal(receipt.diagnostics.redactedLogCount, null);
  assert.equal(receipt.diagnostics.retainedLogCount, 0);
  assert.equal(receipt.diagnostics.inputTraceEventCount, 1);
  assert.equal(receipt.coverage.missing.includes('logCount'), true);
  const unknown = createRuntimeEvidenceRecorder();
  unknown.observeDiagnostic({ schemaVersion: 3, logCount: 0 });
  assert.equal(unknown.receipt().diagnostics.logCount.total, null);
  assert.ok(unknown.receipt().coverage.missing.includes('logCount'));
});

test('durable summary policy projects console and trace counts without raw event arrays', () => {
  const row=projectDiagnostic({logContentPolicy:'metadata-only',reportedLogCount:2,
    retainedLogCount:0,redactedLogCount:2,inputTraceEventCount:1});
  assert.equal(row.logCount,2);assert.equal(row.retainedLogCount,0);
  assert.equal(row.redactedLogCount,2);assert.equal(row.inputTraceEventCount,1);
  assert.equal(row.metadataOnly,true);
});

test('receipt classifies console collection and preserves bounded input loss evidence', () => {
  const base = { schemaVersion: 3, logContentPolicy: 'metadata-only', logs: [], reportedLogCount: 0,
    inputTrace: { events: [], counters: { droppedEvents: 4, droppedHashCount: 2, evictedPendingAcks: 1,
      expiredPendingAcks: 3, ackTimeoutCount: 5 } } };
  assert.equal(projectDiagnostic(base).logReceipt.state, 'empty');
  assert.deepEqual(projectDiagnostic(base).inputTraceLoss, {
    droppedEvents: 4, droppedHashCount: 2, evictedPendingAcks: 1, expiredPendingAcks: 3, ackTimeoutCount: 5,
  });
  assert.equal(projectDiagnostic({ schemaVersion: 3, logContentPolicy: 'metadata-only' }).logReceipt.state, 'unknown');
  assert.equal(projectDiagnostic({ ...base, reportedLogCount: 3, logReceipt: { state: 'truncated', reported: 3, dropped: 2 } }).logReceipt.state, 'truncated');
  assert.equal(projectDiagnostic({ ...base, logReceipt: { state: 'failed' } }).logReceipt.state, 'failed');
});

test('receipt exposes stage correlation coverage without fabricating missing stages', () => {
  const row = projectDiagnostic({ schemaVersion: 3, logContentPolicy: 'metadata-only', reportedLogCount: 1,
    latency: { scope: { attemptHash: 'a'.repeat(32), generation: 1, leaseEpoch: 2 }, outcomes: { acked: 1 }, metrics: {
      hostApplyMs: { count: 1 }, capturePrepareMs: { count: 1 }, encoderMs: { count: 1 },
      rtpApiAwaitMs: { count: 1 }, inputToPostApplyFrameMs: { count: 1 }, inputToVisibleEffectMs: { count: 1 },
    } } });
  assert.equal(row.correlation.scopeAvailable, true);
  assert.deepEqual(row.correlation.stages, {
    ack: true, hostApply: true, capture: true, encode: true, rtp: true, decode: true, present: true,
  });
  assert.equal(row.correlation.complete, true);
});

test('runtime evidence summarizes bounded frame correlation loss', () => {
  const evidence = createRuntimeEvidenceRecorder();
  evidence.observeDiagnostic({ schemaVersion: 3, traceSummary: { frameTrace: {
    acceptanceState: 'UNALIGNED', droppedTraceCount: 3, invalidBatchCount: 1,
    staleTraceCount: 2, conflictingTraceCount: 1,
    stageCoverage: { sampleCount: 2, observed: { grab: 2, encode: 1, packetize: 1 } },
  } } });
  const receipt = evidence.receipt();
  assert.deepEqual(receipt.diagnostics.frameTraceLoss, {
    droppedTraceCount: 3, invalidBatchCount: 1, staleTraceCount: 2, conflictingTraceCount: 1,
  });
});

test('runtime evidence preserves bounded frame stage coverage without claiming complete input causality', () => {
  const evidence = createRuntimeEvidenceRecorder();
  const projected = evidence.observeDiagnostic({ schemaVersion: 3, traceSummary: { frameTrace: {
    acceptanceState: 'PENDING', stageCoverage: { sampleCount: 3, observed: { grab: 3, encode: 2, packetize: 2 } },
  } } });
  assert.deepEqual(projected.frameTrace.stageCoverage, {
    sampleCount: 3,
    observed: { grab: 3, age_at_recv: null, worker_queue: null, prepare: null, build: null,
      reformat: null, encode: 2, packetize: 2, encode_total: null },
  });
  assert.equal(projected.correlation.complete, false);
});
