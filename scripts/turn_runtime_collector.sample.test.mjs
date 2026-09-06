import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./turn_runtime_collector.py', import.meta.url), 'utf8');
const match = source.match(/SAMPLE_JS = r\"\"\"([\s\S]*?)\"\"\"/);
assert.ok(match, 'SAMPLE_JS must remain directly executable');
const sampleSource = match[1];

function harness() {
  let now = 0;
  let attempt = 'attempt-a';
  let mediaPhase = 'active';
  let rect = { x: 10, y: 20, width: 1280, height: 720 };
  let video = null;
  let statsHook = null;
  const callbacks = [];
  const makeVideo = () => ({
    videoWidth: 1280,
    videoHeight: 720,
    getBoundingClientRect: () => ({ ...rect }),
    requestVideoFrameCallback(callback) { callbacks.push({ video: this, callback }); return callbacks.length; },
    cancelVideoFrameCallback() {},
  });
  video = makeVideo();
  const stats = () => new Map([
    ['inbound', { type: 'inbound-rtp', kind: 'video', framesDecoded: 100, framesReceived: 100, packetsReceived: 100, jitterBufferEmittedCount: 100, jitterBufferDelay: 1 }],
    ['pair', { id: 'pair', type: 'candidate-pair', state: 'succeeded', selected: true, localCandidateId: 'local' }],
    ['local', { id: 'local', type: 'local-candidate', candidateType: 'relay', protocol: 'udp' }],
  ]);
  const context = {
    performance: { now: () => now },
    window: {},
    document: { getElementById: (id) => id === 'remoteVideo' ? video : null },
    WebRTC: {
      pc: { connectionState: 'connected', getStats: async () => { if (statsHook) await statsHook(); return stats(); } },
      socket: { connected: true },
      currentConnectionAttemptId: attempt,
      _videoFrameSeq: 100,
      getMediaAppliedPhase: () => mediaPhase,
    },
  };
  context.window.WebRTC = context.WebRTC;
  vm.createContext(context);
  const run = vm.runInContext(`(${sampleSource})`, context);
  return {
    async sample(at) { now = at; return run(); },
    frame(at) { now = at; const item = callbacks.shift(); assert.ok(item, 'expected a registered video callback'); item.callback(at, {}); },
    setStatsHook(hook) { statsHook = hook; },
    setAttempt(value) { attempt = value; context.WebRTC.currentConnectionAttemptId = value; },
    setMediaPhase(value) { mediaPhase = value; },
    replaceVideo() { video = makeVideo(); },
    setResolution(width, height) { video.videoWidth = width; video.videoHeight = height; },
    setRect(value) { rect = value; },
  };
}

test('SAMPLE_JS records the 1490ms frame gap missed by one-hertz paint ages', async () => {
  const page = harness();
  await page.sample(0);
  page.frame(0);
  const first = await page.sample(1000);
  page.frame(1490);
  const second = await page.sample(2000);

  assert.equal(first.paintAgeMs, 1000);
  assert.equal(second.paintAgeMs, 510);
  assert.equal(second.maxPaintGapMs, 1490);
  assert.equal(second.intervalMaxPaintGapMs, 1490);
});

test('SAMPLE_JS retains a painted resolution change that ends between samples', async () => {
  const page = harness();
  await page.sample(0);
  page.frame(0);
  page.setResolution(640, 360);
  page.frame(50);
  page.setResolution(1280, 720);
  page.frame(100);
  const sample = await page.sample(150);
  assert.equal(sample.resolution.width, 1280);
  assert.equal(sample.paintResolution.minWidth, 640);
  assert.equal(sample.paintResolution.maxWidth, 1280);
  assert.equal(sample.paintResolution.minHeight, 360);
});

test('SAMPLE_JS rejects null geometry rather than coercing it to zero', async () => {
  const page = harness();
  page.setRect({ x: null, y: 20, width: 1280, height: 720 });
  await page.sample(0);
  page.frame(0);
  const sample = await page.sample(50);
  assert.equal(sample.geometry, null);
  assert.equal(sample.paintEvidenceStatus, 'invalid-geometry');
});

test('SAMPLE_JS keeps healthy 20 FPS paint evidence and fails closed without a first paint', async () => {
  const healthy = harness();
  await healthy.sample(0);
  healthy.frame(0);
  for (let at = 50; at <= 1000; at += 50) healthy.frame(at);
  const sample = await healthy.sample(1000);
  assert.equal(sample.firstPaintObserved, true);
  assert.equal(sample.maxPaintGapMs, 50);
  assert.equal(sample.paintEvidenceStatus, 'complete');

  const stalled = harness();
  await stalled.sample(0);
  const noFirstPaint = await stalled.sample(2000);
  assert.equal(noFirstPaint.paintEvidenceStatus, 'awaiting-first-paint');
  assert.equal(noFirstPaint.maxPaintGapMs, null);
});

test('SAMPLE_JS carries an unfinished stall into the next interval', async () => {
  const page = harness();
  await page.sample(0);
  page.frame(0);
  const first = await page.sample(1000);
  const second = await page.sample(2000);
  assert.equal(first.maxPaintGapMs, 1000);
  assert.equal(second.maxPaintGapMs, 2000);
  assert.equal(second.intervalMaxPaintGapMs, 1000);
});

test('SAMPLE_JS resets paint evidence for phase, attempt, and video boundaries', async () => {
  const page = harness();
  await page.sample(0);
  page.frame(0);
  await page.sample(100);
  page.setMediaPhase('suspended');
  const paused = await page.sample(500);
  assert.equal(paused.paintEvidenceStatus, 'inactive-phase');
  page.setMediaPhase('active');
  const resumed = await page.sample(600);
  assert.equal(resumed.paintEvidenceStatus, 'awaiting-first-paint');
  page.setAttempt('attempt-b');
  const retried = await page.sample(700);
  assert.equal(retried.paintEvidenceStatus, 'awaiting-first-paint');
  page.replaceVideo();
  const replaced = await page.sample(800);
  assert.equal(replaced.paintEvidenceStatus, 'awaiting-first-paint');
});

test('SAMPLE_JS ignores a cancelled callback from the previous media phase', async () => {
  const page = harness();
  await page.sample(0);
  page.frame(0);
  page.setMediaPhase('suspended');
  await page.sample(100);
  page.setMediaPhase('active');
  await page.sample(200);
  page.frame(250); // This is the queued callback for the cancelled tracker.
  const evidence = await page.sample(300);
  assert.equal(evidence.paintEvidenceStatus, 'awaiting-first-paint');
  assert.equal(evidence.firstPaintObserved, false);
});

test('SAMPLE_JS timestamps paint after awaited stats and records finite geometry ranges', async () => {
  const page = harness();
  await page.sample(0);
  page.frame(1000);
  page.setStatsHook(async () => page.frame(1100));
  const sample = await page.sample(1000);
  assert.equal(sample.paintAgeMs, 0);
  assert.ok(sample.paintAgeMs >= 0);
  assert.equal(sample.geometry.rangeWidth, 0);

  page.setStatsHook(null);
  page.setRect({ x: 12.5, y: 20, width: 1282, height: 720 });
  const moved = await page.sample(1200);
  assert.equal(moved.geometry.rangeX, 2.5);
  assert.equal(moved.geometry.rangeWidth, 2);

  page.setRect({ x: Number.NaN, y: 20, width: 1282, height: 720 });
  const malformed = await page.sample(1300);
  assert.equal(malformed.paintEvidenceStatus, 'invalid-geometry');
  assert.equal(malformed.geometry, null);
});
