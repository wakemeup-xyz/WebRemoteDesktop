const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// Store connections
const connections = {
  host: null,
  viewers: new Map()
};

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
      connections.host = socket;
      socket.emit('connected', { role: 'host', status: 'ok' });
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

    // Input relay
    socket.on('input', (data) => {
      if (connections.host) {
        connections.host.emit('input', data);
      }
    });

    socket.on('disconnect', () => {
      console.log(`Disconnected: ${role} - ${socket.id}`);
      if (role === 'host') {
        connections.host = null;
        connections.viewers.forEach((viewerSocket) => {
          viewerSocket.emit('host-status', { online: false });
        });
      } else {
        connections.viewers.delete(socket.id);
      }
    });
  });

  return connections;
}

module.exports = { setupSignaling, connections };
