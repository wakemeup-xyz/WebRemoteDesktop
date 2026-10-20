// Offline test adapters only; this module registers no tests.
const { EventEmitter } = require('node:events');
const { signAccessToken, verifyAccessToken } = require('../lib/auth');
const { connections, clearHostCapabilities, runtimeContext } = require('./signaling');

class FakeSocket extends EventEmitter {
  constructor(id, role, tokenRole = role === 'relay-viewer' ? 'viewer' : role) {
    super();
    this.id = id;
    this.disconnected = false;
    this.handshake = {
      auth: { role, token: signAccessToken(tokenRole, tokenRole === 'viewer' ? 'viewer-password-login' : `${id}-${tokenRole}`) },
      address: '127.0.0.1',
      headers: {},
    };
    this.sent = [];
    this.volatile = {
      emit: (event, data) => this.sent.push({ event, data, volatile: true }),
    };
  }

  emit(event, data, ack) {
    this.sent.push(ack ? { event, data, ack } : { event, data });
    return true;
  }

  timeout(ms) {
    return {
      emit: (event, data, ack) => {
        this.emit(event, data, ack);
        this.sent.at(-1).timeoutMs = ms;
      },
    };
  }

  trigger(event, data) {
    return super.emit(event, data);
  }

  disconnect() {
    if (this.disconnected) return;
    this.disconnected = true;
    this.trigger('disconnect');
  }
}

function makeIo(context = runtimeContext) {
  return {
    connectionHandler: null,
    middleware: null,
    namespaces: new Map(),
    use(handler) {
      this.middleware = handler;
    },
    on(event, handler) {
      if (event === 'connection') {
        this.connectionHandler = handler;
      }
    },
    of(name) {
      if (!this.namespaces.has(name)) {
        this.namespaces.set(name, {
          middleware: null,
          connectionHandler: null,
          use(handler) {
            this.middleware = handler;
          },
          on(event, handler) {
            if (event === 'connection') {
              this.connectionHandler = handler;
            }
          },
        });
      }
      return this.namespaces.get(name);
    },
    // Tests must spell out a human click when replacing a different session.
    connectManual(socket) {
      const session = socket.handshake.auth.viewerSessionId || `fixture-session-${socket.id}`;
      socket.handshake.auth.viewerSessionId = session;
      const admission = context.viewerAdmission.issue(verifyAccessToken(socket.handshake.auth.token).sub, session);
      if (!admission.ticket) throw new Error('fixture admission unavailable');
      socket.handshake.auth.viewerAdmission = { mode: 'explicit', ticket: admission.ticket };
      this.connect(socket);
    },
    connect(socket) {
      if (this.middleware) {
        let middlewareError = null;
        this.middleware(socket, (err) => {
          middlewareError = err || null;
        });
        if (middlewareError) {
          throw middlewareError;
        }
      }
      this.connectionHandler(socket);
    },
  };
}

function resetConnections() {
  runtimeContext.viewerAdmission = require('../lib/viewer-admission').createViewerAdmission();
  connections.host = null;
  connections.viewers.clear();
  connections.relayViewers.clear();
  clearHostCapabilities();
}

function grantActiveLease(io, host, viewer, requestId = 'grant') {
  viewer.trigger('control-acquire', { requestId });
  const transition = host.sent.find((e) => e.event === 'control-transition').data;
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'applied' });
  return viewer.sent.find((e) => e.event === 'control-grant').data;
}

module.exports = { FakeSocket, makeIo, resetConnections, grantActiveLease };
