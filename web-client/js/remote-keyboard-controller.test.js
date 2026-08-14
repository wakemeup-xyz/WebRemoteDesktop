const assert = require('node:assert/strict');
const test = require('node:test');

const { RemoteKeyboardController } = require('./remote-keyboard-controller.js');
const KeyboardTransport = require('./keyboard-transport.js');

function makeController(options = {}) {
  const sent = [];
  let ready = options.ready !== false;
  let time = 0;
  const transport = {
    setLease() {},
    send(item) {
      sent.push(item);
      const shouldFail = typeof options.failAction === 'function'
        ? options.failAction(item, sent)
        : options.failAction === item.action;
      return shouldFail ? null : { accepted: true, seq: sent.length, adapter: 'datachannel' };
    },
    resetBarrier(reason) {
      sent.push({ type: 'keyboard', action: 'reset', payload: { reason } });
      ready = false;
      return { accepted: true, seq: sent.length };
    },
    acceptAck(ack) {
      if (ack && ack.status === 'applied') ready = true;
      return { status: ack && ack.status };
    },
    canSendNewInput() { return ready; },
    getSnapshot() { return { state: ready ? 'ready' : 'blocked', pendingCount: 0 }; },
  };
  const controller = RemoteKeyboardController.create({
    transport,
    mode: options.mode || 'mac',
    now: () => time,
  });
  controller.setLease({ leaseId: 'lease-000000000001', leaseEpoch: 1 });
  return {
    controller,
    sent,
    acceptAck(ack) { return transport.acceptAck(ack); },
    setReady(value) { ready = value; },
    advance(ms) { time += ms; },
  };
}

function keyEvent(type, overrides = {}) {
  return {
    type,
    code: 'KeyA',
    key: 'a',
    location: 0,
    repeat: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
    target: { tagName: 'DIV', isContentEditable: false, closest: () => null },
    getModifierState: () => false,
    preventDefault() {},
    ...overrides,
  };
}

function modalInputTarget() {
  return {
    tagName: 'INPUT',
    isContentEditable: false,
    closest: (selector) => (selector === '.modal' ? {} : null),
  };
}

function keyActions(sent) {
  return sent.filter((item) => item.action === 'key');
}

function makeControllerTransportIntegration() {
  const dataChannel = [];
  const socket = [];
  let nextId = 0;
  const transport = KeyboardTransport.create({
    sendDataChannel(payload) { dataChannel.push(payload); return true; },
    sendSocket(payload) { socket.push(payload); return true; },
    makeInputId: () => `controller-${++nextId}`,
  });
  const controller = RemoteKeyboardController.create({ transport });
  controller.setLease({ leaseId: 'lease-000000000001', leaseEpoch: 1 });
  return { controller, transport, dataChannel, socket };
}

test('tracked keyup releases before modal ignore rules and leaves no pressed state', () => {
  const { controller, sent } = makeController();
  controller.handleDomEvent(keyEvent('keydown', { code: 'ShiftLeft', key: 'Shift', shiftKey: true }));
  controller.handleDomEvent(keyEvent('keyup', {
    code: 'ShiftLeft',
    key: 'Shift',
    target: modalInputTarget(),
  }));

  assert.deepEqual(keyActions(sent).map((item) => [item.payload.phase, item.payload.code]), [
    ['down', 'ShiftLeft'],
    ['up', 'ShiftLeft'],
  ]);
  assert.equal(controller.getSnapshot().pressedKeyCount, 0);
});

test('windows ControlRight maps once to MetaRight for down, suppressed modifier repeat, and up', () => {
  const { controller, sent } = makeController({ mode: 'windows' });
  controller.handleDomEvent(keyEvent('keydown', {
    code: 'ControlRight', key: 'Control', location: 2, ctrlKey: true,
  }));
  assert.equal(controller.handleDomEvent(keyEvent('keydown', {
    code: 'ControlRight', key: 'Control', location: 2, ctrlKey: true, repeat: true,
  })), false);
  controller.handleDomEvent(keyEvent('keyup', { code: 'ControlRight', key: 'Control', location: 2 }));

  assert.deepEqual(keyActions(sent).map((item) => [item.payload.phase, item.payload.code, item.payload.repeat]), [
    ['down', 'MetaRight', false], ['up', 'MetaRight', false],
  ]);
  assert.deepEqual(keyActions(sent)[0].payload.modifiers, {
    altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
  });
  assert.deepEqual(keyActions(sent)[1].payload.modifiers, {
    altKey: false, ctrlKey: false, metaKey: true, shiftKey: false,
  });
});

test('Windows ControlRight keydown uses prior modifier state while later keys observe MetaRight', () => {
  const { controller, sent } = makeController({ mode: 'windows' });
  controller.handleDomEvent(keyEvent('keydown', {
    code: 'ControlRight', key: 'Control', location: 2, ctrlKey: true,
  }));
  controller.handleDomEvent(keyEvent('keydown', { code: 'KeyC', key: 'c', ctrlKey: true }));

  assert.deepEqual(keyActions(sent)[0].payload.modifiers, {
    altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
  });
  assert.deepEqual(keyActions(sent)[1].payload.modifiers, {
    altKey: false, ctrlKey: false, metaKey: true, shiftKey: false,
  });
});

test('Mac preserves modifier sides while Windows maps only Control sides to Meta', () => {
  const mac = makeController();
  for (const code of ['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight']) {
    mac.controller.handleDomEvent(keyEvent('keydown', { code, key: code.replace(/(Left|Right)$/, '') }));
    mac.controller.handleDomEvent(keyEvent('keyup', { code, key: code.replace(/(Left|Right)$/, '') }));
  }
  assert.deepEqual(keyActions(mac.sent).map((item) => item.payload.code), [
    'ControlLeft', 'ControlLeft', 'ControlRight', 'ControlRight', 'ShiftLeft', 'ShiftLeft', 'ShiftRight', 'ShiftRight',
    'AltLeft', 'AltLeft', 'AltRight', 'AltRight', 'MetaLeft', 'MetaLeft', 'MetaRight', 'MetaRight',
  ]);

  const windows = makeController({ mode: 'windows' });
  for (const code of ['ControlLeft', 'ControlRight', 'ShiftRight', 'AltRight', 'MetaRight']) {
    windows.controller.handleDomEvent(keyEvent('keydown', { code, key: code.replace(/(Left|Right)$/, ''), ctrlKey: code.startsWith('Control') }));
    windows.controller.handleDomEvent(keyEvent('keyup', { code, key: code.replace(/(Left|Right)$/, '') }));
  }
  assert.deepEqual(keyActions(windows.sent).map((item) => item.payload.code), [
    'MetaLeft', 'MetaLeft', 'MetaRight', 'MetaRight', 'ShiftRight', 'ShiftRight',
    'AltRight', 'AltRight', 'MetaRight', 'MetaRight',
  ]);
});

test('windows shortcut mapping converts Ctrl C/V/X/Z/A/S/F and modifier combinations to Meta snapshots', () => {
  const keys = ['KeyC', 'KeyV', 'KeyX', 'KeyZ', 'KeyA', 'KeyS', 'KeyF'];
  for (const code of keys) {
    const { controller, sent } = makeController({ mode: 'windows' });
    controller.handleDomEvent(keyEvent('keydown', { code: 'ControlLeft', key: 'Control', ctrlKey: true }));
    controller.handleDomEvent(keyEvent('keydown', { code, key: code.slice(-1).toLowerCase(), ctrlKey: true }));
    const main = keyActions(sent).at(-1).payload;
    assert.deepEqual(main.modifiers, { altKey: false, ctrlKey: false, metaKey: true, shiftKey: false });
  }

  const { controller, sent } = makeController({ mode: 'windows' });
  controller.handleDomEvent(keyEvent('keydown', { code: 'ControlLeft', key: 'Control', ctrlKey: true }));
  controller.handleDomEvent(keyEvent('keydown', { code: 'ShiftLeft', key: 'Shift', ctrlKey: true, shiftKey: true }));
  controller.handleDomEvent(keyEvent('keydown', { code: 'KeyP', key: 'p', ctrlKey: true, shiftKey: true }));
  controller.handleDomEvent(keyEvent('keydown', { code: 'AltLeft', key: 'Alt', ctrlKey: true, altKey: true }));
  controller.handleDomEvent(keyEvent('keydown', { code: 'KeyQ', key: 'q', ctrlKey: true, altKey: true }));
  assert.deepEqual(keyActions(sent).filter((item) => ['KeyP', 'KeyQ'].includes(item.payload.code)).map((item) => item.payload.modifiers), [
    { altKey: false, ctrlKey: false, metaKey: true, shiftKey: true },
    { altKey: true, ctrlKey: false, metaKey: true, shiftKey: false },
  ]);
});

test('duplicate down is ignored while non-modifier repeat is forwarded without duplicating pressed state', () => {
  const { controller, sent } = makeController();
  controller.handleDomEvent(keyEvent('keydown', { code: 'KeyR', key: 'r' }));
  controller.handleDomEvent(keyEvent('keydown', { code: 'KeyR', key: 'r' }));
  controller.handleDomEvent(keyEvent('keydown', { code: 'KeyR', key: 'r', repeat: true }));

  assert.deepEqual(keyActions(sent).map((item) => item.payload.repeat), [false, true]);
  assert.equal(controller.getSnapshot().pressedKeyCount, 1);
  controller.handleDomEvent(keyEvent('keyup', { code: 'KeyU', key: 'u' }));
  assert.equal(keyActions(sent).length, 2);
});

test('controller emits v2 key actions with physical code and exact modifier shape', () => {
  const { controller, sent } = makeController();
  controller.handleDomEvent(keyEvent('keydown', { code: 'KeyQ', key: 'q' }));
  assert.deepEqual(sent[0], {
    type: 'keyboard',
    action: 'key',
    payload: {
      phase: 'down',
      code: 'KeyQ',
      location: 0,
      repeat: false,
      modifiers: { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false },
      locks: { capsLock: false },
    },
  });
});

test('Meta ordinary key uses one batch without releasing the physically held Meta', () => {
  const { controller, sent } = makeController();
  controller.handleDomEvent(keyEvent('keydown', { code: 'MetaLeft', key: 'Meta', metaKey: true }));
  controller.handleDomEvent(keyEvent('keydown', { code: 'KeyC', key: 'c', metaKey: true }));

  assert.equal(sent[1].action, 'batch');
  assert.deepEqual(sent[1].payload.steps.map((step) => [step.phase, step.code]), [
    ['down', 'KeyC'], ['up', 'KeyC'],
  ]);
  assert.equal(controller.getSnapshot().pressedKeyCount, 1);
  controller.handleDomEvent(keyEvent('keyup', { code: 'MetaLeft', key: 'Meta' }));
  assert.deepEqual(keyActions(sent).map((item) => item.payload.code), ['MetaLeft', 'MetaLeft']);
});

test('CapsLock is an atomic tap and Dead physical keys remain physical input', () => {
  const { controller, sent } = makeController();
  controller.handleDomEvent(keyEvent('keydown', {
    code: 'CapsLock', key: 'CapsLock', getModifierState: (name) => name === 'CapsLock',
  }));
  controller.handleDomEvent(keyEvent('keyup', { code: 'CapsLock', key: 'CapsLock' }));
  controller.handleDomEvent(keyEvent('keydown', { code: 'KeyE', key: 'Dead' }));
  controller.handleDomEvent(keyEvent('keyup', { code: 'KeyE', key: 'Dead' }));

  assert.deepEqual(sent[0].payload.steps.map((step) => [step.phase, step.code, step.locks.capsLock]), [
    ['down', 'CapsLock', true], ['up', 'CapsLock', true],
  ]);
  assert.deepEqual(keyActions(sent).map((item) => item.payload.code), ['KeyE', 'KeyE']);
  assert.equal(controller.getSnapshot().pressedKeyCount, 0);
});

test('Windows AltGr retains the real Control press and maps the armed right Alt as AltRight', () => {
  const { controller, sent } = makeController({ mode: 'windows' });
  controller.handleDomEvent(keyEvent('keydown', { code: 'ControlLeft', key: 'Control', ctrlKey: true }));
  controller.handleDomEvent(keyEvent('keydown', {
    code: 'AltRight', key: 'AltGraph', location: 2, ctrlKey: true, altKey: true,
  }));
  controller.handleDomEvent(keyEvent('keyup', { code: 'AltRight', key: 'AltGraph', location: 2 }));

  assert.deepEqual(keyActions(sent).map((item) => [item.payload.phase, item.payload.code]), [
    ['down', 'MetaLeft'], ['down', 'AltRight'], ['up', 'AltRight'],
  ]);
  assert.deepEqual(keyActions(sent)[1].payload.modifiers, {
    altKey: true, ctrlKey: false, metaKey: false, shiftKey: false,
  });
});

test('double Shift mismatch enters a reset barrier instead of guessing a release', () => {
  const { controller, sent } = makeController({ mode: 'windows' });
  controller.handleDomEvent(keyEvent('keydown', { code: 'ShiftLeft', key: 'Shift', shiftKey: true }));
  controller.handleDomEvent(keyEvent('keydown', { code: 'ShiftRight', key: 'Shift', location: 2, shiftKey: true }));
  controller.handleDomEvent(keyEvent('keyup', {
    code: 'ShiftLeft', key: 'Shift', getModifierState: () => false,
  }));

  assert.equal(sent.at(-1).action, 'reset');
  assert.equal(controller.getSnapshot().state, 'RESET_REQUIRED');
});

test('composition text is separate from pressed physical state and requires a ready lease', () => {
  const { controller, sent } = makeController();
  controller.handleDomEvent(keyEvent('keydown', { code: 'KeyI', key: 'Process', isComposing: true }));
  assert.equal(controller.sendText(''), false);
  assert.equal(controller.sendText('\u5df2\u5b8c\u6210\ud83d\ude80'), true);
  controller.handleDomEvent(keyEvent('keydown', { code: 'ShiftLeft', key: 'Shift', shiftKey: true }));
  assert.equal(controller.sendText('blocked'), false);

  assert.deepEqual(sent.map((item) => item.action), ['text', 'key']);
  assert.equal(controller.getSnapshot().pressedKeyCount, 1);
});

test('virtual chord owns only its virtual modifiers and emits one ordered batch', () => {
  const { controller, sent } = makeController();
  controller.handleDomEvent(keyEvent('keydown', { code: 'MetaLeft', key: 'Meta', metaKey: true }));
  assert.equal(controller.sendChord({ code: 'KeyK', modifiers: { ctrl: true, shift: true, meta: true } }), true);

  assert.equal(sent.at(-1).action, 'batch');
  assert.deepEqual(sent.at(-1).payload.steps.map((step) => [step.phase, step.code]), [
    ['down', 'ControlLeft'], ['down', 'ShiftLeft'], ['down', 'KeyK'], ['up', 'KeyK'],
    ['up', 'ShiftLeft'], ['up', 'ControlLeft'],
  ]);
  assert.equal(controller.getSnapshot().pressedKeyCount, 1);
});

test('Windows ControlRight ownership prevents a chord from injecting either Meta side', () => {
  const { controller, sent } = makeController({ mode: 'windows' });
  controller.handleDomEvent(keyEvent('keydown', {
    code: 'ControlRight', key: 'Control', location: 2, ctrlKey: true,
  }));
  assert.equal(controller.sendChord({ code: 'KeyC', modifiers: { ctrl: true } }), true);

  const batch = sent.at(-1);
  assert.equal(batch.action, 'batch');
  assert.deepEqual(batch.payload.steps.map((step) => [step.phase, step.code]), [
    ['down', 'KeyC'], ['up', 'KeyC'],
  ]);
  assert.deepEqual(batch.payload.steps[0].modifiers, {
    altKey: false, ctrlKey: false, metaKey: true, shiftKey: false,
  });
});

test('a ten-second hold remains pressed until real keyup and a failed keyup requires reset', () => {
  const hold = makeController();
  hold.controller.handleDomEvent(keyEvent('keydown', { code: 'ArrowRight', key: 'ArrowRight' }));
  hold.advance(10_000);
  assert.equal(hold.controller.getSnapshot().pressedKeyCount, 1);
  hold.controller.handleDomEvent(keyEvent('keyup', { code: 'ArrowRight', key: 'ArrowRight' }));
  assert.equal(hold.controller.getSnapshot().pressedKeyCount, 0);

  const failed = makeController({ failAction: (item, sent) => item.action === 'key' && sent.length === 2 });
  failed.controller.handleDomEvent(keyEvent('keydown', { code: 'KeyL', key: 'l' }));
  failed.controller.handleDomEvent(keyEvent('keyup', { code: 'KeyL', key: 'l' }));
  assert.equal(failed.controller.getSnapshot().pressedKeyCount, 0);
  assert.equal(failed.sent.at(-1).action, 'reset');
  assert.equal(failed.controller.getSnapshot().state, 'RESET_REQUIRED');
});

test('controller resumes after the transport applies a failed-keyup reset barrier', () => {
  const { controller, sent, acceptAck } = makeController({
    failAction: (item, items) => item.action === 'key' && items.length === 2,
  });
  controller.handleDomEvent(keyEvent('keydown', { code: 'KeyL', key: 'l' }));
  controller.handleDomEvent(keyEvent('keyup', { code: 'KeyL', key: 'l' }));
  assert.equal(controller.getSnapshot().state, 'RESET_REQUIRED');
  assert.equal(sent.at(-1).action, 'reset');

  assert.deepEqual(acceptAck({ status: 'applied' }), { status: 'applied' });
  assert.equal(controller.getSnapshot().state, 'READY');
  assert.equal(controller.handleDomEvent(keyEvent('keydown', { code: 'KeyN', key: 'n' })), true);
});

test('external transport reset clears controller state before accepting the same key again', () => {
  const { controller, transport, socket } = makeControllerTransportIntegration();
  controller.handleDomEvent(keyEvent('keydown', { code: 'KeyR', key: 'r' }));
  assert.equal(controller.getSnapshot().pressedKeyCount, 1);

  transport.markAdapterUnavailable('dataChannel');
  assert.equal(socket.at(-1).action, 'reset');
  assert.equal(controller.getSnapshot().pressedKeyCount, 0);
  assert.equal(controller.getSnapshot().state, 'RESET_REQUIRED');

  transport.acceptAck({ schemaVersion: 2, leaseEpoch: 1, appliedSeq: 2, status: 'applied' });
  assert.equal(controller.getSnapshot().state, 'READY');
  assert.equal(controller.handleDomEvent(keyEvent('keydown', { code: 'KeyR', key: 'r' })), true);
  assert.equal(controller.getSnapshot().pressedKeyCount, 1);
});

test('mode change clears state through a reset barrier before exposing the new mode', () => {
  const { controller, sent, setReady } = makeController();
  controller.handleDomEvent(keyEvent('keydown', { code: 'KeyM', key: 'm' }));
  assert.equal(controller.setMode('windows'), true);
  assert.equal(controller.getSnapshot().mode, 'mac');
  assert.equal(sent.at(-1).action, 'reset');
  setReady(true);
  assert.equal(controller.getSnapshot().mode, 'windows');
  assert.equal(controller.getSnapshot().pressedKeyCount, 0);
  assert.equal(JSON.stringify(controller.getSnapshot()).includes('lease-000000000001'), false);
  assert.equal(JSON.stringify(controller.getSnapshot()).includes('KeyM'), false);
});

test('transport barrier timeout then new lease clears stale resetRequired', () => {
  // Reproduces the "keyboard stuck at RESET_REQUIRED" bug:
  // 1. DC dies → markAdapterUnavailable → sendReset → barrier deadline = now+3000ms
  // 2. 3 seconds pass with no ack → expireBarrier → reacquireRequired=true, leaseId=null
  // 3. syncTransportState notifies controller: state='reacquire-required'
  //    → resetRequired=true, resetBarrierPending=false
  // 4. New lease arrives → setLease(newLease) → transport state='ready'
  //    → syncTransportState('ready') → must clear resetRequired even though
  //      resetBarrierPending=false (old barrier expired, not pending)
  let now = 0;
  const dataChannel = [];
  const socket = [];
  let nextId = 0;
  const transport = KeyboardTransport.create({
    sendDataChannel(payload) { dataChannel.push(payload); return true; },
    sendSocket(payload) { socket.push(payload); return true; },
    makeInputId: () => `kb-${++nextId}`,
    now: () => now,
    ackTimeoutMs: 3000,
  });
  const controller = RemoteKeyboardController.create({ transport });
  controller.setLease({ leaseId: 'lease-001', leaseEpoch: 1 });

  // DC dies → transport sends reset, controller enters RESET_REQUIRED
  transport.markAdapterUnavailable('dataChannel');
  assert.equal(controller.getSnapshot().state, 'RESET_REQUIRED');

  // Barrier timeout: advance past 3000ms deadline without ack
  now = 4000;
  // Trigger expireBarrier by calling state (KeyboardTransport calls it lazily)
  transport.getSnapshot(); // forces expireBarrier; reacquireRequired=true now

  // New lease arrives (new connection established)
  controller.setLease({ leaseId: 'lease-002', leaseEpoch: 2 });

  // MUST be READY — the stale reset context (barrier expired, old lease gone)
  // must not leave the keyboard stuck in RESET_REQUIRED
  assert.equal(
    controller.getSnapshot().state, 'READY',
    'keyboard must recover to READY when transport is ready with a fresh lease'
  );
  assert.equal(
    controller.handleDomEvent(keyEvent('keydown', { code: 'KeyA', key: 'a' })), true,
    'keydown must be accepted after fresh lease with no pending barrier'
  );
});

test('rebinding the same lease after barrier expiry clears RESET_REQUIRED', () => {
  let now = 0;
  const dataChannel = [];
  const socket = [];
  let nextId = 0;
  const transport = KeyboardTransport.create({
    sendDataChannel(payload) { dataChannel.push(payload); return true; },
    sendSocket(payload) { socket.push(payload); return true; },
    makeInputId: () => `kb-${++nextId}`,
    now: () => now,
    ackTimeoutMs: 3000,
  });
  const controller = RemoteKeyboardController.create({ transport });
  const lease = { leaseId: 'lease-001', leaseEpoch: 1 };
  controller.setLease(lease);
  transport.markAdapterUnavailable('dataChannel');
  now = 4000;
  transport.getSnapshot();
  assert.equal(controller.getSnapshot().state, 'RESET_REQUIRED');
  controller.setLease(lease);
  assert.equal(controller.getSnapshot().state, 'READY');
  assert.equal(controller.handleDomEvent(keyEvent('keydown', { code: 'KeyA', key: 'a' })), true);
});

test('park clears local keys without entering RESET_REQUIRED', () => {
  const { controller } = makeController();
  controller.handleDomEvent(keyEvent('keydown', { code: 'KeyA', key: 'a' }));
  controller.park('visibility-hidden');
  assert.equal(controller.getSnapshot().state, 'READY');
  assert.equal(controller.getSnapshot().pressedKeyCount, 0);
});
