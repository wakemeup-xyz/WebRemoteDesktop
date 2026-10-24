const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function fixture({ errorName = null, socketConnected = true } = {}) {
  const attempts = [], accepted = [], socketInputs = [];
  let sendErrorName = errorName;
  let nextTimer = 0;
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    performance: { now: () => 1000 },
    setTimeout: () => ++nextTimer,
    clearTimeout() {},
    document: { readyState: 'loading', addEventListener() {} },
    localStorage: { getItem: () => null },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'webrtc.js'), 'utf8')
    + '\nglobalThis.__WebRTC = WebRTC;', context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'input.js'), 'utf8'), context);
  const WebRTC = context.__WebRTC;
  const Input = context.Input;
  WebRTC.socket = { id: 'fallback-socket', connected: socketConnected,
    emit(event, payload) { if (event === 'input') socketInputs.push(payload); } };
  WebRTC.inputChannel = { readyState: 'open', bufferedAmount: 0,
    send(serialized) {
      attempts.push(serialized);
      if (sendErrorName) throw new DOMException('Input enqueue rejected', sendErrorName);
      accepted.push(JSON.parse(serialized));
    } };
  WebRTC.currentConnectionAttemptId = 'fallback-attempt';
  Input.activeControlLease = { leaseId: 'fallback-lease', leaseEpoch: 7 };
  Input.isActive = true;
  Input._viewportInputSupported = true;
  Input._recordInputGate = Input._recordInputTrace = Input.recordLatency = () => {};
  Input.getEffectiveInputGate = () => ({ allowed: true, blockedReasons: [] });
  return { Input, WebRTC, attempts, accepted, socketInputs,
    failDataChannel(name) { sendErrorName = name; } };
}

for (const errorName of ['OperationError', 'InvalidStateError']) {
  for (const [type, action, payload] of [
    ['mouse', 'down', { button: 'left', relX: 0.5, relY: 0.5 }],
    ['mouse', 'wheel', { deltaY: 1 }],
    ['command', 'showDock', {}],
  ]) {
    test(`${errorName} from a real DataChannel send uses the existing Socket fallback for ${type}/${action}`, () => {
      const h = fixture({ errorName });
      const id = h.Input.sendInput(type, action, payload);
      assert.ok(id);
      assert.equal(h.attempts.length, 1);
      assert.equal(h.accepted.length, 0);
      assert.equal(h.socketInputs.length, 1);
      assert.equal(h.socketInputs[0].inputIds[0], id);
      assert.equal(h.socketInputs[0].seq, 1);
      assert.equal(h.Input._desktopWriteSequence, 1);
      assert.equal(h.Input._desktopWritePending.get(id).transport, 'socket');
      assert.equal(h.Input._getInputBudget().snapshot().pendingCount, 1);
    });
  }

  test(`${errorName} while releasing a pressed mouse button still uses Socket after deactivation`, () => {
    const h = fixture();
    const downId = h.Input.sendInput('mouse', 'down', { button: 'left' });
    assert.ok(downId);
    h.failDataChannel(errorName);
    h.Input.isActive = false;
    const upId = h.Input.sendInput('mouse', 'up', { button: 'left' });
    assert.ok(upId);
    assert.equal(h.accepted.length, 1);
    assert.equal(h.socketInputs.length, 1);
    assert.equal(h.socketInputs[0].action, 'up');
    assert.equal(h.socketInputs[0].seq, 2);
    assert.equal(h.Input._desktopWritePending.get(upId).transport, 'socket');
  });

  test(`${errorName} with no connected Socket fails closed without a sequence or reservation`, () => {
    const h = fixture({ errorName, socketConnected: false });
    assert.equal(h.Input.sendInput('mouse', 'down', { button: 'left' }), null);
    assert.equal(h.attempts.length, 1);
    assert.equal(h.accepted.length, 0);
    assert.equal(h.socketInputs.length, 0);
    assert.equal(h.Input._desktopWriteSequence, 0);
    assert.equal(h.Input._desktopWritePending.size, 0);
    assert.equal(h.Input._getInputBudget().snapshot().pendingCount, 0);
  });
}

test('a successful DataChannel enqueue commits once without a Socket duplicate', () => {
  const h = fixture();
  const id = h.Input.sendInput('mouse', 'down', { button: 'left' });
  assert.ok(id);
  assert.equal(h.attempts.length, 1);
  assert.equal(h.accepted.length, 1);
  assert.equal(h.socketInputs.length, 0);
  assert.equal(h.Input._desktopWriteSequence, 1);
  assert.equal(h.Input._desktopWritePending.get(id).transport, 'datachannel');
});

test('a mouse reset still bypasses an apparently open DataChannel for the connected Socket', () => {
  const h = fixture({ errorName: 'OperationError' });
  h.Input.isActive = false;
  const id = h.Input.sendInput('mouse', 'reset', { reason: 'manual' });
  assert.ok(id);
  assert.equal(h.attempts.length, 0);
  assert.equal(h.socketInputs.length, 1);
  assert.equal(h.socketInputs[0].action, 'reset');
  assert.equal(h.Input._desktopWritePending.get(id).transport, 'socket');
});

test('serialization failures remain visible before any DataChannel enqueue or Socket fallback', () => {
  const h = fixture();
  const circular = {};
  circular.self = circular;
  assert.throws(() => h.WebRTC.sendInput({ type: 'mouse', action: 'down', payload: circular }),
    error => error.name === 'TypeError');
  const serializationError = new Error('serialization failure');
  assert.throws(() => h.WebRTC.sendInput({ type: 'mouse', action: 'down',
    payload: { toJSON() { throw serializationError; } } }), error => error === serializationError);
  assert.equal(h.attempts.length, 0);
  assert.equal(h.socketInputs.length, 0);
});
