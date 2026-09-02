const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');


function loadLatencyMonitor(overrides = {}) {
  const context = {
    console,
    Date,
    WebRTC: null,
    ...overrides,
  };
  context.globalThis = context;
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, 'latency-monitor.js'), 'utf8');
  vm.runInContext(`${source}\nglobalThis.__LatencyMonitor = LatencyMonitor;`, context);
  return context.__LatencyMonitor;
}


test('video frame paint tracking never calls RTCPeerConnection.getStats', () => {
  let getStatsCalls = 0;
  const monitor = loadLatencyMonitor({
    WebRTC: { pc: { getStats() { getStatsCalls += 1; return new Map(); } } },
  });

  monitor.onVideoFrame(1000, {});
  monitor.onVideoFrame(1050, {});

  assert.equal(getStatsCalls, 0);
});


test('v2 frame timing records measured fields and leaves encoder/network unavailable', () => {
  const monitor = loadLatencyMonitor();

  monitor.onFrameTiming({
    schemaVersion: 2,
    timings: {
      capturePrepareMs: 3.5,
      frameConvertMs: 1.25,
      encoderMs: null,
      rtpSendMs: null,
      endToEndVideoMs: null,
    },
  });
  const result = monitor.getStats();

  assert.equal(result.capture.last, 3.5);
  assert.equal(result.scale.last, 1.25);
  assert.equal(result.encode.available, false);
  assert.equal(result.network.available, false);
});


test('shared media snapshot supplies interval playout without another stats query', () => {
  const monitor = loadLatencyMonitor();
  monitor.onMediaStats({ jitterBufferMs: 18.5 });

  assert.equal(monitor.getStats().playout.last, 18.5);
});

test('v2 zero duration is measured while invalid durations stay unavailable', () => {
  const monitor = loadLatencyMonitor();
  monitor.onFrameTiming({ schemaVersion: 2, timings: {
    capturePrepareMs: 0, frameConvertMs: -1, encoderMs: NaN, rtpSendMs: 0,
  } });
  const stats = monitor.getStats();
  assert.equal(stats.capture.last, 0);
  assert.equal(stats.capture.available, true);
  assert.equal(stats.scale.available, false);
  assert.equal(stats.encode.available, false);
  assert.equal(stats.network.available, false);
});

test('legacy out-of-order timestamps are discarded without synthetic network latency', () => {
  const monitor = loadLatencyMonitor();
  monitor.onFrameTiming({ schemaVersion: 1, timings: {
    captureStart: 2, captureEnd: 1, scaleEnd: 3, encodeEnd: 4, packetSend: 5,
  } });
  const stats = monitor.getStats();
  assert.equal(stats.capture.available, false);
  assert.equal(stats.encode.available, false);
  assert.equal(stats.network.available, false);
});


test('independent input ack measures browser RTT while frame timing measures visual feedback', () => {
  let now = 1000;
  class FakeDate extends Date {
    static now() { return now; }
  }
  const monitor = loadLatencyMonitor({ Date: FakeDate });
  monitor.recordInputSend('input-1');

  now = 1120;
  monitor.onInputAck({
    type: 'input_ack',
    inputIds: ['input-1'],
    hostExecuteMs: 7,
  });
  let stats = monitor.getStats();
  assert.equal(stats.inputRtt.last, 120);
  assert.equal(stats.executeTime.last, 7);
  assert.equal(stats.visualFeedback.available, false);

  now = 1180;
  monitor.onFrameTiming({
    schemaVersion: 2,
    timings: { capturePrepareMs: 1, frameConvertMs: 1 },
    inputIds: ['input-1'],
  });
  stats = monitor.getStats();
  assert.equal(stats.inputRtt.count, 1);
  assert.equal(stats.visualFeedback.last, 180);
});
