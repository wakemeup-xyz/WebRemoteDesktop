const assert = require('node:assert/strict');
const test = require('node:test');

const { TerminalEchoController } = require('./terminal-echo-controller');


test('first printable input is a hidden probe and matching remote echo enables local echo', () => {
  const echo = TerminalEchoController.create();

  assert.deepEqual(echo.onInput('s'), { localEcho: '', probe: 's' });
  assert.equal(echo.snapshot().confident, false);
  assert.equal(echo.onRemoteOutput('s'), 's');
  assert.equal(echo.snapshot().confident, true);

  assert.deepEqual(echo.onInput('e'), { localEcho: 'e', probe: '' });
  assert.equal(echo.onRemoteOutput('e'), '');
});


test('non-echoing password input never becomes local output', () => {
  const echo = TerminalEchoController.create();

  assert.deepEqual(echo.onInput('Secret123'), { localEcho: '', probe: 'Secret123' });
  assert.equal(echo.snapshot().confident, false);
  assert.equal(echo.snapshot().awaitingProbe, true);
  assert.equal(echo.snapshot().pendingEchoBytes, 0);

  assert.deepEqual(echo.onInput('!'), { localEcho: '', probe: '' });
  assert.equal(echo.snapshot().confident, false);
});


test('remote control sequences pass through while confirmed local echo is deduplicated', () => {
  const echo = TerminalEchoController.create();

  echo.onInput('a');
  assert.equal(echo.onRemoteOutput('\u001b[?2004ha'), '\u001b[?2004ha');
  assert.deepEqual(echo.onInput('b'), { localEcho: 'b', probe: '' });
  assert.equal(echo.onRemoteOutput('\u001b[32mb'), '\u001b[32m');
});


test('enter, control input, alternate screen, and lifecycle resets clear echo confidence', () => {
  const resetInputs = ['\r', '\u0003', '\u001b'];
  resetInputs.forEach((input) => {
    const echo = TerminalEchoController.create();
    echo.onInput('x');
    echo.onRemoteOutput('x');
    assert.equal(echo.snapshot().confident, true);
    assert.deepEqual(echo.onInput(input), { localEcho: '', probe: '' });
    assert.equal(echo.snapshot().confident, false);
  });

  const echo = TerminalEchoController.create();
  echo.onInput('x');
  echo.onRemoteOutput('x');
  echo.setAlternateScreen(true);
  assert.equal(echo.snapshot().confident, false);
  assert.deepEqual(echo.onInput('y'), { localEcho: '', probe: '' });
  echo.setAlternateScreen(false);
  echo.onInput('z');
  echo.onRemoteOutput('z');
  echo.reset('disconnect');
  assert.equal(echo.snapshot().confident, false);
});


test('a mismatch disables previously confirmed optimistic echo', () => {
  const echo = TerminalEchoController.create();
  echo.onInput('a');
  echo.onRemoteOutput('a');
  assert.equal(echo.onInput('b').localEcho, 'b');

  assert.equal(echo.onRemoteOutput('x'), 'x');
  assert.equal(echo.snapshot().confident, false);
  assert.deepEqual(echo.onInput('c'), { localEcho: '', probe: 'c' });
});
