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

  const cleanupError = makeTerminalError('pty_cleanup_failed');
  assert.equal(cleanupError.code, 'pty_cleanup_failed');
  assert.equal(cleanupError.message, 'Unable to clean up terminal process');
});

test('planPtyKillSignals freezes SIGHUP → SIGTERM → SIGKILL steps with wait budgets', () => {
  const { planPtyKillSignals } = lifecycle;
  const steps = planPtyKillSignals({ waitMs: 0 });

  assert.equal(Object.isFrozen(steps), true);
  assert.deepEqual(
    steps.map((step) => ({ signal: step.signal, waitMs: step.waitMs })),
    [
      { signal: 'SIGHUP', waitMs: 0 },
      { signal: 'SIGTERM', waitMs: 0 },
      { signal: 'SIGKILL', waitMs: 0 },
    ],
  );
  assert.equal(Object.isFrozen(steps[0]), true);
});

test('cleanup escalates SIGHUP to SIGTERM to SIGKILL and waits for confirmed exit', async () => {
  const { cleanupPtyWithEscalation } = lifecycle;
  const signals = [];
  const pty = {
    kill(sig) {
      signals.push(sig);
    },
  };

  const result = await cleanupPtyWithEscalation(pty, {
    waitForExit: async () => signals.at(-1) === 'SIGKILL',
    isAlive: () => signals.length < 3,
    steps: [
      { signal: 'SIGHUP', waitMs: 0 },
      { signal: 'SIGTERM', waitMs: 0 },
      { signal: 'SIGKILL', waitMs: 0 },
    ],
  });

  assert.deepEqual(signals, ['SIGHUP', 'SIGTERM', 'SIGKILL']);
  assert.equal(result.killed, true);
  assert.equal(result.confirmed, true);
  assert.deepEqual(result.signalsSent, ['SIGHUP', 'SIGTERM', 'SIGKILL']);
});

test('cleanupPtyWithEscalation stops early when exit is confirmed after SIGHUP', async () => {
  const { cleanupPtyWithEscalation } = lifecycle;
  const signals = [];
  const pty = {
    kill(sig) {
      signals.push(sig);
    },
  };

  const result = await cleanupPtyWithEscalation(pty, {
    waitForExit: async () => signals.at(-1) === 'SIGHUP',
    isAlive: () => signals.length === 0,
    steps: [
      { signal: 'SIGHUP', waitMs: 0 },
      { signal: 'SIGTERM', waitMs: 0 },
      { signal: 'SIGKILL', waitMs: 0 },
    ],
  });

  assert.deepEqual(signals, ['SIGHUP']);
  assert.equal(result.killed, true);
  assert.equal(result.finalSignal, 'SIGHUP');
});

test('cleanupPtyWithEscalation treats kill throw as hard failure without pretending success', async () => {
  const { cleanupPtyWithEscalation } = lifecycle;
  const signals = [];
  const pty = {
    kill(sig) {
      signals.push(sig);
      throw new Error('kill failed SECRET');
    },
  };

  const result = await cleanupPtyWithEscalation(pty, {
    waitForExit: async () => false,
    isAlive: () => true,
    steps: [
      { signal: 'SIGHUP', waitMs: 0 },
      { signal: 'SIGTERM', waitMs: 0 },
      { signal: 'SIGKILL', waitMs: 0 },
    ],
  });

  assert.deepEqual(signals, ['SIGHUP']);
  assert.equal(result.killed, false);
  assert.equal(result.confirmed, false);
  assert.equal(result.error instanceof Error, true);
});
