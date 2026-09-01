const assert = require('node:assert/strict');
const test = require('node:test');
const { MobileTextInput } = require('./mobile-text-input.js');

function makeTextHarness({enabled = true} = {}) {
  const listeners = new Map(); const sent = [];
  const input = {
    value: '', selectionStart: 0, selectionEnd: 0,
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type) { listeners.delete(type); },
    focus() {}, blur() {},
  };
  const adapter = MobileTextInput.create({
    element: input,
    sendText: (value) => { sent.push({kind: 'text', value}); return `text-${sent.length}`; },
    sendKey: (value) => { sent.push({kind: 'key', value}); return `key-${sent.length}`; },
    isEnabled: () => enabled,
  });
  adapter.attach();
  return {
    input,
    sent,
    emit(type, overrides = {}) {
      listeners.get(type)?.({type, target: input, inputType: null, ...overrides});
    },
  };
}

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
