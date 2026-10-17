const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function fixture() {
  let now = 0, id = 0; const timers = new Map(), faults = [], captures = [];
  const context = { localStorage: { getItem: () => null }, console: { log(){}, warn(){}, error(){} }, performance: { now: () => now }, RTCSessionDescription: function(value) { return value; },
    setTimeout(fn, ms) { const key = id++; timers.set(key, { fn, at: now + ms }); return key; },
    clearTimeout(key) { timers.delete(key); }, Diagnostic: { autoSendFailure: reason => captures.push(reason) } };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(`${__dirname}/runtime-diagnostic.js`, 'utf8'), context);
  const source = fs.readFileSync(`${__dirname}/webrtc.js`, 'utf8');
  vm.runInContext(source.slice(0, source.indexOf("if (typeof globalThis !== 'undefined') {", source.indexOf('const WebRTC =')))+ '\nglobalThis.rtc = WebRTC;', context);
  const rtc = context.rtc;
  Object.assign(rtc, { socket: { connected: true }, currentConnectionAttemptId: 'a', connectionAttemptSequence: 1,
    pc: { connectionState: 'new', iceConnectionState: 'new', signalingState: 'have-local-offer',
      createDataChannel: () => ({ readyState: 'connecting' }) }, noteDataChannelFault: r => faults.push(r), scheduleReconnect: r => faults.push(r) });
  rtc.stopDcKeepalive = () => {}; rtc.startDcKeepalive = () => {}; rtc.rebindActiveKeyboardLease = () => {};
  const answerStart = source.indexOf("onCurrentSocket('answer', async (data) => {");
  const answerEnd = source.indexOf("\n    onCurrentSocket('ice-candidate'", answerStart);
  const callback = source.slice(answerStart, answerEnd).replace("onCurrentSocket('answer', ", '').trim().slice(0, -2).replace('async (data) =>', 'async function(data)');
  const answer = vm.runInContext('(' + callback + ')', context).bind(rtc);
  rtc.pc.setRemoteDescription = async () => { rtc.pc.remoteDescription = {}; };
  rtc.createInputChannel();
  return { rtc, timers, faults, captures, answer, context, now: n => { now = n; }, tick(n) { now = n; for (const [key, item] of [...timers]) if (item.at <= now) { timers.delete(key); item.fn(); } } };
}
test('initial negotiation survives delayed answer beyond old ten second deadline', async () => {
  const f = fixture(); f.tick(11000); assert.deepEqual(f.faults, []);
  await f.answer({ answer: {} });
  f.tick(20999); assert.deepEqual(f.faults, []);
  f.tick(21000); assert.deepEqual(f.faults, ['dc-stuck']);
});
module.exports = { fixture };
test('never answer expires once at thirty seconds with fixed snapshot before recovery', () => {
  const f = fixture(); const queued = [...f.timers.values()][0].fn;
  f.tick(29999); assert.deepEqual(f.faults, []); f.tick(30000); queued();
  assert.deepEqual(f.faults, ['negotiation-timeout']); assert.deepEqual(f.captures, f.faults);
  const snapshot = f.rtc.getDataChannelWatchdogSnapshot();
  assert.equal(snapshot.phase, 'negotiation'); assert.equal(snapshot.timedOut, true); assert.equal(snapshot.remainingMs, 0);
  assert.equal(Object.keys(snapshot).length, 14); f.now(40000); assert.equal(f.rtc.getDataChannelWatchdogSnapshot(), snapshot);
});
test('late timer cannot let answer install buy a new budget; pending install crossing deadline expires once', async () => {
  for (const pending of [false, true]) {
    const f = fixture(); let resolve;
    if (pending) f.rtc.pc.setRemoteDescription = () => new Promise(r => { resolve = r; });
    const answer = pending ? f.answer({ answer: {} }) : null;
    f.now(30001);
    if (pending) { resolve(); await answer; } else await f.answer({ answer: {} });
    assert.deepEqual(f.faults, ['negotiation-timeout']); f.tick(31000); assert.equal(f.faults.length, 1);
  }
});
test('checking channel extensions are bounded at two and duplicate answers do not reset deadline', async () => {
  const f = fixture(); f.now(100); await f.answer({ answer: {} });
  assert.equal(f.rtc.getDataChannelWatchdogSnapshot().elapsedMs, 0);
  f.rtc.pc.connectionState = 'connecting'; f.rtc.pc.iceConnectionState = 'checking';
  f.now(500); await f.answer({ answer: {} });
  f.tick(10100); assert.equal(f.rtc._dataChannelWatchdog.extensions, 1);
  assert.equal(f.rtc.getDataChannelWatchdogSnapshot().elapsedMs, 10000);
  f.tick(20100); assert.equal(f.rtc._dataChannelWatchdog.extensions, 2);
  f.tick(30100); assert.deepEqual(f.faults, ['dc-stuck']);
  const snapshot = f.rtc.getDataChannelWatchdogSnapshot();
  assert.equal(snapshot.phase, 'channel-open'); assert.equal(snapshot.elapsedMs, 30000);
  assert.equal(snapshot.remainingMs, 0); assert.equal(snapshot.extensions, 2);
});
test('connected or negotiated peer rebuild starts channel deadline immediately', () => {
  for (const mode of ['connected', 'remoteDescription']) {
    const f = fixture(); f.rtc.inputChannel = null;
    if (mode === 'connected') f.rtc.pc.connectionState = mode; else f.rtc.pc.remoteDescription = {};
    f.rtc.createInputChannel(); f.tick(10000); assert.deepEqual(f.faults, ['dc-stuck']);
    assert.equal(f.rtc.getDataChannelWatchdogSnapshot().phase, 'channel-open'); assert.equal(f.captures.length, 1);
  }
});
test('open before answer continuation cancels zero timer and never resurrects it', async () => {
  const f = fixture(); let resolve; f.rtc.pc.setRemoteDescription = () => new Promise(r => { resolve = r; });
  const pending = f.answer({ answer: {} }); f.rtc.inputChannel.readyState = 'open'; f.rtc.inputChannel.onopen();
  assert.equal(f.timers.size, 0); resolve(); await pending; assert.equal(f.timers.size, 0); f.tick(40000); assert.deepEqual(f.faults, []);
});
test('unexpected preconnected close retains finite negotiation or channel deadline', async () => {
  for (const phase of ['negotiation', 'channel-open']) {
    const f = fixture(); if (phase === 'channel-open') { await f.answer({ answer: {} }); f.rtc.pc.iceConnectionState = 'checking'; }
    f.rtc.inputChannel.readyState = 'closed'; f.rtc.inputChannel.onclose();
    assert.equal(f.timers.size, 1); f.tick(phase === 'negotiation' ? 30000 : 10000);
    if (phase === 'channel-open') { f.tick(20000); f.tick(30000); }
    assert.equal(f.faults.length, 1);
  }
});
test('connected close recovery rejects queued callbacks after replacement, manual, superseded or socket change', () => {
  for (const change of ['replacement', 'manualDisconnect', '_superseded', 'socket']) {
    const f = fixture(); f.rtc.pc.connectionState = 'connected'; f.rtc.inputChannel.onclose();
    const old = [...f.timers.values()][0].fn;
    if (change === 'replacement') { f.rtc.inputChannel = null; f.rtc.createInputChannel(); }
    else if (change === 'socket') f.rtc.socket = {}; else f.rtc[change] = true;
    const timer = f.rtc._dcTimeout; old(); assert.deepEqual(f.faults, []); assert.equal(f.rtc._dcTimeout, timer);
  }
  const f = fixture(); f.rtc.pc.connectionState = 'connected'; f.rtc.inputChannel.onclose(); f.tick(3000);
  assert.deepEqual(f.faults, ['dc-closed']);
});
test('stale answer await cannot cancel or arm newer owner or offer epoch', async () => {
  for (const change of ['peer', 'socket', 'attempt', 'sequence', 'epoch', 'cancel']) {
    const f = fixture(); let resolve; f.rtc.pc.setRemoteDescription = () => new Promise(r => { resolve = r; });
    const pending = f.answer({ answer: {} });
    if (change === 'peer') f.rtc.pc = { ...f.rtc.pc };
    if (change === 'socket') f.rtc.socket = {};
    if (change === 'attempt') f.rtc.currentConnectionAttemptId = 'b';
    if (change === 'sequence') f.rtc.connectionAttemptSequence++;
    if (change === 'epoch') f.rtc._offerEpoch++;
    if (change === 'cancel') f.rtc.cancelDataChannelWatchdog();
    resolve(); await pending;
    assert.equal(f.rtc._dataChannelWatchdog?.phase || 'inactive', change === 'cancel' ? 'inactive' : 'negotiation');
    assert.deepEqual(f.faults, []);
  }
});
test('invalid or backwards clock retains finite timer, null timing and no answer extension', async () => {
  for (const bad of [NaN, Infinity, -1]) {
    const f = fixture(); f.now(bad); await f.answer({ answer: {} });
    assert.equal(f.rtc.getDataChannelWatchdogSnapshot().elapsedMs, null);
    assert.equal(f.timers.size, 1); f.tick(30000); assert.deepEqual(f.faults, ['negotiation-timeout']); assert.equal(f.timers.size, 0);
  }
  const f = fixture(); f.now(50); f.rtc.getDataChannelWatchdogSnapshot(); f.now(20); await f.answer({ answer: {} });
  f.tick(30000); assert.deepEqual(f.faults, ['negotiation-timeout']);
});
test('early callbacks only schedule remaining budget and old queued callbacks cannot fault a new owner', () => {
  const f = fixture(); const old = [...f.timers.values()][0].fn; f.now(100); old();
  assert.equal(f.timers.size, 1); assert.equal([...f.timers.values()][0].at, 30000);
  f.rtc.inputChannel = null; f.rtc.createInputChannel(); const timer = f.rtc._dcTimeout; old();
  assert.equal(f.rtc._dcTimeout, timer); assert.equal(f.timers.size, 1); assert.deepEqual(f.faults, []);
});
test('failed remote description retains negotiation deadline without starting channel budget', async () => {
  const f = fixture(); f.rtc.pc.setRemoteDescription = async () => { throw Error('fake failure'); };
  f.now(11000); await f.answer({ answer: {} }); assert.equal(f.rtc._dataChannelWatchdog.phase, 'negotiation');
  f.tick(30000); assert.deepEqual(f.faults, ['negotiation-timeout']);
});
test('diagnostic capture failure cannot stop timeout recovery', () => {
  const f = fixture(); f.context.Diagnostic.autoSendFailure = () => { throw Error('capture unavailable'); };
  f.tick(30000); assert.deepEqual(f.faults, ['negotiation-timeout']);
});
