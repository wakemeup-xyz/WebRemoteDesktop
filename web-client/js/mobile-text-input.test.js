const assert = require('node:assert/strict');
const test = require('node:test');
const { MobileTextInput } = require('./mobile-text-input.js');

function makeTextHarness({enabled = true, refreshViewport = () => {}, sendTextResult = true, sendKeyResult = true, isDeliverySettled = true} = {}) {
  const listeners = new Map(); const sent = []; const failedAttempts = [];
  let enabledState = enabled;
  let sendAccepted = sendTextResult;
  let keyAccepted = sendKeyResult;
  let deliverySettled = isDeliverySettled;
  const input = {
    value: '', selectionStart: 0, selectionEnd: 0,
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type) { listeners.delete(type); },
    focus() {}, blur() {},
  };
  const adapter = MobileTextInput.create({
    element: input,
    sendText: (value) => {
      if (!sendAccepted) {
        failedAttempts.push({kind: 'text', value});
        return false;
      }
      sent.push({kind: 'text', value});
      return `text-${sent.length}`;
    },
    sendKey: (value) => {
      const result = typeof keyAccepted === 'function' ? keyAccepted(value) : keyAccepted;
      if (!result) {
        failedAttempts.push({kind: 'key', value});
        return false;
      }
      sent.push({kind: 'key', value});
      return `key-${sent.length}`;
    },
    isEnabled: () => enabledState,
    isDeliverySettled: () => deliverySettled,
    refreshViewport,
  });
  adapter.attach();
  return {
    adapter,
    input,
    sent,
    failedAttempts,
    setSendAccepted(value) { sendAccepted = Boolean(value); },
    setSendKeyAccepted(value) { keyAccepted = value; },
    setEnabled(value) { enabledState = Boolean(value); },
    setDeliverySettled(value) { deliverySettled = Boolean(value); },
    emit(type, overrides = {}) {
      listeners.get(type)?.({type, target: input, inputType: null, ...overrides});
    },
  };
}

test('IME DOM phases and deferred sends retain a safe trace event association', async () => {
  const domEvents = [];
  const gateEvents = [];
  const associations = [];
  const listeners = new Map();
  const input = {
    value: '', selectionStart: 0, selectionEnd: 0,
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener() {}, focus() {}, blur() {},
  };
  let nextEventId = 0;
  const adapter = MobileTextInput.create({
    element: input,
    sendText: () => 'text-1',
    sendKey: () => 'key-1',
    isEnabled: () => true,
    onTraceDomEvent(meta) {
      domEvents.push(meta);
      return ++nextEventId;
    },
    onTraceGate(meta) { gateEvents.push(meta); },
    withTraceEvent(eventId, send) {
      associations.push(eventId);
      return send();
    },
  });
  adapter.attach();
  const emit = (type, overrides = {}) => listeners.get(type)?.({ type, target: input, ...overrides });

  emit('compositionstart');
  input.value = '中';
  emit('compositionupdate');
  emit('compositionend');
  emit('input');

  assert.deepEqual(domEvents.map(({ action, phase }) => `${action}:${phase}`), [
    'composition:compositionstart', 'composition:compositionupdate',
    'composition:compositionend', 'text:input',
  ]);
  assert.ok(associations.includes(3), 'the composition commit must retain its DOM event association');
  assert.equal(gateEvents.length, 0, 'an accepted send is gated by Input, not a second adapter gate');
  assert.equal(JSON.stringify(domEvents).includes('中'), false);

  // Once the DOM dispatch microtask closes, a later toolbar action must not
  // inherit the last text event's association.
  await Promise.resolve();
  adapter.runExternalAction('navigation', () => 'navigation-accepted');
  assert.equal(associations.at(-1), null);
});

test('a tracing hook that throws after sending cannot replay the business callback', () => {
  const listeners = new Map();
  const input = {
    value: '', selectionStart: 0, selectionEnd: 0,
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener() {}, focus() {}, blur() {},
  };
  let sends = 0;
  const adapter = MobileTextInput.create({
    element: input,
    sendText: () => { sends += 1; return 'sent-once'; },
    isEnabled: () => true,
    onTraceDomEvent: () => 1,
    withTraceEvent(_eventId, send) {
      const result = send();
      throw new Error(`trace-after-send:${result}`);
    },
  });
  adapter.attach();
  input.value = 'once';
  listeners.get('input')({ type: 'input', target: input });
  assert.equal(sends, 1);
  assert.equal(adapter.getSnapshot().hasPending, false);
});

function withFakeTimers(run) {
  const nativeSetTimeout = global.setTimeout;
  const nativeClearTimeout = global.clearTimeout;
  const callbacks = [];
  global.setTimeout = (callback) => {
    callbacks.push(callback);
    return callbacks.length;
  };
  global.clearTimeout = (id) => { callbacks[id - 1] = null; };
  try {
    return run(callbacks);
  } finally {
    global.setTimeout = nativeSetTimeout;
    global.clearTimeout = nativeClearTimeout;
  }
}

test('rejected draft survives the next edit and retries only unsent text', () => {
  const h = makeTextHarness();
  h.input.value = 'a'; h.emit('input');
  h.setSendAccepted(false);
  h.input.value = 'ab\u200b'; h.emit('input');
  h.emit('beforeinput', {inputType: 'insertText', preventDefault() {}});
  assert.equal(h.input.value, 'ab\u200b');
  h.input.value = 'abc\u200b'; h.emit('input');
  h.setSendAccepted(true);
  assert.equal(h.adapter.retryPending(), true);
  assert.deepEqual(h.sent.filter((x) => x.kind === 'text').map((x) => x.value), ['a', 'bc']);
});

test('pending draft keeps local selection and Backspace editing available', () => {
  const h = makeTextHarness();
  h.input.value = 'a'; h.emit('input');
  h.setSendAccepted(false);
  h.input.value = 'ab\u200b'; h.emit('input');
  h.input.selectionStart = 1; h.input.selectionEnd = 1;
  h.emit('select');
  assert.equal(h.input.selectionStart, 1);
  let prevented = false;
  h.emit('keydown', {key: 'Backspace', preventDefault() { prevented = true; }});
  assert.equal(prevented, false);
  assert.deepEqual(h.sent.filter((item) => item.kind === 'key'), []);
});

test('partial deletion retains the accepted prefix before a later edit', () => {
  withFakeTimers((callbacks) => {
    const h = makeTextHarness();
    h.input.value = 'abcdefghijklmnopqr'; h.emit('input'); h.sent.length = 0;
    h.input.value = '\u200b'; h.emit('input');
    assert.equal(h.sent.filter((item) => item.value === 'Backspace').length, 16);
    assert.equal(callbacks.length, 1);
    h.input.value = 'abz\u200b'; h.emit('input');
    assert.deepEqual(h.sent.slice(16), [{kind: 'text', value: 'z'}]);
  });
});

test('a rejected deletion stops immediately and does not schedule another batch', () => {
  const h = makeTextHarness();
  h.input.value = 'abcdefghijklmnopqr'; h.emit('input'); h.sent.length = 0;
  let keyCalls = 0;
  h.setSendKeyAccepted(() => {
    keyCalls += 1;
    return keyCalls !== 3;
  });
  h.input.value = '\u200b'; h.emit('input');
  assert.equal(keyCalls, 3);
  assert.equal(h.sent.filter((item) => item.value === 'Backspace').length, 2);
  assert.equal(h.failedAttempts.filter((item) => item.value === 'Backspace').length, 1);
  assert.equal(h.adapter.getSnapshot().hasPending, true);
});

test('a synchronous transport gate change stops the current delete batch before the next send', () => {
  const h = makeTextHarness();
  h.input.value = 'abcdefghijklmnopqr'; h.emit('input'); h.sent.length = 0;
  let keyCalls = 0;
  h.setSendKeyAccepted(() => {
    keyCalls += 1;
    if (keyCalls === 1) h.adapter.onTransportState('blocked');
    return true;
  });
  h.input.value = '\u200b'; h.emit('input');
  assert.equal(keyCalls, 1);
  assert.deepEqual(h.sent.filter((item) => item.value === 'Backspace'), [
    {kind: 'key', value: 'Backspace'},
  ]);
  assert.equal(h.adapter.getSnapshot().status, 'blocked');
  assert.equal(h.adapter.getSnapshot().hasPending, true);
});

test('blocked transport context stays invalid after ready until discard establishes a new draft', () => {
  const h = makeTextHarness();
  h.adapter.onTransportState('blocked');
  let snapshot = h.adapter.getSnapshot();
  assert.equal(snapshot.hasPending, false);
  assert.equal(snapshot.deliveryUncertain, true);

  h.adapter.onTransportState('ready');
  h.input.value = 'a'; h.emit('input');
  assert.deepEqual(h.sent, []);
  snapshot = h.adapter.getSnapshot();
  assert.equal(snapshot.hasPending, true);
  assert.equal(snapshot.retryable, false);
  assert.equal(h.adapter.retryPending(), false);

  h.adapter.discardPending();
  h.input.value = 'fresh'; h.emit('input');
  assert.deepEqual(h.sent, [{kind: 'text', value: 'fresh'}]);

  h.adapter.onTransportState('blocked');
  h.input.value = 'fresh-draft'; h.emit('input');
  assert.deepEqual(h.sent, [{kind: 'text', value: 'fresh'}]);
  h.adapter.onTransportState('ready');
  assert.equal(h.adapter.retryPending(), false);
  assert.equal(h.adapter.getSnapshot().hasPending, true);
});

test('composition or gate changes cancel a scheduled drain for explicit retry', () => {
  for (const interrupt of ['composition', 'gate']) {
    withFakeTimers((callbacks) => {
      const h = makeTextHarness();
      h.input.value = 'abcdefghijklmnopqr'; h.emit('input'); h.sent.length = 0;
      h.input.value = '\u200b'; h.emit('input');
      assert.equal(callbacks.length, 1, interrupt);
      if (interrupt === 'composition') h.emit('compositionstart');
      else h.setEnabled(false);
      callbacks[0]?.();
      assert.equal(h.adapter.getSnapshot().hasPending, true, interrupt);
      assert.equal(h.adapter.getSnapshot().retryable, false, interrupt);
      if (interrupt === 'composition') h.emit('compositionend');
      else h.setEnabled(true);
      assert.equal(h.adapter.retryPending(), true, interrupt);
      assert.equal(h.sent.filter((item) => item.value === 'Backspace').length, 18, interrupt);
    });
  }
});

test('ordinary hide preserves the same-context pending draft', () => {
  const h = makeTextHarness({sendTextResult: false, isDeliverySettled: false});
  h.input.value = 'draft'; h.emit('input');
  h.adapter.show();
  h.adapter.hide();
  assert.equal(h.input.value, 'draft');
  assert.equal(h.adapter.getSnapshot().hasPending, true);
});

test('context invalidation keeps an empty surface uncertain until explicit confirmation', () => {
  const h = makeTextHarness();
  const sentBefore = h.sent.length;
  h.adapter.invalidateContext('visibility-hidden');

  assert.equal(h.adapter.needsContextRecovery(), true);
  assert.equal(h.adapter.getSnapshot().hasPending, false);
  assert.equal(h.adapter.getSnapshot().deliveryUncertain, true);
  assert.equal(h.sent.length, sentBefore);
  assert.equal(h.adapter.confirmEmptyContextRecovery(), true);
  assert.equal(h.adapter.needsContextRecovery(), false);
  assert.equal(h.adapter.getSnapshot().deliveryUncertain, false);
});

test('empty context confirmation refuses a draft or composition until discard/commit', () => {
  const h = makeTextHarness({sendTextResult: false});
  h.input.value = 'draft';
  h.emit('input');
  h.adapter.invalidateContext('page-hide');
  assert.equal(h.adapter.confirmEmptyContextRecovery(), false);
  assert.equal(h.input.value, 'draft');

  h.adapter.discardPending();
  assert.equal(h.adapter.confirmEmptyContextRecovery(), true);
  h.emit('compositionstart');
  assert.equal(h.adapter.confirmEmptyContextRecovery(), false);
  h.emit('compositionend');
});

test('bounded deletion timer is cancelled by reset before its old callback can send', () => {
  const nativeSetTimeout = global.setTimeout;
  const nativeClearTimeout = global.clearTimeout;
  const callbacks = [];
  global.setTimeout = (callback) => {
    callbacks.push(callback);
    return callbacks.length;
  };
  global.clearTimeout = (id) => { callbacks[id - 1] = null; };
  try {
    const h = makeTextHarness();
    h.input.value = 'abcdefghijklmnopqr'; h.emit('input'); h.sent.length = 0;
    h.input.value = '\u200b'; h.emit('input');
    assert.equal(h.sent.filter((item) => item.value === 'Backspace').length, 16);
    assert.equal(callbacks.length, 1);
    const sentBeforeReset = h.sent.length;
    h.adapter.reset('lease-changed');
    callbacks[0]?.();
    assert.equal(h.sent.length, sentBeforeReset);
    assert.equal(h.input.value, '\u200b');
  } finally {
    global.setTimeout = nativeSetTimeout;
    global.clearTimeout = nativeClearTimeout;
  }
});

test('unpaired surrogate is retained locally and never sent', () => {
  const h = makeTextHarness();
  h.input.value = '\uD83D\u200b'; h.emit('input');
  assert.deepEqual(h.sent, []);
  assert.equal(h.input.value, '\uD83D\u200b');
  assert.equal(h.adapter.getSnapshot().hasPending, true);
});

test('ZWJ text is sent as one Unicode scalar-bounded action', () => {
  const h = makeTextHarness();
  h.input.value = '👩‍💻'; h.emit('input');
  assert.deepEqual(h.sent, [{kind: 'text', value: '👩‍💻'}]);
});

test('pending text is capped at 4096 Unicode scalars independently of DOM maxlength', () => {
  const h = makeTextHarness();
  h.input.value = `${'🙂'.repeat(4097)}\u200b`; h.emit('input');
  assert.equal(Array.from(h.sent[0].value).length, 4096);
  assert.equal(Array.from(h.input.value.replace('\u200b', '')).length, 4096);
});

test('transport uncertainty is metadata-only and does not expose draft text', () => {
  const snapshots = [];
  const h = makeTextHarness();
  const adapter = MobileTextInput.create({
    element: h.input,
    sendText: () => true,
    sendKey: () => true,
    isEnabled: () => true,
    onStateChange: (snapshot) => snapshots.push(snapshot),
  });
  adapter.attach();
  adapter.onTransportState('reacquire-required');
  const snapshot = adapter.getSnapshot();
  assert.equal(snapshot.status, 'uncertain');
  assert.equal(snapshot.deliveryUncertain, true);
  assert.equal(snapshot.hasPending, false);
  assert.equal(Object.prototype.hasOwnProperty.call(snapshot, 'value'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(snapshot, 'selectionStart'), false);
  assert.equal(snapshots.at(-1).status, 'uncertain');
});

test('an invalid beforeinput without a native input does not swallow the next valid edit', () => {
  const h = makeTextHarness();
  h.input.value = 'abc'; h.emit('input'); h.sent.length = 0;
  h.input.selectionStart = 1; h.input.selectionEnd = 2;
  h.emit('beforeinput', {inputType: 'insertText', preventDefault() {}});
  h.input.value = 'abcd\u200b'; h.emit('input');
  assert.deepEqual(h.sent, [{kind: 'text', value: 'd'}]);
  assert.equal(h.input.value, 'abcd\u200b');
});

test('plain input diff sends inserted Unicode as one text action', () => {
  const h = makeTextHarness(); h.input.value = 'hello'; h.emit('input');
  assert.deepEqual(h.sent, [{kind: 'text', value: 'hello'}]);
});

test('compositionend sends committed CJK text once despite the following input', () => {
  const h = makeTextHarness(); h.emit('compositionstart'); h.input.value = '中文';
  h.emit('compositionend'); h.emit('input');
  assert.deepEqual(h.sent, [{kind: 'text', value: '中文'}]);
});

test('deleteContentBackward sends bounded Backspace actions', () => {
  const h = makeTextHarness(); h.input.value = 'abcdefghijklmnopq'; h.emit('input'); h.sent.length = 0;
  h.input.value = 'a'; h.emit('beforeinput', {inputType: 'deleteContentBackward'}); h.emit('input');
  assert.equal(h.sent.filter((item) => item.value === 'Backspace').length, 16);
});

test('deletion beyond one bounded batch remains pending for retry', () => {
  const h = makeTextHarness(); h.input.value = 'abcdefghijklmnopqr'; h.emit('input'); h.sent.length = 0;
  h.input.value = ''; h.emit('input');
  h.emit('input');
  assert.equal(h.sent.filter((item) => item.value === 'Backspace').length, 18);
});

test('middle replacement is rejected instead of sending a remote Backspace', () => {
  const h = makeTextHarness(); h.input.value = 'abc'; h.emit('input'); h.sent.length = 0;
  h.input.selectionStart = 1; h.input.selectionEnd = 2;
  let prevented = false;
  h.emit('beforeinput', { inputType: 'insertText', preventDefault() { prevented = true; } });
  h.input.value = 'aXc\u200B'; h.emit('input');

  assert.equal(prevented, true);
  assert.deepEqual(h.sent, []);
  assert.equal(h.input.value, 'abc\u200B');
});

test('a reliable left arrow permits the matching middle insertion', () => {
  const h = makeTextHarness(); h.input.value = 'abc'; h.emit('input'); h.sent.length = 0;
  h.emit('keydown', { key: 'ArrowLeft', stopPropagation() {}, preventDefault() {} });
  h.input.value = 'abXc\u200B'; h.emit('input');

  assert.deepEqual(h.sent, [{kind: 'key', value: 'ArrowLeft'}, {kind: 'text', value: 'X'}]);
  assert.equal(h.input.value, 'abXc\u200B');
});

test('public navigation rejects a composition before the DOM value changes', () => {
  const h = makeTextHarness(); h.input.value = 'abc'; h.emit('input'); h.sent.length = 0;
  h.emit('compositionstart');

  assert.equal(h.adapter.sendControlKey('ArrowLeft'), false);
  assert.deepEqual(h.sent, []);
});

test('cursor-aware diff accepts a duplicate insertion after repeated left navigation', () => {
  const h = makeTextHarness(); h.input.value = 'abc'; h.emit('input'); h.sent.length = 0;
  h.emit('keydown', { key: 'ArrowLeft', stopPropagation() {}, preventDefault() {} });
  h.emit('keydown', { key: 'ArrowLeft', stopPropagation() {}, preventDefault() {} });
  assert.equal(h.input.selectionStart, 1);
  h.input.value = 'abbc\u200B'; h.input.selectionStart = 2; h.input.selectionEnd = 2;
  h.emit('input');

  assert.equal(h.input.value, 'abbc\u200B');
  assert.deepEqual(h.sent, [
    {kind: 'key', value: 'ArrowLeft'},
    {kind: 'key', value: 'ArrowLeft'},
    {kind: 'text', value: 'b'},
  ]);
  assert.equal(h.adapter.getSnapshot().status, 'idle');
});

test('cursor-aware diff rejects an accepted-history edit before the remote cursor', () => {
  const h = makeTextHarness(); h.input.value = 'abc'; h.emit('input'); h.sent.length = 0;
  h.emit('keydown', { key: 'ArrowLeft', stopPropagation() {}, preventDefault() {} });
  h.emit('keydown', { key: 'ArrowLeft', stopPropagation() {}, preventDefault() {} });
  h.input.value = 'xbc'; h.input.selectionStart = 1; h.input.selectionEnd = 1;
  h.emit('input');

  assert.equal(h.input.value, 'abc\u200B');
  assert.deepEqual(h.sent, [
    {kind: 'key', value: 'ArrowLeft'},
    {kind: 'key', value: 'ArrowLeft'},
  ]);
});

test('modifier navigation invalidates the local cursor history without changing the cursor', () => {
  const sent = [];
  const input = {
    value: '', selectionStart: 0, selectionEnd: 0,
    addEventListener(type, fn) { this.listeners.set(type, fn); },
    removeEventListener() {}, focus() {}, blur() {}, listeners: new Map(),
  };
  const adapter = MobileTextInput.create({
    element: input,
    sendText: (value) => { sent.push(['text', value]); return true; },
    sendKey: (value, modifiers) => { sent.push(['key', value, modifiers]); return true; },
    isEnabled: () => true,
  });
  adapter.attach();
  input.value = 'abc'; input.listeners.get('input')({target: input});
  input.listeners.get('keydown')({
    target: input, key: 'ArrowLeft', shiftKey: true, ctrlKey: false, altKey: false, metaKey: false,
    stopPropagation() {}, preventDefault() {},
  });

  assert.deepEqual(sent, [
    ['text', 'abc'],
    ['key', 'ArrowLeft', {shiftKey: true, ctrlKey: false, altKey: false, metaKey: false}],
  ]);
  input.value = 'fresh'; input.listeners.get('input')({target: input});
  assert.deepEqual(sent.at(-1), ['text', 'fresh']);
});

test('failed external navigation callback preserves accepted history and the local draft', () => {
  const h = makeTextHarness({sendKeyResult: false});
  h.input.value = 'abc'; h.emit('input');
  assert.equal(h.adapter.runExternalAction('context-change', () => false), false);
  h.input.value = 'abcd\u200b'; h.emit('input');
  assert.equal(h.input.value, 'abcd\u200b');
  assert.deepEqual(h.sent.filter((item) => item.kind === 'text').map((item) => item.value), ['abc', 'd']);
});

test('textarea keyup releases an already tracked key before local gates', () => {
  const released = [];
  const h = makeTextHarness();
  const adapter = MobileTextInput.create({
    element: h.input,
    sendText: () => false,
    sendKey: () => false,
    isEnabled: () => false,
    releaseTrackedKey: (event) => { released.push(event.code); return true; },
  });
  adapter.attach();
  adapter.onTransportState('blocked');
  h.emit('keyup', {code: 'ShiftLeft', stopPropagation() { this.stopped = true; }});
  assert.deepEqual(released, ['ShiftLeft']);
});

test('surrogate-pair Emoji is not split into invalid text', () => {
  const h = makeTextHarness(); h.input.value = '🙂'; h.emit('input');
  assert.deepEqual(h.sent, [{kind: 'text', value: '🙂'}]);
});

test('beforeinput absence still works through input diff', () => {
  const h = makeTextHarness(); h.input.value = 'fallback'; h.emit('input');
  assert.deepEqual(h.sent, [{kind: 'text', value: 'fallback'}]);
});

test('blocked lease preserves value and does not send text', () => {
  const h = makeTextHarness({enabled: false}); h.input.value = 'keep me'; h.emit('input');
  assert.deepEqual(h.sent, []); assert.equal(h.input.value, 'keep me');
});

test('reset retains only the invisible sentinel baseline', () => {
  const h = makeTextHarness(); h.input.value = 'text'; h.emit('input');
  h.adapter.reset('control-lost');
  assert.equal(h.input.value, '\u200B');
});

test('IME visibility asks ChromeLayout to refresh without owning viewport listeners', () => {
  let refreshes = 0;
  const h = makeTextHarness({ refreshViewport() { refreshes += 1; } });

  h.adapter.show();
  h.adapter.hide();

  assert.equal(refreshes, 3);
});
