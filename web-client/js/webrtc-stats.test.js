const assert = require('node:assert/strict');
const test = require('node:test');

const { WebRtcStats } = require('./webrtc-stats');


function stats(reports) {
  return new Map(reports.map((report) => [report.id, report]));
}


test('transport selectedCandidatePairId wins over later succeeded pairs', () => {
  const reports = stats([
    { id: 'transport-1', type: 'transport', selectedCandidatePairId: 'pair-selected' },
    { id: 'pair-selected', type: 'candidate-pair', state: 'succeeded', localCandidateId: 'local-1', remoteCandidateId: 'remote-1', currentRoundTripTime: 0.042 },
    { id: 'pair-other', type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'local-2', remoteCandidateId: 'remote-2', currentRoundTripTime: 0.9 },
    { id: 'local-1', type: 'local-candidate', candidateType: 'srflx', protocol: 'udp', address: '203.0.113.1', port: 5000 },
    { id: 'remote-1', type: 'remote-candidate', candidateType: 'host', protocol: 'udp', address: '192.168.1.2', port: 6000 },
    { id: 'local-2', type: 'local-candidate', candidateType: 'relay' },
    { id: 'remote-2', type: 'remote-candidate', candidateType: 'relay' },
  ]);

  const selected = WebRtcStats.selectActiveCandidatePair(reports);

  assert.equal(selected.pair.id, 'pair-selected');
  assert.equal(selected.local.candidateType, 'srflx');
  assert.equal(selected.remote.candidateType, 'host');
});


test('nominated succeeded pair is the compatibility fallback', () => {
  const reports = stats([
    { id: 'pair-old', type: 'candidate-pair', state: 'succeeded', nominated: false },
    { id: 'pair-nominated', type: 'candidate-pair', state: 'succeeded', nominated: true },
  ]);

  assert.equal(WebRtcStats.selectActiveCandidatePair(reports).pair.id, 'pair-nominated');
});


test('interval media stats derive canonical deltas instead of session averages', () => {
  const previous = {
    sampledAt: 1000,
    framesReceived: 100,
    framesDecoded: 90,
    packetsLost: 4,
    bytesReceived: 1000,
    jitterBufferDelay: 2,
    jitterBufferEmittedCount: 20,
    framesDropped: 1,
    packetsReceived: 800,
    nackCount: 2,
    pliCount: 0,
    firCount: 0,
    freezeCount: 0,
  };
  const current = {
    sampledAt: 2000,
    framesReceived: 125,
    framesDecoded: 110,
    packetsLost: 6,
    bytesReceived: 5000,
    jitterBufferDelay: 3.2,
    jitterBufferEmittedCount: 30,
    framesDropped: 4,
    packetsReceived: 860,
    nackCount: 5,
    pliCount: 1,
    firCount: 0,
    freezeCount: 2,
  };

  assert.deepEqual(WebRtcStats.deriveIntervalMediaStats(previous, current), {
    elapsedMs: 1000,
    derivedFps: 20,
    receivedDelta: 25,
    decodedDelta: 20,
    packetsLostDelta: 2,
    bytesDelta: 4000,
    jitterBufferMs: 120,
    framesDroppedDelta: 3,
    packetsReceivedDelta: 60,
    nackCountDelta: 3,
    pliCountDelta: 1,
    firCountDelta: 0,
    freezeDelta: 2,
  });
});


test('canonical derived FPS uses decoded delta instead of browser-reported FPS', () => {
  const previous = {
    sampledAt: 1000,
    framesReceived: 100,
    framesDecoded: 100,
    packetsLost: 0,
    bytesReceived: 1000,
    jitterBufferDelay: 0,
    jitterBufferEmittedCount: 0,
    framesDropped: 0,
    packetsReceived: 100,
    nackCount: 0,
    pliCount: 0,
    firCount: 0,
    freezeCount: 0,
  };
  const snapshot = WebRtcStats.normalizeStats(stats([{
    id: 'inbound-video',
    type: 'inbound-rtp',
    kind: 'video',
    framesReceived: 119,
    framesDecoded: 119,
    framesPerSecond: 90,
    packetsLost: 0,
    bytesReceived: 2000,
    packetsReceived: 119,
  }]), previous, 2000);

  assert.equal(snapshot.derivedFps, 19);
  assert.equal(snapshot.decodedDelta, 19);
  assert.equal(snapshot.browserReportedFps, 90);
});


test('first stats sample is warmup and does not derive browser FPS as playback FPS', () => {
  const snapshot = WebRtcStats.normalizeStats(stats([{
    id: 'inbound-video',
    type: 'inbound-rtp',
    kind: 'video',
    framesReceived: 100,
    framesDecoded: 100,
    framesPerSecond: 90,
  }]), null, 1000);

  assert.equal(snapshot.warmup, true);
  assert.equal(snapshot.derivedFps, 0);
  assert.equal(snapshot.browserReportedFps, 90);
});


test('sampler owns one timer and ignores overlapping samples', async () => {
  const timers = new Map();
  let nextTimerId = 1;
  let statsCalls = 0;
  let resolveStats;
  const sampler = WebRtcStats.createWebRtcStatsSampler({
    getStats: () => {
      statsCalls += 1;
      return new Promise((resolve) => { resolveStats = resolve; });
    },
    setTimer(callback, intervalMs) {
      const id = nextTimerId++;
      timers.set(id, { callback, intervalMs });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
  });

  sampler.start();
  sampler.start();
  assert.equal(timers.size, 1);
  const first = sampler.sampleNow();
  const overlapping = sampler.sampleNow();
  assert.equal(statsCalls, 1);
  resolveStats(stats([]));
  await Promise.all([first, overlapping]);
  sampler.stop();

  assert.equal(timers.size, 0);
  assert.equal(sampler.snapshot(), null);
});
