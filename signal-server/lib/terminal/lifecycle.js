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

module.exports = {
  PROCESS_STATUS,
  assertProcessWritable,
  makeTerminalError,
  transitionProcessState,
};
