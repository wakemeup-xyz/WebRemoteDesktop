const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(getStats) {
  const callbacks = new Map();
  let seq = 0;
  const video = { videoWidth: 1280, videoHeight: 720,
    requestVideoFrameCallback: cb => { callbacks.set(++seq, cb); return seq; },
    cancelVideoFrameCallback: id => callbacks.delete(id) };
  const relayListeners = new Map();
  const relayImage = { addEventListener: (name, listener) => relayListeners.set(name, listener),
    removeEventListener: (name, listener) => { if (relayListeners.get(name) === listener) relayListeners.delete(name); } };
  const pc = { connectionState: 'connected', getStats };
  const context = { performance: { now: () => 500 }, setTimeout, clearTimeout, Promise,
    document: { getElementById: id => id === 'remoteVideo' ? video : id === 'relayImage' ? relayImage : null },
    WebRTC: { pc, socket: { connected: true }, latencyScope: () => ({ connectionAttemptId:'private-attempt', generation:1, leaseEpoch:2 }), getMediaAppliedPhase: () => 'active' },
    Input: { getEffectiveInputGate: () => ({ allowed:true }) },
    window: { __WRD_BUILD__: { id:'release-a', builtAt:1 } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'passive_session_sampler.js'), 'utf8'), context);
  return { context, sampler:context.window.__wrdPassiveSampler, callbacks, relayListeners };
}

test('reads actual build and selected candidate without addresses or payload', async () => {
  const stats = new Map([
    ['t', { type:'transport', selectedCandidatePairId:'pair' }],
    ['pair', { localCandidateId:'local', remoteCandidateId:'remote', currentRoundTripTime:.02 }],
    ['local', { candidateType:'relay', protocol:'udp', address:'private-address' }],
    ['remote', { candidateType:'host', address:'other-private-address' }],
    ['in', { type:'inbound-rtp', kind:'video', framesDecoded:100, bytesReceived:1234, codecId:'codec' }],
    ['codec', { mimeType:'video/H264' }],
  ]);
  const { sampler, callbacks } = fixture(async () => stats);
  const sample = await sampler.sample();
  assert.equal(sample.buildId, 'release-a');
  assert.equal(sample.transport.localType, 'relay');
  assert.equal(sample.transport.rttMs, 20);
  assert.equal(sample.transport.codec, 'video/h264');
  assert.doesNotMatch(JSON.stringify(sample), /private-address/);
  assert.equal(callbacks.size, 1);
  sampler.stop();
  assert.equal(callbacks.size, 0);
});

test('an overlapping sample does not launch another hung getStats', async () => {
  let calls = 0, finish;
  const { sampler } = fixture(() => { calls += 1; return new Promise(resolve => { finish = resolve; }); });
  const first = sampler.sample();
  await Promise.resolve();
  const second = await sampler.sample();
  assert.equal(calls, 1);
  assert.equal(second.transport.status, 'pending');
  finish(new Map());
  await first;
  sampler.stop();
});

test('PC changed across stats await cannot publish old transport evidence', async () => {
  let finish;
  const { sampler, context } = fixture(() => new Promise(resolve => { finish = resolve; }));
  const pending = sampler.sample();
  await Promise.resolve();
  context.WebRTC.pc = {};
  finish(new Map());
  assert.equal((await pending).transport.status, 'scope-changed');
  sampler.stop();
});

function selectedStats(pairId = 'private-pair', localId = 'private-local', remoteId = 'private-remote') {
  return new Map([
    ['t', { type:'transport', selectedCandidatePairId:pairId }],
    [pairId, { localCandidateId:localId, remoteCandidateId:remoteId }],
    [localId, { candidateType:'relay', protocol:'udp', relayProtocol:'udp', address:'10.0.0.1', url:'turn:private.invalid' }],
    [remoteId, { candidateType:'host', protocol:'udp', address:'10.0.0.2' }],
  ]);
}

test('selected pair and candidate churn changes opaque run-local path identity', async () => {
  let stats = selectedStats();
  const { sampler } = fixture(async () => stats);
  const first = await sampler.sample();
  assert.match(first.transport.pathIdentity, /^path-\d+$/);
  assert.equal((await sampler.sample()).transport.pathIdentity, first.transport.pathIdentity);
  stats = selectedStats('different-private-pair');
  const second = await sampler.sample();
  assert.notEqual(second.transport.pathIdentity, first.transport.pathIdentity);
  stats = selectedStats('different-private-pair', 'different-private-local');
  const third = await sampler.sample();
  assert.notEqual(third.transport.pathIdentity, second.transport.pathIdentity);
  assert.doesNotMatch(JSON.stringify(third), /private-pair|private-local|private-remote|10\.0\.0\.|turn:/);
  sampler.stop();
});

test('missing selected candidate identity remains unavailable', async () => {
  const stats = selectedStats();
  stats.get('private-pair').remoteCandidateId = null;
  const { sampler } = fixture(async () => stats);
  assert.equal((await sampler.sample()).transport.pathIdentity, null);
  sampler.stop();
});

for (const field of ['connectionAttemptId', 'generation', 'leaseEpoch']) {
  test(`${field} changed across stats await invalidates captured scope`, async () => {
    let finish;
    const { sampler, context } = fixture(() => new Promise(resolve => { finish = resolve; }));
    const scope = { connectionAttemptId:'private-attempt', generation:1, leaseEpoch:2 };
    context.WebRTC.latencyScope = () => scope;
    const pending = sampler.sample();
    await Promise.resolve();
    scope[field] = field === 'connectionAttemptId' ? 'other-attempt' : 3;
    finish(selectedStats());
    const sample = await pending;
    assert.equal(sample.scopeStable, false);
    assert.equal(sample.transport.status, 'scope-changed');
    sampler.stop();
  });
}


test('actual rVFC times retain a long gap even when frame age is fresh', async () => {
  const { sampler, context, callbacks } = fixture(async () => selectedStats());
  let now = 100;
  context.performance.now = () => now;
  await sampler.sample();
  const fire = at => {
    now = at;
    const [id, cb] = callbacks.entries().next().value;
    callbacks.delete(id); cb(at);
  };
  fire(100); fire(5900);
  now = 5910;
  const sample = await sampler.sample();
  assert.equal(sample.callbacks, 2);
  assert.equal(sample.lastFrameAtMs, 5900);
  assert.equal(sample.frameAgeMs, 10);
  assert.equal(sample.maxFrameGapMs, 5800);
  sampler.stop();
});

test('relay load timestamps measure load events and retain gaps without claiming optical presentation', async () => {
  const { sampler, context, relayListeners } = fixture(async () => selectedStats());
  let now = 100;
  context.performance.now = () => now;
  assert.equal((await sampler.sample()).relayLoadAgeMs, null);
  relayListeners.get('load')();
  now = 5900; relayListeners.get('load')();
  now = 5910;
  const sample = await sampler.sample();
  assert.equal(sample.relayLoadCallbacks, 2);
  assert.equal(sample.lastRelayLoadAtMs, 5900);
  assert.equal(sample.relayLoadAgeMs, 10);
  assert.equal(sample.maxRelayLoadGapMs, 5800);
  assert.equal(sample.relayEvidenceKind, 'image-load-event-not-optical-presentation');
  sampler.stop();
  assert.equal(relayListeners.size, 0);
});

test('observer exposes bounded lifecycle snapshot before sampling and survives stop', () => {
  const { sampler } = fixture(async () => new Map());
  assert.equal(typeof sampler.diagnosticSnapshot, 'function');
  const snapshot = sampler.diagnosticSnapshot();
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.attribution.firstDisconnectEvent, null);
  sampler.stop();
  assert.deepEqual(sampler.diagnosticSnapshot(), sampler.diagnosticSnapshot());
});

const { EventEmitter } = require('node:events');
function observerFixture({ beforeInstall } = {}) {
  let now = 1000, wall = 1800000000000, timerId = 0;
  const timers = new Map(), rvfc = new Map();
  class Target extends EventEmitter {
    addEventListener(name,fn) { this.on(name,fn); }
    removeEventListener(name,fn) { this.off(name,fn); }
    fire(name) { this.emit(name, {secret:'private-DOM-canary'}); }
  }
  const makeEngine = () => Object.assign(new EventEmitter(), {transport:{name:'websocket'},id:'private-engine-id'});
  const engine = makeEngine(), manager = Object.assign(new EventEmitter(), {engine});
  const socket = Object.assign(new EventEmitter(),{io:manager,connected:true,id:'private-socket-id'});
  const window = Object.assign(new Target(),{__WRD_BUILD__:{id:'release-a'}});
  const document = Object.assign(new Target(),{visibilityState:'visible',hasFocus:() => true,
    getElementById:() => null});
  const context = {window,document,navigator:{onLine:true},Promise,
    performance:{now:() => now,timeOrigin:1800000000000},Date:{now:() => wall},
    setTimeout:(fn,delay) => {timers.set(++timerId,{fn,at:now+delay}); return timerId;},
    clearTimeout:id => timers.delete(id),
    WebRTC:{socket,pc:null,latencyScope:() => ({}),getMediaAppliedPhase:() => 'active'}};
  beforeInstall?.({socket,manager,engine,context});
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'passive_session_sampler.js'),'utf8'),context);
  return {context,socket,manager,engine,window,document,timers,makeEngine,
    sampler:window.__wrdPassiveSampler,
    advance(ms) { now += ms; }, jumpWall(ms) { wall += ms; },
    fireTimer() { const [id,timer] = timers.entries().next().value; timers.delete(id); timer.fn(); }};
}
const plain = value => JSON.parse(JSON.stringify(value));
const bytes = value => Buffer.byteLength(JSON.stringify(value));

test('own emitter callbacks are stable and product listeners survive sampling and stop', async () => {
  let productCalls = 0;
  const f = observerFixture({beforeInstall:({socket}) => socket.on('connect',() => productCalls++)});
  const count = emitter => emitter.eventNames().reduce((n,key) => n+emitter.listenerCount(key),0);
  const initial = [f.socket,f.manager,f.engine].map(count);
  for (let i=0;i<5;i++) await f.sampler.sample();
  assert.deepEqual([f.socket,f.manager,f.engine].map(count),initial);
  f.socket.emit('connect');
  assert.equal(productCalls,1);
  f.sampler.stop(); f.sampler.stop();
  assert.deepEqual([f.socket,f.manager,f.engine].map(count),[1,0,0]);
  assert.equal(f.timers.size,0);
  assert.equal(f.window.eventNames().length,0);
  assert.equal(f.document.eventNames().length,0);
});

test('typed errors and exact close reasons are fixed and never inspect secrets', () => {
  const f = observerFixture();
  const error = {type:'TransportError',get message() { throw Error('message read'); },
    get data() { throw Error('data read'); },get stack() { throw Error('stack read'); }};
  const description = new Proxy({}, {get() {throw Error('description read');}});
  f.socket.emit('connect_error',error);
  f.manager.emit('reconnect_error',{type:'private-error-type',message:'private-canary'});
  for (const value of ['io server disconnect','io client disconnect','ping timeout','transport close',
    'transport error','parse error','forced close','private-reason',null,{}]) {
    f.socket.emit('disconnect',value,description);
    f.engine.emit('close',value,description);
    f.manager.emit('close',value,description);
  }
  const d = f.sampler.diagnosticSnapshot();
  assert.equal(d.attribution.firstDisconnectEvent.k,'se');
  assert.equal(d.attribution.firstDisconnectEvent.r,'transport-error');
  assert.equal(d.attribution.cause,'unknown');
  assert.deepEqual(plain(d.events.filter(e => e.k === 'sd').map(e => e.r)),
    ['server','client','ping','transport-close','transport-error','parse','forced','unknown','unknown','unknown']);
  assert.equal(d.events.find(e => e.k === 'ec').r,'unknown');
  assert.doesNotMatch(JSON.stringify(d), /private-|message|description|stack|10\.0\.|https?:/);
  f.sampler.stop();
});

test('heartbeat records creation and flush semantics without payload, remote acknowledgement or RTT', () => {
  const f = observerFixture();
  const packet = type => ({type,get data() {throw Error('packet payload read');}});
  for (const type of ['message','open','error','probe']) f.engine.emit('packet',packet(type));
  f.engine.emit('packet',packet('ping'));
  f.advance(5); f.engine.emit('packetCreate',packet('pong'));
  const created = f.sampler.diagnosticSnapshot();
  assert.equal(created.state.pingReceivedAtMs,0);
  assert.equal(created.state.pongCreatedAtMs,5);
  assert.equal(created.state.flushAtMs,null);
  f.advance(5); f.engine.emit('flush'); f.engine.emit('ping'); f.engine.emit('pong');
  const d = f.sampler.diagnosticSnapshot();
  assert.deepEqual(plain(d.events.slice(-5).map(e => e.k)),['rx','tx','ef','ep','eo']);
  assert.equal(d.state.flushAtMs,10);
  assert.doesNotMatch(JSON.stringify(d), /rtt|acknowledg|payload|probe|wire/i);
  f.sampler.stop();
});

test('product replacement during emitter dispatch retains enrolled old reason with false currentness', () => {
  const f = observerFixture({beforeInstall:({socket,engine,context,manager}) => {
    socket.on('disconnect',() => {context.WebRTC.socket = Object.assign(new EventEmitter(),{connected:false,io:manager});});
    engine.on('close',() => {manager.engine = Object.assign(new EventEmitter(),{transport:{name:'polling'}});});
  }});
  f.socket.emit('disconnect','transport close');
  f.engine.emit('close','ping timeout');
  let d = f.sampler.diagnosticSnapshot();
  assert.deepEqual(plain(d.attribution.firstDisconnectEvent),{t:0,n:7,k:'sd',o:'s1',c:false,r:'transport-close'});
  assert.equal(d.events.find(e => e.k === 'ec').c,false);
  assert.equal(d.events.find(e => e.k === 'ec').r,'ping');
  assert.equal(f.socket.listenerCount('disconnect'),1);
  assert.equal(f.engine.listenerCount('close'),1);
  f.context.WebRTC.socket.emit('disconnect','io client disconnect');
  d = f.sampler.diagnosticSnapshot();
  assert.equal(d.events.filter(e => e.k === 'sd').at(-1).o,'s2');
  assert.equal(d.coverage.transport,'polling');
  f.sampler.stop();
});

test('copied callbacks after detach remain labelled but never write after stop', () => {
  const f = observerFixture();
  const old = f.engine.listeners('close')[0];
  f.manager.engine = f.makeEngine();
  f.manager.emit('open');
  assert.equal(f.engine.listenerCount('close'),0);
  old('transport error');
  assert.equal(f.sampler.diagnosticSnapshot().events.at(-1).c,false);
  const stopped = plain(f.sampler.stop());
  old('ping timeout');
  f.manager.engine = f.makeEngine();
  assert.deepEqual(plain(f.sampler.diagnosticSnapshot()),stopped);
});

test('reconnect microtask binds assigned engine and unavailable APIs are harmless', async () => {
  const f = observerFixture();
  f.manager.emit('reconnect_attempt',123456);
  f.manager.engine = f.makeEngine();
  await Promise.resolve();
  f.manager.engine.emit('close','transport close');
  assert.equal(f.sampler.diagnosticSnapshot().events.at(-1).o,'e2');
  f.context.WebRTC.socket = {connected:false};
  assert.doesNotThrow(() => f.sampler.diagnosticSnapshot());
  assert.equal(f.manager.engine.listenerCount('close'),0);
  f.sampler.stop();
});

test('bounded flood, drain cursor gap and first terminal preservation through ring eviction', async () => {
  const f = observerFixture();
  f.socket.emit('disconnect','ping timeout');
  const first = plain(f.sampler.diagnosticSnapshot().attribution.firstDisconnectEvent);
  for (let i=0;i<1000;i++) f.engine.emit('flush');
  const d = f.sampler.diagnosticSnapshot();
  assert.equal(d.events.length,128);
  assert.equal(d.droppedEvents,879);
  assert.deepEqual(plain(d.attribution.firstDisconnectEvent),first);
  const delta = (await f.sampler.sample()).diagnostics;
  assert.equal(delta.events.length,16); assert.equal(delta.gap,879); assert.equal(delta.truncated,true);
  assert.equal(delta.cursor,delta.events.at(-1).n);
  assert.ok(bytes(delta) <=4096); assert.ok(bytes(d.events) <=24705);
  assert.ok(bytes({...plain(d),events:undefined}) <=8063);
  for (let i=0;i<80;i++) {f.manager.engine=f.makeEngine(); f.sampler.diagnosticSnapshot();}
  const capped = f.sampler.diagnosticSnapshot();
  assert.equal(capped.coverage.status,'capacity');
  assert.equal(capped.counters.cap,1);
  assert.equal(f.manager.engine.listenerCount('close'),0);
  f.sampler.stop();
});

test('single scheduler calculates missed intervals arithmetically and ignores wall jumps', () => {
  const f = observerFixture();
  assert.equal(f.timers.size,1);
  f.advance(3600500); f.jumpWall(-90000000); f.fireTimer();
  const d = f.sampler.diagnosticSnapshot();
  assert.equal(d.state.lag.lastMs,3599500);
  assert.equal(d.state.lag.missedIntervals,3599);
  assert.equal(d.state.lag.count,1);
  assert.equal(f.timers.size,1);
  assert.equal(f.timers.values().next().value.at,3602000);
  assert.equal(d.anchors.browserWallEpochMs,1800000000000);
  f.document.visibilityState='private-canary'; f.document.fire('visibilitychange');
  f.context.navigator.onLine=false; f.window.fire('offline'); f.window.fire('blur');
  for (const name of ['pagehide','pageshow']) f.window.fire(name);
  for (const name of ['freeze','resume']) f.document.fire(name);
  const final = f.sampler.finalize();
  assert.equal(final.state.visibility,'unknown'); assert.equal(final.state.online,false); assert.equal(final.state.focus,false);
  assert.equal(final.events.at(-1).k,'preclose');
  assert.doesNotMatch(JSON.stringify(final), /private-canary/);
  assert.equal(f.timers.size,0);
});

test('all compact schema variants remain within exact event and aggregate allocations', () => {
  const kinds = ['sd','mc','ec','se','re','rx','tx','sc','mo','ra','rr','rf','ep','eo','ef','eu','bind',
    'vis','net','focus','hide','show','freeze','resume','preclose','cap'];
  let maximum = 0;
  for (const k of kinds) {
    let variants = [{}];
    if (['sd','mc','ec','se','re'].includes(k)) {
      const reasons = ['se','re'].includes(k) ? ['transport-error','unknown'] : ['server','client','ping','transport-close','transport-error','parse','forced','unknown'];
      const prefix = ['sd','se'].includes(k) ? 's' : ['mc','re'].includes(k) ? 'm':'e';
      variants = reasons.flatMap(r => [true,false].map(c => ({o:prefix+'64',c,r})));
    } else if (['rx','tx'].includes(k)) variants = ['ping','pong','unknown'].flatMap(p => [true,false].map(c => ({o:'e64',c,p})));
    else if (['sc','mo','ra','rr','rf','ep','eo','ef','eu','bind'].includes(k)) variants = [true,false].map(c => ({o:'e64',c}));
    else if (k === 'vis') variants = ['visible','hidden','prerender','unknown'].map(v => ({v}));
    else if (['net','focus'].includes(k)) variants = [true,false,null].map(v => ({v}));
    for (const fields of variants) {
      const event = {t:43320000,n:999999999,k,...fields};
      const size = bytes(event); maximum = Math.max(maximum,size);
      assert.ok(size <=192);
      assert.ok(size <= (['sd','mc','ec','se','re'].includes(k) ? 79 : ['rx','tx'].includes(k) ? 71 : 59));
    }
  }
  assert.equal(maximum,79);
  assert.equal(bytes(Array.from({length:128},() => 'x'.repeat(190))),24705);
  assert.equal(bytes(Array.from({length:16},() => 'x'.repeat(190))),3089);
  const f = observerFixture();
  f.context.WebRTC.socket.connected=false;
  assert.equal(f.sampler.diagnosticSnapshot().attribution.firstDisconnectEvent,null);
  f.sampler.stop();
});
