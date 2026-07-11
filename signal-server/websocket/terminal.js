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
    const socketId = socket.id;
    const getTransportName = () => String(socket.conn?.transport?.name || 'unknown');
    audit.info('terminal_socket_connected', {
      socketId,
      clientId,
      subject: user?.sub || '',
      role: user?.role || '',
      transport: getTransportName(),
    });
    if (typeof socket.conn?.on === 'function') {
      socket.conn.on('upgrade', (transport) => {
        audit.info('terminal_socket_transport_upgrade', {
          socketId,
          clientId,
          transport: String(transport?.name || 'unknown'),
        });
      });
    }

    function emitPoolSnapshot() {
      const snapshot = sessionManager.getPoolSnapshot();
      terminalNamespace.emit('terminal:pool_snapshot', snapshot);
      terminalNamespace.emit('terminal:snapshot', snapshot);
    }

    function emitPresence(sessionId) {
      if (typeof sessionManager.getPresence !== 'function') {
        return;
      }
      terminalNamespace.emit('terminal:presence', sessionManager.getPresence(sessionId));
    }

    function bindSessionCallbacks(sessionId) {
      return {
        onData: (data) => {
          socket.emit('terminal:output', {
            sessionId,
            data,
          });
        },
        onExit: ({ exitCode, signal }) => {
          socket.emit('terminal:exit', {
            sessionId,
            exitCode,
            signal,
          });
        },
      };
    }

    function handleCreate(payload = {}) {
      try {
        const sessionRef = { sessionId: null };
        const created = sessionManager.createSession({
          clientId,
          socketId,
          title: payload.title,
          cols: payload.cols,
          rows: payload.rows,
          onData: (data) => {
            socket.emit('terminal:output', {
              sessionId: sessionRef.sessionId,
              data,
            });
          },
          onExit: ({ exitCode, signal }) => {
            socket.emit('terminal:exit', {
              sessionId: sessionRef.sessionId,
              exitCode,
              signal,
            });
          },
        });
        sessionRef.sessionId = created.sessionId;
        terminalNamespace.emit('terminal:session_created', created);
        terminalNamespace.emit('terminal:created', created);
        emitPoolSnapshot();
        emitPresence(created.sessionId);
        if (sessionManager.getPoolSnapshot().sessions.length > config.terminalSoftWarnSessionCount) {
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
    }

    function handleAttach(payload = {}) {
      try {
        const attached = sessionManager.attachSession(payload.sessionId, {
          clientId,
          socketId,
          cols: payload.cols,
          rows: payload.rows,
          ...bindSessionCallbacks(payload.sessionId),
        });
        socket.emit('terminal:replay', {
          sessionId: attached.sessionId,
          replay: attached.replay,
        });
        socket.emit('terminal:session_attached', attached);
        socket.emit('terminal:attached', attached);
        emitPresence(payload.sessionId);
        emitPoolSnapshot();
      } catch (err) {
        socket.emit('terminal:error', {
          code: err.code || 'terminal_attach_failed',
          message: err.message,
        });
      }
    }

    function handleDetach(payload = {}) {
      try {
        const detached = sessionManager.detachObserver(payload.sessionId, {
          clientId,
          socketId,
          reason: payload.reason || 'socket-detach',
        });
        socket.emit('terminal:session_detached', detached);
        socket.emit('terminal:detached', detached);
        emitPresence(payload.sessionId);
        emitPoolSnapshot();
      } catch (err) {
        socket.emit('terminal:error', {
          code: err.code || 'terminal_detach_failed',
          message: err.message,
        });
      }
    }

    function handleClose(payload = {}) {
      try {
        const closed = sessionManager.closeSession(payload.sessionId, {
          clientId,
          socketId,
          reason: payload.reason || 'user-close',
        });
        terminalNamespace.emit('terminal:session_closed', closed);
        terminalNamespace.emit('terminal:closed', closed);
        emitPoolSnapshot();
      } catch (err) {
        socket.emit('terminal:error', {
          code: err.code || 'terminal_close_failed',
          message: err.message,
        });
      }
    }

    function handleSetActivePresenter(payload = {}) {
      try {
        const updated = sessionManager.setActivePresenter(payload.sessionId, {
          clientId,
          socketId,
        });
        socket.emit('terminal:session_attached', updated);
        socket.emit('terminal:attached', updated);
        emitPresence(payload.sessionId);
        emitPoolSnapshot();
      } catch (err) {
        socket.emit('terminal:error', {
          code: err.code || 'terminal_set_active_presenter_failed',
          message: err.message,
        });
      }
    }

    const initialSnapshot = sessionManager.getPoolSnapshot();
    socket.emit('terminal:pool_snapshot', initialSnapshot);
    socket.emit('terminal:snapshot', initialSnapshot);

    socket.on('terminal:list', () => {
      const snapshot = sessionManager.getPoolSnapshot();
      socket.emit('terminal:pool_snapshot', snapshot);
      socket.emit('terminal:snapshot', snapshot);
    });

    socket.on('terminal:create_session', handleCreate);
    socket.on('terminal:attach_session', handleAttach);
    socket.on('terminal:detach_session', handleDetach);
    socket.on('terminal:close_session', handleClose);
    socket.on('terminal:set_active_presenter', handleSetActivePresenter);
    socket.on('terminal:set_active_session', handleSetActivePresenter);
    socket.on('terminal:create', handleCreate);
    socket.on('terminal:attach', handleAttach);
    socket.on('terminal:detach', handleDetach);
    socket.on('terminal:close', handleClose);
    socket.on('terminal:ping', (payload = {}) => {
      const serverReceivedAt = Date.now();
      socket.emit('terminal:pong', {
        nonce: typeof payload.nonce === 'string' ? payload.nonce : null,
        clientSentAt: Number.isFinite(Number(payload.clientSentAt))
          ? Number(payload.clientSentAt)
          : null,
        serverReceivedAt,
        serverSentAt: Date.now(),
        transport: getTransportName(),
      });
    });

    socket.on('terminal:input', (payload = {}) => {
      if (!payload.sessionId || !sessionManager.isObserverAttached(payload.sessionId, { clientId, socketId })) {
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
      try {
        const serverReceivedAt = Date.now();
        sessionManager.writeInput(payload.sessionId, {
          clientId,
          socketId,
          data,
        });
        socket.emit('terminal:input_ack', {
          sessionId: payload.sessionId,
          inputId: typeof payload.inputId === 'string' ? payload.inputId : null,
          clientSentAt: Number.isFinite(Number(payload.clientSentAt))
            ? Number(payload.clientSentAt)
            : null,
          serverReceivedAt,
          serverSentAt: Date.now(),
          bytes: Buffer.byteLength(data, 'utf8'),
          transport: getTransportName(),
        });
      } catch (err) {
        socket.emit('terminal:error', {
          code: err.code || 'terminal_input_failed',
          message: err.message,
        });
      }
    });

    socket.on('terminal:resize', (payload = {}) => {
      if (!payload.sessionId || !sessionManager.isObserverAttached(payload.sessionId, { clientId, socketId })) {
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
      sessionManager.resizeSession(payload.sessionId, {
        clientId,
        socketId,
        cols,
        rows,
      });
      emitPoolSnapshot();
    });

    socket.on('disconnect', () => {
      const disconnected = sessionManager.handleSocketDisconnect({
        clientId,
        socketId,
        reason: 'socket-disconnect',
      });
      for (const sessionId of disconnected.affectedSessionIds || []) {
        emitPresence(sessionId);
      }
      emitPoolSnapshot();
      audit.info('terminal_socket_disconnected', {
        socketId,
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
