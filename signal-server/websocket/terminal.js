const { loadConfig } = require('../lib/config');
const { verifyAccessToken } = require('../lib/auth');
const { createTerminalSessionManager } = require('../lib/terminal/session-manager');
const { createTerminalAudit } = require('../lib/terminal/audit');
const { TerminalMetrics } = require('../lib/terminal/metrics');
const { createTerminalWebRtcGateway } = require('../lib/terminal/webrtc-gateway');

const TERMINAL_EVENT_ALIASES = Object.freeze({
  pool_snapshot: ['snapshot'],
  session_created: ['created'],
  session_attached: ['attached'],
  session_detached: ['detached'],
  session_closed: ['closed'],
});
const TERMINAL_PROTOCOL_VERSION = '2026-08-30';

function getToken(socket) {
  return socket.handshake?.auth?.token || null;
}

function getClientLabel(socket) {
  const rawLabel = socket.handshake?.auth?.clientId;
  return rawLabel === undefined || rawLabel === null
    ? null
    : String(rawLabel).slice(0, 128);
}

function normalizeOperationId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 128);
}

function buildOperationCorrelation(action, payload = {}) {
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : null;
  const operationId = normalizeOperationId(payload.operationId);
  const correlation = { action, sessionId };
  if (operationId) correlation.operationId = operationId;
  return correlation;
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
  const managerMetrics = options.sessionManager?.metrics || null;
  if (options.metrics && managerMetrics && options.metrics !== managerMetrics) {
    throw new Error('[terminal] Explicit metrics instance must match sessionManager.metrics');
  }
  const metrics = options.metrics || managerMetrics || new TerminalMetrics();
  const sessionManager = options.sessionManager || createTerminalSessionManager({
    config,
    logger: options.logger || console,
    audit,
    metrics,
  });
  const metricNow = typeof options.metricNow === 'function' ? options.metricNow : () => performance.now();
  const webrtcGateway = options.webrtcGateway || createTerminalWebRtcGateway({
    config,
    logger: options.logger || console,
    audit,
    sessionManager,
    metricNow,
  });

  const terminalNamespace = io.of('/terminal');
  const aliasHitCounters = new Map();
  function recordAliasHit(alias, canonical) {
    const key = String(alias || '');
    if (!key) return;
    const count = Math.min(1000000, (aliasHitCounters.get(key) || 0) + 1);
    aliasHitCounters.set(key, count);
    audit.info('terminal_legacy_alias_hit', {
      alias: key,
      canonical,
      count,
      protocolVersion: TERMINAL_PROTOCOL_VERSION,
    });
  }
  function emitCanonical(target, canonical, payload, acknowledge) {
    const event = `terminal:${canonical}`;
    if (typeof acknowledge === 'function') {
      target.emit(event, payload, acknowledge);
    } else {
      target.emit(event, payload);
    }
    for (const alias of TERMINAL_EVENT_ALIASES[canonical] || []) {
      if (typeof acknowledge === 'function') {
        target.emit(`terminal:${alias}`, payload, acknowledge);
      } else {
        target.emit(`terminal:${alias}`, payload);
      }
    }
  }
  function redactCallerPresenter(snapshot = {}) {
    const { isPresenter, callerIsPresenter, ...shared } = snapshot;
    return shared;
  }
  let idleReaperTimer = null;
  if (
    Number(config.terminalIdleTimeoutMs) > 0
    && typeof sessionManager.reapIdleSessions === 'function'
  ) {
    const intervalMs = Math.min(60000, Math.max(1000, Math.floor(Number(config.terminalIdleTimeoutMs) / 2)));
    idleReaperTimer = setInterval(() => {
      Promise.resolve(sessionManager.reapIdleSessions())
        .then((reaped) => {
          if (!reaped.length) return;
          const snapshot = sessionManager.getPoolSnapshot();
          emitCanonical(terminalNamespace, 'pool_snapshot', snapshot);
        })
        .catch((error) => {
          audit.error('terminal_idle_reap_failed', {
            code: error?.code || 'terminal_idle_reap_failed',
            message: error?.message || 'idle reap failed',
          });
        });
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
      // Socket.IO namespaces expose connected sockets in production. Emit a
      // caller-aware snapshot there so presenter flags remain truthful; the
      // test adapter/fallback still receives one shared snapshot.
      if (terminalNamespace.sockets?.forEach) {
        terminalNamespace.sockets.forEach((target) => {
          emitCanonical(target, 'pool_snapshot', sessionManager.getPoolSnapshot({ clientId: target.id }));
        });
        return;
      }
      emitCanonical(terminalNamespace, 'pool_snapshot', sessionManager.getPoolSnapshot());
    }

    function emitPresence(sessionId) {
      if (typeof sessionManager.getPresence !== 'function') {
        return;
      }
      const presence = sessionManager.getPresence(sessionId);
      if (terminalNamespace.sockets?.forEach) {
        terminalNamespace.sockets.forEach((target) => {
          target.emit('terminal:presence', {
            ...presence,
            isPresenter: presence.activePresenterClientId === target.id,
            callerIsPresenter: presence.activePresenterClientId === target.id,
          });
        });
        return;
      }
      terminalNamespace.emit('terminal:presence', presence);
    }

    function requireAttachedSession(sessionId, rejectionEvent, errorContext = {}) {
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
        ...errorContext,
      });
      return false;
    }

    function getInputErrorContext(payload = {}) {
      return {
        sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : null,
        inputId: typeof payload.inputId === 'string' ? payload.inputId : null,
      };
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
          emitPresence(presence?.sessionId || sessionId);
          emitCanonical(terminalNamespace, 'pool_snapshot', pool);
        },
      };
    }

    async function handleCreate(payload = {}) {
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
        const created = await sessionManager.createSession({
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
            emitPresence(presence?.sessionId || sessionRef.sessionId);
            emitCanonical(terminalNamespace, 'pool_snapshot', pool);
          },
        });
        sessionRef.sessionId = created.sessionId;
        const creatorPayload = { ...created, requestId };
        emitCanonical(socket, 'session_created', creatorPayload);
        emitCanonical(socket.broadcast, 'session_created', redactCallerPresenter(created));
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
      const correlation = buildOperationCorrelation('attach', payload);
      try {
        const attached = sessionManager.attachSession(payload.sessionId, {
          clientId,
          socketId,
          cols: payload.cols,
          rows: payload.rows,
          ...bindSessionCallbacks(payload.sessionId),
        });
        const attachedPayload = {
          ...attached,
          ...correlation,
          sessionId: attached.sessionId,
        };
        socket.emit('terminal:replay', {
          sessionId: attached.sessionId,
          replay: attached.replay,
        });
        emitCanonical(socket, 'session_attached', attachedPayload);
        emitPresence(payload.sessionId);
        emitPoolSnapshot();
      } catch (err) {
        socket.emit('terminal:error', {
          ...correlation,
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
        emitCanonical(socket, 'session_detached', detached);
        emitPresence(payload.sessionId);
        emitPoolSnapshot();
      } catch (err) {
        socket.emit('terminal:error', {
          code: err.code || 'terminal_detach_failed',
          message: err.message,
        });
      }
    }

    async function handleClose(payload = {}) {
      const correlation = buildOperationCorrelation('close', payload);
      try {
        const closed = await sessionManager.closeSession(payload.sessionId, {
          clientId,
          socketId,
          reason: 'user-close',
        });
        const closedPayload = {
          ...closed,
          ...correlation,
          sessionId: closed.sessionId || correlation.sessionId,
        };
        emitCanonical(terminalNamespace, 'session_closed', closedPayload);
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
          ...correlation,
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
        emitCanonical(socket, 'session_attached', updated);
        emitPresence(payload.sessionId);
        emitPoolSnapshot();
      } catch (err) {
        socket.emit('terminal:error', {
          code: err.code || 'terminal_set_active_presenter_failed',
          message: err.message,
        });
      }
    }

    emitCanonical(socket, 'pool_snapshot', sessionManager.getPoolSnapshot({ clientId }));
    socket.emit('terminal:webrtc_capability', webrtcGateway.capability());

    socket.on('terminal:list', () => {
      const snapshot = sessionManager.getPoolSnapshot({ clientId });
      emitCanonical(socket, 'pool_snapshot', snapshot);
    });

    socket.on('terminal:create_session', handleCreate);
    socket.on('terminal:attach_session', handleAttach);
    socket.on('terminal:detach_session', handleDetach);
    socket.on('terminal:close_session', handleClose);
    socket.on('terminal:set_active_presenter', handleSetActivePresenter);
    socket.on('terminal:set_active_session', handleSetActivePresenter);
    socket.on('terminal:create', (...args) => { recordAliasHit('create', 'create_session'); return handleCreate(...args); });
    socket.on('terminal:attach', (...args) => { recordAliasHit('attach', 'attach_session'); return handleAttach(...args); });
    socket.on('terminal:detach', (...args) => { recordAliasHit('detach', 'detach_session'); return handleDetach(...args); });
    socket.on('terminal:close', (...args) => { recordAliasHit('close', 'close_session'); return handleClose(...args); });
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

    socket.on('terminal:client_metrics', (payload = {}) => {
      metrics.recordTransportLatency(
        typeof payload.name === 'string' ? payload.name : '',
        typeof payload.transport === 'string' ? payload.transport : '',
        Number(payload.value),
      );
    });

    socket.on('terminal:input', (payload = {}) => {
      const inputErrorContext = getInputErrorContext(payload);
      if (!requireAttachedSession(payload.sessionId, 'terminal_input_rejected', inputErrorContext)) {
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
          ...inputErrorContext,
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
          ...inputErrorContext,
          ...(err.details ? { details: err.details } : {}),
        });
      } finally {
        metrics.recordLatency(
          'server_input_process_ms',
          Math.max(0, Number(metricNow()) - Number(processingStartedAt)),
        );
      }
    });

    socket.on('terminal:webrtc_offer', (payload = {}) => {
      try {
        webrtcGateway.acceptOffer({
          socketId,
          clientId,
          offer: payload.offer || payload,
          onLocalDescription: (desc) => {
            socket.emit('terminal:webrtc_answer', {
              type: desc.type,
              sdp: desc.sdp,
            });
          },
          onLocalCandidate: (candidate) => {
            socket.emit('terminal:webrtc_ice', candidate);
          },
        });
        metrics.recordCounter('webrtc_offer_accepted');
        audit.info('terminal_webrtc_offer_accepted', {
          socketId,
          clientId,
          subject: user?.sub || '',
        });
      } catch (err) {
        metrics.recordCounter('webrtc_offer_rejected');
        audit.warn('terminal_webrtc_offer_rejected', {
          socketId,
          clientId,
          code: err.code || 'terminal_webrtc_offer_failed',
          message: err.message,
        });
        socket.emit('terminal:error', {
          code: err.code || 'terminal_webrtc_offer_failed',
          message: err.message,
        });
      }
    });

    socket.on('terminal:webrtc_ice', (payload = {}) => {
      webrtcGateway.addRemoteCandidate(socketId, payload);
    });

    socket.on('terminal:webrtc_close', () => {
      webrtcGateway.closePeer(socketId, 'client-close');
    });

    socket.on('terminal:resize', (payload = {}) => {
      if (!requireAttachedSession(payload.sessionId, 'terminal_resize_rejected')) {
        return;
      }
      try {
        sessionManager.resizeSession(payload.sessionId, {
          clientId,
          socketId,
          cols: payload.cols,
          rows: payload.rows,
        });
        emitPoolSnapshot();
      } catch (err) {
        const code = err.code === 'terminal_invalid_size'
          ? 'terminal_resize_out_of_range'
          : (err.code || 'terminal_resize_failed');
        if (code === 'terminal_resize_out_of_range') {
          audit.warn('terminal_resize_rejected', {
            sessionId: payload.sessionId,
            clientId,
            socketId,
            code,
            cols: payload.cols,
            rows: payload.rows,
          });
        } else {
          audit.error('terminal_error', {
            sessionId: payload.sessionId || null,
            clientId,
            socketId,
            action: 'resize',
            code,
            message: err.message,
          });
        }
        socket.emit('terminal:error', {
          code,
          message: code === 'terminal_resize_out_of_range'
            ? 'Terminal resize is out of range'
            : err.message,
          action: 'resize',
          sessionId: payload.sessionId || null,
        });
      }
    });

    socket.on('disconnect', () => {
      metrics.recordCounter('socket_disconnected');
      webrtcGateway.closePeer(socketId, 'socket-disconnect');
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

  let closePromise = null;
  let closeCompleted = false;

  async function close(reason = 'system:shutdown') {
    if (closeCompleted) {
      return {
        closedSessionIds: [],
        failures: [],
        reason,
      };
    }
    if (closePromise) {
      return closePromise;
    }
    closePromise = (async () => {
      if (idleReaperTimer) {
        clearInterval(idleReaperTimer);
        idleReaperTimer = null;
      }
      if (typeof webrtcGateway.closeAll === 'function') {
        webrtcGateway.closeAll('setup-close');
      }
      let summary = {
        closedSessionIds: [],
        failures: [],
        reason,
      };
      if (typeof sessionManager.closeAllAsSystem === 'function') {
        summary = await sessionManager.closeAllAsSystem(reason);
      }
      closeCompleted = true;
      return summary;
    })();
    try {
      return await closePromise;
    } finally {
      // Keep closePromise so concurrent callers share one in-flight harvest.
    }
  }

  return {
    namespace: terminalNamespace,
    sessionManager,
    metrics,
    webrtcGateway,
    close,
    getAliasTelemetry() {
      return Object.fromEntries(aliasHitCounters.entries());
    },
  };
}

module.exports = {
  setupTerminal,
};
