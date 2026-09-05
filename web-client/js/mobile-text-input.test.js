const assert = require('node:assert/strict');
const test = require('node:test');
const { MobileTextInput } = require('./mobile-text-input.js');

function makeTextHarness({enabled = true, refreshViewport = () => {}, sendTextResult = true, sendKeyResult = true, isDeliverySettled = true} = {}) {
  const listeners = new Map(); const sent = []; const failedAttempts = [];
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
    isEnabled: () => enabled,
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
    setDeliverySettled(value) { deliverySettled = Boolean(value); },
    emit(type, overrides = {}) {
      listeners.get(type)?.({type, target: input, inputType: null, ...overrides});
    },
  };
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

test('ordinary hide preserves the same-context pending draft', () => {
  const h = makeTextHarness({sendTextResult: false, isDeliverySettled: false});
  h.input.value = 'draft'; h.emit('input');
  h.adapter.show();
  h.adapter.hide();
  assert.equal(h.input.value, 'draft');
  assert.equal(h.adapter.getSnapshot().hasPending, true);
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
