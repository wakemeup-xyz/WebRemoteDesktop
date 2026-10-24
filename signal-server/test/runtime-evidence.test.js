'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntimeEvidenceRecorder, projectDiagnostic } = require('../lib/observability/runtime-evidence');

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
