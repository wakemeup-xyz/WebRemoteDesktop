const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createInputBudget } = require('./input.js');
const KeyboardTransport = require('./keyboard-transport.js');

function fixture() {
  const sent = [], timers = new Map();
  let now = 1000, serial = 0;
  const context = vm.createContext({ console,
    Date: {now: () => now},
    performance: {now: () => now},
    setTimeout: (fn, delay) => { const id = ++serial; timers.set(id, {fn, at:now + delay}); return id; },
    clearTimeout: id => timers.delete(id), requestAnimationFrame: fn => fn(),
    document: {addEventListener() {}},
    WebRTC: {sendInput: data => { sent.push(data); return true; }, connectionAttemptId:'attempt'},
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'input.js'), 'utf8'), context);
  const input = context.Input;
  input.activeControlLease = {leaseId:'lease-000000000001', leaseEpoch:1};
  input.isActive = true;
  input._viewportInputSupported = true;
  input._recordInputGate = input._recordInputTrace = input.recordLatency = () => {};
  input.getEffectiveInputGate = () => ({allowed:true});
  input._currentConnectionAttemptId = () => 'attempt';
  const recoveries = [];
  input._onReliableAckTimeout = record => recoveries.push(record);
  return {input, sent, recoveries, async tick(ms) {now += ms; for (const [id, item] of [...timers]) {
    if (item.at <= now) {timers.delete(id); item.fn();}
  } await Promise.resolve(); }};
}

test('budget reserves once, releases idempotently, and enforces single entry bytes', () => {
  const b = createInputBudget({maxEntries:2, maxBytes:8});
  assert.equal(b.reserve('a', 4), true);
  assert.equal(b.reserve('a', 4), true);
  assert.equal(b.reserve('b', 4), true);
  assert.equal(b.reserve('c', 1), false);
  b.release('a'); b.release('a');
  assert.equal(b.snapshot().pendingBytes, 4);
  assert.equal(b.reserve('c', 4), true);
  assert.equal(createInputBudget().reserve('large', 65537), false);
});

test('real desktop send refuses before sequence, transport and pending grow', () => {
  const h = fixture();
  for (let i=0; i<32; i++) assert.ok(h.input._sendInput('command','showDock',{},`d-${i}`));
  assert.equal(h.input._sendInput('command','showDock',{},'overflow'), null);
  assert.equal(h.input._desktopWriteSequence, 32);
  assert.equal(h.sent.length, 32);
  assert.equal(h.input._desktopWritePending.size, 32);
  assert.equal(h.recoveries.length, 1);
  assert.equal(h.input._sendInput('mouse','reset',{reason:'manual'},'reset-full'), null);
  assert.equal(h.sent.length, 32);
});

test('keyboard and desktop share one budget and reject before numbering', () => {
  const h = fixture();
  const keyboardSent = [];
  const k = KeyboardTransport.create({inputBudget:h.input._getInputBudget(),
    makeInputId: () => `k-${keyboardSent.length}`, sendSocket: data => {keyboardSent.push(data); return true;},
    getConnectionAttemptId: () => 'attempt', setTimeoutFn: () => 1, clearTimeoutFn() {},
  });
  k.setLease(h.input.activeControlLease);
  for (let i=0;i<16;i++) assert.ok(h.input._sendInput('command','showDock',{},`d-${i}`));
  for (let i=0;i<16;i++) assert.ok(k.send({action:'text',payload:{text:'x'}}));
  assert.equal(k.send({action:'text',payload:{text:'overflow'}}), null);
  assert.equal(k.getSnapshot().lastSent, 16);
  assert.equal(keyboardSent.length + h.sent.length, 32);
  assert.equal(h.input._getInputBudget().snapshot().pendingCount,32);
});

test('100 wheel events merge before one sequence, subsequent flush waits 16ms', async () => {
  const h=fixture();
  for(let i=0;i<100;i++) h.input.queueWheel({relX:0.5,relY:0.5,deltaX:1,deltaY:2});
  await Promise.resolve();
  assert.equal(h.sent.length,1);
  assert.equal(h.sent[0].payload.deltaY,200);
  h.input.queueWheel({relX:0.5,relY:0.5,deltaX:1,deltaY:2});
  await Promise.resolve();
  await h.tick(15);
  assert.equal(h.sent.length,1);
  await h.tick(1);
  assert.equal(h.sent.length,2);
});

test('byte budget and oversized first write never consume a sequence', () => {
  const h=fixture();
  assert.equal(h.input._sendInput('command','showDock',{text:'x'.repeat(65536)},'large'),null);
  assert.equal(h.input._desktopWriteSequence,0);
  assert.equal(h.sent.length,0);
  assert.equal(h.input._getInputBudget().snapshot().pendingCount,0);
  assert.equal(h.recoveries[0].dataChannel, undefined);
  h.input._getInputBudget().reserve('other-1',65536);
  h.input._getInputBudget().reserve('other-2',65536);
  assert.equal(h.input._sendInput('command','showDock',{},'no-bytes'),null);
  assert.equal(h.sent.length,0);
});

test('desktop ACK releases capacity and Host resync delegates recovery without rewinding', () => {
  const h=fixture();
  h.input._sendInput('command','showDock',{},'one');
  h.input._sendInput('command','showDock',{},'two');
  h.input._acceptDesktopWriteAck({status:'applied',leaseEpoch:1,appliedSeq:1},['one']);
  assert.equal(h.input._getInputBudget().snapshot().pendingCount,1);
  h.input._acceptDesktopWriteAck({status:'resync-required',leaseEpoch:1,appliedSeq:0},['two']);
  assert.equal(h.recoveries.length,1);
  assert.equal(h.input._desktopWriteSequence,2);
});

test('keyboard reset retains old reservations until its owned applied ACK', () => {
  const budget=createInputBudget(); const sent=[];
  const k=KeyboardTransport.create({inputBudget:budget,makeInputId:()=>`k-${sent.length}`,
    sendSocket:data=>{sent.push(data);return true;},setTimeoutFn:()=>1,clearTimeoutFn(){}});
  k.setLease({leaseId:'lease-000000000001',leaseEpoch:1});
  k.send({action:'text',payload:{text:'old'}});
  k.resetBarrier('manual');
  assert.equal(budget.snapshot().pendingCount,2);
  k.acceptAck({schemaVersion:2,leaseEpoch:1,inputIds:sent[0].inputIds,appliedSeq:2,status:'applied'});
  assert.equal(budget.snapshot().pendingCount,2);
  k.acceptAck({schemaVersion:2,leaseEpoch:1,inputIds:sent[1].inputIds,appliedSeq:2,status:'applied'});
  assert.equal(budget.snapshot().pendingCount,0);
});

test('pending wheel from an old control scope cannot flush into the next scope', async () => {
  const h=fixture();
  h.input.queueWheel({relX:0.5,relY:0.5,deltaX:1,deltaY:2});
  h.input._pointerLifecycleGeneration += 1;
  await Promise.resolve();
  assert.equal(h.sent.length,0);
});

test('failed reset keeps shared reservations until actual new lease', () => {
  const budget=createInputBudget(); const sent=[];
  const k=KeyboardTransport.create({inputBudget:budget,makeInputId:()=>`k-${sent.length}`,
    sendSocket:data=>{sent.push(data);return true;},setTimeoutFn:()=>1,clearTimeoutFn(){}});
  k.setLease({leaseId:'lease-000000000001',leaseEpoch:1});
  k.send({action:'text',payload:{text:'uncertain'}});
  k.resetBarrier('manual');
  k.acceptAck({schemaVersion:2,leaseEpoch:1,inputIds:sent[1].inputIds,appliedSeq:0,status:'execution-failed'});
  assert.equal(k.getSnapshot().state,'reacquire-required');
  assert.equal(budget.snapshot().pendingCount,2);
  k.setLease({leaseId:'lease-000000000002',leaseEpoch:2});
  assert.equal(budget.snapshot().pendingCount,0);
});

test('same-lease pointer cancellation drops the old wheel and permits a fresh wheel', async () => {
  const h=fixture();
  h.input.queueWheel({relX:0.5,relY:0.5,deltaX:0,deltaY:1});
  h.input.releasePointer('pointer-cancel');
  await Promise.resolve();
  assert.equal(h.input._wheelScheduled,false);
  assert.equal(h.input._pendingWheel,null);
  h.input.queueWheel({relX:0.5,relY:0.5,deltaX:0,deltaY:2});
  await Promise.resolve();
  assert.equal(h.sent.length,1);
  assert.equal(h.sent[0].payload.deltaY,2);
});

test('an old wheel callback cannot clear a newer lifecycle schedule', async () => {
  const h=fixture();
  h.input.queueWheel({relX:0.5,relY:0.5,deltaX:0,deltaY:1});
  h.input.releasePointer('pointer-cancel');
  h.input.queueWheel({relX:0.5,relY:0.5,deltaX:0,deltaY:2});
  await Promise.resolve();
  assert.equal(h.sent.length,1);
  assert.equal(h.sent[0].payload.deltaY,2);
});

test('pointer cancellation clears an owned 16ms wheel timer without losing the new slot', async () => {
  const h=fixture();
  h.input.queueWheel({relX:0.5,relY:0.5,deltaX:0,deltaY:1});
  await Promise.resolve();
  h.input.queueWheel({relX:0.5,relY:0.5,deltaX:0,deltaY:2});
  await Promise.resolve();
  h.input.releasePointer('pointer-cancel');
  h.input.queueWheel({relX:0.5,relY:0.5,deltaX:0,deltaY:3});
  await Promise.resolve();
  await h.tick(16);
  assert.equal(h.sent.length,2);
  assert.equal(h.sent[1].payload.deltaY,3);
  assert.equal(h.input._wheelScheduled,false);
  assert.equal(h.input._wheelTimer,null);
});
