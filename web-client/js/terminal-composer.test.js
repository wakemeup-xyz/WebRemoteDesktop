const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createTerminalDraftStore,
  getTerminalComposerUtf8ByteLength,
  normalizeTerminalComposerText,
  shouldSubmitTerminalComposerKey,
  serializeTerminalComposerInput,
} = require('./terminal-composer');

test('normalizes pasted CRLF text while preserving real LF newlines', () => {
  assert.equal(normalizeTerminalComposerText('first\r\nsecond\rthird'), 'first\nsecond\nthird');
});

test('submits only plain Enter and rejects modifier or IME Enter variants', () => {
  assert.equal(shouldSubmitTerminalComposerKey({ key: 'Enter', shiftKey: true, isComposing: false }), false);
  assert.equal(shouldSubmitTerminalComposerKey({ key: 'Enter', ctrlKey: true, isComposing: false }), false);
  assert.equal(shouldSubmitTerminalComposerKey({ key: 'Enter', altKey: true, isComposing: false }), false);
  assert.equal(shouldSubmitTerminalComposerKey({ key: 'Enter', metaKey: true, isComposing: false }), false);
  assert.equal(shouldSubmitTerminalComposerKey({ key: 'Process', shiftKey: false, isComposing: false }), false);
  assert.equal(shouldSubmitTerminalComposerKey({ key: 'Enter', keyCode: 229, shiftKey: false, isComposing: false }), false);
  assert.equal(shouldSubmitTerminalComposerKey({ key: 'Enter', shiftKey: false, isComposing: true }), false);
  assert.equal(shouldSubmitTerminalComposerKey({ key: 'Enter', shiftKey: false, isComposing: false }), true);
});

test('serializes a multiline draft with bracketed paste only when enabled', () => {
  const text = 'echo one\necho two';
  assert.equal(serializeTerminalComposerInput(text, { bracketedPasteEnabled: true }), '\x1b[200~echo one\necho two\x1b[201~\r');
  assert.equal(serializeTerminalComposerInput(text, { bracketedPasteEnabled: false }), 'echo one\necho two\r');
  assert.equal(serializeTerminalComposerInput('', { bracketedPasteEnabled: true }), '\r');
});

test('measures UTF-8 bytes instead of JavaScript character count', () => {
  assert.equal(getTerminalComposerUtf8ByteLength('plain'), 5);
  assert.equal(getTerminalComposerUtf8ByteLength('é'), 2);
  assert.equal(getTerminalComposerUtf8ByteLength('😀'), 4);
  assert.equal(getTerminalComposerUtf8ByteLength('😀abc\r'), 8);
});

test('keeps unsent drafts isolated by terminal session and deletes closed drafts', () => {
  const drafts = createTerminalDraftStore();
  drafts.set('term-a', 'first\nsecond');
  drafts.set('term-b', 'other');
  drafts.delete('term-a');
  assert.equal(drafts.get('term-a'), '');
  assert.equal(drafts.get('term-b'), 'other');
});
