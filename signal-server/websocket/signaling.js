const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

const DIAG_DIR = path.join(__dirname, '..', '..', 'diag-logs');

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
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function setupSignaling(io) {
  // Use default namespace for all connections
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error('Authentication required'));
    }
    const decoded = verifyToken(token);
    if (!decoded) {
      return next(new Error('Invalid token'));
    }
    socket.user = decoded;
    next();
  });

  io.on('connection', (socket) => {
    const role = socket.handshake.auth.role;
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
      if (connections.host) {
        connections.host.emit('offer', {
          offer: data.offer,
          viewerId: socket.id
        });
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
      if (data.type !== 'mouse' || data.action !== 'move') {
        console.log(`[INPUT] Relaying from viewer ${socket.id}:`, JSON.stringify(data));
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

    // Diagnostic logs relay (viewer -> host) + persist to disk
    socket.on('diagnostic', (data) => {
      if (role !== 'viewer') {
        console.warn(`Diagnostic rejected: role=${role} from ${socket.id}`);
        return;
      }
      const logCount = data.logs?.length || 0;
      console.log(`[DIAGNOSTIC] Received ${logCount} lines from viewer ${socket.id}`);

      // Write to diag-logs/ for agent analysis
      try {
        if (!fs.existsSync(DIAG_DIR)) {
          fs.mkdirSync(DIAG_DIR, { recursive: true });
        }
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `${ts}_${socket.id}.json`;
        const report = {
          receivedAt: new Date().toISOString(),
          viewerId: socket.id,
          userAgent: data.userAgent || 'unknown',
          screen: data.screen || 'unknown',
          logCount,
          latency: data.latency || null,
          logs: data.logs || [],
        };
        fs.writeFileSync(path.join(DIAG_DIR, filename), JSON.stringify(report, null, 2), 'utf-8');
        console.log(`[DIAGNOSTIC] Saved → diag-logs/${filename}`);
      } catch (err) {
        console.error('[DIAGNOSTIC] Failed to write log file:', err.message);
      }

      // Also relay to host for real-time analysis
      if (connections.host) {
        connections.host.emit('diagnostic', data);
      }
    });

    socket.on('viewer-stats', (data) => {
      if (role !== 'viewer') {
        console.warn(`Viewer stats rejected: role=${role} from ${socket.id}`);
        return;
      }
      if (connections.host) {
        connections.host.emit('viewer-stats', {
          ...data,
          viewerId: socket.id
        });
      }
    });

    socket.on('relay-stream-control', (data) => {
      if (role !== 'viewer' && role !== 'relay-viewer') {
        console.warn(`Relay stream control rejected: role=${role} from ${socket.id}`);
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

module.exports = { setupSignaling, connections, getConnectionStatus };
