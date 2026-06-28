const { loadConfig } = require('../lib/config');
const { verifyAccessToken } = require('../lib/auth');
const { createTerminalSessionManager } = require('../lib/terminal/session-manager');
const { createTerminalAudit } = require('../lib/terminal/audit');

function getToken(socket) {
  return socket.handshake?.auth?.token || null;
}

function getClientId(socket) {
  return socket.handshake?.auth?.clientId || socket.id;
}

function authenticate(socket) {
  const token = getToken(socket);
  if (!token) {
    throw Object.assign(new Error('Authentication required'), { code: 'auth_required' });
  }
  const decoded = verifyAccessToken(token);
  if (decoded.role !== 'admin') {
    throw Object.assign(new Error('Admin role required'), { code: 'admin_required' });
  }
  socket.user = decoded;
  return decoded;
}

function setupTerminal(io, options = {}) {
  const config = options.config || loadConfig();
  const audit = options.audit || createTerminalAudit(options.logger || console);
  const sessionManager = options.sessionManager || createTerminalSessionManager({
    config,
    logger: options.logger || console,
    audit,
  });

  const terminalNamespace = io.of('/terminal');

  terminalNamespace.use((socket, next) => {
    try {
      authenticate(socket);
      if (!config.enableTerminal) {
        throw Object.assign(new Error('Terminal disabled'), { code: 'terminal_disabled' });
      }
      if (!config.terminalAdminPassword) {
        throw Object.assign(new Error('Terminal admin password not configured'), {
          code: 'terminal_admin_password_missing',
        });
      }
      next();
    } catch (err) {
      next(err);
    }
  });

  terminalNamespace.on('connection', (socket) => {
    const user = socket.user;
    const clientId = getClientId(socket);
    audit.info('terminal_socket_connected', {
      socketId: socket.id,
      clientId,
      subject: user?.sub || '',
      role: user?.role || '',
    });

    socket.emit('terminal:snapshot', sessionManager.getSnapshot());

    socket.on('terminal:list', () => {
      socket.emit('terminal:snapshot', sessionManager.getSnapshot());
    });

    socket.on('terminal:create', (payload = {}) => {
      try {
        const created = sessionManager.createSession({
          ownerSub: user.sub,
          title: payload.title,
          cols: payload.cols,
          rows: payload.rows,
          onData: (data) => {
            socket.emit('terminal:output', {
              sessionId: created.sessionId,
              data,
            });
          },
          onExit: ({ exitCode, signal }) => {
            socket.emit('terminal:exit', {
              sessionId: created.sessionId,
              exitCode,
              signal,
            });
          },
        });
        socket.emit('terminal:created', created);
        if (sessionManager.getSnapshot().sessions.length > config.terminalSoftWarnSessionCount) {
          socket.emit('terminal:warning', {
            warning: 'session_count_above_soft_threshold',
            message: 'Terminal session count is high',
          });
        }
      } catch (err) {
        socket.emit('terminal:error', {
          code: err.code || 'terminal_create_failed',
          message: err.message,
        });
      }
    });

    socket.on('terminal:attach', (payload = {}) => {
      try {
        const attached = sessionManager.attachSession(payload.sessionId, {
          ownerSub: user.sub,
          cols: payload.cols,
          rows: payload.rows,
          onData: (data) => {
            socket.emit('terminal:output', {
              sessionId: attached.sessionId,
              data,
            });
          },
          onExit: ({ exitCode, signal }) => {
            socket.emit('terminal:exit', {
              sessionId: attached.sessionId,
              exitCode,
              signal,
            });
          },
        });
        socket.emit('terminal:attached', attached);
        socket.emit('terminal:snapshot', sessionManager.getSnapshot());
      } catch (err) {
        socket.emit('terminal:error', {
          code: err.code || 'terminal_attach_failed',
          message: err.message,
        });
      }
    });

    socket.on('terminal:detach', (payload = {}) => {
      try {
        const detached = sessionManager.detachSession(payload.sessionId, payload.reason || 'socket-disconnect');
        socket.emit('terminal:detached', detached);
      } catch (err) {
        socket.emit('terminal:error', {
          code: err.code || 'terminal_detach_failed',
          message: err.message,
        });
      }
    });

    socket.on('terminal:close', (payload = {}) => {
      try {
        const closed = sessionManager.closeSession(payload.sessionId, payload.reason || 'user-close');
        socket.emit('terminal:closed', closed);
        socket.emit('terminal:snapshot', sessionManager.getSnapshot());
      } catch (err) {
        socket.emit('terminal:error', {
          code: err.code || 'terminal_close_failed',
          message: err.message,
        });
      }
    });

    socket.on('terminal:input', (payload = {}) => {
      const session = sessionManager._getSession ? sessionManager._getSession(payload.sessionId) : null;
      if (!session || session.ownerSub !== user.sub) {
        socket.emit('terminal:error', {
          code: 'terminal_session_not_found',
          message: 'Terminal session not found',
        });
        return;
      }
      const data = String(payload.data || '');
      if (Buffer.byteLength(data, 'utf8') > 64 * 1024) {
        socket.emit('terminal:error', {
          code: 'terminal_input_too_large',
          message: 'Terminal input exceeds 64KB',
        });
        return;
      }
      if (session.pty && typeof session.pty.write === 'function') {
        session.pty.write(data);
      }
    });

    socket.on('terminal:resize', (payload = {}) => {
      const session = sessionManager._getSession ? sessionManager._getSession(payload.sessionId) : null;
      if (!session || session.ownerSub !== user.sub) {
        socket.emit('terminal:error', {
          code: 'terminal_session_not_found',
          message: 'Terminal session not found',
        });
        return;
      }
      const cols = Number(payload.cols);
      const rows = Number(payload.rows);
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 10 || cols > 300 || rows < 5 || rows > 100) {
        socket.emit('terminal:error', {
          code: 'terminal_resize_out_of_range',
          message: 'Terminal resize is out of range',
        });
        return;
      }
      if (session.pty && typeof session.pty.resize === 'function') {
        session.pty.resize(cols, rows);
      }
    });

    socket.on('disconnect', () => {
      audit.info('terminal_socket_disconnected', {
        socketId: socket.id,
        clientId,
        subject: user?.sub || '',
      });
    });
  });

  return {
    namespace: terminalNamespace,
    sessionManager,
  };
}

module.exports = {
  setupTerminal,
};
