const PROCESS_STATUS = Object.freeze({
  STARTING: 'starting',
  RUNNING: 'running',
  EXITED: 'exited',
  FAILED: 'failed',
  CLOSED: 'closed',
});

const ERROR_MESSAGES = Object.freeze({
  pty_spawn_failed: 'Unable to start terminal process',
  pty_starting: 'Terminal process is still starting',
  pty_startup_timeout: 'Terminal process startup timed out',
  pty_exited: 'Terminal process has exited',
  pty_cleanup_failed: 'Unable to clean up terminal process',
});

const TRANSITIONS = Object.freeze({
  [PROCESS_STATUS.STARTING]: Object.freeze({
    ready: PROCESS_STATUS.RUNNING,
    exit: PROCESS_STATUS.FAILED,
    timeout: PROCESS_STATUS.FAILED,
    close: PROCESS_STATUS.CLOSED,
  }),
  [PROCESS_STATUS.RUNNING]: Object.freeze({
    exit: PROCESS_STATUS.EXITED,
    close: PROCESS_STATUS.CLOSED,
  }),
  [PROCESS_STATUS.EXITED]: Object.freeze({ close: PROCESS_STATUS.CLOSED }),
  [PROCESS_STATUS.FAILED]: Object.freeze({ close: PROCESS_STATUS.CLOSED }),
  [PROCESS_STATUS.CLOSED]: Object.freeze({ close: PROCESS_STATUS.CLOSED }),
});

const DEFAULT_PTY_KILL_SIGNALS = Object.freeze(['SIGHUP', 'SIGTERM', 'SIGKILL']);

function makeTerminalError(code, message, details) {
  let normalizedMessage = message;
  let normalizedDetails = details;
  if (message && typeof message === 'object') {
    normalizedDetails = message;
    normalizedMessage = '';
  }
  const error = new Error(String(normalizedMessage || ERROR_MESSAGES[code] || code));
  error.code = code;
  if (normalizedDetails && typeof normalizedDetails === 'object') {
    error.details = Object.freeze({ ...normalizedDetails });
  }
  return error;
}

function transitionProcessState(current, event) {
  const next = TRANSITIONS[current]?.[event];
  if (!next) {
    throw new Error(`invalid terminal lifecycle transition: ${current} + ${event}`);
  }
  return next;
}

function assertProcessWritable(status) {
  if (status === PROCESS_STATUS.RUNNING) {
    return true;
  }
  if (status === PROCESS_STATUS.STARTING) {
    throw makeTerminalError('pty_starting');
  }
  throw makeTerminalError('pty_exited');
}

function planPtyKillSignals(options = {}) {
  const waitMs = Math.max(0, Number(options.waitMs) || 0);
  const signals = Array.isArray(options.signals) && options.signals.length > 0
    ? options.signals
    : DEFAULT_PTY_KILL_SIGNALS;
  return Object.freeze(
    signals.map((signal) => Object.freeze({
      signal: String(signal),
      waitMs,
    })),
  );
}

function defaultDelay(ms) {
  const waitMs = Math.max(0, Number(ms) || 0);
  if (waitMs <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, waitMs);
  });
}

async function cleanupPtyWithEscalation(pty, options = {}) {
  const steps = Array.isArray(options.steps) && options.steps.length > 0
    ? options.steps
    : planPtyKillSignals(options);
  const waitForExit = typeof options.waitForExit === 'function'
    ? options.waitForExit
    : async () => false;
  const isAlive = typeof options.isAlive === 'function'
    ? options.isAlive
    : () => true;
  const delay = typeof options.delay === 'function'
    ? options.delay
    : defaultDelay;
  const signalsSent = [];

  if (!pty || typeof pty.kill !== 'function') {
    return {
      killed: true,
      confirmed: true,
      attempted: false,
      signalsSent,
    };
  }

  if (!isAlive()) {
    return {
      killed: true,
      confirmed: true,
      attempted: false,
      signalsSent,
    };
  }

  for (const step of steps) {
    const signal = String(step?.signal || '');
    try {
      pty.kill(signal);
      signalsSent.push(signal);
    } catch (error) {
      return {
        killed: false,
        confirmed: false,
        attempted: true,
        signalsSent,
        error,
      };
    }

    const waitMs = Math.max(0, Number(step?.waitMs) || 0);
    if (waitMs > 0) {
      await delay(waitMs);
    }

    const exited = Boolean(await waitForExit(step));
    if (exited || !isAlive()) {
      return {
        killed: true,
        confirmed: true,
        attempted: true,
        signalsSent,
        finalSignal: signal,
      };
    }
  }

  return {
    killed: false,
    confirmed: false,
    attempted: signalsSent.length > 0,
    signalsSent,
  };
}

module.exports = {
  PROCESS_STATUS,
  assertProcessWritable,
  cleanupPtyWithEscalation,
  makeTerminalError,
  planPtyKillSignals,
  transitionProcessState,
};
