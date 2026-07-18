const { loadConfig } = require('../lib/config');
const { verifyAccessToken } = require('../lib/auth');
const { ingestDiagnosticPayload } = require('../lib/diagnostic');

// Store connections
const connections = {
  host: null,
  viewers: new Map(),
  relayViewers: new Map()
};

function getViewerSnapshot() {
  return Array.from(connections.viewers.values()).map((viewerSocket) => ({
    id: viewerSocket.id,
    ip: viewerSocket.handshake.address || 'unknown',
    userAgent: viewerSocket.handshake.headers['user-agent'] || 'unknown'
  }));
}

function emitViewerStatus(reason, viewerSocket = null) {
  const payload = {
    reason,
    onlineCount: connections.viewers.size,
    viewers: getViewerSnapshot(),
    changedViewer: viewerSocket ? {
      id: viewerSocket.id,
      ip: viewerSocket.handshake.address || 'unknown',
      userAgent: viewerSocket.handshake.headers['user-agent'] || 'unknown'
    } : null
  };

  if (connections.host) {
    connections.host.emit('viewer-status', payload);
  }
}

function verifyToken(token) {
  try {
    return verifyAccessToken(token);
  } catch {
    return null;
  }
}

function isActiveViewerSocket(socket) {
  return connections.viewers.get(socket.id) === socket;
}

function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function setupSignaling(io, options = {}) {
  const config = options.config || loadConfig();
  const logger = options.logger || console;
  const recentEventStore = options.recentEventStore || null;
  const structuredLogger = options.structuredLogger || null;
  // Use default namespace for all connections
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
      return next(new Error('Authentication required'));
    }
    const decoded = verifyToken(token);
    if (!decoded) {
      return next(new Error('Invalid token'));
    }
    socket.user = decoded;
    const claimedRole = socket.handshake.auth?.role;
    socket.userRole = decoded.role === 'viewer' && claimedRole === 'relay-viewer'
      ? 'relay-viewer'
      : decoded.role;
    next();
  });

  io.on('connection', (socket) => {
    const role = socket.userRole || socket.user?.role || socket.handshake.auth?.role;
    const claimedRole = socket.handshake.auth?.role;
    if (claimedRole && claimedRole !== role) {
      console.warn(`[AUTH] Ignoring client-declared role=${claimedRole}, using token role=${role}`);
    }
    console.log(`Connection: ${role} - ${socket.id}`);

    if (role === 'host') {
      const previousHost = connections.host;
      connections.host = socket;
      if (previousHost && previousHost.id !== socket.id) {
        console.warn(`Replacing stale host connection: ${previousHost.id} -> ${socket.id}`);
        previousHost.disconnect(true);
      }
      socket.emit('connected', { role: 'host', status: 'ok' });
      emitViewerStatus('host-connected');
      // Notify all viewers that host is online
      connections.viewers.forEach((viewerSocket) => {
        viewerSocket.emit('host-status', { online: true });
      });
    } else if (role === 'viewer') {
      connections.viewers.set(socket.id, socket);
      socket.emit('connected', {
        role: 'viewer',
        status: 'ok',
        hostOnline: connections.host !== null
      });
      emitViewerStatus('viewer-connected', socket);
    } else if (role === 'relay-viewer') {
      connections.relayViewers.set(socket.id, socket);
      socket.emit('connected', {
        role: 'relay-viewer',
        status: 'ok',
        hostOnline: connections.host !== null
      });
    }

    // WebRTC signaling
    socket.on('offer', (data) => {
      if (role !== 'viewer') {
        console.warn(`Offer rejected: role=${role} from ${socket.id}`);
        return;
      }
      if (!isActiveViewerSocket(socket)) {
        console.warn(`Offer rejected: disconnected viewer ${socket.id}`);
        return;
      }
      console.log(`[OFFER] Received from ${role}=${socket.id} epoch=${data.epoch} hostConnected=${Boolean(connections.host)}`);
      if (connections.host) {
        console.log(`[OFFER] Forwarding to host ${connections.host.id} epoch=${data.epoch}`);
        connections.host.emit('offer', {
          offer: data.offer,
          viewerId: socket.id,
          epoch: data.epoch
        });
      } else {
        console.warn(`[OFFER] No host connected, dropping offer from ${socket.id} epoch=${data.epoch}`);
      }
    });

    socket.on('answer', (data) => {
      const viewerSocket = connections.viewers.get(data.viewerId);
      if (viewerSocket) {
        viewerSocket.emit('answer', { answer: data.answer });
      }
    });

    socket.on('ice-candidate', (data) => {
      if (data.target === 'host' && connections.host) {
        if (role !== 'viewer') {
          console.warn(`ICE candidate to host rejected: role=${role} from ${socket.id}`);
          return;
        }
        if (!isActiveViewerSocket(socket)) {
          console.warn(`ICE candidate to host rejected: disconnected viewer ${socket.id}`);
          return;
        }
        connections.host.emit('ice-candidate', {
          candidate: data.candidate,
          from: socket.id
        });
      } else if (data.target === 'viewer') {
        const viewerSocket = connections.viewers.get(data.viewerId);
        if (viewerSocket) {
          viewerSocket.emit('ice-candidate', {
            candidate: data.candidate,
            from: socket.id
          });
        }
      }
    });

    // Input relay (viewer -> host only)
    socket.on('input', (data) => {
      if (role !== 'viewer') {
        console.warn(`Input rejected: role=${role} from ${socket.id}`);
        return;
      }
      if (!isActiveViewerSocket(socket)) {
        console.warn(`Input rejected: disconnected viewer ${socket.id}`);
        return;
      }
      if (data.type !== 'mouse' || data.action !== 'move') {
        const inputType = ['mouse', 'keyboard', 'command'].includes(data.type) ? data.type : 'unknown';
        const action = /^[a-z-]{1,32}$/i.test(String(data.action || '')) ? String(data.action) : 'unknown';
        const transport = data.transport === 'datachannel' ? 'datachannel' : 'socket';
        const payloadBytes = Buffer.byteLength(JSON.stringify(data.payload || {}), 'utf8');
        logger.log?.(`[INPUT] relay viewer=${socket.id} type=${inputType} action=${action} transport=${transport} payloadBytes=${payloadBytes}`);
      }
      if (connections.host) {
        connections.host.emit('input', {
          ...data,
          viewerId: socket.id
        });
      } else {
        console.warn('[INPUT] No host connected, dropping input');
      }
    });

    socket.on('input-ack', (data = {}) => {
      if (role !== 'host' || connections.host !== socket) {
        logger.warn?.(`[INPUT] ack rejected role=${role}`);
        return;
      }
      const viewerSocket = connections.viewers.get(String(data.viewerId || ''));
      if (!viewerSocket) return;
      viewerSocket.emit('input-ack', {
        type: 'input_ack',
        schemaVersion: 1,
        inputIds: Array.isArray(data.inputIds) ? data.inputIds.slice(0, 64) : [],
        hostExecuteMs: Math.max(0, Number(data.hostExecuteMs || 0)),
        transport: 'socket',
      });
    });

    // Diagnostic logs relay (viewer -> host) + persist to disk
    socket.on('diagnostic', (data) => {
      if (role !== 'viewer') {
        console.warn(`Diagnostic rejected: role=${role} from ${socket.id}`);
        return;
      }
      if (!isActiveViewerSocket(socket)) {
        console.warn(`Diagnostic rejected: disconnected viewer ${socket.id}`);
        return;
      }
      const logCount = data.logs?.length || 0;
      logger.log?.(`[DIAGNOSTIC] Received ${logCount} lines from viewer ${socket.id}`);
      const result = ingestDiagnosticPayload({
        role,
        viewerId: socket.id,
        socketId: socket.id,
        userAgent: socket.handshake.headers['user-agent'] || 'unknown',
        data,
        config,
        logger,
      });
      if (result.accepted && result.summaryEvent) {
        recentEventStore?.append(result.summaryEvent);
        structuredLogger?.info(result.summaryEvent);
      }

      // Also relay to host for real-time analysis
      if (result.accepted && connections.host) {
        connections.host.emit('diagnostic', result.report);
      }
    });

    socket.on('viewer-stats', (data) => {
      if (role !== 'viewer') {
        console.warn(`Viewer stats rejected: role=${role} from ${socket.id}`);
        return;
      }
      if (!isActiveViewerSocket(socket)) {
        console.warn(`Viewer stats rejected: disconnected viewer ${socket.id}`);
        return;
      }
      if (connections.host) {
        connections.host.emit('viewer-stats', {
          ...data,
          viewerId: socket.id
        });
      }
    });

    socket.on('media-profile-change', (data = {}) => {
      if (role !== 'viewer') {
        console.warn(`Media profile change rejected: role=${role} from ${socket.id}`);
        return;
      }
      if (!isActiveViewerSocket(socket)) {
        console.warn(`Media profile change rejected: disconnected viewer ${socket.id}`);
        return;
      }
      const allowedProfiles = new Set(['high', 'medium', 'low', 'survival']);
      const profile = allowedProfiles.has(data.profile) ? data.profile : 'medium';
      const sanitized = {
        viewerId: socket.id,
        profile,
        width: clampInt(data.width, 320, 1920, 960),
        height: clampInt(data.height, 180, 1080, 540),
        targetFps: clampInt(data.targetFps, 5, 30, 15),
        videoBitrateKbps: clampInt(data.videoBitrateKbps, 250, 5000, 1400),
        reason: String(data.reason || 'quality').slice(0, 80),
        mediaPolicy: data.mediaPolicy === 'strict-stun' ? 'strict-stun' : 'unknown',
      };
      if (connections.host) {
        connections.host.emit('media-profile-change', sanitized);
      }
    });

    socket.on('relay-stream-control', (data) => {
      if (role !== 'viewer' && role !== 'relay-viewer') {
        console.warn(`Relay stream control rejected: role=${role} from ${socket.id}`);
        return;
      }
      if (role === 'viewer' && !isActiveViewerSocket(socket)) {
        console.warn(`Relay stream control rejected: disconnected viewer ${socket.id}`);
        return;
      }
      if (connections.host) {
        connections.host.emit('relay-stream-control', {
          ...data,
          viewerId: socket.id
        });
      }
    });

    socket.on('relay-frame', (data) => {
      if (role !== 'host') {
        console.warn(`Relay frame rejected: role=${role} from ${socket.id}`);
        return;
      }
      const viewerSocket = connections.relayViewers.get(data.viewerId) || connections.viewers.get(data.viewerId);
      if (viewerSocket) {
        viewerSocket.volatile.emit('relay-frame', data);
      }
    });

    socket.on('relay-frame-ack', (data) => {
      if (role !== 'viewer' && role !== 'relay-viewer') {
        return;
      }
      if (connections.host) {
        connections.host.emit('relay-frame-ack', {
          ...data,
          viewerId: socket.id
        });
      }
    });

    socket.on('resolution-change', (data) => {
      if (role !== 'viewer') {
        console.warn(`Resolution change rejected: role=${role} from ${socket.id}`);
        return;
      }
      if (!isActiveViewerSocket(socket)) {
        console.warn(`Resolution change rejected: disconnected viewer ${socket.id}`);
        return;
      }
      const width = Number(data.width);
      const height = Number(data.height);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width < 320 || height < 180) {
        console.warn(`[RESOLUTION] Invalid request from ${socket.id}:`, data);
        return;
      }
      if (connections.host) {
        connections.host.emit('resolution-change', {
          width: Math.round(width),
          height: Math.round(height),
          viewerId: socket.id
        });
      }
    });

    socket.on('disconnect', () => {
      console.log(`Disconnected: ${role} - ${socket.id}`);
      if (role === 'host') {
        if (connections.host && connections.host.id === socket.id) {
          connections.host = null;
          connections.viewers.forEach((viewerSocket) => {
            viewerSocket.emit('host-status', { online: false });
          });
          emitViewerStatus('host-disconnected');
        } else {
          console.log(`Ignoring stale host disconnect: ${socket.id}`);
        }
      } else if (role === 'viewer') {
        connections.viewers.delete(socket.id);
        emitViewerStatus('viewer-disconnected', socket);
      } else if (role === 'relay-viewer') {
        connections.relayViewers.delete(socket.id);
        if (connections.host) {
          connections.host.emit('relay-stream-control', {
            enabled: false,
            viewerId: socket.id
          });
        }
      }
    });
  });

  return connections;
}

function getConnectionStatus() {
  return {
    hostOnline: Boolean(connections.host),
    hostId: connections.host ? connections.host.id : null,
    viewerCount: connections.viewers.size,
    relayViewerCount: connections.relayViewers.size,
    viewers: getViewerSnapshot()
  };
}

module.exports = { setupSignaling, connections, getConnectionStatus, ingestDiagnosticPayload };
