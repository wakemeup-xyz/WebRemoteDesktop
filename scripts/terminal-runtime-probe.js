const { io } = require('../signal-server/node_modules/socket.io/client-dist/socket.io.js');

const FORBIDDEN_ENV_NAME = /^(JWT_SECRET|WRD_TERMINAL_ADMIN_PASSWORD|VIEWER_ACCESS_PASSWORD|HOST_SHARED_SECRET|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|ANTHROPIC_AUTH_TOKEN|OPENAI_API_KEY|.*(?:API_KEY|TOKEN|PASSWORD|SECRET).*)$/;

function lastMarker(output, marker) {
  const matches = [...String(output || '').matchAll(new RegExp(`${marker}([^\\r\\n]*)`, 'g'))];
  return matches.at(-1)?.[1]?.trim() || '';
}

function runTerminalProbe(options = {}) {
  const baseUrl = String(options.baseUrl || '').replace(/\/$/, '');
  const token = String(options.token || '');
  if (!baseUrl || !token) {
    return Promise.reject(new Error('runtime Terminal probe requires baseUrl and token'));
  }

  return new Promise((resolve, reject) => {
    let sessionId = null;
    let output = '';
    let probeSent = false;
    let exited = false;
    let inputRejectedAfterExit = false;
    let inputAckAfterExit = false;
    let settled = false;
    let exitTimer = null;
    const socket = io(`${baseUrl}/terminal`, {
      auth: { token, role: 'admin', clientId: 'terminal-runtime-probe' },
      transports: ['websocket'],
      reconnection: false,
      timeout: 5000,
    });

    function finish(error) {
      if (settled) return;
      settled = true;
      if (exitTimer) clearTimeout(exitTimer);
      if (sessionId) socket.emit('terminal:close_session', { sessionId, reason: 'user-close' });
      socket.close();
      if (error) {
        reject(error);
        return;
      }
      const commandPython = lastMarker(output, '__WRD_COMMAND_V__');
      const envPython = lastMarker(output, '__WRD_ENV_PY__');
      const shell = lastMarker(output, '__WRD_SHELL__');
      const environmentNames = lastMarker(output, '__WRD_ENV_KEYS__')
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean);
      const expectedFragment = String(options.expectedPythonPathFragment || '');
      if (
        !commandPython.includes(expectedFragment)
        || !envPython.includes(expectedFragment)
      ) {
        reject(new Error('runtime Terminal probe resolved Python outside the expected path'));
        return;
      }
      resolve({
        shell,
        commandPython,
        envPython,
        forbiddenEnvNames: environmentNames.filter((name) => FORBIDDEN_ENV_NAME.test(name)),
        exited,
        inputRejectedAfterExit,
        inputAckAfterExit,
      });
    }

    function sendProbeCommand() {
      if (probeSent || !sessionId) return;
      probeSent = true;
      const newline = String.fromCharCode(10);
      socket.emit('terminal:input', {
        sessionId,
        inputId: 'runtime-probe',
        data: [
          "printf '__WRD_SHELL__%s\\n' \"$0\"",
          "printf '__WRD_COMMAND_V__'; command -v python3",
          "printf '__WRD_ENV_PY__'; /usr/bin/env python3 -c 'import sys; print(sys.executable)'",
          "printf '__WRD_ENV_KEYS__'; env | cut -d= -f1 | sort | tr '\\n' ','; printf '\\n'",
          "printf '__WRD_DONE__\\n'",
          'exit',
        ].join('; ') + newline,
      });
    }

    function handleCreated(payload = {}) {
      if (sessionId || !payload.sessionId) return;
      sessionId = payload.sessionId;
      if (payload.processStatus === 'running') sendProbeCommand();
    }

    socket.on('connect', () => {
      socket.emit('terminal:create_session', {
        cols: 120,
        rows: 32,
        title: 'Runtime acceptance probe',
        requestId: 'runtime-probe',
      });
    });
    socket.on('connect_error', (error) => finish(new Error(`terminal probe connect failed: ${error.message}`)));
    socket.on('terminal:session_created', handleCreated);
    socket.on('terminal:created', handleCreated);
    socket.on('terminal:output', (payload = {}, acknowledge) => {
      if (payload.sessionId === sessionId) {
        output += String(payload.data || '');
        sendProbeCommand();
      }
      if (typeof acknowledge === 'function') acknowledge();
    });
    socket.on('terminal:error', (payload = {}) => {
      if (payload.sessionId !== sessionId) return;
      if (payload.inputId === 'after-exit' || payload.code === 'pty_exited') {
        inputRejectedAfterExit = payload.code === 'pty_exited';
      }
    });
    socket.on('terminal:input_ack', (payload = {}) => {
      if (payload.inputId === 'after-exit') inputAckAfterExit = true;
    });
    socket.on('terminal:exit', (payload = {}) => {
      if (payload.sessionId !== sessionId || exited) return;
      exited = true;
      socket.emit('terminal:input', {
        sessionId,
        inputId: 'after-exit',
        data: `echo should-not-run${String.fromCharCode(10)}`,
      });
      exitTimer = setTimeout(() => {
        if (!inputRejectedAfterExit) {
          finish(new Error('runtime Terminal probe did not reject exited input'));
          return;
        }
        finish(null);
      }, 500);
      exitTimer.unref?.();
    });
    setTimeout(() => finish(new Error('runtime Terminal probe timed out')), 15000).unref?.();
  });
}

if (require.main === module) {
  const [baseUrl, token, expectedPythonPathFragment] = process.argv.slice(2);
  runTerminalProbe({ baseUrl, token, expectedPythonPathFragment })
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`terminal-runtime-probe: ${error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = { runTerminalProbe };
