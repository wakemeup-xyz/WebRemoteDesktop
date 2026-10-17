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

test('engine close copies only complete native websocket metadata', () => {
  const f = observerFixture();
  const envelope = context => ({description:'websocket connection closed',context});
  const secret = () => { throw Error('private-canary read'); };
  for (const [code,wasClean] of [[1000,true],[1006,false],[1005,false],[1015,false],[4999,true]]) {
    const context = Object.create({get code() {return code;},get wasClean() {return wasClean;},get reason() {return secret();}});
    f.engine.emit('close','transport close',envelope(context));
    assert.deepEqual(plain(f.sampler.diagnosticSnapshot().events.at(-1).ws),{code,wasClean});
  }
  const invalid = [undefined,null,{}, {code:1006}, {wasClean:false},
    ...[NaN,Infinity,1000.5,true,'1006',999,5000].map(code => ({code,wasClean:false})),
    {code:1006,wasClean:'false'}, {get code() {return secret();},wasClean:false},
    {code:1006,get wasClean() {return secret();}}];
  for (const context of invalid) {
    f.engine.emit('close','transport close',envelope(context));
    assert.equal('ws' in f.sampler.diagnosticSnapshot().events.at(-1),false);
  }
  for (const details of [undefined,null,{}, {get description() {return secret();}},
    {description:'websocket connection closed',get context() {return secret();}},
    {description:'network connection lost',get context() {return secret();}}]) {
    f.engine.emit('close','transport close',details);
    assert.equal('ws' in f.sampler.diagnosticSnapshot().events.at(-1),false);
  }
  const details = {get description() {return secret();}};
  f.engine.emit('close','ping timeout',details);
  f.socket.emit('disconnect','transport close',envelope({code:1006,wasClean:false}));
  f.manager.emit('close','transport close',envelope({code:1006,wasClean:false}));
  const d = f.sampler.diagnosticSnapshot();
  assert.ok(d.events.filter(e => e.k !== 'ec').every(e => !('ws' in e)));
  assert.equal(d.attribution.cause,'unknown');
  assert.deepEqual(plain(d.attribution.firstDisconnectEvent.ws),{code:1000,wasClean:true});
  assert.doesNotMatch(JSON.stringify(d),/private-canary|description|context|reason/);
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
  f.engine.emit('close','transport close',{description:'websocket connection closed',context:{code:1006,wasClean:false}});
  let d = f.sampler.diagnosticSnapshot();
  assert.deepEqual(plain(d.attribution.firstDisconnectEvent),{t:0,n:7,k:'sd',o:'s1',c:false,r:'transport-close'});
  assert.equal(d.events.find(e => e.k === 'ec').c,false);
  assert.equal(d.events.find(e => e.k === 'ec').r,'transport-close');
  assert.deepEqual(plain(d.events.find(e => e.k === 'ec').ws),{code:1006,wasClean:false});
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

test('websocket metadata stays bounded through ring delta and final', async () => {
  const f = observerFixture();
  const details = {description:'websocket connection closed',context:{code:1006,wasClean:false}};
  for (let i=0;i<1000;i++) f.engine.emit('close','transport close',details);
  const delta = (await f.sampler.sample()).diagnostics;
  const final = f.sampler.finalize();
  assert.equal(delta.events.length,16);
  assert.equal(final.events.length,128);
  assert.ok(delta.events.every(e => e.ws.code === 1006));
  assert.ok(bytes(delta) <=4096);
  assert.ok(bytes(final) <=32768);
  assert.deepEqual(plain(final.attribution.firstDisconnectEvent.ws),{code:1006,wasClean:false});
  assert.equal(final.attribution.cause,'unknown');
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
  const wsEvent = {t:43320000,n:999999999,k:'ec',o:'e64',c:false,r:'transport-close',ws:{code:4999,wasClean:false}};
  assert.ok(bytes(wsEvent) <=192);
  assert.ok(bytes(Array(16).fill(wsEvent)) <=3089);
  assert.ok(bytes(Array(128).fill(wsEvent)) <=24705);
  assert.equal(bytes(Array.from({length:128},() => 'x'.repeat(190))),24705);
  assert.equal(bytes(Array.from({length:16},() => 'x'.repeat(190))),3089);
  const f = observerFixture();
  f.context.WebRTC.socket.connected=false;
  assert.equal(f.sampler.diagnosticSnapshot().attribution.firstDisconnectEvent,null);
  f.sampler.stop();
});

const expectedGateEnums = {
  uiPhase:['idle','signaling','media-pending','connected','media-stalled','disconnected','unknown'],
  desiredMediaState:['active','suspended','unknown'],
  mediaRuntimePhase:['active','suspending','suspended','resuming','unknown'],
  keyboardControllerState:['INACTIVE','READY','BLOCKED','RESET_REQUIRED','unknown'],
  keyboardTransportState:['ready','blocked','reacquire-required','revoked','unknown'],
  surfaceState:['settled','pending','uncertain','unknown'],
  desktopWriteRecoveryState:['none','reacquire-required','reconciled','unknown'],
  recoveryState:['idle','waiting','recovered','failed','unknown'],
};
const expectedGateReasons = ['no-active-control','inactive','viewport-unsupported','manual-disconnect',
  'media-not-ready-for-attempt','media-gate',
  ...['active','suspending','suspended','resuming','unknown'].map(v => `runtime-phase:${v}`),
  ...['active','suspended','unknown'].map(v => `media-state:${v}`),
  'keyboard-transport-blocked','keyboard-transport-reacquire-required','keyboard-transport-revoked',
  'keyboard-reset-pending','keyboard-blocked','surface-pending','surface-uncertain','mouse-reset-pending',
  'desktop-write-reacquire-required','draft-composing','draft-pending','draft-uncertain',
  'recovery-waiting','recovery-failed','unknown'];
const expectedGateBooleans = ['allowed','inputActive','hasInputLease','viewportSupported','hasPaintedFrame',
  'currentAttemptReady','hasActiveControl','socketConnected','manualDisconnect','superseded',
  'mouseResetPending','draftComposing','draftPending','draftUncertain','firstFrameTimerHandlePresent'];
function gateFixture() {
  const f = fixture(async () => new Map());
  const controller = {state:'READY', private:'secret-controller-canary'};
  const transport = {state:'ready',private:'secret-transport-canary'};
  const draft = {composing:false,hasPending:false,deliveryUncertain:false,
    get text() { throw Error('secret draft inspected'); },get length() { throw Error('draft length inspected'); }};
  const effective = {allowed:false,blockedReasons:['inactive']};
  let reads = 0;
  Object.assign(f.context.Input, {isActive:false,activeControlLease:{private:'secret-lease'},
    _viewportInputSupported:true,_pendingMouseReset:null,_mobileSurfaceState:'settled',
    _desktopWriteRecovery:null,_recoveryCycle:{state:'idle'},
    keyboardController:{getSnapshot:() => controller},keyboardTransport:{getSnapshot:() => transport},
    mobileTextInputAdapter:{getSnapshot:() => draft},getEffectiveInputGate:() => {reads++;return effective;}});
  Object.assign(f.context.WebRTC,{uiPhase:'disconnected',hasPaintedFrame:true,manualDisconnect:false,
    _superseded:false,hasActiveControl:() => true,currentConnectionAttemptId:'secret-attempt',
    _mediaReadyConnectionAttemptId:'secret-attempt',_firstFrameTimer:37,
    mediaActivityRuntime:{phase:'active',snapshot:() => ({desiredState:'active',private:'secret-runtime'})}});
  return {...f,controller,transport,draft,effective,reads:() => reads};
}

test('emitted row uses actual effective verdict once, preserving disconnected painted ready factors', async () => {
  const f = gateFixture();
  const sample = await f.sampler.sample(), gate = sample.inputGate;
  assert.equal(f.reads(),1);
  assert.equal(sample.inputAllowed,false);
  assert.equal(gate.allowed,false);
  assert.deepEqual(plain(gate.blockedReasons),['inactive']);
  assert.equal(gate.uiPhase,'disconnected');
  for (const key of ['hasPaintedFrame','currentAttemptReady','hasActiveControl','socketConnected','hasInputLease']) assert.equal(gate[key],true);
  assert.deepEqual(Object.keys(gate).sort(),['status','blockedReasons',...expectedGateBooleans,...Object.keys(expectedGateEnums)].sort());
  assert.ok(bytes(gate) <=4096);
  assert.doesNotMatch(JSON.stringify(sample),/secret-|text|private.*runtime/);
  f.effective.allowed = true;
  assert.equal((await f.sampler.sample()).inputAllowed,true);
  assert.equal(f.reads(),2);
  f.sampler.stop();
});

test('all gate reasons are closed unique bounded enums in actual emitted rows', async () => {
  const f = gateFixture();
  for (const reason of expectedGateReasons) {
    f.effective.blockedReasons = [reason,reason,'secret-reason-canary',{},null];
    const gate = (await f.sampler.sample()).inputGate;
    assert.deepEqual(plain(gate.blockedReasons),reason === 'unknown' ? ['unknown']:[reason,'unknown']);
    assert.ok(bytes(gate) <=4096);
  }
  for (const reasons of [null,{},Array(33).fill('secret-reason-canary')]) {
    f.effective.blockedReasons = reasons;
    assert.deepEqual(plain((await f.sampler.sample()).inputGate.blockedReasons),['unknown']);
  }
  f.effective.blockedReasons = expectedGateReasons;
  const sample = await f.sampler.sample();
  assert.equal(sample.inputGate.blockedReasons.length,expectedGateReasons.length);
  assert.ok(bytes(sample) <=32768);
  assert.doesNotMatch(JSON.stringify(sample),/secret-/);
  f.sampler.stop();
});

test('each gate enum maps exact states and unknown canaries without arbitrary snapshot export', async () => {
  const f = gateFixture(), c = f.context.WebRTC, input = f.context.Input;
  const assign = {
    uiPhase:v => c.uiPhase=v, desiredMediaState:v => c.mediaActivityRuntime.snapshot=() => ({desiredState:v}),
    mediaRuntimePhase:v => c.mediaActivityRuntime.phase=v,keyboardControllerState:v => f.controller.state=v,
    keyboardTransportState:v => f.transport.state=v,surfaceState:v => input._mobileSurfaceState=v,
    desktopWriteRecoveryState:v => input._desktopWriteRecovery=v === 'none' ? null:{state:v},
    recoveryState:v => input._recoveryCycle.state=v,
  };
  for (const [key,values] of Object.entries(expectedGateEnums)) for (const value of [...values,'secret-enum-canary',{},null]) {
    assign[key](value);
    const gate = (await f.sampler.sample()).inputGate;
    assert.equal(gate[key],values.includes(value) ? value:'unknown',key);
    assert.doesNotMatch(JSON.stringify(gate),/secret-/);
  }
  f.sampler.stop();
});

test('gate booleans distinguish true false and unknown; timer only reports own handle presence', async () => {
  const f = gateFixture(), c = f.context.WebRTC, input = f.context.Input;
  const assign = {
    allowed:v => f.effective.allowed=v,inputActive:v => input.isActive=v,
    hasInputLease:v => input.activeControlLease=v,viewportSupported:v => input._viewportInputSupported=v,
    hasPaintedFrame:v => c.hasPaintedFrame=v,hasActiveControl:v => c.hasActiveControl=() => v,
    socketConnected:v => c.socket.connected=v,manualDisconnect:v => c.manualDisconnect=v,superseded:v => c._superseded=v,
    mouseResetPending:v => input._pendingMouseReset=v,draftComposing:v => f.draft.composing=v,
    draftPending:v => f.draft.hasPending=v,draftUncertain:v => f.draft.deliveryUncertain=v,
  };
  for (const [key,set] of Object.entries(assign)) for (const value of [true,false]) {
    set(value);assert.equal((await f.sampler.sample()).inputGate[key],value,key);
  }
  c._mediaReadyConnectionAttemptId='other-secret-attempt';
  assert.equal((await f.sampler.sample()).inputGate.currentAttemptReady,false);
  c._firstFrameTimer = null;
  assert.equal((await f.sampler.sample()).inputGate.firstFrameTimerHandlePresent,false);
  delete c._firstFrameTimer;
  assert.equal((await f.sampler.sample()).inputGate.firstFrameTimerHandlePresent,null);
  f.context.Input = {getEffectiveInputGate:() => ({allowed:null,blockedReasons:[]})};
  const gate = (await f.sampler.sample()).inputGate;
  for (const key of ['allowed','inputActive','hasInputLease','viewportSupported','mouseResetPending','draftComposing','draftPending','draftUncertain']) assert.equal(gate[key],null,key);
  delete f.context.Input;
  const missing = (await f.sampler.sample()).inputGate;
  assert.equal(missing.status,'unavailable');
  for (const key of expectedGateBooleans) assert.equal(missing[key],null,key);
  f.sampler.stop();
});

for (const field of ['client','pc','socket','input','build','connectionAttemptId','generation','leaseEpoch']) {
  test(`gate ${field} ownership is fenced across stats and snapshot getters`, async () => {
    for (const duringGetter of [false,true]) {
      let finish;
      const f = gateFixture(), c=f.context.WebRTC;
      const scope = {connectionAttemptId:'secret-attempt',generation:1,leaseEpoch:2};
      c.latencyScope=() => scope;
      const change = () => {
        if (field === 'client') f.context.WebRTC={...c};
        else if (field === 'pc') c.pc={};
        else if (field === 'socket') c.socket={connected:true};
        else if (field === 'input') f.context.Input={...f.context.Input};
        else if (field === 'build') f.context.window.__WRD_BUILD__={id:'release-b'};
        else scope[field] = field === 'connectionAttemptId' ? 'other-secret-attempt':4;
      };
      if (duringGetter) f.context.Input.keyboardController.getSnapshot=() => {change();return f.controller;};
      else c.pc.getStats=() => new Promise(resolve => {finish=resolve;});
      const pending = f.sampler.sample();
      if (!duringGetter) {await Promise.resolve();change();finish(new Map());}
      const sample = await pending;
      assert.equal(sample.scopeStable,false);
      assert.equal(sample.transport.status,'scope-changed');
      assert.equal(sample.inputGate.status,'scope-changed');
      assert.equal(sample.inputAllowed,false);
      assert.deepEqual(plain(sample.inputGate.blockedReasons),[]);
      for (const key of expectedGateBooleans) assert.equal(sample.inputGate[key],null,key);
      f.sampler.stop();
    }
  });
}

test('throwing getters do not export partial factors or fail sample control flow', async () => {
  const f=gateFixture();
  f.context.Input.keyboardController.getSnapshot=() => {throw Error('secret-error');};
  const gate=(await f.sampler.sample()).inputGate;
  assert.equal(gate.status,'unavailable');
  assert.deepEqual(plain(gate.blockedReasons),[]);
  assert.doesNotMatch(JSON.stringify(gate),/secret-/);
  f.sampler.stop();
});

test('emitted startup marks retain first original valid time only with fixed keys and no details', async () => {
  const f=gateFixture();
  f.context.StartupTelemetry={snapshot:() => ({marks:[
    {name:'start-click',atMs:12.5,get detail(){throw Error('secret detail read');}},
    {name:'start-click',atMs:99}, {name:'first-frame',atMs:8009}, {name:'active',atMs:8009},
    {name:'bootstrap-ready',atMs:Infinity},{name:'bootstrap-ready',atMs:45},
    {name:'signal-connected',atMs:-1},{name:'secret-name',atMs:22,detail:'secret-detail'},
  ],get resources(){throw Error('secret resources read');},build:{id:'secret-build'}})};
  const sample=await f.sampler.sample();
  assert.deepEqual(plain(sample.startupMarks),{'start-click':12.5,'bootstrap-start':null,
    'bootstrap-ready':45,'bootstrap-degraded':null,'signal-connected':null,'first-frame':8009,'active':8009});
  assert.equal(sample.inputAllowed,false);
  const capture=f.sampler.evidenceSnapshot();
  assert.equal(capture.browserNowMs,500);
  assert.deepEqual(plain(capture.startupMarks),plain(sample.startupMarks));
  assert.doesNotMatch(JSON.stringify(capture),/secret-/);
  delete f.context.StartupTelemetry;
  assert.ok(Object.values((await f.sampler.sample()).startupMarks).every(v => v === null));
  f.context.StartupTelemetry={snapshot:() => {f.context.Input={};return {marks:[]};}};
  assert.equal(f.sampler.evidenceSnapshot().inputGate.status,'scope-changed');
  f.sampler.stop();
});
