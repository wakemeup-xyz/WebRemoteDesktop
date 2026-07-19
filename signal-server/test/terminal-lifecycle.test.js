const assert = require('node:assert/strict');
const test = require('node:test');

let lifecycle = {};
try {
  lifecycle = require('../lib/terminal/lifecycle');
} catch {
  // RED: the lifecycle module does not exist yet.
}

test('terminal lifecycle exposes frozen process states and valid transitions', () => {
  const { PROCESS_STATUS, transitionProcessState } = lifecycle;

  assert.equal(Object.isFrozen(PROCESS_STATUS), true);
  assert.equal(transitionProcessState(PROCESS_STATUS.STARTING, 'ready'), PROCESS_STATUS.RUNNING);
  assert.equal(transitionProcessState(PROCESS_STATUS.RUNNING, 'exit'), PROCESS_STATUS.EXITED);
  assert.equal(transitionProcessState(PROCESS_STATUS.STARTING, 'exit'), PROCESS_STATUS.FAILED);
  assert.equal(transitionProcessState(PROCESS_STATUS.STARTING, 'timeout'), PROCESS_STATUS.FAILED);
  for (const status of Object.values(PROCESS_STATUS)) {
    assert.equal(transitionProcessState(status, 'close'), PROCESS_STATUS.CLOSED);
  }
  assert.throws(
    () => transitionProcessState(PROCESS_STATUS.CLOSED, 'ready'),
    /invalid terminal lifecycle transition/,
  );
});

test('terminal lifecycle only permits writes while the process is running', () => {
  const { PROCESS_STATUS, assertProcessWritable } = lifecycle;

  assert.doesNotThrow(() => assertProcessWritable(PROCESS_STATUS.RUNNING));
  assert.throws(
    () => assertProcessWritable(PROCESS_STATUS.STARTING),
    (error) => error.code === 'pty_starting',
  );
  for (const status of [PROCESS_STATUS.EXITED, PROCESS_STATUS.FAILED, PROCESS_STATUS.CLOSED]) {
    assert.throws(
      () => assertProcessWritable(status),
      (error) => error.code === 'pty_exited',
    );
  }
});

test('terminal lifecycle creates stable errors without exposing mutable detail objects', () => {
  const { makeTerminalError } = lifecycle;
  const details = { sessionId: 'term-1' };
  const error = makeTerminalError('pty_spawn_failed', 'Unable to start terminal', details);

  assert.equal(error.code, 'pty_spawn_failed');
  assert.equal(error.message, 'Unable to start terminal');
  assert.deepEqual(error.details, details);
  assert.notEqual(error.details, details);
});
