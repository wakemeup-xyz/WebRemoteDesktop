const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function makeTarget(extra = {}) {
  const handlers = new Map();
  const classes = new Set();
  const target = {
    handlers,
    style: {},
    dataset: {},
    hidden: false,
    disabled: false,
    isConnected: true,
    value: '',
    selectionStart: 0,
    selectionEnd: 0,
    tagName: 'DIV',
    videoWidth: 800,
    videoHeight: 600,
    classList: {
      add(...names) { names.forEach((name) => classes.add(name)); },
      remove(...names) { names.forEach((name) => classes.delete(name)); },
      contains(name) { return classes.has(name); },
      toggle(name, force) {
        const next = force === undefined ? !classes.has(name) : Boolean(force);
        if (next) classes.add(name);
        else classes.delete(name);
        return next;
      },
    },
    addEventListener(type, handler) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(handler);
    },
    removeEventListener(type, handler) {
      const list = handlers.get(type) || [];
      handlers.set(type, list.filter((item) => item !== handler));
    },
    dispatch(type, fields = {}) {
      const event = { type, target: target, currentTarget: target,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.propagationStopped = true; }, ...fields };
      for (const handler of [...(handlers.get(type) || [])]) handler(event);
      return event;
    },
    focus() { this.ownerDocument.activeElement = this; },
    blur() {
      if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null;
    },
    setAttribute() {},
    removeAttribute() {},
    matches() { return false; },
    closest() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; },
    setPointerCapture() {},
    releasePointerCapture() {},
    hasPointerCapture() { return false; },
    ...extra,
  };
  return target;
}

function loadRecoveryFixture({ touchPoints = 0, channels = 'both', onIncident = () => {} } = {}) {
  let now = 1000;
  let nextTimerId = 0;
  const timers = new Map();
  const sent = [];
  const elements = new Map();
  const documentListeners = new Map();
  const windowListeners = new Map();
  const addListener = (map, type, handler) => {
    if (!map.has(type)) map.set(type, []);
    map.get(type).push(handler);
  };
  const dispatch = (map, type, fields = {}) => {
    const event = { type, target: null, currentTarget: null,
      preventDefault() { this.defaultPrevented = true; }, ...fields };
    for (const handler of [...(map.get(type) || [])]) handler(event);
    return event;
  };
  const video = makeTarget({ tagName: 'VIDEO' });
  const body = makeTarget();
  const document = {
    hidden: false,
    activeElement: null,
    body,
    documentElement: {},
    addEventListener(type, handler) { addListener(documentListeners, type, handler); },
    dispatch(type, fields = {}) { return dispatch(documentListeners, type, fields); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getElementById(id) {
      if (!elements.has(id)) {
        const element = makeTarget({
          ownerDocument: document,
          tagName: id === 'mobileTextInput' ? 'TEXTAREA' : 'BUTTON',
          hidden: id === 'mobileInputDock' || id === 'mobileTextInputBtn',
        });
        elements.set(id, element);
      }
      return elements.get(id);
    },
  };
  video.ownerDocument = document;
  elements.set('remoteVideo', video);
  const window = {
    addEventListener(type, handler) { addListener(windowListeners, type, handler); },
    location: { origin: 'http://offline.invalid' },
    dispatch(type, fields = {}) { return dispatch(windowListeners, type, fields); },
  };
  window.document = document;
  window.window = window;
  class FixtureDate extends Date {
    static now() { return now; }
  }
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    Date: FixtureDate,
    document,
    window,
    navigator: { platform: 'MacIntel', userAgent: 'input-recovery-test', maxTouchPoints: touchPoints },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    performance: { now: () => now },
    getComputedStyle: () => ({ objectFit: 'contain' }),
    requestAnimationFrame: (callback) => callback(),
    setTimeout(callback, delay = 0) {
      const id = ++nextTimerId;
      timers.set(id, { callback, due: now + Number(delay || 0) });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    setInterval() { return ++nextTimerId; },
    clearInterval() {},
  });
  context.globalThis = context;
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'input-trace.js'), 'utf8'), context);
  const trace = context.InputTrace.create({
    now: () => now,
    hashInputIds: null,
    setTimeoutFn: context.setTimeout,
    clearTimeoutFn: context.clearTimeout,
    onIncident,
  });
  context.Diagnostic = {
    recordInputTrace(stage, meta) { return trace.record(stage, meta); },
    getInputTraceSnapshot() { return trace.snapshot(); },
  };
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'input-geometry.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'touch-input-adapter.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'keyboard-transport.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'remote-keyboard-controller.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'mobile-text-input.js'), 'utf8'), context);
  for (const filename of ['media-activity-controller.js', 'media-activity-lifecycle.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, filename), 'utf8'), context);
    const exportName = filename === 'media-activity-controller.js'
      ? 'MediaActivityController' : 'MediaActivityLifecycle';
    context[exportName] = context.window[exportName];
  }
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'media-activity-runtime.js'), 'utf8'), context);
  vm.runInContext(`${fs.readFileSync(path.join(__dirname, 'webrtc.js'), 'utf8')}
globalThis.__WebRTC = WebRTC;`, context);
  vm.runInContext(`${fs.readFileSync(path.join(__dirname, 'input.js'), 'utf8')}
globalThis.__Input = Input;`, context);

  const WebRTC = context.__WebRTC;
  const Input = context.__Input;
  WebRTC.socket = {
    connected: channels !== 'none' && channels !== 'dc',
    emit(event, payload) { sent.push({ event, payload }); },
  };
  WebRTC.inputChannel = channels === 'socket' || channels === 'none'
    ? null
    : { readyState: 'open', bufferedAmount: 0,
      send(json) { sent.push({ event: 'dc', payload: JSON.parse(json) }); } };
  WebRTC.inputMoveChannel = WebRTC.inputChannel;
  WebRTC.controlState = { state: 'ACTIVE', controller: true,
    lease: { leaseId: 'recovery-lease-0001', leaseEpoch: 7 }, hostOnline: true };
  WebRTC.networkMode = 'direct';
  WebRTC.currentConnectionAttemptId = 'recovery-attempt-1';
  WebRTC.connectionAttemptSequence = 1;
  WebRTC._mediaReadyConnectionAttemptId = WebRTC.currentConnectionAttemptId;
  WebRTC.uiPhase = 'connected';
  WebRTC.hasPaintedFrame = true;
  Input.videoElement = video;
  Input.setControlLease(WebRTC.controlState.lease);
  Input.setupEventListeners();
  Input.setupTextInput();
  WebRTC.bindControlLifecycle();
  Input.setActive(true);

  function advance(ms) {
    now += ms;
    let ran = true;
    while (ran) {
      ran = false;
      for (const [id, timer] of [...timers]) {
        if (timer.due <= now) {
          timers.delete(id);
          timer.callback();
          ran = true;
        }
      }
    }
  }
  function ack(payload, overrides = {}) {
    const ackPayload = {
      schemaVersion: 2,
      inputType: payload.type,
      inputIds: payload.inputIds,
      leaseEpoch: payload.leaseEpoch,
      appliedSeq: payload.seq,
      status: 'applied',
      ...overrides,
    };
    if (payload.type === 'keyboard') return Input.acceptKeyboardAck(ackPayload);
    return Input.acceptMouseAck(ackPayload);
  }
  function writes() {
    return sent.filter(({ event, payload }) => (event === 'dc' || event === 'input')
      && ['mouse', 'keyboard'].includes(payload?.type)).map(({ payload }) => payload);
  }
  function pointer(type, fields = {}) {
    return video.dispatch(type, {
      pointerType: 'mouse', pointerId: 1, button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      clientX: 400, clientY: 300, timeStamp: now, ...fields,
    });
  }
  function keydown(fields = {}) {
    return dispatch(documentListeners, 'keydown', {
      target: video, code: 'KeyA', key: 'a', repeat: false, location: 0,
      ctrlKey: false, shiftKey: false, altKey: false, metaKey: false,
      isComposing: false, getModifierState() { return false; }, ...fields,
    });
  }
  function keyup(fields = {}) {
    return dispatch(documentListeners, 'keyup', {
      target: video, code: 'KeyA', key: 'a', repeat: false, location: 0,
      ctrlKey: false, shiftKey: false, altKey: false, metaKey: false,
      isComposing: false, getModifierState() { return false; }, ...fields,
    });
  }
  function blur() { return dispatch(windowListeners, 'blur'); }
  function resume() {
    document.hidden = false;
    window.dispatch('pageshow');
    document.dispatch('visibilitychange');
  }
  function setDataChannelOpen(open) {
    if (WebRTC.inputChannel) WebRTC.inputChannel.readyState = open ? 'open' : 'closed';
  }
  function latestMediaRequest(state) {
    const request = [...sent].reverse().find(({ event, payload }) => (
      event === 'media-activity-change' && payload?.state === state
    ));
    if (!request) return null;
    WebRTC.handleMediaActivityAck({
      state,
      generation: request.payload.generation,
      connectionAttemptId: request.payload.connectionAttemptId,
      applied: true,
    });
    return request.payload;
  }
  function freshFrame() {
    const nextFrame = (Number(WebRTC._videoFrameSeq) || 0) + 1;
    return WebRTC.noteMediaRenderedFrame({
      source: 'video-callback',
      frameSeq: nextFrame,
      connectionAttemptId: WebRTC.currentConnectionAttemptId,
    });
  }
  function suspendAndResume() {
    document.hidden = true;
    document.dispatch('visibilitychange');
    window.dispatch('pagehide');
    const suspended = latestMediaRequest('suspended');
    window.dispatch('pageshow');
    document.hidden = false;
    document.dispatch('visibilitychange');
    const active = latestMediaRequest('active');
    if (active) freshFrame();
    return { suspended, active };
  }

  return {
    Input, WebRTC, document, window, video, elements, sent, timers, documentListeners, windowListeners,
    advance, ack, writes, inputs: writes, pointer, keydown, keyup, blur, resume, trace,
    setDataChannelOpen, latestMediaRequest, freshFrame, suspendAndResume,
    setNow(value) { now = value; },
  };
}

test('recovery fixture records real gate, send, ACK-timeout, and lifecycle decisions', () => {
  const h = loadRecoveryFixture();
  h.pointer('pointerdown');
  h.pointer('pointerup');
  h.advance(3001);

  const snapshot = h.trace.snapshot();
  const stages = new Set(snapshot.events.map(({ stage }) => stage));
  assert.equal(stages.has('dom-received'), true);
  assert.equal(stages.has('gate'), true);
  assert.equal(stages.has('transport-send'), true);
  assert.equal(stages.has('ack-timeout'), true);
  assert.equal(stages.has('lifecycle'), true);
  assert.equal(JSON.stringify(snapshot).includes('recovery-lease-0001'), false);
  assert.equal(JSON.stringify(snapshot).includes('relX'), false);
  assert.equal(JSON.stringify(snapshot).includes('relY'), false);
});

test('repeated unchanged activity callbacks keep one lifecycle observation while state changes remain visible', () => {
  const h = loadRecoveryFixture();
  const lifecycleCount = () => h.trace.snapshot().events.filter(({ stage }) => stage === 'lifecycle').length;
  const before = lifecycleCount();

  h.pointer('pointerdown');
  h.pointer('pointerup');
  h.writes().filter((payload) => payload.type === 'mouse').forEach((payload) => h.ack(payload));
  const domBeforeFrames = h.trace.snapshot().events
    .filter(({ stage }) => stage === 'dom-received').map(({ eventId }) => eventId);
  assert.ok(domBeforeFrames.length >= 2, 'real click must establish DOM history before readiness callbacks');

  h.Input.setActive(true, { reason: 'window-focus' });
  const firstObservation = lifecycleCount();
  h.WebRTC.markMediaAttemptReady('recovery-attempt-1');
  const firstFrameObservation = lifecycleCount();
  for (let index = 0; index < 99; index += 1) h.WebRTC.markMediaAttemptReady('recovery-attempt-1');
  assert.equal(lifecycleCount(), firstFrameObservation, 'unchanged readiness must not flood lifecycle traces');
  assert.equal(h.Input.isActive, true);
  assert.deepEqual(
    h.trace.snapshot().events.filter(({ stage }) => stage === 'dom-received').map(({ eventId }) => eventId),
    domBeforeFrames,
    'readiness callbacks must not evict the prior DOM observations',
  );

  h.Input.setActive(true, { reason: 'resume' });
  assert.equal(lifecycleCount(), firstFrameObservation + 1, 'a changed lifecycle reason remains observable');
  h.WebRTC.currentConnectionAttemptId = 'recovery-attempt-2';
  h.Input.setActive(true, { reason: 'resume' });
  assert.equal(lifecycleCount(), firstFrameObservation + 2, 'a new attempt remains observable');
  h.Input.setActive(false, { reason: 'page-hidden', resetKeyboard: false });
  const parked = lifecycleCount();
  for (let index = 0; index < 30; index += 1) h.Input.setActive(false, { reason: 'page-hidden', resetKeyboard: false });
  assert.equal(lifecycleCount(), parked, 'repeated parked callbacks must also be deduplicated');
  assert.equal(before < firstObservation, true);
});

test('visible controlled gate rejection records an unexpected incident without a business send', () => {
  const incidents = [];
  const h = loadRecoveryFixture({ onIncident: (reason) => incidents.push(reason) });
  const showDock = makeTarget({ dataset: { action: 'showDock' } });
  h.document.querySelectorAll = (selector) => (
    selector === '.action-btn, [data-mobile-action]' ? [showDock] : []
  );
  h.Input.setupActionButtons();
  showDock.dispatch('click');

  const command = h.sent.find(({ payload }) => payload?.type === 'command' && payload.action === 'showDock');
  assert.ok(command);
  h.Input.acceptMouseAck({
    schemaVersion: 2,
    inputType: 'command',
    inputIds: command.payload.inputIds,
    leaseEpoch: command.payload.leaseEpoch,
    appliedSeq: 0,
    status: 'resync-required',
  });

  const before = h.writes().length;
  h.keydown();
  assert.equal(h.writes().length, before, 'blocked physical keydown must not emit a business write');
  assert.deepEqual(incidents, ['input-gate-unexpected']);
});

test('tracked user release ACK loss remains eligible for mouse, physical key, and touch', () => {
  const scenarios = [
    {
      kind: 'mouse-up',
      touchPoints: 0,
      send(h) { h.pointer('pointerdown'); h.pointer('pointerup'); },
      isDown(payload) { return payload.type === 'mouse' && payload.action === 'down'; },
      isRelease(payload) { return payload.type === 'mouse' && payload.action === 'up'; },
      releaseAction: 'up',
    },
    {
      kind: 'key-up',
      touchPoints: 0,
      send(h) { h.keydown(); h.keyup(); },
      isDown(payload) {
        return payload.type === 'keyboard' && payload.action === 'key'
          && payload.payload?.phase === 'down';
      },
      isRelease(payload) {
        return payload.type === 'keyboard' && payload.action === 'key'
          && payload.payload?.phase === 'up';
      },
      releaseAction: 'key',
    },
    {
      kind: 'touch-up',
      touchPoints: 1,
      send(h) {
        h.video.dispatch('pointerdown', {
          pointerType: 'touch', pointerId: 1, isPrimary: true,
          clientX: 400, clientY: 300, buttons: 1,
        });
        h.video.dispatch('pointerup', {
          pointerType: 'touch', pointerId: 1, isPrimary: true,
          clientX: 400, clientY: 300, buttons: 0,
        });
      },
      isDown(payload) {
        return payload.type === 'mouse' && payload.action === 'down';
      },
      isRelease(payload) {
        return payload.type === 'mouse' && payload.action === 'up';
      },
      releaseAction: 'up',
    },
  ];

  for (const scenario of scenarios) {
    const incidents = [];
    const h = loadRecoveryFixture({
      touchPoints: scenario.touchPoints,
      onIncident: (reason, identity) => incidents.push({ reason, identity }),
    });
    scenario.send(h);
    const writes = h.writes().filter((payload) => scenario.isDown(payload) || scenario.isRelease(payload));
    assert.equal(writes.length, 2, scenario.kind);
    const down = writes.find(scenario.isDown);
    const release = writes.find(scenario.isRelease);
    assert.ok(down, scenario.kind);
    assert.ok(release, scenario.kind);
    h.ack(down);

    const beforeTimeout = h.trace.snapshot();
    const releaseDom = beforeTimeout.events.find(({ stage, inputType, action, phase }) => (
      stage === 'dom-received'
      && ((scenario.kind === 'key-up' && inputType === 'keyboard' && action === 'key' && phase === 'up')
        || (scenario.kind !== 'key-up' && inputType === 'pointer' && action === 'up'))
    ));
    const releaseSend = beforeTimeout.events.find(({ stage, inputType, action, phase, accepted }) => (
      stage === 'transport-send' && accepted === true
      && ((scenario.kind === 'key-up' && inputType === 'keyboard' && action === 'key' && phase === 'up')
        || (scenario.kind !== 'key-up' && inputType === 'pointer' && action === 'up'))
    ));
    assert.ok(releaseDom, scenario.kind);
    assert.ok(releaseSend, scenario.kind);
    assert.equal(releaseSend.eventId, releaseDom.eventId, scenario.kind);

    h.advance(3001);
    const snapshot = h.trace.snapshot();
    assert.equal(snapshot.counters.ackTimeoutCount, 1, scenario.kind);
    assert.equal(incidents.length, 1, scenario.kind);
    assert.equal(incidents[0].reason, 'input-ack-timeout', scenario.kind);
    const timeout = snapshot.events.find(({ stage, action }) => stage === 'ack-timeout' && action === scenario.releaseAction);
    assert.ok(timeout, scenario.kind);
    assert.equal(timeout.eventId, releaseDom.eventId, scenario.kind);
  }
});

test('unmatched, cancelled, hidden, local-focus, revoked, paused, and uncertain releases do not incident', () => {
  const cases = [
    {
      name: 'unmatched mouse release',
      run(h) { h.pointer('pointerup'); },
      assertWrites(h) {
        assert.equal(h.writes().filter((payload) => payload.type === 'mouse' && payload.action === 'up').length, 1);
      },
    },
    {
      name: 'cancelled mouse release',
      run(h) {
        h.pointer('pointerdown');
        const down = h.writes().find((payload) => payload.type === 'mouse' && payload.action === 'down');
        h.ack(down);
        h.pointer('pointercancel');
        h.pointer('pointerup');
      },
      assertWrites(h) {
        assert.equal(h.writes().filter((payload) => payload.type === 'mouse' && payload.action === 'reset').length, 1);
        assert.equal(h.writes().filter((payload) => payload.type === 'mouse' && payload.action === 'up').length, 1);
      },
    },
    {
      name: 'no-send mouse release',
      options: { channels: 'none' },
      run(h) { h.pointer('pointerdown'); h.pointer('pointerup'); },
      assertWrites(h) {
        assert.equal(h.writes().filter((payload) => payload.type === 'mouse').length, 0);
      },
    },
    {
      name: 'hidden before deferred touch send',
      options: { touchPoints: 1 },
      run(h) {
        h.video.dispatch('pointerdown', {
          pointerType: 'touch', pointerId: 2, isPrimary: true,
          clientX: 400, clientY: 300, buttons: 1,
        });
        h.document.hidden = true;
        h.advance(550);
      },
    },
    {
      name: 'media gate closes before tracked release',
      run(h) {
        h.pointer('pointerdown');
        const down = h.writes().find((payload) => payload.type === 'mouse' && payload.action === 'down');
        h.ack(down);
        h.WebRTC.getDesktopInputGateSnapshot = () => ({ enabled: false, blockedReasons: ['media-gate'] });
        h.pointer('pointerup');
      },
      assertWrites(h) {
        assert.equal(h.writes().filter((payload) => payload.type === 'mouse' && payload.action === 'up').length, 1);
      },
    },
    {
      name: 'terminal focus release',
      run(h) {
        h.keydown();
        const down = h.writes().find((payload) => payload.type === 'keyboard' && payload.payload?.phase === 'down');
        h.ack(down);
        const terminal = h.document.getElementById('terminalComposer');
        terminal.id = 'terminalComposer';
        h.keyup({ target: terminal });
      },
      assertWrites(h) {
        assert.equal(h.writes().filter((payload) => payload.type === 'keyboard' && payload.payload?.phase === 'up').length, 1);
      },
    },
    {
      name: 'local editor focus release',
      run(h) {
        h.keydown();
        const down = h.writes().find((payload) => payload.type === 'keyboard' && payload.payload?.phase === 'down');
        h.ack(down);
        const editor = h.document.getElementById('remoteTextInput');
        editor.id = 'remoteTextInput';
        h.keyup({ target: editor });
      },
      assertWrites(h) {
        assert.equal(h.writes().filter((payload) => payload.type === 'keyboard' && payload.payload?.phase === 'up').length, 1);
      },
    },
    {
      name: 'revoked lease release',
      run(h) {
        h.pointer('pointerdown');
        const down = h.writes().find((payload) => payload.type === 'mouse' && payload.action === 'down');
        h.ack(down);
        h.Input.setControlLease(null);
        h.pointer('pointerup');
      },
    },
    {
      name: 'manual keyboard pause release',
      run(h) {
        h.keydown();
        const down = h.writes().find((payload) => payload.type === 'keyboard' && payload.payload?.phase === 'down');
        h.ack(down);
        h.Input.parkKeyboard('manual-pause');
        h.keyup();
      },
      assertWrites(h) {
        assert.equal(h.writes().filter((payload) => payload.type === 'keyboard' && payload.payload?.phase === 'up').length, 0);
      },
    },
    {
      name: 'uncertain draft release',
      run(h) {
        h.keydown();
        const down = h.writes().find((payload) => payload.type === 'keyboard' && payload.payload?.phase === 'down');
        h.ack(down);
        h.Input.mobileTextInputAdapter.invalidateContext('visibility-hidden');
        h.keyup();
      },
      assertWrites(h) {
        assert.equal(h.writes().filter((payload) => payload.type === 'keyboard' && payload.payload?.phase === 'up').length, 1);
      },
    },
  ];

  for (const scenario of cases) {
    const incidents = [];
    const h = loadRecoveryFixture({
      ...(scenario.options || {}),
      onIncident: (reason, identity) => incidents.push({ reason, identity }),
    });
    scenario.run(h);
    scenario.assertWrites?.(h);
    h.advance(3001);
    assert.equal(incidents.length, 0, scenario.name);
  }
});

test('touch and IME reliable writes retain bounded attribution for timeout incidents', () => {
  const touchIncidents = [];
  const touch = loadRecoveryFixture({
    touchPoints: 1,
    onIncident: (reason, identity) => touchIncidents.push({ reason, identity }),
  });
  touch.video.dispatch('pointerdown', {
    pointerType: 'touch', pointerId: 1, isPrimary: true,
    clientX: 400, clientY: 300, buttons: 1,
  });
  touch.video.dispatch('pointerup', {
    pointerType: 'touch', pointerId: 1, isPrimary: true,
    clientX: 400, clientY: 300, buttons: 0,
  });
  touch.advance(3001);
  const touchSnapshot = touch.trace.snapshot();
  const touchWrites = touchSnapshot.events.filter(({ stage, inputType, accepted, action }) => (
    stage === 'transport-send' && inputType === 'pointer' && accepted === true
      && ['down', 'up'].includes(action)
  ));
  assert.equal(touchWrites.length, 2);
  assert.ok(touchWrites.every(({ eventId }) => Number.isSafeInteger(eventId)));
  assert.ok(touchIncidents.length > 0);
  assert.ok(touchIncidents.every(({ reason, identity }) => (
    reason === 'input-ack-timeout'
      && identity.connectionAttemptId === 'recovery-attempt-1'
      && identity.leaseEpoch === 7
  )));

  const imeIncidents = [];
  const ime = loadRecoveryFixture({
    touchPoints: 1,
    onIncident: (reason, identity) => imeIncidents.push({ reason, identity }),
  });
  const mobileInput = ime.elements.get('mobileTextInput');
  mobileInput.dispatch('compositionstart');
  mobileInput.value = 'ime-canary\u200b';
  mobileInput.dispatch('compositionupdate');
  mobileInput.dispatch('input');
  mobileInput.dispatch('compositionend');
  ime.advance(3001);
  const imeSnapshot = ime.trace.snapshot();
  const imeWrites = imeSnapshot.events.filter(({ stage, inputType, accepted, action }) => (
    stage === 'transport-send' && inputType === 'keyboard' && accepted === true && action === 'text'
  ));
  assert.equal(imeWrites.length, 1);
  assert.ok(Number.isSafeInteger(imeWrites[0].eventId));
  assert.ok(imeIncidents.length > 0);
  assert.ok(imeIncidents.every(({ reason, identity }) => (
    reason === 'input-ack-timeout'
      && identity.connectionAttemptId === 'recovery-attempt-1'
      && identity.leaseEpoch === 7
  )));
  const json = JSON.stringify({ touchSnapshot, imeSnapshot, touchIncidents, imeIncidents });
  assert.doesNotMatch(json, /ime-canary|recovery-lease-0001|relX|relY/);
});

test('deferred long-press retains the originating desktop focus for timeout incidents', () => {
  const incidents = [];
  const h = loadRecoveryFixture({
    touchPoints: 1,
    onIncident: (reason, identity) => incidents.push({ reason, identity }),
  });
  h.video.dispatch('pointerdown', {
    pointerType: 'touch', pointerId: 11, isPrimary: true,
    clientX: 400, clientY: 300, buttons: 1,
  });
  h.advance(550);

  const snapshot = h.trace.snapshot();
  const dom = snapshot.events.find(({ stage, inputType, action }) => (
    stage === 'dom-received' && inputType === 'pointer' && action === 'down'
  ));
  const down = snapshot.events.find(({ stage, inputType, action, accepted }) => (
    stage === 'transport-send' && inputType === 'pointer' && action === 'down' && accepted === true
  ));
  assert.ok(dom);
  assert.ok(down);
  assert.equal(down.eventId, dom.eventId);

  h.advance(3001);
  assert.equal(h.trace.snapshot().counters.ackTimeoutCount, 1);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].reason, 'input-ack-timeout');
  assert.equal(incidents[0].identity.connectionAttemptId, 'recovery-attempt-1');
  assert.equal(incidents[0].identity.leaseEpoch, 7);
});

test('deferred drag-start retains the originating desktop focus for timeout incidents', () => {
  const incidents = [];
  const h = loadRecoveryFixture({
    touchPoints: 1,
    onIncident: (reason, identity) => incidents.push({ reason, identity }),
  });
  h.video.dispatch('pointerdown', {
    pointerType: 'touch', pointerId: 12, isPrimary: true,
    clientX: 400, clientY: 300, buttons: 1,
  });
  h.video.dispatch('pointermove', {
    pointerType: 'touch', pointerId: 12, isPrimary: true,
    clientX: 430, clientY: 300, buttons: 1,
  });

  const snapshot = h.trace.snapshot();
  const dom = snapshot.events.find(({ stage, inputType, action }) => (
    stage === 'dom-received' && inputType === 'pointer' && action === 'down'
  ));
  const down = snapshot.events.find(({ stage, inputType, action, accepted }) => (
    stage === 'transport-send' && inputType === 'pointer' && action === 'down' && accepted === true
  ));
  assert.ok(dom);
  assert.ok(down);
  assert.equal(down.eventId, dom.eventId);

  h.advance(3001);
  assert.equal(h.trace.snapshot().counters.ackTimeoutCount, 1);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].reason, 'input-ack-timeout');
  assert.equal(incidents[0].identity.connectionAttemptId, 'recovery-attempt-1');
  assert.equal(incidents[0].identity.leaseEpoch, 7);
});

test('deferred mobile text drain retains the originating mobile focus for timeout incidents', () => {
  const incidents = [];
  const h = loadRecoveryFixture({
    touchPoints: 1,
    onIncident: (reason, identity) => incidents.push({ reason, identity }),
  });
  const mobileInput = h.elements.get('mobileTextInput');
  mobileInput.value = 'abcdefghijklmnopq';
  mobileInput.dispatch('input');
  const initialText = h.writes().find(({ action }) => action === 'text');
  assert.ok(initialText);
  h.ack(initialText);

  mobileInput.value = '\u200b';
  mobileInput.dispatch('input');
  const immediateDeletes = h.writes().filter(({ action }) => action === 'batch');
  assert.equal(immediateDeletes.length, 16);
  immediateDeletes.forEach((payload) => h.ack(payload));
  h.advance(0);

  const snapshot = h.trace.snapshot();
  const dom = snapshot.events.filter(({ stage, inputType, action }) => (
    stage === 'dom-received' && inputType === 'text' && action === 'text'
  )).at(-1);
  const deletes = snapshot.events.filter(({ stage, inputType, action, accepted }) => (
    stage === 'transport-send' && inputType === 'keyboard' && action === 'batch' && accepted === true
  ));
  assert.ok(dom);
  assert.equal(deletes.length, 17);
  assert.ok(deletes.every(({ eventId }) => eventId === dom.eventId));

  h.advance(3001);
  assert.equal(h.trace.snapshot().counters.ackTimeoutCount, 1);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].reason, 'input-ack-timeout');
  assert.equal(incidents[0].identity.connectionAttemptId, 'recovery-attempt-1');
  assert.equal(incidents[0].identity.leaseEpoch, 7);
});

test('deferred touch send refreshes current visibility before incident eligibility', () => {
  const incidents = [];
  const h = loadRecoveryFixture({
    touchPoints: 1,
    onIncident: (reason, identity) => incidents.push({ reason, identity }),
  });
  h.video.dispatch('pointerdown', {
    pointerType: 'touch', pointerId: 13, isPrimary: true,
    clientX: 400, clientY: 300, buttons: 1,
  });
  h.document.hidden = true;
  h.advance(550);

  const down = h.trace.snapshot().events.find(({ stage, inputType, action, accepted }) => (
    stage === 'transport-send' && inputType === 'pointer' && action === 'down' && accepted === true
  ));
  assert.ok(down);
  h.advance(3001);
  assert.equal(h.trace.snapshot().counters.ackTimeoutCount, 1);
  assert.equal(incidents.length, 0);
});

test('deferred touch dispatch retains desktop focus through nested mobile scope', () => {
  const h = loadRecoveryFixture({ touchPoints: 1 });
  const nestedScopes = [];
  const sendInput = h.WebRTC.sendInput;
  h.WebRTC.sendInput = function tracedSendInput(payload) {
    nestedScopes.push({
      action: payload?.action,
      eventId: h.Input._inputTraceContext?.eventId ?? null,
      focusKind: h.Input._inputTraceContext?.focusKind,
    });
    return sendInput.call(this, payload);
  };

  h.video.dispatch('pointerdown', {
    pointerType: 'touch', pointerId: 14, isPrimary: true,
    clientX: 400, clientY: 300, buttons: 1,
  });
  assert.equal(h.Input._inputTraceContext, null);
  h.advance(550);

  const snapshot = h.trace.snapshot();
  const dom = snapshot.events.find(({ stage, inputType, action }) => (
    stage === 'dom-received' && inputType === 'pointer' && action === 'down'
  ));
  const down = nestedScopes.find(({ action }) => action === 'down');
  assert.ok(dom);
  assert.ok(down);
  assert.equal(down.eventId, dom.eventId);
  assert.equal(down.focusKind, 'desktop');
});

test('invalid nested focus categories are not retained for trace eligibility', () => {
  const h = loadRecoveryFixture({ touchPoints: 1 });
  let nestedContext = null;
  h.Input._inputTraceContext = { focusKind: 'desktop', incidentEligible: true };
  h.Input._withInputTraceEvent(99, () => {
    nestedContext = { ...h.Input._inputTraceContext };
  }, { refreshEligibility: true, focusKind: 'untrusted-focus' });

  assert.equal(nestedContext.focusKind, undefined);
  assert.equal(nestedContext.incidentEligible, false);
});

test('recovery API unlocks a click and key only after both owned reset ACKs', () => {
  const h = loadRecoveryFixture();
  h.pointer('pointerdown');
  h.pointer('pointerup');
  h.blur();

  assert.equal(typeof h.Input.requestInputRecovery, 'function');
  assert.equal(h.Input.requestInputRecovery({ source: 'auto' }), true);
  assert.equal(h.Input.getEffectiveInputGate().allowed, false);

  const resets = h.writes().filter((payload) => payload.action === 'reset');
  assert.equal(resets.length, 2);
  const mouseReset = resets.find((payload) => payload.type === 'mouse');
  const keyboardReset = resets.find((payload) => payload.type === 'keyboard');
  assert.ok(mouseReset);
  assert.ok(keyboardReset);

  h.ack(keyboardReset);
  assert.equal(h.Input.getEffectiveInputGate().allowed, false);
  h.ack(mouseReset);
  assert.equal(h.Input.getEffectiveInputGate().allowed, true);

  const freshStart = h.writes().length;
  h.pointer('pointerdown');
  h.pointer('pointerup');
  const freshMouse = h.writes().slice(freshStart);
  freshMouse.forEach((payload) => h.ack(payload));
  h.keydown();
  h.keyup();
  const fresh = h.writes().slice(freshStart);
  assert.deepEqual(fresh.map((payload) => [payload.type, payload.action, payload.payload?.phase || '']), [
    ['mouse', 'down', ''], ['mouse', 'up', ''], ['keyboard', 'key', 'down'], ['keyboard', 'key', 'up'],
  ]);
});

test('both recovery ACK orders restore mobile transport before fresh textarea input', () => {
  for (const order of [['mouse', 'keyboard'], ['keyboard', 'mouse']]) {
    const h = loadRecoveryFixture({ touchPoints: 5 });
    h.setDataChannelOpen(false);
    // Mirror the real DataChannel onclose seam so the transport selects the
    // connected Socket for fresh text after recovery.
    h.Input.setKeyboardDataChannelAvailable(false);
    h.blur();
    h.window.dispatch('focus');

    const resets = h.inputs().filter((payload) => payload.action === 'reset');
    const byType = Object.fromEntries(resets.map((payload) => [payload.type, payload]));
    assert.equal(resets.length, 2);
    for (const type of order) h.ack(byType[type]);

    assert.equal(h.Input.getDiagnosticState().recovery.state, 'recovered', order.join(' then '));
    assert.equal(h.Input.getEffectiveInputGate().allowed, true, order.join(' then '));
    assert.equal(h.Input.mobileTextInputAdapter.getSnapshot().status, 'idle', order.join(' then '));

    h.elements.get('mobileTextInputBtn').dispatch('click');
    const mobile = h.elements.get('mobileTextInput');
    const before = h.inputs().length;
    mobile.value = 'fresh-mobile-text\u200b';
    mobile.dispatch('input');
    const fresh = h.inputs().slice(before).filter((payload) => payload.type === 'keyboard');
    assert.deepEqual(fresh.map((payload) => payload.action), ['text'], order.join(' then '));
  }
});

test('owned reset rejection ACK with a non-adjacent applied prefix fails recovery immediately', () => {
  for (const status of ['stale-lease', 'invalid-input', 'unsupported-code', 'execution-failed']) {
    for (const type of ['mouse', 'keyboard']) {
      const h = loadRecoveryFixture();
      // Leave two keyboard writes unconfirmed. The next keyboard reset is
      // therefore seq=3 while the Host may truthfully reject it at prefix 0.
      h.keydown();
      h.keyup();
      h.Input._markMobileSurfaceUncertain(`negative-${type}-${status}`);
      assert.equal(h.Input.requestInputRecovery({ source: 'auto' }), true);
      const reset = h.inputs().filter((payload) => payload.action === 'reset')
        .find((payload) => payload.type === type);
      const ack = {
        schemaVersion: 2,
        inputType: type,
        inputIds: reset.inputIds,
        leaseEpoch: reset.leaseEpoch,
        appliedSeq: 0,
        status,
      };
      const result = type === 'mouse'
        ? h.Input.acceptMouseAck(ack)
        : h.Input.acceptKeyboardAck(ack);
      assert.ok(['execution-failed', 'reacquire-required'].includes(result.status),
        `${type}/${status}`);
      assert.equal(h.Input.getDiagnosticState().recovery.state, 'failed', `${type}/${status}`);
      assert.equal(h.Input.getDiagnosticState().recovery.retryAvailable, true, `${type}/${status}`);
    }
  }
});

test('dual reset does not authorize an uncertain surface-timeout draft to resend old text', () => {
  for (const order of [['mouse', 'keyboard'], ['keyboard', 'mouse']]) {
    const h = loadRecoveryFixture({ touchPoints: 5 });
    h.pointer('pointerdown');
    const mobile = h.elements.get('mobileTextInput');
    h.elements.get('mobileTextInputBtn').dispatch('click');
    mobile.value = 'old-surface-draft\u200b';
    mobile.dispatch('input');
    h.advance(3001);
    assert.equal(h.Input.getDiagnosticState().surface.state, 'uncertain', order.join(' then '));
    assert.equal(h.Input.mobileTextInputAdapter.getSnapshot().deliveryUncertain, true,
      order.join(' then '));
    assert.equal(h.Input.mobileTextInputAdapter.getSnapshot().retryable, false,
      order.join(' then '));

    assert.equal(h.Input.requestInputRecovery({ source: 'user' }), true, order.join(' then '));
    const resets = h.inputs().filter((payload) => payload.action === 'reset');
    const byType = Object.fromEntries(resets.map((payload) => [payload.type, payload]));
    assert.equal(resets.length, 2, order.join(' then '));
    for (const type of order) h.ack(byType[type]);

    const snapshot = h.Input.mobileTextInputAdapter.getSnapshot();
    assert.equal(h.Input.getDiagnosticState().recovery.state, 'recovered', order.join(' then '));
    assert.equal(snapshot.deliveryUncertain, true, order.join(' then '));
    assert.equal(snapshot.retryable, false, order.join(' then '));
    const beforeRetry = h.inputs().length;
    assert.equal(h.Input.mobileTextInputAdapter.retryPending(), false, order.join(' then '));
    assert.equal(h.inputs().length, beforeRetry, order.join(' then '));
  }
});

test('automatic and user recovery reset messages pass the Signal v2 wire contract', () => {
  const { validateRemoteInput } = require(path.resolve(
    __dirname, '../../signal-server/lib/remote-input-contract.js',
  ));
  for (const source of ['auto', 'user']) {
    const h = loadRecoveryFixture();
    h.setDataChannelOpen(false);
    h.blur();
    h.Input._markMobileSurfaceUncertain(`wire-${source}`);
    assert.equal(h.Input.requestInputRecovery({ source }), true, source);
    const resets = h.inputs().filter((payload) => payload.action === 'reset');
    assert.equal(resets.length, 2, source);
    assert.deepEqual(new Set(resets.map((payload) => payload.payload.reason)),
      new Set([source === 'auto' ? 'transport-change' : 'manual']), source);
    resets.forEach((payload) => assert.equal(validateRemoteInput(payload).ok, true, source));
  }
});

test('reset confirmation rejects wrong identity and expires after the bounded deadline', () => {
  const h = loadRecoveryFixture();
  h.pointer('pointerdown');
  h.pointer('pointerup');
  h.blur();
  assert.equal(h.Input.requestInputRecovery({ source: 'user' }), true);
  const resets = h.writes().filter((payload) => payload.action === 'reset');
  const mouseReset = resets.find((payload) => payload.type === 'mouse');
  const keyboardReset = resets.find((payload) => payload.type === 'keyboard');

  assert.equal(h.Input.acceptMouseAck({
    schemaVersion: 2, inputType: 'mouse', inputIds: ['wrong-reset'],
    leaseEpoch: 7, appliedSeq: mouseReset.seq, status: 'applied',
  }).status, 'stale');
  assert.equal(h.Input.acceptKeyboardAck({
    schemaVersion: 2, inputType: 'mouse', inputIds: keyboardReset.inputIds,
    leaseEpoch: 7, appliedSeq: keyboardReset.seq, status: 'applied',
  }).status, 'stale');
  assert.equal(h.Input.acceptMouseAck({
    schemaVersion: 2, inputType: 'mouse', inputIds: mouseReset.inputIds,
    leaseEpoch: 7, appliedSeq: mouseReset.seq - 1, status: 'applied',
  }).status, 'stale');
  assert.equal(h.Input.acceptMouseAck({
    schemaVersion: 2, inputType: 'mouse', inputIds: mouseReset.inputIds,
    leaseEpoch: 8, appliedSeq: mouseReset.seq, status: 'applied',
  }).status, 'stale');
  assert.equal(h.Input.getDiagnosticState().recovery.state, 'waiting');
  const beforeTimeoutLifecycle = h.inputs().length;
  h.advance(3001);
  assert.equal(h.Input.getEffectiveInputGate().allowed, false);
  assert.equal(h.Input.getDiagnosticState().recovery.state, 'failed');
  assert.equal(h.Input.getDiagnosticState().recovery.retryAvailable, true);
  h.Input.setActive(true);
  assert.equal(h.inputs().length, beforeTimeoutLifecycle);
});

test('mobile context invalidation retains a draft until explicit empty recovery', () => {
  const h = loadRecoveryFixture({ touchPoints: 5 });
  const mobile = h.elements.get('mobileTextInput');
  h.Input.mobileTextInputAdapter.onTransportState('blocked');
  mobile.value = 'keep-this-draft\u200b';
  mobile.dispatch('input');
  h.Input.mobileTextInputAdapter.invalidateContext('visibility-hidden');
  assert.equal(mobile.value, 'keep-this-draft\u200b');
  assert.equal(h.Input.mobileTextInputAdapter.getSnapshot().deliveryUncertain, true);
  assert.equal(h.Input.mobileTextInputAdapter.confirmEmptyContextRecovery(), false);
  h.Input.mobileTextInputAdapter.discardPending();
  assert.equal(h.Input.mobileTextInputAdapter.confirmEmptyContextRecovery(), true);
  assert.equal(mobile.value, '\u200b');
});

test('real media runtime and both lifecycle listeners suspend, ACK, and require a fresh frame', () => {
  const h = loadRecoveryFixture({ touchPoints: 5 });
  assert.equal(h.WebRTC.mediaActivityController.snapshot().state, 'active');
  assert.equal(h.WebRTC.mediaActivityRuntime.phase, 'active');

  h.setDataChannelOpen(false);
  const before = h.sent.length;
  const requests = h.suspendAndResume();
  assert.ok(requests.suspended);
  assert.ok(requests.active);
  assert.ok(h.sent.slice(before).some(({ event, payload }) => (
    event === 'media-activity-change' && payload.state === 'suspended'
  )));
  assert.equal(h.WebRTC.mediaActivityRuntime.phase, 'active');
  assert.equal(h.WebRTC.mediaActivityRuntime.snapshot().lastAck.state, 'active');
  assert.equal(h.WebRTC.mediaActivityRuntime.snapshot().lastAck.applied, true);
  assert.equal(h.Input.getEffectiveInputGate().allowed, false, 'closed DC park remains gated');
  assert.equal(h.Input.getDiagnosticState().recovery.state, 'waiting');

  const resets = h.inputs().filter((payload) => payload.action === 'reset');
  const mouseReset = resets.find((payload) => payload.type === 'mouse');
  const keyboardReset = resets.find((payload) => payload.type === 'keyboard');
  assert.equal(resets.filter((payload) => payload.type === 'mouse').length, 1);
  assert.equal(resets.filter((payload) => payload.type === 'keyboard').length, 1);
  assert.ok(mouseReset);
  assert.ok(keyboardReset);
  h.ack(mouseReset);
  assert.equal(h.Input.getEffectiveInputGate().allowed, false);
  h.ack(keyboardReset);
  assert.equal(h.Input.getEffectiveInputGate().allowed, true);

  const freshStart = h.inputs().length;
  h.pointer('pointerdown');
  h.pointer('pointerup');
  const freshMouse = h.inputs().slice(freshStart);
  freshMouse.forEach((payload) => h.ack(payload));
  h.keydown();
  h.keyup();
  assert.deepEqual(h.inputs().slice(freshStart).map((payload) => (
    `${payload.type}:${payload.action}:${payload.payload?.phase || ''}`
  )), ['mouse:down:', 'mouse:up:', 'keyboard:key:down', 'keyboard:key:up']);
});

test('ordinary surface pending, IME composing, and healthy blur do not spend recovery budget', () => {
  const pending = loadRecoveryFixture();
  pending.pointer('pointerdown');
  const pendingResetCount = pending.inputs().filter((payload) => payload.action === 'reset').length;
  for (let index = 0; index < 20; index += 1) pending.Input.setActive(true);
  assert.equal(
    pending.inputs().filter((payload) => payload.action === 'reset').length,
    pendingResetCount,
  );
  assert.equal(pending.Input.getDiagnosticState().recovery.state, 'idle');
  assert.equal(pending.elements.get('inputRecoveryNotice').hidden, true);

  const composing = loadRecoveryFixture({touchPoints: 5});
  const mobile = composing.elements.get('mobileTextInput');
  mobile.dispatch('compositionstart');
  const composingResetCount = composing.inputs().filter((payload) => payload.action === 'reset').length;
  for (let index = 0; index < 20; index += 1) composing.Input.setActive(true);
  assert.equal(
    composing.inputs().filter((payload) => payload.action === 'reset').length,
    composingResetCount,
  );
  assert.equal(composing.Input.getDiagnosticState().recovery.state, 'idle');
  assert.equal(composing.elements.get('inputRecoveryNotice').hidden, true);

  const uncertain = loadRecoveryFixture();
  uncertain.Input._markMobileSurfaceUncertain('notice-test');
  assert.equal(uncertain.elements.get('inputRecoveryNotice').hidden, false);

  const healthyBlur = loadRecoveryFixture();
  healthyBlur.blur();
  const blurResets = healthyBlur.inputs().filter((payload) => payload.action === 'reset');
  assert.equal(blurResets.filter((payload) => payload.type === 'mouse').length, 0);
  assert.equal(blurResets.filter((payload) => payload.type === 'keyboard').length, 1);
  const beforeRepeatedActive = healthyBlur.inputs().length;
  for (let index = 0; index < 20; index += 1) healthyBlur.Input.setActive(true);
  assert.equal(healthyBlur.inputs().length, beforeRepeatedActive);
  healthyBlur.ack(blurResets[0]);
  assert.equal(healthyBlur.Input.getDiagnosticState().recovery.state, 'idle');
});

test('recovery notice distinguishes normal composition and ACK-pending drafts from invalidated drafts', () => {
  const composing = loadRecoveryFixture({ touchPoints: 5 });
  const composingInput = composing.elements.get('mobileTextInput');
  composingInput.dispatch('compositionstart');
  composingInput.value = 'normal-composition\u200b';
  composingInput.dispatch('compositionupdate');
  composingInput.dispatch('input');
  assert.equal(composing.Input.mobileTextInputAdapter.getSnapshot().composing, true);
  assert.equal(composing.Input.mobileTextInputAdapter.getSnapshot().hasPending, true);
  assert.equal(composing.Input.mobileTextInputAdapter.getSnapshot().deliveryUncertain, false);
  assert.equal(composing.elements.get('inputRecoveryNotice').hidden, true);
  assert.equal(composing.elements.get('inputRecoveryDraftBtn').hidden, true);
  composingInput.dispatch('compositionend');
  assert.equal(composing.elements.get('inputRecoveryNotice').hidden, true);

  const ackPending = loadRecoveryFixture({ touchPoints: 5 });
  ackPending.pointer('pointerdown');
  const ackPendingInput = ackPending.elements.get('mobileTextInput');
  ackPendingInput.value = 'ordinary-ack-pending\u200b';
  ackPendingInput.dispatch('input');
  const pendingSnapshot = ackPending.Input.mobileTextInputAdapter.getSnapshot();
  assert.equal(pendingSnapshot.hasPending, true);
  assert.equal(pendingSnapshot.deliveryUncertain, false);
  assert.equal(pendingSnapshot.status, 'pending');
  assert.equal(ackPending.elements.get('inputRecoveryNotice').hidden, true);
  assert.equal(ackPending.elements.get('inputRecoveryDraftBtn').hidden, true);

  const invalidated = loadRecoveryFixture({ touchPoints: 5 });
  invalidated.pointer('pointerdown');
  const invalidatedInput = invalidated.elements.get('mobileTextInput');
  invalidatedInput.value = 'retained-invalidated-draft\u200b';
  invalidatedInput.dispatch('input');
  invalidated.Input.mobileTextInputAdapter.invalidateContext('visibility-hidden');
  const invalidatedSnapshot = invalidated.Input.mobileTextInputAdapter.getSnapshot();
  assert.equal(invalidatedSnapshot.hasPending, true);
  assert.equal(invalidatedSnapshot.deliveryUncertain, true);
  assert.equal(invalidated.elements.get('inputRecoveryNotice').hidden, false);
  assert.equal(invalidated.elements.get('inputRecoveryDraftBtn').hidden, false);
  const beforeRetry = invalidated.inputs().length;
  assert.equal(invalidated.Input.mobileTextInputAdapter.retryPending(), false);
  assert.equal(invalidated.inputs().length, beforeRetry);
});

test('keyboard UI reflects effective vetoes instead of reporting raw READY', () => {
  const uncertain = loadRecoveryFixture();
  const uncertainDisplay = uncertain.elements.get('keyInputDisplay');
  assert.equal(uncertain.Input.keyboardController.getSnapshot().state, 'READY');
  uncertain.Input._markMobileSurfaceUncertain('ui-gate');
  uncertain.Input.updateKeyboardUI();
  assert.equal(uncertainDisplay.textContent, '键盘：阻塞');
  assert.equal(uncertainDisplay.dataset.state, 'BLOCKED');

  const unsupported = loadRecoveryFixture();
  const unsupportedDisplay = unsupported.elements.get('keyInputDisplay');
  assert.equal(unsupported.Input.keyboardController.getSnapshot().state, 'READY');
  unsupported.Input.setViewportInputSupported(false);
  unsupported.Input.updateKeyboardUI();
  assert.equal(unsupportedDisplay.textContent, '键盘：阻塞');
  assert.equal(unsupportedDisplay.dataset.state, 'BLOCKED');

  const healthy = loadRecoveryFixture();
  const healthyDisplay = healthy.elements.get('keyInputDisplay');
  healthy.Input.updateKeyboardUI();
  assert.equal(healthyDisplay.textContent, '键盘：就绪');
  assert.equal(healthyDisplay.dataset.state, 'READY');
});

test('a visible focus return recovers a parked surface without waiting for a media frame', () => {
  const h = loadRecoveryFixture();
  h.setDataChannelOpen(false);
  h.blur();
  assert.equal(h.Input.getDiagnosticState().recovery.state, 'idle');
  assert.equal(h.Input.getEffectiveInputGate().allowed, false);

  const beforeFocus = h.inputs().length;
  h.window.dispatch('focus');
  assert.equal(h.Input.getDiagnosticState().recovery.state, 'waiting');
  const resets = h.inputs().slice(beforeFocus).filter((payload) => payload.action === 'reset');
  assert.equal(resets.length, 2);
  resets.forEach((payload) => h.ack(payload));
  assert.equal(h.Input.getEffectiveInputGate().allowed, true);
});

test('a cancelled drag enters uncertainty and recovers without replaying the drag', () => {
  const h = loadRecoveryFixture();
  h.pointer('pointerdown');
  h.pointer('pointercancel');
  const initial = h.inputs();
  const cancelledReset = initial.find((payload) => payload.type === 'mouse' && payload.action === 'reset');
  assert.ok(cancelledReset);
  assert.equal(h.Input.getDiagnosticState().surface.state, 'uncertain');

  assert.equal(h.Input.requestInputRecovery({ source: 'auto' }), true);
  const recoveryWrites = h.inputs().slice(initial.length);
  const recoveryResets = recoveryWrites.filter((payload) => payload.action === 'reset');
  assert.equal(recoveryResets.length, 1, 'the already-pending mouse reset is claimed');
  assert.ok(recoveryResets.some((payload) => payload.type === 'keyboard'));
  h.ack(cancelledReset);
  h.ack(recoveryResets.find((payload) => payload.type === 'keyboard'));
  assert.equal(h.Input.getEffectiveInputGate().allowed, true);

  const freshStart = h.inputs().length;
  h.pointer('pointerdown');
  h.pointer('pointerup');
  assert.deepEqual(h.inputs().slice(freshStart).map((payload) => payload.action), ['down', 'up']);
});

test('wrong-epoch or old-attempt mouse reset ACK cannot clear the safety barrier', () => {
  const h = loadRecoveryFixture();
  h.pointer('pointerdown');
  h.blur();
  const reset = h.inputs().find((payload) => payload.type === 'mouse' && payload.action === 'reset');
  assert.ok(reset);

  assert.equal(h.Input.acceptMouseAck({
    schemaVersion: 2,
    inputType: 'mouse',
    inputIds: reset.inputIds,
    leaseEpoch: 8,
    appliedSeq: reset.seq,
    status: 'applied',
  }).status, 'stale');
  assert.equal(h.Input.getDiagnosticState().pendingMouseReset, true);

  h.WebRTC.currentConnectionAttemptId = 'recovery-attempt-old-ack';
  assert.equal(h.Input.acceptMouseAck({
    schemaVersion: 2,
    inputType: 'mouse',
    inputIds: reset.inputIds,
    leaseEpoch: 7,
    appliedSeq: reset.seq,
    status: 'applied',
  }).status, 'stale');
  assert.equal(h.Input.getDiagnosticState().pendingMouseReset, true);
});

test('a keyboard reset from an old attempt cannot unlock, while the new attempt gets new ownership', () => {
  const h = loadRecoveryFixture();
  h.Input.mobileTextInputAdapter.invalidateContext('attempt-change');
  assert.equal(h.Input.requestInputRecovery({source: 'auto'}), true);
  const oldResets = h.inputs().filter((payload) => payload.action === 'reset');
  const oldKeyboard = oldResets.find((payload) => payload.type === 'keyboard');
  assert.ok(oldKeyboard);

  h.WebRTC.currentConnectionAttemptId = 'recovery-attempt-2';
  h.WebRTC._mediaReadyConnectionAttemptId = 'recovery-attempt-2';
  h.Input.onConnectionAttemptChanged('recovery-attempt-2');
  assert.equal(h.Input.acceptKeyboardAck({
    schemaVersion: 2,
    inputType: 'keyboard',
    inputIds: oldKeyboard.inputIds,
    leaseEpoch: oldKeyboard.leaseEpoch,
    appliedSeq: oldKeyboard.seq,
    status: 'applied',
  }).status, 'stale');
  assert.equal(h.Input.getDiagnosticState().recovery.state, 'idle');

  h.Input.setActive(true);
  assert.equal(h.Input.getDiagnosticState().recovery.state, 'waiting');
  const currentResets = h.inputs().filter((payload) => payload.action === 'reset');
  const newResets = currentResets.slice(oldResets.length);
  const currentKeyboard = newResets.find((payload) => payload.type === 'keyboard');
  assert.notEqual(currentKeyboard.inputIds[0], oldKeyboard.inputIds[0]);
  assert.equal(currentKeyboard.payload.reason, 'transport-change');
  assert.equal(h.Input.keyboardTransport.getPendingReset().connectionAttemptId, 'recovery-attempt-2');
  assert.equal(h.Input.acceptKeyboardAck({
    schemaVersion: 2,
    inputType: 'keyboard',
    inputIds: oldKeyboard.inputIds,
    leaseEpoch: oldKeyboard.leaseEpoch,
    appliedSeq: oldKeyboard.seq,
    status: 'applied',
  }).status, 'stale');
  const currentMouse = newResets.find((payload) => payload.type === 'mouse');
  assert.ok(currentMouse);
  h.ack(currentMouse);
  h.ack(currentKeyboard);
  assert.equal(h.Input.getEffectiveInputGate().allowed, true);
});

test('a successful recovery closes its budget so a second same-session failure gets one new cycle', () => {
  const h = loadRecoveryFixture();
  h.Input.mobileTextInputAdapter.invalidateContext('first-failure');
  assert.equal(h.Input.requestInputRecovery({source: 'auto'}), true);
  let resets = h.inputs().filter((payload) => payload.action === 'reset');
  resets.forEach((payload) => h.ack(payload));
  assert.equal(h.Input.getDiagnosticState().recovery.state, 'recovered');
  assert.equal(h.Input.getEffectiveInputGate().allowed, true);

  h.Input._markMobileSurfaceUncertain('second-failure');
  const beforeSecond = h.inputs().length;
  assert.equal(h.Input.setActive(true), undefined);
  assert.equal(h.Input.getDiagnosticState().recovery.state, 'waiting');
  const secondResets = h.inputs().slice(beforeSecond)
    .filter((payload) => payload.action === 'reset');
  assert.equal(secondResets.length, 2);
  secondResets.forEach((payload) => h.ack(payload));
  assert.equal(h.Input.getDiagnosticState().recovery.state, 'recovered');
  assert.equal(h.Input.getEffectiveInputGate().allowed, true);
});

test('automatic timeout/negative ACK stops, then a user retry starts one bounded cycle', () => {
  const h = loadRecoveryFixture();
  h.Input._markMobileSurfaceUncertain('retry-needed');
  assert.equal(h.Input.requestInputRecovery({source: 'auto'}), true);
  const firstResets = h.inputs().filter((payload) => payload.action === 'reset');
  const firstMouse = firstResets.find((payload) => payload.type === 'mouse');
  const firstKeyboard = firstResets.find((payload) => payload.type === 'keyboard');
  assert.equal(h.Input.acceptMouseAck({
    schemaVersion: 2,
    inputType: 'mouse',
    inputIds: firstMouse.inputIds,
    leaseEpoch: 7,
    appliedSeq: firstMouse.seq,
    status: 'execution-failed',
  }).status, 'execution-failed');
  assert.equal(h.Input.getDiagnosticState().recovery.state, 'failed');
  assert.equal(h.Input.getDiagnosticState().recovery.retryAvailable, true);

  const beforeRetry = h.inputs().length;
  assert.equal(h.Input.requestInputRecovery({source: 'user'}), true);
  const retryResets = h.inputs().slice(beforeRetry).filter((payload) => payload.action === 'reset');
  assert.equal(retryResets.length, 1, 'the still-pending keyboard reset is claimed, not duplicated');
  const retryMouse = retryResets.find((payload) => payload.type === 'mouse');
  const retryKeyboard = firstKeyboard;
  assert.equal(retryMouse.payload.reason, 'manual');
  assert.notEqual(retryMouse.inputIds[0], firstMouse.inputIds[0]);
  h.ack(retryKeyboard);
  assert.equal(h.Input.getEffectiveInputGate().allowed, false);
  h.ack(retryMouse);
  assert.equal(h.Input.getEffectiveInputGate().allowed, true);
  assert.equal(h.Input.requestInputRecovery({source: 'auto'}), false);
});

test('mouse sequence-gap recovery rewinds once and sends only a new reset', () => {
  const h = loadRecoveryFixture();
  h.Input._markMobileSurfaceUncertain('sequence-gap');
  assert.equal(h.Input.requestInputRecovery({source: 'auto'}), true);
  const firstResets = h.inputs().filter((payload) => payload.action === 'reset');
  const firstMouse = firstResets.find((payload) => payload.type === 'mouse');
  const keyboardReset = firstResets.find((payload) => payload.type === 'keyboard');
  const ordinaryBeforeRecovery = h.inputs().filter((payload) => payload.action !== 'reset');
  assert.equal(h.Input.acceptMouseAck({
    schemaVersion: 2,
    inputType: 'mouse',
    inputIds: firstMouse.inputIds,
    leaseEpoch: 7,
    appliedSeq: 0,
    status: 'sequence-gap',
  }).status, 'sequence-gap');
  const retryMouse = h.inputs().filter((payload) => payload.type === 'mouse' && payload.action === 'reset').at(-1);
  assert.notEqual(retryMouse.inputIds[0], firstMouse.inputIds[0]);
  assert.equal(h.Input.getDiagnosticState().recovery.mouseConfirmed, false);
  assert.deepEqual(h.inputs().filter((payload) => payload.action !== 'reset'), ordinaryBeforeRecovery);

  h.ack(retryMouse);
  assert.equal(h.Input.getEffectiveInputGate().allowed, false);
  h.ack(keyboardReset);
  assert.equal(h.Input.getEffectiveInputGate().allowed, true);
  assert.equal(h.Input._recoveryCycle.mouseRetryUsed, true);
  assert.equal(h.Input.acceptMouseAck({
    schemaVersion: 2,
    inputType: 'mouse',
    inputIds: [firstMouse.inputIds[0]],
    leaseEpoch: 7,
    appliedSeq: 0,
    status: 'sequence-gap',
  }).status, 'stale');
});

test('a late ACK for the pre-blur gesture cannot satisfy the new recovery owner', () => {
  const h = loadRecoveryFixture();
  h.pointer('pointerdown');
  h.pointer('pointerup');
  const gestureWrites = h.inputs().filter((payload) => payload.action === 'down' || payload.action === 'up');
  assert.equal(gestureWrites.length, 2);
  h.blur();
  assert.equal(h.Input.requestInputRecovery({source: 'auto'}), true);
  const recoveryResets = h.inputs().filter((payload) => payload.action === 'reset');
  const mouseReset = recoveryResets.find((payload) => payload.type === 'mouse');
  const keyboardReset = recoveryResets.find((payload) => payload.type === 'keyboard');
  for (const gesture of gestureWrites) {
    assert.equal(h.Input.acceptMouseAck({
      schemaVersion: 2,
      inputType: 'mouse',
      inputIds: gesture.inputIds,
      leaseEpoch: 7,
      appliedSeq: gesture.seq,
      status: 'applied',
    }).status, 'stale');
  }
  assert.equal(h.Input.getDiagnosticState().recovery.state, 'waiting');
  assert.equal(h.Input.getEffectiveInputGate().allowed, false);
  h.ack(keyboardReset);
  assert.equal(h.Input.getEffectiveInputGate().allowed, false);
  h.ack(mouseReset);
  assert.equal(h.Input.getEffectiveInputGate().allowed, true);
});

test('an old cumulative gesture ACK cannot prune the current recovery reset owner', () => {
  const h = loadRecoveryFixture();
  h.pointer('pointerdown');
  h.pointer('pointerup');
  const oldUp = h.writes().find((payload) => payload.type === 'mouse' && payload.action === 'up');
  h.blur();
  assert.equal(h.Input.requestInputRecovery({ source: 'auto' }), true);
  const resets = h.writes().filter((payload) => payload.action === 'reset');
  const mouseReset = resets.filter((payload) => payload.type === 'mouse').at(-1);
  const keyboardReset = resets.filter((payload) => payload.type === 'keyboard').at(-1);

  assert.equal(h.ack(oldUp, { status: 'duplicate', appliedSeq: mouseReset.seq }).status, 'stale');
  assert.equal(h.ack(keyboardReset).status, 'applied');
  assert.equal(h.ack(mouseReset).status, 'applied');
  assert.equal(h.Input.getEffectiveInputGate().allowed, true);
});

test('a closed DataChannel uses a connected Socket for the dual reset and fresh writes', () => {
  const h = loadRecoveryFixture({channels: 'socket'});
  h.Input._markMobileSurfaceUncertain('socket-fallback');
  assert.equal(h.Input.requestInputRecovery({source: 'auto'}), true);
  const resets = h.inputs().filter((payload) => payload.action === 'reset');
  assert.equal(resets.length, 2);
  assert.equal(h.sent.filter(({event}) => event === 'dc').length, 0);
  assert.ok(resets.every((payload) => payload.type === 'mouse' || payload.type === 'keyboard'));
  h.ack(resets[0]);
  h.ack(resets[1]);
  assert.equal(h.Input.getEffectiveInputGate().allowed, true);

  const freshStart = h.inputs().length;
  h.pointer('pointerdown');
  h.pointer('pointerup');
  const freshMouse = h.inputs().slice(freshStart);
  freshMouse.forEach((payload) => h.ack(payload));
  h.keydown();
  h.keyup();
  assert.deepEqual(h.inputs().slice(freshStart).map((payload) => (
    `${payload.type}:${payload.action}:${payload.payload?.phase || ''}`
  )), ['mouse:down:', 'mouse:up:', 'keyboard:key:down', 'keyboard:key:up']);
});

test('recovery does not claim success when both input transports are unavailable', () => {
  const h = loadRecoveryFixture({channels: 'none'});
  h.Input._markMobileSurfaceUncertain('all-transports-down');
  assert.equal(h.Input.requestInputRecovery({source: 'user'}), false);
  assert.equal(h.Input.getEffectiveInputGate().allowed, false);
  assert.equal(h.Input.getDiagnosticState().recovery.state, 'failed');
  assert.equal(h.Input.getDiagnosticState().recovery.retryAvailable, true);
  assert.equal(h.inputs().filter((payload) => payload.action === 'reset').length, 0);
});

test('a retained draft is visible through the fixed recovery UI without auto-send or reset', () => {
  const h = loadRecoveryFixture({touchPoints: 5});
  const mobile = h.elements.get('mobileTextInput');
  const dock = h.elements.get('mobileInputDock');
  const draftButton = h.elements.get('inputRecoveryDraftBtn');
  h.Input.mobileTextInputAdapter.onTransportState('blocked');
  mobile.value = 'local-draft';
  mobile.dispatch('input');
  const before = h.inputs().length;
  h.Input.setActive(true);
  const notice = h.elements.get('inputRecoveryNotice');
  assert.equal(notice.hidden, false);
  assert.equal(draftButton.hidden, false);
  assert.equal(h.elements.get('inputRecoveryRetryBtn').hidden, true);
  draftButton.dispatch('click');
  assert.equal(dock.hidden, false);
  assert.equal(mobile.value, 'local-draft');
  assert.equal(h.inputs().length, before);
});

test('failed recovery UI retry invokes a user cycle without stealing the local editor', () => {
  const h = loadRecoveryFixture();
  h.Input._markMobileSurfaceUncertain('ui-retry');
  assert.equal(h.Input.requestInputRecovery({source: 'auto'}), true);
  const firstMouse = h.inputs().filter((payload) => payload.type === 'mouse' && payload.action === 'reset').at(-1);
  h.Input.acceptMouseAck({
    schemaVersion: 2,
    inputType: 'mouse',
    inputIds: firstMouse.inputIds,
    leaseEpoch: 7,
    appliedSeq: firstMouse.seq,
    status: 'execution-failed',
  });
  assert.equal(h.Input.getDiagnosticState().recovery.state, 'failed');
  const retryButton = h.elements.get('inputRecoveryRetryBtn');
  assert.equal(retryButton.hidden, false);
  const before = h.inputs().length;
  retryButton.dispatch('click');
  assert.equal(h.Input.getDiagnosticState().recovery.state, 'waiting');
  assert.equal(h.inputs().length > before, true);
  assert.equal(h.document.activeElement, null);
});
