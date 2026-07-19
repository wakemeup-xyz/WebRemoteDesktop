const { loadConfig } = require('../lib/config');
const { verifyAccessToken } = require('../lib/auth');
const { createTerminalSessionManager } = require('../lib/terminal/session-manager');
const { createTerminalAudit } = require('../lib/terminal/audit');
const { TerminalMetrics } = require('../lib/terminal/metrics');

function getToken(socket) {
  return socket.handshake?.auth?.token || null;
}

function getClientLabel(socket) {
  const rawLabel = socket.handshake?.auth?.clientId;
  return rawLabel === undefined || rawLabel === null
    ? null
    : String(rawLabel).slice(0, 128);
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
  const metrics = options.metrics || options.sessionManager?.metrics || new TerminalMetrics();
  const sessionManager = options.sessionManager || createTerminalSessionManager({
    config,
    logger: options.logger || console,
    audit,
    metrics,
  });
  const metricNow = typeof options.metricNow === 'function' ? options.metricNow : () => performance.now();

  const terminalNamespace = io.of('/terminal');
  let idleReaperTimer = null;
  if (
    Number(config.terminalIdleTimeoutMs) > 0
    && typeof sessionManager.reapIdleSessions === 'function'
  ) {
    const intervalMs = Math.min(60000, Math.max(1000, Math.floor(Number(config.terminalIdleTimeoutMs) / 2)));
    idleReaperTimer = setInterval(() => {
      const reaped = sessionManager.reapIdleSessions();
      if (!reaped.length) return;
      const snapshot = sessionManager.getPoolSnapshot();
      terminalNamespace.emit('terminal:pool_snapshot', snapshot);
      terminalNamespace.emit('terminal:snapshot', snapshot);
    }, intervalMs);
    idleReaperTimer.unref?.();
  }

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
    const clientId = socket.id;
    const socketId = socket.id;
    const clientLabel = getClientLabel(socket);
    const getTransportName = () => String(socket.conn?.transport?.name || 'unknown');
    metrics.recordCounter('socket_connected');
    audit.info('terminal_socket_connected', {
      socketId,
      clientId,
      clientLabel,
      subject: user?.sub || '',
      role: user?.role || '',
      transport: getTransportName(),
    });
    if (typeof socket.conn?.on === 'function') {
      socket.conn.on('upgrade', (transport) => {
        audit.info('terminal_socket_transport_upgrade', {
          socketId,
          clientId,
          clientLabel,
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

    function requireAttachedSession(sessionId, rejectionEvent) {
      let attached = false;
      try {
        attached = Boolean(
          sessionId
          && sessionManager.isObserverAttached(sessionId, { clientId, socketId }),
        );
      } catch (err) {
        if (err.code !== 'terminal_session_not_found') {
          throw err;
        }
      }
      if (attached) {
        return true;
      }
      audit.warn(rejectionEvent, {
        sessionId: sessionId || null,
        clientId,
        socketId,
        code: 'terminal_session_not_found',
        reason: 'observer_not_attached',
      });
      socket.emit('terminal:error', {
        code: 'terminal_session_not_found',
        message: 'Terminal session not found',
      });
      return false;
    }

    function bindSessionCallbacks(sessionId) {
      return {
        onData: (data, metadata, acknowledge) => {
          socket.emit('terminal:output', {
            sessionId: metadata?.sessionId || sessionId,
            data,
          }, acknowledge);
        },
        onError: (error, metadata = {}) => {
          socket.emit('terminal:error', {
            sessionId: metadata.sessionId || error.details?.sessionId || sessionId,
            code: error.code || 'terminal_process_failed',
            message: error.message,
          });
        },
        onExit: ({ sessionId: callbackSessionId, exitCode, signal, errorCode, processStatus }) => {
          socket.emit('terminal:exit', {
            sessionId: callbackSessionId || sessionId,
            exitCode,
            signal,
            errorCode,
            processStatus,
          });
        },
        onWarning: ({ code, stats }) => {
          socket.emit('terminal:warning', {
            sessionId,
            code,
            stats,
          });
        },
        onPresence: ({ presence, pool }) => {
          terminalNamespace.emit('terminal:presence', presence);
          terminalNamespace.emit('terminal:pool_snapshot', pool);
          terminalNamespace.emit('terminal:snapshot', pool);
        },
      };
    }

    function handleCreate(payload = {}) {
      try {
        const requestId = typeof payload.requestId === 'string'
          ? payload.requestId.slice(0, 128)
          : null;
        const sessionRef = { sessionId: null };
        const pendingLifecycleEvents = [];
        const emitLifecycleEvent = (event, eventPayload, acknowledge) => {
          if (!sessionRef.sessionId) {
            pendingLifecycleEvents.push({ event, payload: eventPayload, acknowledge });
            return;
          }
          const correlatedPayload = {
            ...eventPayload,
            sessionId: eventPayload.sessionId || sessionRef.sessionId,
          };
          if (typeof acknowledge === 'function') {
            socket.emit(event, correlatedPayload, acknowledge);
          } else {
            socket.emit(event, correlatedPayload);
          }
        };
        const created = sessionManager.createSession({
          clientId,
          socketId,
          title: payload.title,
          cols: payload.cols,
          rows: payload.rows,
          onData: (data, metadata, acknowledge) => {
            emitLifecycleEvent('terminal:output', {
              sessionId: metadata?.sessionId || null,
              data,
            }, acknowledge);
          },
          onError: (error, metadata = {}) => {
            emitLifecycleEvent('terminal:error', {
              sessionId: metadata.sessionId || error.details?.sessionId || null,
              code: error.code || 'terminal_process_failed',
              message: error.message,
            });
          },
          onExit: ({ sessionId, exitCode, signal, errorCode, processStatus }) => {
            emitLifecycleEvent('terminal:exit', {
              sessionId: sessionId || null,
              exitCode,
              signal,
              errorCode,
              processStatus,
            });
          },
          onWarning: ({ code, stats }) => {
            emitLifecycleEvent('terminal:warning', {
              code,
              stats,
            });
          },
          onPresence: ({ presence, pool }) => {
            if (!sessionRef.sessionId) return;
            terminalNamespace.emit('terminal:presence', presence);
            terminalNamespace.emit('terminal:pool_snapshot', pool);
            terminalNamespace.emit('terminal:snapshot', pool);
          },
        });
        sessionRef.sessionId = created.sessionId;
        const creatorPayload = { ...created, requestId };
        socket.emit('terminal:session_created', creatorPayload);
        socket.emit('terminal:created', creatorPayload);
        socket.broadcast.emit('terminal:session_created', created);
        socket.broadcast.emit('terminal:created', created);
        for (const pending of pendingLifecycleEvents) {
          const correlatedPayload = {
            ...pending.payload,
            sessionId: pending.payload.sessionId || created.sessionId,
          };
          if (typeof pending.acknowledge === 'function') {
            socket.emit(pending.event, correlatedPayload, pending.acknowledge);
          } else {
            socket.emit(pending.event, correlatedPayload);
          }
        }
        pendingLifecycleEvents.length = 0;
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
          reason: 'user-close',
        });
        terminalNamespace.emit('terminal:session_closed', closed);
        terminalNamespace.emit('terminal:closed', closed);
        emitPoolSnapshot();
      } catch (err) {
        const code = err.code || 'terminal_close_failed';
        if (code === 'terminal_session_not_attached' || code === 'terminal_session_not_found') {
          audit.warn('terminal_close_rejected', {
            sessionId: payload.sessionId || null,
            clientId,
            socketId,
            code,
            reason: code === 'terminal_session_not_attached'
              ? 'observer_not_attached'
              : 'session_not_found',
          });
        }
        socket.emit('terminal:error', {
          sessionId: payload.sessionId || null,
          code,
          message: err.message,
        });
        emitPoolSnapshot();
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
      if (!requireAttachedSession(payload.sessionId, 'terminal_input_rejected')) {
        metrics.recordCounter('input_rejected');
        return;
      }
      const data = String(payload.data || '');
      if (Buffer.byteLength(data, 'utf8') > 64 * 1024) {
        metrics.recordCounter('input_rejected');
        audit.warn('terminal_input_rejected', {
          sessionId: payload.sessionId,
          clientId,
          socketId,
          code: 'terminal_input_too_large',
          bytes: Buffer.byteLength(data, 'utf8'),
          maxBytes: 64 * 1024,
        });
        socket.emit('terminal:error', {
          code: 'terminal_input_too_large',
          message: 'Terminal input exceeds 64KB',
        });
        return;
      }
      const processingStartedAt = metricNow();
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
        const code = err.code || 'terminal_input_failed';
        if (code !== 'terminal_input_rate_limited') {
          metrics.recordCounter('input_rejected');
        }
        if (code !== 'terminal_input_rate_limited') {
          audit.error('terminal_error', {
            sessionId: payload.sessionId || null,
            clientId,
            socketId,
            action: 'input',
            code,
            message: err.message,
          });
        }
        socket.emit('terminal:error', {
          sessionId: payload.sessionId || null,
          code,
          message: err.message,
          ...(err.details ? { details: err.details } : {}),
        });
      } finally {
        metrics.recordLatency(
          'server_input_process_ms',
          Math.max(0, Number(metricNow()) - Number(processingStartedAt)),
        );
      }
    });

    socket.on('terminal:resize', (payload = {}) => {
      if (!requireAttachedSession(payload.sessionId, 'terminal_resize_rejected')) {
        return;
      }
      const cols = Number(payload.cols);
      const rows = Number(payload.rows);
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 10 || cols > 300 || rows < 5 || rows > 100) {
        audit.warn('terminal_resize_rejected', {
          sessionId: payload.sessionId,
          clientId,
          socketId,
          code: 'terminal_resize_out_of_range',
          cols,
          rows,
        });
        socket.emit('terminal:error', {
          code: 'terminal_resize_out_of_range',
          message: 'Terminal resize is out of range',
        });
        return;
      }
      try {
        sessionManager.resizeSession(payload.sessionId, {
          clientId,
          socketId,
          cols,
          rows,
        });
        emitPoolSnapshot();
      } catch (err) {
        audit.error('terminal_error', {
          sessionId: payload.sessionId || null,
          clientId,
          socketId,
          action: 'resize',
          code: err.code || 'terminal_resize_failed',
          message: err.message,
        });
        socket.emit('terminal:error', {
          code: err.code || 'terminal_resize_failed',
          message: err.message,
        });
      }
    });

    socket.on('disconnect', () => {
      metrics.recordCounter('socket_disconnected');
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
        clientLabel,
        subject: user?.sub || '',
      });
    });
  });

  return {
    namespace: terminalNamespace,
    sessionManager,
    metrics,
    close() {
      if (idleReaperTimer) clearInterval(idleReaperTimer);
      idleReaperTimer = null;
    },
  };
}

module.exports = {
  setupTerminal,
};
